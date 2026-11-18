import assert from 'node:assert/strict';
import { connect, waitFor } from './cdp.mjs';

const base = process.env.BASE || 'http://127.0.0.1:8789';
const targets = await fetch('http://127.0.0.1:9239/json/list').then((response) => response.json());
const client = await connect(targets.find((target) => target.type === 'page'));
const store = '(await import("/assets/runtime-DL2fiDAQ.js")).E.state';

try {
  // Hold initial roster and board messages until the test releases them. The
  // native socket still connects to the real isolated Better Party backend.
  await client.call('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      const NativeSocket = window.WebSocket;
      window.bpHeldFrames = [];
      window.bpReleaseFrames = false;
      class DelayedPartySocket extends NativeSocket {
        set onmessage(handler) {
          super.onmessage = (event) => {
            let message;
            try { message = JSON.parse(event.data); } catch {}
            if (!window.bpReleaseFrames && ['roster', 'board', 'final'].includes(message?.t)) {
              window.bpHeldFrames.push(() => handler.call(this, event));
              return;
            }
            handler.call(this, event);
          };
        }
      }
      window.WebSocket = DelayedPartySocket;
      window.bpPrematureHud = false;
      function inspectFrame() {
        const hud = document.querySelector('[data-overview-hud-root]');
        if (hud && getComputedStyle(hud).visibility === 'visible' && !window.bpReleaseFrames) {
          window.bpPrematureHud = true;
        }
        requestAnimationFrame(inspectFrame);
      }
      requestAnimationFrame(inspectFrame);
    `,
  });
  await client.call('Page.navigate', { url: base + '/home' });
  await waitFor(client, 'typeof document.querySelector("#create")?.onclick === "function"');
  await client.evalJS('document.querySelector("#create").click()');
  await waitFor(client, '!!document.querySelector(".bp-name-input")');
  await client.evalJS(`
    (() => {
      const input = document.querySelector('.bp-name-input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Loading test');
      input.dispatchEvent(new Event('input', {bubbles: true}));
    })()
  `);
  await waitFor(client, '!!document.querySelector(".bp-join-form button:not([disabled])")');
  await client.evalJS('document.querySelector(".bp-join-form button").click()');

  await waitFor(
    client,
    `(async()=>${store}.bpInitialSnapshot && window.bpHeldFrames.length >= 2)()`,
  );
  await waitFor(client, `(async()=>${store}.bpSceneReady != null)()`, 30000);
  assert.equal(await client.evalJS('!!document.querySelector(".bp-party-loading")'), true);
  assert.equal(await client.evalJS('window.bpPrematureHud'), false);
  assert.equal(
    await client.evalJS(
      'getComputedStyle(document.querySelector("[data-overview-hud-root]")).visibility',
    ),
    'hidden',
  );
  assert.equal(
    await client.evalJS(
      'document.elementFromPoint(innerWidth / 2, innerHeight / 2).closest(".bp-party-loading") !== null',
    ),
    true,
  );

  await client.evalJS(
    'window.bpReleaseFrames = true; window.bpHeldFrames.splice(0).forEach(release => release())',
  );
  await waitFor(
    client,
    '!document.querySelector(".bp-party-loading") && !!document.querySelector(".bp-dashboard-overlay")',
  );
  assert.equal(
    await client.evalJS(
      'getComputedStyle(document.querySelector("[data-overview-hud-root]")).visibility',
    ),
    'visible',
  );
  assert.equal(await client.evalJS('window.bpPrematureHud'), false);
  assert.equal(client.events.filter((event) => event.type === 'exception').length, 0);
  console.log('PASS no incomplete HUD rendered while initial roster and board were delayed');
} finally {
  console.log(
    'Browser errors',
    JSON.stringify(client.events.filter((event) => event.type === 'exception')),
  );
  client.close();
}
