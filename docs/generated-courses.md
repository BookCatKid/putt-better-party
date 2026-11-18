# Procedural course generation

This document reverse-engineers the procedural hole generator that ships inside the original
putt.day client. It is an investigation report: nothing here changes Better Party, the pinned
client assets or the wire protocol. Every claim is traceable to a specific function in
`private-client/assets/versionedGenerator-CZtiQNmN.js`; minified names are mapped to descriptive
ones in the appendix.

## Scope and method

- The generator is a single ES module, `versionedGenerator-CZtiQNmN.js` (173 kB minified). It
  imports five sibling modules and nothing else that matters at runtime:
  `runtime-DL2fiDAQ.js` (match state store), `theme-BxxhUw0H.js` (the six sky/weather themes),
  `specValidation-vqop-JBL.js` (the course validator used by the game itself),
  `registry-BaQMskdl.js` (the 95-entry piece registry), `footprint-Bs0DuXWX.js` (rotated socket
  geometry).
- To read it, the bundle was formatted with the repository's own Prettier
  (`--parser babel --print-width 100`) into a scratch copy outside the repository. Line numbers in
  this report refer to that 9,097-line formatted copy, not to the shipped one-line bundle.
- To measure behaviour, the original modules were imported directly under Node (v26) with no DOM
  and no WebGL. The generator's transitive import closure is 25 modules (the five above plus the
  runtime store's own dependencies, React and a `three.module` build), but only a handful of named
  exports are actually touched, and none of them need a browser. The module also installs its own
  deterministic `sin`/`cos`/`pow`/`hypot`… implementations over `Math` for the duration of a
  generation call and restores them afterwards (prettified lines 920–1155). That is what makes
  results identical across engines and platforms.
- Validity was judged with the shipped `specValidation` validator rather than a hand-written one, so
  "valid" below means "the game's own loader accepts it".

Sample sizes are stated wherever a statistic appears. All timings are from one Apple-silicon
machine under Node and should be read as orders of magnitude, not absolutes.

## What the module exports

Five exports, and only these are reachable from outside:

| Export | Internal | Signature                           | Result                            |
| ------ | -------- | ----------------------------------- | --------------------------------- |
| `a`    | `N`      | `generateV1(seed)`                  | v1 level object, never `null`     |
| `i`    | `Qo`     | `generateV3(seed, options?)`        | `{level, board, meta}` or `null`  |
| `n`    | `ls`     | `parseVersion(value)`               | `1`, `2` or `3`, throws otherwise |
| `r`    | `fs`     | `generateFromReference('gen:v3:7')` | level object                      |
| `t`    | `ds`     | `generateAny(seed, version?)`       | level object                      |

`t` is the entry point the client actually uses. Its whole body is 12 lines (prettified 9080–9090):

```js
function generateAny(seed, version) {
  const n = parseVersion(version);
  if (n === 2 || n === 3) assertSeed(seed);
  else if (!Number.isFinite(seed)) throw Error('Invalid generation seed');
  if (n === 3) {
    const v3 = generateV3(seed);
    if (v3) return v3.level;
  }
  const v1 = generateV1(seed);
  return n === 1 ? v1 : { ...v1, id: `gen-v${n}-${seed}`, runtimeVersion: 2 };
}
```

Two consequences are worth stating plainly because they are easy to miss:

1. **`generateAny` never passes options.** A caller cannot reach the v3 genome, attempt count or
   candidate count through `t`. `i` is the only way in.
2. **The v3 → v1 fallback is real but effectively dead.** In 400 sampled seeds `generateV3`
   returned a level every time, so the `N(seed)` fallback after it exists only for the pathological
   case where every attempt is rejected.

`assertSeed` requires `Number.isSafeInteger(seed) && seed >= 0 && seed <= 4294967295`; v1 only
requires a finite number. That asymmetry is load-bearing: `t(-1, 1)` works, `t(-1, 2)` throws.

## Seeds, references and determinism

### Seed grammar

- v1 accepts any finite number, including negatives and fractions. The id is literally
  `gen-${seed}`, so calling `a(-1)` yields `gen--1` and `a(0.5)` yields `gen-0.5`. Neither can be
  expressed as a `gen:` reference, because the reference grammar only admits digits.
- v2/v3 accept `0 … 4294967295`. The id is `gen-v2-${seed}` / `gen3-${seed}`.
- Reference grammar is `/^gen:(?:(v\d+):)?(\d+)$/` (prettified 9091). Examples:
  `gen:1` → v1 seed 1, `gen:v2:7` → v2 seed 7, `gen:v3:7` → v3 seed 7, `gen:00042` → v1 seed 42
  (leading zeros are absorbed by `Number`). Anything else throws
  `Invalid generated map reference`.
- Version parser accepts `1|2|3`, `'1'|'2'|'3'`, and treats `null`/`undefined` as 1. Everything
  else throws `Unsupported generation version: X`.

There is no length cap on the reference beyond the grammar, and no path-like input is accepted, so
a reference cannot escape into a filesystem or network lookup.

### Determinism

Three independent mechanisms produce reproducibility, and they compose:

1. **A 32-bit counter RNG.** `s(seed)` is a `mulberry32` variant (prettified 6–15). Every pipeline
   gets its own stream seeded from a different derivation, so consuming one stream cannot shift
   another.
2. **Domain-separated stream derivation.** `hash32(seed, label, nonce)` (prettified 2193–2206) is a
   MurmurHash3-style mix over the seed, the label's character codes, its length and the nonce.
   `stream(seed, label, nonce) = rng(hash32(...))`. Labels are human-readable:
   `grow`, `finale`, `moves`, `orient`, `emit`, `look.decor`, `look.theme`, `look.turf`, `gene7`,
   `turtle:primary`, `bag`, `fix`. Fixing a bug in one stage therefore does not silently rewrite
   every other stage's output unless that stage's own stream is touched.
3. **A patched `Math`.** `withDeterministicMath(fn)` swaps `Math.sin/cos/tan/atan/atan2/asin/acos/
exp/log/pow/cbrt/hypot` for fdlibm-derived implementations for the duration of the call
   (prettified 920–1155). Geometry that depends on trigonometry is thus bit-identical across
   platforms, which matters because the generator does trig-heavy spline and macro-corner layout.

Measured: 0 diffs across repeated calls with identical arguments, including when a genome override
is supplied. Because the streams are label-derived, overriding `genome` changes only the stages
downstream of the genome, and `ri` re-derives the same genome from the same seed plus the override,
so overrides are themselves deterministic.

### Genome gene derivation

`ri` (prettified 3001–3077) does not draw genes from a single RNG stream, and this is the subtlest
part of the whole module. Each numeric gene is computed by `gene(seed, i)` (prettified 2963–2968),
which is

```
Xr(seed, i) = frac( frac(hi*frac(J[i]*65536)) + frac(lo*J[i]) + frac(0.5 + i*0.137) )
gene(seed, i) = frac( Xr(seed, i) + (hash32(seed, 'gene'+i)/2^32 - 0.5) * 0.12 )
```

where `hi`/`lo` are the seed split at 2¹⁶ and `J[i] = (1/qr)^(i+1)` with `qr` built by 64
iterations of `x ← (1+x)^(1/16)`, giving `J[0] = 0.95625…`, `J[1] = 0.91441…`, `J[2] = 0.87441…` —
a geometric ladder of low-discrepancy additive-recurrence constants (the same construction as the
R2 sequence, generalised to arbitrary dimension). The three `frac` terms are a Kronecker/Weyl
recurrence in `(hi, lo, i)`, so consecutive seeds land far apart in gene space and the marginal
distribution is near-uniform. A further ±6% hashed jitter breaks the lattice.

The practical effect is that gene values are spread evenly across their ranges and nearby seeds do
not produce near-identical genomes. It explains the measured uniformity of `primary`: 400
consecutive seeds give exactly 33–34 hits per family, with no clustering. (Theme selection is a
separate 336-slot deck, covered under Colour.)

## Version comparison

