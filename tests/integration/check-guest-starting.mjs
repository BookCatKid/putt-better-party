import { connect, waitFor } from './cdp.mjs';
import assert from 'node:assert/strict';
const base = process.env.BASE || 'http://127.0.0.1:8789';
const headers = { origin: base, 'content-type': 'application/json' };
const post = async (path, data) => {
  const response = await fetch(base + path, {
    method: 'POST',
    headers,
    body: JSON.stringify(data),
  });
  const identity = await response.json();
  assert(response.ok, JSON.stringify(identity));
  return identity;
};
const room = await post('/api/create', {});
const host = await post('/api/join', { code: room.code, name: 'Host' });
const ws = new WebSocket(base.replace('http', 'ws') + '/ws/party/' + room.code, {
  headers: { origin: base },
});
const frames = [];
ws.onmessage = (event) => frames.push(JSON.parse(event.data));
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
ws.send(
  JSON.stringify({
    t: 'join',
    ...host,
    host: room.hostToken,
    protocol: 2,
    instance: 'guest-loading-test',
  }),
);
const client = await connect(
  (await fetch('http://127.0.0.1:9239/json/list').then((response) => response.json())).find(
    (pageTarget) => pageTarget.type === 'page',
  ),
);
try {
  await client.call('Page.navigate', { url: base + '/party/' + room.code });
  await waitFor(client, 'document.querySelector("input")?.placeholder==="Your name"');
  await client.evalJS(
    '(()=>{let x=document.querySelector("input");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(x,"Guest");x.dispatchEvent(new Event("input",{bubbles:true}));})()',
  );
  await waitFor(
    client,
    '[...document.querySelectorAll("button")].some(b=>b.textContent==="Join"&&!b.disabled)',
  );
  await client.evalJS(
    '[...document.querySelectorAll("button")].find(b=>b.textContent==="Join").click()',
  );
  await waitFor(client, 'document.body.innerText.includes("Waiting for the host to start")');
  await client.evalJS(
    'window.bpSawLoading=false;window.bpLoadingText="";new MutationObserver(()=>{let x=document.querySelector(".bp-guest-starting");if(x){window.bpSawLoading=true;window.bpLoadingText=x.innerText}}).observe(document.body,{childList:true,subtree:true,characterData:true})',
  );
  ws.send(JSON.stringify({ t: 'start' }));
  await waitFor(client, 'window.bpSawLoading===true', 25000);
  const loadingMessage = await client.evalJS('window.bpLoadingText');
  assert(loadingMessage.includes('The host has started the party'));
  assert(loadingMessage.includes('Loading courses'));
  console.log('PASS guest sees authoritative loading indication:', loadingMessage);
  await waitFor(
    client,
    '(async()=>{let s=(await import("/assets/runtime-DL2fiDAQ.js")).E.state;return ["countdown","playing"].includes(s.phase)&&!document.querySelector(".bp-guest-starting")})()',
    40000,
  );
  assert(
    frames.some(
      (message) => message.t === 'party' && message.phase === 'lobby' && message.preparing,
    ),
  );
  console.log('PASS loading indication disappears when game starts');
  assert.equal(client.events.filter((event) => event.type === 'exception').length, 0);
} finally {
  ws.close();
  client.close();
}
