import assert from 'node:assert/strict';
import { connect, waitFor, pause } from './cdp.mjs';
import { closePlaylistEditor, openPlaylistEditor } from './playlist-editor.mjs';

/**
 * Background simulation on a version 2 course.
 *
 * A live public course is `runtimeVersion: 2`, which swaps the per-frame physics
 * step for a fixed 1/120 s clock that is explicitly suspended while the document
 * is hidden and discards the elapsed time instead of replaying it. Two things
 * must follow, and both are visible to a party:
 *
 *  1. A hidden client stops simulating. Nothing drifts, and nothing is queued.
 *  2. Returning does not fast-forward. There is no catch-up burst of steps.
 *
 * A third behaviour is a party safety property rather than a clock property: a
 * shot being pulled when the page hides is cancelled, not fired.
 *
 * `document.hidden` is shadowed rather than the tab actually being occluded.
 * That is not a shortcut: headless Chrome freezes an occluded renderer outright,
 * so a genuinely backgrounded page cannot be measured at all — which is itself a
 * limit worth recording. The shadowed property is the same signal the production
 * clock reads, and the production `visibilitychange` listener does the suspending,
 * so the code under test is the real one.
 */

const base = process.env.BASE || 'http://127.0.0.1:8789';
const debugging = 'http://127.0.0.1:9239';
const store = '(await import("/assets/runtime-DL2fiDAQ.js")).E.state';
const game = '(await import("/assets/runtime-DL2fiDAQ.js")).m.state';
const runtime = '(await import("/assets/runtime-DL2fiDAQ.js"))';

const targets = await fetch(debugging + '/json/list').then((response) => response.json());
const page = await connect(targets.find((target) => target.type === 'page'));

/** Ball position to four decimals plus the state the clock would move. */
const read = () =>
  page.evalJS(
    `(async()=>{const s=${store},g=${game},r=${runtime};return {
      partyPhase: s.phase,
      gamePhase: g.phase,
      strokes: g.strokes,
      hidden: document.hidden,
      x: +r.r.ballPos.x.toFixed(4),
      y: +r.r.ballPos.y.toFixed(4),
      z: +r.r.ballPos.z.toFixed(4),
    }})()`,
  );

const distance = (left, right) => Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);

const hide = () =>
  page.evalJS(
    `(()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});document.dispatchEvent(new Event('visibilitychange'));})()`,
  );

const show = () =>
  page.evalJS(
    `(()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));})()`,
  );

async function join(name) {
  await waitFor(page, '!!document.querySelector("input[placeholder=\\"Your name\\"]")');
  await page.evalJS(
    `(()=>{let x=document.querySelector("input");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(x,${JSON.stringify(name)});x.dispatchEvent(new Event("input",{bubbles:true}));})()`,
  );
  await waitFor(
    page,
    '!![...document.querySelectorAll("button")].find(x=>x.textContent==="Join"&&!x.disabled)',
  );
  await page.evalJS(
    '[...document.querySelectorAll("button")].find(x=>x.textContent==="Join").click()',
  );
  await waitFor(
    page,
    `(async()=>{const s=${store},g=${game};return s.mapReady&&!!g.level})()`,
    45000,
  );
}

