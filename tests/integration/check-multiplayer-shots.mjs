import assert from 'node:assert/strict';
import { connect, waitFor, pause } from './cdp.mjs';

/**
 * Multiplayer actual shots.
 *
 * Other party regressions drive one player at a time, or finish a round with a
 * synthetic completion frame. This one has two real original-client browsers
 * taking real pointer strokes on a live public course, and asserts the resulting
 * physics and scores from the outside:
 *
 *  1. Both clients hold independent balls at the same tee. A stroke by one does
 *     not move or score the other: multiplayer physics really is per-client.
 *  2. A real pointer drag holes out, so the score comes from actual simulated
 *     physics rather than a synthetic `f:1` frame.
 *  3. The round ends only once *both* players are done, one by holing out and one
 *     by forfeiting - simultaneous completion with mixed outcomes.
 *  4. The forfeit and the hole out are scored differently on the final board, and
 *     the final board carries both players.
 *
 * Deliberately not covered here, with reasons rather than silence:
 *  - Water and moving obstacles. The live catalog only exposes them on large
 *    themed courses ("Tightrope", "the broken back world"), and driving two WebGL
 *    clients through a *second* level load stalls this headless harness for
 *    minutes - a renderer limitation that reproduces in control runs, not a game
 *    regression. Their handling is covered offline in tests/room.test.js and
 *    tests/transport.test.js instead.
 *  - A repeated course identifier and a mid-round restart. Both are covered for
 *    real in tests/integration/check-restart.mjs, which exists precisely because a
 *    restart keeps the course identifier.
 */

const base = process.env.BASE || 'http://127.0.0.1:8789';
const debugging = 'http://127.0.0.1:9239';
const store = '(await import("/assets/runtime-DL2fiDAQ.js")).E.state';
const game = '(await import("/assets/runtime-DL2fiDAQ.js")).m.state';
const runtime = '(await import("/assets/runtime-DL2fiDAQ.js"))';
/** A short, unthemed public course: it loads fast and is a straight putt. */
const COURSE = 'hole in one';
/** Pulling down launches the ball up-course, where the cup sits from the tee. */
const PULL_DOWN_PX = 120;

const targets = await fetch(debugging + '/json/list').then((response) => response.json());
const host = await connect(targets.find((target) => target.type === 'page'));
const guestPage = await fetch(debugging + '/json/new?about:blank', { method: 'PUT' }).then(
  (response) => response.json(),
);
const guest = await connect(guestPage);

/**
 * Headless Chrome freezes an occluded renderer outright, so every evaluation has
 * to happen on the frontmost tab. The two clients therefore take turns: touch
 * one, it becomes frontmost, then the other. Nothing here needs both rendering at
 * the same instant.
 */
const focus = (client) => client.call('Page.bringToFront');
const focusThen = async (client, action) => {
  await focus(client);
  return action();
};

const stateOf = (client) =>
  focusThen(client, () =>
    client.evalJS(`(async()=>{
      const party=${store};
      const state=${game};
      const scene=${runtime};
      return {
        phase: party.phase,
        holeIndex: party.holeIndex,
        matchId: party.matchId,
        mapReady: party.mapReady,
        level: state.level?.name,
        strokes: state.strokes,
        gamePhase: state.phase,
        attemptSeq: state.attemptSeq,
        ball: {
          x: +scene.r.ballPos.x.toFixed(2),
          y: +scene.r.ballPos.y.toFixed(2),
          z: +scene.r.ballPos.z.toFixed(2),
        },
        final: party.final?.standings ?? null,
      };
    })()`),
  );

const expectState = (client, condition, ms = 40000) =>
  focusThen(client, () =>
    waitFor(
      client,
      `(async()=>{const s=${store};const g=${game};return (${condition})&&!document.querySelector(".bp-party-loading")})()`,
      ms,
    ),
  );

async function join(client, name) {
  await focus(client);
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
  await expectState(client, 's.mapReady && !!g.level', 60000);
}

/** Pull back and release through the original pointer handlers. No state injection. */
async function stroke(client, pullDown = PULL_DOWN_PX) {
  await focus(client);
  await pause(120);
  const origin = await client.evalJS(
    '(()=>{const b=document.querySelector("canvas").getBoundingClientRect();return {x:b.x+b.width*.5,y:b.y+b.height*.6}})()',
  );
  await client.call('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: origin.x,
    y: origin.y,
    button: 'left',
    clickCount: 1,
  });
  await client.call('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: origin.x,
    y: origin.y + pullDown,
    button: 'left',
    buttons: 1,
  });
  await pause(120);
  await client.call('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: origin.x,
    y: origin.y + pullDown,
    button: 'left',
    clickCount: 1,
  });
}

