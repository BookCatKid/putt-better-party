import assert from 'node:assert/strict';
import { connect, waitFor } from './cdp.mjs';
import { closePlaylistEditor, openPlaylistEditor } from './playlist-editor.mjs';

/**
 * Completed-match history in the lobby.
 *
 * A finished match is summarised on the server, survives the rematch, and is shown in
 * the lobby as a compact list. The hole-out is reported with the same completion frame
 * the client sends, so the test does not depend on physics.
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
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'History host');
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
  await expect('s.config.selectedHoleIds.length===1', 25000);
  await closePlaylistEditor(client);

  await click('Start party');
  await expect('s.phase==="playing"&&s.mapReady');
  const par = await client.evalJS(`(async()=>${state}.currentMap.par)()`);
  await client.evalJS(
    `window.bpPartySockets.at(-1).send(JSON.stringify({ f: 1, s: ${par}, p: ${par} }))`,
  );
  await expect('s.phase==="final"', 30000);

  // 1. The server recorded the match before the final snapshot.
  const recorded = await client.evalJS(`(async()=>{
    const s = ${state};
    return {
      history: s.matchHistory,
      standings: s.final.standings,
    };
  })()`);
  assert.equal(recorded.history.length, 1);
  assert.equal(recorded.history[0].holes, 1);
  assert.equal(recorded.history[0].courses.length, 1);
  assert.equal(recorded.history[0].courses[0].par, par);
  assert.equal(recorded.history[0].standings[0].name, 'History host');
  assert.equal(recorded.history[0].standings[0].totalStrokes, recorded.standings[0].totalStrokes);
  // The summary carries a name and a score, not a credential.
  for (const row of recorded.history[0].standings) {
    assert.deepEqual(Object.keys(row).sort(), [
      'holesSurvived',
      'name',
      'rank',
      'totalStrokes',
      'totalTimeMs',
    ]);
  }
  console.log('PASS the finished match is recorded with its course, par and scores');

  // 2. A rematch keeps it and clears only the current match.
  await click('🔄 Back to lobby');
  await waitFor(
    client,
    '!!document.querySelector(".bp-dashboard-overlay") && !document.querySelector(".bp-party-loading")',
  );
  await expect('s.roundHistory.length===0');
  assert.equal(await client.evalJS(`(async()=>${state}.matchHistory.length)()`), 1);
  console.log('PASS a rematch keeps the completed match and clears the current rounds');

  // 3. The lobby shows it as a compact list, with the score and the hole count.
  await waitFor(client, '!!document.querySelector(".bp-dashboard-history")');
  const panel = await client.evalJS(`(() => {
    const element = document.querySelector('.bp-dashboard-history');
    return {
      heading: element.querySelector('h3')?.textContent ?? '',
      items: [...element.querySelectorAll('.bp-match-history li')].map((li) => ({
        meta: li.querySelector('.bp-match-history-meta')?.textContent ?? '',
        score: li.querySelector('.bp-match-history-score')?.textContent ?? '',
      })),
    };
  })()`);
  assert.equal(panel.heading, 'Recent matches');
  assert.equal(panel.items.length, 1);
  assert.match(panel.items[0].meta, /1 hole$/);
  assert.equal(panel.items[0].score, 'History host ' + recorded.standings[0].totalStrokes);
  console.log('PASS the lobby lists the completed match with its score and hole count');

  const exceptions = client.events.filter((event) => event.type === 'exception');
  assert.equal(exceptions.length, 0, JSON.stringify(exceptions));
  console.log('PASS no page exceptions');
} finally {
  client.close();
}
