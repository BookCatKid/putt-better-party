# Dependency inventory of the original client

This document reverse-engineers the original putt.day client snapshot that this
backend serves, so that preparation, patch anchors and required-asset checks can
be reasoned about from evidence rather than memory. Every claim below is tied to
a path under `private-client/`, to a line in `scripts/client-lock.json`, or to a
quoted non-minified snippet.

Nothing under `private-client/` was formatted, linted or edited to produce this
document. All probing was read-only: `grep`, small `python3` readers and
`struct`-level GLB header inspection, with bundle output filtered so that no
minified source was printed wholesale.

The scope is the **archived snapshot** listed in `scripts/client-lock.json`
(275 entries). It is deliberately not the current putt.day release; the lock is
the single authority for what may exist locally.

## 1. Route graph

### Entry point

The browser entry is exactly one module script and one stylesheet, both named in
the generated page markup in `src/server.ts` (`const html = …`):

```html
<link rel="stylesheet" href="/assets/styles-S28F_fms.css" />
<script type="module" src="/assets/index-DFMxt6BL.js"></script>
```

`index-DFMxt6BL.js` is reachability root for **all 112 pinned JavaScript files**
(see §2). There is no second entry, no service worker and no preload list, so a
missing entry bundle cannot be partially recovered — the page renders nothing.

The favicon at `/favicon.ico` is a separate pinned file (`/favicon.ico` in the
lock, copied to `web/favicon.ico`) and is referenced directly from the same
markup, outside the module graph.

### Route table

Routes are declared in `index-DFMxt6BL.js` as TanStack-style `path:` entries.
The paths observed in the pinned bundles are:

| Path                           | Bundle loaded on demand                   |
| ------------------------------ | ----------------------------------------- |
| `/`                            | `_site.index-DaJxwS70.js`                 |
| `/about`                       | `_site.about--PmRQCCK.js`                 |
| `/archive`                     | `_site.archive-CoU-SiBn.js`               |
| `/holes`                       | `_site.holes-BZxjWLe4.js`                 |
| `/maker/$id`                   | `_site.maker._id-BSuAN66T.js`             |
| `/privacy`                     | `_site.privacy-B6zXTjC4.js`               |
| `/settings`                    | `_site.settings-B1XtI15T.js`              |
| `/stats/day/$n`                | `_site.stats.day._n-CRN5CTmm.js`          |
| `/terms`                       | `_site.terms-BKuqtxkn.js`                 |
| `/u/$username`                 | `_site.u._username-DooxDiju.js`           |
| `/u/$username/calendar`        | `_site.u._username_.calendar-CYFgJP6f.js` |
| `/u/$username/day/$n`          | `_site.u._username_.day._n-DYEtFjz8.js`   |
| `/play`                        | `play-IZW7ZgwT.js`                        |
| `/party`                       | `party-CPmq-MON.js`                       |
| `/party/`                      | `party.index-BoF04CoL.js`                 |
| `/party/$code`                 | `party._code-D3a-IB4-.js`                 |
| `/admin`                       | `admin-*.js`                              |
| `/admin/submissions`           | `admin_.submissions-D153zb--.js`          |
| `/day/$n`                      | (daily route)                             |
| `/g/$code`, `/h/$id`, `/s/$id` | share/spectate/replay routes              |
| `/submit`                      | submission route                          |

The `/dev/*` routes (`/dev/attractor`, `/dev/balls`, `/dev/editor`, `/dev/forcetest`,
`/dev/gen`, `/dev/levels`, `/dev/pieces`, `/dev/random`, `/dev/spec`, `/dev/spline`,
`/dev/tab-test`) are present in the bundle but are **not** reachable UI for this
deployment; they are not linked from `/party` and are not prepared as product
surface. They are still served as static files, because the bundle graph is
served wholesale.

### How `/party/:code` is registered, and where the patch enters

`/party/$code` resolves to `party._code-D3a-IB4-.js`. That bundle contains the
original route component `E()` plus the original map loader:

```js
let t = await c({ data: { id: e } });
```

`scripts/patch-client.py` (`route_patch`) replaces that single call with a local
request:

```js
let t = await fetch('/api/map/' + encodeURIComponent(e)).then((r) => r.json());
```

It then splices the authored route modules in place of the original component,
between the `function E(){` anchor and the `export{E as component}` anchor:

