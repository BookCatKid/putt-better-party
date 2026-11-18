import assert from 'node:assert/strict';
import { connect, waitFor } from './cdp.mjs';

const base = process.env.BASE || 'http://127.0.0.1:8789';
const password = process.env.BP_TEST_ADMIN_PASSWORD;
assert(password, 'Set BP_TEST_ADMIN_PASSWORD for the isolated admin-enabled server');
const headers = { origin: base, 'content-type': 'application/json' };
const post = async (path, body) => {
  const response = await fetch(base + path, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  assert(response.ok, String(response.status));
  return response.json();
};
const room = await post('/api/create', {});
const name = '<img src=x onerror=alert(1)>';
const identity = await post('/api/join', { code: room.code, name: name.slice(0, 24) });
const host = new WebSocket(base.replace('http', 'ws') + '/ws/party/' + room.code, {
  headers: { origin: base },
});
await new Promise((resolve, reject) => {
  host.onopen = resolve;
  host.onerror = reject;
});
host.send(
  JSON.stringify({
    t: 'join',
    ...identity,
    host: room.hostToken,
    protocol: 2,
    instance: 'admin-test',
  }),
);
const client = await connect(
  (await fetch('http://127.0.0.1:9239/json/list').then((response) => response.json())).find(
    (target) => target.type === 'page',
  ),
);
try {
  assert.equal((await fetch(base + '/api/admin/status')).status, 401);
  await client.call('Page.navigate', { url: base + '/admin' });
  await waitFor(client, '!document.getElementById("unlock")?.hidden');
  const login = (value) =>
    client.evalJS(
      `(()=>{document.getElementById("password").value=${JSON.stringify(value)};document.getElementById("login").requestSubmit()})()`,
    );
  await login('incorrect');
  await waitFor(
    client,
    'document.getElementById("login-error").innerText.includes("Incorrect password")',
  );
  assert.equal(await client.evalJS('document.getElementById("dashboard").hidden'), true);
  await login(password);
  await waitFor(
    client,
    '!document.getElementById("dashboard")?.hidden && document.getElementById("rooms").innerText.includes(' +
      JSON.stringify(room.code) +
      ')',
  );
  await client.evalJS('document.querySelector(".admin-room summary").click()');
  await waitFor(
    client,
    'document.querySelector(".admin-room[open]")?.innerText.includes(' +
      JSON.stringify(identity.name) +
      ')',
  );
  assert.equal(await client.evalJS('document.querySelectorAll("#rooms img").length'), 0);
  assert.equal(await client.evalJS('document.getElementById("password").value'), '');
  assert.equal(await client.evalJS('document.cookie.includes("bp_admin=")'), false);
  await client.evalJS(
    'document.getElementById("filter").value="player joined";document.getElementById("filter").dispatchEvent(new Event("input"))',
  );
  await client.call('Page.reload');
  await waitFor(client, '!document.getElementById("dashboard")?.hidden');
  await client.evalJS('document.getElementById("logout").click()');
  await waitFor(
    client,
    '!document.getElementById("unlock")?.hidden && document.getElementById("dashboard").hidden',
  );
  assert.equal(await client.evalJS('(async()=> (await fetch("/api/admin/status")).status)()'), 401);
  assert.equal(await client.evalJS('document.getElementById("rooms").textContent'), '');
  assert.equal(client.events.filter((event) => event.type === 'exception').length, 0);
  console.log(
    'PASS admin unlock, wrong password, live room rendering, safe player names, session reload, logout and access revocation',
  );
} finally {
  host.close();
  client.close();
}
