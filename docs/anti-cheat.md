# Anti-cheat threat model

The server does not decide a score by simulating golf. It receives a score and
records it. This page states precisely what the server enforces, what it cannot
enforce, and what deterministic verification does and does not settle — because a
claim of "cheat-proof" play would be false, and a vague one would be worse than
none.

Every statement here was checked against the code and, where behaviour matters,
against a running service. The measurements are recorded rather than described.

## The threat model in one paragraph

A player controls their own browser. The client runs the original physics engine,
so the _only_ thing the server learns about a hole is what that client chooses to
send. Anyone who can open developer tools can send any frame they like, including
a hole-in-one on a par-10 course. The server's job is therefore to refuse reports
that are **internally impossible**, to keep **one player's claims from affecting
another's**, to ensure the **public leaderboard** cannot be filled with scores
that trivially self-discredit it, and — since [deterministic
verification](#what-deterministic-verification-does-and-what-it-still-does-not-settle)
landed on this branch — to **replay the shots it was given and record whether the
reported trajectory is the one the physics produces**. That last part is an
audit, not a gate: it never changes a score.

## What the server enforces

### Identity is not an account

`/api/join` issues a `uid` and a `session` token. They are anonymous: no email, no
password, no verification. There is no account to steal because there is no
account.

That is a deliberate design decision rather than an oversight, and it bounds what
any anti-cheat measure can achieve. A cheater who is banned can join again under
a new name. Name-based leaderboards are therefore a **convenience and a social
record**, not an identity system; two people using one name share a record, which
is documented in
[architecture](architecture.md#public-leaderboard).

What identity _does_ enforce is that a player cannot act as somebody else:

| Attempt                               | Result                               |
| ------------------------------------- | ------------------------------------ |
| Join with a forged `session`          | `invalid-join`, socket closed `1008` |
| Join with `protocol` other than `2`   | `invalid-join`, socket closed `1008` |
| Join a locked party                   | Refused                              |
| Join past `maxPlayers`                | Refused                              |
| Reuse an expired `uid`/`session` pair | Refused, a new identity is required  |
| Act as host without the host token    | `not-host`                           |

The forged-session case was verified live against a running service and answers
exactly `{"t":"error","code":"invalid-join","msg":"Obtain a local join credential first."}`.

A room also caps how many identities it will ever issue (`200`), so a single
client cannot mint identities without limit.

### Only a player in play may report a score

Every scoring frame is gated on the same predicate. A report is honoured only when
the room is `playing`, the player is alive, participated in this hole, has not
already finished, and the round timer has not expired.

This matters more than it looks. It means a report cannot be backdated to a hole
that has ended, cannot come from a spectator, cannot come from a player who was
eliminated, and cannot arrive after the deadline. The frames that are _not_
gated this way (`config`, `start`, `host-action`) are host-only and checked
separately.

### A finish must be self-consistent

A finish frame carries three values: `s` (strokes), `p` (par claimed by the
client) and the `t: 'f'` marker. The server requires:

1. **The claimed par is the real par.** `p` must equal the loaded course's par. A
   client cannot invent a par to make its score look good, and cannot reuse a par
   from a different hole.
2. **The stroke count is at least what was already reported.** `s` must be in
   `[max(1, strokesReportedSoFar), 200]`, so a player cannot spend five strokes and
   then claim the hole in two.
3. **The stroke count is bounded.** Nothing above `200` is accepted, which caps
   what a single hole can contribute to a total.

A report failing any of these is **dropped silently** — the hole stays open and
the player may finish correctly. It is not an error the client has to handle,
because a legitimate client never sends an inconsistent report.

### A progress report is bounded and rate-limited

`prog` carries the current stroke count. It is accepted only as an integer in
`0–200`, and changing it costs from a per-player budget: **10 burst, 4 refilled
per second**. Repeating the same count is free and is dropped before any
broadcast, so the cheap attack — spam the same value to make the server
re-serialize the standings — costs nothing to defend against.

The budget exists because a board broadcast is the expensive kind: it serializes
the full standings once and fans them out. Without the budget one client could
force that as fast as it could write.

### Positions are bounded and never scored

Position frames are rate-limited to one per **40 ms** per player, every coordinate
must be finite and within `|value| < 1e5`, and the two flags must be `0` or `1`.
Out-of-range frames are dropped rather than clamped.

**Positions do not affect scoring at all.** They are relayed to other clients as
`b` frames for interpolated rendering and then discarded. Nothing in the scoring
path reads them, so a forged position cannot claim a score — it can only make one
ball appear in a strange place on someone else's screen.

### Hole time is measured by the server

The recorded time for a hole is computed on the server from the moment the hole
started, not taken from the client. There is no `timeMs` field in any client
frame — the transport never sends one — so a client cannot report a fast time
directly.

This is the strongest single property in the scoring path, and it is worth being
precise about its limit: it guarantees the _clock_ is honest, not the _strokes_
it is measuring. Finishing early is still possible, and that is exactly the gap
described below.

### The leaderboard has an eligibility gate

A score reaches the public leaderboard only when **all** of these hold:

- the room reached `final`;
- `mapSource` is `random` (custom playlists are excluded);
- `courseVoting` is off — a match with voting enabled is ineligible even when
  nobody votes, because the course draw is partly chosen by the players;
- `recordEligible` is true — a host restart clears it;
- `roundHistory` has exactly `config.holes` rounds, every one `completed`, in
  order;
- every hole row for that player is `holed` with an integer stroke count `>= 1`
  and a finite, non-negative time.

Custom playlists, voting matches, restarted attempts, skipped or ended rounds,
timeouts, elimination, and late joiners who missed a hole are therefore all
ineligible. The gate is a whitelist: an unexpected condition yields no score
rather than a score with a caveat.

## What the server cannot enforce

These are properties of the architecture, not bugs waiting to be found.

### It cannot tell whether a score was earned

The decisive measurement. On a live service, a par-**10** course was started and
a single frame was sent:

```
{ f: 1, s: 1, p: 10 }
```

Result: accepted. Phase moved to `hole-results`, and the recorded round history
was:

```json
{ "par": 10, "status": "completed", "rows": [{ "strokes": 1, "status": "holed", "timeMs": 16 }] }
```

A hole-in-one on a par 10 in **16 milliseconds**, recorded as a legitimate hole.
Every check listed above passed, because the report was internally consistent:
the par was real, one stroke is at least zero, and 16 ms is a number.

That is the honest summary of what the server **enforces**. The recorded verdict
for this same class of report is now narrower: on a course the verifier can model,
a report whose trajectory does not come from the physics is recorded as
`shot_verification` with `ok: false` (see
[deterministic verification](#what-deterministic-verification-does-and-what-it-still-does-not-settle)).
The score is still stored and still counts. Detection and enforcement are
different things, and only the first one is implemented.

### The stroke floor is not monotonic

The floor is `max(1, strokesReportedSoFar)`, and `prog` is a level rather than a
running maximum. So this sequence is accepted:

```
prog 5   -> recorded 5
prog 1   -> recorded 1     (a level may decrease)
finish 1 -> accepted
```

Verified against a real room. The floor therefore prevents a player from
_finishing below their last report_, not from _lowering their report_. Closing
that would mean making `prog` monotonic, which no legitimate client needs but
which is a behaviour change rather than a hardening tweak, so it is recorded here
rather than done quietly.

### There is no minimum hole time

A score of 16 ms on a par-10 hole is stored. There is no plausibility check
against par, course length, or the number of strokes — a par 10 finished in 1
stroke in 16 ms is exactly as acceptable to the server as a genuine one.

A minimum time would be easy to add and easy to game in the other direction (a
slow cheater passes it trivially), so the absence is deliberate rather than
forgotten. It is listed as a limitation so nobody assumes it is covered.

### Within a party, scores are taken at face value

Other players see the reported score. There is no cross-checking between clients
and no way for one player to dispute another's claim, and the verifier's verdict
is not shown to them. A cheater in a private party with friends has no technical
obstacle — only a social one — unless the host reads the event log, where a
mismatch on a modelled course does appear.

### Anonymous identities mean a ban is not durable

Because `/api/join` requires nothing but a display name, "banning" a cheater is
not meaningful. The leaderboard records the name used; a cheater can use another.
This is why the leaderboard is described as a social record rather than a
competitive ranking.

## What deterministic verification does, and what it still does not settle

Deterministic verification — replay the shot inputs through the physics and check
the resulting score — is the only approach that would settle whether a score was
earned. It is **implemented on this branch** as an audit, and it deliberately does
not gate scoring. The reasoning, and the remaining gap, are concrete:

1. **The physics is the pinned engine, run natively.** The server does not
   reimplement Rapier; it runs the same build the client ships. The
   `@dimforge/rapier3d-compat` WebAssembly binary is **byte-identical** to the
   one inlined in the client bundle — same SHA-256
   (`18157113bd106b5c9644f4a293fea7ba8513e9d44a8b2ec47d11225439c381ca`, 1,569,397
   bytes) — so "the same engine" is a hash comparison, not a claim. This is also
   what makes cross-engine float drift a non-question on this pinned pair.

2. **The input stream now carries inputs.** The client already kept every shot it
   fired in `gameStore.shots` as `{dir, power}`; the transport forwards new
   entries as a `shot` frame. That is a protocol addition, and an older client
   simply never sends it — the frame is dropped rather than treated as an error,
   so old and new clients interoperate.

3. **The comparison is path-based, because index-based cannot work.** The client
   samples its trajectory once per render frame at `0.04 s` of accumulated
   simulated time, so an honest run's sample boundaries land at slightly
   different physical points from a fixed-step replay: measured at up to **~6 cm**
   of index misalignment. The verifier therefore requires every reported point to
   lie within **10 cm** of the replayed path, plus a matching rest position and a
   matching holed/not-holed result. That tolerance is documented as an expected
   comparison artifact, not as a fudge factor — a fabricated path cannot come
   near it without running the same physics.

4. **The measurement behind all of this is still the same one.** On a fixed
   engine build and host, the same stroke produces a **bit-identical** trajectory
   even under 8× CPU throttling and a 400 ms main-thread stall well past the
   engine's own 0.2 s catch-up clamp
   ([deterministic verification](deterministic-verification.md)). A **quarter of
   one CSS pixel** of extra pointer pull, however, diverges the trajectory at its
   tenth sample and moves where the ball stops by **1.96 cm** — which is exactly
   why the verifier compares against a path with a tolerance rather than
   demanding identical samples.

5. **Courses it cannot model are refused, not approximated.** An approximation
   would report an honest player as a cheat, which is worse than no verdict.
   Courses with event devices (`events.nodes`), spline deck surfaces, an active
   zone piece (boost, jump, sand, ice, bumper, geyser, portal) or a loop are
   skipped: the client's engine had inputs the verifier does not have.

6. **The verdict never changes a score.** Verification runs after the round is
   stored, asynchronously, and writes one `shot_verification` event per holed
   track. A failure is an operator signal, not a refusal. That is deliberate: a
   verifier that can reject a legitimate player's score is a worse failure mode
   than a cheater who is only recorded.

So the honest position is now narrower than it was. The server **can** reproduce
a recorded shot and check that the reported trajectory is the one the physics
produces; it **does not** yet act on the result. Closing that last step means
deciding what a mismatch should cost, which is a gameplay and fairness question
rather than a technical one. Until it is answered, this is detection, not
enforcement — and [the leaderboard gate](#the-leaderboard-has-an-eligibility-gate)
is unchanged.

## If you need stronger guarantees

In rough order of cost:

- **Play with people you know, in a private party.** The social check is the only
  one that works today, and for the common case it is sufficient.
- **Watch the scorecards.** A 16 ms par-10 hole is obvious in the final
  standings, and the event log (with `BP_EVENT_LOG` set) records `stroke_count`,
  `player_holed` and `player_forfeited` with strokes, time and par, so a dispute
  can be examined afterwards.
- **Read the verification verdict.** With `BP_EVENT_LOG` set, every holed track
  on a course the verifier can model gets a `shot_verification` event carrying
  `ok`, the number of shots replayed and the worst path deviation in centimetres.
  An `ok: false` on a plain course is the strongest evidence this server can
  produce that a report did not come from its own physics.
- **Treat the leaderboard as a social record.** It is already gated, already
  excludes custom playlists and restarts, and is not a competitive ranking.
- **Acting on a verdict** — refusing or flagging a score on a mismatch — is the
  remaining step. It is a fairness decision, not a technical one, and is not
  taken here.

## What is deliberately not claimed

- Not "cheat-proof", "verified", "trusted" or "authenticated" scoring.
- Not a competitive ranking, and not a record of who is actually good.
- Not resistant to a player determined enough to open developer tools.
- Not enforcement: a verification mismatch is recorded, never acted on, and a
  course the verifier cannot model produces no verdict at all rather than a
  guess.

Every one of those would be false. The value of this page is that the limits are
written down where a reader can find them, rather than discovered in a round.

## Related

- [Architecture](architecture.md#public-leaderboard) for how the leaderboard
  stores and ranks records.
- [Configuration](configuration.md) for the budgets and bounds quoted here.
- [Background simulation](background-simulation.md) for why a hidden tab cannot
  fast-forward play.
- [Deterministic verification](deterministic-verification.md) for the measured
  replay results and the implementation behind the verdict described above.