|                    | v1 (`N`)                   | v2                    | v3 (`Qo`)                               |
| ------------------ | -------------------------- | --------------------- | --------------------------------------- |
| Geometry           | cell walk, 250 attempts    | identical bytes to v1 | grown graph, 40 attempts × 6 candidates |
| Difficulty model   | none (par from cell count) | none                  | 17 genes + scoring                      |
| `runtimeVersion`   | absent                     | 2                     | 2                                       |
| id                 | `gen-<seed>`               | `gen-v2-<seed>`       | `gen3-<seed>`                           |
| Theme/decor colour | none (decor only)          | none                  | full theme + LCH palette engine         |
| Events             | none                       | none                  | circuits, plates, gates, particles      |
| Splines            | none                       | none                  | curved lanes, banks, widths             |
| Failure mode       | 49-cell fallback corridor  | same                  | `null` → `generateAny` falls back to v1 |
| Cost               | ~0.2–0.6 ms                | ~0.2–0.6 ms           | 65–1000 ms                              |

v2 is not a generator. It is v1's geometry relabelled: measured byte-for-byte equal `pieces`
arrays, with only `id` and `runtimeVersion` differing. It exists so that a version bump in a course
reference does not change the hole. That is confirmed in the code: the v2 branch is only the object
spread at the end of `generateAny`.

## v1: the cell walker

v1 is a turtle on a grid that lays a corridor cell by cell and then decorates it.

### Outer loop

`N(seed)` (prettified 884–918) tries up to **250** times. Each attempt reseeds from
`(seed ^ 2654435769) + t * 2246822507`, draws an archetype from `w`, decides the ending, and runs
the walker `te`. An attempt is accepted only when all of these hold:

- the final cell's height matches the ending (`y === 0`, or `y === 1` for a summit cup),
- the final cell is at least 6 Manhattan units from the tee (`|x| + |z-2| >= 6`),
- there are at least 4 turns for `classic` and at least 2 for everything else,
- the emitted piece list has at least 50 entries (`M` returns it otherwise).

If all 250 attempts fail, a deterministic 49-cell straight corridor at `x = 0, z = 1…-47` is
emitted through the same `M` pipeline. The fallback is unreachable in practice but it means v1 never
returns `null`.

### Archetypes

`w` (prettified 131–169) is a 13-entry weighted table totalling 122:

| archetype                    | weight  | name                                   | par bias           |
| ---------------------------- | ------- | -------------------------------------- | ------------------ |
| wormhole                     | 16      | The Wormhole                           | 0                  |
| arena / fork / geyser / loop | 11 each | The Arena / Crossroads / Geyser / Loop | −2                 |
| leap                         | 11      | The Leap                               | 0                  |
| summit / gauntlet            | 10 each | The Summit / The Gauntlet              | −2 (gauntlet only) |
| padhop                       | 8       | The Hop                                | 0                  |
| classic / beach / pinball    | 6 each  | The Classic / The Beach / The Pinball  | +1 / +1 / 0        |
| boostway                     | 5       | The Speedway                           | +3                 |

Measured over 20,000 seeds: wormhole 13.2%, fork 9.2%, leap 9.0%, arena 8.9%, geyser 8.8%,
loop 8.7%, summit 8.0%, gauntlet 7.9%, padhop 6.8%, pinball 5.3%, beach 5.1%, classic 5.0%,
boostway 4.1%.

Endings are a coin flip weighted by `a < 0.38 → room`, `< 0.56 → nook`, `< 0.66 → island`, else
`cap`, with a 40% overlap forcing `cap` on summit runs. Measured: room 37.2%, cap 36.1%, nook 17.2%,
island 9.6%, and `summitCup` 3.24% of all seeds.

### The walk

`te` (prettified 259–689) maintains `(x, z)`, a heading, an occupancy set and a list of pending
forced pieces. Per step it:

1. computes the available headings (straight, left, right) and rejects ones that would collide or
   fold back into the previous cell,
2. escalates the turn probability with the current run length
   (`0.34` base, `+0.18` per cell beyond two, capped at `0.85`; `classic` starts at `0.5`),
3. may inject a structural set-piece once the walk is far enough along,
4. may inject a secondary flourish after the set-piece,
5. otherwise emits the next cell and advances.

Cells are emitted as `{x, z, enter, exit, y, forced, rot}`; `forced` carries a required piece such
as `gap`, `boost`, `jump`, `ramp-asc`, `portal`, `walls-to-open`.

### Structural set-pieces (`D` and friends)

| archetype              | construction                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| summit                 | `ramp-asc`, 1–2 elevated cells, `ramp-desc`; the descend is dropped for a summit cup                                      |
| gauntlet               | 2–3 obstacle/mover cells separated by straights                                                                           |
| beach                  | `sand`, `bump` or `bump-down`, `sand`                                                                                     |
| leap (`ae`)            | optional `boost`, then `ramp-asc`, then 1–2 `gap` cells or elevated cells, then two straights                             |
| padhop (`oe`)          | `jump`, optional elevated cell or `gap`, two straights                                                                    |
| geyser (`se`)          | `geyser`, three lateral cells, two `open` cells, then a `walls-to-open` rejoin                                            |
| wormhole (`le`)        | two `portal` cells with a 3–5 cell lateral offset and a 0–2 cell forward offset                                           |
| arena / pinball (`ue`) | rectangular field of `block`/`bump-open`/`sand-open`/`open` with bumpers and movers; `pinball` is wider and denser        |
| loop / halfpipe (`ce`) | `boost`, straight, an off-path `loop`/`halfpipe` at `y = 1`, three `open` cells, then a lateral shift back onto the route |
| fork (`de`)            | splits into twin channels re-joined with `walls-to-open` at both ends                                                     |

Each set-piece is placed only if a straight-line reservation of its full footprint is free
(`re(...)` / `ne(...)`), so a set-piece is atomic or absent.

### Emitter (`M`)

`M` (prettified 690–883) turns the cell list into a level object:

- tee at `(0, 2)` with a solved `start` rotation,
- per cell, a piece chosen by `y`, forced type, or a role-based weighted table `O`
  (`bump` 8, `bump-down` 7, `obstacle-block` 8, `narrow-square` 6, `narrow-round` 6, `castle` 5,
  `crest` 5, `tunnel-wide/narrow/double` 5/4/4, `side` 4, `sand` 5, …), with per-attempt caps in `k`
  so `bump`, `narrow-*` and `tunnel-*` cannot repeat indefinitely,
- corners from `A` (`corner` 30, `round-corner-b` 45, `square-corner` 25), rotated by the
  `y(piece, openings)` solver that brute-forces the four rotations against the piece's socket table,
- an ending: `hole-open` for island/forced, `hole-square` for nook, `hole-round` otherwise, plus a
  `supports` piece under any `y = 1` cell,
- three RNG-gated extras keyed off a single fresh draw: below 0.35 a side-pair shortcut, 0.35–0.6 an
  off-path `geyser`, 0.6–0.72 a `portal` pair; and 6–10 decor attempts capped at 8 entries, with a
  12% chance of swapping one item for a `lost-ball-*`,
- par `max(3, min(14, round(1.5 + 0.244 * cells + bias)))`,
- name `${archName} #${seed}`.

v1's decor vocabulary is 8 fixed recipes of 3 items in `ee` (e.g. `tree, flower-red, grass`).

## v3: the grown graph

v3 is a different program. Where v1 walks a corridor, v3 grows a multi-branch graph, then attempts
to make it _good_ by generating several candidates and keeping the best.

```
genome ─▶ plan ─▶ grow ─▶ finale ─▶ features ─▶ dressing ─▶ emit ─▶ recolour ─▶ decor
             (per attempt, up to 40 attempts × 6 candidates, best score wins)
                                    │
                                    └─▶ specValidation ─▶ event lint ─▶ tee-camera check ─▶ score
```

### Genome

`ri` (prettified 3001–3077) yields 17 numeric genes plus three structural choices:

