# Better Party — local proof of concept

Independent party backend with the original, pinned November 16, 2026 putt.day game engine. No official party-server or account dependency. Do not distribute proprietary client bundles or assets without permission.

## Start

Requires Bun, Python 3 and curl. After cloning the private repository, prepare the original public static client assets locally:

```sh
bun run prepare:client
bun run start
```

Open http://127.0.0.1:8789/. Create a room, join with a local name, and open its invite URL in another tab or browser. Select a playlist in the host controls, browse the live public community catalog, add courses in order, and start the party. Use a separate tab/session for each player.

## Implementation

- `src/room.js`: independent room authority, WebSocket protocol, local identity, host permissions, roster, countdown, progress, presence, timeout, standings, rematch and reconnection.
- `src/upstream.js`: read-only public listing and public map detail using the original serialization protocol. No upstream party calls, account credentials, or writes.
- `src/catalog.js`: validates map specifications with the original game validator before retaining a match snapshot.
- `scripts/patch-client.py`: hash-pinned changes to bootstrap, auth and picker. GameCanvas transport and runtime party state have surgical compatibility patches; original physics and rendering are unchanged. Prepared originals and generated web assets are ignored by Git.
- `scripts/picker.js`: replacement host playlist picker with pagination, search, rating/sort, inline original community preview images, playlist reordering and authoritative titles.
- `tests/room.test.js`: deterministic tests for protocol and authority.
- `scripts/run-browser-test.sh`: isolated Chromium integration check on the local server; browser logs remain local.

Client setup uses `python3 scripts/prepare-client.py`. It retrieves pinned public assets listed in the manifests, verifies every locked JS/CSS hash, and regenerates the patched client. There is no HAR or external-project dependency.

## Scope and limitations

This is a private development prototype bound to loopback, not production hosting. Active match state and validated match specifications are in memory; room settings and credentials are persisted in private SQLite storage. All selectable courses come from the live public catalog. No bundled or disk-cached map is used. Non-finishers are eliminated when elimination is enabled (the original client explicitly describes this behavior). Successful players advance; the match ends once at most one survivor remains or the playlist ends. Without elimination, non-finishers receive max(strokes, par + 5). Exact ranking, tie and penalty policies are provisional, not claims of original-server parity. A same-document reconnect restores progress; a full reload forfeits an unfinished active hole because the local physics state cannot be recovered. Player UIDs are public, session secrets are private. Empty rooms expire after 30 minutes. The official client reports strokes; physics is not server-verified. Public catalog availability depends on the upstream site's public read API and pinned protocol. Public course rendering needs further asset coverage and gameplay testing. No official accounts, leaderboard submissions, or production party modifications are made.

A public deployment needs redistribution permission, security and rate-limit review, durable room storage, asset completeness, protocol tests, and a dedicated reachable host.

## Validation commands

```sh
bun test
bun scripts/check-live-catalog.mjs
BROWSER_SCRIPT=scripts/browser-lifecycle.mjs bash scripts/run-browser-test.sh
```

The live integration uses only read-only public upstream endpoints and private Better Party rooms. The full two-browser harness also exists in scripts/browser-match.mjs. Browser debug transport loss is reported as a failed test, never a pass.

## Host controls

The flag menu beside Settings is restricted to the authenticated host. Add 15, 30 or 60 seconds to the current round (up to 15 minutes); extensions do not change the default for future holes. Skip voids the current hole without scoring or elimination. Restart resets only the current hole and retains prior results. End displays standings, retaining completed scores and not penalizing unfinished players. These are Better Party rules, not upstream protocol commands.

## Saved playlists and scorecards

Save named playlists in the host's browser, reorder by dragging or using arrows, and restore them in another room. Only IDs and playlist names are stored; loading fetches fresh public course specifications and replaces the playlist only after every hole is validated. Guests can see selected courses with thumbnails before starting. Final scorecards record successful strokes, timeout penalties, elimination, administrative skips and interrupted rounds. Solo elimination continues while the solo player survives. Match and hole identifiers on progress messages prevent stale packets after a skip or restart.

Browser regression: `BROWSER_SCRIPT=scripts/check-playlists.mjs bash scripts/run-browser-test.sh` (set BASE to the running server).

## Room recovery and random rotation

Room configuration, public playlist metadata, private join credentials and random assignment history are persisted in a private SQLite database at `state/rooms.sqlite` (override with BP_DB). The database never stores playable course specifications. A process restart restores rooms to their lobbies, not the middle of a match; clients are informed when a match was interrupted. Existing authenticated players can return to a locked room. Rooms without activity for 30 minutes are expired. Back up this database privately: it contains session secrets.

Random selection excludes previously assigned random holes until the live public catalog is exhausted, then starts a new cycle. A single match never contains duplicate randomly selected holes. Manual playlists can still contain duplicates. Catalog changes during pagination can require retrying selection.

The home screen contains only party creation, join and return-to-party controls. Community cards remain in the playlist picker. Lobby hosts can set the maximum number of players and lock admission; the HUD shows the next course. Input is disabled during connection loss.

Verification: `bun test`, `bun scripts/check-recovery.mjs` (starts and restarts an isolated local service), and `BROWSER_SCRIPT=scripts/check-recovery-ui.mjs bash scripts/run-browser-test.sh`.

## Custom match settings

Random holes support 1–9 rounds and timers of 20–300 integer seconds, using synchronized sliders and number fields. The optional daily exclusion uses all pages of the live public daily catalog on each new random match and the original Pacific-time daily numbering function. Manual playlists have no nine-hole cap; maps are fetched live as rounds advance. Normal transport and storage resource limits still apply. The original toolbar Home button preserves the room for rejoining.

## Independent upstream capture

From this project directory, run:

```sh
bun run capture:client
```

This stages a timestamped snapshot under `captures/` with a JSON manifest, original public JavaScript/CSS, favicon, models, textures, sounds and sky assets. It discovers the current entry and preload manifest from public /party and /holes HTML, traverses literal module imports, extracts stock asset paths from the original registries and reads GLB texture references. The project media manifest supplements dynamically constructed paths. It does not collect HARs, cookies, authorization headers, raw HTML, private party traffic or account data.

If the pinned bundles are unchanged:

```sh
bun run capture:client --apply-compatible
bun run prepare:client
```

The independent capture checks every locked bundle against `scripts/client-lock.json`. Changed filenames or content are reported; incompatible captures remain separate from the running client. A new upstream build requires reversing the changed bundles, updating protocol and patch bindings, reviewing the new lock and running the tests. Do not bypass the checks. Both capture snapshots and private built assets are ignored by Git.

Tab titles show the room code in the lobby, the actual course name and hole number during a match, and Results at the end. The favicon is the unmodified upstream favicon.

Guests see a loading indicator when the host starts a match. It follows the authoritative preparation flag and disappears at the countdown or when preparation ends.
