/**
 * Live end-to-end check that the server replays a real recorded shot.
 *
 * This drives the pinned client in a real browser, holes out on a real imported
 * course, and then reads the server's own audit log for the `shot_verification`
 * verdict. It is the only check that proves the whole path — the client's `shot`
 * frame, the transport, the room's capture, the verifier and the real Rapier
 * engine — is wired together, so it exercises the feature the way a player does
 * rather than calling the verifier directly.
 *
 * Two things make the verdict readable:
 *
 *  - `BP_EVENT_LOG` must name the service's event log. `run-all.sh` sets it for
 *    the sweep; a manual run has to pass it too. Without it the service writes
 *    no events at all, and the check fails rather than passing on nothing.
 *  - The course must be one the verifier can replay. "hole in one" is a plain
 *    start/straight/hole-round hole with no event devices and no splines, which
 *    is exactly the shape the verifier models. Event-driven courses are refused
 *    by design, so using one here would assert nothing.
 */
import { readFileSync } from 'node:fs';
import { connect, waitFor, pause } from './cdp.mjs';

const base = process.env.BASE || 'http://127.0.0.1:8789';
const debugging = 'http://127.0.0.1:9239';
const auditLog = process.env.BP_EVENT_LOG;
const runtime = '(await import("/assets/runtime-DL2fiDAQ.js"))';
const party = '(await import("/assets/runtime-DL2fiDAQ.js")).E.state';
const game = '(await import("/assets/runtime-DL2fiDAQ.js")).m.state';
/** A short public hole: it loads fast and a normal putt holes out from the tee. */
const COURSE = 'hole in one';
/** Pulling down launches the ball up-course, where the cup sits from the tee. */
const PULL_DOWN_PX = 120;

function fail(message) {
  console.error('FAIL: ' + message);
  process.exit(1);
}

if (!auditLog) {
  fail('set BP_EVENT_LOG to the service event log; the verdict is only recorded there');
}

const targets = await fetch(debugging + '/json/list').then((response) => response.json());
const client = await connect(targets.find((entry) => entry.type === 'page'));
const evalIn = (expression, timeout = 30000) => client.evalJS(expression, timeout);

/** Pull back and release through the original pointer handlers. No state injection. */
async function stroke() {
  await client.call('Page.bringToFront');
  await pause(120);
  const origin = await evalIn(
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
    y: origin.y + PULL_DOWN_PX,
    button: 'left',
    buttons: 1,
  });
  await pause(120);
  await client.call('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: origin.x,
    y: origin.y + PULL_DOWN_PX,
    button: 'left',
    clickCount: 1,
  });
}

