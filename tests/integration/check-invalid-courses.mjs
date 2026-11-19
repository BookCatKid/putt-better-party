import assert from 'node:assert/strict';
import { connect, waitFor, clickButton } from './cdp.mjs';
import { openPlaylistEditor } from './playlist-editor.mjs';

/**
 * A saved playlist with one course that no longer exists.
 *
 * One dead course used to abort the whole load, turning intact data into "your
 * playlist does not work". It must instead load what it can, name the entry that
 * failed, and leave the saved playlist exactly as it was.
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
const click = (label) => clickButton(client, label);
const ids = () => client.evalJS(`(async()=>${state}.config.selectedHoleIds)()`);
const selectPlaylist = (name) =>
  client.evalJS(`(() => {
    const select = document.querySelector('select[aria-label="Saved playlists"]');
    select.value = [...select.options].find(o => o.textContent.startsWith(${JSON.stringify(name)})).value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);

try {
  await client.call('Page.navigate', { url: base + '/home' });
  await waitFor(client, 'typeof document.querySelector("#create")?.onclick === "function"');

  // Two real public ids, and one that is well formed but does not exist upstream.
  const catalog = await fetch(base + '/api/catalog?sort=new&offset=0').then((response) =>
    response.json(),
  );
  const first = catalog.holes[0].id;
  const second = catalog.holes[1].id;
  const missing = 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz';
  const seeded = [first, missing, second];
  // Seeded before the party page mounts: the picker reads its saved list once on
  // mount, so a later write would not be seen without a reload.
  await client.evalJS(
    `localStorage.setItem('bp.playlists.v1', JSON.stringify([{ id: 'seed-playlist', name: 'Mixed', ids: ${JSON.stringify(seeded)} }]))`,
  );

  await client.evalJS('document.querySelector("#create").click()');
  await waitFor(client, '!!document.querySelector(".bp-name-input")');
  await client.evalJS(`
    (() => {
      const input = document.querySelector('.bp-name-input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Invalid test');
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

  await selectPlaylist('Mixed');
  await click('Load saved playlist');
  await waitFor(client, '!!document.querySelector(".bp-playlist-failures")');

  // 1. The two good courses load, in their original order, without the dead one.
  assert.deepEqual(await ids(), [first, second]);
  console.log('PASS an unavailable course does not stop the rest of the playlist loading');

  // 2. The failure names the entry and offers both actions.
  const panel = await client.evalJS(`(() => {
    const section = document.querySelector('.bp-playlist-failures');
    return {
      text: section.textContent,
      actions: [...section.querySelectorAll('button')].map(b => b.textContent),
    };
  })()`);
  assert.match(panel.text, /1 course could not be loaded/i);
  assert.match(panel.text, /saved playlist is unchanged/i);
  assert(panel.text.includes(missing), 'the failing id is named: ' + panel.text);
  assert.deepEqual(panel.actions.sort(), ['Remove', 'Retry']);
  console.log('PASS the failing entry is named with retry and remove offered');

  // 3. The saved playlist in storage still has all three entries.
  const stored = await client.evalJS(`JSON.parse(localStorage.getItem('bp.playlists.v1'))`);
  assert.deepEqual(stored[0].ids, seeded);
  console.log('PASS the saved playlist is not modified by loading it');

  // 4. Retry keeps the entry when it still fails, with its message intact.
  await click('Retry ' + missing);
  await waitFor(client, '!!document.querySelector(".bp-playlist-failures")');
  assert.deepEqual(await ids(), [first, second]);

  // 5. Remove forgets it for this load, and the panel goes away. Wait for the retry
  //    to settle first, or the buttons are still disabled and nothing is clicked.
  await waitFor(client, '!document.querySelector(\'button[aria-label^="Remove"]\').disabled');
  await click('Remove ' + missing);
  await waitFor(client, '!document.querySelector(".bp-playlist-failures")');
  assert.deepEqual(await ids(), [first, second]);
  console.log('PASS retry keeps a still-failing entry and remove dismisses it');

  // 6. The failure comes back on the next load, because storage was never changed.
  await click('Clear');
  await expect('s.config.selectedHoleIds.length===0');
  await click('Load saved playlist');
  await waitFor(client, '!!document.querySelector(".bp-playlist-failures")');
  assert.deepEqual(await ids(), [first, second]);
  console.log('PASS reloading still reports it, so nothing was silently discarded');

  const exceptions = client.events.filter((event) => event.type === 'exception');
  assert.equal(exceptions.length, 0, JSON.stringify(exceptions));
  console.log('PASS no page exceptions');
} finally {
  client.close();
}
