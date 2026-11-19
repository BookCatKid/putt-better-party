import { connect, waitFor } from './cdp.mjs';
import assert from 'node:assert/strict';

const base = process.env.BASE || 'http://127.0.0.1:8789';
const debugging = 'http://127.0.0.1:9239';
const runtime = '(await import("/assets/runtime-DL2fiDAQ.js"))';
const headers = { origin: base, 'content-type': 'application/json' };
const post = async (path, data) => {
  const response = await fetch(base + path, {
    method: 'POST',
    headers,
    body: JSON.stringify(data),
  });
  const result = await response.json();
  assert(response.ok, JSON.stringify(result));
  return result;
};

const client = await connect(
  (await fetch(debugging + '/json/list').then((response) => response.json())).find(
    (target) => target.type === 'page',
  ),
);
let host;
async function join(name) {
  await waitFor(client, 'document.querySelector("input")?.placeholder==="Your name"');
  await client.evalJS(
    `(()=>{const x=document.querySelector("input");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(x,${JSON.stringify(name)});x.dispatchEvent(new Event("input",{bubbles:true}));})()`,
  );
  await waitFor(
    client,
    '[...document.querySelectorAll("button")].some(b=>b.textContent==="Join"&&!b.disabled)',
  );
  await client.evalJS(
    '[...document.querySelectorAll("button")].find(b=>b.textContent==="Join").click()',
  );
}
const state = (condition, timeout = 45000) =>
  waitFor(
    client,
    `(async()=>{const r=${runtime},s=r.E.state,g=r.m.state;return (${condition})&&!document.querySelector(".bp-party-loading")})()`,
    timeout,
  );

