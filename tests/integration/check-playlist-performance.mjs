import assert from 'node:assert/strict';
import { connect, waitFor } from './cdp.mjs';
import { openPlaylistEditor } from './playlist-editor.mjs';

/**
 * Saved-playlist loading should not re-fetch what it already knows.
 *
 * Loading a saved playlist used to issue one `/api/import` per unique course every
 * time, even for courses this session had already resolved. A catalogue listing and
 * a successful import are both upstream validation, so reloading the same playlist
 * should cost nothing while producing exactly the same playlist.
 */

const base = process.env.BASE || 'http://127.0.0.1:8789';
const targets = await fetch('http://127.0.0.1:9239/json/list').then((response) => response.json());
const client = await connect(targets.find((target) => target.type === 'page'));
const state = '(await import("/assets/runtime-DL2fiDAQ.js")).E.state';
const expect = (condition) =>
  waitFor(
    client,
    `(async()=>{const s=${state};return (${condition})&&!document.querySelector(".bp-party-loading")})()`,
    30000,
  );
const click = async (label) => {
  const found = await client.evalJS(
    `(()=>{const b=[...document.querySelectorAll("button")].find(b=>b.textContent===${JSON.stringify(label)}||b.getAttribute("aria-label")===${JSON.stringify(label)});if(!b||b.disabled)return null;b.scrollIntoView({block:"nearest"});const r=b.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;return {x,y,hit:b.contains(document.elementFromPoint(x,y))}})()`,
  );
  assert(found?.hit, 'Not pointer-clickable: ' + label + ' ' + JSON.stringify(found));
  for (const type of ['mousePressed', 'mouseReleased']) {
    await client.call('Input.dispatchMouseEvent', {
      type,
      x: found.x,
      y: found.y,
      button: 'left',
      clickCount: 1,
    });
  }
};

try {
  await client.call('Page.navigate', { url: base + '/home' });
  await waitFor(client, 'typeof document.querySelector("#create")?.onclick === "function"');
  await client.evalJS('document.querySelector("#create").click()');
  await waitFor(client, '!!document.querySelector(".bp-name-input")');
  await client.evalJS(`
    (() => {
      const input = document.querySelector('.bp-name-input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Playlist perf');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  const joinButton = `[...document.querySelectorAll(".bp-join-form button")].find(b => b.textContent === "Join")`;
  await waitFor(client, `!!${joinButton} && !${joinButton}.disabled`);
  await client.evalJS(`${joinButton}.click()`);
  await waitFor(
    client,
    '!!document.querySelector(".bp-dashboard-overlay") && !document.querySelector(".bp-party-loading")',
  );

  await client.evalJS(
    '(()=>{let x=document.querySelector("[aria-label=\\"Party map selection\\"]");x.value="picked";x.dispatchEvent(new Event("change",{bubbles:true}));})()',
  );
  await openPlaylistEditor(client);
  await waitFor(client, 'document.querySelectorAll(".bp-catalog-scroll li img").length>=24');

  // Two courses, chosen the same way the playlist suite does.
  await client.evalJS(
    '[...document.querySelectorAll("button")].find(b=>b.getAttribute("aria-label")?.startsWith("Add ")).click()',
  );
  await expect('s.config.selectedHoleIds.length===1');
  await client.evalJS(
    '[...document.querySelectorAll("button")].filter(b=>b.getAttribute("aria-label")?.startsWith("Add "))[1].click()',
  );
  await expect('s.config.selectedHoleIds.length===2');
  const playlist = await client.evalJS(`(async()=>${state}.config.selectedHoleIds)()`);

  await client.evalJS(
    '(()=>{let x=[...document.querySelectorAll("input")].find(x=>x.getAttribute("aria-label")==="Playlist name");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(x,"Perf");x.dispatchEvent(new Event("input",{bubbles:true}));})()',
  );
  await click('Save playlist');
  await waitFor(
    client,
    '[...document.querySelectorAll("select")].find(x=>x.getAttribute("aria-label")==="Saved playlists").options.length>1',
  );

  // From here, count the per-course imports.
  await client.evalJS(`
    (() => {
      window.bpImportCount = 0;
      const original = window.fetch;
      window.fetch = (input, options) => {
        const url = typeof input === 'string' ? input : input.url;
        if (url === '/api/import') window.bpImportCount += 1;
        return original(input, options);
      };
    })()
  `);

  // Both courses are already named from the catalogue page, so even the first load
  // needs no detail fetch.
  await click('Clear');
  await expect('s.config.selectedHoleIds.length===0');
  await click('Load saved playlist');
  await expect('s.config.selectedHoleIds.length===2');
  assert.deepEqual(await client.evalJS(`(async()=>${state}.config.selectedHoleIds)()`), playlist);
  const firstLoad = await client.evalJS('window.bpImportCount');
  assert.equal(firstLoad, 0, 'catalogue-validated courses are not re-imported');

  // And a repeat load of the same playlist costs nothing either.
  await click('Clear');
  await expect('s.config.selectedHoleIds.length===0');
  await click('Load saved playlist');
  await expect('s.config.selectedHoleIds.length===2');
  assert.deepEqual(await client.evalJS(`(async()=>${state}.config.selectedHoleIds)()`), playlist);
  assert.equal(await client.evalJS('window.bpImportCount'), 0, 'a repeat load imports nothing');

  console.log('PASS a saved playlist is not re-imported once its courses are known');
  const exceptions = client.events.filter((event) => event.type === 'exception');
  assert.equal(exceptions.length, 0, JSON.stringify(exceptions));
  console.log('PASS no page exceptions');
} finally {
  client.close();
}
