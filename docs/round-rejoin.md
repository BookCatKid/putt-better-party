# Rejoining an active round

## The question

Can the original game's round state be serialized on one document and restored on
another, so a player who reloads mid-hole resumes exactly where they were — ball
position, velocity, in-flight shot, remaining time, and physics tick alignment?

This is the investigation behind the `Active round rejoin` backlog entry. The
answer is **no, not deterministically**, and this document records why and what the
server does instead.

## What was examined

- The pinned, hash-pinned bundles in `private-client/assets/` and the prepared
  copies in `web/assets/`.
- The original game store's round fields, recovered in `tests/clock.test.js` and the
  bundle: `strokes`, `shots`, `card`, `lastLie`, `path`, `restarts`, `phase`,
  `level`.
- The fixed-step clock, recovered verbatim in `tests/clock.test.js`: a 1/120 s step
  with catch-up capped at 24 steps and a `discardNext` flag that drops the first
  frame after a resume.
- The server's rejoin path in `src/room.ts` (`join`), and its regressions in
  `tests/room.test.js` and `tests/transport.test.js`.

## Findings

**Rapier can snapshot, but this client never does.** The bundled Rapier build
contains `World.takeSnapshot()` and the static `restoreSnapshot(...)`
(`AppearanceClone-CBos6VT9.js`). Neither is called anywhere in the game code — the
only occurrences are the library's own definitions. There is therefore no snapshot
being taken that a reload could restore.

**A snapshot would have nothing to restore into.** The physics world is created per
level, and its bodies and colliders are bound to Three.js meshes that are built at
the same time. There is no code path that rebuilds a level _from_ a snapshot: the
engine only ever constructs a world from the course specification. Applying a
snapshot would mean authoring a restore path inside the engine, not enabling one.

**The state that matters is wider than the physics world.** Even with a snapshot,
a faithful resume needs the fixed-step accumulator, the aim/charge state, the
camera, the HUD's derived values, and the store's `shots`/`card`/`path`/`restarts`.
The last four are plain data and _could_ be serialized; the accumulator and any
mid-step impulse are not exposed.

**Determinism across a reload is not available.** The client steps physics at a
fixed 1/120 s and bounds catch-up, so two documents will not be at the same point
in the step sequence at the same wall-clock moment. A restored world would resume
at a different phase of the step, and the first frame after a resume is explicitly
discarded (`discardNext`). "Restored" would mean "approximately restored", which is
not good enough for a scored hole.

**The engine is immutable.** `scripts/client-lock.json` pins every archived asset by
hash and `AGENTS.md` forbids editing their bytes. Adding a snapshot/restore path
would be a redesign of the engine integration — new authored engine code running
inside a bundle we treat as read-only — not a rejoin feature.

## Decision

Do not attempt to restore an active round. Keep the explicit, visible fallback.

## The fallback, precisely

- **Same document reconnecting** (the client's `instance` is unchanged, e.g. a
  dropped socket): progress is preserved exactly. `strokes` and `done` survive, and
  the player carries on. Covered by _a full reload during play cannot reset progress;
  ordinary reconnect preserves progress_.
- **A new document during play** (`instance` changes — a reload): the server records
  the hole time, marks the hole `done`, keeps `success` only if it was already true,
  sets `roundSpectator`, and moves the player to `spectator`. The reload **cannot
  restart the hole**, cannot claim a score it did not earn, and cannot mark itself
  ready for a round it never prepared. On the next hole the player returns as a
  player with a fresh attempt. Covered by the same test.
- **A reload during the countdown** is _not_ a forfeit: nothing has happened yet, so
  the only consequence is that the prepared scene must be reported again, or the
  readiness gate would start the round without that client. Covered by _a page reload
  during the countdown has to report its scene again_.
- **A drop during the results phase** settles rather than replaying: the round is
  over for everybody, and the client must not resend the previous hole's score or
  claim the next one is ready. Covered by _a disconnect during the results phase
  settles rather than replaying the hole_.

## Why this is not an unauthorized reset

Every path above is one-directional. A reload can only _give up_ ground: it ends
the hole for that player, keeps the score they had, and returns them as a spectator.
Nothing in it can rewind a stroke count, re-open a finished hole, or re-assert
readiness for a round the new document has not loaded. That property is what the
tests assert, and it is the reason the fallback is safe to keep.
