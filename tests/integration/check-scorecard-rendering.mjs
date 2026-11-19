import assert from 'node:assert/strict';
import { connect, waitFor, clickButton } from './cdp.mjs';
import { closePlaylistEditor, openPlaylistEditor } from './playlist-editor.mjs';

/**
 * The scorecard table against the server's own records.
 *
 * The table is a view of `roundHistory` and `final.standings`, so the check reads both
 * and compares every cell: course name, par, per-hole state, total, relative-to-par
 * and the standing order. A hole-out is produced by sending the same completion frame
 * the client sends when the ball is holed, so the test does not depend on physics.
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

const click = (label) => clickButton(client, label, { selector: 'button,a' });
/** The table, structured the way the scorecard builds it. */
const readTable = () =>
  client.evalJS(`(() => {
    const table = document.querySelector('.bp-scorecard table');
    const head = [...table.querySelectorAll('thead tr')];
    const body = [...table.querySelectorAll('tbody tr')];
    const leading = (cell) => (cell.childNodes[0]?.textContent ?? '').trim();
    return {
      header: [...head[0].children].map((cell) => ({
        number: cell.querySelector('span')?.textContent ?? null,
        name: cell.querySelector('.bp-hole-name')?.textContent ?? null,
      })),
      par: [...head[1].children].map((cell) => cell.textContent.trim()),
      players: body.map((row) => {
        const cells = [...row.children];
        return {
          name: cells[0].textContent.trim(),
          holes: cells.slice(1, -1).map((cell) => ({
            text: leading(cell),
            status: cell.getAttribute('data-status'),
            holed: cell.classList.contains('bp-holed'),
            flagged: !!cell.querySelector('.bp-cell-flag'),
          })),
          total: leading(cells.at(-1)),
          relative: cells.at(-1).querySelector('.bp-cell-relative')?.textContent ?? null,
        };
      }),
    };
  })()`);

const readServer = () =>
  client.evalJS(`(async()=>{
    const s = ${state};
    return { history: s.roundHistory, standings: s.final.standings };
  })()`);

const openScorecard = async () => {
  await waitFor(client, '!!document.querySelector(".bp-scorecard")', 30000);
  await click('Scorecard');
  await waitFor(client, '!!document.querySelector(".bp-scorecard table")');
};

async function createParty(name) {
  await client.call('Page.navigate', { url: base + '/home' });
  await waitFor(client, 'typeof document.querySelector("#create")?.onclick === "function"');
  await client.evalJS('document.querySelector("#create").click()');
  await waitFor(client, '!!document.querySelector(".bp-name-input")');
  await client.evalJS(`
    (() => {
      const input = document.querySelector('.bp-name-input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(name)});
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
}

async function addCourses(count) {
  await client.evalJS(
    '(()=>{let x=document.querySelector("[aria-label=\\"Party map selection\\"]");x.value="picked";x.dispatchEvent(new Event("change",{bubbles:true}));})()',
  );
  await openPlaylistEditor(client);
  await waitFor(client, 'document.querySelectorAll(".bp-catalog-scroll li img").length>=24');
  for (let index = 0; index < count; index += 1) {
    await client.evalJS(
      `[...document.querySelectorAll("button")].filter(b=>b.getAttribute("aria-label")?.startsWith("Add "))[${index}].click()`,
    );
    await expect(`s.config.selectedHoleIds.length===${index + 1}`, 25000);
  }
  await closePlaylistEditor(client);
}

try {
  // Capture the party socket so a hole-out can be reported with the same frame the
  // client sends when the ball is holed, without depending on real physics.
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

  // ---- Scenario A: a hole-out, a skipped hole and an ended party. ----
  await createParty('Scorecard test');
  await addCourses(3);
  await click('Start party');
  await expect('s.phase==="playing"&&s.mapReady');

  // Hole 1: report the same completion frame a holed ball produces.
  const par = await client.evalJS(`(async()=>${state}.currentMap.par)()`);
  await client.evalJS(
    `window.bpPartySockets.at(-1).send(JSON.stringify({ f: 1, s: ${par}, p: ${par} }))`,
  );
  await expect('s.holeIndex===1&&s.phase==="playing"', 30000);

  // Hole 2: the host skips it. The panel stays open across actions, so only open it
  // when it is closed - clicking "Party controls" again would toggle it shut.
  if (!(await client.evalJS('!!document.querySelector(".bp-host-panel")'))) {
    await click('Party controls');
  }
  await click('Skip level');
  await click('Confirm');
  await expect('s.holeIndex===2&&s.phase==="playing"', 30000);

  // Hole 3: the host ends the party without anybody holing it.
  if (!(await client.evalJS('!!document.querySelector(".bp-host-panel")'))) {
    await click('Party controls');
  }
  await click('End party');
  await click('Confirm');
  await expect('s.phase==="final"', 30000);
  await openScorecard();

  const serverA = await readServer();
  const tableA = await readTable();
  assert.deepEqual(
    serverA.history.map((round) => round.status),
    ['completed', 'skipped', 'ended'],
  );
  assert.equal(tableA.header[0].number, null);
  // Course names are visible labels, not hover-only titles.
  assert.deepEqual(
    tableA.header.slice(1, -1).map((cell) => cell.name),
    serverA.history.map((round) => round.title),
  );
  assert.deepEqual(
    tableA.header.slice(1, -1).map((cell) => cell.number),
    ['1', '2', '3'],
  );
  // Par: the server's own value per hole, and a dash for the skipped one.
  assert.deepEqual(
    tableA.par.slice(1, -1),
    serverA.history.map((round) => (round.status === 'skipped' ? '—' : String(round.par))),
  );
  // States: holed (with the score), skipped, ended.
  assert.deepEqual(
    tableA.players[0].holes.map((cell) => cell.text),
    [String(par), 'Skip', 'End'],
  );
  assert.equal(tableA.players[0].holes[0].holed, true);
  assert.equal(tableA.players[0].holes[0].flagged, false);
  // Totals and relative-to-par agree with the server.
  assert.equal(tableA.players[0].total, String(serverA.standings[0].totalStrokes));
  assert.equal(serverA.standings[0].totalStrokes, par);
  assert.equal(tableA.players[0].relative, 'E');
  // The row order is the standing order.
  assert.deepEqual(
    tableA.players.map((row) => row.name),
    serverA.standings.map((row) => row.name),
  );
  console.log('PASS holed, skipped and ended holes match the recorded rounds');

  const exceptions = client.events.filter((event) => event.type === 'exception');
  assert.equal(exceptions.length, 0, JSON.stringify(exceptions));
  console.log('PASS no page exceptions');
} finally {
  client.close();
}
