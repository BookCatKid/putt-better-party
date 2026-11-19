import { connect, waitFor } from './cdp.mjs';
import { closePlaylistEditor, openPlaylistEditor } from './playlist-editor.mjs';
import assert from 'node:assert/strict';
const base = process.env.BASE || 'http://127.0.0.1:8789';
const debug = 'http://127.0.0.1:9239';
const client = await connect(
  (await fetch(debug + '/json/list').then((response) => response.json())).find(
    (target) => target.type === 'page',
  ),
);
const state = '(await import("/assets/runtime-DL2fiDAQ.js")).E.state';
const expect = (cond) =>
  waitFor(
    client,
    `(async()=>{const s=${state};return (${cond})&&!document.querySelector(".bp-party-loading")})()`,
    25000,
  );
const click = async (label) => {
  const response = await client.evalJS(
    `(()=>{const b=[...document.querySelectorAll("button")].find(b=>b.textContent===${JSON.stringify(label)}||b.getAttribute("aria-label")===${JSON.stringify(label)});if(!b||b.disabled)return null;b.scrollIntoView({block:"nearest"});const r=b.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;return {x,y,hit:b.contains(document.elementFromPoint(x,y))}})()`,
  );
  assert(response?.hit, 'Not pointer-clickable: ' + label + ' ' + JSON.stringify(response));
  await client.call('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: response.x,
    y: response.y,
    button: 'left',
    clickCount: 1,
  });
  await client.call('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: response.x,
    y: response.y,
    button: 'left',
    clickCount: 1,
  });
};
const game = '(await import("/assets/runtime-DL2fiDAQ.js")).m.state';
const read = () =>
  client.evalJS(
    `(async()=>{let s=${state},g=${game};return {matchId:s.matchId,holeIndex:s.holeIndex,name:g.level?.name,attempt:g.attemptSeq,strokes:g.strokes,ends:s.timerEndsAt,connected:s.bpConnected,phase:s.phase,levelId:g.level?.id}})()`,
  );
