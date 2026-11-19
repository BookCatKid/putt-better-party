import assert from 'node:assert/strict';
import { connect, waitFor, pause } from './cdp.mjs';

const base = process.env.BASE || 'http://127.0.0.1:8789';
const debugging = 'http://127.0.0.1:9239';
const store = '(await import("/assets/runtime-DL2fiDAQ.js")).E.state';
const targets = await fetch(debugging + '/json/list').then((response) => response.json());
const first = await connect(targets.find((target) => target.type === 'page'));
let second;
let secondTarget;

const monitorSockets = {
  source: `
    const NativeSocket = window.WebSocket;
    window.bpPartySockets = [];
    window.WebSocket = class extends NativeSocket {
      constructor(...args) {
        super(...args);
        if (String(args[0]).includes('/ws/party/')) {
          window.bpPartySockets.push(this);
        }
      }
    };
  `,
};

async function waitForLobby(client) {
  // `.bp-lobby` is not in the built client; the lobby the pinned bundle renders
  // is the dashboard overlay inside the scene.
  await waitFor(
    client,
    '!!document.querySelector(".bp-dashboard-overlay") && !document.querySelector(".bp-party-loading")',
    30000,
  );
}

try {
  await first.call('Page.addScriptToEvaluateOnNewDocument', monitorSockets);
  await first.call('Page.navigate', { url: base + '/home' });
  await waitFor(first, 'typeof document.querySelector("#create")?.onclick === "function"');
  await first.evalJS('document.querySelector("#create").click()');
  await waitFor(first, '!!document.querySelector(".bp-name-input")');
  await first.evalJS(`
    (() => {
      const input = document.querySelector('.bp-name-input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Reconnect test');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  // The ball picker renders a "+" button ahead of Join, so selecting the first
  // button in the form clicks that instead of joining.
  const joinButton = `[...document.querySelectorAll(".bp-join-form button")].find(b => b.textContent === "Join")`;
  await waitFor(first, `!!${joinButton} && !${joinButton}.disabled`);
  await first.evalJS(`${joinButton}.click()`);
  await waitForLobby(first);
  const identity = await first.evalJS(`(async()=>({code:${store}.code, uid:${store}.self.uid}))()`);
  const credentials = await first.evalJS(
    'Object.fromEntries(Object.entries(sessionStorage).filter(([key]) => key.startsWith("bp.")))',
  );
  assert.equal(await first.evalJS('window.bpPartySockets.length'), 1);

  await first.evalJS('window.bpPartySockets.at(-1).close(1000, "Test connection interruption")');
  await waitFor(
    first,
    'document.querySelector(".bp-loading-message")?.textContent === "Reconnecting party…"',
  );
  await waitForLobby(first);
  assert.equal(await first.evalJS('window.bpPartySockets.length'), 2);
  assert.equal(await first.evalJS(`(async()=>${store}.self.uid)()`), identity.uid);
  assert.equal(await first.evalJS(`(async()=>${store}.isHost)()`), true);
  console.log('PASS transient disconnect automatically restores the same host identity');

  secondTarget = await fetch(debugging + '/json/new?about:blank', { method: 'PUT' }).then(
    (response) => response.json(),
  );
  second = await connect(secondTarget);
  await second.call('Page.addScriptToEvaluateOnNewDocument', monitorSockets);
  await second.call('Page.addScriptToEvaluateOnNewDocument', {
    source: `if (location.pathname.startsWith('/party/')) {
      for (const [key, value] of Object.entries(${JSON.stringify(credentials)})) {
        sessionStorage.setItem(key, value);
      }
    }`,
  });
  await second.call('Page.navigate', { url: base + '/party/' + identity.code });
  await waitForLobby(second);
  await waitFor(
    first,
    'document.querySelector(".bp-loading-message[role=alert]")?.textContent === "This party is open in another tab."',
  );
  // More than the initial retry interval and its next backoff interval.
  await pause(3500);
  assert.equal(await first.evalJS('window.bpPartySockets.length'), 2);
  assert.equal(await second.evalJS('window.bpPartySockets.length'), 1);
  assert.equal(await second.evalJS(`(async()=>${store}.bpConnected)()`), true);
  assert.equal(await second.evalJS(`(async()=>${store}.self.uid)()`), identity.uid);
  assert.equal(
    await first.evalJS('!!document.querySelector(".bp-party-loading a[href=\'/home\']")'),
    true,
  );
  assert.equal(
    await first.evalJS(
      '[...document.querySelectorAll(".bp-loading-action")].some(button=>button.textContent==="Reload")',
    ),
    true,
  );
  console.log(
    'PASS replacement tab stays connected; displaced tab does not reconnect or reclaim the identity',
  );

  await first.evalJS('document.querySelector(".bp-party-loading a[href=\'/home\']").click()');
  await waitFor(first, 'location.pathname === "/home"');
  assert.equal(await second.evalJS(`(async()=>${store}.bpConnected)()`), true);
  assert.equal(first.events.filter((event) => event.type === 'exception').length, 0);
  assert.equal(second.events.filter((event) => event.type === 'exception').length, 0);
  console.log('PASS displaced tab can return home without interrupting new tab');
} finally {
  second?.close();
  if (secondTarget) {
    await fetch(debugging + '/json/close/' + secondTarget.id).catch(() => {});
  }
  first.close();
}