/** Pick the live public course through the real picker, then start the party. */
async function startOneCourseParty(client) {
  await focus(client);
  await waitFor(
    client,
    '!!document.querySelector("select[aria-label=\\"Party map selection\\"]")',
    30000,
  );
  await client.evalJS(
    `(()=>{let x=document.querySelector("select[aria-label='Party map selection']");x.value="picked";x.dispatchEvent(new Event("change",{bubbles:true}));})()`,
  );
  /*
   * Open the playlist editor the way a host does. It is a modal dialog behind
   * "Edit playlist", so the catalogue is not in the DOM until it opens and waiting
   * for the search field first would never resolve.
   */
  await waitFor(
    client,
    '!![...document.querySelectorAll("button")].find(b=>b.textContent==="Edit playlist")',
    30000,
  );
  await client.evalJS(
    '[...document.querySelectorAll("button")].find(b=>b.textContent==="Edit playlist").click()',
  );
  /*
   * Search for the course instead of assuming it is on the first catalog page.
   * The live catalog is a moving list, so a course that was on page one can drift
   * off it between runs and this test would then fail for a reason with nothing to
   * do with the code under test.
   */
  await waitFor(
    client,
    '!!document.querySelector("input[aria-label=\\"Find party holes\\"]")',
    30000,
  );
  await client.evalJS(`(()=>{
    const input=document.querySelector('input[aria-label="Find party holes"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(COURSE)});
    input.dispatchEvent(new Event('input',{bubbles:true}));
  })()`);
  await waitFor(
    client,
    '!![...document.querySelectorAll("button")].find(b=>b.getAttribute("aria-label")?.startsWith("Add "))',
    45000,
  );
  const added = await client.evalJS(`(()=>{
    const button=[...document.querySelectorAll("button")].find(
      b=>b.getAttribute("aria-label")===${JSON.stringify('Add ' + COURSE)},
    );
    if(!button){return false;}
    button.click();
    return true;
  })()`);
  assert(added, 'searching the live catalog must still find the ' + COURSE + ' course');
  await expectState(client, 's.config.selectedHoleIds?.length===1');
  const ids = await client.evalJS(
    `(async()=>{const s=${store};return s.config.selectedHoleIds})()`,
  );
  assert.deepEqual(ids.length, 1, 'the playlist must hold exactly the one course');
  // Close the modal so the host controls underneath are reachable again.
  await client.evalJS(`(()=>{
    const done=[...document.querySelectorAll("dialog button")].find(b=>b.textContent==="Done");
    if(done){done.click();}
  })()`);
  await waitFor(client, '!document.querySelector(\'input[aria-label="Find party holes"]\')', 15000);
  await client.evalJS(
    '(async()=>{(await import("/assets/runtime-DL2fiDAQ.js")).D({timerMs:180000,elimination:false})})()',
  );
  await expectState(client, 's.config.timerMs===180000');
  await client.evalJS(
    '[...document.querySelectorAll("button")].find(x=>x.textContent==="Start party").click()',
  );
}

/** Use the original Give up control, including its confirmation step. */
async function giveUp(client) {
  await focus(client);
  await waitFor(
    client,
    '!![...document.querySelectorAll("button")].find(x=>x.textContent==="Give up")',
    15000,
  );
  await client.evalJS(
    '[...document.querySelectorAll("button")].find(x=>x.textContent==="Give up").click()',
  );
  await waitFor(
    client,
    '!![...document.querySelectorAll("button")].find(x=>x.textContent==="Yes")',
  );
  await client.evalJS(
    '[...document.querySelectorAll("button")].find(x=>x.textContent==="Yes").click()',
  );
}

