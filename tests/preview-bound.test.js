import { test, expect } from 'bun:test';
import { preview, rememberPublicMetadata } from '../src/upstream.js';

/**
 * The preview path's waiting bound.
 *
 * `preview` fetches `/og/h/<id>` directly rather than through the paced catalog
 * queue, and limits concurrency to four. Bounding the running requests without
 * bounding the waiting ones is the half-fix that looks safe: a client asking for
 * previews faster than upstream answers would grow the waiter list without
 * limit, holding a closure and a promise for each request. This is the same
 * defect the catalog queue had before it gained a waiting limit.
 *
 * `fetch` is gated below rather than stubbed to fail, so every request past the
 * fourth is genuinely waiting at the moment the bound is asserted. The gate is
 * then opened so the test finishes instead of leaving promises pending.
 */
function gatedFetch() {
  const gates = [];
  let started = 0;
  globalThis.fetch = () => {
    started += 1;
    return new Promise((resolve) => {
      gates.push(() =>
        resolve(
          new Response(new Uint8Array([137, 80, 78, 71]), {
            headers: { 'content-type': 'image/png' },
          }),
        ),
      );
    });
  };
  return {
    get started() {
      return started;
    },
    /** Open every gate, repeatedly, until no request is left waiting. */
    async drain() {
      for (let round = 0; round < 200 && gates.length; round++) {
        for (const open of gates.splice(0)) {
          open();
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    },
  };
}

test('preview refuses to queue without limit when upstream is slow', async () => {
  const original = globalThis.fetch;
  const gate = gatedFetch();
  try {
    // Distinct ids so the cache cannot answer any of them.
    const ids = Array.from({ length: 70 }, (ignored, index) => 'gated-course-' + index);
    for (const id of ids) {
      rememberPublicMetadata(id, id);
    }
    const settled = ids.map((id) =>
      preview(id).then(
        () => ({ ok: true }),
        (error) => ({ ok: false, message: String(error?.message ?? error) }),
      ),
    );
    // Let the first four take their slots and the rest reach the waiter list.
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Four slots plus a waiting limit of 64 is the ceiling, so with seventy
    // requests some must already have been refused rather than queued.
    const early = await Promise.race([
      Promise.all(settled),
      new Promise((resolve) => setTimeout(() => resolve(null), 50)),
    ]);
    // The gated fetches cannot have completed, so only refusals have settled.
    expect(early).toBe(null);
    await gate.drain();
    const results = await Promise.all(settled);
    const refused = results.filter(
      (result) =>
        !result.ok && result.message.includes('Too many preview requests are already waiting'),
    );
    expect(refused.length).toBe(2);
    // Four running plus a waiting limit of 64 admits exactly 68 of the 70, so
    // two are refused. Pinning the number keeps the limit honest: a limit that
    // silently grew, or a bound applied to the wrong counter, changes it.
    expect(results.filter((result) => result.ok).length).toBe(68);
    // Everything admitted was fetched exactly once, so the bound is on queueing
    // rather than on reaching upstream.
    expect(gate.started).toBe(68);
  } finally {
    globalThis.fetch = original;
  }
});
