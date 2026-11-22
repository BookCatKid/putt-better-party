import assert from 'node:assert/strict';
import { connect, waitFor, pause } from './cdp.mjs';

const base = process.env.BASE || 'http://127.0.0.1:8789';
const debug = 'http://127.0.0.1:9239';
const client = await connect(
  (await fetch(debug + '/json/list').then((response) => response.json())).find(
    (target) => target.type === 'page',
  ),
);
const runtime = '(await import("/assets/runtime-DL2fiDAQ.js"))';
const state = (condition, timeout = 45000) =>
  waitFor(
    client,
    '(async()=>{const r=' +
      runtime +
      ',s=r.E.state,g=r.m.state;return (' +
      condition +
      ')&&!document.querySelector(".bp-party-loading")})()',
    timeout,
  );
const click = (title) =>
  client.evalJS(
    '[...document.querySelectorAll("button")].find(b=>b.textContent===' +
      JSON.stringify(title) +
      ').click()',
  );
let guest;
try {
  await client.call('Page.navigate', { url: base + '/home' });
  await waitFor(client, 'typeof document.querySelector("#create")?.onclick==="function"');
  await client.evalJS('document.querySelector("#create").click()');
  await waitFor(client, 'document.querySelector("input")?.placeholder==="Your name"');
  await client.evalJS(
    '(()=>{const el=document.querySelector("input");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(el,"Replay host");el.dispatchEvent(new Event("input",{bubbles:true}))})()',
  );
  await click('Join');
  await state('s.isHost&&s.mapReady&&s.bpConnected');
  await client.evalJS(
    '(async()=>{const r=' + runtime + ';r.D({holes:1,elimination:false,timerMs:60000})})()',
  );
  await state('s.config.holes===1&&!s.config.elimination');
  const code = await client.evalJS('location.pathname.split("/").at(-1)');
  const response = await fetch(base + '/api/join', {
    method: 'POST',
    headers: { origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({ code, name: 'Replay guest' }),
  });
  assert(response.ok);
  const identity = await response.json();
  guest = new WebSocket(base.replace('http', 'ws') + '/ws/party/' + code, {
    headers: { origin: base },
  });
  let snapshot;
  guest.onmessage = (event) => {
    const packet = JSON.parse(event.data);
    if (packet.t === 'party') {
      snapshot = packet;
    }
  };
  await new Promise((resolve, reject) => {
    guest.onopen = resolve;
    guest.onerror = reject;
  });
  const send = (message) => guest.send(JSON.stringify(message));
  send({ t: 'join', ...identity, protocol: 2, instance: 'replay-probe' });
  await state('s.roster.length===2');
  await click('Start party');
  await state('s.phase==="playing"&&g.phase==="aiming"&&!!document.querySelector("canvas")');
  const tee = await client.evalJS(
    '(async()=>{const r=' + runtime + ';return [r.r.ballPos.x,r.r.ballPos.y,r.r.ballPos.z]})()',
  );
  await pause(1200);
  const scope = { matchId: snapshot.matchId, holeIndex: snapshot.holeIndex };
  const coords = tee.map((value) => Math.round(value * 100));
  send({
    t: 'replay-samples',
    ...scope,
    replay: {
      samples: [
        100,
        ...coords,
        1,
        150,
        coords[0] + 25,
        coords[1],
        coords[2] - 25,
        0,
        200,
        coords[0] + 50,
        coords[1],
        coords[2] - 50,
        0,
      ],
      states: [],
    },
  });
  const origin = await client.evalJS(
    '(()=>{const b=document.querySelector("canvas").getBoundingClientRect();return {x:b.x+b.width*.5,y:b.y+b.height*.6}})()',
  );
  await client.call('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    ...origin,
    button: 'left',
    clickCount: 1,
  });
  await client.call('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: origin.x,
    y: origin.y + 120,
    button: 'left',
    buttons: 1,
  });
  await pause(120);
  await client.call('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: origin.x,
    y: origin.y + 120,
    button: 'left',
    clickCount: 1,
  });
  await state('g.strokes>=1');
  await pause(1800);
  console.log('PASS original engine accepted a real pointer stroke');
  await state('g.phase==="aiming"||g.phase==="holed"', 20000);
  if ((await client.evalJS('(async()=>(' + runtime + ').m.state.phase)()')) !== 'holed') {
    await click('Give up');
    await click('Yes');
    await state('g.phase==="forfeit"');
  }
  send({
    f: 1,
    s: 1,
    p: snapshot.currentMap.par,
    ...scope,
    replay: {
      samples: [300, coords[0] + 100, coords[1], coords[2] - 100, 0],
      states: [],
      native: {
        path: [0, 0, 0, 1],
        trajectory: [...coords, coords[0] + 100, coords[1], coords[2] - 100],
        events: [],
      },
    },
  });
  await state('s.phase==="final"&&!!s.replayId');
  await waitFor(
    client,
    '!![...document.querySelectorAll("a")].find(a=>a.textContent==="View party replays")',
  );
  const link = await client.evalJS(
    '[...document.querySelectorAll("a")].find(a=>a.textContent==="View party replays").href',
  );
  const id = link.split('/').at(-1);
  const summary = await fetch(base + '/api/replays/' + id).then((result) => result.json());
  assert.equal(summary.rounds.length, 1);
  assert.equal(summary.rounds[0].players.filter((player) => player.recorded).length, 2);
  const hole = await fetch(base + '/api/replays/' + id + '/0').then((result) => result.json());
  const real = hole.tracks.find((track) => track.name === 'Replay host');
  assert(real.samples.length >= 50, 'host recorded at least ten actual samples');
  const distance =
    Math.max(...real.samples.filter((_value, index) => index % 5 === 3)) -
    Math.min(...real.samples.filter((_value, index) => index % 5 === 3));
  assert(distance > 20, 'the real ball moved more than twenty centimetres');
  // Clock-driven course devices (spinner, slider, pendulum, piston) animate from
  // the renderer clock, whose phase at round start is arbitrary, so a replay can
  // only place them correctly if the phase was recorded.
  assert(
    Number.isInteger(hole.deviceClockMs) && hole.deviceClockMs >= 0,
    'the renderer clock at round start was recorded: ' + JSON.stringify(hole.deviceClockMs),
  );
  console.log(
    'PASS actual ball motion and guest fixture timeline independently archived; match link available',
  );
  await client.call('Page.navigate', { url: link });
  await waitFor(client, '!!document.querySelector(".bp-replay-controls")', 40000);
  await click('Pause');
  await click('Map');
  await waitFor(client, '!!document.querySelector(".bp-replay-map")');
  await client.evalJS(
    '(()=>{const el=document.querySelector(\'input[aria-label="Replay time"]\');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(el,"250");el.dispatchEvent(new Event("input",{bubbles:true}));el.dispatchEvent(new Event("change",{bubbles:true}));})()',
  );
  await waitFor(client, 'document.querySelectorAll(".bp-replay-map circle").length>=3');
  await client.evalJS(
    '[...document.querySelectorAll(".bp-replay-players button")].find(b=>b.textContent==="Solo").click()',
  );
  await waitFor(client, 'document.querySelectorAll(".bp-replay-players input:checked").length===1');
  await click('All');
  await waitFor(client, 'document.querySelectorAll(".bp-replay-players input:checked").length===2');
  await click('3D');
  await waitFor(client, '!!document.querySelector(".bp-replay-viewport canvas")', 40000);
  await pause(800);
  assert.equal(
    client.events.filter((event) => event.type === 'exception').length,
    0,
    JSON.stringify(client.events.filter((event) => event.type === 'exception')),
  );
  assert(!(await client.evalJS('document.body.innerText.includes("The replay hit a snag")')));
  console.log(
    'PASS shared map timeline, individual selection, original 3D course scene, no page exceptions',
  );
} finally {
  guest?.close();
  client.close();
}
