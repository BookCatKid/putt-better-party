import assert from 'node:assert/strict';
import { connect, waitFor, clickButton } from './cdp.mjs';
import { closePlaylistEditor, openPlaylistEditor } from './playlist-editor.mjs';

/**
 * The scorecard's DNF state, in its own browser run.
 *
 * Elimination is the one status that removes a player rather than charging them, and
 * the table must show DNF with no total. This runs as a separate suite because a
 * second party in the same browser session does not progress past its countdown in
 * the headless renderer; one party per run is stable.
 */

const base = process.env.BASE || 'http://127.0.0.1:8789';
const targets = await fetch('http://127.0.0.1:9239/json/list').then((response) => response.json());
const client = await connect(targets.find((target) => target.type === 'page'));
const state = '(await import("/assets/runtime-DL2fiDAQ.js")).E.state';
const expect = (condition, timeout = 30000) =>
  waitFor(client, `(async()=>{const s=${state};return (${condition})})()`, timeout);

const click = (label) => clickButton(client, label, { selector: 'button,a' });
try {
  await client.call('Page.navigate', { url: base + '/home' });
  await waitFor(client, 'typeof document.querySelector("#create")?.onclick === "function"');
  await client.evalJS('document.querySelector("#create").click()');
  await waitFor(client, '!!document.querySelector(".bp-name-input")');
  await client.evalJS(`
    (() => {
      const input = document.querySelector('.bp-name-input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'DNF test');
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

  // Elimination is the default, and a one-second timer ends the hole before anybody
  // can finish it, so the solo player is eliminated.
  await expect('s.config.elimination===true', 15000);
  await client.evalJS(`
    (() => {
      const input = document.querySelector('input[aria-label="Timer"]');
      input.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '1');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  await new Promise((resolve) => setTimeout(resolve, 200));
  await client.evalJS(
    'document.querySelector(\'input[aria-label="Timer"]\').dispatchEvent(new FocusEvent("focusout", { bubbles: true }))',
  );
  await expect('s.config.timerMs===1000', 15000);

  await client.call('Page.bringToFront');
  await click('Start party');
  await expect('s.phase==="final"', 45000);

  await waitFor(client, '!!document.querySelector(".bp-scorecard")', 30000);
  await click('Scorecard');
  await waitFor(client, '!!document.querySelector(".bp-scorecard table")');

  const server = await client.evalJS(`(async()=>{
    const s = ${state};
    return { history: s.roundHistory, standings: s.final.standings };
  })()`);
  const table = await client.evalJS(`(() => {
    const table = document.querySelector('.bp-scorecard table');
    const rows = [...table.querySelectorAll('tbody tr')];
    const cells = [...rows[0].children];
    const leading = (cell) => (cell.childNodes[0]?.textContent ?? '').trim();
    return {
      hole: {
        text: leading(cells[1]),
        status: cells[1].getAttribute('data-status'),
        dnf: cells[1].classList.contains('bp-dnf'),
      },
      total: leading(cells.at(-1)),
      relative: cells.at(-1).querySelector('.bp-cell-relative')?.textContent ?? null,
    };
  })()`);

  assert.deepEqual(
    server.history.map((round) => round.status),
    ['completed'],
  );
  assert.deepEqual(
    server.history[0].rows.map((row) => row.status),
    ['eliminated'],
  );
  assert.equal(table.hole.text, 'DNF');
  assert.equal(table.hole.status, 'eliminated');
  assert.equal(table.hole.dnf, true);
  assert.equal(table.total, '0');
  // No scored hole means no par faced, so there is no relative figure to show.
  assert.equal(table.relative, '');
  console.log('PASS an eliminated player renders as DNF with no total and no relative figure');

  const exceptions = client.events.filter((event) => event.type === 'exception');
  assert.equal(exceptions.length, 0, JSON.stringify(exceptions));
  console.log('PASS no page exceptions');
} finally {
  client.close();
}