try {
  // Confirm the choice is visible and functional on the host's real lobby page.
  await client.call('Page.navigate', { url: base + '/home' });
  await waitFor(client, 'typeof document.querySelector("#create")?.onclick==="function"');
  await client.evalJS('document.querySelector("#create").click()');
  await join('Policy host');
  await state('s.isHost && s.bpConnected && s.mapReady');
  const policy = 'document.querySelector(\'select[aria-label="Join during a match"]\')';
  await waitFor(client, `!!${policy}`);
  assert.deepEqual(await client.evalJS(`[...${policy}.options].map(o=>[o.value,o.textContent])`), [
    ['never', 'Never'],
    ['next-hole', 'After current hole'],
    ['always', 'Always'],
  ]);
  assert.equal(await client.evalJS(`${policy}.value`), 'always');
  for (const value of ['never', 'next-hole', 'always']) {
    await client.evalJS(
      `(()=>{const select=${policy};select.value=${JSON.stringify(value)};select.dispatchEvent(new Event("change",{bubbles:true}));})()`,
    );
    await state(`s.config.lateJoin===${JSON.stringify(value)}`);
  }
  console.log('PASS all three host lobby choices update the server');
  await client.call('Page.navigate', { url: base + '/home' });

  // A protocol-level host runs the real server; only the course source may be
  // replaced by an isolated fixture server. The guest renders the real client.
  const room = await post('/api/create', {});
  const identity = await post('/api/join', { code: room.code, name: 'Host' });
  host = new WebSocket(base.replace('http', 'ws') + '/ws/party/' + room.code, {
    headers: { origin: base },
  });
  let snapshot;
  host.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.t === 'party') {
      snapshot = message;
    }
  };
  await new Promise((resolve, reject) => {
    host.onopen = resolve;
    host.onerror = reject;
  });
  const send = (message) => host.send(JSON.stringify(message));
  const waitForSnapshot = async (condition) => {
    const until = Date.now() + 45000;
    while (Date.now() < until) {
      if (snapshot && condition(snapshot)) {
        return;
      }
      await Bun.sleep(20);
    }
    throw new Error('Host did not receive the expected snapshot');
  };
  send({ t: 'join', ...identity, host: room.hostToken, protocol: 2, instance: 'spectator-host' });
  await waitForSnapshot((party) => party.phase === 'lobby');
  send({
    t: 'config',
    config: { lateJoin: 'next-hole', holes: 2, timerMs: 120000, elimination: false },
  });
  await waitForSnapshot((party) => party.config.lateJoin === 'next-hole');
  send({ t: 'start' });
  await waitForSnapshot((party) => party.phase === 'playing');
  await client.call('Page.navigate', { url: base + '/party/' + room.code });
  await join('Late player');
  await state(
    's.selfRole==="spectator" && s.mapReady && !!document.querySelector(".bp-spectating")',
  );
  const read = () =>
    client.evalJS(
      `(async()=>{const r=${runtime},s=r.E.state,g=r.m.state;return {role:s.selfRole,hole:s.holeIndex,phase:s.phase,fly:s.flyCam,live:r.r.ballRenderLive,strokes:g.strokes,version:g.level?.runtimeVersion,notice:document.querySelector(".bp-spectating")?.innerText??null,aim:document.body.innerText.includes("Drag back from the ball to putt"),position:r.r.ballPos.toArray(),spawn:g.level?.spawn}})()`,
    );
  const waiting = await read();
  assert.equal(waiting.role, 'spectator');
  assert.equal(waiting.live, false);
  assert.equal(waiting.fly, true);
  assert.equal(waiting.aim, false);
  assert.match(waiting.notice, /Spectating.*next hole/s);
  console.log(
    'PASS spectator sees waiting message without local rendered ball or putt hint',
    waiting,
  );
  await state(
    'document.querySelector(".bp-follow-status")?.textContent.includes("Following Host")',
  );
  // Instrument Three's original camera lookAt solely in the isolated browser.
  await client.evalJS(
    `(async()=>{const three=await import("/assets/three.module-DJ81ilGZ.js");const proto=Object.values(three).find(value=>typeof value==="function"&&value.prototype&&Object.hasOwn(value.prototype,"lookAt"))?.prototype;if(!proto)throw Error("Object3D.lookAt not found");const original=proto.lookAt;proto.lookAt=function(...args){if(this.isCamera){const target=args[0];window.bpTestCameraTarget=typeof target==="object"?[target.x,target.y,target.z]:args.slice(0,3)}return original.apply(this,args)}})()`,
  );
  const broadcastBall = (coordX, coordZ) =>
    send({
      x: coordX,
      y: 0.26,
      z: coordZ,
      px: coordX,
      pz: coordZ,
      c: 0,
      m: 0,
      matchId: snapshot.matchId,
      holeIndex: snapshot.holeIndex,
    });
  broadcastBall(1.5, 3.5);
  await state(
    's.bpWatchLive && Math.abs(window.bpTestCameraTarget?.[0]-1.5)<.15 && Math.abs(window.bpTestCameraTarget?.[2]-3.5)<.15',
  );
  broadcastBall(4, 6);
  await state(
    's.bpWatchLive && Math.abs(window.bpTestCameraTarget?.[0]-4)<.15 && Math.abs(window.bpTestCameraTarget?.[2]-6)<.15',
  );
  const selector = 'document.querySelector(\'select[aria-label="Spectator camera"]\')';
  await client.evalJS(
    `(()=>{const select=${selector};select.value="free";select.dispatchEvent(new Event("change",{bubbles:true}))})()`,
  );
  await state(
    'document.querySelector(".bp-follow-status")?.textContent==="Free camera" && !s.bpWatchLive',
  );
  await client.evalJS('document.querySelector(\'button[aria-label="Follow Host"]\').click()');
  broadcastBall(4, 6);
  await state(
    's.bpWatchLive && document.querySelector(".bp-watch-name[aria-pressed=true]")?.textContent==="Host"',
  );
  console.log(
    'PASS original Three camera follows moving remote ball, then switches between free and selected camera',
  );
  const bounds = await client.evalJS(
    '(()=>{const c=document.querySelector("canvas").getBoundingClientRect();return {x:c.x+c.width/2,y:c.y+c.height/2}})()',
  );
  await client.call('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    ...bounds,
    button: 'left',
    clickCount: 1,
  });
  await client.call('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: bounds.x,
    y: bounds.y + 100,
    button: 'left',
    buttons: 1,
  });
  await client.call('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: bounds.x,
    y: bounds.y + 100,
    button: 'left',
    clickCount: 1,
  });
  assert.equal((await read()).strokes, 0);
  send({
    f: 1,
    s: 1,
    p: snapshot.currentMap.par,
    matchId: snapshot.matchId,
    holeIndex: snapshot.holeIndex,
  });
  await state(
    's.selfRole==="player" && s.holeIndex===1 && s.phase==="playing" && s.mapReady && g.level?.id===s.currentMap?.id && !document.querySelector(".bp-spectating")',
  );
  await waitFor(
    client,
    `(async()=>{const r=${runtime};return r.m.state.level?.runtimeVersion!==2||r.r.ballRenderLive})()`,
  );
  const playing = await read();
  assert.equal(playing.role, 'player');
  assert.equal(playing.notice, null);
  assert.equal(await client.evalJS('!!document.querySelector(".bp-follow-controls")'), false);
  assert.equal(playing.fly, false);
  assert.equal(playing.strokes, 0);
  assert(
    Math.hypot(playing.position[0] - playing.spawn[0], playing.position[2] - playing.spawn[2]) <
      0.15,
    JSON.stringify(playing),
  );
  if (playing.version === 2) {
    assert.equal(playing.live, true);
  }
  console.log('PASS next hole admits spectator and initializes their ball at the tee', playing);
  assert.equal(client.events.filter((event) => event.type === 'exception').length, 0);
} finally {
  host?.close();
  client.close();
}
