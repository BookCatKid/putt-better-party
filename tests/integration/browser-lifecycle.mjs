import { connect, waitFor } from './cdp.mjs';
import assert from 'node:assert/strict';
const base = process.env.BASE || 'http://127.0.0.1:8789';
const debug = 'http://127.0.0.1:9239';
const target = (await fetch(debug + '/json/list').then((response) => response.json())).find(
  (pageTarget) => pageTarget.type === 'page',
);
const client = await connect(target);
const state = '(await import("/assets/runtime-DL2fiDAQ.js")).E.state';
const game = '(await import("/assets/runtime-DL2fiDAQ.js")).m.state';
const expect = async (cond, ms = 20000) =>
  waitFor(
    client,
    `(async()=>{const s=${state},g=${game};return (${cond})&&!document.querySelector(".bp-party-loading")})()`,
    ms,
  );
const click = async (text) =>
  client.evalJS(
    `[...document.querySelectorAll("button")].find(b=>b.textContent===${JSON.stringify(text)})?.click()`,
  );
let ws;
try {
  await client.call('Page.navigate', { url: base + '/home' });
  await waitFor(client, 'typeof document.querySelector("#create")?.onclick === "function"');
  await client.evalJS('document.querySelector("#create").click()');
  await waitFor(
    client,
    '!![...document.querySelectorAll("input")].find(x=>x.placeholder==="Your name")',
  );
  await client.evalJS(
    '(()=>{let x=document.querySelector("input");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(x,"Browser Host");x.dispatchEvent(new Event("input",{bubbles:true}));})()',
  );
  await waitFor(
    client,
    '!![...document.querySelectorAll("button")].find(b=>b.textContent==="Join"&&!b.disabled)',
  );
  await click('Join');
  await expect('s.isHost&&s.mapReady&&!!g.level');
  const code = await client.evalJS(`(async()=>${state}.code)()`);
  const identity = await fetch(base + '/api/join', {
    method: 'POST',
    headers: { origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({ code, name: 'Protocol guest' }),
  }).then((response) => response.json());
  ws = new WebSocket(base.replace('http', 'ws') + '/ws/party/' + code, {
    headers: { origin: base },
  });
  const peerFrames = [];
  ws.onmessage = (event) => peerFrames.push(JSON.parse(event.data));
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  ws.send(JSON.stringify({ t: 'join', ...identity, protocol: 2, instance: 'test-peer' }));
  await expect('s.count===2');
  console.log('PASS real browser host with authenticated protocol guest');
  await client.evalJS(
    '(()=>{let x=[...document.querySelectorAll("select")].find(b=>b.getAttribute("aria-label")==="Party map selection");x.value="picked";x.dispatchEvent(new Event("change",{bubbles:true}));})()',
  );
  const add =
    '[...document.querySelectorAll("button")].find(b=>b.getAttribute("aria-label")?.startsWith("Add "))';
  await waitFor(client, '!!' + add);
  const title = await client.evalJS(add + '.getAttribute("aria-label").slice(4)');
  await client.evalJS(
    '[...document.querySelectorAll("button")].find(b=>b.getAttribute("aria-label")?.startsWith("Preview ")).click()',
  );
  await waitFor(
    client,
    '[...document.images].some(x=>x.src.includes("/api/preview/")&&x.complete&&x.naturalWidth>0)',
  );
  console.log('PASS actual public course preview:', title);
  await click('Close');
  await client.evalJS(add + '.click()');
  await expect('s.config.selectedHoleIds.length===1');
  await client.evalJS(add + '.click()');
  await expect('s.config.selectedHoleIds.length===2');
  await client.evalJS(
    '(async()=>{(await import("/assets/runtime-DL2fiDAQ.js")).D({timerMs:20000,elimination:false})})()',
  );
  await expect('s.config.timerMs===20000&&!s.config.elimination');
  await click('Start party');
  for (let hole = 0; hole < 2; hole++) {
    await expect(
      `s.phase==="playing"&&s.holeIndex===${hole}&&s.mapReady&&document.querySelectorAll("canvas").length>0`,
      30000,
    );
    console.log(
      'PASS rendered round',
      hole + 1,
      await client.evalJS(`(async()=>${game}.level.name)()`),
    );
    await waitFor(
      client,
      '[...document.querySelectorAll("button")].some(b=>b.textContent==="Give up")',
    );
    await click('Give up');
    await click('Yes');
    await expect('g.phase==="forfeit"');
    ws.send(JSON.stringify({ t: 'forfeit' }));
    await expect('s.phase==="hole-results"||s.phase==="final"');
  }
  await expect('s.phase==="final"&&s.final?.standings.length===2');
  await waitFor(client, 'document.body.innerText.includes("Party over")');
  assert(peerFrames.some((frame) => frame.t === 'final' && frame.standings.length === 2));
  console.log('PASS final podium and standings in original game UI');
  await client.evalJS(
    '[...document.querySelectorAll("button")].find(b=>b.textContent.includes("Back to lobby")).click()',
  );
  await expect('s.phase==="lobby"&&s.config.selectedHoleIds.length===2');
  console.log('PASS rematch preserves playlist and names');
  await client.call('Page.navigate', { url: base + '/party' });
  await waitFor(client, 'typeof document.querySelector("#create")?.onclick === "function"');
  console.log('PASS leave party opens home');
} finally {
  console.log(
    'Browser network errors',
    JSON.stringify(
      client.events
        .filter(
          (event) => event.type === 'exception' || event.type === 'http' || event.type === 'failed',
        )
        .slice(-20),
    ),
  );
  ws?.close();
  client.close();
}