- `scripts/party-loading.js`
- `scripts/party-entry.js`
- `scripts/party-route.js`

and rewrites the export to `export{PartyRoute as component}`. The authored code
therefore owns loading, entry and the party route shell, while the original
router, React bindings and every other route stay untouched. If either anchor
moves, `replace_once` asserts (`assert s.count(a) == 1`) and preparation fails
closed rather than silently shipping an unpatched bundle.

The **server's own** route list is separate and much smaller — it is the Better
Party backend in `src/server.ts`: `/`, `/home`, `/party/**`, `/leaderboard`,
`/admin`, `/admin.css`, `/admin.js`, `/favicon.ico`, `/health`, `/api/create`,
`/api/join`, `/api/catalog`, `/api/import`, `/api/import-playlist`,
`/api/generate-playlist`, `/api/leaderboard`, `/api/map/<id>`, `/api/room/<code>`
and `/ws/party/<code>`. Everything under `/assets/`, `/models/`, `/sfx/` and
`/sky/` is served statically from `web/`.

## 2. Static and dynamic imports

Measured over all 112 pinned `.js` files:

- Files with **static** `from "./…"` imports: **97**
- Files with **dynamic** `import("./…")` calls: **49 distinct targets** across
  **61 call sites**
- Import-specifier forms seen: `from"./x.js"`, `from'./x.js'`, `import(`./x.js`)`,
  `import("./x.js")`, plus the Vite dependency table
  `"assets/xxx-YYYY.js"` strings in `__vite__mapDeps`.

Reachability from `/assets/index-DFMxt6BL.js`, following static imports, dynamic
imports and the `__vite__mapDeps` string table:

- **112 of 112** pinned bundles reachable.
- **0** bundles referenced that are absent from the lock.
- **0** bundles present in the lock but never imported.

So the lock and the module graph agree exactly: nothing pinned is dead weight,
and nothing imported is unpinned. That equality is what makes the whole-snapshot
hash check in §6 meaningful — a prepared client cannot silently be missing a
lazily loaded route.

Every `import(` observed is a literal string. There is no runtime-computed
import specifier, so the graph is statically enumerable and `scripts/prepare-client.py`
can verify it without executing bundle code.

## 3. WebAssembly

There are **no `.wasm` files** in the snapshot. Every WebAssembly module is
embedded and one of the most significant findings is that **the engines the game
needs are inlined, and none is fetched from a CDN at runtime**.

| Module                  | Carrier file                                                                       | Size                                | How it is loaded                                                             |
| ----------------------- | ---------------------------------------------------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------- |
| Rapier physics          | `AppearanceClone-CBos6VT9.js`                                                      | 1 569 399 bytes, `sha256 1815…81ca` | Base64 string decoded with `dr.toByteArray`, then `WebAssembly.instantiate`  |
| Automerge (collab docs) | `initAutomerge-CjumIVwr.js`                                                        | 2 749 799 bytes, `sha256 0acf…`     | Base64 string in module scope                                                |
| Subduction / sync WASM  | `wasm-base64-CDKYcJZr.js`                                                          | 1 300 632 bytes, `sha256 91dd…`     | Base64 string, imported by `subductionSync-DWuSUAij.js`                      |
| Meshopt decoder         | inlined in `Gltf-DAxTfnM9.js` as a byte array (`new Uint8Array([0,97,115,109,…])`) | small                               | Returned by the `()=>{…}` factory passed to `setMeshoptDecoder`              |
| Draco decoder           | **not local**                                                                      | —                                   | `DRACOLoader` with `https://www.gstatic.com/draco/versioned/decoders/1.5.5/` |

### The Rapier loader is the load-bearing one

`AppearanceClone-CBos6VT9.js` contains the wasm-bindgen glue with the default
path replaced by a placeholder that never resolves:

```js
e === void 0 && (e = new URL(`rapier_wasm3d_bg.wasm`, `<deleted>`));
```

That branch is **not reached**, because the game always supplies the inlined
bytes: the only call site is `br()`, which calls `kt(dr.toByteArray(`AGFzbQ…`))`
with the decoded base64 module. The `<deleted>`, meaning an editor removed the
original site URL from the archived copy, is therefore harmless — but it is a
real hazard to know about, because any future code path that calls the wasm
init **without** an argument would try to fetch a URL that cannot resolve, and
would fail at the first physics step.

