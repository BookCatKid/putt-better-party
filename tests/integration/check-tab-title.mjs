import { connect, waitFor, clickButton } from './cdp.mjs';
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
const click = (label) => clickButton(client, label);
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
  assert.match(await client.evalJS('document.title'), /^Party [A-Z2-9]{5} · Better Party$/);
  await closePlaylistEditor(client);
  await click('Start party');
  await expect('s.phase==="playing"&&s.mapReady');
  const title = await client.evalJS('document.title');
  console.log('PASS gameplay title:', title);
  assert(title.includes('Hole 1/1 · Better Party'));
  assert(!title.includes('Local'));
  await click('Party controls');
  await click('End party');
  await click('Confirm');
  await expect('s.phase==="final"');
  await waitFor(client, 'document.title==="Results · Better Party"');
  console.log('PASS results title');
} finally {
  console.log(
    'Browser errors',
    JSON.stringify(client.events.filter((event) => event.type === 'exception')),
  );
  client.close();
}
