# Deterministic verification feasibility

Whether a reported score can be checked by replaying the shot through the physics
instead of trusting the client. This page records a measurement rather than a
judgement: what the pinned engine actually does with time, how far a shot can be
reproduced, and the one property that decides the question.

Everything below was measured against a real client on a real course through the
real pointer handlers. The probe is `tests/probes/p2-determinism.mjs`; the
commands are at the end.

## The short answer

The physics **is** reproducible. The same input, replayed on the same engine,
produces a **bit-identical** trajectory, and it stays identical when the frame
timing is deliberately disturbed well past the engine's own catch-up limit.

That does not make scores verifiable, because the thing that must be reproduced
is the **input**, and the input is a pointer position quantised to sub-pixel
precision. A **quarter of one CSS pixel** of extra pull changes the recorded
trajectory from its tenth sample and moves where the ball stops by **1.96 cm**.
The client never records that input, so a verifier has nothing exact to replay —
and a verifier that replays the _recorded trajectory_ instead proves only that
the client can produce a trajectory, which is the thing in question.

So the feasibility answer is: **deterministic replay is real, but it is not a
verification path without a protocol change, and the protocol change is what
costs more than the problem is worth.** The reasoning is spelled out below.

## What the engine does with time

Recovered from the pinned bundles, and consistent with
[background simulation](background-simulation.md).

The world is Rapier, stepped at a **fixed `1/120` s**. The step is not driven by
the frame delta directly; an accumulator consumes the delta and emits whole
steps (`AppearanceClone-CBos6VT9.js`):

```js
advance(frameDelta, onStep) {
  if (this.hidden || !Number.isFinite(frameDelta) || frameDelta < 0) return 0;
  if (this.discardNext) { this.discardNext = false; return 0; }
  this.remainder += Math.min(frameDelta, Yi * 24);   // Yi = 1/120, so 0.2 s max
  let steps = 0;
  while (this.remainder + 1e-10 >= 1/120 && steps < 24) {
    this.remainder = Math.max(0, this.remainder - Yi);
    this.elapsed += Yi;
    onStep(Yi);                                     // exactly 1/120 s, always
    steps++;
  }
  return steps;
}
```

Two consequences matter here. **Every step advances exactly `1/120` s** — the
subscriber is handed `Yi`, never the frame delta. And the trajectory sampler
accumulates **that step**, not frame time (`GameCanvas-C5hQh1sR.js`):

```js
let p = t ? o : Math.min(o, _n);   // the step (o), clamped for the legacy path
...
M.current += p; P.current += p;
P.current >= xn && (V.traj.push(...));   // xn = 0.04 s, Sn = 6000 samples
```

So a sample is emitted every `0.04` s **of simulated time**, which is `4.8`
steps, and positions are stored as integer centimetres (`Math.round(v * 100)`).

That is the whole mechanism behind the result below: frame pacing changes how
many frames it takes to reach a given simulated time, but not the sequence of
steps, and therefore not the samples.

## The measurement

One course (`5a87ddbb107d4209bfdf21a381fe460a`), one pull (`120` CSS px), one
stroke per run, the same spawn point every time
(`[-2, 4.191431522369385, 3.5999999046325684]`). Each run is a **fresh browser
process**; the service is the same instance.

| run | condition                      | max frame gap | samples | trajectory | rest position                                  |
| --- | ------------------------------ | ------------- | ------- | ---------- | ---------------------------------------------- |
| s1  | unthrottled                    | —             | 89      | baseline   | `[-2, 4.191416263580322, -1.3707833290100098]` |
| s2  | unthrottled                    | —             | 89      | identical  | identical                                      |
| s3  | 4× CPU throttle                | —             | 89      | identical  | identical                                      |
| s5  | 8× CPU throttle                | —             | 89      | identical  | identical                                      |
| s7  | 400 ms main-thread stall       | 401.9 ms      | 89      | identical  | identical                                      |
| s9  | 400 ms stall, wall-clock timed | 412.7 ms      | 89      | identical  | identical                                      |
| s10 | unthrottled, wall-clock timed  | 92.5 ms       | 89      | identical  | identical                                      |

All 89 samples are equal in every row — the same 267 integers, byte for byte —
and the resting position matches to the last bit of the `f32`.

The stall rows are the interesting ones. The accumulator **clamps one frame to
`0.2 s` and discards the excess**, so a 400 ms frame loses simulated time by
design. It still produced the identical trajectory, and the wall clock shows why:
the roll took **4831 ms** with the stall against **4408 ms** without it. The
simulation was fed the same steps, more slowly. Time was lost from the _real_
clock, not from the _step sequence_, and the score depends only on the latter.