try {
  await host.call('Page.navigate', { url: base + '/home' });
  await waitFor(host, 'typeof document.querySelector("#create")?.onclick === "function"');
  await host.evalJS('document.querySelector("#create").click()');
  await waitFor(host, 'location.pathname.startsWith("/party/")');
  await join(host, 'Shots host');
  const url = await host.evalJS('location.href');

  await guest.call('Page.navigate', { url });
  await join(guest, 'Shots guest');
  await expectState(host, 's.roster.length===2');

  await startOneCourseParty(host);
  await expectState(guest, 's.phase==="playing"&&s.mapReady&&g.level', 90000);
  await expectState(host, 's.phase==="playing"&&s.mapReady&&g.level', 90000);

  const opening = { host: await stateOf(host), guest: await stateOf(guest) };
  assert.equal(opening.host.level, COURSE, 'the host must be playing the live course');
  assert.equal(opening.guest.level, COURSE, 'the guest must be playing the same course');
  assert.equal(opening.host.strokes, 0, 'the host starts the round with no strokes');
  assert.equal(opening.guest.strokes, 0, 'the guest starts the round with no strokes');
  assert.equal(opening.host.gamePhase, 'aiming', 'the host must be ready to strike');
  assert.equal(opening.guest.gamePhase, 'aiming', 'the guest must be ready to strike');
  const teeSeparation = Math.hypot(
    opening.host.ball.x - opening.guest.ball.x,
    opening.host.ball.z - opening.guest.ball.z,
  );
  assert(teeSeparation < 0.5, 'both players must begin from the same tee position');
  console.log('Both clients on the live course', { course: COURSE, teeSeparation, opening });

  // --- 1. a stroke is per-client physics --------------------------------
  await stroke(guest);
  await expectState(guest, 'g.phase==="holed"', 25000);
  const guestHoled = await stateOf(guest);
  assert.equal(guestHoled.strokes, 1, 'the guest must have taken exactly one real stroke');
  const travelled = Math.hypot(
    guestHoled.ball.x - opening.guest.ball.x,
    guestHoled.ball.z - opening.guest.ball.z,
  );
  assert(
    travelled > 1,
    'the guest ball must actually travel, proving real physics rather than a synthetic frame',
  );

  const hostUntouched = await stateOf(host);
  assert.equal(hostUntouched.strokes, 0, 'the guest taking a stroke must not score the host');
  assert.equal(
    hostUntouched.gamePhase,
    'aiming',
    'the guest finishing must not finish the host on the host client',
  );
  assert.equal(
    hostUntouched.phase,
    'playing',
    'the round must not advance while the host has not finished',
  );
  console.log('Guest holed out from real input', { strokes: guestHoled.strokes, travelled });

  // --- 2. simultaneous completion with mixed outcomes -------------------
  await giveUp(host);
  await expectState(host, 'g.phase==="forfeit"', 25000);
  await expectState(host, 's.phase==="final"', 45000);
  await expectState(guest, 's.phase==="final"', 45000);

  const final = await stateOf(host);
  const rows = final.final ?? [];
  assert.equal(rows.length, 2, 'the final board must carry both players');
  const hostRow = rows.find((row) => row.name === 'Shots host');
  const guestRow = rows.find((row) => row.name === 'Shots guest');
  assert(hostRow, 'the host must appear on the final board');
  assert(guestRow, 'the guest must appear on the final board');
  // The documented local stroke-play policy: without elimination, a non-finisher
  // still completes the hole but takes a par+5 penalty rather than its real score.
  // Both players are therefore credited the hole, and the forfeit costs strokes.
  assert.equal(guestRow.holesSurvived, 1, 'the guest holed out and must be credited the hole');
  assert.equal(hostRow.holesSurvived, 1, 'without elimination a forfeit still completes the hole');
  assert.equal(guestRow.totalStrokes, 1, 'the hole out cost the guest exactly one stroke');
  assert(
    hostRow.totalStrokes >= 7,
    'a forfeit must carry at least the par+5 penalty on this par-2 course, scoring ' +
      hostRow.totalStrokes,
  );
  assert(
    hostRow.totalStrokes > guestRow.totalStrokes,
    'the forfeited hole must cost more strokes than the hole out',
  );
  assert.equal(guestRow.rank, 1, 'the player who holed out must rank above the forfeiter');
  await waitFor(host, 'document.body.innerText.includes("Party over")', 15000);
  console.log('Final board', JSON.stringify(rows));

  const failures = [...host.events, ...guest.events].filter((event) => event.type === 'exception');
  assert.equal(failures.length, 0, 'no page exceptions are allowed');
  console.log('PASS two real clients took real strokes on a live public course');
  console.log('PASS the round waited for both players and ended on simultaneous completion');
  console.log('PASS a hole out and a forfeit were scored distinctly on the final board');
} finally {
  guest.close();
  await fetch(debugging + '/json/close/' + guestPage.id).catch(() => {});
  host.close();
}
