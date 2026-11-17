# Better Party development backlog

Review baseline: `b7c4d28` (2026-11-17). This is the implementation and review checklist for the next development pass. It records known defects, verification gaps, proposed features, and deployment prerequisites separately. A proposed feature is not evidence of an existing bug.

## Working agreement

- [ ] Read `AGENTS.md`, `docs/architecture.md`, `docs/development.md`, this backlog, and the current Git diff before editing.
- [ ] Work in logical, reviewable commits. Update this checklist as tasks are completed, with evidence in commit messages or a concise implementation report.
- [ ] Keep the independent Better Party backend and the original putt.day game client. Do not replace the engine or rely on the official party backend.
- [ ] Reverse-engineer available original bundles, WASM and relevant binary dependencies before changing compatibility behavior or making protocol test requests. Establish the actual call paths and data contracts. Do not infer correctness merely from successful requests.
- [ ] Preserve the approved home, join and rejoin layout, original in-game UI, original favicon, and actual community-browser card design. Do not invent decorative UI or generic substitutes.
- [ ] Use live public community courses. Do not bundle, permanently cache or maintain a separate playable course collection. Metadata and bounded process-local validated specifications are acceptable.
- [ ] Preserve all existing functionality, including unlimited manual playlist length, duplicates, random history, custom settings, host controls and scorecards. Resource limits must not silently reintroduce a nine-hole manual playlist cap.
- [ ] Keep handwritten code readable, descriptive, formatted, linted and typed. Keep exact upstream anchors and ABI aliases isolated from authored implementation. No lint/type suppressions or unnecessary abstractions.
- [ ] Keep the repository private. Do not commit downloaded client assets, room databases, HAR files, credentials, recordings or logs. Do not publicly deploy without authorization and asset-rights review.
- [ ] Run relevant unit, protocol and real-browser regressions after each subsystem change. Never weaken assertions, remove tests or hide failures to obtain a green result.
- [ ] Use isolated rooms, database paths, browser profiles and ports for tests. Do not interrupt the live local service or other agents' work without coordination.
- [ ] Obtain approval for major product-policy changes (e.g. elimination rules, host succession policy, account system, public deployment). Optional features below are proposals, not permission for destructive changes.
- [ ] End with a clean working tree, exact commit range, completed/uncompleted checklist, test results and known limitations. Do not claim every possible bug is fixed.

Priority: P0 = correctness or prerequisite; P1 = important improvement; P2 = optional expansion. "Verify" means establish evidence before deciding whether a code change is needed.

## 0. Verified baseline

These are already implemented; preserve them and rerun their regressions as appropriate.

- [x] Independent Bun/TypeScript room server and original game engine integration.
- [x] Public catalog search, sort, rating/author/daily filters, community cards and thumbnails.
- [x] Random course selection with per-room history and optional daily exclusion.
- [x] Manual playlists with duplicates, reordering, local save/load and no nine-hole cap.
- [x] Host configuration: random hole count, exact timer seconds, elimination, maximum players, lock.
- [x] Host extend-time, restart, skip and end commands with acknowledgements.
- [x] Guest match-preparation indication, standings, final results and scorecard.
- [x] Session-based rejoin and persistent room settings; interrupted matches restore to lobby.
- [x] Shared rejoining/loading screen with original layout, retry, expired-session recovery and return home.
- [x] Hide incomplete HUD until initial state and original scene readiness.
- [x] Extract readable party WebSocket adapter; synchronize initial snapshot/roster/board; bounded reconnect backoff; stop duplicate-tab reconnect loops.
- [x] Strict backend TypeScript, Prettier, ESLint, Ruff, ShellCheck, pre-commit hook and CI.
- [x] Verified 63 pinned bundle hashes and generated client syntax.
- [x] Baseline verification: 21 unit tests, 148 assertions, five latest browser regressions and live WebSocket lifecycle all passed. Earlier browser/catalog/recovery regressions passed before the latest transport change; rerun all in the next pass.
- [x] README uses the homepage wordmark; local service runs at http://127.0.0.1:8789/.

## 1. Core correctness and lifecycle (P0/P1)

