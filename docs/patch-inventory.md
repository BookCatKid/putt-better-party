# Patch inventory

Every modification applied to the upstream client during `prepare-client`, per
patched bundle. The sha256 prefixes are the immutable archived originals under
`private-client/` (full hashes in `scripts/client-lock.json`); the patch bodies
live in `scripts/patch-client.py` and run in registration order.

**Binding proof.** Anchors are counted, not fuzzy: `replace_once`/
`replace_count` assert the anchor text occurs exactly the expected number of
times and fail the build when upstream drifts; `.index()` splice points raise
on a moved symbol. `patch-client.py --check-anchors <dir>` dry-runs every body
against a capture and names the anchor that breaks; `diff-capture.py` reports
the same per-build. A change outside a counted anchor cannot apply silently —
that is what makes "does upstream still X" answerable offline.

**Regression evidence.** Every staged bundle is syntax-checked before publish,
authored modules are hash-pinned into `build.json`, `bun run check` runs
395 tests, and the browser suites exercise each patched surface live.

## `index-DFMxt6BL.js` — `86e38dd3` — `index_patch` (1 anchor)

|            |                                                                                                                                                                                                                      |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Original   | Vite entry chunk: router/React/shared exports plus the site hydration call `(0,O.startTransition)(()=>{(0,Hs.hydrateRoot)(…)})`.                                                                                     |
| Intended   | Replace only the hydration expression with `scripts/client-bootstrap.js` — the isolated-mode bootstrap that mounts the party shell. Router, React and shared exports are retained so downstream chunks keep linking. |
| Binding    | The full `hydrateRoot` expression is the counted anchor; `client-bootstrap.js` is spliced in verbatim.                                                                                                               |
| Regression | Every browser suite boots through this bundle; `prepare-client` output.                                                                                                                                              |

## `party._code-D3a-IB4-.js` — `816cef20` — `route_patch` (1 anchor, 2 index splices, 4 file reads)

|            |                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Original   | The `/party/:code` route component (`function E(){…export{E as component}`); loads map data through the upstream API adapter `c({data:{id:e}})`.                                                                                                                                                                                                                                                                               |
| Intended   | Two changes: (a) swap the map fetch for `fetch("/api/map/"+encodeURIComponent(e))` — the server's local catalog endpoint; (b) splice the entire route component for `PartyRoute`, assembled from `party-loading.js` + `party-overlay.js` + `party-entry.js` + `party-route.js` bound to the chunk's own React/store symbols (`partyRouteReact = y`, `selectPartyRouteState = l`, …). Export becomes `PartyRoute as component`. |
| Binding    | Map-fetch call counted once; the component body is removed between `function E(){` and `export{E as component}` index splices; the export rename is a single `.replace`.                                                                                                                                                                                                                                                       |
| Regression | Room join + route suites navigate through this component.                                                                                                                                                                                                                                                                                                                                                                      |

## `GameCanvas-C5hQh1sR.js` — `6f77824f` — `transport_patch` (27 anchors, 2 index splices, 3 file reads)

|            |                                                                                                                                                                                                                                                                                              |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Original   | The canvas/transport bundle: the original `Zn` adapter owned the party socket and state-store bindings; scene, camera, input and simulation live alongside it.                                                                                                                               |
| Intended   | (a) **Socket** — replace the `Zn` adapter body with `connectBetterParty` from `party-transport.js`, bound into the chunk via named bindings (`transportPartyStore = M`, `transportGameStore = B`, `updateTransportGhost = Ne`, …); completed-run recording with no deadline (`!r.timerEndsAt |     | `). (b) **Ball placement** — the original `Dn`ball tees at the origin and relies on a post-step teleport;`bpLevel`/`bpRuntimeReady`props plus the inline spawn watcher (14 bundle locals, deliberately not extracted) place each fresh attempt on the real tee *before* either physics driver,`position:`prop included. (c) **Physics pause** —`paused:Ye(l)===2 |     | bpPaused`on the Rapier world and`':'+bpAdminAttempt`in the world key so a host reset rebuilds the world. (d) **Input gate** —`!t&&e&&n>0?(Yt.copy`gains`&&j()`(release requires the allowed check). (e) **Rendering** —`bpColor`/`bpEffect`selectors override local ball color/effect from the roster;`bpHideLocalBall`keeps the ball meshes unmounted for spectators while canvas, course and socket stay mounted;`bpScenePrepared(l.id)`reports readiness;`bpFollowId`/`BpFollowCamera`; appended `bp-ghost-color.js`+`follow-camera.js`, prepended imports for `bp-spectator-follow.js` + runtime exports. Simulation step functions are untouched — the prepare banner's "shot physics unchanged" is contract. |
| Binding    | 27 counted replacements; `Zn` spliced between `function Zn(` and `function Qn(`. The prepared-vs-archived diff produces exactly 19 zones, each mapping to an anchor above (verified mechanically — see "Physics/input/rendering verification").                                              |
| Regression | `room-lifecycle`, ghost-color, follow-camera and physics suites.                                                                                                                                                                                                                             |

