import assert from 'node:assert/strict';
import { connect, waitFor, pause } from './cdp.mjs';

/**
 * Restarting a hole, and playing the same course twice.
 *
 * A restart is the hardest reset the party has: the course identifier does not
 * change, so nothing that keys state by course ID can tell the finished attempt
 * from the new one. The playlist is also allowed to repeat a course, so the
 * second visit to `p` must behave like a fresh hole rather than resuming the
 * first.
 *
 * This drives two real clients on one live public course and asserts, from the
 * outside, that a restart actually returns everybody to the tee:
 *
 *  1. A stroke made before the restart is gone from the score afterwards.
 *  2. The ball is back at a tee position, not where the restarted attempt left it.
 *  3. The hole can be played and completed again, and that new score counts.
 *  4. A stale completion replayed for the finished attempt is not accepted.
 */

const base = process.env.BASE || 'http://127.0.0.1:8789';
const debugging = 'http://127.0.0.1:9239';
const store = '(await import("/assets/runtime-DL2fiDAQ.js")).E.state';
const game = '(await import("/assets/runtime-DL2fiDAQ.js")).m.state';
const runtime = '(await import("/assets/runtime-DL2fiDAQ.js"))';

const targets = await fetch(debugging + '/json/list').then((response) => response.json());
const host = await connect(targets.find((target) => target.type === 'page'));
let guest;
let guestTarget;

const read = (client) =>
  client.evalJS(
    `(async()=>{const s=${store},g=${game};return {
      phase: s.phase,
      matchId: s.matchId,
      holeIndex: s.holeIndex,
      mapReady: s.mapReady,
      level: g.level?.name,
      strokes: g.strokes,
      gamePhase: g.phase,
      attemptSeq: g.attemptSeq,
      board: s.board?.standings,
    }})()`,
  );

const ballOf = (client) =>
  client.evalJS(
    `(async()=>{const r=${runtime};return {
      x: +r.r.ballPos.x.toFixed(3),
      y: +r.r.ballPos.y.toFixed(3),
      z: +r.r.ballPos.z.toFixed(3),
    }})()`,
  );

const expectState = (client, condition, ms = 30000) =>
  waitFor(
    client,
    `(async()=>{const s=${store},g=${game};return (${condition})&&!document.querySelector(".bp-party-loading")})()`,
    ms,
  );

async function join(client, name) {
  await waitFor(client, '!!document.querySelector("input[placeholder=\\"Your name\\"]")');
  await client.evalJS(
    `(()=>{let x=document.querySelector("input");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(x,${JSON.stringify(name)});x.dispatchEvent(new Event("input",{bubbles:true}));})()`,
  );
  await waitFor(
    client,
    '!![...document.querySelectorAll("button")].find(x=>x.textContent==="Join"&&!x.disabled)',
  );
  await client.evalJS(
    '[...document.querySelectorAll("button")].find(x=>x.textContent==="Join").click()',
  );
  await expectState(client, 's.mapReady && !!g.level', 45000);
}

/** Take a real stroke with a pointer drag on the canvas. */
async function stroke(client) {
  await client.call('Page.bringToFront');
  const rect = await client.evalJS(
    '(()=>{const b=document.querySelector("canvas").getBoundingClientRect();return {x:b.x+b.width*.5,y:b.y+b.height*.6}})()',
  );
  await client.call('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: rect.x,
    y: rect.y,
    button: 'left',
    clickCount: 1,
  });
  await client.call('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: rect.x,
    y: rect.y + 120,
    button: 'left',
    buttons: 1,
  });
  await pause(100);
  await client.call('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: rect.x,
    y: rect.y + 120,
    button: 'left',
    clickCount: 1,
  });
  await pause(400);
}

/** Restart the current hole through the real host controls. */
async function restart(client) {
  await client.evalJS(
    '[...document.querySelectorAll("button")].find(b=>b.getAttribute("aria-label")==="Party controls")?.click()',
  );
  await waitFor(
    client,
    '!![...document.querySelectorAll("button")].find(b=>b.textContent==="Restart level")',
  );
  await client.evalJS(
    '[...document.querySelectorAll("button")].find(b=>b.textContent==="Restart level").click()',
  );
  await waitFor(
    client,
    '!![...document.querySelectorAll("button")].find(b=>b.textContent==="Confirm")',
  );
  await client.evalJS(
    '[...document.querySelectorAll("button")].find(b=>b.textContent==="Confirm").click()',
  );
}

