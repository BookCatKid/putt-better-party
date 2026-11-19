import assert from 'node:assert/strict';
import { connect, waitFor } from './cdp.mjs';
import { openPlaylistEditor } from './playlist-editor.mjs';

/**
 * Sharing a playlist as a versioned document.
 *
 * The document must carry public course ids and settings and nothing else - no host
 * capability, no session, no course specification - and importing one must resolve
 * the ids against the live catalogue, preserving order and deliberate duplicates
 * while refusing a document that is not one of ours.
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
const transferValue = 'document.querySelector("textarea[aria-label=\\"Playlist JSON\\"]").value';
const setTransfer = (text) =>
  client.evalJS(`
    (() => {
      const area = document.querySelector('textarea[aria-label="Playlist JSON"]');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(area, ${JSON.stringify(text)});
      area.dispatchEvent(new Event('input', { bubbles: true }));
    })()
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
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Transfer test');
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

  // Two courses, then the same course again so the document has a real duplicate.
  await client.evalJS(
    '[...document.querySelectorAll("button")].find(b=>b.getAttribute("aria-label")?.startsWith("Add ")).click()',
  );
  await expect('s.config.selectedHoleIds.length===1');
  await client.evalJS(
    '[...document.querySelectorAll("button")].filter(b=>b.getAttribute("aria-label")?.startsWith("Add "))[1].click()',
  );
  await expect('s.config.selectedHoleIds.length===2');
  await client.evalJS(
    '[...document.querySelectorAll("button")].find(b=>b.getAttribute("aria-label")?.startsWith("Add ")).click()',
  );
  await expect('s.config.selectedHoleIds.length===3');
  const original = await client.evalJS(`(async()=>${state}.config.selectedHoleIds)()`);
  assert.equal(original.length, 3);
  assert.equal(original[0], original[2], 'the third entry duplicates the first');

  // 1. Export produces a versioned document with the ids in order and nothing secret.
  await click('Export playlist');
  await waitFor(client, `${transferValue}.includes('better-party.playlist')`);
  const documentText = await client.evalJS(transferValue);
  const document = JSON.parse(documentText);
  assert.equal(document.format, 'better-party.playlist');
  assert.equal(document.version, 1);
  assert.deepEqual(document.ids, original);
  assert.equal(typeof document.settings.timerMs, 'number');
  for (const forbidden of ['host', 'session', 'token', 'spec', 'uid']) {
    assert.equal(
      JSON.stringify(document).toLowerCase().includes(`"${forbidden}`),
      false,
      'the document must not carry ' + forbidden,
    );
  }
  console.log('PASS export writes a versioned document with ordered ids and no secrets');

  // 2. Import restores the same playlist, duplicates and order intact.
  await click('Clear');
  await expect('s.config.selectedHoleIds.length===0');
  await setTransfer(documentText);
  await click('Import playlist');
  await expect('s.config.selectedHoleIds.length===3');
  assert.deepEqual(await client.evalJS(`(async()=>${state}.config.selectedHoleIds)()`), original);
  console.log('PASS import restores order and deliberate duplicates');

  // 3. A document that is not one of ours is refused with a reason and changes nothing.
  for (const [label, text, reason] of [
    ['not json', 'hello', /not valid JSON/i],
    [
      'wrong format',
      JSON.stringify({ format: 'other', version: 1, ids: [original[0]] }),
      /not a Better Party playlist/i,
    ],
    [
      'wrong version',
      JSON.stringify({ format: 'better-party.playlist', version: 99, ids: [original[0]] }),
      /different version/i,
    ],
    [
      'no ids',
      JSON.stringify({ format: 'better-party.playlist', version: 1, ids: [] }),
      /at least one course/i,
    ],
    [
      'bad id',
      JSON.stringify({ format: 'better-party.playlist', version: 1, ids: ['../etc'] }),
      // The client's own refusal, not the server's: the server also rejects this
      // id, so matching "invalid course ID" would pass without the client guard.
      /contains an invalid course ID/i,
    ],
  ]) {
    await setTransfer(text);
    await click('Import playlist');
    await waitFor(client, `${errorText}.length>0`);
    const message = await client.evalJS(errorText);
    assert.match(message, reason, label + ' -> ' + message);
    // The existing playlist is untouched by a refused import.
    assert.deepEqual(await client.evalJS(`(async()=>${state}.config.selectedHoleIds)()`), original);
  }
  console.log('PASS invalid documents are refused with a reason and change nothing');

  const exceptions = client.events.filter((event) => event.type === 'exception');
  assert.equal(exceptions.length, 0, JSON.stringify(exceptions));
  console.log('PASS no page exceptions');
} finally {
  client.close();
}
