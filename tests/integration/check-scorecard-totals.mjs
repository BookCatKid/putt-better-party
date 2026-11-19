import assert from 'node:assert/strict';
import { connect, waitFor } from './cdp.mjs';
import { closePlaylistEditor, openPlaylistEditor } from './playlist-editor.mjs';

/**
 * The scorecard's numbers agree with the totals it shows.
 *
 * A timeout is the case where a penalty is applied to a score the player did not
 * earn, so it is the case where a row and a total are most likely to disagree. This
 * plays a real round that times out, then reads the rendered table: the per-hole
 * cell must equal the Total cell and the server's own `totalStrokes`, and the value
 * must be the documented `par + 5` minimum.
 */

const base = process.env.BASE || 'http://127.0.0.1:8789';
const targets = await fetch('http://127.0.0.1:9239/json/list').then((response) => response.json());
const client = await connect(targets.find((target) => target.type === 'page'));
const state = '(await import("/assets/runtime-DL2fiDAQ.js")).E.state';
const expect = (condition) =>
  waitFor(
    client,
    `(async()=>{const s=${state};return (${condition})&&!document.querySelector(".bp-party-loading")})()`,
    45000,
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

try {
  await client.call('Page.navigate', { url: base + '/home' });
  await waitFor(client, 'typeof document.querySelector("#create")?.onclick === "function"');
  await client.evalJS('document.querySelector("#create").click()');
  await waitFor(client, '!!document.querySelector(".bp-name-input")');
  await client.evalJS(`
    (() => {
      const input = document.querySelector('.bp-name-input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Penalty test');
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

  // One real public course.
  await client.evalJS(
    '(()=>{let x=document.querySelector("[aria-label=\\"Party map selection\\"]");x.value="picked";x.dispatchEvent(new Event("change",{bubbles:true}));})()',
  );
  await openPlaylistEditor(client);
  await waitFor(client, 'document.querySelectorAll(".bp-catalog-scroll li img").length>=24');
  await client.evalJS(
    '[...document.querySelectorAll("button")].find(b=>b.getAttribute("aria-label")?.startsWith("Add ")).click()',
  );
  await expect('s.config.selectedHoleIds.length===1');
  // The catalog is a modal dialog, so the lobby cannot be started behind it.
  await closePlaylistEditor(client);

  // Stroke play: with elimination on, a non-finisher is removed rather than charged,
  // and this test is about the charge.
  await client.evalJS(`
    (() => {
      const box = document.querySelector('input[aria-label="Elimination"]');
      if (box.checked) {
        box.click();
      }
    })()
  `);
  await expect('s.config.elimination===false');

  // A short round timer, so the hole really times out rather than being played.
  await client.evalJS(`
    (() => {
      const input = document.querySelector('input[aria-label="Timer"]');
      input.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '5');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  await new Promise((resolve) => setTimeout(resolve, 200));
  // React commits the draft on `focusout`, not on `blur`, and only after the draft
  // state has flushed - so both the event and the tick are required.
  await client.evalJS(
    'document.querySelector(\'input[aria-label="Timer"]\').dispatchEvent(new FocusEvent("focusout", { bubbles: true }))',
  );
  await expect('s.config.timerMs===5000');

  await click('Start party');
  // The scorecard is a section with a toggle button; the table itself only exists
  // once it has been opened.
  await waitFor(client, '!!document.querySelector(".bp-scorecard")', 60000);
  await click('Scorecard');
  await waitFor(client, '!!document.querySelector(".bp-scorecard table")');

  const table = await client.evalJS(`(() => {
    const rows = [...document.querySelectorAll('.bp-scorecard table tr')];
    const cells = (row) => [...row.children].map((cell) => cell.textContent.trim());
    // A score cell holds the number followed by a <small> time, and textContent
    // concatenates them ("15" + "0:05" = "150:05"), so read the leading text node.
    const leadingNumber = (cell) => Number((cell.childNodes[0]?.textContent ?? '').trim());
    const par = Number(cells(rows[1])[1]);
    const playerCells = rows[2].children;
    return {
      header: cells(rows[0]),
      par,
      holeScore: leadingNumber(playerCells[1]),
      total: leadingNumber(playerCells[2]),
    };
  })()`);
  const serverTotal = await client.evalJS(`(async()=>${state}.final.standings[0].totalStrokes)()`);
  const roundStatus = await client.evalJS(`(async()=>${state}.roundHistory[0].rows[0].status)()`);

  assert.equal(roundStatus, 'timeout', 'the hole really timed out');
  assert.equal(table.header[0], 'Hole');
  assert.equal(table.header.at(-1), 'Total');
  // The documented rule: the worse of the player's strokes and par + 5. Nothing was
  // played here, so it is exactly par + 5.
  assert.equal(table.holeScore, table.par + 5);
  assert.equal(table.total, table.holeScore, 'the total agrees with the hole cell');
  assert.equal(table.total, serverTotal, 'the rendered total agrees with the server');
  console.log('PASS a timed-out hole shows par + 5 in the scorecard and the same total beside it');

  const exceptions = client.events.filter((event) => event.type === 'exception');
  assert.equal(exceptions.length, 0, JSON.stringify(exceptions));
  console.log('PASS no page exceptions');
} finally {
  client.close();
}
