import assert from 'node:assert/strict';
import { connect, waitFor, clickButton } from './cdp.mjs';
import { openPlaylistEditor } from './playlist-editor.mjs';

/**
 * Adding a course from a pasted link.
 *
 * The link is a convenience, not a source of truth: only its id is used, and the
 * request goes to our own `/api/import`. The test proves that by recording every
 * `fetch` the page makes while a link is added, and by checking that the course
 * actually lands in the playlist.
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
const setUrl = (text) =>
  client.evalJS(`
    (() => {
      const input = document.querySelector('input[aria-label="Course URL"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(text)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
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
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'URL test');
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

  // A real public id, taken from the live catalogue the server relays.
  const catalog = await fetch(base + '/api/catalog?sort=new&offset=0').then((response) =>
    response.json(),
  );
  const id = catalog.holes[0].id;
  assert.match(id, /^[a-zA-Z0-9_-]{5,64}$/);

  // Record every request the page makes, so a fetch to the pasted host would show.
  await client.evalJS(`
    (() => {
      window.bpRequested = [];
      const original = window.fetch;
      window.fetch = (input, options) => {
        window.bpRequested.push(typeof input === 'string' ? input : input.url);
        return original(input, options);
      };
    })()
  `);

  // 1. The official link shape is accepted and the course is added.
  await setUrl('https://putt.day/h/' + id);
  await click('Add course from URL');
  await expect('s.config.selectedHoleIds.length===1');
  assert.equal(await client.evalJS(`(async()=>${state}.config.selectedHoleIds[0])()`), id);
  const requested = await client.evalJS('window.bpRequested');
  assert(requested.includes('/api/import'), 'the import went through our own API');
  assert.equal(
    requested.some((url) => /putt\.day/.test(url)),
    false,
    'the pasted URL is never fetched: ' + JSON.stringify(requested),
  );
  console.log('PASS an official link adds the course and the URL itself is never fetched');

  // 2. A bare id, a trailing slash, a query and the www host are all accepted.
  await client.evalJS(`(() => {
    const area = document.querySelector('.bp-playlist-dialog');
    return area ? true : true;
  })()`);
  await click('Clear');
  await expect('s.config.selectedHoleIds.length===0');
  for (const variant of [
    id,
    'https://putt.day/h/' + id + '/',
    'https://putt.day/h/' + id + '?ref=share',
    'https://www.putt.day/h/' + id,
    'http://putt.day/h/' + id,
  ]) {
    await setUrl(variant);
    await click('Add course from URL');
    await expect(`s.config.selectedHoleIds.length===1`);
    await click('Clear');
    await expect('s.config.selectedHoleIds.length===0');
  }
  console.log('PASS bare ids, trailing slashes, queries and the www host are accepted');

  // 3. Anything else is refused with a reason and adds nothing.
  for (const [label, text, reason] of [
    ['other host', 'https://evil.example/h/' + id, /only putt\.day/i],
    ['wrong path', 'https://putt.day/holes/' + id, /not a public course link/i],
    ['nested path', 'https://putt.day/h/' + id + '/x', /not a public course link/i],
    ['javascript scheme', 'javascript:alert(1)', /does not look like a course link/i],
    ['credentials', 'https://user:pw@putt.day/h/' + id, /does not look like a course link/i],
    ['short id', 'https://putt.day/h/abc', /not a public course link/i],
    ['not a link', 'hello there', /does not look like a course link/i],
  ]) {
    await setUrl(text);
    await click('Add course from URL');
    await waitFor(client, `${errorText}.length>0`);
    const message = await client.evalJS(errorText);
    assert.match(message, reason, label + ' -> ' + message);
    assert.equal(await client.evalJS(`(async()=>${state}.config.selectedHoleIds.length)()`), 0);
  }
  // Still nothing was sent anywhere near the pasted hosts.
  assert.equal(
    (await client.evalJS('window.bpRequested')).some((url) => /evil\.example/.test(url)),
    false,
  );
  console.log('PASS foreign hosts and malformed links are refused without fetching them');

  const exceptions = client.events.filter((event) => event.type === 'exception');
  assert.equal(exceptions.length, 0, JSON.stringify(exceptions));
  console.log('PASS no page exceptions');
} finally {
  client.close();
}