try {
  await page.call('Page.navigate', { url: base + '/home' });
  await waitFor(page, 'typeof document.querySelector("#create")?.onclick === "function"');
  await page.evalJS('document.querySelector("#create").click()');
  await waitFor(page, 'location.pathname.startsWith("/party/")');
  await join('Background clock');

  // A long timer keeps the hole open for the whole measurement.
  await page.evalJS(
    `(()=>{let x=document.querySelector("select[aria-label='Party map selection']");x.value="picked";x.dispatchEvent(new Event("change",{bubbles:true}));})()`,
  );
  await openPlaylistEditor(page);
  const addFirst =
    '[...document.querySelectorAll("button")].find(b=>b.getAttribute("aria-label")?.startsWith("Add "))';
  await waitFor(page, '!!' + addFirst, 25000);
  await page.evalJS(addFirst + '.click()');
  await waitFor(page, `(async()=>${store}.config.selectedHoleIds?.length===1)()`);
  await closePlaylistEditor(page);
  await page.evalJS(
    '(async()=>{(await import("/assets/runtime-DL2fiDAQ.js")).D({timerMs:120000,elimination:false})})()',
  );
  await waitFor(page, `(async()=>${store}.config.timerMs===120000)()`);
  await page.evalJS(
    '[...document.querySelectorAll("button")].find(x=>x.textContent==="Start party").click()',
  );
  await waitFor(page, `(async()=>${store}.phase==="countdown")()`);
  await waitFor(
    page,
    `(async()=>{const s=${store},g=${game};return s.phase==="playing"&&s.mapReady&&!!g.level})()`,
    45000,
  );

  const version = await page.evalJS(`(async()=>${game}.level?.runtimeVersion)()`);
  assert.equal(version, 2, 'every live public course runs the version 2 clock');

  // --- a shot in flight, then the page hides mid-drag -------------------
  const rect = await page.evalJS(
    '(()=>{const b=document.querySelector("canvas").getBoundingClientRect();return {x:b.x+b.width*.5,y:b.y+b.height*.6}})()',
  );
  await page.call('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: rect.x,
    y: rect.y,
    button: 'left',
    clickCount: 1,
  });
  await page.call('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: rect.x,
    y: rect.y + 130,
    button: 'left',
    buttons: 1,
  });
  await pause(200);
  const charging = await read();
  assert.equal(charging.gamePhase, 'charging', 'the drag must be charging before it is hidden');

  await hide();
  await pause(400);
  const cancelled = await read();
  assert.equal(cancelled.hidden, true);
  // The swing is abandoned, not released: the stroke count never moves.
  assert.equal(cancelled.gamePhase, 'aiming', 'hiding mid-drag must cancel the swing');
  assert.equal(cancelled.strokes, 0, 'a cancelled swing must not commit a stroke');
  await show();
  console.log('PASS hiding mid-drag cancels the swing instead of firing it');

  // --- a real shot, then the clock is suspended while the ball rolls ----
  await page.call('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: rect.x,
    y: rect.y,
    button: 'left',
    clickCount: 1,
  });
  await page.call('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: rect.x,
    y: rect.y + 130,
    button: 'left',
    buttons: 1,
  });
  await pause(100);
  await page.call('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: rect.x,
    y: rect.y + 130,
    button: 'left',
    clickCount: 1,
  });
  await pause(300);
  const rolling = await read();
  assert.equal(rolling.strokes, 1, 'the second drag must fire exactly one stroke');
  assert.equal(rolling.gamePhase, 'rolling');

  await hide();
  await pause(300);
  const hiddenStart = await read();
  assert.equal(hiddenStart.hidden, true);
  // Three seconds of wall clock while the world is frozen.
  await pause(3000);
  const hiddenEnd = await read();
  const hiddenDrift = distance(hiddenEnd, hiddenStart);
  assert.equal(hiddenDrift, 0, 'a hidden page must not simulate at all');
  assert.equal(hiddenEnd.strokes, 1, 'nothing is queued while hidden');
  console.log('PASS a suspended clock takes no steps and banks nothing', {
    drift: hiddenDrift,
  });

  // --- resuming must not fast-forward ----------------------------------
  await show();
  await pause(120);
  const resumedFirst = await read();
  const resumeJump = distance(resumedFirst, hiddenEnd);
  // A whole background period of catch-up would be a large jump. The clock
  // discards elapsed time, so the first frame back moves the ball by at most one
  // rendered frame of travel.
  assert(
    resumeJump < 1,
    `a resume must not replay the hidden interval (moved ${resumeJump.toFixed(3)})`,
  );
  await pause(1200);
  const resumedLater = await read();
  assert.equal(resumedLater.hidden, false);
  assert.equal(resumedLater.strokes, 1, 'the resumed shot is still the same shot');
  console.log('PASS resuming does not fast-forward the frozen interval', {
    jumpOnResume: +resumeJump.toFixed(4),
    travelAfterResume: +distance(resumedLater, resumedFirst).toFixed(4),
  });

  assert.equal(page.events.filter((event) => event.type === 'exception').length, 0);
  console.log('PASS background clock regression complete');
} finally {
  page.close();
}