| gene        | range                                | meaning                                     |
| ----------- | ------------------------------------ | ------------------------------------------- |
| `floor`     | 26–62 (clamped 20–95)                | target floor area in cells                  |
| `aspect`    | 1–2.1                                | long-axis ratio of the bounding span        |
| `flow`      | ±0.45                                | how much the route prefers flowing curves   |
| `runMean`   | 1–2.4                                | mean straight-run length                    |
| `curl`      | 0–1                                  | tendency to curl back on itself             |
| `reach`     | 0.12–1                               | how far the first leg stretches             |
| `width`     | 0–1                                  | lane/fairway width                          |
| `relief`    | staged: 0, 1–2.5, 2.5–4.5, 5–8       | vertical budget                             |
| `spin`      | ±                                    | directional persistence                     |
| `slope`     | ±1                                   | global up/down drift                        |
| `air`       | 0.25–1                               | appetite for hops, drops, pads, geysers     |
| `court`     | 0.3–1                                | appetite for open court/room sections       |
| `risk`      | 0.15–1                               | appetite for forks, tongues, hazards        |
| `density`   | 1–2                                  | feature density multiplier                  |
| `celebrate` | 0–3                                  | post-hole celebration intensity             |
| `logic`     | 0–1 (35% forced to 0)                | appetite for gate/plate mechanics           |
| `sharp`     | 0–1                                  | tightness of turns and how many hazards     |
| `tee`       | `turn, flow, perch, cap, turn, flow` | tee construction style                      |
| `primary`   | 12 families                          | the hole's headline family                  |
| `secondary` | 1–3 families                         | supporting families, weighted by usefulness |

`celebrate` and `logic` are drawn from a _separate_ RNG, not the gene sequence, which is why they
do not follow the even-spread pattern of the others.

Secondary families are not drawn uniformly. `ni(family, genome)` returns a usefulness score —
`fields` likes `court`, `movers` likes low `flow`, `apertures` likes low `width`, `logic` scales
with `logic`, `geysers` with `air` and `relief` — and the secondary draw is weighted by those
scores. Weights end up `primary = 3`, each secondary `= 1`, plus `logic = 0.5` when `logic > 0.85`.

Genes are overridable. `Object.assign(genome, entries.filter(([k]) => k in genome))` means unknown
keys are silently dropped and known keys are clamped afterwards (`floor: 500 → 95`, `floor: 1 → 20`,
`width` clamped to 0–1). `primary`, `tee` and `secondary` are handled separately because they are
not plain numbers: `secondary` also rebuilds `weights`.

### Plan

`pa` (prettified 4935–4947) converts genes into budgets:

```
route     = round(floor * (0.47 - 0.2 * court) + 3 + min(6, relief))
floorStop = round(floor * 0.92)
spanX     = max(6, round(sqrt(floor / t * r)))       r = 1 + (aspect-1) * clamp((floor-24)/30, 0.4, 1)
spanZ     = max(5, round(sqrt(floor / t / r)))       t = 0.4 + 0.2*curl - 0.07*flow - 0.05*width + 0.06*sharp
maxY      = relief <= 0 ? 0 : max(1, round(relief))
```

So `court` shortens the route and `curl`/`sharp` widen the footprint, which is what makes a
high-`court` hole read as an arena rather than a corridor.

### Grow

`ga` (prettified 4949 onward) is the largest function in the module. It builds a `Board` — a cell
map plus `solid`, `reserved`, `underslots`, `splineRuns`, `bridges`, `hops`, `portals`,
`invitations`, `circuits`, `walls`, `tee`, `cup`, `notes` — and repeatedly applies one of a scored
menu of moves.

The move menu, with its dynamic weights:

| move       | implements                                                 | notable gating                                   |
| ---------- | ---------------------------------------------------------- | ------------------------------------------------ |
| `run`      | straight cells                                             | weight drops to 0.1 when the run budget is spent |
| `bend`     | 1–4 cell 90° turn                                          | needs a free side                                |
| `sweep`    | macro corner: 3 cells replaced by one large-corner piece   | needs an L-shaped free group                     |
| `flow`     | curved spline lane (`flow-arc/shift/hairpin/meander/hook`) | rejected above `7 + 1.5 × abs(Δy)` nodes         |
| `court`    | 2×2–4×4 room with internal links                           | capped at `1 + round(court*2.5)` rooms           |
| `ramp`     | `ramp/ramp-high/ramp-medium` up or down                    | needs `maxY > 0` and 4 cells since the last ramp |
| `drop`     | ≥0.5 step down with a launch edge                          | needs `y >= 1`                                   |
| `hump`     | up-then-down or dip                                        | needs 4 cells of clearance                       |
| `hop`      | pad / geyser / lip / stepping-stones across a gap          | needs ≥2.5 cells from origin                     |
| `bridge`   | deck over a lower lane                                     | needs `y >= 1`                                   |
| `orbit`    | ring around a reserved core                                | once                                             |
| `arena`    | large `court` with `arena` tag                             | once, late                                       |
| `cascade`  | stepped descent                                            | needs `y >= 2`                                   |
| `tongue`   | narrow peninsula / risk spur                               | max 2, gated by `risk`                           |
| `bump`     | raised bump with a crossing                                | max 1                                            |
| `fork`     | braided alternative route                                  | max 2 unless `risk > 0.55`                       |
| `overpass` | bridge over the route                                      | once, needs height headroom                      |

Each move is validated by `canPlace` (`y`), which rejects with a reason: `span`, `taken`,
`height`, `teefall`, `self`, `tee`, `touch`. Those reasons are the same strings that show up in
`meta.rejects` when a whole attempt fails, which makes generated holes diagnosable after the fact.

Two details matter for realism:

- **Height field.** A smooth height function `E(s)` combines slope, a sine wave with period
  `6 + 8·rand` and amplitude proportional to relief. Ramps set `up` sides so that a cell's floor is a
  range, and the board rejects any link whose two sides disagree by more than 1e-6. Elevation is
  therefore always consistent, never patched afterwards.
- **Anti-frustration.** `teefall` rejects any cell whose floor is more than 0.5 below the tee within
  3 cells of the origin — you cannot fall off the tee. `tee` rejects any cell at the origin.
  `overshoot` handling in `ramp` enforces `s - F >= 4`, i.e. at least four cells between ramps.

Run limits: 80 menu iterations, or until `route` cells / `floorStop` floors are reached.

### Finale

`oi` (prettified 3095 onward) picks the ending from five kinds: `lane-cup`, `green`,
`raised-green`, `island-cup`, `air-green`. With a large court present the weights shift towards
greens; without one, `green` dominates at weight 3. The green itself is then dressed from
`dip-ring`, `dips`, `mounds`, `bumpers`, `bunker`, `bank`, `post`. The finale also decides whether
an air approach (pad/geyser) is required to reach the cup at all, which is where the
"pad onto a green…" finale strings come from.

### Features

`Ho` (prettified 8284 onward) places features after the route exists. In order:

1. claims the tee, the first three route cells and everything within 2 cells of the tee,
2. places the portal feature (`Qa`) when `portals` is primary, or when `portals` is active and a 40%
   roll fires,
3. runs the layout builders `ro` (bump/crossing sites), `Ua` (bumps), `Ha` (folds), `Lo`,
4. places the air move (`Va`),
5. places shortcuts (`Ka`), up to `min(4, 2 + round(risk) + tongue)` of them,
6. forces a logic circuit (`Ro`) when `logic` is primary and none exists,
7. places the primary family twice (`zo`),
8. widens fairways (`Bo`/`wt`) when `width > 0.35` or a 25% roll fires,
9. adds hazards (`Io`) `round(sharp*2 + coin)` times.

Feature count is `max(4, min(15, round(floors * (0.17 + 0.1*(density-1)))))`.

The 20 feature definitions in `Vo`:

| id              | family    | weight | what it does                                        |
| --------------- | --------- | ------ | --------------------------------------------------- |
| `aperture`      | apertures | 3      | picks the narrowest gate piece matching `sharp`     |
| `split`         | apertures | 1      | `split-start` + `split-walls-to-open` twin channels |
| `baffle`        | apertures | 1.2    | `wall-left`/`wall-right` offset wall                |
| `mover-lane`    | movers    | 3      | spinner/slider/pendulum/piston on a lane            |
| `mover-court`   | movers    | 1.5    | movers inside a court                               |
| `gauntlet`      | movers    | 1.5    | series of movers with straights                     |
| `kicker`        | relief    | 2      | kicker ramp pair                                    |
| `court-terrain` | relief    | 2      | terrain inside a court                              |
| `sand`          | surfaces  | 2      | sand patch                                          |
| `ice`           | surfaces  | 1.6    | ice patch                                           |
| `ice-court`     | surfaces  | 1      | court of ice                                        |
| `bumpers`       | bumpers   | 3      | bumper cluster                                      |
| `bank-walls`    | banks     | 3      | banked walls along a curve                          |
| `curved-rail`   | banks     | 1.5    | curved rail overlay                                 |
| `field`         | fields    | 3      | magnet/gravitywell                                  |
| `fan`           | fields    | 2      | fan                                                 |
| `boost-climb`   | boosts    | 3      | boost into a climb                                  |
| `boost-drop`    | boosts    | 3      | boost off a drop                                    |
| `trampoline`    | pads      | 1      | trampoline                                          |
| `portal`        | portals   | —      | hoop/secret/gated/perch pairs (`Qa`)                |

Measured feature-family distribution over 300 seeds (prefixes of `meta.features`): relief 460,
surfaces 367, hazard 365, movers 330, bumpers 260, layout 213, pads 183, apertures 172, flow 162,
fields 149, boosts 83, banks 53, portals 38, logic 31, air 28, geysers 10. Mean 9.7 features per
hole.

### Shortcuts

`Wa` (prettified 6781–6797) is a ten-entry table. Each entry has a family affinity, a base weight, a
boost when that family is active, and a _gain window_ in cells saved:

| shortcut        | family    | base | boost | gain window |
| --------------- | --------- | ---- | ----- | ----------- |
| `plank`         | apertures | 1.0  | 0.8   | 6–11        |
| `catwalk`       | —         | 1.2  | 0     | 7–14        |
| `ice-plank`     | surfaces  | 0.6  | 1.0   | 6–10        |
| `spinner-plank` | movers    | 0.3  | 1.6   | 6–12        |
| `gated-plank`   | logic     | 0.2  | 1.8   | 6–12        |
| `kick`          | relief    | 0.7  | 0.9   | 6–11        |
| `pad`           | pads      | 1.0  | 1.4   | 6–12        |
| `chute`         | relief    | 0.8  | 0.8   | 6–14        |
| `ledge`         | relief    | 0.5  | 0.8   | 6–14        |
| `long-pad`      | pads      | 0.7  | 1.0   | 8–16        |

Candidate shortcuts are scored by
`rand^(1/(2 + gain*0.15 + familyBonus*3))`, so short gains are strongly preferred unless the family
is active. A shortcut is rejected if it would cross an existing bump (`Sa` exempts catwalk and the
four planks), if it covers more than 45% of the route (`wa` exempts the same set plus pads, kicks,
ledges and chutes), if the gain is outside the window, or if a plank/catwalk would not actually be
reachable from the route (`Ca`).

### Dressing and emit

- `Lt` (prettified 1947 onward) emits every board cell as a piece. Cells on the main route come
  first, then off-route cells. It handles four special cases: macro cells become one large corner
  with a solved rotation; `device` cells get rails on their open sides; two-edge rooms/greens/tees
  become an `open` piece with corner rails; everything else goes through `Nt`, the open-side piece
  selector.
- `Nt` (prettified 1847–1906) is the piece solver. It honours an explicit piece when one is set
  (solving its rotation with `St` against the registry socket table), otherwise picks by open-side
  count: 4 → `open`, 3 → `side`, 2 → `straight` or a corner from `yt`, 1 → `end`/`round-cap`, 0 →
  `open` with rails. `spline-straight` is substituted 20% of the time on plain straight lanes.
- `Et` rotates the whole board by a solved mirror + quarter-turn so the hole's long axis fits the
  camera, rebuilding cells, walls, splines, bridges, portals, tee, cup and circuits.
- `Ei` (prettified 3804 onward) recolours everything (see below), `Yi` decorates, `aa` orchestrates
  both.

### Events

`st`/`ot` compile circuits into the emitted `events` object:

```json
{ "version": 1, "nodes": { "<id>": { "kind": "...", "x": ., "z": ., ... } },
  "links": { "<from>><to>": { "from": {"node": ., "port": .}, "to": {"node": ., "port": .} } } }
```

Part kinds map to node kinds: `plate → ball-trigger`, `gate → gate`, `junction →
rotating-junction`, `particle → particle-emitter`, `sound → sound-emitter`. Bridges become
`drawbridge` or `trapdoor` nodes with `initialPose`/`activatedPose`.

`ss` always adds a celebration circuit `fx-cup` when `celebrate > 0`: a hidden hole plate wired to a
cheer sound and a confetti (or firework at `celebrate >= 3`) emitter, with palette
`['gold','rainbow','cool','warm'][seed % 4]`. At `celebrate >= 2` and an island landing it also adds
`fx-land` with a `spark` preset.

### The replay-safe lint

`pt` (prettified 1281–1373) is a hand-written event linter. It is not cosmetic — any `error`-level
finding rejects the attempt. Its rules, with the reasoning embedded in the messages:

| rule               | limit                                                        |
| ------------------ | ------------------------------------------------------------ |
| `sensor-count`     | ≤ 6 ball triggers                                            |
| `gameplay-sensors` | ≤ 3 triggers that drive a gameplay actor                     |
| `emitters`         | ≤ 3 particle emitters                                        |
| `dead-plate`       | every plate must have a responder                            |
| `fanout`           | ≤ 8 responders per plate                                     |
| `hidden-gameplay`  | hidden plates cannot drive gameplay actors                   |
| `burst`            | ≤ 96 particles per second per plate (sizes 12/24/40)         |
| `sounds`           | ≤ 1 sound per plate (120 ms global gap)                      |
| `seam-settle`      | settle plates ≤ 0.8 × 0.8 and ≤ 0.15 from a cell centre      |
| `blade-trap`       | plates ≥ 2.25 tiles from rotating junctions                  |
| `gate-timing`      | plates ≥ 1.5 tiles from an opening gate (0.25 s still solid) |
| `deck-timing`      | plates ≥ 1.5 tiles from a drawbridge/trapdoor                |
| `orphan-effect`    | effects must be wired                                        |
| `unwired-actor`    | gates/junctions must have a plate                            |
| `missing-node`     | links must resolve                                           |

`gate-timing` is the single most common v3 rejection after `grow` (147 occurrences per 300 seeds),
which says the generator regularly places a plate too close to a gate it opens and the lint catches
it. That is a good illustration of the "generate and validate" design: the layout code is allowed to
be optimistic because the linter is the guard rail.

### Tee-camera check

`Ni` (prettified 4135 onward) reconstructs a camera ray from the ball towards the second waypoint
and marches 20 samples looking for deck, solid or bridge geometry above the ray. It first rejects
any hole whose opening waypoint is more than 70° off the tee exit. This is the reason a hole can be
rejected for something no layout rule mentions: 138 rejections per 300 seeds, tied with `floor` as
the third most common cause after `grow` and `gate-timing`.

### Overlay budget

`os` (prettified 8830–8869) caps overlay counts after feature placement, removing the ones _farthest_
from the route first:

- `gravitywell`/`fan` 1 (2 if `fields` is primary), `magnet` 2;
- `bumper`, `spinner`, `slider`, `pendulum`, `piston`, `trampoline` 4 (8 if the primary family owns
  that kind);
- all field overlays together 2 (3 if `fields` is primary);
- `bumper`, `magnet` and `gravitywell` cannot sit within 1.05 of the cup on the cup's level.

Measured overlay mix over 300 seeds: `wall` 3465 (rails are overlays), `bumper` 426, `ice` 401,
`jump` 244, `sand` 210, `spinner` 190, `slider` 149, `trampoline` 109, `pendulum` 91, `boost` 76,
`portal` 58, `geyser` 53, `magnet` 41, `gravitywell` 40, `piston` 20, `curved-rail` 16, `fan` 9.

