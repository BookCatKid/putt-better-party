import assert from 'node:assert/strict';
import { connect, waitFor } from './cdp.mjs';
import { closePlaylistEditor, openPlaylistEditor } from './playlist-editor.mjs';

/**
 * Team play in a real browser, with two players.
 *
 * Two clients join the same party, the host turns on the lobby's Team play control,
 * and both hole out. The final board must be two teams with summed scores, the
 * scorecard must show the same rows, and the CSV export must agree. The hole-outs are
 * reported with the same completion frame the client sends, so the test does not
 * depend on physics; real shots are covered by check-multiplayer-shots.
 */

const base = process.env.BASE || 'http://127.0.0.1:8789';
const debugging = 'http://127.0.0.1:9239';
const state = '(await import("/assets/runtime-DL2fiDAQ.js")).E.state';

const targets = await fetch(debugging + '/json/list').then((response) => response.json());
const host = await connect(targets.find((target) => target.type === 'page'));
const guestPage = await fetch(debugging + '/json/new?about:blank', { method: 'PUT' }).then(
  (response) => response.json(),
);
const guest = await connect(guestPage);

/** Headless Chrome freezes an occluded renderer, so each eval runs on the front tab. */
const focus = (client) => client.call('Page.bringToFront');
const on = async (client, action) => {
  await focus(client);
  return action();
};
const expectState = (client, condition, timeout = 30000) =>
  on(client, () =>
    waitFor(
      client,
      `(async()=>{const s=${state};return (${condition})&&!document.querySelector(".bp-party-loading")})()`,
      timeout,
    ),
  );

const click = (client, label) =>
  on(client, async () => {
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
  });