try {
  await client.call('Page.navigate', { url: base + '/home' });
  await waitFor(client, 'typeof document.querySelector("#create")?.onclick === "function"');
  await client.evalJS('document.querySelector("#create").click()');
  await waitFor(
    client,
    '[...document.querySelectorAll("input")].some(x=>x.placeholder==="Your name")',
  );
  await client.evalJS(
    '(()=>{let x=document.querySelector("input");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(x,"UI Test");x.dispatchEvent(new Event("input",{bubbles:true}));})()',
  );
  await waitFor(
    client,
    '[...document.querySelectorAll("button")].some(b=>b.textContent==="Join"&&!b.disabled)',
  );
  await click('Join');
  await expect('s.isHost&&s.mapReady');
  await client.evalJS(
    '(()=>{let x=document.querySelector("[aria-label=\\"Party map selection\\"]");x.value="picked";x.dispatchEvent(new Event("change",{bubbles:true}));})()',
  );
  await openPlaylistEditor(client);
  await waitFor(client, 'document.querySelectorAll(".bp-catalog-scroll li img").length>=24');
  await waitFor(
    client,
    '[...document.querySelectorAll(".bp-catalog-scroll li img")].filter(x=>x.complete&&x.naturalWidth>0).length>=2',
  );
  const info = await client.evalJS(
    '(()=>{let el=document.querySelector(".bp-catalog-scroll li"),img=el.querySelector("img"),grid=el.parentElement;return {cards:grid.children.length,columns:getComputedStyle(grid).gridTemplateColumns,image:img.naturalWidth,aspect:getComputedStyle(img).aspectRatio,background:getComputedStyle(document.querySelector(".bp-community")).backgroundColor}})()',
  );
  console.log('PASS community cards', info);
  assert.equal(info.cards, 24);
  await client.evalJS(
    '[...document.querySelectorAll("button")].find(b=>b.getAttribute("aria-label")?.startsWith("Add ")).click()',
  );
  await expect('s.config.selectedHoleIds.length===1');
  await waitFor(client, '!!document.querySelector(".bp-playlist-item img")');
  await client.evalJS(
    '[...document.querySelectorAll("button")].filter(b=>b.getAttribute("aria-label")?.startsWith("Add "))[1].click()',
  );
  await expect('s.config.selectedHoleIds.length===2');
  await client.evalJS(
    '(async()=>{(await import("/assets/runtime-DL2fiDAQ.js")).D({timerMs:60000,elimination:false})})()',
  );
  await expect('!s.config.elimination');
  await closePlaylistEditor(client);
  await click('Start party');
  await expect('s.phase==="playing"&&s.mapReady');
  const rect = await client.evalJS(
    '(()=>{let a=document.querySelector(".bp-toolbar").getBoundingClientRect(),b=document.querySelector(".bp-party-status").getBoundingClientRect();return {toolbarBottom:a.bottom,statusTop:b.top}})()',
  );
  console.log('HUD bounds', rect);
  assert(rect.statusTop >= rect.toolbarBottom);
  const before = await read();
  if (!(await client.evalJS('!!document.querySelector(".bp-host-panel")'))) {
    await click('Party controls');
  }
  await waitFor(client, '!!document.querySelector(".bp-host-panel")');
  const groups = await client.evalJS(
    '[...document.querySelectorAll(".bp-host-section h4")].map(heading=>heading.textContent)',
  );
  assert.deepEqual(groups, ['Players', 'Current hole', 'Upcoming holes', 'Match']);
  assert.equal(
    await client.evalJS(
      'document.querySelector(".bp-host-panel").textContent.includes("Make someone else host")',
    ),
    false,
  );
  await client.call('Emulation.setDeviceMetricsOverride', {
    width: 375,
    height: 667,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const timerBounds = await client.evalJS(
    '(()=>{const input=document.querySelector("#bp-future-hole-time");input.scrollIntoView({block:"nearest"});const rect=input.getBoundingClientRect();return {width:rect.width,left:rect.left,right:rect.right,viewport:innerWidth}})()',
  );
  assert(
    timerBounds.width >= 110 && timerBounds.left >= 0 && timerBounds.right <= timerBounds.viewport,
    JSON.stringify(timerBounds),
  );
  await client.evalJS(
    '(()=>{const input=document.querySelector("#bp-future-hole-time");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,"86400");input.dispatchEvent(new Event("input",{bubbles:true}));})()',
  );
  await click('Set');
  await expect('s.config.timerMs===86400000&&!!document.querySelector(".bp-host-panel")');
  await client.evalJS(
    '(()=>{const input=document.querySelector("#bp-future-hole-time");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,"60");input.dispatchEvent(new Event("input",{bubbles:true}));})()',
  );
  await click('Set');
  await expect('s.config.timerMs===60000&&!!document.querySelector(".bp-host-panel")');
  console.log('PASS full-width timer field at 375px and repeated changes', timerBounds);
  await click('+30s');
  await expect('s.timerEndsAt-s.startAt===90000&&!!document.querySelector(".bp-host-panel")');
  const added = await read();
  assert(added.ends - before.ends >= 29500);
  console.log('PASS pointer-based add time', before.ends, added.ends);
  if (!(await client.evalJS('!!document.querySelector(".bp-host-panel")'))) {
    await click('Party controls');
  }
  await click('Restart level');
  await click('Confirm');
  await expect(
    's.matchId!==' +
      JSON.stringify(before.matchId) +
      '&&s.phase==="playing"&&s.mapReady&&!!document.querySelector(".bp-host-panel")',
  );
  const restarted = await read();
  assert.equal(restarted.holeIndex, before.holeIndex);
  assert.equal(restarted.name, before.name);
  assert(restarted.attempt > before.attempt);
  assert.equal(restarted.strokes, 0);
  console.log('PASS pointer-based restart with real game attempt reset', before, restarted);
  if (!(await client.evalJS('!!document.querySelector(".bp-host-panel")'))) {
    await click('Party controls');
  }
  await click('Skip level');
  await click('Confirm');
  await expect(
    's.holeIndex===1&&s.phase==="playing"&&s.mapReady&&!!document.querySelector(".bp-host-panel")',
  );
  const skipped = await read();
  assert.notEqual(skipped.name, before.name);
  assert(skipped.attempt > restarted.attempt);
  console.log('PASS pointer-based skip loaded different map', skipped);
  if (!(await client.evalJS('!!document.querySelector(".bp-host-panel")'))) {
    await click('Party controls');
  }
  await click('End party');
  await click('Confirm');
  await expect('s.phase==="final"');
  console.log('PASS pointer-based end');
} finally {
  console.log(
    'Browser errors',
    JSON.stringify(
      client.events
        .filter((event) => event.type === 'exception' || event.type === 'http')
        .slice(-10),
    ),
  );
  client.close();
}