- [x] **P0 — Re-run the entire current integration suite.** (Done 2026-11-17: `bun run check` clean; protocol, recovery and live-catalog integrations pass; all 15 browser regression scripts pass. Stale preview-modal selectors in `browser-lifecycle.mjs` fixed to match the approved inline-thumbnail card design (e2b006d). One transient failure each in `check-guest-starting` and `check-host-actions` on first run — a live-catalog course fetch/start rejection — both passed unchanged on rerun; recorded as upstream flakiness, not a code defect.)
- [x] **P0 — Round identity.** (Audit complete: prog/forfeit/completion and host commands are matchId/holeIndex scoped and idempotent; restart regenerates matchId and clears positions; ghost positions are keyed to per-join player IDs and removed on disconnect. Ghost position frames are not matchId-scoped because the abbreviated wire keys carry no round identity; impact is bounded by per-join ID regeneration, position clearing at each hole start and the 40ms rate limit. No unscoped completion path found; no change made.)
- [x] **P0 — Course identity/readiness.** (Verified by existing regressions: browser lifecycle plays the same course twice in one playlist and renders both rounds correctly; the host-actions regression restarts the same map and asserts a new matchId, increased attempt sequence and zeroed strokes. Same-map restart readiness is additionally guarded by matchId regeneration forcing a level reload.)
- [ ] **P0 — Join handshake.** Verify hello, authoritative snapshot, roster membership, board and final-state handling; no commands before synchronization. Confirm reconnect cannot reuse stale roster/board data, old errors or final state. Test delayed/missing messages.
- [ ] **P0 — Initial render.** Test fresh join, rejoin, countdown, playing, hole results and final results with delayed packets/assets. Never expose unfinished lobby or stale end screen. Prevent hidden controls receiving focus/input.
- [ ] **P0 — Loading fairness.** Establish original renderer/physics readiness semantics, including the scene fallback timeout. Coordinate server round start with client readiness and a bounded deadline so one slow/disconnected client cannot stall everybody indefinitely. No player should silently consume most of a round while loading. Preserve the authoritative timer and spectator behavior.
- [x] **P0 — Next-course failure.** (Fixed: retrieval failure no longer terminates the match. The room stays in hole-results with scores and history intact and the snapshot carries nextError; the host can retry-next (generation-guarded against competing retries and stale completions), skip-next (voids the unloaded hole in round history and advances or finalizes) or end. Client surfaces nextError in the party state, host panel and alert. Three unit regressions added; browser-level forced-failure coverage still open. Commit 261e6e1.)
- [x] **P0 — Match preparation across disconnects.** (Preparation completion is now guarded by authenticated host UID and in-progress preparation state rather than the original host socket; failures report to the current host socket. Regressions added for preparation surviving host reconnect and failure reporting to the reconnected socket. Commit 7070907.)
- [x] **P0 — Admission limits.** (Capacity is checked at issuance and again at socket admission; the host token no longer bypasses the full-room check unless the join claims or retains host authority. Semantics documented: spectators count toward the maximum, returning connected players keep their slot when the limit is reduced, nobody is evicted. Regressions added. Commit c04f78a.)
- [x] **P0 — Random history rollover.** (Fixed: the rollover cycle now retains every course played in the rollover match, not only the deferred previously-seen IDs; previously the freshly selected IDs were lost from the new cycle's history. Regressions cover the rollover boundary, follow-up match avoidance, deleted history entries and duplicate catalog IDs. Commit f809e0c.)
- [ ] **P1 — Configuration acknowledgement.** Add operation/revision handling for settings and playlist edits so rapidly changing sliders, numeric entry, reorders and imports cannot overwrite newer state. Preserve partial configuration semantics. Give actionable errors on rejected updates.
- [ ] **P1 — Request lifecycle.** Cancel or invalidate fetches and preparation when leaving, switching rooms/modes, changing search filters, rematching, disposing or cancelling. Prevent stale results from writing into a different room or newer operation.
- [ ] **P1 — Error lifecycle.** Clear resolved errors, distinguish network/permission/full/locked/expired/map errors, avoid infinite loading and misleading spinners, make retry and return home reliable.
- [ ] **P1 — Room expiry and recovery.** Verify idle expiration, live sockets, interrupted starts, empty rooms and reconnect races. Clean up issued credentials when safe without losing valid returning identities.
- [ ] **P1 — Same-document navigation.** Check unsubscribe, timer cleanup, abort handling and stale callbacks during route changes and browser back/forward.
- [ ] **P1 — Home admission UX.** Bound create/join requests, prevent double submits and conflicting navigation, handle inaccessible storage, clear or hide obsolete recent-room links, match room-code alphabet consistently.

## 2. Transport and connection resilience

- [ ] **P0 — Offline transport tests.** Make the adapter testable with injected socket/time/store bindings rather than real upstream servers. Exercise handshake ordering, malformed messages, backoff, stale callbacks, disposal, terminal errors and duplicate tabs.
- [ ] **P0 — Gameplay reconnect tests.** Disconnect during aiming, charging, rolling, completion, forfeit, countdown, results and transition to next hole. Verify exactly-once scoring, preserved identity, current authoritative state and absence of stale replay.
- [x] **P0 — Completion delivery.** (Audited and fixed: completion/forfeit flags were set on socket-write acceptance and reset only on round change, so a write accepted by a socket that died before server processing was never retransmitted on the same round. Each connection now re-arms the flags; server-side acceptance is idempotent because results from players already marked done are ignored. Commit 4069468. Remaining gap: no offline harness yet to prove retransmission timing directly — see offline transport tests below.)
- [ ] **P1 — Heartbeat liveness.** Handle pong/last-receive deadlines and half-open sockets; retry with bounded jitter/backoff. Respect browser throttling and avoid declaring a suspended background tab dead without evidence.
- [ ] **P1 — Terminal admission failures.** Stop retrying permanent failures, distinguish room missing/full/locked/invalid credentials/other-tab replacement and provide appropriate recovery.
- [ ] **P1 — Reconnect UX.** Retain the approved shared loading style; ensure connection warnings and stale errors do not persist after recovery. Review whether a full-screen overlay during brief gameplay disconnection is appropriate; do not unblock actions before synchronization.
- [ ] **P1 — Presence cleanup.** Remove departed/stale ghosts, handle old socket IDs on reconnect/restart, scope positions to a round and preserve original 100ms update behavior unless measured changes justify it.
- [ ] **P1 — Backpressure.** Detect excessive bufferedAmount and server send backpressure. Drop/coalesce nonessential presence updates, not critical results or acknowledgements.
- [ ] **P1 — Time synchronization.** Verify skew, latency and timer extension handling; avoid visible timer jumps or client deadline extending past server acceptance.

## 3. Host and player management

- [ ] **P0 — Host transfer.** Authenticated, acknowledged transfer to a connected eligible player. Update roster, permissions, import authorization, reconnect and persisted host ownership atomically. Revoke old authority; do not leak the original host token.
- [ ] **P0 — Host succession.** Define deliberate departure vs temporary outage, grace period and eligible successor selection; recover abandoned rooms without surprise ownership takeover. Persist the chosen host.
- [ ] **P1 — Kick.** Host-only action with confirmation, explicit reason and correct socket/roster/credential cleanup. Define impact during a round; old connection must not immediately reclaim the slot.
- [ ] **P1 — Ban.** Define temporary room-level ban semantics and limitations of anonymous identities; avoid claims that an anonymous user can never re-enter. Provide unblock control.
- [ ] **P1 — Spectators.** Explicit spectator admission and host-controlled player/spectator changes. Define allowed phases and prevent bypassing scoring/round state by switching roles.
- [ ] **P1 — Connected status.** Show disconnected participants accurately in lobby, game and results without conflating eliminated/spectating/disconnected.
- [ ] **P1 — Nickname changes.** Preserve identity and scores, validate name length/content, synchronize name changes and rejoin behavior. No credential leakage.
- [ ] **P1 — Cancel preparation.** Host can cancel pending course preparation; stale operations cannot start a match later.
- [ ] **P1 — Invite links.** Keep ordinary party URLs, copy feedback, keyboard and clipboard-failure fallback. Verify actual external host/origin when deployment is authorized.
- [ ] **P2 — Require readiness.** Optional rule requiring eligible players to be ready; distinguish UI readiness from renderer readiness.
- [ ] **P2 — Pause/resume.** Define authoritative semantics, timers, simulation behavior and reconnect state before implementing. Prevent client-only pause exploits.

## 4. Catalog and playlists

- [ ] **P0 — Preserve live-only source.** Every playable course originates from a validated public detail response; never silently fall back to a bundled/disk-cached course database.
- [ ] **P0 — Public course identity.** Verify catalog ID vs specification ID, visibility, revision changes, duplicate IDs/forks and metadata consistency from original bundles. No private course access.
- [ ] **P0 — Historical daily exclusion.** Reverse-engineer archive and revision bundles; verify whether every previously featured public hole is identifiable, including changed/removed metadata and future scheduled holes. Document limits rather than claiming unproven completeness.
- [ ] **P1 — Saved playlist performance.** Existing loading deduplicates IDs within one operation; remove additional unnecessary detail fetches, coalesce overlapping requests and avoid redundant validation where current in-memory validation suffices. Preserve fresh retrieval at match start and explicit failure behavior.
- [ ] **P1 — Upcoming prefetch.** Load the next selected course while playing the current one, using bounded process-local data and cancellation/generation checks. Do not load an entire huge playlist unnecessarily or hit upstream aggressively.
- [ ] **P1 — Playlist import/export.** Share portable playlist IDs and optional settings as versioned JSON; validate and resolve through live public API. Handle duplicates/order and invalid entries. Never export tokens or hidden specs.
- [ ] **P1 — Paste course URL.** Parse allowed official public hole URLs, verify original route/detail contract and visibility; do not fetch arbitrary user-controlled URLs.
- [ ] **P1 — Playlist editing.** Rename, duplicate, delete with confirmation, explicit overwrite, useful list ordering; handle storage quota/corruption and migration. Avoid silent loss of saved lists.
- [ ] **P1 — Shuffle.** Shuffle manually selected order without changing membership or removing intentional duplicates.
- [ ] **P1 — Random filters.** Creator, rating, par and any other filters actually supported by original public APIs; document client-side filtering tradeoffs and avoid guessing backend query fields.
- [ ] **P1 — Invalid courses.** Identify deleted/private/invalid/unavailable entries individually with retry/remove options. Do not discard an intact saved playlist silently.
- [ ] **P1 — Search/pagination.** Verify use of official stable sort/offset semantics, duplicates under catalog changes, stale pagination, end-of-list state, empty results and retry. Preserve original filters and card appearance.
- [ ] **P1 — Cache and queue limits.** Bound courseEntries/listedCourses, preview queue and public fetch queue by memory/work limits. Keep active room course references available. Coalesce duplicates, honor timeouts and Retry-After, handle 429/5xx with bounded backoff and cancellation. No aggressive scraping or permanent playable cache.
- [ ] **P1 — Thumbnail state.** Correct lazy loading, missing images, fallback, retry and layout stability; keep original card dimensions.
- [ ] **P2 — Preview/practice.** Use original game client in a safe independent preview; do not accidentally join/mutate a match or use official account-only controls.
- [ ] **P2 — Favorites.** Local personal favorite IDs and filters.
- [ ] **P2 — Random preview.** Preview selected random playlist before starting, with a defined impact on history and ability to regenerate.

## 5. Gameplay, physics and scoring

- [ ] **P0 — Background simulation.** Original Version 2 fixed-step clock explicitly suspends while hidden and discards elapsed time. Reverse its WASM/JS clock, ordered before/after physics callbacks, render driver, events, input cancellation, world stepping and interpolation before implementing changes. Compare Version 1. Preserve 120Hz stepping and game behavior; do not simply remove visibility checks. Consider browser suspension limitations, safe catch-up and worker approaches. Test real background tabs without disabling throttling. Do not promise background execution when the browser/OS suspends the page.
- [ ] **P0 — Repeat/restart correctness.** Verify identical IDs and repeated courses fully reset physics, ball position, shots, event runtime and score; stale packets/callbacks cannot complete a newer attempt.
- [ ] **P0 — Multiplayer actual shots.** Real original-client simulations for multiple players and courses, not only synthetic finish messages. Verify hole-in-one, ordinary shots, reset, water, moving obstacles, forfeit, timeout and simultaneous completion.
- [ ] **P1 — Active round rejoin.** Investigate whether original game state and physics can be serialized/restored deterministically, including moving devices/tick state, shots and timers. If not, preserve explicit spectator/forfeit behavior rather than enabling unauthorized resets.
- [ ] **P1 — Original scoring behavior.** Reverse available official client ranking, eliminated/finished flags, board, round transitions, podium, tie handling and rematch semantics. Distinguish proven client behavior from independent server policy; do not claim exact official server parity without evidence.
- [ ] **P1 — Timeout penalties.** Review current par+5 minimum, ties, stroke play and elimination outcomes; make configurable only after policy approval. Keep scorecard consistent with totals.
- [ ] **P1 — Late joins and disconnects.** Define eligibility across playing/countdown/results/next match, last-player handling and all-disconnected rooms; preserve fairness.
- [ ] **P1 — Scorecard.** Course names, par, per-hole strokes, total/relative-to-par, skipped/ended/DNF/timeout states, disconnected players and final standing consistency. Make readable on phones and long playlists.
- [ ] **P1 — Upcoming course display.** Show next hole and loading/retry state accurately; avoid showing stale course title or incorrect index.
- [ ] **P1 — Match history.** Retain completed result metadata and scores through rematches/restarts with bounded retention and privacy-conscious storage; do not persist playable course specs.
- [ ] **P2 — Export results.** Shareable scorecard or CSV/JSON without private credentials.
- [ ] **P2 — Team mode.** Independent optional rules; design scoring, readiness and disconnect behavior first.
- [ ] **P2 — Tournament mode.** Multiple rounds/matches, brackets or standings; only after base lifecycle is reliable.
- [ ] **P2 — Server-verifiable gameplay.** Study feasibility of deterministic validation using recovered engine/runtime; do not treat client-reported results as verified physics. No engine rewrite as a substitute for the existing client.

## 6. UI, accessibility and compatibility

- [ ] **P0 — Preserve approved shared entry screens.** Real browser regression for desktop, 390px and 320px layouts. Same wordmark, party code, inline spinner and full-width rounded home button through rejoin/load; no flashing broken UI.
- [ ] **P0 — Hidden UI accessibility.** Use appropriate inert/focus management during overlays while keeping engine/socket mounted; block keyboard/pointer actions, restore sensible focus when ready.
- [ ] **P1 — Consistent loading/error states.** All recovery paths, course loading, lobby errors and WebGL failures should provide useful actionable messages without added gimmicks.
- [ ] **P1 — Responsive lobby.** Host controls, player list, cards and long playlists fit narrow/short viewports; avoid nested unusable scroll areas, clipped controls and unexpected layout jumps.
- [ ] **P1 — Touch playlists.** Reorder and remove on mobile without mouse-only drag/drop; retain keyboard-accessible controls.
- [ ] **P1 — Community design parity.** Match official gallery spacing, typography, cards, previews, filters and responsive behavior from original bundles/CSS; use party-specific add/remove controls only where needed.
- [ ] **P1 — Accessible interaction.** Real button/link semantics, keyboard navigation, focus outlines, labels, ARIA status/alerts, contrast, reduced motion and touch target sizing.
- [ ] **P1 — Host actions feedback.** Clear confirmations, disabled states, pending acknowledgements, errors and timeout handling. Avoid duplicate action submission.
- [ ] **P1 — Clipboard fallback and invites.** Usable if Clipboard API denied/unavailable.
- [ ] **P1 — Browser coverage.** Safari, Firefox, Chromium, iOS and Android; check WebGL/WASM support, input touch, audio permissions, background behavior and viewport resizing.
- [ ] **P1 — Renderer failure.** Context loss, GPU disabled, unsupported WebGL, missing assets and scene preparation timeout should fail safely with recovery.
- [ ] **P1 — Wordmark consistency.** Maintain a single branding definition where practical; retain current homepage/README appearance and favicon. Verify actual fonts (external font imports are currently blocked by local CSP); resolve lawful local font handling if necessary.
- [ ] **P2 — Visual regression.** Screenshots of approved screens and original UI, compare intentional changes instead of arbitrary redesigns.

## 7. Code structure and quality

- [ ] **P0 — Typed frontend.** Extend meaningful strict TypeScript checking to authored client components and transport; use typed adapters for upstream ABI and runtime boundary validation. Leave original bundles untouched.
- [ ] **P0 — Protocol contracts.** Define discriminated unions for client/server messages, payload validators and explicit version/round identity. Preserve original wire names where required. Share types across authored code.
- [ ] **P0 — Persisted data validation.** Parse unknown JSON, validate version/schema, bounds, credentials, config, course metadata and history; handle corrupt rows, unsupported versions and safe migrations without data loss.
- [ ] **P0 — Naming and style.** Remove remaining minifier-style or mechanically misnamed authored identifiers (e.g. generic btn/cls/prev, misleading courseIndex/positionY names where they mean something else). Use descriptive local names and clear control flow. Keep ABI names only at boundaries.
- [ ] **P1 — Room responsibilities.** Separate admission, roster/authority, configuration, round state/progression, scoring and presence where cohesive. Avoid unnecessary abstractions or arbitrary line-count targets.
- [ ] **P1 — HTTP responsibilities.** Extract routes, input validation, authorization and static serving from server bootstrap. Remove unused endpoints only after mapping every caller.
- [ ] **P1 — Picker responsibilities.** Split catalog fetching/filter state, course cards, selected playlist, saved playlist persistence and operation status into coherent components/hooks. Preserve native appearance and ordering semantics.
- [ ] **P1 — Upstream services.** Separate protocol serializer/transport, catalog/metadata, detail validation and preview proxy/cache. Keep pinned imports behind stable documented adapters.
- [ ] **P1 — Patcher.** Extract substantial authored JS into ordinary modules/snippets. Keep exact, counted compatibility anchors; document every alias and linkage, fail if anchors are missing/ambiguous.
- [ ] **P1 — Consolidate repeated state and helpers.** Shared entry layout, error handling and request logic where it actually reduces duplication; remove dead code and redundant patches without altering original engine.
- [ ] **P1 — Quality enforcement.** Review lint rule coverage including tests, hooks, shell scripts, Python patcher and frontend types. Avoid broad exceptions; use type-aware rules where worthwhile. Run formatter/linter/type checker/tests in CI.
- [ ] **P1 — Test readability.** Descriptive names, shared helpers for stable CDP setup, typed browser expressions where practical, no hidden exceptions. Preserve meaningful strict assertions.
- [ ] **P1 — Measure performance.** Profile large playlists, many concurrent rooms and long-running connections before optimization.
- [ ] **P2 — Architecture/protocol documentation.** Maintain accurate module contracts and state diagrams; generate where helpful without adding redundant documentation machinery.

## 8. Upstream client preparation and compatibility

- [ ] **P0 — Full dependency inventory.** Reverse original route graph, static and dynamic imports, WASM, registries, models, textures, audio, themes, runtime-generated paths and relevant fallback paths. Distinguish required from optional assets.
- [ ] **P0 — Required-asset integrity.** Detect missing/truncated required media at build time; hash static media as well as JS/CSS. Validate expected MIME/size/path. Fail closed on incompatible or incomplete builds.
- [ ] **P0 — Atomic preparation.** Stage download, verify, patch and syntax-check in isolation, then publish only a complete build. Never overwrite original binaries or leave partially patched live assets. Preserve rollback.
- [ ] **P1 — Download resilience.** Safe temporary files, bounded retry, timeout, origin allowlist and no unsafe redirects. Avoid treating a nonempty partial download as valid. Remove stale generated files when replacing a build.
- [ ] **P1 — Capture workflow.** Test compatible installation, missing files, changed hashes, new logical modules and failed manifest parsing. Incomplete captures must report failure distinctly while preserving diagnostic snapshots.
- [ ] **P1 — Version-diff report.** Report changed/new/removed dependencies, registry changes and exact anchors affected. Never automatically update lock or patch incompatible builds.
- [ ] **P1 — Patch inventory.** For each patch document original hash, original behavior, binding proof, intended behavior and regression evidence. Verify no physics/input/rendering changes outside intentional changes.
- [ ] **P1 — Runtime compatibility.** Cover V1/V2 maps, special themes/devices/events and required stock media. Establish which features are supported by pinned client instead of guessing.
- [ ] **P1 — Reproducible installation.** Test clean checkout with no private-client/web cache; document what happens if pinned upstream files are no longer available. Do not add proprietary assets to source control.
- [ ] **P1 — Local static serving.** Ensure generated assets and server HTML use matching versions, browser caching and rollback policy. Audit service worker or browser cache interference if present.
- [ ] **P2 — Compatibility tooling.** Automate read-only version/inventory checks where useful; do not create scheduled monitoring tasks without explicit user request.

## 9. Regression suite and verification

- [x] **P0 — Run all current tests.** (Same evidence as the section 1 suite re-run: unit suite 29 tests / 182 assertions after this pass's additions; protocol, recovery, live-catalog and all 15 browser scripts run with results recorded above. Classification: unit and protocol/recovery/catalog integrations run offline or against public read-only endpoints; browser scripts require the prepared pinned client and a live catalog for course data.)
- [ ] **P0 — New transport unit tests.** Deterministic fake socket/time and state stores, ordered handshake, retry, disposal, replacement and replay.
- [ ] **P0 — Actual multiplayer browser tests.** Two or more original-client browsers completing real shots; verify board, physics attempt, scores and final results.
- [ ] **P0 — Reconnect matrix.** Network interruption, half-open socket, duplicate tab, full reload, tab close, host departure, admission errors and every round phase.
- [ ] **P0 — Loading matrix.** Delayed/out-of-order relevant frames, assets, expired session, failed admission, retry, scene fallback, repeated IDs, rematch and failed course load.
- [ ] **P0 — Authorization/admission.** Guest attempting host commands/imports, forged UID/token, old socket, transfer/revocation, simultaneous joins, full/locked room, stale round message.
- [ ] **P1 — One integration command.** Reproducible isolated temporary service/database, per-test timeouts, safe browser profile cleanup and summarized failure output. No interference with local live service.
- [ ] **P1 — Deterministic fixtures.** Synthetic or independently authored minimal courses and metadata mocks for tests; no persisted official playable catalog. Retain separate real-public-catalog integration coverage.
- [ ] **P1 — Persistence tests.** Recovery, corrupt rows, schema upgrade, expired sessions, permission preservation, interrupted start, backup and deletion.
- [ ] **P1 — Malformed inputs.** Invalid JSON, oversized messages, invalid numbers, missing fields, unexpected frame types, invalid URLs/IDs, API errors and rate limits.
- [ ] **P1 — Catalog tests.** Pagination mutation, deduplication, daily/archive boundaries, random history rollover, deleted course, 429/timeouts, cache limits, retries and aborted requests.
- [ ] **P1 — Coverage.** Track meaningful branch/behavior coverage, not a percentage target that encourages trivial tests.
- [ ] **P1 — CI expansion.** Offline tests on every change; browser/live integration on explicitly approved jobs when original asset access allows. Separate unavailable external dependencies from actual regressions.
- [ ] **P1 — Capacity/load.** Test 50-player rooms, multiple active rooms, slow consumers and long playlists; measure CPU, heap, queue lengths, DB writes and latency.
- [ ] **P1 — Soak.** Bounded long-running session/reconnect/room expiry test; check timers, subscriptions, caches, sockets and memory.
- [ ] **P2 — Cross-browser and visual automation.** Add browser coverage and approved screenshot baselines; never use screenshots alone as functional proof.

## 10. Security, operations and deployment

Do not publicly expose the service as part of this checklist without explicit authorization. Local-only functionality is the current baseline. Resolve production prerequisites first.

- [ ] **P0 — Deployment configuration.** Configurable listening address, canonical public origin, trusted host allowlist, HTTP/WS scheme and ports; secure loopback defaults. Fix README localhost/127.0.0.1 inconsistency.
- [ ] **P0 — Origin/proxy handling.** Correct WebSocket origin and HTTP host validation behind approved reverse proxy; trust forwarded headers only from configured trusted proxies. No blanket permissive CORS.
- [ ] **P0 — Authorization.** Audit room creation/ownership, host transfer, reconnect session secret entropy/rotation/expiry, import permissions, stale credentials and access after kicks. Never expose secrets in snapshots, logs, URLs or exports.
- [ ] **P0 — Abuse prevention.** Bound create/join/import/catalog requests, WebSocket control/progress/position messages, room/identity counts and pending queues. Rate limits should protect upstream and local service while allowing valid multiplayer.
- [ ] **P0 — Input/storage hardening.** Validate request methods/sizes, public IDs, path traversal, static asset directory containment, untrusted JSON and stored data. Review CSP, preview allowlists, request timeouts and response size limits.
- [ ] **P0 — Asset rights.** Establish permission to serve the original code/models/audio/fonts/artwork beyond personal local use. Keep independent source licensing separate; do not distribute proprietary client assets in release images or Git.
- [ ] **P1 — Docker/OCI.** Reproducible non-root build and runtime, persistent database mount, separate private asset preparation, health check, least privilege, documented architecture support; no proprietary assets baked into a public image.
- [ ] **P1 — Oracle VM deployment.** Only after explicit approval and checking free disk, ARM compatibility, network/HTTPS and asset rights. Use an isolated deployment and rollback plan; do not alter unrelated services.
- [ ] **P1 — TLS and reverse proxy.** HTTPS/WSS, canonical origin, secure headers and correct timeouts/upgrade behavior for authorized deployment.
- [ ] **P1 — Graceful shutdown.** Stop accepting work, cancel timers/queues, close connections appropriately, flush database and release resources. Preserve defined recovery state.
- [ ] **P1 — Backups.** Consistent SQLite backups including WAL considerations, restricted file permissions, retention, restore verification and migration rollback; exclude secrets from public logs/artifacts.
- [ ] **P1 — Observability.** Structured sanitized logs, useful health/ready status, errors, room counts, upstream latency, queue and memory metrics. No telemetry sent to unrelated services.
- [ ] **P1 — Resource efficiency.** Avoid serializing whole large specs/history unnecessarily on every config/timer update; use scoped snapshots where compatible. Reduce synchronous checkpoint writes, bound queue/cache growth and ensure active matches retain required state.
- [ ] **P1 — Service management.** Document environment variables, startup/restart, persistent working directory, logs and operational recovery. Keep default local setup simple.
- [ ] **P2 — Stronger anti-cheat.** Threat model for anonymous client-reported scores, authenticated messages and deterministic verification. Clearly document limitations; no unsupported claims of cheat-proof play.

## 11. Repository and releases

- [ ] **P1 — Clean installation guide.** Dependencies, pinned versions, hook installation, client preparation, exact working loopback address and required assets.
- [ ] **P1 — Versioning and changelog.** Choose a simple versioning scheme, describe user-visible changes and compatibility requirements.
- [ ] **P1 — Configuration reference.** Document all supported settings, limits, origins, storage and operational defaults.
- [ ] **P1 — README screenshots.** Accurate approved UI and useful features, no generic mockups. Keep branding consistent.
- [ ] **P1 — Contribution guide.** Explain baseline, review expectations, local tests, upstream reverse-engineering requirements and what must never be committed.
- [ ] **P1 — Security reporting.** Responsible reporting instructions appropriate for a private independent project.
- [ ] **P1 — License.** Choose a license for independently authored code only with owner approval; document third-party ownership and exclusions.
- [ ] **P1 — Upgrade/rollback.** Preserve room metadata, document migrations and restoring compatible asset/source versions.
- [ ] **P2 — Release automation.** Private source-only releases, version checks, CI gates and reproducible builds. No public distribution or release assets containing original client binaries without permission.

## Recommended execution order

1. Confirm the baseline and run the entire test suite; establish a deterministic regression harness.
2. Fix transport/round identity, course readiness, preparation, admission and random rollover defects. Add the corresponding regressions.
3. Implement host/player management with explicit authority and recovery semantics.
4. Resolve gameplay synchronization and background simulation based on binary analysis. Do not improvise physics behavior.
5. Improve course loading, playlists and UI in small verified changes.
6. Continue software architecture and test cleanup throughout, not as one giant rewrite.
7. Harden preparation, persistence, security and deployment. Leave public deployment and major optional modes pending owner approval.

## Definition of done for review

- [ ] Every implemented item is checked with a reference to the change or test evidence.
- [ ] Every unimplemented item remains open with a concise blocker or rationale; no sweeping "done" claims.
- [ ] Existing and new tests pass; relevant actual-client tests have run, including failure paths.
- [ ] All upstream binding changes have binary/source evidence and reproducible validation.
- [ ] No regressions in approved layout, original rendering/physics, playlist semantics or security boundaries.
- [ ] Reviewable commits, private repository, no proprietary downloads/secrets in Git, clean working tree.
- [ ] Final handoff records commit range, changes, test results, caveats, any policy decisions and how to reproduce the service.