The fetch/instantiate path itself is the standard wasm-bindgen pair: if the
argument is a string, `Request` or `URL` it is `fetch`ed; if the response lacks
`Content-Type: application/wasm` it warns and falls back from
`instantiateStreaming` to `instantiate(arrayBuffer)`. Because our path passes a
`Uint8Array` rather than a URL, **no HTTP fetch and no MIME negotiation happens
for Rapier at all** — which is why the party physics works offline and why the
CSP `wasm-unsafe-eval` relaxation is required but no `connect-src` entry is.

### Behaviour if a decoder is missing

- **Draco** is instantiated unconditionally when a GLTF is loaded
  (`function It(e=!0,t=!0,n){…e&&(Q||=new Mt, Q.setDecoderPath(…))}`), but it is
  only _used_ when a mesh declares `KHR_draco_mesh_compression`. **No pinned GLB
  uses Draco** (verified across all 116: `extensionsUsed` is only
  `KHR_materials_unlit` and `KHR_texture_transform`). So the CDN dependency is
  latent: with no network, no Draco asset is ever decoded, and models load
  normally. It becomes a hard failure only if a future live course uses Draco.
- **Meshopt** is likewise wired in unconditionally and likewise unused by the
  pinned assets (`EXT_meshopt_compression` appears in **0** of 116 GLBs).
- **Rapier** missing is fatal: no physics world, no shots.

## 4. Asset registries and runtime-built paths

Four registries and two path builders are responsible for essentially every
non-JS request. All resolve through the same helper, whose base is a single `/`:

```js
var e = `/`;
function t(t) {
  return e + t.replace(/^\//, ``);
}
```

`asset-D95J-uvP.js`. This matters operationally: because the base is `/`, every
model, texture, sky and sound path is **absolute from the site root**, not
relative to the bundle. The server must serve the same layout from `/` — a
rebase onto a sub-path would break every asset at once.

### 4a. Decor / prop registry (`courseEventRuntime-Bzd93hOE.js`)

One object literal maps a prop name to a GLB filename, then a second lookup picks
the directory:

```js
O = (e) => `/models/${D.has(e) ? `minigolf` : `decor`}/${T[e]}`;
```

`D` is a set of `lost-ball-*`, `golf-club` and `golf-flag`; everything else goes
to `decor/`. The registry has **45 entries**, and **all 45 resolve to a file that
exists in the lock**. Themes are folded in here too: `graveyard/*` and
`platformer/*` are _subdirectories of `decor/`_, so a Halloween or platformer
course pulls a different subtree rather than a different root.

### 4b. Minigolf piece registry (`registry-BaQMskdl.js`)

```js
V = (t) => e(`/models/minigolf/${R[t].glb}`);
H = (t) => {
  let n = R[t].floorGlb;
  return n ? e(`/models/minigolf/${n}`) : null;
};
```

- **69** `glb` references, **2** distinct `floorGlb` references.
- **0** references missing from the lock.
- 8 files in `/models/minigolf/` are referenced _outside_ this registry rather
  than being unreferenced: `ball-{blue,red,green}.glb`, `club-red.glb`,
  `flag-large-red.glb`, `flag-red.glb`, `gate-base.glb` (used as a `floorGlb`),
  plus the shared `colormap.png` texture.

So "not in the registry" does not mean "optional". All 76 minigolf files are
load-bearing; the registry just is not the only consumer.

### 4c. Sky registry (`theme-BxxhUw0H.js`)

Six themes are declared (`day`, `sunset`, `night`, `dawn`, `breezy`, `snow`), and
five carry a skybox:

| Theme    | Skybox                                                 |
| -------- | ------------------------------------------------------ |
| `day`    | `/sky/day.webp`                                        |
| `sunset` | `/sky/sunset.webp`                                     |
| `night`  | `/sky/night.webp`                                      |
| `dawn`   | `/sky/dawn.webp`                                       |
| `breezy` | `/sky/breezy.webp`                                     |
| `snow`   | **none** — pure colour gradient plus `weather: 'snow'` |

Exactly those five `.webp` files are pinned, so the set is complete. A course
without an explicit `theme` gets one chosen from a **stable hash of its id**
(`n(e)` folds the id with `*31` and indexes the theme array), which is why the
same live course keeps its look between sessions and across clients.

### 4d. Sound registry (`GameRoot-7kMtVtdO.js`)

