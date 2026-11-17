import assert from 'node:assert/strict';
import { connect, waitFor } from './cdp.mjs';

const base = process.env.BASE || 'http://127.0.0.1:8789';
const targets = await fetch('http://127.0.0.1:9239/json/list').then((response) => response.json());
const client = await connect(targets.find((target) => target.type === 'page'));
const partyState = '(await import("/assets/runtime-DL2fiDAQ.js")).E.state';

async function waitForLobby() {
  await waitFor(
    client,
    '!!document.querySelector(".bp-lobby") && !document.querySelector(".bp-party-loading")',
  );
}

async function clickHome() {
  await client.evalJS('document.querySelector(".bp-party-loading a[href=\'/home\']").click()');
  await waitFor(
    client,
    'location.pathname === "/home" && typeof document.querySelector("#create")?.onclick === "function"',
  );
}

try {
  // Delay identity admission, then the initial party messages independently.
  // The live backend and original game still provide all successful responses.
  await client.call('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      if (sessionStorage.getItem('bp.test-rejoin-mode') && location.pathname.startsWith('/party/')) {
        const originalFetch = window.fetch.bind(window);
        const mode = sessionStorage.getItem('bp.test-rejoin-mode');
        window.bpAdmissionPending = false;
        window.fetch = async (input, options) => {
          if (input === '/api/join' && !window.bpAdmissionReleased) {
            window.bpAdmissionPending = true;
            await new Promise((resolve) => { window.bpReleaseAdmission = resolve; });
            window.bpAdmissionReleased = true;
            if (mode === 'fail') {
              return new Response(JSON.stringify({error: 'Test connection failure'}), {
                status: 503,
                headers: {'content-type': 'application/json'},
              });
            }
          }
          return originalFetch(input, options);
        };

        if (mode === 'success') {
          const NativeSocket = window.WebSocket;
          window.bpHeldFrames = [];
          class DelayedSocket extends NativeSocket {
            set onmessage(handler) {
              super.onmessage = (event) => {
                const message = JSON.parse(event.data);
                if (!window.bpFramesReleased && ['roster', 'board'].includes(message.t)) {
                  window.bpHeldFrames.push(() => handler.call(this, event));
                } else {
                  handler.call(this, event);
                }
              };
            }
          }
          window.WebSocket = DelayedSocket;
        }
      }
    `,
  });
  await client.call('Page.navigate', { url: base + '/home' });
  await waitFor(client, 'typeof document.querySelector("#create")?.onclick === "function"');
  await client.evalJS('document.querySelector("#create").click()');
  await waitFor(client, '!!document.querySelector(".bp-name-input")');
  await client.evalJS(`
    (() => {
      const input = document.querySelector('.bp-name-input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Rejoin test');
      input.dispatchEvent(new Event('input', {bubbles: true}));
    })()
  `);
  await waitFor(client, '!!document.querySelector(".bp-join-form button:not([disabled])")');
  await client.evalJS('document.querySelector(".bp-join-form button").click()');
  await waitForLobby();
  const originalIdentity = await client.evalJS(
    `(async()=>({code:${partyState}.code, uid:${partyState}.self.uid}))()`,
  );
  const partyUrl = base + '/party/' + originalIdentity.code;

  await client.evalJS('sessionStorage.setItem("bp.test-rejoin-mode", "success")');
  await client.call('Page.navigate', { url: partyUrl });
  await waitFor(
    client,
    'window.bpAdmissionPending && document.querySelector(".bp-loading-message")?.textContent === "Rejoining party…"',
  );
  await client.evalJS(`
    window.bpOriginalLoadingScreen = document.querySelector('.bp-party-loading');
    window.bpOriginalSpinner = document.querySelector('.bp-loading-spinner');
    window.bpOriginalHome = document.querySelector('.bp-loading-action[href="/home"]');
    void 0;
  `);
  const initialGeometry = await client.evalJS(`
    (() => {
      const [heading, spinner, message, home] = [
        '.bp-loading-wordmark', '.bp-loading-spinner-slot', '.bp-loading-message', '.bp-loading-action[href="/home"]'
      ].map(selector => document.querySelector(selector).getBoundingClientRect());
      return [heading.y, spinner.x, spinner.y, message.y, home.y];
    })()
  `);

  await client.evalJS('window.bpReleaseAdmission()');
  await waitFor(
    client,
    'window.bpHeldFrames?.length >= 2 && document.querySelector(".bp-loading-message")?.textContent === "Loading party…"',
  );
  assert.equal(
    await client.evalJS(
      'window.bpOriginalLoadingScreen === document.querySelector(".bp-party-loading")',
    ),
    true,
  );
  assert.equal(
    await client.evalJS(
      'window.bpOriginalSpinner === document.querySelector(".bp-loading-spinner")',
    ),
    true,
  );
  assert.equal(
    await client.evalJS(
      'window.bpOriginalHome === document.querySelector(".bp-loading-action[href=\'/home\']")',
    ),
    true,
  );
  const loadingGeometry = await client.evalJS(`
    (() => {
      const [heading, spinner, message, home] = [
        '.bp-loading-wordmark', '.bp-loading-spinner-slot', '.bp-loading-message', '.bp-loading-action[href="/home"]'
      ].map(selector => document.querySelector(selector).getBoundingClientRect());
      return [heading.y, spinner.x, spinner.y, message.y, home.y];
    })()
  `);
  assert.deepEqual(loadingGeometry, initialGeometry);
  await client.evalJS(
    'window.bpFramesReleased = true; window.bpHeldFrames.splice(0).forEach(release => release())',
  );
  await waitForLobby();
  assert.equal(await client.evalJS(`(async()=>${partyState}.self.uid)()`), originalIdentity.uid);
  console.log('PASS continuous rejoin/loading DOM, identical geometry and preserved identity');

  await client.evalJS('sessionStorage.setItem("bp.test-rejoin-mode", "fail")');
  await client.call('Page.navigate', { url: partyUrl });
  await waitFor(
    client,
    'window.bpAdmissionPending && !!document.querySelector(".bp-party-loading")',
  );
  await client.evalJS('window.bpReleaseAdmission()');
  await waitFor(
    client,
    'document.querySelector(".bp-loading-message[role=alert]")?.textContent === "Test connection failure"',
  );
  assert.equal(
    await client.evalJS('!!document.querySelector(".bp-party-loading a[href=\'/home\']")'),
    true,
  );
  await client.evalJS(
    '[...document.querySelectorAll(".bp-loading-action")].find(button => button.textContent === "Retry").click()',
  );
  await waitForLobby();
  assert.equal(await client.evalJS(`(async()=>${partyState}.self.uid)()`), originalIdentity.uid);
  console.log(
    'PASS admission failure stays on loading screen and retry restores original identity',
  );

  await client.evalJS('sessionStorage.setItem("bp.test-rejoin-mode", "fail")');
  await client.call('Page.navigate', { url: partyUrl });
  await waitFor(
    client,
    'window.bpAdmissionPending && !!document.querySelector(".bp-party-loading")',
  );
  await client.evalJS('window.bpReleaseAdmission()');
  await waitFor(client, '!!document.querySelector(".bp-loading-message[role=alert]")');
  await clickHome();
  assert.equal(await client.evalJS('!!document.querySelector("#create")'), true);
  console.log('PASS Back to home from a failed rejoin');

  await client.evalJS(
    `sessionStorage.removeItem("bp.test-rejoin-mode"); sessionStorage.setItem(${JSON.stringify('bp.session.' + originalIdentity.code)}, "expired-test-session")`,
  );
  await client.call('Page.navigate', { url: partyUrl });
  await waitFor(
    client,
    'document.querySelector(".bp-loading-message[role=alert]")?.textContent.includes("Session expired")',
  );
  await client.evalJS(
    '[...document.querySelectorAll(".bp-loading-action")].find(button => button.textContent === "Join again").click()',
  );
  await waitFor(
    client,
    '!!document.querySelector(".bp-name-input") && !document.querySelector(".bp-party-loading")',
  );
  assert.equal(client.events.filter((event) => event.type === 'exception').length, 0);
  console.log('PASS expired-session recovery offers a new name entry');
} finally {
  client.close();
}