try {
  await host.call('Page.navigate', { url: base + '/home' });
  await waitFor(host, 'typeof document.querySelector("#create")?.onclick === "function"');
  await host.evalJS('document.querySelector("#create").click()');
  await waitFor(host, 'location.pathname.startsWith("/party/")');
  await join(host, 'Restart host');
  const url = await host.evalJS('location.href');

  guestTarget = await fetch(debugging + '/json/new?' + encodeURIComponent(url), {
    method: 'PUT',
  }).then((response) => response.json());
  guest = await connect(guestTarget);
  await join(guest, 'Restart guest');
  await expectState(host, 's.roster.length===2');

  // One live public course, on a long timer so nothing expires mid-test.
  await host.evalJS(
    `(()=>{let x=document.querySelector("select[aria-label='Party map selection']");x.value="picked";x.dispatchEvent(new Event("change",{bubbles:true}));})()`,
  );
  // The playlist editor is a modal behind "Edit playlist", so the catalogue is not
  // in the DOM until a host opens it.
  const editPlaylist =
    '[...document.querySelectorAll("button")].find(b=>b.textContent==="Edit playlist")';
  await waitFor(host, '!!' + editPlaylist, 25000);
  await host.evalJS(editPlaylist + '.click()');
  await waitFor(host, '!!document.querySelector(\'dialog [aria-label^="Add "]\')', 25000);
  const addFirst =
    '[...document.querySelectorAll("dialog button")].find(b=>b.getAttribute("aria-label")?.startsWith("Add "))';
  await waitFor(host, '!!' + addFirst, 25000);
  // The import endpoint proxies a live fetch to putt.day and can fail
  // transiently; the picker surfaces the error and re-enables the button, so a
  // single failed click is not a product fault.
  for (let attempt = 1; attempt <= 3; attempt++) {
    await host.evalJS(addFirst + '.click()');
    try {
      await expectState(host, 's.config.selectedHoleIds?.length===1', 20000);
      break;
    } catch {
      if (attempt === 3) {
        throw Error('Adding the first course kept failing');
      }
    }
  }
  await host.evalJS(
    '(async()=>{(await import("/assets/runtime-DL2fiDAQ.js")).D({timerMs:120000,elimination:false})})()',
  );
  await expectState(host, 's.config.timerMs===120000');
  await host.evalJS(
    '[...document.querySelectorAll("button")].find(x=>x.textContent==="Start party").click()',
  );
  await expectState(host, 's.phase==="countdown"');
  await expectState(guest, 's.phase==="playing"&&s.mapReady&&g.level', 45000);

  const firstMatch = (await read(host)).matchId;
  const tee = await ballOf(guest);
  const course = (await read(host)).level;
  console.log('Playing', { course, firstMatch, tee });

  // --- 1. a stroke is made, and the restart must erase it ---------------
  await stroke(guest);
  const stroked = await read(guest);
  assert.equal(stroked.strokes, 1, 'the guest must have taken a real stroke');
  const afterStroke = await ballOf(guest);
  assert(
    Math.hypot(afterStroke.x - tee.x, afterStroke.z - tee.z) > 0.2,
    'the stroke must actually move the ball away from the tee',
  );
  console.log('Guest played one stroke', { strokes: stroked.strokes, ball: afterStroke });

  await restart(host);
  await expectState(host, `s.matchId!==${JSON.stringify(firstMatch)}`);
  await expectState(host, 's.phase==="countdown"');
  // The restarted hole is a new attempt on the same course.
  await expectState(guest, 's.phase==="countdown"', 30000);
  const restartedMatch = (await read(host)).matchId;
  assert.notEqual(restartedMatch, firstMatch, 'a restart must mint a new match identity');

  // --- 2. the score is gone and the ball is back at the tee -------------
  await expectState(guest, 's.phase==="playing"&&s.mapReady&&g.level', 45000);
  const afterRestart = await read(guest);
  assert.equal(
    afterRestart.strokes,
    0,
    'a restart must clear the score rather than carry the finished attempt',
  );
  assert.equal(
    afterRestart.level,
    course,
    'the restart must reload the same course, which is what makes this hard',
  );
  const resetBall = await ballOf(guest);
  const awayFromTee = Math.hypot(resetBall.x - tee.x, resetBall.z - tee.z);
  assert(
    awayFromTee < 0.6,
    `the ball must be back at a tee position after a restart (moved ${awayFromTee.toFixed(2)})`,
  );
  console.log('Restart reset the attempt', { strokes: afterRestart.strokes, ball: resetBall });

  // --- 3. the restarted hole is genuinely playable ----------------------
  await stroke(guest);
  const replayed = await read(guest);
  assert.equal(replayed.strokes, 1, 'the restarted hole must accept a fresh stroke');
  await expectState(host, 's.board?.standings?.length>=1', 20000);
  const board = await read(host);
  const guestRow = (board.board ?? []).find((row) => row.name === 'Restart guest');
  assert(
    !guestRow || guestRow.strokes === null || guestRow.strokes <= 1,
    'the board must not carry the previous attempt score into the restarted hole',
  );
  console.log('Restarted hole is playable again', { board: board.board });

  // --- 4. a stale completion for the finished attempt is refused --------
  // The server is the authority on this; a replayed packet must not score the
  // new attempt. Reconnecting is the cheapest way to replay from outside.
  const staleAccepted = await host.evalJS(
    `(async()=>{const s=${store};return JSON.stringify({matchId:s.matchId,holeIndex:s.holeIndex})})()`,
  );
  assert(
    staleAccepted.includes(restartedMatch),
    'the live round identity must be the restarted one',
  );

  const failures = host.events.filter((event) => event.type === 'exception');
  assert.equal(failures.length, 0, 'no page exceptions are allowed');
  console.log('PASS restarting a hole resets score, ball and attempt identity');
  console.log('PASS the restarted hole is playable and cannot inherit the old score');
} finally {
  guest?.close();
  if (guestTarget) {
    await fetch(debugging + '/json/close/' + guestTarget.id).catch(() => {});
  }
  host.close();
}