## `AppearanceClone-CBos6VT9.js` — `a3712ad3` — `pause_physics_patch` (2 anchors, 1 import prepend)

|            |                                                                                                                                                                                                                                                 |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Original   | Shared animation-loop bundle: a per-frame subscriber loop gated on `document.hidden`.                                                                                                                                                           |
| Intended   | Room-wide physics pause: prepend `bpPhysicsPaused` from the runtime chunk, gate the version-2 tick on it (`r?.version!==2&&!bpPhysicsPaused()&&e(t,n)`), and fold it into the loop's hidden check so `clock.setHidden` follows `document.hidden |     | bpPhysicsPaused()` — pausing freezes every subscriber, not just the tab. |
| Binding    | Both call sites counted once each.                                                                                                                                                                                                              |
| Regression | Room pause/resume suites.                                                                                                                                                                                                                       |

## `runtime-DL2fiDAQ.js` — `61d86522` — `runtime_patch` (8 anchors, 1 file read)

|            |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Original   | Shared runtime chunk: the room store's initial state, snapshot→state mapping, playable/input gates and the charge-release handler.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Intended   | (a) `timerEndsAt=0` treated as unlimited in the playable gate (`&&n&&e.timerMs?…`). (b) Extend the store's initial state — both `active:!0` and `active:!1` literals — with the bp* fields (`vote`, `bpAttempt`, `roster`, `board`, `final`, `matchHistory`, `teams`, `tournament`, connection flags…). (c) Extend snapshot→state mapping (`bpPlaylistRevision`, `bpPausedAt`, `replayId`, `roundHistory`, …). (d) Input gates: `bpInputBlocked()` in the playable check and in charge-release (cancel charging without touching a rolling ball). (e) Spectator `holed` transitions for the active room. (f) Roster updates carry `coHost`/`puttingLocked`/`attempt` epoch — an attempt change resets `mapReady`/`bpSceneReady`. (g) Append `party-runtime.js` bound via `partyRuntimeStore = i`. |
| Binding    | 8 counted replacements; the module append is positional (end of chunk).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Regression | Store contract tests, input-gate and reconnect suites.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

## `GameRoot-7kMtVtdO.js` — `f77c814b` — `game_patch` (37 anchors, 11 index splices, 7 file reads)

|            |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Original   | The in-room game component: course picker `At`, lobby overlay `Mt`, hole-flow HUD, scoreboard, results, host controls.                                                                                                                                                                                                                                                                                                                                                                           |
| Intended   | The largest surface. Grouped: (a) **picker** — splice `function At(`→`function jt(` for `CommunityCoursePicker` assembled from `picker-playlist/ui/catalog/generator.js` + `picker.js` (authored modules, `export` stripped); (b) **lobby** — splice `Mt`→`Nt` for `BpLobbyDashboard` from `lobby.js`, with `results-export.js` shared helpers injected once ahead of both scorecard and lobby; (c) **flow text** — "Loading next community hole…" when `preparing`, elimination edge `a.holes-1 |     | …`, `bpLeaveParty()`on the Leave link so host handoff is immediate,`BpUpcoming`on HUD and results (results is where the next course actually loads),`BpConnectionNotice`; (d) **spectate/follow** — `Ut`renders for watchers during`playing`, imports of `bp-spectator-follow.js`, `follow-controls.js`appended bound to`followGameStore`; (e) **host tools** — `match-details.js`, `host-menu.js`, `player-management.js`spliced at their mount points; (f) **cosmetics** — ghost ball color`e.ball?.color??hsl(…)`counted ×6,`∞`when no timer,`bpClockNow()` for pause-aware countdowns. |
| Binding    | 37 counted replacements + 11 `.index()` splices; each injection point names the minified symbol it pins.                                                                                                                                                                                                                                                                                                                                                                                         |
| Regression | Heaviest coverage: lobby, picker, host actions, ballots, results-export, follow, ghost color, HUD text.                                                                                                                                                                                                                                                                                                                                                                                          |

