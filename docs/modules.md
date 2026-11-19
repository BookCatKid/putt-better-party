# Module contracts

What each boundary owns and what may cross it. The behaviour-level description stays in `architecture.md`; this page is the map of where it lives, so a change lands in the file whose contract it is. Files not named here are ordinary internals of the boundary that contains them.

## Server (`src/`)

The process is two layers: bootstrap, then a request map.

- **`server.ts` — bootstrap only.** Configuration, the room store, the test-only fault-injection `loadMap`, leaderboard/replay/playlist collaborators, room recovery, `createHttpHandler` wiring, the `Bun.serve` literal with its WebSocket handlers, and the tick/reclaim/shutdown timers. Nothing here answers a request by route; adding one belongs in the map.
- **`http-routes.ts` — the entire HTTP request map**, behind `createHttpHandler(context)`. Host/origin enforcement, read-vs-write method gating, the `/ws/party` upgrade, every `/api/*` route's validation and authorization, static asset serving, the CSP/`page` helpers and the shared error path. Its contract is the context object: `config`, `root`, `rooms`, `roomOptions`, `admin`, `clientScripts`, `leaderboard`, `replayArchive`, `playlistJobs`.
- **`room.ts` — the room state machine.** Admission, host authority, the lobby countdown, round timing, votes, standings and the socket protocol. Heavy single responsibilities delegate: `room-scoring.ts` (standings/totals/records), `room-persistence.ts` (SQLite checkpoint shape and restore), `room-expiry.ts` (the reclaim rule). `room-types.ts` holds the shared socket/room types; `room-store.ts` owns the database. `RoomOptions` — `prepareMatch`, `loadMap`, `onChange`, `onFinalize`, `onReplayRound` — is the contract between a room and the process that owns it.
- **`upstream/` — the only code that may touch putt.day**, an acyclic split:
  - `transport.ts` — pinned function ids, the method allowlist, credential-scrubbing `publicFetch`, the paced `PacedRequestQueue`. No other module fetches upstream.
  - `catalog.ts` — community browse, page cache, and the private `listedCourses` index behind `isListedCourse`/`rememberListed`; the "was this course listed?" guard detail and preview enforce.
  - `detail.ts` — the playable boundary: `public: true`, matching id, a specification — `parsePublicCourseDetail` kept separate from the network call so the rule is testable — plus in-flight dedupe.
  - `preview.ts` — the og-path-only thumbnail proxy with byte, type and pacing bounds.
  - `src/upstream.ts` — the stable facade: re-exports plus `upstreamMetrics()` composed from each module's own counters. Callers import the facade, never the internals.
  - `client-adapter.ts`/`bindings.d.ts`/`request-queue.ts` — the pinned-protocol adapter boundary; upstream export names are wire contracts, not naming guidance.
- **Services**: `catalog.ts` (the validated `courseIndex` plus `prepareMatch` random draws), `playlist-generator.ts` (the cancellable scan job), `leaderboard.ts`, `replays.ts`, `admin.ts`.
- **Cross-cutting**: `request-guards.ts` (HTTP bounds — body size, room-code alphabet), `config.ts`, `shutdown.ts`, `event-log.ts`, `deployment-headers.ts`, `domain.ts` (shared types and validators), `join-errors.ts`.

## Client scripts (`scripts/`)

Authored JavaScript lands inside pinned bundles at splice points; which file shares scope with which is the contract that decides where a helper may live. `authored_module()` in `patch-client.py` strips `export` markers at concatenation, so every file lints as a module while sharing one lexical scope at runtime — a shared name must also be declared in `eslint.config.js` globals, and `const` names must stay unique across each bundle's members.

- **`GameRoot` scope** (lobby/dialog/settings): `picker-playlist.js`, `picker-ui.js`, `picker-catalog.js`, `picker-generator.js`, `picker.js` (concatenated in that order), `results-export.js`, `lobby.js`, `follow-controls.js`, `match-details.js`, `host-menu.js`, `player-management.js`. Shared helpers such as `bpHostAuth`/`bpHostRequest` and the picker atoms live here and are usable across these files.
- **`GameCanvas` scope** (transport/simulation): `party-transport.js`, `follow-camera.js`, `bp-ghost-color.js`. `party-runtime.js` goes to `runtime-*.js`, the store the transport writes into.
- **`party._code` scope** (the route bundle): `party-loading.js`, `party-overlay.js`, `party-entry.js`, `party-route.js`. These cannot reach `GameRoot` helpers; `party-entry.js` builds its own host credentials for exactly that reason.
- **`Replay3D` scope**: `party-replay-scene.js`.
- **Standalone pages**: `home.ts`, `admin.ts`, `leaderboard.ts` are TypeScript transpiled on demand (`client-scripts.ts`), each its own bundle — nothing shared with the patched client.
- **`AppearanceClone`**: physics pause patch only; authored code does not live there.

## Room state machine

`room.ts`'s `phase` field is the single source of truth; the client renders whatever the snapshot reports, so transitions only ever happen here.

```
                 host start
        lobby ──────────────▶ countdown ──countdown elapsed AND all──▶ playing
          ▲                        ▲        required scenes ready        │
          │                        │        (READY_GRACE bounds the      │
          │                        │         wait, never shortens it)    │
          │                        │                                     │ every player
          │                        │                                     │ resolves, or
          │                   hole-results ◀─────────────── timer expires│
          │                        │                                     │
          │                        └───── next hole (when course voting  ▼
          │                               is on, a ballot runs inside
          │                               this phase first)
          │                        │
          │                        └───── last hole ──▶ final ──host reset──┐
          │                                                                │
          └────────────── host reset (any phase) ◀─────────────────────────┘
```

- `lobby` — admission, configuration, saved playlists, ballots may not run.
- `countdown` — created by `begin()`; the approved countdown runs and `playNotBefore` is set. When course voting is on, `openVote` runs a timed ballot **inside a `hole-results` phase** (phase is `hole-results` with a live `vote`, even ahead of hole 1), the room freezes the tally, draws once, and only then enters `countdown`.
- `playing` — the round clock is running; this is when readiness may only ever have lengthened the wait, never started it early.
- `hole-results` — standings broadcast; the next `begin()` produces either another `countdown` or `final`.
- `final` — leaderboard/recording side effects via `onFinalize`; `reset()` returns to `lobby`.

Every transition broadcasts a fresh snapshot; spectators and mid-match arrivals read `phase` to decide what to render. A persisted room restarts in `lobby` — browser-local physics state cannot be reconstructed, which is why `final`/`playing`/`hole-results` never survive a restart.

## Where a contract is pinned

- HTTP bounds: `request-guards.ts` — body cap, room-code alphabet, method sets.
- Wire types between browser and room: `room-types.ts` plus the frame handling on `Room.handle`.
- Upstream wire names: `src/upstream/bindings.d.ts` — pinned export ids are the contract.
- Patch anchors: `scripts/patch-client.py` — every `replace_once`/`replace_count` asserts exact multiplicity; a drifted upstream build fails the patch run rather than silently half-patching.
