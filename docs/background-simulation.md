# Background simulation and the fixed-step clock

What the original client does with time while a tab is hidden, recovered from the
pinned bundles. This is a description of behaviour that already exists; the party
build changes none of it.

## Two runtimes, two clocks

A course declares `runtimeVersion`, and the client picks a simulation path from it
(`runtimeVersion-DMr6qz4K.js`, `I()`):

- **absent or `1`** — the legacy path.
- **`2`** — the fixed-step path.
- anything else — `Unsupported map runtime version`.

Every live public course sampled from the catalog declares `runtimeVersion: 2`
(`do it try it`, `slow and steady 1.0`, `The Labyrinth`, `Tightrope`,
`Golf Trials 1: Easy`, `the broken back world`), so the fixed-step path is the one
a party actually runs.

The choice reaches the scene as three arguments in `GameCanvas-C5hQh1sR.js`:

```
(0,Y.jsx)(_,{version:Ye(l),children:(0,Y.jsxs)(x,{
  gravity:ei, timeStep:1/120, paused:Ye(l)===2, debug:Gr, children:[...]})})
```

`paused` is `true` exactly when the runtime is version 2. That inversion is the
whole design: the physics component's own per-frame step is switched **off** for
version 2, because a separate ordered clock drives it instead.

## The version 2 clock

`AppearanceClone-CBos6VT9.js` holds it in a React context provider (`Qi`) and
exposes it through `$i`/`ea`/`ta`/`na`.

```
var Yi = 1/120;
class Clock {
  elapsed = 0;
  remainder = 0;
  discardNext = true;
  hidden = false;
  get alpha() { return Math.min(1, Math.max(0, this.remainder / Yi)); }

  setHidden(value) {
    this.hidden = value;
    this.remainder = 0;      // elapsed time is discarded, not banked
    this.discardNext = true; // and the first frame back advances nothing
  }

  advance(frameDelta, onStep) {
    if (this.hidden || !Number.isFinite(frameDelta) || frameDelta < 0) return 0;
    if (this.discardNext) { this.discardNext = false; return 0; }
    this.remainder += Math.min(frameDelta, Yi * 24);   // at most 0.2 s of catch-up
    let steps = 0;
    while (this.remainder + 1e-10 >= 1/120 && steps < 24) {
      this.remainder = Math.max(0, this.remainder - Yi);
      this.elapsed += Yi;
      onStep(Yi);                                     // fixed 1/120 s per step
      steps++;
    }
    return steps;
  }
}
```

Three properties follow directly, and they are the reason the clock is safe:

1. **A hidden page simulates nothing.** `hidden` short-circuits `advance`, so no
   step is taken and `elapsed` does not move. The world is frozen, not fast-forwarded.
2. **Elapsed time is thrown away, not replayed.** `setHidden` zeroes `remainder`,
   so the seconds spent in the background are gone. There is no catch-up burst on
   return — the exact failure mode a naive "just keep accumulating" loop has.
3. **Catch-up is bounded anyway.** Even without the hide, one frame can contribute
   at most 0.2 s (24 steps at 1/120), so a long stall cannot spiral.

`discardNext` is the subtlety: the first frame after `setHidden(false)` returns 0
without consuming the remainder, so a resume costs one silent frame rather than an
immediate jump.

## Who advances it, and in what order

`na()` is the driver. It subscribes to the render loop at priority `-100` — before
everything else — and does two things.

**Wiring visibility.** On mount it reads `document.hidden`, then listens:

- `visibilitychange` on `document` → `setHidden(document.hidden)`
- `pagehide` on `window` → `setHidden(true)`
- `pageshow` on `window` → `setHidden(document.hidden)`

`pagehide` covers the bfcache/media-restore cases where no `visibilitychange`
arrives. So the clock is suspended by three independent signals, not just one.

**Ordering the step.** Each frame:

```
if (document.hidden) { clock.setHidden(true); return; }   // belt and braces
const subscribers = [...set].sort((a, b) => a.order - b.order);
clock.advance(frameDelta, (step) => {
  context.clock.elapsedTime = clock.elapsed;
  for (const s of subscribers) if (s.phase === 'before') s.callback(step);
  physics.step(step);                                     // the world
  for (const s of subscribers) if (s.phase === 'after') s.callback(step);
});
```

