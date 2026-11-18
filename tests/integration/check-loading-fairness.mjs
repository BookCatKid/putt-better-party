import assert from 'node:assert/strict';
import { connect, waitFor } from './cdp.mjs';
import { closePlaylistEditor, openPlaylistEditor } from './playlist-editor.mjs';

// Proves that a client still loading its level does not eat into the round:
// the guest's renderer readiness frame is held back by several seconds, and the
// host must stay in countdown with an untouched timer until it arrives.
const base = process.env.BASE || 'http://127.0.0.1:8789';
const debug = 'http://127.0.0.1:9239';
const targets = await fetch(debug + '/json/list').then((response) => response.json());
const host = await connect(targets.find((target) => target.type === 'page'));
let guest;
const store = '(await import("/assets/runtime-DL2fiDAQ.js")).E.state';
const game = '(await import("/assets/runtime-DL2fiDAQ.js")).m.state';
const read = async (client) =>
  client.evalJS(
    `(async()=>{const s=${store},g=${game};return {phase:s.phase,holeIndex:s.holeIndex,mapReady:s.mapReady,awaitingPlayers:s.awaitingPlayers,startAt:s.startAt,timerEndsAt:s.timerEndsAt,level:g.level?.name}})()`,
  );
const expect = async (client, cond, ms = 30000) =>
  waitFor(
    client,
    `(async()=>{const s=${store},g=${game};return (${cond})&&!document.querySelector(".bp-party-loading")})()`,
    ms,
  );
const join = async (client, name) => {
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
  await expect(client, 's.roster.length>0 && s.mapReady && !!g.level', 45000);
};

const addButtons =
  '[...document.querySelectorAll("button")].filter(b=>b.getAttribute("aria-label")?.startsWith("Add "))';

// The import endpoint proxies a live fetch to putt.day and can fail
// transiently; the picker surfaces the error and re-enables the button.
async function addCourse(client, index, expectedCount) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    await client.evalJS(`${addButtons}[${index}].click()`);
    try {
      await expect(client, `s.config.selectedHoleIds?.length===${expectedCount}`, 20000);
      return;
    } catch {
      // Retry the same card.
    }
  }
  throw Error(`Adding course card ${index} kept failing`);
}

const setSmallViewport = (client) =>
  client.call('Emulation.setDeviceMetricsOverride', {
    width: 480,
    height: 360,
    deviceScaleFactor: 1,
    mobile: false,
  });

// How long the guest pretends to still be loading its level: longer than the
// five second countdown, comfortably shorter than the ten second readiness
// grace, so the wait ends with the report rather than with the deadline.
const HELD_READY_MS = 6000;