## Scoring and candidate selection

`cs` (prettified 8956–9069) is the objective function. Everything is additive:

| term        | value                                                                                                 |
| ----------- | ----------------------------------------------------------------------------------------------------- |
| `corridor`  | −6 × max(0, bareShare − 0.3), where a "bare" cell is an unadorned 2-edge lane                         |
| `floorFit`  | −2 × absolute ln of (floors ÷ genome.floor)                                                           |
| `kinds`     | 0.25 per distinct piece/overlay/spline/event kind, cap 16                                             |
| `features`  | 0.4 per feature, cap 8                                                                                |
| `primary`   | +1.5 if a primary-tagged feature exists, else −1.5                                                    |
| `longRun`   | −0.6 per cell of straight run beyond 5                                                                |
| `chute`     | −0.5 per cell of chute run beyond 3                                                                   |
| `density`   | −2 × absolute difference between deck density and 0.38                                                |
| `compact`   | −4 × 10 × (0.25 − density) when density < 0.25                                                        |
| `flowFit`   | −1.5 × absolute difference between spline share and flow × 0.8                                        |
| `choices`   | 1.1 per invitation (route alternative), cap 3; −2.5 if none                                           |
| `deadBump`  | −3 per dead-end note (`bump without a crossing`, …)                                                   |
| `deadTrack` | −7 × dead-lane share                                                                                  |
| `cupTease`  | −3 if the cup is visible within 2.3 from the first 60% of the route **and** no invitation is within 3 |
| `moments`   | 0.6 per structural segment, cap 5; −3 if fewer than 2                                                 |
| `bare`      | −0.9 per unit of longest bare stretch beyond 5                                                        |
| `skill`     | up to +1.2 for a skill gap ≥ 0.5, else −1                                                             |
| `air`       | +1.5 for a non-drop hop, +0.6 for any hop/bridge, else −1                                             |
| `walledCup` | −8 when the cup is within 5.5 of the tee and there is no invitation within 3                          |

A hole is "boring" when it has fewer than 2 moments, a bare stretch over 6, or a spline run over 8
cells; boring holes take a further −15.

`$o` (prettified 8616–8680) is the candidate loop:

- 40 attempts and 6 candidates by default;
- it stops early when it has 6 candidates _and_ at least one has `skillGap >= 0.5` _and_ at least one
  is not boring — or when it has 12;
- candidates are sorted by score and the best wins;
- **if the best score is below 5 or the best is boring, and no genome override was given**, the whole
  genome is regenerated with `aspect ≤ 1.35, curl ≥ 0.55, flow ≤ 0.35, court ≥ 0.5` and up to 40 more
  attempts run; the result is kept only if it scores higher, and is marked `meta.rescued`.

Measured: 13/400 seeds (3.3%) take the rescue path. Score distribution: min −0.72, median 11.53,
max 15.81. That means the threshold of 5 is rarely the trigger — rescue is almost always reached via
the `boring` flag.

`meta.rejects` accumulates every rejection reason across every attempt for that seed, which is the
single most useful debugging surface the generator exposes. Measured over 300 seeds:
`grow` 949, `lint:gate-timing` 147, `teecam` 138, `floor` 138, `finale` 32, plus **115 distinct**
one-off `error:not adjacent …` / `error:forced hole-round cannot match open sides …` strings.

## Colour

Colour is generated, not authored, and it is validated perceptually.

- Everything is computed in OKLab/OKLCH (`qt`/`Jt`), converted back through sRGB (`Kt`).
- A turf hue is only legal if it survives a contrast check (`rr`): it must achieve the target
  lightness within 0.05 and pass `Gn`, which requires a ΔE of at least 16 against the sea, a
  difference of at least `min(16, 0.85 × base)` against the ball, and per-band aim separation
  (low ≥ 9, mid ≥ 10, high ≥ 10). Turf hues are searched in 3° steps over 0–360 with 52°–135°
  excluded (`Wn`), up to 80 attempts, falling back to hue 300 at C 0.1.
- Zoning is chosen from five passes — `stripes`, `plaza`, `risk`, `court`, `drift` — trimmed to at
  most 2, and applied as lightness/chroma/hue deltas.
- Decorative overlay colours are fixed per kind: boost `#7dffce`, jump `#ffd166`, geyser `#4dd9e8`,
  portal `#b388ff`, sand `#e0c184`, ice `#bfe9ff`, bumper `#f2f4f9` on `#e44b5a`, gate `#d6a448`.
- Aim decals use `#3ddc68` / `#ffd23d` / `#ff4d3d` for low/mid/high.
- Piece colours are then guarded per piece: if a decal colour clashes with the piece colour it
  searches small lightness perturbations and, if nothing reaches a guard score of 1, falls back to
  the kit colour. Guard outcomes are recorded in the colour analysis (`counts`, `guards`,
  `warnings`), not in the level.

Themes come from `theme-BxxhUw0H.js` (`day`, `sunset`, `night`, `dawn`, `breezy`, `snow`), weighted
in `Kn` as day 2, breezy 2, dawn 1.5, sunset 1.5, night 1.5, snow 1. Because theme selection goes
through a hashed 336-value deck (`or` + `Ur` + `zr`, a baked hex table), any 336 consecutive seeds
contain **exactly 56 of each theme** — measured exactly 56/56/56/56/56/56 over seeds 0–335, and
66–67 per theme in the 400-seed sample. The `Kn` weights are the generic fallback used when a look
config is built without an override; for the default `putt` palette the theme comes from the deck.
Other palettes (`timber`, etc.) run a 4 × 336 × 14 local search (`Rr`) rather than using the baked
table.

`scenery` is `course` or `islands`, weight 3:1 in `er`, and only `course` survives emission
(`t.scenery === 'course' ? level.scenery = 'course' : delete`), so measured 75% `course` / 25%
absent.

## Decor

`Yi` (prettified 4392 onward) places scenery in passes, each of which audits candidate positions
against the tee camera before accepting them:

1. **hoop auditions** — `wi` finds every portal _entry_ overlay that has a `jump` pad two cells
   behind it, i.e. the hoop-style portal shots. Each such site gets a `tree-oak` (fixed colour
   `#e5484d`) on both sides at 1.45/1.75/2.05 units, trying scales 1.25 / 1.0 / 0.8 until the
   camera accepts one.
2. **monuments** — 0–2 when the mood rolls 35%, scale 2.2–6, placed on 18 candidate angles at two
   rings outside the course bounds.
3. **lookouts** — 0–2 at 25%, anchored on cells at height ≥ 1, 14 candidate angles at radius
   1.5–2.4.
4. **framing** — 60% of the time, up to 3 items on a ring of 2.7/3.3/3.9 around the cup, excluding
   a 55° wedge behind the cup.
5. **field fill** — the remaining budget, mixing "place near an existing decor item" (25–40%) with
   "place on a random ring around the course centroid".
6. **lost-ball swap** — 12% of one entry gets a `lost-ball-*` item appended.

Any item that fails the camera audit is first retried shrunk (`scale ≤ 0.7`, at most 2 items) and
then dropped, counting `droppedForTee`. The fill loop is bounded by `60 + count*40` attempts.

Moods are 8: `orchard`, `grove`, `pinewood`, `rockfield`, `meadow`, `dunes`, `fungal`, `bare`, each
with 4 item recipes and a `foliage`/`big` hint. Mood can be overridden by a free-text `decor` string
with fuzzy aliases (`forest → grove`, `rocks → rockfield`, `sand → dunes`, `mushroom → fungal`,
`lush → orchard`, and a hash fallback for unknown words).

Two rejection filters run during decor:

- `Ki` rejects any decor item that would occlude the tee camera, by projecting a cylinder of 20
  points plus the saved waypoints through the candidate camera;
- `Ji` desaturates (`L ≤ 0.56`, `C ≤ 0.09`) items that recede from the camera.

Output shape is one entry per cluster:

