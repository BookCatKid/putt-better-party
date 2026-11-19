import assert from 'node:assert/strict';
import { connect, waitFor } from './cdp.mjs';
import { closePlaylistEditor, openPlaylistEditor } from './playlist-editor.mjs';

/**
 * The upcoming-course line.
 *
 * The ready state is checked against the real playlist, and the last hole is checked
 * for the absence of a stale title. The loading and error states are checked by
 * setting the two fields the server owns (`preparing`, `nextError`) on the store the
 * server updates: the server's values for those fields are pinned by
 * `tests/upcoming.test.js`, and this proves the component renders each one.
 */

const base = process.env.BASE || 'http://127.0.0.1:8789';
const targets = await fetch('http://127.0.0.1:9239/json/list').then((response) => response.json());
const client = await connect(targets.find((target) => target.type === 'page'));
const state = '(await import("/assets/runtime-DL2fiDAQ.js")).E.state';
const expect = (condition, timeout = 30000) =>
  waitFor(
    client,
    `(async()=>{const s=${state};return (${condition})&&!document.querySelector(".bp-party-loading")})()`,
    timeout,
  );
const click = async (label) => {
  const found = await client.evalJS(
    `(()=>{const b=[...document.querySelectorAll("button,a")].find(b=>b.textContent===${JSON.stringify(label)}||b.getAttribute("aria-label")===${JSON.stringify(label)});if(!b||b.disabled)return null;b.scrollIntoView({block:"nearest"});const r=b.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;return {x,y,hit:b.contains(document.elementFromPoint(x,y))}})()`,
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
const upcoming = () =>
  client.evalJS(`(() => {
    const element = document.querySelector('.bp-upcoming');
    return element
      ? { text: element.textContent, state: element.getAttribute('data-state') }
      : null;
  })()`);
const seed = (patch) =>
  client.evalJS(
    `(async()=>{const r=await import("/assets/runtime-DL2fiDAQ.js");r.E.setState(s=>({...s, ...${JSON.stringify(patch)}}))})()`,
  );

try {
  await client.call('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      const NativeSocket = window.WebSocket;
      window.bpPartySockets = [];
      window.WebSocket = class extends NativeSocket {
        constructor(...args) {
          super(...args);
          if (String(args[0]).includes('/ws/party/')) {
            window.bpPartySockets.push(this);
          }
        }
      };
    `,
  });

  await client.call('Page.navigate', { url: base + '/home' });
  await waitFor(client, 'typeof document.querySelector("#create")?.onclick === "function"');
  await client.evalJS('document.querySelector("#create").click()');
  await waitFor(client, '!!document.querySelector(".bp-name-input")');
  await client.evalJS(`
    (() => {
      const input = document.querySelector('.bp-name-input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Upcoming test');
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
  for (let index = 0; index < 2; index += 1) {
    await client.evalJS(
      `[...document.querySelectorAll("button")].filter(b=>b.getAttribute("aria-label")?.startsWith("Add "))[${index}].click()`,
    );
    await expect(`s.config.selectedHoleIds.length===${index + 1}`, 25000);
  }
  await closePlaylistEditor(client);

  const playlist = await client.evalJS(`(async()=>{
    const s = ${state};
    return {
      ids: s.config.selectedHoleIds,
      titles: s.config.selectedHoleIds.map((id) => s.playlistTitles?.[id] ?? null),
    };
  })()`);
  assert.equal(playlist.ids.length, 2);
  const nextTitle = playlist.titles[1];
  assert(nextTitle, 'the second course has a title');

  await click('Start party');
  await expect('s.phase==="playing"&&s.mapReady');

  // 1. The ready state names the next course, not the current one.
  await waitFor(client, '!!document.querySelector(".bp-upcoming")');
  const ready = await upcoming();
  assert.equal(ready.state, 'ready');
  assert.equal(ready.text, 'Next: ' + nextTitle);
  console.log('PASS the playing HUD names the next course');

  // 2. Loading: the next course is being fetched, so a bare promise would be wrong.
  await seed({ preparing: true, nextError: null });
  await waitFor(
    client,
    'document.querySelector(".bp-upcoming")?.getAttribute("data-state")==="loading"',
  );
  const loading = await upcoming();
  assert.equal(loading.text, 'Loading next hole: ' + nextTitle + '…');
  console.log('PASS a loading next course is reported as loading');

  // 3. Error: the fetch failed, so the line must not promise the course.
  await seed({ preparing: false, nextError: 'Could not load the next public hole: boom' });
  await waitFor(
    client,
    'document.querySelector(".bp-upcoming")?.getAttribute("data-state")==="error"',
  );
  const failed = await upcoming();
  assert.equal(failed.text, 'Next hole could not load: ' + nextTitle);
  console.log('PASS a failed next course is reported as a failure');

  // 4. Back to ready, then finish the hole and check the last hole shows nothing.
  await seed({ preparing: false, nextError: null });
  await waitFor(
    client,
    'document.querySelector(".bp-upcoming")?.getAttribute("data-state")==="ready"',
  );

  const par = await client.evalJS(`(async()=>${state}.currentMap.par)()`);
  await client.evalJS(
    `window.bpPartySockets.at(-1).send(JSON.stringify({ f: 1, s: ${par}, p: ${par} }))`,
  );
  await expect('s.holeIndex===1&&s.phase==="playing"', 30000);
  // The last hole has no next course, so the previous title must not linger.
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(await upcoming(), null);
  console.log('PASS the last hole shows no upcoming course rather than a stale title');

  const exceptions = client.events.filter((event) => event.type === 'exception');
  assert.equal(exceptions.length, 0, JSON.stringify(exceptions));
  console.log('PASS no page exceptions');
} finally {
  client.close();
}
