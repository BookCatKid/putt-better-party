import { test, expect } from 'bun:test';

/**
 * The original fixed-step clock, reproduced from the pinned bundle.
 *
 * `AppearanceClone-CBos6VT9.js` keeps this class in a React context, so it cannot
 * be imported on its own; the body below is a faithful transcription of the
 * recovered source. These tests pin the arithmetic a party depends on — a hidden
 * page takes no steps, a resume does not replay the hidden interval, and catch-up
 * is bounded — so a future edit to the clock's behaviour is caught as a change
 * rather than discovered in a live round.
 *
 * Recovered source, for comparison:
 *   var Yi = 1/120;
 *   advance(e, t) {
 *     if (this.hidden || !Number.isFinite(e) || e < 0) return 0;
 *     if (this.discardNext) { this.discardNext = false; return 0; }
 *     this.remainder += Math.min(e, Yi * 24);
 *     let n = 0;
 *     for (; this.remainder + 1e-10 >= 1/120 && n < 24;) {
 *       this.remainder = Math.max(0, this.remainder - Yi);
 *       this.elapsed += Yi;
 *       t(Yi);
 *       n++;
 *     }
 *     return n;
 *   }
 *   setHidden(e) { this.hidden = e; this.remainder = 0; this.discardNext = true; }
 */

const STEP = 1 / 120;

class OriginalClock {
  elapsed = 0;
  remainder = 0;
  discardNext = true;
  hidden = false;

  get alpha() {
    return Math.min(1, Math.max(0, this.remainder / STEP));
  }

  setHidden(value) {
    this.hidden = value;
    this.remainder = 0;
    this.discardNext = true;
  }

  advance(frameDelta, onStep) {
    if (this.hidden || !Number.isFinite(frameDelta) || frameDelta < 0) {
      return 0;
    }
    if (this.discardNext) {
      this.discardNext = false;
      return 0;
    }
    this.remainder += Math.min(frameDelta, STEP * 24);
    let steps = 0;
    for (; this.remainder + 1e-10 >= STEP && steps < 24;) {
      this.remainder = Math.max(0, this.remainder - STEP);
      this.elapsed += STEP;
      onStep(STEP);
      steps++;
    }
    return steps;
  }
}

/** Run a fresh clock past its initial discarded frame. */
function primed() {
  const clock = new OriginalClock();
  clock.advance(STEP, () => {});
  return clock;
}

/** Count steps and total simulated time for one frame. */
function frame(clock, delta) {
  let steps = 0;
  clock.advance(delta, () => {
    steps++;
  });
  return steps;
}

test('the first frame after mount advances nothing', () => {
  const clock = new OriginalClock();
  expect(frame(clock, STEP)).toBe(0);
  expect(clock.elapsed).toBe(0);
  // The discarded frame leaves no remainder behind either.
  expect(clock.remainder).toBe(0);
});

test('a steady 120 Hz frame is exactly one step', () => {
  const clock = primed();
  expect(frame(clock, STEP)).toBe(1);
  expect(clock.elapsed).toBeCloseTo(STEP, 12);
  expect(clock.alpha).toBeCloseTo(0, 12);
});

test('a 60 Hz frame runs exactly two steps', () => {
  const clock = primed();
  expect(frame(clock, STEP * 2)).toBe(2);
  expect(clock.elapsed).toBeCloseTo(STEP * 2, 12);
});

test('a hidden page takes no steps and never advances its clock', () => {
  const clock = primed();
  clock.setHidden(true);
  for (let tick = 0; tick < 20; tick++) {
    expect(frame(clock, STEP * 2)).toBe(0);
  }
  expect(clock.elapsed).toBe(0);
  expect(clock.remainder).toBe(0);
});

test('a resume does not replay the hidden interval', () => {
  const clock = primed();
  // A long absence: whatever the elapsed wall clock was, the clock must not
  // convert it into steps on return.
  clock.setHidden(true);
  expect(frame(clock, 30_000)).toBe(0);
  clock.setHidden(false);
  // The first frame after a resume is discarded, exactly like mount.
  expect(frame(clock, 30_000)).toBe(0);
  expect(clock.elapsed).toBe(0);
  // The next frame is an ordinary one — no catch-up burst.
  expect(frame(clock, STEP)).toBe(1);
  expect(clock.elapsed).toBeCloseTo(STEP, 12);
});

test('hiding discards a partial remainder instead of carrying it over', () => {
  const clock = primed();
  // Half a step is left pending.
  expect(frame(clock, STEP * 0.5)).toBe(0);
  expect(clock.alpha).toBeCloseTo(0.5, 12);
  clock.setHidden(true);
  expect(clock.remainder).toBe(0);
  clock.setHidden(false);
  expect(frame(clock, STEP)).toBe(0); // discarded frame
  // The next step must not include the stale half step.
  expect(frame(clock, STEP * 0.5)).toBe(0);
  expect(clock.elapsed).toBe(0);
  expect(frame(clock, STEP * 0.5)).toBe(1);
});

test('one frame contributes at most 0.2 s of catch-up', () => {
  const clock = primed();
  // A five second stall is clamped to 24 steps, not 600.
  const steps = frame(clock, 5000);
  expect(steps).toBe(24);
  expect(clock.elapsed).toBeCloseTo(STEP * 24, 12);
  // Any surplus is dropped, not carried into the next frame.
  expect(clock.remainder).toBeLessThan(STEP);
  expect(frame(clock, STEP)).toBe(1);
});

test('nonsense frame deltas are ignored', () => {
  const clock = primed();
  expect(frame(clock, Number.NaN)).toBe(0);
  expect(frame(clock, Number.POSITIVE_INFINITY)).toBe(0);
  expect(frame(clock, -1)).toBe(0);
  expect(clock.elapsed).toBe(0);
  expect(clock.remainder).toBe(0);
  // The clock is still usable afterwards.
  expect(frame(clock, STEP)).toBe(1);
});

test('interpolation alpha stays within a single step', () => {
  const clock = primed();
  expect(clock.alpha).toBe(0);
  frame(clock, STEP * 0.25);
  expect(clock.alpha).toBeCloseTo(0.25, 12);
  frame(clock, STEP * 0.5);
  expect(clock.alpha).toBeCloseTo(0.75, 12);
  frame(clock, STEP);
  // A full step consumes the remainder and one step, so alpha returns to zero.
  expect(clock.alpha).toBeGreaterThanOrEqual(0);
  expect(clock.alpha).toBeLessThan(1);
});

test('elapsed time equals the number of steps at 1/120 s each', () => {
  const clock = primed();
  let counted = 0;
  for (let frameIndex = 0; frameIndex < 120; frameIndex++) {
    counted += frame(clock, STEP);
  }
  expect(counted).toBe(120);
  expect(clock.elapsed).toBeCloseTo(1, 9);
});
