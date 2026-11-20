# Development

## Tooling

Install Bun, Node.js 22 or later (for lint-staged), Python 3, curl and ShellCheck. In a Python virtual environment, install the pinned Ruff version:

```sh
bun install --frozen-lockfile
python3 -m pip install -r requirements-dev.txt
bun run hooks:install
bun run format
bun run lint
bun run check
```

The quality check runs Prettier, ESLint, Ruff, ShellCheck, strict TypeScript checking and the offline unit tests. CI uses the same check. The installed pre-commit hook formats and lints staged source, runs the type checker and runs the unit tests. Generated assets and room data are excluded from source control and formatting. The complete original asset snapshot is stored under `private-client/`, with every file listed by exact SHA-256 in `scripts/client-lock.json`. The quality check and pre-commit hook run `bun run prepare:client` to reconstruct the original validator and patched browser client offline. Catalog unit tests mock only public network answers and exercise the original pinned validator. No asset downloads or live public server are required.

## Integration tests

Prepare the client and start the service. Live integration tests exercise public read-only catalog endpoints and independent Better Party rooms:

```sh
bun run test:catalog
bun run test:protocol
bun run test:recovery
bun run test:browser
```

The one-command sweep — an isolated temporary service and database on its own
port, one headless browser, every check in sequence with a per-check timeout
and a summarized result — is:

```sh
bun run test:integration
```

It refuses to start rather than interfere with anything already running: a
service answering on its port or an occupied debugging port are both errors.
The service defaults to port 8799 (`BP_TEST_PORT`), deliberately not the 8789
a developer's own service conventionally uses; each script gets
`BP_TEST_TIMEOUT` seconds (default 300) before it is killed and reported as
`TIME`. Passed logs are discarded; failed and timed-out logs are kept and
their directory is printed. `BP_TEST_ONLY=a.mjs,b.mjs` runs a subset,
`BP_TEST_SKIP=a.mjs` drops individual scripts. Helpers and measurement tools
(`cdp`, `playlist-editor`, `profile-load`, `visual-regression`) are not checks
and are never run; `check-voting` is skipped for the documented
headless-renderer stall below; `check-admin` joins only when both
`BP_ADMIN_PASSWORD_HASH` and `BP_TEST_ADMIN_PASSWORD` are set, otherwise it is
reported skipped — a configuration limitation, not evidence. The checks that
start their own service (`check-recovery`, `check-next-failure`) still do so
on their own ports and run inside the sweep unchanged.

To run a single check instead, prepare the client, start a service and use
`BROWSER_SCRIPT`:

Browser integration uses Chromium via the DevTools protocol. Set `CHROME` to an executable if it is not detected automatically. Set `BASE` to the running test service URL if necessary. Select a particular regression using `BROWSER_SCRIPT`, for example:

```sh
BROWSER_SCRIPT=tests/integration/check-entry-style.mjs bun run test:browser
```

### Load and soak

Two harnesses measure the service rather than assert a product behaviour, and
neither runs in the sweep because both need a service configured for them.

`profile-load.mjs` (`bun run test:load`) is a probe: it prints measured numbers
and asserts nothing, so a review compares runs. It creates many concurrent rooms,
seeds a validated course index, broadcasts large playlists, holds long-running
connections, fills one room to `BIG_MEMBERS` (default 50, the real party
maximum), and finally aims `FLOOD_ROUNDS` broadcasts at a consumer that has
stopped reading. That last one is a Python child holding a raw socket: Bun's own
socket emulation drains the kernel regardless of listeners, so only a raw
consumer produces genuine backpressure. It reports create/join/broadcast latency,
pong latency, RSS, and — from `/health` — CPU as a fraction of one core, database
writes and deletes, and the bytes queued for stuck sockets. The point of the slow
consumer is isolation: the healthy member's broadcast latency must stay flat
while the stuck socket's backlog grows.

`check-soak.mjs` (`bun run test:soak`) does assert. It runs `CYCLES` of
create/join/configure/leave, alternating clean closes with abrupt drops, then
waits for the room sweep and requires that every abandoned room is gone, no
socket survives, no undelivered bytes remain, the database saw at least one
delete per room, and heap did not grow with the cycle count. It needs the service
started with a short clock, because the production reclaim window is thirty
minutes:

```sh
PORT=8803 BP_DB=/tmp/soak.sqlite BP_ROOM_IDLE_MS=1500 BP_ROOM_SWEEP_MS=500 \
  bun src/server.ts
BASE=http://127.0.0.1:8803 CYCLES=10 ROOM_IDLE_MS=1500 bun run test:soak
```

`BP_ROOM_IDLE_MS` and `BP_ROOM_SWEEP_MS` change only when the sweep decides, not
what it decides; production runs the same `isReclaimable` on its default
half-hour clock. The scope is the protocol, not the renderer, because a headless
browser cannot survive this many cycles and the leaks being looked for are
server-side.

The loading regression (`check-party-loading.mjs`) delays the initial roster and scoreboard messages while the engine loads to verify that the incomplete HUD remains hidden.

The next-course failure regression (`check-next-failure.mjs`) starts its own service with `BP_TEST_FAIL_MAP_FETCH_CALL` set to a comma list of lazy course-load call numbers that must fail. The room's `loadNext` is the only caller of that loader, so call 1 is exactly the first next-course load; the regression drives the host retry through the real UI.

Recovery tests start an isolated process with a temporary database. A browser debugging disconnection is a test failure, not a successful result.

### Visual baselines