```json
{
  "items": ["tree-oak", "bush", "flower-yellow"],
  "x": 7.39,
  "z": 0.8,
  "rot": 1.966,
  "scale": 0.954,
  "appearance": { "color": "#..." }
}
```

Hard cap: `decor.slice(0, 60)`. Measured 291/300 seeds have decor (97%).

The decor item vocabulary is closed by the validator: 45 names, enforced by `specValidation`
(`tree`, `tree-oak`, `tree-pine`, `tree-detailed`, `rock-large`, `rock-small`, `bush`, `bush-large`,
`flower-red`, `flower-yellow`, `flower-purple`, `mushroom`, `mushrooms`, `stump`, `grass`, `fence`,
`lost-ball-blue/red/green`, `signpost`, `pumpkin-patch`, `log-pile`, `flower-pot`, `obelisk`,
`tree-autumn`, `tree-oak-autumn`, `palm`, `cactus`, `pumpkin`, `jack-o-lantern`,
`jack-o-lantern-tall`, `gravestone`, `gravestone-cross`, `lantern`, `lamp-post`, `candles`,
`hay-bale`, `arrow-sign`, `arrow-signpost`, `sign-board`, `flag`, `barrel`, `crate`, `golf-club`,
`golf-flag`). Anything else is silently filtered out by the validator, so an extension must stay
inside this list.

## What is emitted

### v3

```json
{
  "runtimeVersion": 2,
  "id": "gen3-424242",
  "name": "Orchard Steps",
  "par": 7,
  "pieces": [...],
  "decor": [...],
  "overlays": [...],
  "splines": [...],
  "events": { "version": 1, "nodes": {...}, "links": {...} },
  "ball": { "x": -0.2, "z": 0, "y": 1 },
  "cup": { "x": -8, "z": -7, "y": 1 },
  "theme": "day",
  "scenery": "course",
  "overview": "fit-course-v1"
}
```

- `pieces`: `{piece, x, z, y?, rot, offPath?, appearance?: {color}}`. Integer `x`/`z`; `y` is
  omitted at 0. `offPath` marks decorative or bypass geometry that is not part of the waypoint
  chain.
- `overlays`: `{kind, x, z, y?, rot?, ...}` — kinds `wall`, `bumper`, `spinner`, `slider`,
  `pendulum`, `piston`, `boost`, `jump`, `sand`, `ice`, `portal` (with `portalPairId`/`portalRole`),
  `geyser`, `trampoline`, `magnet`, `fan`, `gravitywell`, `one-way-flap`, `catch-basin`,
  `curved-rail`. Walls carry `size: [w, h, d]`.
- `splines`: `{nodes: [{x, z, y?, width?, bank?}], width, dockStart: true, dockEnd: true, wall?,
appearance?}`. Coordinates are quantised to 1e-3 by `It`.
- Coordinates inside `pieces`/`decor` are quantised before emission, which keeps the serialised size
  small and stops float noise from accumulating in the level.

Par for v3 is `clamp(round(4.5 + 0.36 × expert + 0.5 if island), 4, 10)` where `expert` is the
turn-penalised A\* distance from tee to cup measured on the rotated board. Because `expert >= 0` and
`round(4.5) = 5` in JavaScript, the effective minimum is **5**, not the clamp's 4; par 4 is
unreachable. Measured distribution over 400 seeds: 6 → 36, 7 → 174, 8 → 146, 9 → 39, 10 → 5. The
practical ceiling is around par 9: par 10 needs `expert >= 15.3`, which needs a long island hole.

Names are `${Xo[rand]} ${Zo[rand]}` from two 16-word lists (`Hollow`, `Ridge`, `Terrace`, … /
`Run`, `Loop`, `Steps`, …) — 256 combinations, so collisions across a playlist are likely and
harmless.

### v1

No `runtimeVersion`, no `theme`, no `splines`, no `events`, no `overview`. `decor` is a required
array (may be empty). `ball` is always `{x: 0, z: 1.8}` and the cup is the last walk cell.

### Engine hand-off

`GameCanvas` recomputes the derived state per level and stores it in the runtime store `V`:

- `courseAabb` — bounding box over `pieces`, `decor` and spline nodes, x/z expanded by 0.5 and
  doubled (world units are 2× grid units).
- `waypoints` — every `piece` that is not `start`, `supports` or `offPath`, plus spline nodes, in
  order, doubled. This is the definition of "on the path" for camera and guidance.
- `zones` — from piece `special` markers, overlay kinds, portal pairs and `loop` pieces; kinds are
  `bumper, boost, jump, sand, ice, geyser, trampoline, magnet, fan, gravitywell, portal, loop`.
- `wpIndex`, `wpIndexAtFire`, `traj`, `lastShot`, `eventTimeline`, `discontinuitySeq` for telemetry
  and the "did the ball leave the course" logic.

Nothing else in the level is interpreted: `theme`, `name`, `overview`, `scenery` are presentation
only, and `par` is scoring metadata.

## Validation

`specValidation` is the authoritative gate, and the generator runs it on every attempt
(`n(E)` inside `ns`, rejecting as `spec:<message>`). Its limits:

| limit                   | value     |
| ----------------------- | --------- |
| coordinate              | ±256      |
| elevation               | ±128      |
| pieces                  | 600       |
| overlays                | 200       |
| decor entries           | 200       |
| decor items per entry   | 8         |
| pits                    | 200       |
| splines                 | 32        |
| spline nodes per spline | 256       |
| total spline nodes      | 2048      |
| wall size               | 12        |
| serialised bytes        | 1,000,000 |

The generator stays far inside these: measured 21–87 pieces (median 48), 18.7 overlays average,
1.6 splines average, 3.4–16.3 kB serialised.

Validation success: 120/120 v3 seeds and 300/300 v1 seeds pass the full `specValidation` with no
repair. The validator does have a repair path for unknown decor items (`F(e)` filters them out), but
the generator never needs it.

## Can generation be customised beyond a seed?

Partially, and asymmetrically:

| Surface                         | Reachable?                                 | Notes                                                                                |
| ------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------ |
| Seed                            | yes, via any entry point                   | 0…2³²−1 for v2/v3                                                                    |
| Version                         | yes, `t(seed, version)`                    | 1, 2, 3                                                                              |
| Genome gene values              | only via `i(seed, {genome})`               | unknown keys dropped; numeric genes clamped                                          |
| `primary` / `secondary` / `tee` | only via `genome` override                 | rebuilt weights follow                                                               |
| Attempts / candidates           | only via `i(seed, {attempts, candidates})` | measured below                                                                       |
| Colour / theme / decor mood     | **no**                                     | `aa` calls `ia(seed, undefined)`; the look config is not plumbed from `Qo`'s options |
| Piece palette / rules           | no                                         | hard-coded tables                                                                    |
| Par                             | no                                         | derived                                                                              |

Measured effect of the attempt/candidate knobs (15 seeds each, `gen:v3` only):

| setting                          | succeeded | median score |
| -------------------------------- | --------- | ------------ |
| `{attempts: 1, candidates: 1}`   | 11/15     | 7.9          |
| `{attempts: 5, candidates: 2}`   | 15/15     | 9.7          |
| default `{40, 6}`                | 15/15     | 11.5         |
| `{attempts: 80, candidates: 12}` | 15/15     | 11.8         |

The success and median figures move by a seed or two between samples of 15, so read the rows as
trends. The trend is clear: the knobs degrade gracefully, and the default is already near the point
of diminishing returns — tripling the work buys about 0.3 score.

All 12 primary-family overrides produce playable levels (20/20 each). The primary-tagged feature is
present in only 5/20 (`geysers`), 9/20 (`logic`), 14/20 (`portals`), 15/20 (`banks`), and 19–20/20 for
the rest, which means `primary` is a strong bias rather than a guarantee — and the `primary` scoring
term (−1.5 when absent) is what pushes the candidate loop to find one.

Genome clamping is confirmed: `floor: 500 → 95`, `floor: 1 → 20`, `width: 5 → 1`, unknown keys
dropped, `secondary` override honoured and reflected in `weights`.

