import assert from 'node:assert/strict';
import { connect, waitFor } from './cdp.mjs';

/*
 * Renderer failure: a real WebGL context loss, driven end to end.
 *
 * The upstream failure contract is preserved deliberately rather than
 * reinvented, and this suite locks each half of it:
 *
 *   webglcontextlost   - the per-surface render watchdog (CourseEventDevices)
 *                        records diagnostics, flags safe mode for the next
 *                        mount, and the canvas is covered by the snag overlay:
 *                        "Your device's graphics stopped responding…" + Reload.
 *   webglcontextrestored - in full-quality mode the client does not trust the
 *                        recovered context and reloads, so the next mount comes
 *                        up on the safe-mode quality floor instead of risking a
 *                        second crash. (In safe mode it would dismiss in place.)
 *
 * A forced loss via WEBGL_lose_context fires the same canvas events as a real
 * driver reset, so the assertions are on the rendered DOM, not the machinery.
 */

const base = process.env.BASE || 'http://127.0.0.1:8789';
const debugging = 'http://127.0.0.1:9239';
const target = (await fetch(debugging + '/json/list').then((response) => response.json())).find(
  (entry) => entry.type === 'page',
);
const client = await connect(target);
const runtime = '(await import("/assets/runtime-DL2fiDAQ.js"))';
try {
  await client.call('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await client.call('Page.navigate', { url: base + '/home' });
  await waitFor(client, 'typeof document.querySelector("#create")?.onclick==="function"');
  await client.evalJS('document.querySelector("#create").click()');
  await waitFor(client, 'document.querySelector("input")?.placeholder==="Your name"');
  await client.evalJS(
    '(()=>{const el=document.querySelector("input");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(el,"Renderer");el.dispatchEvent(new Event("input",{bubbles:true}))})()',
  );
  await client.evalJS(
    '[...document.querySelectorAll("button")].find(b=>b.textContent==="Join").click()',
  );
  // The scene must genuinely be up: a ready socket and a prepared level.
  await waitFor(
    client,
    '(async()=>{const s=' + runtime + '.E.state;return s.bpConnected&&s.bpSceneReady})()',
    60000,
  );
  await waitFor(client, '!!document.querySelector("canvas")');

  /*
   * Force the loss. The extension object must be captured first: once the
   * context is lost, getExtension returns null for everything.
   */
  await client.evalJS('window.__bpCtxMarker = 42');
  const lose = await client.evalJS(
    `(() => {
      const canvas = document.querySelector('canvas');
      const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
      const ext = gl && gl.getExtension('WEBGL_lose_context');
      if (!ext) return 'no WEBGL_lose_context';
      window.__bpLoseExt = ext;
      ext.loseContext();
      return 'lost';
    })()`,
  );
  assert.equal(lose, 'lost');

  // The snag overlay must cover the canvas with the recovery message.
  await waitFor(client, '!!document.querySelector(".absolute.inset-0.z-\\\\[70\\\\]")', 15000);
  const overlay = await client.evalJS(
    `(() => {
      const el = document.querySelector('.absolute.inset-0.z-\\\\[70\\\\]');
      return {
        title: el.querySelector('h2')?.textContent ?? '',
        body: el.querySelector('p.max-w-xs')?.textContent ?? '',
        button: el.querySelector('button')?.textContent ?? '',
      };
    })()`,
  );
  assert.equal(overlay.title, 'The hole hit a snag');
  assert.match(overlay.body, /graphics stopped responding/);
  assert.match(overlay.body, /safer graphics/);
  assert.equal(overlay.button, 'Reload');

  /*
   * Restore in full-quality mode: the client reloads rather than trust the
   * recovered context. A marker set before the loss must be gone afterwards,
   * and the reloaded page must return to the same party route.
   */
  await client.evalJS('window.__bpLoseExt.restoreContext()');
  await waitFor(client, '!(window.__bpCtxMarker ?? null)', 20000);
  assert.equal(await client.evalJS('location.pathname.startsWith("/party/")'), true);
  // The reloaded document must reach the entry/join surface, not a dead page.
  await waitFor(
    client,
    'document.querySelector("input")?.placeholder==="Your name" || !!document.querySelector(".bp-entry")',
    30000,
  );
  console.log('check-renderer-failure: ok');
} finally {
  client.close();
}
process.exit(0);