`tests/integration/visual-regression.mjs` captures the approved screens (home, name entry, lobby and the playlist dialog at desktop and mobile widths) into `tests/visual-baseline/`:

```sh
BROWSER_SCRIPT=tests/integration/visual-regression.mjs \
  VISUAL_DIR=tests/visual-baseline bun run test:browser
```

Baselines are machine-local and gitignored: font rasterisation and WebGL output differ between platforms, so captures are only comparable on the machine that made them. After an intentional UI change, capture into a fresh directory and pixel-diff with `tests/visual-diff.mjs` — a self-contained PNG codec, no dependencies:

```sh
BROWSER_SCRIPT=tests/integration/visual-regression.mjs \
  VISUAL_DIR=/tmp/visual-fresh bun run test:browser
bun tests/visual-diff.mjs tests/visual-baseline /tmp/visual-fresh
```

Screens that change print their differing-pixel share and write a `*-diff.png` heatmap into the fresh directory so the change is reviewable rather than guessed at. Two determinism rules keep the diff honest: the live WebGL canvas is hidden for party-surface captures (the lobby overlay is translucent over the running scene), and run-varying data — invite code, ball swatches, course titles, authors, ratings, thumbnails — is redacted to fixed strings. Transient and live-data surfaces (loading, leaderboard, vote, in-play HUD) are covered by the behavioural suites instead; a screenshot is never functional proof on its own.

### README screenshots

`tests/integration/capture-screenshots.mjs` writes the images the README shows into `docs/screenshots/`. It is the opposite of a visual baseline on purpose: nothing is redacted and the WebGL canvas stays visible, because these exist to show a reader what the product looks like. That also means they cannot be compared — the courses a shot contains come from the live catalog — so they are committed as documentation and no test reads them.

```sh
BASE=http://127.0.0.1:8801 bun run capture:screenshots
```

It drives a real prepared client against a real service: creates a party, joins three guests over the protocol, imports real public courses, opens the playlist editor, starts the round and captures the same hole again at 390px. Re-run it after an intentional UI change and commit the result; a stale screenshot is worse than none.

### Known limits of the browser suite

These are measured limits of the test harness and the pinned client, not open
product bugs. They are recorded so a future failure is compared against them
rather than re-diagnosed from scratch.

- **A second themed course can wedge the headless renderer.** `check-voting` is
  the one suite that does not complete. Reproduced at HEAD: it passes
  "opening ballot keeps the neutral scene and never blocks on a candidate" and
  "opening ballot before first hole", then fails with
  `error: CDP timeout: Runtime.evaluate` while waiting for the second ballot's
  round to reach `playing`. The failure is a DevTools timeout, not a server
  error, which is what distinguishes a wedged renderer from a product fault;
  the server side was verified directly, with ballot 1 opening at `target 0` and
  ballot 2 at `target 1` with three choices. The same limit is why water,
  out-of-bounds and moving-obstacle behaviour is covered offline rather than in
  a browser.
- **Generator filters in browser tests must be metadata only.** A filter over
  strokes or par forces a per-course detail fetch across the whole live catalog
  and wedges the same renderer. Rating count plus a maximum course count
  completes in about six seconds and is what the playlist suites use.
- **`check-admin` needs its own configuration.** It requires
  `BP_TEST_ADMIN_PASSWORD` and a service started with `BP_ADMIN_PASSWORD_HASH`
  (generate one with
  `bun -e "console.log(await Bun.password.hash(process.argv[1]))" 'password'`).
  Run on its own against a service without a hash, it fails with an assertion
  saying so rather than passing quietly, which would be the dangerous outcome.
  A full sweep that cannot provide the hash therefore reports it as skipped;
  that is a limitation of the sweep's configuration, not evidence about the
  admin surface. Verified passing against a service started with a hash: unlock,
  wrong password, live room rendering, safe player names, session reload, logout
  and access revocation. The admin API also has offline coverage in
  `tests/admin.test.js`.
- **The live catalog is a moving list.** Drive a test by title search, never by
  position, and do not assert a total count; the pool has been observed at 276,
  428 and 370 courses. Imports also proxy a live fetch to putt.day and can fail
  transiently, so suites retry the same card rather than treating one failure as
  a product fault.
- **An occluded headless renderer freezes.** Every DevTools evaluation must bring
  the page to the front first, or the renderer is throttled and the evaluation
  never returns.

## Updating the upstream client

```sh
bun run capture:client
```

The capture script discovers the current public entry modules, traverses literal imports, inspects stock asset registries and GLB texture references, and stages the downloaded artifacts and hash manifest in a timestamped capture directory. It does not collect account credentials, HAR files or private party traffic.

Capture and preparation are intentionally separate. `capture:client` discovers and saves candidate upstream releases under `captures/`; it never applies them to the archive or generated build. `prepare:client` reads only the committed snapshot, verifies every hash before touching generated output, and rebuilds `web/` and `private-client/validation/`. Missing or modified originals are errors: restore them from Git rather than downloading replacements.

Compare a capture's manifest against `scripts/client-lock.json`. Reverse-engineer changed bundles before updating patch bindings or protocol assumptions. When adopting a reviewed release, update the complete asset lock and corresponding original files together, remove superseded tracked paths, and stage only the verified originals with `git add -f`. Check both unit tests and browser integration before adopting it. Do not make the repository or archived assets public without appropriate permission.

Keep exact match anchors in the Python patcher. Write substantial new JavaScript in separately formatted and linted source files. Upstream lexical bindings are documented in the ESLint config; do not disable linting for the whole patch.