What is _not_ customisable is the look. There is a complete colour/theme/decor configuration layer
(`or`, `ra`, `ia`, `Ur`, `Rr`) with theme, tint, palette (`timber/slate/stone/tone/earth` +
`/struct`), decor mood and zoning overrides, but `aa` calls it with `undefined` for the override
argument, so from the public API those options are unreachable. This is the largest piece of
dead-but-complete capability in the module.

## Backend dependency

None. The generator contains **zero** occurrences of `fetch`, `XMLHttpRequest` or
`createServerFn`. Everything is synchronous, in-memory and client-side.

The only consumer of generated courses is `party._code-D3a-IB4-.js`, and it resolves them locally:

```js
async function loadHole(id) {
  if (id.startsWith('gen:')) return { ...generateFromReference(id), name: 'Party' };
  const res = await fetchMap({ data: { id } });
  ...
}
```

The default seed is the constant `424242`, and `gen:<seed>` is the literal default hole id when a
room has no explicit hole list. Network access is only used for _catalogue_ holes (public course
ids), never for generated ones. That means a Better Party room can generate an unlimited supply of
holes with no upstream availability and no server round-trip — and equally that a generated hole is
reproducible forever as long as the bundle hash is pinned.

The whole generator also runs under plain Node with no DOM, no `window`, no WebGL and no network —
verified by copying the module's 25-file transitive import closure out of the pinned assets and
calling `i(424242)` successfully. `document`, `window`, `localStorage` and `navigator` do not appear
anywhere in the generator bundle.

## Performance

| pipeline        | measurement                                                  |
| --------------- | ------------------------------------------------------------ |
| v1              | 2000 seeds in 1.23 s → ~0.6 ms/seed (p50 0.43 ms)            |
| v3, cold        | first calls 170–1250 ms (module init, JIT)                   |
| v3, warm        | p10 75 ms, p50 145 ms, p90 310 ms, max 560 ms over 200 seeds |
| v3, whole-batch | 200 seeds in 34 s                                            |

v3 is roughly 250× the cost of v1, and it is single-threaded and synchronous. In the client this
means a visible hitch when a v3 hole is requested. In practice the party flow generates the hole
once at load and caches the level in the store, so the cost is paid once per course rather than per
frame. A caller that wanted to pre-generate a playlist should budget ~0.15 s per hole and expect a
long tail (one seed in a few hundred exceeded 1 s cold).

The cost is dominated by the attempt loop: 40 attempts × up to 6 retained candidates, each running
grow, features, emit, recolour, decor and a full `specValidation` pass. Candidate pruning is the main
lever; `{attempts: 5, candidates: 2}` lowers median score by roughly 2 points and costs several times
less.

## Undocumented and interesting capabilities

These are all present in the shipped bundle and reachable, but not obvious from the public API:

1. **`t` accepts a version 1, 2 or 3 and v2 is a stable alias of v1 geometry.** A course reference can
   be future-proofed by writing `gen:v2:<seed>` and it will never change shape even if v1's tables
   are edited later.
2. **`i` returns the board**, not just the level. `board.routes`, `board.invitations`,
   `board.splineRuns`, `board.hops`, `board.circuits`, `board.notes` and `board.bounds()` are all
   available, which makes it possible to reason about a hole structurally (route length, alternative
   routes, dead lanes) rather than by inspecting emitted pieces.
3. **`meta` is a complete explanation of a hole**: genome, attempt index, feature list, finale
   description, floor count, route length, expert distance, skill gap, dead-lane share, bare stretch,
   boring flag, score, per-term score breakdown, distinct kinds, corridor share and every rejection
   reason. This is a ready-made difficulty model.
4. **The event linter is reusable.** `pt` is a pure function of an `events` object and returns
   structured findings with rule names. It could validate hand-authored holes as well as generated
   ones.
5. **`specValidation` exports a repair path** for decor (`F`) that filters unknown items rather than
   failing. Any tool that writes levels can rely on it.
6. **Deterministic math is scoped.** `withDeterministicMath` monkey-patches `Math` and restores it in
   a `finally` block, so it is safe to call inside a long-lived process, though it is not
   re-entrant-safe if two generations were ever interleaved asynchronously.
7. **The primary/secondary family system is a real difficulty axis.** `ni` scores families by how
   well they match the genome, which means a `fields`-primary hole is systematically different from a
   `logic`-primary hole, not just decorated differently.
8. **Tee styles are structural.** `turn`, `flow`, `perch`, `cap` and `court` produce genuinely
   different openings (a turning tee, a flowing lane, an elevated perch, a cap, an arena), and
   `tee:perch` forces the tee up by 2 when the height budget allows. Measured over 400 seeds:
   `flow` 133, `turn` 134, `perch` 67, `cap` 66. `court` never appears from a seed because the gene
   list `Gr` does not contain it, but `genome: { tee: 'court' }` works and produced a
   `tee:court2x3` opening in 40/40 sampled holes.
9. **`overview: 'fit-course-v1'`** is a HUD hint that the camera should fit the whole course, which
   is why generated holes are always shown in full rather than from the tee.
10. **The fallback corridor is a real, valid level.** If everything else fails, v1 emits a 49-cell
    straight run that passes validation. That guarantees `t()` never throws for a valid seed.

## Failure modes and their frequency

Over 400 v3 seeds, 0 returned `null` and 13 (3.3%) were rescued. Over a separate 300-seed sample the
rejection counters were:

| reason                                   | count |
| ---------------------------------------- | ----- |
| `grow`                                   | 949   |
| `lint:gate-timing`                       | 147   |
| `floor`                                  | 138   |
| `teecam`                                 | 138   |
| `finale`                                 | 32    |
| `error:*` (mostly `not adjacent`)        | ~100  |
| other distinct keys (115 distinct total) | rest  |

The `error:` entries are thrown inside the board's link/rotation solvers and caught by the attempt
loop's `try/catch`, which truncates the message to 60 characters. They indicate the grower proposed
a move that the emitter could not realise — a real, if rare, mismatch between the graph model and
the piece registry. It is contained but it is the main place where the two representations
disagree.

## Unresolved questions

- **Was v3 shipped to players?** v3 exists and works, but the default path (`gen:424242` with no
  version) resolves to v1. Nothing in the captured client constructs a `gen:v3:` reference. v3 may be
  a later-generation experiment shipped but not enabled, or enabled by a flag not present in this
  capture.
- **`tee:court` needs an explicit override.** It is fully implemented in `ga` (four branches, plus a
  separate `tee:courtWxH` segment label) but the baked tee list `Gr` omits it, so no seed produces it.
  `genome: { tee: 'court' }` does, in 40/40 sampled holes, so this is override-only rather than dead
  code. Why it was excluded from the seed distribution is not determinable from the bundle.
- **Theme deck exactness across versions.** The 56-per-theme property holds for seeds 0–335 with the
  `putt` palette, but `Rr`'s local search for other palettes is only exercised when a non-`putt`
  palette is requested, which the public API never does. Whether the deck property survives there is
  untested.
- **`meta.rejects` accumulates across attempts and across the rescue pass**, so counts are per seed,
  not per attempt. Any difficulty model built on them should normalise by attempt count.
- **Par 4 is not merely unobserved, it is unreachable.** `Math.round(4.5) = 5` and `expert >= 0`, so
  the clamp's lower bound of 4 can never bind. Par 5 needs `expert < 2.78`, and the smallest par seen
  over 400 seeds was 6 — so no sampled hole had a tee-to-cup expert distance under ~2.8. Whether
  par 5 is reachable at all is unknown.
- **The `error:` strings suggest a modelling gap** between the board's abstract sockets and the
  registry's real sockets. How often a _player-visible_ geometry bug results is unknown, because the
  affected attempts are discarded.

## Potentially interesting applications

- **Offline course packs.** Because generation is pure and fast enough at ~0.15 s/hole, a build step
  could emit a few hundred validated holes to JSON, with `meta` as the difficulty index, and serve
  them with no runtime cost and no upstream dependency.
