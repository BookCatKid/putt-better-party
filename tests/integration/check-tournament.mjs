import assert from 'node:assert/strict';
import { connect, waitFor } from './cdp.mjs';
import { closePlaylistEditor, openPlaylistEditor } from './playlist-editor.mjs';

/**
 * Tournament mode in a real browser.
 *
 * One player is enough to prove the wiring: the lobby control, the round count, the
 * progress panel on the results screen, its survival through a rematch, and the
 * finished state after the configured number of matches. The multi-player points rule
 * is pinned by `tests/tournament.test.js`, which can play several competitors without
 * a second renderer.
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

/** The tournament table as the client renders it. */
const readTable = () =>
  client.evalJS(`(() => {
    const element = document.querySelector('.bp-tournament');
    if (!element) {
      return null;
    }
    return {
      state: element.getAttribute('data-tournament-state'),
      heading: element.querySelector('.bp-tournament-heading')?.textContent ?? '',
      rows: [...element.querySelectorAll('.bp-tournament-list li')].map((row) => ({
        rank: row.querySelector('.bp-tournament-rank')?.textContent ?? '',
        name: row.querySelector('.bp-tournament-name')?.textContent ?? '',
        points: row.querySelector('.bp-tournament-points')?.textContent ?? '',
      })),
    };
  })()`);

/** Report a hole-out with the same frame the client sends when the ball is holed. */
const holeOut = async (strokes) => {
  const par = await client.evalJS(`(async()=>${state}.currentMap.par)()`);
  await client.evalJS(
    `window.bpPartySockets.at(-1).send(JSON.stringify({ f: 1, s: ${strokes}, p: ${par} }))`,
  );
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
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Tournament host');
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

  // The lobby control, not a store write: this proves the UI wiring.
  await client.evalJS(`(() => {
    const box = document.querySelector('input[aria-label="Tournament"]');
    if (!box.checked) {
      box.click();
    }
  })()`);
  await expect('s.config.tournament===true', 15000);
  await client.evalJS(`(() => {
    const select = document.querySelector('select[aria-label="Tournament rounds"]');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, '2');
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await expect('s.config.tournamentRounds===2', 15000);
  console.log('PASS the lobby controls enable a two-match tournament');

  // ---- Match 1 of 2 ----
  await click('Start party');
  await expect('s.phase==="playing"&&s.mapReady');
  await holeOut(2);
  await expect('s.phase==="final"', 60000);

  const first = await readTable();
  assert(first, 'the results screen shows the tournament table');
  assert.equal(first.state, 'running');
  assert.equal(first.heading, 'Tournament · 1 of 2 matches played');
  assert.deepEqual(first.rows, [{ rank: '1', name: 'Tournament host', points: '1 pts' }]);
  console.log('PASS the first result shows one of two matches played, with its point');

  // ---- Back to the lobby: the table survives ----
  await click('🔄 Back to lobby');
  await waitFor(
    client,
    '!!document.querySelector(".bp-dashboard-overlay") && !document.querySelector(".bp-party-loading")',
  );
  await waitFor(client, '!!document.querySelector(".bp-dashboard-tournament")');
  const lobby = await readTable();
  assert.equal(lobby.heading, 'Tournament · 1 of 2 matches played');
  assert.deepEqual(lobby.rows, [{ rank: '1', name: 'Tournament host', points: '1 pts' }]);
  console.log('PASS the lobby carries the table into the next match');

  // ---- Match 2 of 2 ----
  await click('Start party');
  await expect('s.phase==="playing"&&s.mapReady', 90000);
  await holeOut(2);
  await expect('s.phase==="final"', 60000);

  const second = await readTable();
  assert.equal(second.state, 'finished');
  assert.equal(second.heading, 'Tournament complete');
  assert.deepEqual(second.rows, [{ rank: '1', name: 'Tournament host', points: '2 pts' }]);
  console.log('PASS the tournament completes and totals the points');

  const exceptions = client.events.filter((event) => event.type === 'exception');
  assert.equal(exceptions.length, 0, JSON.stringify(exceptions));
  console.log('PASS no page exceptions');
} finally {
  client.close();
}
