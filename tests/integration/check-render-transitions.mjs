import assert from 'node:assert/strict';
import { connect, waitFor } from './cdp.mjs';

// Renders every match transition against delayed packets: the guest tab holds
// the next hole's snapshots after the results screen appears and holds the
// final frames after the last results screen, proving the client never renders
// the next round or the end screen from stale state and that hidden controls
// receive no focus while the loading overlay is up.
const base = process.env.BASE || 'http://127.0.0.1:8789';
const debug = 'http://127.0.0.1:9239';
const targets = await fetch(debug + '/json/list').then((response) => response.json());
const host = await connect(targets.find((target) => target.type === 'page'));
let guest;
const store = '(await import("/assets/runtime-DL2fiDAQ.js")).E.state';
const game = '(await import("/assets/runtime-DL2fiDAQ.js")).m.state';
const read = async (client) =>
  client.evalJS(
    `(async()=>{const s=${store},g=${game};return {phase:s.phase,holeIndex:s.holeIndex,mapReady:s.mapReady,level:g.level?.name,final:!!s.final}})()`,
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
async function giveUp(client) {
  // The clicks are synthetic; keeping the tab in the background avoids the
  // software-rendered game loop starving Runtime.evaluate on the busy tab.
  const clicks = async (label) => {
    await waitFor(
      client,
      '!![...document.querySelectorAll("button")].find(x=>x.textContent===' +
        JSON.stringify(label) +
        '&&!x.disabled)',
      20000,
    );
    await client.evalJS(
      '[...document.querySelectorAll("button")].find(x=>x.textContent===' +
        JSON.stringify(label) +
        ').click()',
    );
  };
  await clicks('Give up');
  await clicks('Yes');
}

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

// A small viewport keeps the software-rendered scenes cheap enough that two
// live WebGL contexts can upload level textures without stalling for minutes;
// layout and control behaviour are unaffected.
const setSmallViewport = (client) =>
  client.call('Emulation.setDeviceMetricsOverride', {
    width: 480,
    height: 360,
    deviceScaleFactor: 1,
    mobile: false,
  });

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
  // Hold party and final frames on the guest only while the test asks for it.
  await guest.call('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      const NativeSocket = window.WebSocket;
      window.bpHeldParty = [];
      window.bpHeldFinal = [];
      // Party frames are held once their map names the given course, so the
      // results frame of the finished hole still arrives normally and only the
      // next round's frames are delayed.
      window.bpHoldPartyMapName = null;
      window.bpHoldFinal = false;
      class HoldPartySocket extends NativeSocket {
        set onmessage(handler) {
          super.onmessage = (event) => {
            let message;
            try { message = JSON.parse(event.data); } catch {}
            const holdsPartyFrame =
              message?.t === 'party' &&
              window.bpHoldPartyMapName !== null &&
              message.currentMap?.name === window.bpHoldPartyMapName;
            if (holdsPartyFrame) {
              window.bpHeldParty.push(() => handler.call(this, event));
              return;
            }
            // The end of the party arrives as both a final-phase snapshot and
            // a final standings frame; hold the pair so the guest cannot render
            // an end screen from the snapshot alone.
            const holdsFinalFrame =
              window.bpHoldFinal &&
              (message?.t === 'final' || (message?.t === 'party' && message.phase === 'final'));
            if (holdsFinalFrame) {
              window.bpHeldFinal.push(() => handler.call(this, event));
              return;
            }
            handler.call(this, event);
          };
        }
      }
      window.WebSocket = HoldPartySocket;
    `,
  });
  await guest.call('Page.navigate', { url });
  await join(guest, 'Guest');
  await expect(host, 's.roster.length===2');

  // Two-course picked playlist so the hole transition goes through the lazy
  // loader; stroke play so giving up voids the round instead of ending the match.
  await host.evalJS(
    '(async()=>{(await import("/assets/runtime-DL2fiDAQ.js")).D({timerMs:60000,elimination:false})})()',
  );
  await expect(host, '!s.config.elimination');
  await host.evalJS(
    `(()=>{let x=document.querySelector("select[aria-label='Party map selection']");x.value="picked";x.dispatchEvent(new Event("change",{bubbles:true}));})()`,
  );
  await waitFor(host, addButtons + '.length>=2', 25000);
  await addCourse(host, 0, 1);
  const firstTitle = await host.evalJS(addButtons + '[0].getAttribute("aria-label").slice(4)');
  // A different second course forces a real level reload at the hole change.
  await addCourse(host, 1, 2);
  const secondTitle = await host.evalJS(addButtons + '[1].getAttribute("aria-label").slice(4)');
  assert.notEqual(firstTitle, secondTitle);
  await host.evalJS(
    '[...document.querySelectorAll("button")].find(x=>x.textContent==="Start party").click()',
  );
  await expect(host, 's.phase==="countdown"&&s.currentMap?.name===' + JSON.stringify(firstTitle));
  await expect(host, 's.phase==="playing"&&s.mapReady&&!!g.level');
  await expect(
    guest,
    's.phase==="playing"&&s.mapReady&&g.level?.name===' + JSON.stringify(firstTitle),
  );
  console.log('Hole 1 playing', await read(host), await read(guest));

  // Finish hole 1 normally, then hold every further party frame on the guest:
  // the guest must keep showing the hole 1 results and never render the next
  // round while the hole 2 snapshots are delayed.
  // Arm the hold before the round ends: only the next hole's frames are
  // delayed, so the guest still receives and renders the hole 1 results.
  await guest.evalJS(`window.bpHoldPartyMapName=${JSON.stringify(secondTitle)}`);
  await giveUp(guest);
  await giveUp(host);
  await expect(host, 's.phase==="hole-results"');
  await expect(guest, 's.phase==="hole-results"');
  await waitFor(guest, 'window.bpHeldParty.length>=1', 20000);
  const heldState = await read(guest);
  assert.equal(heldState.holeIndex, 0);
  assert.equal(heldState.level, firstTitle);
  assert.equal(heldState.final, false);
  assert.equal(await guest.evalJS('document.body.innerText.includes("Party over")'), false);
  console.log('Guest holds hole 1 results while hole 2 snapshots are delayed', heldState);

  // Release: the guest reloads the level behind the loading overlay, hidden
  // controls receive no focus, and hole 2 renders only once ready.
  await guest.evalJS('window.bpHoldPartyMapName=null;window.bpHeldParty.splice(0).forEach(r=>r())');
  await waitFor(guest, '!!document.querySelector(".bp-party-loading")', 15000);
  await guest.call('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Tab',
    code: 'Tab',
    windowsVirtualKeyCode: 9,
  });
  await guest.call('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Tab',
    code: 'Tab',
    windowsVirtualKeyCode: 9,
  });
  // Read overlay, HUD visibility and focus in one evaluation so the overlay
  // cannot disappear between separate round trips.
  const overlayState = await waitFor(
    guest,
    `(()=>{const overlay=document.querySelector(".bp-party-loading");if(!overlay)return null;const hud=document.querySelector("[data-overview-hud-root]");const active=document.activeElement;return {hudVisibility:hud?getComputedStyle(hud).visibility:"absent",activeInHiddenHud:!!active?.closest?.("[data-overview-hud-root]")};})()`,
    15000,
  );
  assert.equal(overlayState.hudVisibility, 'hidden');
  assert.equal(overlayState.activeInHiddenHud, false);
  await expect(
    guest,
    's.phase==="playing"&&s.holeIndex===1&&s.mapReady&&g.level?.name===' +
      JSON.stringify(secondTitle),
    240000,
  );
  await expect(host, 's.phase==="playing"&&s.holeIndex===1&&s.mapReady');
  console.log('Guest recovered to hole 2 after release', await read(guest));

  // Hold only the final frames on the guest: the guest processes the hole 2
  // results normally but must keep them until the final frames are delivered.
  await guest.evalJS('window.bpHoldFinal=true');
  await giveUp(guest);
  await giveUp(host);
  await expect(host, 's.phase==="final"', 240000);
  // Only the final frames were armed, so the held party count stays empty.
  await waitFor(guest, 'window.bpHeldFinal.length>=1', 20000);
  const heldFinal = await read(guest);
  assert.equal(heldFinal.phase, 'hole-results');
  assert.equal(heldFinal.final, false);
  assert.equal(await guest.evalJS('document.body.innerText.includes("Party over")'), false);
  console.log('Guest holds hole 2 results while final frames are delayed', heldFinal);
  await guest.evalJS('window.bpHoldFinal=false;window.bpHeldFinal.splice(0).forEach(r=>r())');
  await expect(guest, 's.phase==="final"');
  await waitFor(guest, 'document.body.innerText.includes("Party over")');
  assert.equal(host.events.filter((event) => event.type === 'exception').length, 0);
  assert.equal(guest.events.filter((event) => event.type === 'exception').length, 0);
  console.log('PASS delayed hole and final frames never render stale or premature rounds');
} finally {
  guest?.close();
  host.close();
}
