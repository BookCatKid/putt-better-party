import assert from 'node:assert/strict';
import { connect, waitFor, clickButton } from './cdp.mjs';
import { openPlaylistEditor } from './playlist-editor.mjs';

/**
 * Editing saved playlists.
 *
 * Renaming, duplicating and deleting are all destructive, so each is checked for
 * both halves: that the intended change happens, and that the irreversible ones
 * ask first. Storage is checked too, because a corrupt or full store is where a
 * saved list is most easily lost without anyone noticing.
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
const setName = (text) =>
  client.evalJS(`
    (() => {
      const input = document.querySelector('input[aria-label="Playlist name"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(text)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
const stored = () => client.evalJS(`JSON.parse(localStorage.getItem('bp.playlists.v1') || '[]')`);
const optionNames = () =>
  client.evalJS(`
    [...document.querySelectorAll('select[aria-label="Saved playlists"] option')]
      .map(o => o.textContent).filter(t => !t.startsWith('Saved playlists'))
  `);
const errorText = `document.querySelector('.bp-playlist-dialog [role="alert"]')?.textContent ?? ''`;

try {
  await client.call('Page.navigate', { url: base + '/home' });
  await waitFor(client, 'typeof document.querySelector("#create")?.onclick === "function"');
  await client.evalJS('document.querySelector("#create").click()');
  await waitFor(client, '!!document.querySelector(".bp-name-input")');
  await client.evalJS(`
    (() => {
      const input = document.querySelector('.bp-name-input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Edit test');
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
  await client.evalJS(
    '[...document.querySelectorAll("button")].find(b=>b.getAttribute("aria-label")?.startsWith("Add ")).click()',
  );
  await expect('s.config.selectedHoleIds.length===1');

  // 1. Save two playlists, then check the list is ordered by name rather than by
  //    when they happened to be created. Saved oldest-first on purpose: the store
  //    prepends, so insertion order here is Zebra then Apple - the reverse of the
  //    alphabetical order this asserts.
  for (const name of ['Apple', 'Zebra']) {
    await setName(name);
    await click('Save playlist');
    await waitFor(
      client,
      `[...document.querySelectorAll('select[aria-label="Saved playlists"] option')].some(o => o.textContent.startsWith(${JSON.stringify(name)}))`,
    );
  }
  assert.deepEqual(await optionNames(), ['Apple (1)', 'Zebra (1)']);
  console.log('PASS saved playlists are listed in name order');

  // 2. Saving an existing name asks before replacing it.
  await setName('Apple');
  await click('Save playlist');
  await waitFor(client, '!!document.querySelector(".bp-playlist-confirm")');
  assert.match(await client.evalJS(errorText), /already exists/i);
  await click('Cancel playlist change');
  await waitFor(client, '!document.querySelector(".bp-playlist-confirm")');
  assert.equal((await stored()).length, 2, 'a cancelled overwrite changes nothing');

  await click('Save playlist');
  await waitFor(client, '!!document.querySelector(".bp-playlist-confirm")');
  await click('Confirm playlist change');
  await waitFor(client, '!document.querySelector(".bp-playlist-confirm")');
  assert.deepEqual(await optionNames(), ['Apple (1)', 'Zebra (1)'], 'no duplicate created');
  console.log('PASS an existing name asks before replacing it');

  // 3. Rename the selected playlist.
  await client.evalJS(`(() => {
    const select = document.querySelector('select[aria-label="Saved playlists"]');
    select.value = [...select.options].find(o => o.textContent.startsWith('Zebra')).value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await setName('Zulu');
  await click('Rename saved playlist');
  await waitFor(
    client,
    `[...document.querySelectorAll('select[aria-label="Saved playlists"] option')].some(o => o.textContent.startsWith('Zulu'))`,
  );
  assert.deepEqual(await optionNames(), ['Apple (1)', 'Zulu (1)']);
  console.log('PASS a saved playlist can be renamed');

  // 4. Duplicate it; the copy gets a distinct name and keeps the ids.
  await click('Duplicate saved playlist');
  await waitFor(
    client,
    `[...document.querySelectorAll('select[aria-label="Saved playlists"] option')].filter(o => o.textContent.startsWith('Zulu')).length===2`,
  );
  const duplicates = (await stored()).filter((playlist) => playlist.name.startsWith('Zulu'));
  assert.equal(duplicates.length, 2);
  assert.deepEqual(duplicates[0].ids, duplicates[1].ids);
  assert.notEqual(duplicates[0].id, duplicates[1].id);
  console.log('PASS a saved playlist can be duplicated');

  // 5. Delete asks first, and a cancel keeps it.
  await click('Delete saved playlist');
  await waitFor(client, '!!document.querySelector(".bp-playlist-confirm")');
  assert.match(await client.evalJS(errorText), /cannot be undone/i);
  await click('Cancel playlist change');
  await waitFor(client, '!document.querySelector(".bp-playlist-confirm")');
  assert.equal((await stored()).length, 3, 'a cancelled delete keeps the playlist');
  await click('Delete saved playlist');
  await waitFor(client, '!!document.querySelector(".bp-playlist-confirm")');
  await click('Confirm playlist change');
  await waitFor(client, '!document.querySelector(".bp-playlist-confirm")');
  assert.equal((await stored()).length, 2, 'the confirmed delete removed exactly one');
  console.log('PASS deleting asks first and then removes exactly one');

  // 6. A corrupt entry is reported and left in place rather than wiped.
  await client.evalJS(`
    (() => {
      const list = JSON.parse(localStorage.getItem('bp.playlists.v1') || '[]');
      localStorage.setItem('bp.playlists.v1', JSON.stringify([...list, { name: 'Broken', ids: 'nope' }]));
    })()
  `);
  await client.call('Page.reload');
  await waitFor(
    client,
    '!!document.querySelector(".bp-dashboard-overlay") && !document.querySelector(".bp-party-loading")',
  );
  await openPlaylistEditor(client);
  await waitFor(client, 'document.querySelectorAll(".bp-catalog-scroll li img").length>=24');
  const problem = await client.evalJS(
    `document.querySelector('.bp-playlist-dialog [role="status"]')?.textContent ?? ''`,
  );
  assert.match(problem, /could not be read/i);
  const afterCorrupt = await stored();
  assert.equal(afterCorrupt.length, 3, 'the unreadable entry is left in place');
  assert.equal(
    afterCorrupt.some((entry) => entry.name === 'Broken'),
    true,
  );
  console.log('PASS an unreadable entry is reported and left in place');

  // 7. A full store fails loudly and keeps the existing list.
  const beforeQuota = (await stored()).length;
  await client.evalJS(`
    (() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key === 'bp.playlists.v1') {
          const error = new Error('quota');
          error.name = 'QuotaExceededError';
          throw error;
        }
        return original.call(this, key, value);
      };
      window.bpRestoreStorage = () => { Storage.prototype.setItem = original; };
    })()
  `);
  await setName('NoRoom');
  await click('Save playlist');
  await waitFor(client, `${errorText}.length>0`);
  assert.match(await client.evalJS(errorText), /no room left/i);
  assert.equal((await stored()).length, beforeQuota, 'a refused write keeps the list');
  await client.evalJS('window.bpRestoreStorage()');
  console.log('PASS a full store fails loudly and keeps the existing list');

  const exceptions = client.events.filter((event) => event.type === 'exception');
  assert.equal(exceptions.length, 0, JSON.stringify(exceptions));
  console.log('PASS no page exceptions');
} finally {
  client.close();
}
