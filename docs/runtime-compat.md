# Runtime compatibility

What the pinned client (snapshot `89e451ea`) supports, established from the
bundles and the pinned validator rather than assumed. The authoritative
contract is `specValidation-vqop-JBL.js` — the upstream's own spec validator,
which our server runs hash-pinned (`src/upstream/client-adapter.ts`), so a spec
that imports through `/api/import` is _by construction_ one the client can
play, and one the validator rejects could never have run.

## Map runtimes: V1 and V2, nothing else

The map spec's `runtimeVersion` field selects the runtime
(`runtimeVersion-DMr6qz4K.js`, export `t`):

```js
if (e.runtimeVersion === void 0 || e.runtimeVersion === 1) return 1;
if (e.runtimeVersion === 2) return 2;
throw Error(`Unsupported map runtime version: ${String(e.runtimeVersion)}`);
```

The validator agrees exactly: `runtimeVersion !== undefined && !== 1 && !== 2`
fails with `unsupported map runtime version`.

|               | V1 (`undefined`/`1`)                    | V2 (`2`)                                               |
| ------------- | --------------------------------------- | ------------------------------------------------------ |
| Physics world | one shared world keyed `legacy`         | per-level world keyed `${level.id}:2`                  |
| Clock/tick    | legacy rAF path                         | `version===2` clock-driven subscribers                 |
| Camera fit    | `overview === 'fit-course-v1'`          | fit-course v2 path                                     |
| Portals       | adjacent piece pairs (`mode: 'legacy'`) | explicit `portalPairId` + `portalRole: 'entry'/'exit'` |
| Events        | none                                    | `events.version === 1` responder graph                 |

**Ceiling:** a future `runtimeVersion: 3` map throws on load and fails import
server-side — the pin cannot play it, which is a hard incompatibility a
version-diff watch should flag rather than discover mid-party.

## Special devices and events (V2)

Validator piece/overlay kinds — the complete accepted vocabulary (19):
`bumper`, `spinner`, `slider`, `boost`, `jump`, `sand`, `ice`, `portal`,
`geyser`, `trampoline`, `pendulum`, `piston`, `wall`, `magnet`, `fan`,
`gravitywell`, `one-way-flap`, `catch-basin`, `curved-rail`.

The event system (`spec.events`, schema version 1) names responder nodes of
kinds `ball-trigger`, `drawbridge`, `gate`, `rotating-junction`,
`sliding-block` (models in `CourseEventDevices-BtqCJXBm.js`) plus the
render-side kinds `particle-emitter`, `sound-emitter`, `loop`. A
`ball-trigger` validates `mode: 'enter'|'settle'|'hole'` and
`repeat: 'once-attempt'`. GameCanvas drives these through
`V.eventTimeline`/`activeEventNodes` and samples them into replays
(`events` on the replay payload, bounded at 256 in `src/replays.ts`).

## Themes and weather

Six themes: `day`, `sunset`, `night`, `dawn`, `breezy`, `snow` — the validator
rejects anything else (`unknown theme`). Five name a `/sky/<theme>.webp`
skybox; `snow` names none and instead sets `weather: 'snow'`, the only weather
effect. Unset themes are assigned by a stable hash of the course id. A
`fancyGraphics` quality gate scales effects.

## Seasonal / time-gated events

**None.** No halloween/christmas/seasonal or date-gated code exists in the
snapshot. Themed decor packs (`graveyard/`, `platformer/`) are static
per-course assets, not calendar events.

## Input devices

- **Pointer events only** — `pointerdown/move/up/cancel/leave`,
  `lostpointercapture`: mouse, touch and pen share one path; no
  mouse-only code paths exist to diverge.
- **Wheel** zoom on the canvas; **limited keyboard** (`keydown`/`keyup` in
  index/GameCanvas/GameRoot — gameplay shortcuts and editor controls).
- **No gamepad, no device-orientation input.** `getGamepads` and
  `DeviceOrientation` do not occur anywhere in the snapshot.
- **WebXR plumbing is latent**: `sessionstart`/`squeeze`/`inputsourceschange`
  live inside three.js/r3f, but no authored route creates an XR session —
  treated as unsupported, not broken.
- **`orientationchange`** is handled (viewport), and `touchmove` handlers
  exist in GameRoot/index for gesture paths.

## WebGL and rendering requirements

`WebGLGate-j7-Em6ku.js` gates the app on WebGL availability;
`webglcontextlost`/`restored`/`creationerror` handlers exist in the three.js
layer. All 116 GLBs are glTF ≥ 2.0 with only `KHR_materials_unlit` +
`KHR_texture_transform` — no Draco or meshopt needed by any pinned asset
(Draco is wired to a gstatic CDN but latent, per the dependency inventory).

## Required stock media

158 pinned runtime references, verified at prepare time and by
`tests/assets.test.js`: 69 course pieces/floors (+8 off-registry), 45 decor
props, 5 skyboxes, 36 sound clips, and the 3 GLB-internal `colormap.png`
textures no JS scan can see. Fonts are deliberately absent — the Google Fonts
`@import` is stripped for offline isolation and the system stack is used.

## Spec limits the validator enforces

`coordinate: 256, elevation: 128, pieces: 600, overlays: 200, decor: 200,
decorItems: 8, pits: 200, splines: 32, splineNodes: 256`. A community map
beyond these fails import, matching the client exactly.

## What this means for adoption

When upstream ships a new build, `diff-capture.py` covers the compatibility
surface: if the new bundles add a `runtimeVersion: 3` path, a new device
kind, or a theme the validator doesn't know, the anchor report plus the
registry diff names it. A spec our pinned validator rejects is one the
pinned client was never going to run — the boundary is the validator, not
our code.