```js
Ve = {
  putt: 4,
  iron: 4,
  drive: 4,
  bounce: 4,
  hole: 4,
  water: 4,
  sand: 3,
  clap: 3,
  chip: 3,
  swish: 3,
};
```

The loader builds `${name}-${n}.mp3` for `n` in `1..count` and fetches
`/sfx/<name>.mp3`, decoding into an `AudioContext`. That is **36** expected
files, and exactly 36 `.mp3` files are pinned, with **no missing and no extras**.
Each fetch is individually `.catch(() => {})`-guarded, so a missing sound
degrades to silence rather than failing the round — a real distinction from
models, which fail the scene.

### 4e. Runtime-built paths, complete list

The dynamic path builders found across the bundles are exactly:

- `/models/${minigolf|decor}/${file}.glb` — props
- `/models/minigolf/${file}.glb` — pieces and floors
- `/sfx/${name}-${n}.mp3` — sounds
- `/sky/${theme}.webp` — skyboxes
- `/models/minigolf/Textures/colormap.png`, `/models/decor/graveyard/Textures/colormap.png`,
  `/models/decor/platformer/Textures/colormap.png` — **referenced from inside the
  GLBs**, not from JavaScript (see §5)

## 5. Models, textures, audio, themes, fonts

### Models — 116 GLB files

| Directory                   | Count | Notes                                     |
| --------------------------- | ----- | ----------------------------------------- |
| `/models/minigolf/`         | 76    | Course pieces, plus ball/club/flag models |
| `/models/decor/` (flat)     | 33    | Trees, rocks, flowers, fences, pumpkins   |
| `/models/decor/graveyard/`  | 9     | Halloween set; needs a shared texture     |
| `/models/decor/platformer/` | 6     | Platformer set; needs a shared texture    |

Header inspection of all 116 confirms they are all glTF **binary** (`glTF` magic),
`asset.version >= 2`, and use only `KHR_materials_unlit` and
`KHR_texture_transform`. No Draco, no meshopt, no KTX2, no basis textures.

### Textures — 3 PNG files, all referenced from inside GLBs

The only external resource a GLB names is `Textures/colormap.png` (as an `image`
URI). Resolved relative to the GLB, that yields the three pinned
`colormap.png` files — one per model directory. **None of these three paths
appears anywhere in JavaScript.** They are therefore invisible to any check that
scans only the bundles, and must be discovered by inspecting the GLB JSON chunk.
This is the one place where "is it referenced by code" is the wrong question.

The other pinned images are `/logo192.png`, `/favicon.ico` and the five sky
`.webp` files.

### Audio — 36 MP3 files

Covered in §4d. All 36 present, all 36 referenced by the loader.

### Fonts — **served by nobody**

The pinned stylesheet opens with a Google Fonts import:

```css
@import 'https://fonts.googleapis.com/css2?family=Fraunces:…&family=Manrope:…&display=swap';
```

`scripts/patch-client.py` **strips exactly that first `@import`** when it copies
the stylesheet (`re.sub(r'^@import "[^"]+";', "", s, count=1)`), which is what
makes the deployment offline and independent. No `.woff`, `.woff2` or `.ttf`
exists in the snapshot, and `scripts/better-party.css` references no font file.
Consequently the prepared client renders with the system font stack for
authored chrome, while the game canvas (which draws with its own textures) is
unaffected. Anyone expecting the captured design's Fraunces/Manrope must know it
is intentionally absent, not broken.

### Themes

Declared in `theme-BxxhUw0H.js`, listed in §4c. Theme choice is either explicit
(`course.theme`) or hashed from the course id. `snow` adds weather; the other
five add a skybox image.

## 6. Required, required-for-feature, optional

The classification below is justified by the failing code path, not by taste.

### REQUIRED — preparation must fail closed if absent

1. **`/assets/index-DFMxt6BL.js`** — the only entry. Absent, the page is blank.
2. **`/assets/styles-S28F_fms.css`** — linked in server markup. Absent, unstyled
   but functional; still treated as required because it is named in the page and
   its absence indicates a broken preparation, not a degraded client.
3. **All 112 `.js` bundles** — the graph is fully connected (§2): every one is
   reachable from the entry, so any omission is a broken lazy route rather than an
   unused file.
4. **`/models/minigolf/` — all 76 files.** 69 through the piece registry plus 8
   named directly elsewhere. A missing piece aborts the GLTF load for that part,
   which fails the level.
