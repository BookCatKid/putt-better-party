import assert from 'node:assert/strict';
import { connect, waitFor } from './cdp.mjs';

// Proves host hand-over in real clients: the host picks a player from the party
// controls mid-match, both clients learn about it immediately, the new host can
// act and the old one cannot, and a deliberate departure hands the crown on at
// once instead of waiting out the reconnect grace period.
const base = process.env.BASE || 'http://127.0.0.1:8789';
const debug = 'http://127.0.0.1:9239';
const targets = await fetch(debug + '/json/list').then((response) => response.json());
const host = await connect(targets.find((target) => target.type === 'page'));
let guest;
const store = '(await import("/assets/runtime-DL2fiDAQ.js")).E.state';
const game = '(await import("/assets/runtime-DL2fiDAQ.js")).m.state';
const read = async (client) =>
  client.evalJS(
    `(async()=>{const s=${store};return {phase:s.phase,isHost:s.isHost,roster:s.roster.map(p=>({name:p.name,isHost:p.isHost})),timerMs:s.config.timerMs}})()`,
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
const setSmallViewport = (client) =>
  client.call('Emulation.setDeviceMetricsOverride', {
    width: 480,
    height: 360,
    deviceScaleFactor: 1,
    mobile: false,
  });
const openHostControls = async (client) => {
  const controls = 'document.querySelector(`[aria-label="Party controls"]`)';
  await waitFor(client, '!!' + controls, 20000);
  if ((await client.evalJS(controls + '.getAttribute("aria-expanded")')) !== 'true') {
    await client.evalJS(controls + '.click()');
  }
  await waitFor(client, '!!document.querySelector(".bp-host-panel")');
};
const addButtons =
  '[...document.querySelectorAll("button")].filter(b=>b.getAttribute("aria-label")?.startsWith("Add "))';
const capabilityOf = (client) =>
  client.evalJS(
    `(()=>{const code=sessionStorage.getItem("bp.lastRoom");return code?sessionStorage.getItem("bp.host."+code):null})()`,
  );

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
  await guest.call('Page.navigate', { url });
  await join(guest, 'Guest');
  await expect(host, 's.roster.length===2');
  await expect(guest, 's.roster.length===2&&!s.isHost');

  // One live course, stroke play, long timer: the party stays in playing while
  // the hand-over happens.
  await host.evalJS(
    '(async()=>{(await import("/assets/runtime-DL2fiDAQ.js")).D({timerMs:300000,elimination:false})})()',
  );
  await expect(host, '!s.config.elimination');
  await host.evalJS(
    `(()=>{let x=document.querySelector("select[aria-label='Party map selection']");x.value="picked";x.dispatchEvent(new Event("change",{bubbles:true}));})()`,
  );
  await waitFor(host, addButtons + '.length>=1', 25000);
  await host.evalJS(`${addButtons}[0].click()`);
  await expect(host, 's.config.selectedHoleIds?.length===1', 20000);
  const originalCapability = await capabilityOf(host);
  assert.equal(typeof originalCapability, 'string');

  await host.evalJS(
    '[...document.querySelectorAll("button")].find(x=>x.textContent==="Start party").click()',
  );
  await expect(host, 's.phase==="playing"');
  await expect(guest, 's.phase==="playing"');

  // The host sees who is eligible and hands the crown over from the menu.
  await openHostControls(host);
  const offered = await waitFor(
    host,
    `(()=>{const panel=document.querySelector(".bp-host-panel");if(!panel)return null;const names=[...panel.querySelectorAll(".bp-host-transfer button")].map(b=>b.textContent);return names.length?names:null})()`,
    15000,
  );
  assert.deepEqual(offered, ['Guest'], 'only the other connected player is offered');
  console.log('Host is offered the connected guest', offered);
  await host.evalJS(
    '[...document.querySelectorAll(".bp-host-transfer button")].find(b=>b.textContent.startsWith("Guest")).click()',
  );

  // Both clients learn about it at once, mid-round, with no reconnect.
  await expect(guest, 's.isHost===true');
  await expect(host, 's.isHost===false');
  await expect(guest, 's.roster.find(p=>p.uid===s.self.uid)?.isHost===true');
  await expect(host, 's.roster.find(p=>p.uid===s.self.uid)?.isHost===false');
  await expect(host, '!document.querySelector(".bp-host-control")');
  assert.equal((await read(host)).phase, 'playing');
  console.log('Authority moved to the guest mid-round with no reconnect');

  // The capability moved with the crown, so privileged calls follow authority.
  assert.equal(await capabilityOf(host), null);
  const newCapability = await capabilityOf(guest);
  assert.equal(typeof newCapability, 'string');
  assert.notEqual(newCapability, originalCapability);

  // The new host can act and the effect reaches both clients.
  await openHostControls(guest);
  await guest.evalJS(
    '[...document.querySelectorAll(".bp-host-item")].find(b=>b.textContent==="+30s").click()',
  );
  await expect(guest, '!document.querySelector(".bp-host-panel")');
  await expect(host, 's.timerEndsAt>0');
  const extended = await read(guest);
  assert.ok(extended.timerMs >= 300000, 'the timer extension reached the new host');
  // The party ends on the new host's authority, not the old one's.
  await openHostControls(guest);
  await guest.evalJS(
    '[...document.querySelectorAll(".bp-host-item")].find(b=>b.textContent==="End party").click()',
  );
  await guest.evalJS(
    '[...document.querySelectorAll(".bp-host-item")].find(b=>b.textContent==="Confirm").click()',
  );
  await expect(guest, 's.phase==="final"');
  await expect(host, 's.phase==="final"');
  console.log('New host drives the party; the old host has no controls');

  // A deliberate departure hands the crown back at once rather than waiting out
  // the reconnect grace period, so nobody is left without a host.
  await waitFor(
    guest,
    '!![...document.querySelectorAll("a")].find(a=>a.textContent==="Leave party")',
    30000,
  );
  await guest.evalJS(
    '[...document.querySelectorAll("a")].find(a=>a.textContent==="Leave party").click()',
  );
  await expect(host, 's.isHost===true', 20000);
  await expect(host, 's.roster.length===1');
  console.log('Departing host hands the crown back immediately');

  assert.equal(host.events.filter((event) => event.type === 'exception').length, 0);
  assert.equal(guest.events.filter((event) => event.type === 'exception').length, 0);
  console.log('PASS host authority transfers, revokes and succeeds');
} finally {
  guest?.close();
  host.close();
}
