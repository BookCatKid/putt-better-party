import { connect, waitFor } from './cdp.mjs';
import assert from 'node:assert/strict';
const base = process.env.BASE || 'http://127.0.0.1:8789',
  debug = 'http://127.0.0.1:9239';
const c = await connect(
  (await fetch(debug + '/json/list').then((r) => r.json())).find((t) => t.type === 'page'),
);
const state = '(await import("/assets/runtime-DL2fiDAQ.js")).E.state';
const expect = (cond) => waitFor(c, `(async()=>{const s=${state};return (${cond})})()`, 25000);
const click = (label) =>
  c.evalJS(
    `[...document.querySelectorAll("button")].find(b=>b.textContent===${JSON.stringify(label)}||b.getAttribute("aria-label")===${JSON.stringify(label)})?.click()`,
  );
try {
  await c.call('Page.navigate', { url: base + '/home' });
  await waitFor(c, '!!document.querySelector("#create")');
  await c.evalJS('document.querySelector("#create").click()');
  await waitFor(c, '[...document.querySelectorAll("input")].some(x=>x.placeholder==="Your name")');
  await c.evalJS(
    '(()=>{let x=document.querySelector("input");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(x,"UI Test");x.dispatchEvent(new Event("input",{bubbles:true}));})()',
  );
  await waitFor(
    c,
    '[...document.querySelectorAll("button")].some(b=>b.textContent==="Join"&&!b.disabled)',
  );
  await click('Join');
  await expect('s.isHost&&s.mapReady');
  await c.evalJS(
    '(()=>{let x=document.querySelector("[aria-label=\\"Party map selection\\"]");x.value="picked";x.dispatchEvent(new Event("change",{bubbles:true}));})()',
  );
  await waitFor(c, 'document.querySelectorAll(".bp-catalog-scroll li img").length>=24');
  await waitFor(
    c,
    '[...document.querySelectorAll(".bp-catalog-scroll li img")].filter(x=>x.complete&&x.naturalWidth>0).length>=2',
  );
  const info = await c.evalJS(
    '(()=>{let el=document.querySelector(".bp-catalog-scroll li"),img=el.querySelector("img"),grid=el.parentElement;return {cards:grid.children.length,columns:getComputedStyle(grid).gridTemplateColumns,image:img.naturalWidth,aspect:getComputedStyle(img).aspectRatio,background:getComputedStyle(document.querySelector(".bp-community")).backgroundColor}})()',
  );
  console.log('PASS community cards', info);
  assert.equal(info.cards, 24);
  await c.evalJS(
    '[...document.querySelectorAll("button")].find(b=>b.getAttribute("aria-label")?.startsWith("Add ")).click()',
  );
  await expect('s.config.selectedHoleIds.length===1');
  await waitFor(c, '!!document.querySelector(".bp-playlist-item img")');
  await c.evalJS(
    '[...document.querySelectorAll("button")].find(b=>b.getAttribute("aria-label")?.startsWith("Add ")).click()',
  );
  await expect('s.config.selectedHoleIds.length===2');
  await c.evalJS(
    '(async()=>{(await import("/assets/runtime-DL2fiDAQ.js")).D({timerMs:60000,elimination:false})})()',
  );
  await expect('!s.config.elimination');
  await click('Start party');
  await expect('s.phase==="playing"&&s.mapReady');
  const rect = await c.evalJS(
    '(()=>{let a=document.querySelector(".bp-toolbar").getBoundingClientRect(),b=document.querySelector(".bp-party-status").getBoundingClientRect();return {toolbarBottom:a.bottom,statusTop:b.top}})()',
  );
  console.log('HUD bounds', rect);
  assert(rect.statusTop >= rect.toolbarBottom);
  await click('Party controls');
  await waitFor(c, '!!document.querySelector(".bp-host-panel")');
  await click('+30s');
  await expect('s.timerEndsAt-s.startAt===90000');
  console.log('PASS host time extension through UI');
  await click('Party controls');
  await click('Skip level');
  await click('Confirm');
  await expect('s.holeIndex===1');
  console.log('PASS host skip through UI');
  await expect('s.phase==="playing"');
  await click('Party controls');
  await click('End party');
  await click('Confirm');
  await expect('s.phase==="final"');
  console.log('PASS host end through UI');
} finally {
  console.log(
    'Browser errors',
    JSON.stringify(c.events.filter((e) => e.type === 'exception' || e.type === 'http').slice(-10)),
  );
  c.close();
}