/** Keep each party socket so a completion frame can be sent without physics. */
const monitorSockets = {
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
    window.bpDownloads = [];
    const nativeCreate = URL.createObjectURL;
    URL.createObjectURL = (blob) => {
      const url = nativeCreate.call(URL, blob);
      window.bpPendingBlob = blob;
      return url;
    };
    const nativeClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.download && window.bpPendingBlob) {
        window.bpDownloads.push({ name: this.download, blob: window.bpPendingBlob });
        window.bpPendingBlob = null;
      }
      return nativeClick.call(this);
    };
  `,
};

async function join(client, name) {
  await on(client, () => waitFor(client, '!!document.querySelector(".bp-name-input")', 30000));
  await on(client, () =>
    client.evalJS(`
      (() => {
        const input = document.querySelector('.bp-name-input');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(name)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()
    `),
  );
  const joinButton = `[...document.querySelectorAll(".bp-join-form button")].find(b => b.textContent === "Join")`;
  await on(client, () => waitFor(client, `!!${joinButton} && !${joinButton}.disabled`));
  await on(client, () => client.evalJS(`${joinButton}.click()`));
  await on(client, () =>
    waitFor(
      client,
      '!!document.querySelector(".bp-dashboard-overlay") && !document.querySelector(".bp-party-loading")',
      60000,
    ),
  );
}

const holeOut = (client, strokes, par) =>
  on(client, () =>
    client.evalJS(
      `window.bpPartySockets.at(-1).send(JSON.stringify({ f: 1, s: ${strokes}, p: ${par} }))`,
    ),
  );

try {
  await host.call('Page.addScriptToEvaluateOnNewDocument', monitorSockets);
  await guest.call('Page.addScriptToEvaluateOnNewDocument', monitorSockets);

  // ---- Host creates the party ----
  await host.call('Page.navigate', { url: base + '/home' });
  await waitFor(host, 'typeof document.querySelector("#create")?.onclick === "function"');
  await host.evalJS('document.querySelector("#create").click()');
  await join(host, 'Team host');
  const invitation = await host.evalJS('location.href');

  // ---- Guest joins the same party ----
  await guest.call('Page.navigate', { url: invitation });
  await join(guest, 'Team guest');
  await expectState(host, 's.roster.length===2', 60000);

  // ---- Host configures: one course, team play on, no elimination ----
  await on(host, () =>
    host.evalJS(
      '(()=>{let x=document.querySelector("[aria-label=\\"Party map selection\\"]");x.value="picked";x.dispatchEvent(new Event("change",{bubbles:true}));})()',
    ),
  );
  await on(host, () => openPlaylistEditor(host));
  await waitFor(host, 'document.querySelectorAll(".bp-catalog-scroll li img").length>=24');
  await on(host, () =>
    host.evalJS(
      '[...document.querySelectorAll("button")].find(b=>b.getAttribute("aria-label")?.startsWith("Add ")).click()',
    ),
  );
  await expectState(host, 's.config.selectedHoleIds.length===1', 25000);
  await on(host, () => closePlaylistEditor(host));

  // The lobby control, not a direct store write: this proves the UI wiring.
  await on(host, () =>
    host.evalJS(`(() => {
      const box = document.querySelector('input[aria-label="Team play"]');
      if (!box.checked) {
        box.click();
      }
    })()`),
  );
  await expectState(host, 's.config.teams===true', 15000);
  await on(host, () =>
    host.evalJS(`(() => {
      const box = document.querySelector('input[aria-label="Elimination"]');
      if (box.checked) {
        box.click();
      }
    })()`),
  );
  await expectState(host, 's.config.elimination===false', 15000);

  await click(host, 'Start party');
  await expectState(host, 's.phase==="playing"&&s.mapReady', 90000);
  await expectState(guest, 's.phase==="playing"&&s.mapReady', 90000);

  // The server has formed the teams before anybody plays.
  const teams = await on(host, () => host.evalJS(`(async()=>${state}.teams)()`));
  assert.deepEqual(
    teams.map((team) => team.name),
    ['Team 1', 'Team 2'],
  );
  assert.equal(teams[0].members.length, 1);
  assert.equal(teams[1].members.length, 1);
  console.log('PASS the lobby control forms two teams in the running match');

  const par = await on(host, () => host.evalJS(`(async()=>${state}.currentMap.par)()`));
  await holeOut(host, 2, par);
  await holeOut(guest, 4, par);
  await expectState(host, 's.phase==="final"', 60000);

  // ---- The final board is two teams, not two players ----
  const board = await on(host, () => host.evalJS(`(async()=>${state}.final.standings)()`));
  assert.deepEqual(
    board.map((row) => [row.name, row.rank, row.totalStrokes]),
    [
      ['Team 1', 1, 2],
      ['Team 2', 2, 4],
    ],
  );
  console.log('PASS the final board ranks two teams by their summed scores');

  // ---- The scorecard shows the same rows ----
  await waitFor(host, '!!document.querySelector(".bp-scorecard")', 30000);
  await click(host, 'Scorecard');
  await waitFor(host, '!!document.querySelector(".bp-scorecard table")');
  const table = await on(host, () =>
    host.evalJS(`(() => {
      const rows = [...document.querySelectorAll('.bp-scorecard tbody tr')];
      const leading = (cell) => (cell.childNodes[0]?.textContent ?? '').trim();
      return rows.map((row) => {
        const cells = [...row.children];
        return {
          name: cells[0].textContent.trim(),
          hole: leading(cells[1]),
          total: leading(cells.at(-1)),
          relative: cells.at(-1).querySelector('.bp-cell-relative')?.textContent ?? null,
        };
      });
    })()`),
  );
  // The live course decides its own par, so the relative figure is derived from it
  // rather than assumed: the course used here is not a par-3.
  const relative = (strokes) => {
    const difference = strokes - par;
    if (difference === 0) {
      return 'E';
    }
    return difference > 0 ? '+' + difference : '−' + Math.abs(difference);
  };
  assert.deepEqual(table, [
    { name: 'Team 1', hole: '2', total: '2', relative: relative(2) },
    { name: 'Team 2', hole: '4', total: '4', relative: relative(4) },
  ]);
  console.log('PASS the scorecard renders team rows with the same totals');

  // ---- The export agrees with the screen ----
  await click(host, 'Export CSV');
  const csv = await on(host, () =>
    host.evalJS(`(async () => {
      const download = window.bpDownloads.at(-1);
      return download ? { name: download.name, text: await download.blob.text() } : null;
    })()`),
  );
  assert(csv, 'a CSV download happened');
  const lines = csv.text.trim().split('\r\n');
  // The CSV uses a plain minus sign, matching the on-screen figure's meaning.
  const csvRelative = (strokes) => {
    const difference = strokes - par;
    if (difference === 0) {
      return 'E';
    }
    return difference > 0 ? '+' + difference : String(difference);
  };
  assert.equal(lines.at(-2), 'Team 1,2,2,' + csvRelative(2));
  assert.equal(lines.at(-1), 'Team 2,4,4,' + csvRelative(4));
  console.log('PASS the CSV export uses the same team rows');

  const exceptions = host.events.filter((event) => event.type === 'exception');
  assert.equal(exceptions.length, 0, JSON.stringify(exceptions));
  console.log('PASS no page exceptions');
} finally {
  host.close();
  guest.close();
}
