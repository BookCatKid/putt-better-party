import assert from 'node:assert/strict';
import { connect, waitFor } from './cdp.mjs';

/**
 * Home admission behaviour.
 *
 * The page is the first thing anyone touches, and every failure here looks the same
 * to the player: nothing happens. These checks drive the real page in a real
 * browser - a double submit must not create two parties, a blocked storage backend
 * must explain itself instead of hanging, and a remembered party must only be
 * offered while it still exists.
 */

const base = process.env.BASE || 'http://127.0.0.1:8789';
const targets = await fetch('http://127.0.0.1:9239/json/list').then((response) => response.json());
const client = await connect(targets.find((target) => target.type === 'page'));

const headers = { origin: base, 'content-type': 'application/json' };

/** Count admission requests across a navigation by keeping the tally in storage. */
const countRequests = `
  (() => {
    const originalFetch = window.fetch.bind(window);
    const bump = (key) => {
      const next = Number(sessionStorage.getItem(key) ?? 0) + 1;
      sessionStorage.setItem(key, String(next));
    };
    window.fetch = (input, options) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url === '/api/create') bump('bp.test.createCalls');
      if (url.startsWith('/api/room/')) bump('bp.test.roomCalls');
      return originalFetch(input, options);
    };
  })();
`;

const clearCounts = `sessionStorage.removeItem('bp.test.createCalls'); sessionStorage.removeItem('bp.test.roomCalls');`;
const readCounts = `({
  create: Number(sessionStorage.getItem('bp.test.createCalls') ?? 0),
  room: Number(sessionStorage.getItem('bp.test.roomCalls') ?? 0),
})`;

try {
  await client.call('Page.addScriptToEvaluateOnNewDocument', { source: countRequests });

  // 1. A create followed immediately by a join submit must not race a second
  //    navigation. Before the guard, both requests ran and whichever resolved last
  //    won - leaving a host key for a party the player never entered.
  await client.call('Page.navigate', { url: base + '/home' });
  await waitFor(client, 'typeof document.querySelector("#create")?.onclick === "function"');
  await client.evalJS(clearCounts);
  await client.evalJS(`
    (() => {
      // A valid code, so the submit gets past validation and actually reaches the
      // guard. requestSubmit() is no use here: it is a no-op while the submit
      // button is disabled, so it would be stopped by the attribute rather than by
      // the guard and the test would pass without exercising the guard at all.
      const input = document.querySelector('#code');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(
        input,
        'ABCDE',
      );
      document.querySelector('#create').click();
      document.querySelector('#join').dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
    })()
  `);
  await waitFor(client, 'location.pathname.startsWith("/party/")');
  const counts = await client.evalJS(readCounts);
  assert.equal(counts.create, 1, 'exactly one create request');
  assert.equal(counts.room, 0, 'the racing join must not reach the server');
  const createdPath = await client.evalJS('location.pathname');
  assert.match(createdPath, /^\/party\/[A-Z2-9]{5}$/);
  console.log('PASS a create and a racing join submit produce one navigation and one request');

  // 2. Storage that refuses writes must be explained before a party is created,
  //    not after - an orphaned room with no host is worse than a clear refusal.
  await client.call('Page.navigate', { url: base + '/home' });
  await waitFor(client, 'typeof document.querySelector("#create")?.onclick === "function"');
  await client.evalJS(clearCounts);
  await client.evalJS(`
    (() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function () { throw new Error('storage blocked'); };
      window.bpRestoreStorage = () => { Storage.prototype.setItem = original; };
    })()
  `);
  await client.evalJS('document.querySelector("#create").click()');
  await waitFor(client, 'document.querySelector("#error").textContent.includes("storage")');
  const blocked = await client.evalJS(`({
    path: location.pathname,
    message: document.querySelector('#error').textContent,
    counts: ${readCounts},
    createEnabled: !document.querySelector('#create').disabled,
    joinEnabled: !document.querySelector('#join button').disabled,
  })`);
  assert.equal(blocked.path, '/home', 'must not navigate');
  assert.equal(blocked.counts.create, 0, 'must not create an orphaned party');
  assert.match(blocked.message, /blocking site storage/i);
  // Both controls are usable again, so the player can retry in another window.
  assert.equal(blocked.createEnabled, true);
  assert.equal(blocked.joinEnabled, true);
  console.log('PASS blocked storage is explained without creating an orphaned party');

  // 3. A remembered party that no longer exists is forgotten, not re-probed on
  //    every visit and not offered as a dead link.
  await client.evalJS(`window.bpRestoreStorage(); sessionStorage.setItem('bp.lastRoom', 'ZZZZZ')`);
  await client.call('Page.navigate', { url: base + '/home' });
  await waitFor(client, 'typeof document.querySelector("#create")?.onclick === "function"');
  await waitFor(client, `sessionStorage.getItem('bp.lastRoom') === null`, 15000);
  assert.equal(
    await client.evalJS('document.querySelector("#resume").hidden'),
    true,
    'no dead resume link',
  );
  console.log('PASS an obsolete remembered party is cleared and never offered');

  // 4. A remembered party that does exist is offered and works.
  const room = await fetch(base + '/api/create', {
    method: 'POST',
    headers,
    body: '{}',
  }).then((response) => response.json());
  await client.evalJS(`sessionStorage.setItem('bp.lastRoom', ${JSON.stringify(room.code)})`);
  await client.call('Page.navigate', { url: base + '/home' });
  await waitFor(client, 'typeof document.querySelector("#create")?.onclick === "function"');
  await waitFor(client, '!document.querySelector("#resume").hidden', 15000);
  assert.match(
    await client.evalJS('document.querySelector("#resume").textContent'),
    new RegExp(room.code),
  );
  await client.evalJS('document.querySelector("#resume").click()');
  await waitFor(client, `location.pathname === "/party/${room.code}"`);
  assert.equal(
    await client.evalJS('sessionStorage.getItem("bp.lastRoom")'),
    room.code,
    'the code survives the jump',
  );
  console.log('PASS a remembered party that still exists is offered and navigates');

  const exceptions = client.events.filter((event) => event.type === 'exception');
  assert.equal(exceptions.length, 0, JSON.stringify(exceptions));
  console.log('PASS no page exceptions');
} finally {
  client.close();
}
