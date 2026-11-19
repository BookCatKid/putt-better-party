import { connect, waitFor } from './cdp.mjs';
import assert from 'node:assert/strict';

const base = process.env.BASE || 'http://127.0.0.1:8789';
const debugging = process.env.DEBUG_URL || 'http://127.0.0.1:9239';
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

const click = async (label) => {
  const point = await client.evalJS(
    `(()=>{const b=[...document.querySelectorAll("button")].find(b=>!b.disabled&&(b.textContent===${JSON.stringify(label)}||b.getAttribute("aria-label")===${JSON.stringify(label)}));if(!b)return null;b.scrollIntoView({block:"nearest"});const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,hit:b.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}})()`,
  );
  assert(point?.hit, 'Button not clickable: ' + label + ' ' + JSON.stringify(point));
  await client.call('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: point.x,
    y: point.y,
    button: 'left',
    clickCount: 1,
  });
  await client.call('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: point.x,
    y: point.y,
    button: 'left',
    clickCount: 1,
  });
};
try {
  await client.call('Page.navigate', { url: base + '/home' });
  await waitFor(client, 'typeof document.querySelector("#create")?.onclick==="function"');
  await client.evalJS('document.querySelector("#create").click()');
  await join('Manager');
  await state('s.isHost&&s.bpConnected&&s.mapReady');
  const code = await client.evalJS(`(async()=>${runtime}.E.state.code)()`);
  const guest = await post('/api/join', { code, name: 'Guest' });
  host = new WebSocket(base.replace('http', 'ws') + '/ws/party/' + code, {
    headers: { origin: base },
  });
  await new Promise((resolve, reject) => {
    host.onopen = resolve;
    host.onerror = reject;
  });
  host.send(JSON.stringify({ t: 'join', ...guest, protocol: 2, instance: 'guest' }));
  await state('s.roster.some(p=>p.name==="Guest")');
  await click('Manage Guest');
  await waitFor(client, '!!document.querySelector("dialog[open]")');
  await client.evalJS(
    `(()=>{const input=document.querySelector('[aria-label="Player name"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,"Renamed");input.dispatchEvent(new Event("input",{bubbles:true}));})()`,
  );
  await click('Save');
  await state('s.roster.some(p=>p.name==="Renamed")&&!!document.querySelector("dialog[open]")');
  await waitFor(
    client,
    'document.querySelector("dialog[open] .bp-dialog-notices .bp-management-toast")?.textContent.includes("Renamed")',
  );
  assert.equal(
    await client.evalJS(
      'document.querySelector(".bp-dashboard-header").textContent.includes("was renamed")',
    ),
    false,
  );
  await click('Close management');
  await waitFor(
    client,
    'document.querySelector(".bp-lobby-notices .bp-management-toast")?.textContent.includes("Renamed")',
  );
  console.log('PASS lobby management dialog and server-authoritative rename');
  host.close();
  host = undefined;
  await client.call('Page.navigate', { url: base + '/home' });
  const room = await post('/api/create', {});
  const identity = await post('/api/join', { code: room.code, name: 'Host' });
  host = new WebSocket(base.replace('http', 'ws') + '/ws/party/' + room.code, {
    headers: { origin: base },
  });
  let snapshot;
  let roster;
  let board;
  const acks = new Map();
  host.onmessage = (event) => {
    const frame = JSON.parse(event.data);
    if (frame.t === 'party') {
      snapshot = frame;
    }
    if (frame.t === 'roster') {
      roster = frame.players;
    }
    if (frame.t === 'board') {
      board = frame;
    }
    if (frame.t === 'host-ack') {
      acks.set(frame.requestId, frame);
    }
  };
  await new Promise((resolve, reject) => {
    host.onopen = resolve;
    host.onerror = reject;
  });
  const send = (message) => host.send(JSON.stringify(message));
  async function until(condition) {
    for (let attempt = 0; attempt < 600; attempt++) {
      if (condition()) {
        return;
      }
      await Bun.sleep(50);
    }
    throw Error('Server state timeout');
  }
  send({ t: 'join', ...identity, host: room.hostToken, protocol: 2, instance: 'manager' });
  await until(() => snapshot?.phase === 'lobby');
  send({ t: 'config', config: { holes: 2, elimination: false, timerMs: 120000 } });
  await until(() => snapshot.config.timerMs === 120000);
  await client.call('Page.navigate', { url: base + '/party/' + room.code });
  await join('Controlled player');
  await state('s.mapReady&&s.bpConnected&&s.selfRole==="player"');
  await until(() => roster?.some((player) => player.name === 'Controlled player'));
  const uid = roster.find((player) => player.name === 'Controlled player').uid;
  await client.evalJS(
    '(async()=>{const three=await import("/assets/three.module-DJ81ilGZ.js");const original=three.mt.prototype.lookAt;three.mt.prototype.lookAt=function(...args){if(this.isCamera)window.bpTestCamera=this;return original.apply(this,args)}})()',
  );
  send({ t: 'start' });
  await state('s.phase==="playing"&&s.mapReady&&g.level?.id===s.currentMap?.id');
  async function command(action, value) {
    const requestId = crypto.randomUUID();
    send({
      t: 'host-action',
      action,
      uid,
      value,
      requestId,
      matchId: snapshot.matchId,
      holeIndex: snapshot.holeIndex,
    });
    await until(() => acks.has(requestId));
    assert(acks.get(requestId).ok, JSON.stringify(acks.get(requestId)));
  }
  const read = () =>
    client.evalJS(
      `(async()=>{const r=${runtime};const s=r.E.state,g=r.m.state;return {position:r.r.ballPos.toArray(),spawn:g.level?.spawn,strokes:g.strokes,attempt:g.attemptSeq,epoch:s.bpAttempt,phase:g.phase,paused:s.bpPausedAt,version:g.level?.runtimeVersion,gate:r.C(),fly:s.flyCam,lock:s.bpPuttingLocked,reset:s.bpResetPending,ready:s.mapReady,inert:!!document.querySelector("canvas")?.closest("[inert]"),time:s.timerEndsAt-Date.now()}})()`,
    );
  async function shoot() {
    const point = await client.evalJS(
      `(async()=>{const r=${runtime},c=document.querySelector("canvas").getBoundingClientRect(),camera=window.bpTestCamera;if(!camera)throw Error("No active camera");camera.updateMatrixWorld();const projected=r.r.ballPos.clone().project(camera),px=c.x+(projected.x+1)*c.width/2,py=c.y+(1-projected.y)*c.height/2;return {x:px,y:py,hit:document.elementFromPoint(px,py)?.tagName}})()`,
    );
    console.log('Shot target', point);
    await client.call('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: point.x,
      y: point.y,
      button: 'left',
      clickCount: 1,
    });
    console.log('After press', await read());
    await client.call('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: point.x,
      y: point.y + 120,
      button: 'left',
      buttons: 1,
    });
    await client.call('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: point.x,
      y: point.y + 120,
      button: 'left',
      clickCount: 1,
    });
  }
  await command('lock-putting');
  await state('s.bpPuttingLocked');
  await shoot();
  assert.equal((await read()).strokes, 0);
  await command('unlock-putting');
  await state('!s.bpPuttingLocked');
  await shoot();
  await state('g.strokes>=1');
  await command('pause');
  await state('!!s.bpPausedAt');
  await Bun.sleep(150);
  const paused = await read();
  await Bun.sleep(650);
  const still = await read();
  assert.equal(still.paused, paused.paused);
  assert(
    Math.hypot(...still.position.map((value, index) => value - paused.position[index])) < 0.02,
    JSON.stringify({ paused, still }),
  );
  await command('resume');
  await state('!s.bpPausedAt');
  console.log('PASS real pointer input locking and physics pause', paused.version);
  const previous = await read();
  await command('restart-player');
  await state('s.bpAttempt===1&&!s.bpResetPending&&s.mapReady&&g.strokes===0');
  const reset = await read();
  assert(reset.attempt > previous.attempt);
  assert(
    Math.hypot(reset.position[0] - reset.spawn[0], reset.position[2] - reset.spawn[2]) < 0.2,
    JSON.stringify(reset),
  );
  await Bun.sleep(800);
  console.log('Reset readiness', await read());
  await shoot();
  console.log('After new shot', await read());
  await state('g.strokes===1');
  await until(() => board?.standings.some((player) => player.uid === uid && player.strokes === 1));
  console.log('PASS individual restart loads original tee and next stroke is accepted by server');
  await command('spectate-player');
  await state('s.selfRole==="spectator"&&!!document.querySelector(".bp-spectating")');
  await command('return-player');
  await state(
    's.selfRole==="player"&&s.bpAttempt===2&&!s.bpResetPending&&s.mapReady&&g.strokes===0',
  );
  console.log('PASS spectator return loads new attempt');
} finally {
  console.log(
    'Browser errors',
    JSON.stringify(
      client.events
        .filter((event) => event.type === 'exception' || event.type === 'crash')
        .slice(-10),
    ),
  );
  host?.close();
  client.close();
}
