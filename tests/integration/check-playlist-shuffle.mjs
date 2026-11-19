import assert from 'node:assert/strict';
import { connect, waitFor } from './cdp.mjs';
import { openPlaylistEditor } from './playlist-editor.mjs';

/**
 * Shuffling the picked order.
 *
 * Shuffle is only safe if it is a *permutation*: the same courses, the same number
 * of each, in a different order. A shuffle that deduplicated would silently change
 * the playlist, which is why the multiset is asserted on every attempt rather than
 * just the length.
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
const ids = () => client.evalJS(`(async()=>${state}.config.selectedHoleIds)()`);
const addCard = (index) =>
  client.evalJS(
    `[...document.querySelectorAll("button")].filter(b=>b.getAttribute("aria-label")?.startsWith("Add "))[${index}].click()`,
  );

try {
  await client.call('Page.navigate', { url: base + '/home' });
  await waitFor(client, 'typeof document.querySelector("#create")?.onclick === "function"');
  await client.evalJS('document.querySelector("#create").click()');
  await waitFor(client, '!!document.querySelector(".bp-name-input")');
  await client.evalJS(`
    (() => {
      const input = document.querySelector('.bp-name-input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Shuffle test');
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

  // Four distinct courses, then the first one twice more: six entries whose
  // multiset has a course repeated three times.
  for (let index = 0; index < 4; index += 1) {
    await addCard(index);
    await expect(`s.config.selectedHoleIds.length===${index + 1}`);
  }
  await addCard(0);
  await expect('s.config.selectedHoleIds.length===5');
  await addCard(0);
  await expect('s.config.selectedHoleIds.length===6');

  const original = await ids();
  assert.equal(original.length, 6);
  const multiset = (list) => [...list].sort().join(',');
  assert.equal(
    original.filter((id) => id === original[0]).length,
    3,
    'the first course is deliberately repeated three times',
  );

  // Shuffle up to three times. A single shuffle may legitimately reproduce the
  // same order, so the assertion is that shuffling *can* change it; every attempt
  // must still be a permutation.
  const orders = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await click('Shuffle playlist order');
    await new Promise((resolve) => setTimeout(resolve, 300));
    const next = await ids();
    assert.equal(next.length, original.length, 'shuffle does not change the length');
    assert.equal(multiset(next), multiset(original), 'shuffle keeps the same courses');
    orders.push(next.join(','));
  }
  assert.equal(
    orders.some((order) => order !== original.join(',')),
    true,
    'at least one shuffle changed the order: ' + JSON.stringify({ original, orders }),
  );
  console.log('PASS shuffle permutes the order and keeps every course and duplicate');

  const exceptions = client.events.filter((event) => event.type === 'exception');
  assert.equal(exceptions.length, 0, JSON.stringify(exceptions));
  console.log('PASS no page exceptions');
} finally {
  client.close();
}