- **Difficulty calibration.** `meta.score`, `expert`, `skillGap`, `deadShare` and `bare` form a
  multi-dimensional handle that is not exposed anywhere in the UI. A Better Party ranking model could
  use `expert` and `skillGap` directly instead of par.
- **Hole search by constraint.** `i(seed, {genome})` makes it possible to search the seed space for
  holes with a desired profile — "a `logic`-primary hole with relief ≥ 3 and at least two
  shortcuts" — by scoring `meta` rather than parsing geometry.
- **Structural analytics.** `board.routes` / `invitations` / `hops` expose the route graph, which is
  what a "how many sensible lines does this hole have?" metric would need.
- **Reusable validation.** Both `specValidation` and the event linter are pure, dependency-light
  functions. A course-authoring tool could run the same gates the game runs, including the
  tee-camera check, which is the least obvious rule in the whole system.
- **Deterministic replay testing.** Since generation is bit-identical across engines, a pinned seed
  list makes an excellent regression corpus for any change to the piece registry or the renderer.

## Appendix: function map

Minified → descriptive, in module order. Line numbers are from the 9,097-line formatted copy.

| Line      | Minified                      | Name used here                                     |
| --------- | ----------------------------- | -------------------------------------------------- |
| 6         | `s`                           | `makeRng` (mulberry32)                             |
| 19        | `d`                           | `pickWeighted`                                     |
| 16/17/18  | `c`/`l`/`u`                   | `randInt` / `pickOne` / `chance`                   |
| 25        | `f`                           | `rotateVec`                                        |
| 97        | `y`                           | `solveOpeningRotation`                             |
| 106       | `b`                           | `solveWallRotation`                                |
| 115       | `x`                           | `pieceForWallSet`                                  |
| 123/127   | `S`/`C`                       | `rotForExit` / `rotForEntry`                       |
| 131       | `w`                           | `ARCHETYPES`                                       |
| 172       | `D`                           | `structuralSetPiece`                               |
| 201       | `O`                           | `LANE_PIECE_WEIGHTS`                               |
| 219       | `k`                           | `LANE_PIECE_CAPS`                                  |
| 237       | `A`                           | `CORNER_WEIGHTS`                                   |
| 249       | `ee`                          | `DECOR_RECIPES_V1`                                 |
| 259       | `te`                          | `walkCorridor` (v1)                                |
| 690       | `M`                           | `emitV1Level`                                      |
| 884       | `N`                           | `generateV1`                                       |
| 920–1155  | —                             | fdlibm math + `withDeterministicMath`              |
| 1157      | `tt`                          | `SIDES`                                            |
| 1194      | `ot`                          | `compileCircuitParts`                              |
| 1252      | `st`                          | `compileCircuits`                                  |
| 1270/1271 | `ct`/`lt`                     | `PARTICLE_COST` / `EVENT_LIMITS`                   |
| 1281      | `pt`                          | `lintEvents`                                       |
| 1374      | `z`                           | `SIDES` (index array)                              |
| 1390      | `W`                           | `sideBetween`                                      |
| 1405/1417 | `bt`/`St`                     | `socketSides` / `matchRotation`                    |
| 1421      | `Ct`                          | `Board`                                            |
| 1546      | `wt`                          | `widenRoom`                                        |
| 1580      | `Et`                          | `rotateBoard`                                      |
| 1668      | `Dt`                          | `buildGraph`                                       |
| 1691      | `Ot`                          | `distToCupExcludingShortcuts`                      |
| 1702      | `kt`                          | `analyseDeadLanes`                                 |
| 1778      | `At`                          | `dijkstraToCup`                                    |
| 1805      | `jt`                          | `turnedAStar` (turn cost 0.75, 1/9 per cell)       |
| 1841/1847 | `Mt`/`Nt`                     | `isCorner` / `selectPiece`                         |
| 1907      | `Pt`                          | `solveMacroRotation`                               |
| 1935      | `Ft`                          | `OVERLAY_PIECE_ALIASES`                            |
| 1947      | `Lt`                          | `emitV3Level`                                      |
| 2193/2208 | `zt`/`Bt`                     | `hash32` / `stream`                                |
| 2232–2300 | `qt`/`Jt`/`Qt`/`en`           | OKLab conversions + ΔE                             |
| 2310      | `ln`                          | `THEME_NAMES`                                      |
| 2368–2500 | `jn`/`Mn`/`Rn`/`zn`/`Bn`/`Gn` | palette derivation + contrast gates                |
| 2501      | `Kn`                          | `THEME_WEIGHTS`                                    |
| 2555/2563 | `nr`/`rr`                     | `legalTurfHues` / `isLegalTurfHue`                 |
| 2570      | `ir`                          | `harmonyHue`                                       |
| 2587      | `ar`                          | `decorCount` (log-normal)                          |
| 2594      | `or`                          | `makeLookConfig`                                   |
| 2684      | `cr`                          | `slabColour`                                       |
| 2703      | `lr`                          | `derivePalette`                                    |
| 2765      | `dr`                          | `paletteDistance`                                  |
| 2780/2802 | `hr`/`gr`                     | `deckOrder` / `hashedPick`                         |
| 2826/2835 | `Dr`/`Or`                     | theme/turf derivation                              |
| 2869/2891 | `kr`/`Rr`                     | zoning / palette local search                      |
| 2919      | `zr`                          | baked 336-entry hue table                          |
| 2928/2932 | `Ur`/`Wr`                     | `lookForSeed` / `FAMILIES`                         |
| 2946      | `Gr`                          | `TEE_STYLES`                                       |
| 2963/2966 | `$r`/`ei`                     | `gene` / `biasToEdge`                              |
| 2970/2973 | `ti`/`ni`                     | `turtlePick` / `familyUsefulness`                  |
| 3001      | `ri`                          | `makeGenome`                                       |
| 3095      | `oi`                          | `buildFinale`                                      |
| 3804      | `Ei`                          | `recolourLevel`                                    |
| 4135      | `Ni`                          | `teeCameraCheck`                                   |
| 4237      | `Hi`                          | `DECOR_MOODS`                                      |
| 4337      | `Ki`                          | `occludesTeeCamera`                                |
| 4388      | `Ji`                          | `desaturateReceded`                                |
| 4392      | `Yi`                          | `placeDecor`                                       |
| 4647      | `Xi`                          | `DECOR_MOOD_ALIASES`                               |
| 4667/4680 | `Zi`/`ea`                     | `resolveMood` / `parsePalette`                     |
| 4729/4732 | `ia`/`aa`                     | `lookForSeedWith` / `applyLook`                    |
| 4788      | `fa`                          | `sweepSpline`                                      |
| 4935/4949 | `pa`/`ga`                     | `makePlan` / `growBoard`                           |
| 6270      | `va`                          | `rankMoves`                                        |
| 6284/6292 | `ya`/`xa`                     | `rectCells` / `bfsPath`                            |
| 6310      | `Ca`                          | `shortcutIsReachable`                              |
| 6781      | `Wa`                          | `SHORTCUTS`                                        |
| 7309–8283 | `mo`…`Po`, `Qa`               | `FEATURES[20]`                                     |
| 8284      | `Ho`                          | `placeFeatures`                                    |
| 8575/8576 | `Jo`/`Yo`                     | `DEFAULT_ATTEMPTS` (40) / `DEFAULT_CANDIDATES` (6) |
| 8577/8595 | `Xo`/`Zo`                     | `NAME_PREFIXES` / `NAME_SUFFIXES`                  |
| 8613/8616 | `Qo`/`$o`                     | `generateV3` / `generateBest`                      |
| 8682      | `ns`                          | `attemptOnce`                                      |
| 8776      | `rs`                          | `longestBareRun`                                   |
| 8809      | `is`                          | `shortcutExcludedDistance`                         |
| 8830      | `os`                          | `enforceOverlayBudget`                             |
| 8870      | `ss`                          | `addCelebrations`                                  |
| 8956      | `cs`                          | `scoreHole`                                        |
| 9070      | `ls`                          | `parseVersion`                                     |
| 9080      | `ds`                          | `generateAny`                                      |
| 9091      | `fs`                          | `generateFromReference`                            |
