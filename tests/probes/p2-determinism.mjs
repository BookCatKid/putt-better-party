/**
 * P2 feasibility probe: is a recorded shot reproducible?
 *
 * The question is whether the pinned client's physics can be re-simulated to
 * validate a reported score, or whether a trajectory is a one-off artefact of
 * frame timing that nothing can reproduce.
 *
 * Method: a real client joins a real course and takes one real pointer stroke
 * from the tee, then the trajectory the client itself records (`V.traj`, the
 * same array it uploads as replay samples) is written out. Running this twice
 * and comparing the arrays answers the question directly: equal arrays mean a
 * fixed input under fixed conditions yields a fixed trajectory, which is the
 * precondition for server-side replay. Differing arrays mean the recorded path
 * cannot be regenerated, and a score cannot be verified by re-simulation.
 *
 * Nothing is mocked: the stroke goes through the original pointer handlers and
 * the course comes from the live catalog through the real import path.
 */

import { writeFileSync } from 'node:fs';
import { connect, waitFor, pause } from '../integration/cdp.mjs';

const base = process.env.BASE || 'http://127.0.0.1:8831';
const debugging = 'http://127.0.0.1:9239';
const output = process.env.PROBE_OUT || '/tmp/p2-shot.json';
const courseId = process.env.PROBE_COURSE || '';
const pullDown = Number(process.env.PROBE_PULL || 120);
/**
 * Simulated CPU slowdown, in the CDP sense (1 = unthrottled). This is the lever
 * that changes frame timing without changing anything the shot depends on, so
 * comparing two throttled runs answers whether the outcome is a function of the
 * input or of how the frames happened to land.
 */
const throttle = Number(process.env.PROBE_THROTTLE || 1);
/**
 * Block the page's main thread mid-roll, in milliseconds.
 *
 * `advance` clamps one frame to `1/120 * 24` (0.2 s) and discards the excess, so
 * a frame longer than that **loses simulated time** — the wall clock takes
 * longer to reach the same point. What it does not lose is the step sequence:
 * the ball is fed the same 1/120 s steps, so the sampled trajectory comes out
 * identical and only `rollWallMs` grows. This knob exists to demonstrate that
 * separation; the evidence file records both, so the claim can be checked
 * rather than taken on trust.
 */
const stallMs = Number(process.env.PROBE_STALL_MS || 0);
const runtime = '(await import("/assets/runtime-DL2fiDAQ.js"))';
const party = '(await import("/assets/runtime-DL2fiDAQ.js")).E.state';
const game = '(await import("/assets/runtime-DL2fiDAQ.js")).m.state';

const targets = await fetch(debugging + '/json/list').then((response) => response.json());
const client = await connect(targets.find((entry) => entry.type === 'page'));

const evalIn = (expression, timeout) => client.evalJS(expression, timeout);

const state = () =>
  evalIn(`(async()=>{const s=${party};const g=${game};return {
    partyPhase: s.phase, gamePhase: g.phase, strokes: g.strokes, attemptSeq: g.attemptSeq,
  }})()`);

/**
 * Pull back and release through the original pointer handlers.
 *
 * `Page.bringToFront` first: headless Chrome freezes an occluded renderer
 * outright, so pointer input dispatched to a backgrounded tab never reaches the
 * canvas. This is the same constraint the multiplayer shot regression documents.
 */
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

await client.call('Emulation.setDeviceMetricsOverride', {
  width: 1280,
  height: 800,
  deviceScaleFactor: 1,
  mobile: false,
});
if (throttle > 1) {
  await client.call('Emulation.setCPUThrottlingRate', { rate: throttle });
  console.log('cpu throttle', throttle);
}
await client.call('Page.navigate', { url: base + '/home' });
await waitFor(client, 'typeof document.querySelector("#create")?.onclick==="function"', 60000);
await evalIn('document.querySelector("#create").click()');
await waitFor(client, 'document.querySelector("input")?.placeholder==="Your name"', 30000);
await evalIn(
  '(()=>{const el=document.querySelector("input");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(el,"Probe");el.dispatchEvent(new Event("input",{bubbles:true}))})()',
);
await evalIn('[...document.querySelectorAll("button")].find(b=>b.textContent==="Join").click()');
await waitFor(client, `(async()=>{const s=${party};return s.bpConnected&&s.mapReady})()`, 90000);

