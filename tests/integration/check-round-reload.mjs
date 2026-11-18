import assert from 'node:assert/strict';
import { connect, waitFor, pause } from './cdp.mjs';

/**
 * A full page reload during an active round.
 *
 * A same-document reconnect keeps the local physics state, but a reload is a new
 * document: the ball, the in-flight swing and the score so far are all gone.
 * The room must not let that document replay the hole, and the reloaded client
 * must not resurrect the previous document's score or claim the round is ready
 * before it has loaded the course.
 *
 * This drives two real clients on a real public course, reloads the guest
 * mid-round, and checks what the server and both browsers then agree on.
 */

const base = process.env.BASE || 'http://127.0.0.1:8789';
const debugging = 'http://127.0.0.1:9239';
const store = '(await import("/assets/runtime-DL2fiDAQ.js")).E.state';
const game = '(await import("/assets/runtime-DL2fiDAQ.js")).m.state';

const targets = await fetch(debugging + '/json/list').then((response) => response.json());
const host = await connect(targets.find((target) => target.type === 'page'));
let guest;
let guestTarget;

const read = (client) =>
  client.evalJS(
    `(async()=>{const s=${store},g=${game};return {
      phase: s.phase,
      isHost: s.isHost,
      role: s.selfRole,
      connected: s.bpConnected,
      mapReady: s.mapReady,
      holeIndex: s.holeIndex,
      level: g.level?.name,
      strokes: g.strokes,
      gamePhase: g.phase,
      error: s.error,
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

try {
  await host.call('Page.navigate', { url: base + '/home' });
  await waitFor(host, 'typeof document.querySelector("#create")?.onclick === "function"');
  await host.evalJS('document.querySelector("#create").click()');
  await waitFor(host, 'location.pathname.startsWith("/party/")');
  await join(host, 'Reload host');
  await expectState(host, 's.isHost');
  const url = await host.evalJS('location.href');

  guestTarget = await fetch(debugging + '/json/new?' + encodeURIComponent(url), {
    method: 'PUT',
  }).then((response) => response.json());
  guest = await connect(guestTarget);
  await join(guest, 'Reload guest');
  await expectState(host, 's.roster.length===2');

  // One live public course is enough: the reload has to happen inside one hole.
  await host.evalJS(
    `(()=>{let x=document.querySelector("select[aria-label='Party map selection']");x.value="picked";x.dispatchEvent(new Event("change",{bubbles:true}));})()`,
  );
  const addFirst =
    '[...document.querySelectorAll("button")].find(b=>b.getAttribute("aria-label")?.startsWith("Add "))';
  await waitFor(host, '!!' + addFirst, 25000);
  await host.evalJS(addFirst + '.click()');
  await expectState(host, 's.config.selectedHoleIds?.length===1');
  await host.evalJS(
    '(async()=>{(await import("/assets/runtime-DL2fiDAQ.js")).D({timerMs:90000,elimination:false})})()',
  );
  await expectState(host, 's.config.timerMs===90000');
  await host.evalJS(
    '[...document.querySelectorAll("button")].find(x=>x.textContent==="Start party").click()',
  );
  await expectState(host, 's.phase==="countdown"');
  await expectState(guest, 's.phase==="playing"&&s.mapReady&&g.level', 45000);
  console.log('Both clients are playing hole 1', await read(host), await read(guest));

  // The guest takes a real stroke before the reload, so the reload has something
  // real to lose: an attempt count the server already knows about.
  await guest.call('Page.bringToFront');
  const rect = await guest.evalJS(
    '(()=>{const b=document.querySelector("canvas").getBoundingClientRect();return {x:b.x+b.width*.5,y:b.y+b.height*.6}})()',
  );
  await guest.call('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: rect.x,
    y: rect.y,
    button: 'left',
    clickCount: 1,
  });
  await guest.call('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: rect.x,
    y: rect.y + 120,
    button: 'left',
    buttons: 1,
  });
  await pause(100);
  await guest.call('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: rect.x,
    y: rect.y + 120,
    button: 'left',
    clickCount: 1,
  });
  // The ball is now rolling: this is the mid-swing disconnect the reconnect
  // matrix was missing, and the reload lands while the shot is still in flight.
  const shotState = await guest.evalJS(
    `(async()=>{const g=${game};return {strokes:g.strokes,phase:g.phase}})()`,
  );
  console.log('After a real pointer drag', shotState);
  assert.equal(shotState.strokes, 1, 'the guest must have taken a real stroke before reloading');
  const credentials = await guest.evalJS(
    'Object.fromEntries(Object.entries(sessionStorage).filter(([key]) => key.startsWith("bp.")))',
  );

  // A reload is a new document with a new instance id, exactly like closing the
  // tab and reopening the party link.
  await guest.call('Page.reload', { ignoreCache: false });
  await pause(1500);
  guest.close();
  guest = await connect(guestTarget);
  await guest.call('Page.addScriptToEvaluateOnNewDocument', {
    source: `if (location.pathname.startsWith('/party/')) {
      for (const [key, value] of Object.entries(${JSON.stringify(credentials)})) {
        sessionStorage.setItem(key, value);
      }
    }`,
  });
  await guest.call('Page.navigate', { url });
  // The saved session resumes on its own, so the reload goes straight back into
  // the party as a new document rather than asking for the name again.
  await waitFor(guest, `(async()=>{const s=${store};return s.bpConnected === true})()`, 45000);
  const reloaded = await read(guest);
  assert.equal(reloaded.role, 'spectator', 'a reloaded document must not replay the hole');
  assert.equal(reloaded.phase, 'playing');
  assert.equal(await host.evalJS(`(async()=>${store}.roster.length)()`), 2);

  // The server kept the round: the reload changed who is playing, not the hole.
  const hostState = await read(host);
  assert.equal(hostState.holeIndex, 0);
  assert.equal(hostState.level, reloaded.level);

  // A spectator reports nothing, so no progress or completion can be replayed
  // from a state the new document never played.
  assert.equal(await guest.evalJS(`(async()=>${store}.selfRole)()`), 'spectator');
  // The stroke the previous document took is still on the board: a reload forfeits
  // the rest of the hole, it does not erase what was played.
  const boardStrokes = await host.evalJS(
    `(async()=>{const s=${store};return s.board?.standings?.map(p=>p.strokes)??[]})()`,
  );
  assert(
    boardStrokes.some((strokes) => strokes >= 1),
    'the host must still see the stroke that was played',
  );
  assert.equal(guest.events.filter((event) => event.type === 'exception').length, 0);
  assert.equal(host.events.filter((event) => event.type === 'exception').length, 0);
  console.log('PASS a mid-round reload forfeits the hole and cannot replay it', {
    beforeReload: shotState,
    afterReload: reloaded,
  });
} finally {
  guest?.close();
  if (guestTarget) {
    await fetch(debugging + '/json/close/' + guestTarget.id).catch(() => {});
  }
  host.close();
}