try {
  await setSmallViewport(host);
  await host.call('Page.navigate', { url: base + '/home' });
  await waitFor(host, 'typeof document.querySelector("#create")?.onclick === "function"');
  await host.evalJS('document.querySelector("#create").click()');
  await join(host, 'Host');
  const url = await host.evalJS('location.href');
  const target = await fetch(debug + '/json/new', { method: 'PUT' }).then((response) =>
    response.json(),
  );
  guest = await connect(target);
  await setSmallViewport(guest);

  // Hold the guest's scene readiness frame, exactly as a client that is still
  // uploading level textures would delay it.
  await guest.call('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      const bpNativeSend = WebSocket.prototype.send;
      window.bpHeldScene = [];
      window.bpHoldScene = false;
      WebSocket.prototype.send = function (data) {
        let message;
        try { message = JSON.parse(data); } catch {}
        if (window.bpHoldScene && message?.t === 'scene') {
          window.bpHeldScene.push([this, data]);
          return;
        }
        return bpNativeSend.call(this, data);
      };
      window.bpReleaseScene = () => {
        window.bpHoldScene = false;
        for (const [socket, data] of window.bpHeldScene.splice(0)) {
          bpNativeSend.call(socket, data);
        }
      };
    `,
  });
  await guest.call('Page.navigate', { url });
  await join(guest, 'Guest');
  await expect(host, 's.roster.length===2');
  // Arm the hold before the party starts so the very first readiness report is
  // the delayed one.
  assert.equal(
    await guest.evalJS('Array.isArray(window.bpHeldScene)'),
    true,
    'the readiness hold must be installed in the guest page',
  );
  await guest.evalJS('window.bpHoldScene=true');

  // One live public course, lazily imported; stroke play so the round cannot
  // end early and the countdown gate is the only thing holding the start.
  await host.evalJS(
    '(async()=>{(await import("/assets/runtime-DL2fiDAQ.js")).D({timerMs:60000,elimination:false})})()',
  );
  await expect(host, '!s.config.elimination');
  await host.evalJS(
    `(()=>{let x=document.querySelector("select[aria-label='Party map selection']");x.value="picked";x.dispatchEvent(new Event("change",{bubbles:true}));})()`,
  );
  await openPlaylistEditor(host);
  await waitFor(host, addButtons + '.length>=1', 25000);
  await addCourse(host, 0, 1);
  await closePlaylistEditor(host);
  await host.evalJS(
    '[...document.querySelectorAll("button")].find(x=>x.textContent==="Start party").click()',
  );
  await expect(host, 's.phase==="countdown"');
  const countdownStart = Date.now();
  // The host loads and reports, so only the guest is left: the gate keeps the
  // round in countdown and names how many clients it is still waiting for.
  const waiting = await waitFor(
    host,
    `(async()=>{const s=${store};return s.phase==="countdown"&&s.awaitingPlayers===1?s:null})()`,
    20000,
  );
  console.log('Host countdown is waiting for the slow client', {
    awaitingPlayers: waiting.awaitingPlayers,
    timerEndsAt: waiting.timerEndsAt,
  });

  // The wait is visible to the host, not a silent freeze.
  const hostControls = 'document.querySelector(`[aria-label="Party controls"]`)';
  await host.evalJS(hostControls + '.click()');
  const hostNotice = await waitFor(
    host,
    `(()=>{const panel=document.querySelector(".bp-host-panel");if(!panel)return null;const notice=panel.querySelector('[role="status"]');return notice&&/finish loading/.test(notice.textContent)?notice.textContent:null})()`,
    10000,
  );
  console.log('Host sees the wait', hostNotice);
  await host.evalJS(hostControls + '.click()');

  // Outlast the countdown window: without the gate this would already be
  // playing and the round timer would be running down.
  await new Promise((resolve) => setTimeout(resolve, HELD_READY_MS));
  const stillWaiting = await read(host);
  assert.equal(stillWaiting.phase, 'countdown');
  assert.ok(Date.now() - countdownStart > 5000, 'the countdown window elapsed');
  // No round time has been consumed: the client only starts its round timer on
  // the playing phase, and nothing here has started it.
  assert.equal(stillWaiting.timerEndsAt, 0);
  // The guest is genuinely still behind: no scene readiness reached the server.
  assert.equal(await guest.evalJS('window.bpHeldScene.length'), 1);
  console.log('Timer untouched while the slow client loads', {
    phase: stillWaiting.phase,
    awaitingPlayers: stillWaiting.awaitingPlayers,
    timerEndsAt: stillWaiting.timerEndsAt,
  });

  await guest.evalJS('window.bpReleaseScene()');
  await expect(host, 's.phase==="playing"', 30000);
  await expect(guest, 's.phase==="playing"&&s.mapReady', 60000);
  const playing = await read(host);
  assert.equal(playing.awaitingPlayers, 0);
  // The round started when play started, so the host has the whole timer.
  assert.ok(
    playing.timerEndsAt - Date.now() > 50_000,
    `expected a full round timer, got ${playing.timerEndsAt - Date.now()}ms`,
  );
  console.log('Play started with the full round timer', {
    phase: playing.phase,
    remainingMs: playing.timerEndsAt - Date.now(),
  });
  assert.equal(host.events.filter((event) => event.type === 'exception').length, 0);
  assert.equal(guest.events.filter((event) => event.type === 'exception').length, 0);
  console.log('PASS a slow-loading client never consumes round time');
} finally {
  guest?.close();
  host.close();
}