/** Read every `shot_verification` verdict the service has written so far. */
function verdicts() {
  return readFileSync(auditLog, 'utf8')
    .split('\n')
    .filter((line) => line.includes('shot_verification'))
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

try {
  /*
   * No device-metrics override. The pull distance is converted to power through
   * the canvas size, so pinning the viewport would change what a 120 px pull
   * means — and 120 px down is the drag that holes out on this course in
   * `check-multiplayer-shots.mjs`, which runs in the browser's own window.
   */
  await client.call('Page.navigate', { url: base + '/home' });
  await waitFor(client, 'typeof document.querySelector("#create")?.onclick==="function"', 60000);
  await evalIn('document.querySelector("#create").click()');
  await waitFor(client, 'document.querySelector("input")?.placeholder==="Your name"', 30000);
  await evalIn(
    '(()=>{const el=document.querySelector("input");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(el,"Verifier");el.dispatchEvent(new Event("input",{bubbles:true}))})()',
  );
  await evalIn('[...document.querySelectorAll("button")].find(b=>b.textContent==="Join").click()');
  await waitFor(client, `(async()=>{const s=${party};return s.bpConnected&&s.mapReady})()`, 90000);

  // Import the course through the real import route, looking it up the way the
  // picker does. The catalogue is a moving list, so the id is resolved by title
  // rather than assumed to sit at a fixed position.
  const catalog = await fetch(base + '/api/catalog?search=' + encodeURIComponent(COURSE)).then(
    (response) => response.json(),
  );
  const hole = (catalog.holes || []).find((entry) => entry.title === COURSE);
  if (!hole) {
    fail('the public catalogue no longer offers the ' + COURSE + ' course');
  }
  const imported = await evalIn(
    `(async()=>{const s=${party};const response=await fetch("/api/import",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({code:s.code,uid:s.self.uid,session:s.self.session,host:sessionStorage.getItem("bp.host."+s.code),id:${JSON.stringify(hole.id)}})});return response.status})()`,
    40000,
  );
  if (imported !== 200) {
    fail('the service refused to import the ' + COURSE + ' course (status ' + imported + ')');
  }
  console.log('course ' + hole.id + ' (' + COURSE + ')');

  await evalIn(
    `(async()=>{const r=${runtime};r.D({mapSource:"picked",selectedHoleIds:${JSON.stringify([hole.id])}})})()`,
  );
  await pause(600);
  /*
   * One hole and a generous round clock. Without `holes: 1` the party would
   * advance to a second hole after the hole out and never reach `final`, and the
   * default 60 s clock is short for a multi-stroke check on a slow headless
   * renderer.
   */
  await evalIn(`(async()=>{const r=${runtime};r.D({holes:1,elimination:false,timerMs:300000})})()`);
  await waitFor(
    client,
    `(async()=>{const s=${party};return s.config.holes===1&&!s.config.elimination})()`,
    20000,
  );
  await evalIn(
    '[...document.querySelectorAll("button")].find(b=>b.textContent==="Start party").click()',
  );
  await waitFor(
    client,
    `(async()=>{const s=${party};const g=${game};return s.phase==="playing"&&g.phase==="aiming"&&g.level?.name===${JSON.stringify(COURSE)}})()`,
    150000,
  );
  await pause(2500);

  // Take real strokes until the hole is out. Only a completed round is
  // verified, so the report has to be one the client actually finished — the
  // check never synthesises a completion frame.
  let strokes = 0;
  while (strokes < 8) {
    const shotsBefore = await evalIn(`(async()=>(${game}.shots||[]).length)()`);
    await stroke();
    await waitFor(client, `(async()=>(${game}.shots||[]).length>${shotsBefore})()`, 45000);
    strokes += 1;
    const shot = await evalIn(`(async()=>{const s=${game}.shots;return s[s.length-1]})()`);
    console.log('client shot ' + JSON.stringify(shot));
    if (!Array.isArray(shot.dir) || typeof shot.power !== 'number') {
      fail('client did not record a {dir, power} shot');
    }
    await waitFor(
      client,
      `(async()=>{const g=${game};return g.phase==="holed"||g.phase==="aiming"})()`,
      60000,
    );
    if (await evalIn(`(async()=>(${game}.phase==="holed"))()`)) {
      break;
    }
  }
  if (!(await evalIn(`(async()=>(${game}.phase==="holed"))()`))) {
    fail('the ball never holed out in ' + strokes + ' real strokes, so no round completed');
  }
  await waitFor(client, `(async()=>(${party}.phase==="final"))()`, 60000);

  // The verdict is written after the round is stored, so wait for it rather than
  // sampling once and racing the verifier.
  let verdict;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const seen = verdicts();
    if (seen.length) {
      verdict = seen[seen.length - 1];
      break;
    }
    await pause(500);
  }
  if (!verdict) {
    fail('the server recorded no shot_verification verdict for a completed round');
  }
  console.log('server verdict ' + JSON.stringify(verdict));
  if (verdict.ok !== true) {
    fail('the server could not reproduce an honest shot: ' + (verdict.failure ?? 'unknown'));
  }
  if (!(verdict.shots >= 1)) {
    fail('the verdict replayed no shots, so it proves nothing about the trajectory');
  }
  // The finish frame's stroke count and the recorded inputs must agree for an
  // honest run. A mismatch is only ever audited, never enforced, so this asserts
  // the audit stayed quiet rather than that the round was accepted.
  const mismatches = readFileSync(auditLog, 'utf8')
    .split('\n')
    .filter((line) => line.includes('shot_count_mismatch'));
  if (mismatches.length) {
    fail('an honest round reported a stroke count that disagrees with its shot inputs');
  }
  console.log('PASS the server replayed the real shot and reproduced the reported trajectory');
  process.exit(0);
} catch (error) {
  console.error(error);
  fail(String(error && error.message ? error.message : error));
} finally {
  await client.close();
}