`ta(callback, phase = 'before', order = 0)` is how components subscribe. The
registrations found in `GameCanvas-C5hQh1sR.js` fix the ordering:

| phase   | order  | what it does                                    |
| ------- | ------ | ----------------------------------------------- |
| —       | `-100` | the clock driver itself (`na`)                  |
| `after` | `10`   | syncs the ball rigid body into the render state |
| `after` | `20`   | advances the course event runtime               |
| `after` | `1000` | samples the ball transform for interpolation    |

Every step is therefore: read the ball's simulated transform (`10`), tick course
events against it (`20`), sample the new position for drawing (`1000`) — all
strictly inside the fixed-step callback, so none of it can see a partial frame.

## Interpolation and the render driver

`alpha = remainder / (1/120)` is the fraction of a step left unsimulated. The ball
subscriber at order `1000` copies `translation()` into `cur`, keeping the previous
value in `prev`, and the per-frame visual uses `lerpVectors(prev, cur, alpha)`.
When `alpha` is 0 the ball is drawn exactly at its simulated position. `prev` is
snapped to `cur` instead of interpolated when the discontinuity sequence changes or
the two differ by more than 2 units squared, so a teleport or respawn does not smear
across the course.

`RenderDriver-CCq3IVur.js` (`f({maxFps, adaptive})`) is a plain `requestAnimationFrame`
loop that decides _whether_ to render; it never simulates. It skips frames to hold
`maxFps`, adapts to measured frame gaps, and — importantly for the clock — rewinds
`clock.oldTime` by the dropped interval when it skips, so the renderer's own
`THREE.Clock` does not report a huge delta. It also backs off on real jank rather
than firing a burst of renders.

## Input cancellation

`$t()` in `GameCanvas-C5hQh1sR.js` registers a `visibilitychange` handler that runs
only when the level is version 2 **and** `document.hidden`:

```
const cancelDrag = () => {
  B.state.level?.runtimeVersion !== 2 || !document.hidden ||
    (pointerId !== null && releasePointerCapture(pointerId),
     pointerId = null, aim.active = false, aim.power = 0, resetCharge());
};
```

So a shot being pulled when the tab is hidden is **abandoned, not released**. The
drag is dropped, the aim is cleared, and the charge is reset — no stroke is
committed. Without this a backgrounded tab could fire a stroke the player never
finished. Verified in a real browser: pulling a shot and then hiding leaves the game
in `aiming` with `strokes` unchanged (see `tests/integration/check-background-clock.mjs`).

## Version 1, for contrast

Version 1 uses the physics component's own per-frame step (`paused` is `false`), so
the step size is the measured frame delta rather than a fixed `1/120`. The
accumulator still bounds a single frame, but there is no hidden-page bookkeeping:
the clock is not suspended, so returning from the background hands the loop the
whole elapsed interval (clamped) and the world jumps. That is precisely the
behaviour version 2 was introduced to remove, and it is why the party build must not
"simplify" the two paths into one.

## What this means for the party build

**No client change is required, and none was made.** The version 2 clock already
does what a background party needs:

- a hidden tab cannot desynchronize by simulating ahead;
- returning from the background does not fast-forward the hole;
- a half-finished swing is cancelled rather than fired.

Removing the `hidden` checks, or letting `remainder` accumulate across a hidden
period, would be a regression on all three counts. The party layer must not do it.

Two limits are real and are not fixed by any client code:

- **A browser may suspend the page outright.** Headless Chrome does exactly this:
  an occluded renderer stops answering CDP evaluations entirely, and a tab that
  stays hidden long enough can be frozen by the OS. No script can guarantee
  background execution, so the party assumes the server's round timer keeps running
  while a client does not.
- **The server timer is authoritative.** Server-side `endHole` settles the hole on
  its own schedule. A client that was hidden across that boundary resumes into a
  round that has already moved on; it must resynchronize, never replay. The
  round-change latch in `scripts/party-transport.js` (`roundChangePending` /
  `freshAttemptConfirmed`) is what enforces that.

The recovery expectation is therefore: start from the authoritative snapshot, load
the current course, and report only what the fresh attempt produces. Worker-based or
`SharedWorker` simulation was considered and rejected — it would move physics off the
render thread the original client ties it to, changing behaviour the party is required
to preserve, and it still could not survive an OS-level freeze.