## `Replay3D-Cz9axXph.js` — `4554b763` — `replay_patch` (1 import prepend, 1 file append)

|            |                                                                                                                                                                                                                                                                   |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Original   | Standalone 3-D replay viewer component.                                                                                                                                                                                                                           |
| Intended   | Prepend `import{sampleAt,activeNodesAt}from"./replay-timeline.js"` (the authored timeline module) and append `party-replay-scene.js`, so replays sample recorded frames through the same scene pipeline. No in-place replacements — the additions are positional. |
| Binding    | Positional prepend/append; integrity comes from the chunk hash and the module pin in `build.json` rather than counted anchors.                                                                                                                                    |
| Regression | `replay.test`.                                                                                                                                                                                                                                                    |

## `styles-S28F_fms.css` — `0d29d5ae` — apply-tail rewrite (outside the `PATCHES` registry)

|            |                                                                                                                                                                                                                                                                  |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Original   | App stylesheet whose first line is a Google-Fonts `@import`.                                                                                                                                                                                                     |
| Intended   | Strip the import (isolated mode must not phone out; the system stack is a deliberate choice) and append `better-party.css`. Runs in the apply tail, not via `patch()`, so `--check-anchors` does not cover it — the regex targets the first `@import "…";` line. |
| Regression | Visual-baseline suite; absence of the import is observable in prepared output.                                                                                                                                                                                   |

## Apply tail (outside the `PATCHES` registry)

After the registered patches, apply mode also: copies the server-side original
validator closure into `web/validation/` (generated output, never under
`private-client/`), assembles `build_inputs`, stamps `build.json`
(`clientBuild` = sha256 of every input name+bytes, first 16 hex), and prints
the prepare banner. The `clientBuild` hash is what the deploy smoke test and
`/health` report.

## The contract

Anchors are **counted, not fuzzy**: upstream must contain the exact string the
expected number of times or the build fails before publish. Combined with
`--check-anchors`, every row above is verifiable against a staged capture
without deploying — the inventory is executable, not just prose.

## Physics / input / rendering verification

The TODO requirement — _no physics, input or rendering changes outside the
intentional ones_ — was verified mechanically, not by inspection alone:

- **Enumeration.** The patcher has exactly three mutation primitives —
  `replace_once`/`replace_count` (counted), `str.index` splices (fail on
  moved symbols), and positional prepend/append of authored files. The only
  other `re.sub`/`replace` in the file operates on authored sources
  (`export` stripping) or the CSS tail — never on a pinned bundle. So the
  complete original→prepared diff _is_ the patch bodies; nothing else can
  write a bundle.
- **Zone accounting.** `difflib.SequenceMatcher` over the archived vs
  prepared `GameCanvas` (the bundle where simulation lives) yields 19 diff
  zones; every one maps to a documented anchor: prepended imports, the `Zn`
  socket splice, spawn placement + spawn watcher, `paused`/`bpPaused`,
  `&&j()` release gate, `bpColor`/`bpEffect`/`bpHideLocalBall`, scene
  readiness, follow camera, timer fix, module appends. The Rapier WASM
  itself is byte-identical — it is a lock-pinned asset (`assets.test.js`
  verifies the pin).
- **Intentional physics touches** are exactly: initial tee placement (a
  one-shot `setTranslation` before the first step, replacing the original's
  post-step teleport), the world `paused` prop and attempt-scoped world key,
  and the `&&j()` release gate. No integrator, step, collision or
  trajectory code differs — shot behavior parity is exercised by the room
  physics browser suites.
- **Intentional input touches** are `bpInputBlocked()` in the playable gate
  and charge-release (runtime) plus the `&&j()` release gate (canvas) — all
  server-driven (host lock/attempt epoch), none alter aim→shot mechanics.
- **Intentional rendering touches** are ghost/ball color overrides,
  `bpHideLocalBall`, follow camera and the GameRoot HUD/picker/lobby
  surfaces — enumerated above per bundle.