5. **All 3 `colormap.png` textures.** Every minigolf and themed-decor GLB names
   it. Absent, the models load without their palette texture. They are required
   and are the easiest to miss, since no JavaScript mentions them.
6. **Rapier WASM** — inlined in `AppearanceClone-CBos6VT9.js`. It cannot be
   "missing" separately, but that bundle is therefore required for physics.

### REQUIRED FOR FEATURE

7. **`/sky/*.webp` — 5 files.** Needed only by a course using that theme. A
   missing one degrades a specific course's backdrop. Because themes are chosen
   by id hash, any of the five can appear without warning.
8. **`/sfx/*.mp3` — 36 files.** Needed only for that sound. Individually guarded,
   so absence is silent; still required for the intended experience.
9. **`/models/decor/**` — 39 files.** Needed only when a live course places that
   prop or selects the graveyard/platformer set. Properties are chosen by the
   course author, so the client cannot know in advance.
10. **Automerge and Subduction WASM** (`initAutomerge-CjumIVwr.js`,
    `wasm-base64-CDKYcJZr.js`). Required for the hole editor, submission and
    collaborative sync routes. The party route does not need them, but they are
    reachable from the entry, so they are not removable from the snapshot.
11. **`/logo192.png`, `/favicon.ico`** — presentation. The favicon is linked from
    the server's markup; the logo is referenced by the site bundle.
12. **`/assets/bp-home.js`, `/assets/bp-leaderboard.js`** — authored files copied
    in by preparation (`scripts/home.js`, `scripts/leaderboard.js`). Required by
    `/home` and `/leaderboard` respectively.

### OPTIONAL / LATENT

13. **Draco decoder (CDN)** — referenced unconditionally in the loader, used by
    zero pinned assets. Optional in practice; a hard dependency the moment a live
    course ships a Draco mesh.
14. **Meshopt decoder** — inlined, used by zero pinned assets. Dead weight that
    costs bundle size, not correctness.
15. **`/dev/*` routes and their chunks** — reachable in the graph, not product
    surface.
16. **Google Fonts** — deliberately removed by the patcher.

## 7. Fallback behaviour on 404 or wrong MIME

- **Models.** `GLTFLoader.load` routes failure to the caller's error callback;
  the internal buffer path throws
  `THREE.GLTFLoader: Failed to load buffer "…"`. A malformed JSON chunk is
  reported as `THREE.GLTFLoader: Unsupported asset. glTF versions >=2.0 are
supported.` There is no substitute mesh, so a missing required model fails that
  part of the scene.
- **Sounds.** Each fetch is `.catch(() => {})`-guarded; a 404 or a decode failure
  simply leaves that key out of the `AudioContext` cache. Playback of a missing
  key is a no-op. This is the one deliberately soft dependency.
- **Skyboxes.** Loaded through the same asset helper as textures. A missing
  `.webp` leaves the theme's flat `skyTop`/`skyHorizon` colours, so the course
  remains playable with a plain sky.
- **JS chunks.** A failed dynamic `import()` rejects the route component; the page
  does not recover. There is no retry in the bundle.
- **Wrong MIME.** Only relevant to `instantiateStreaming`, which is not on the
  Rapier path (bytes are passed directly). For that unused path the glue warns
  and falls back to `WebAssembly.instantiate(arrayBuffer)`, so a server serving
  `application/octet-stream` would still work, only slower.
- **Server side.** `src/server.ts` answers a missing asset with `404 Missing
asset` and logs an `asset_missing` event with the path (or `invalid-path` when
  the path itself is implausible). A traversal or symlink escape is refused before
  reading, by `containedAssetPath`.

## 8. Not determined

- **Whether any _live_ community course uses Draco or meshopt.** None of the 116
  pinned assets do, and `docs`/tests do not cover it. Settling it needs a survey
  of live course specs and their model extensions, which requires network access
  to the public catalog and is out of scope for an offline inventory.
- **Whether `/dev/*` chunks are needed by any product route at runtime.** They are
  reachable statically but not linked from `/party`. Settling it needs a click-through
  of every route; the conservative answer, which preparation already takes, is to
  keep them.
- **Whether the hashed theme selection covers every live course's theme.** The
  hash is deterministic, but which theme each live course lands on is data, not
  code. Settling it needs the live catalog.