That is a stronger statement than "the physics is deterministic": the outcome is
insensitive to frame pacing across a range that includes a stall well past the
engine's own catch-up limit.

## Why it is still not verifiable

### The control that makes the equality meaningful

An equality result is worthless if the measurement is dead. Pulling `160` px
instead of `120` produces **128** samples instead of 89 and a different resting
position (`[-0.588, 4.191, -2.643]`, **1.901 m** away). The probe responds to
its input, so the equality across the runs above is real reproducibility.

### And the control that closes the door

Change the pull by **a quarter of one CSS pixel** — `120` to `120.25`:

| pull     | samples | first differing sample | rest position                                  | displacement |
| -------- | ------- | ---------------------- | ---------------------------------------------- | ------------ |
| `120`    | 89      | —                      | `[-2, 4.191416263580322, -1.3707833290100098]` | —            |
| `120.25` | 89      | sample 10              | `[-2, 4.191416263580322, -1.3903733491897583]` | **1.96 cm**  |

A sub-pixel difference in the pointer delta moves where the ball stops by two
centimetres, which on a real green is the difference between a putt that drops
and one that does not. The physics amplifies input differences, as physics does.

That is the feasibility problem stated numerically:

1. **The input must be exact to reproduce the outcome.** The client sends
   positions and stroke counts, not aim and power — the transport has no such
   field. Verification would need a new frame carrying the exact shot parameters.
2. **The exact parameters are not recoverable from anything the client sends.**
   They are a float derived from a pointer delta, itself derived from device
   pixel coordinates and canvas geometry. Two players on different screens cannot
   produce the same float even when they intend the same shot, and a verifier
   cannot reconstruct it from a recorded path.
3. **Replaying the recorded trajectory instead proves nothing.** If the server
   accepts the client's own path as the input, it is trusting the client — which
   is what it already does.
4. **The engine is a hash-pinned third-party bundle.** Running it in the request
   path means a new dependency on code this project does not own, and the
   measurement above covers **one engine build on one host**. Whether Rapier
   produces identical floats under a different engine version or a different
   target is **not measured here**, and a verifier that disagrees by one stroke
   is worse than no verifier.

### What the measurement does settle

It replaces an assumption in [anti-cheat](anti-cheat.md) with a fact. That page
previously said a replay "is not guaranteed to produce bit-identical results"
across hosts. The measured position is narrower and more useful: **on a fixed
engine build and host, a fixed input is bit-identical even under severe timing
perturbation** — so the obstacle is input recovery and cross-engine portability,
not timing nondeterminism. The page now says that.

## What would actually be cheaper

If the goal is to make fabrication harder rather than to verify physics, the
bounded checks in [anti-cheat](anti-cheat.md) are the honest cost/benefit: a
minimum hole time against par and course length, and a monotonic `prog`. Both are
cheap, both are gameable, and neither is a claim of verification — which is why
they are documented as limitations rather than sold as a fix.

## Reproducing it

The probe needs a running service and a catalog the service can reach. It joins
as one real player, imports one real course through `/api/import`, starts the
party, and takes one real pointer stroke.

```bash
# a service with its own database
PORT=8831 BP_DB=/tmp/bp-p2.sqlite bun src/server.ts &

# one run; PROBE_OUT names the evidence file
PROBE_OUT=/tmp/p2-s1.json \
  BASE=http://127.0.0.1:8831 \
  BROWSER_SCRIPT=tests/probes/p2-determinism.mjs \
  bash tests/integration/run-browser-test.sh
```

Knobs: `PROBE_PULL` (pointer pull in CSS px), `PROBE_COURSE` (pin the course id
instead of taking the first importable one), `PROBE_THROTTLE` (CDP CPU throttle
rate), `PROBE_STALL_MS` (block the main thread mid-roll). Compare two evidence
files with any JSON tool; the arrays are plain integers.

`PROBE_THROTTLE=20` does not complete — the page never finishes loading under
that slowdown, so the probe's ceiling is between 8× and 20×. The 400 ms stall
covers the same boundary more directly, because it perturbs a single frame
instead of every frame.

The probe is **not** part of `tests/integration/run-all.sh`: it is a measurement
tool, not a pass/fail check, and it needs a service configured for it.

## Status

Studied and measured; **not implemented**, and deliberately not merged. The
finding is that the honest position in [anti-cheat](anti-cheat.md) — the server
verifies consistency, not truth — remains correct, and that closing the gap would
require a protocol change plus an engine dependency in the request path, for a
threat a private party with friends mostly does not face.