/* Pick one course through the real import path, so the level is real. */
let chosen = courseId;
if (!chosen) {
  const catalog = await fetch(base + '/api/catalog?sort=top').then((response) => response.json());
  for (const hole of catalog.holes.slice(0, 6)) {
    const status = await evalIn(
      `(async()=>{const s=${party};const response=await fetch("/api/import",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({code:s.code,uid:s.self.uid,session:s.self.session,host:sessionStorage.getItem("bp.host."+s.code),id:${JSON.stringify(hole.id)}})});return response.status})()`,
      40000,
    );
    if (status === 200) {
      chosen = hole.id;
      break;
    }
  }
}
if (!chosen) {
  throw Error('no catalog course imported');
}
console.log('course', chosen);
await evalIn(
  `(async()=>{const r=${runtime};r.D({mapSource:"picked",selectedHoleIds:${JSON.stringify([chosen])}})})()`,
);
await pause(600);
await evalIn(
  '[...document.querySelectorAll("button")].find(b=>b.textContent==="Start party").click()',
);
await waitFor(
  client,
  `(async()=>{const s=${party};const g=${game};return s.phase==="playing"&&g.phase==="aiming"})()`,
  150000,
);
await pause(3000);

const spawn = await evalIn(`(async()=>{const p=${runtime}.r.ballPos;return [p.x,p.y,p.z]})()`);
console.log('spawn', JSON.stringify(spawn));

/*
 * Record the real frame gaps for the duration of the roll. The physics clock
 * clamps one frame to 1/120 * 24 (0.2 s) and discards the rest, so whether a
 * timing perturbation actually reaches the simulation is a fact about the frame
 * gaps, not an assumption. Measuring them turns "the trajectory was identical"
 * into "the trajectory was identical and here is what the clock was fed".
 */
await evalIn(`(()=>{
  window.__bpGaps = [];
  let previous = performance.now();
  const tick = () => {
    const now = performance.now();
    window.__bpGaps.push(now - previous);
    previous = now;
    if (window.__bpGaps.length < 100000) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return true;
})()`);

const before = await state();
console.log('before', JSON.stringify(before));
if (before.gamePhase !== 'aiming') {
  throw Error('game is not aiming, cannot take a tee shot: ' + before.gamePhase);
}
const rollStartedAt = Date.now();
await stroke();
if (stallMs > 0) {
  await pause(400);
  await evalIn(
    `(()=>{const end=performance.now()+${stallMs};while(performance.now()<end){}return performance.now()})()`,
  );
  console.log('stalled', stallMs);
}
/* Wait for the stroke to be registered, then for the ball to actually stop. */
await waitFor(client, `(async()=>{const g=${game};return g.strokes>${before.strokes}})()`, 45000);
await waitFor(
  client,
  `(async()=>{const g=${game};return g.phase==="aiming"||g.phase==="holed"||g.phase==="forfeit"})()`,
  120000,
);
// The rest position is the quantity a score depends on, so sample it only once
// the phase has settled and confirm it holds still.
let previous = null;
for (let attempt = 0; attempt < 60; attempt++) {
  const now = await evalIn(`(async()=>{const p=${runtime}.r.ballPos;return [p.x,p.y,p.z]})()`);
  if (previous && now.every((value, position) => Math.abs(value - previous[position]) < 1e-9)) {
    break;
  }
  previous = now;
  await pause(100);
}
await pause(300);
const rollWallMs = Date.now() - rollStartedAt;

// `V` is exported as `r`, so the scene buffers are `runtime.r`.
const result = await evalIn(`(async()=>{const r=${runtime};
  const scene = r.r;
  const traj = Array.isArray(scene.traj) ? scene.traj.slice() : null;
  const last = scene.lastShot ? {seq: scene.lastShot.seq, traj: scene.lastShot.traj.slice()} : null;
  const p = scene.ballPos;
  return {traj, last, rest: [p.x, p.y, p.z]};
})()`);

const gaps = await evalIn(`(()=>({
  count: window.__bpGaps.length,
  max: Math.max(...window.__bpGaps),
  over200: window.__bpGaps.filter((gap) => gap > 200).length,
  over250: window.__bpGaps.filter((gap) => gap > 250).length,
  mean: window.__bpGaps.reduce((sum, gap) => sum + gap, 0) / window.__bpGaps.length,
}))()`);
console.log('frame gaps', JSON.stringify(gaps));

const payload = {
  course: chosen,
  frameGaps: gaps,
  pullDown,
  throttle,
  stallMs,
  spawn,
  strokes: (await state()).strokes,
  trajLength: result.traj ? result.traj.length : 0,
  rollWallMs,
  traj: result.traj,
  lastShot: result.last,
  rest: result.rest,
};
writeFileSync(output, JSON.stringify(payload, null, 2));
console.log(
  `wrote ${output}: traj ${payload.trajLength} samples, lastShot ${result.last ? result.last.traj.length : 'null'}, strokes ${payload.strokes}, roll ${rollWallMs} ms wall`,
);
console.log('rest', JSON.stringify(result.rest));

client.close();
