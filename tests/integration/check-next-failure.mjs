import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { connect, waitFor } from './cdp.mjs';
import { closePlaylistEditor, openPlaylistEditor } from './playlist-editor.mjs';

// Exercises the recoverable next-course failure against the real client: the
// server is started with BP_TEST_FAIL_MAP_FETCH_CALL=1 so the first lazy load
// after hole 1 rejects, the host retries through the UI and the match continues.
const debug = 'http://127.0.0.1:9239';
const port = 8792;
const base = 'http://127.0.0.1:' + port;
const dir = await mkdtemp(path.join(tmpdir(), 'better-party-next-failure-'));
const store = '(await import("/assets/runtime-DL2fiDAQ.js")).E.state';
const game = '(await import("/assets/runtime-DL2fiDAQ.js")).m.state';
let server;
let guest;

const read = async (client) =>
  client.evalJS(
    `(async()=>{const s=${store},g=${game};return {phase:s.phase,holeIndex:s.holeIndex,nextError:s.nextError,mapReady:s.mapReady,level:g.level?.name,strokes:g.strokes}})()`,
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
  await client.call('Page.bringToFront');
  await waitFor(
    client,
    '!![...document.querySelectorAll("button")].find(x=>x.textContent==="Give up")',
    10000,
  );
  await client.evalJS(
    '[...document.querySelectorAll("button")].find(x=>x.textContent==="Give up").click()',
  );
  await client.evalJS(
    '[...document.querySelectorAll("button")].find(x=>x.textContent==="Yes").click()',
  );
}

try {
  server = Bun.spawn(['bun', 'src/server.ts'], {
    env: {
      ...process.env,
      PORT: String(port),
      BP_DB: path.join(dir, 'rooms.sqlite'),
      BP_TEST_FAIL_MAP_FETCH_CALL: '1',
    },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const healthWait = async (ms = 30000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      try {
        if ((await fetch(base + '/health')).ok) {
          return;
        }
      } catch {}
      await Bun.sleep(50);
    }
    throw Error('Timed out waiting for the injected-failure server');
  };
  await healthWait();

  const targets = await fetch(debug + '/json/list').then((response) => response.json());
  const host = await connect(targets.find((target) => target.type === 'page'));
  await host.call('Page.navigate', { url: base + '/home' });
  await waitFor(host, 'typeof document.querySelector("#create")?.onclick === "function"');
  await host.evalJS('document.querySelector("#create").click()');
  await join(host, 'Host');
  const url = await host.evalJS('location.href');
  const target = await fetch(debug + '/json/new?' + encodeURIComponent(url), {
    method: 'PUT',
  }).then((response) => response.json());
  guest = await connect(target);
  await join(guest, 'Guest');
  await expect(host, 's.roster.length===2');

  // Two-course picked playlist: preparation fetches only the first course, so
  // the transition to hole 2 goes through the lazy loadNext path that the
  // injected failure targets. Elimination is disabled so giving up voids the
  // round instead of ending the match.
  await host.evalJS(
    '(async()=>{(await import("/assets/runtime-DL2fiDAQ.js")).D({elimination:false})})()',
  );
  await expect(host, '!s.config.elimination');
  await host.evalJS(
    `(()=>{let x=document.querySelector("select[aria-label='Party map selection']");x.value="picked";x.dispatchEvent(new Event("change",{bubbles:true}));})()`,
  );
  const addFirst =
    '[...document.querySelectorAll("button")].find(b=>b.getAttribute("aria-label")?.startsWith("Add "))';
  await openPlaylistEditor(host);
  await waitFor(host, '!!' + addFirst, 25000);
  await host.evalJS(addFirst + '.click()');
  await expect(host, 's.config.selectedHoleIds?.length===1');
  await host.evalJS(addFirst + '.click()');
  await expect(host, 's.config.selectedHoleIds?.length===2');
  await closePlaylistEditor(host);
  await host.evalJS(
    '[...document.querySelectorAll("button")].find(x=>x.textContent==="Start party").click()',
  );
  await expect(host, 's.phase==="countdown"');
  await expect(guest, 's.phase==="countdown"||s.phase==="playing"');
  await expect(host, 's.phase==="playing"&&s.mapReady&&!!g.level');
  await expect(guest, 's.phase==="playing"&&s.mapReady&&!!g.level');
  console.log('Both clients playing hole 1', await read(host), await read(guest));

  await giveUp(guest);
  await giveUp(host);
  await expect(host, 's.phase==="hole-results"&&!!s.nextError');
  await expect(guest, 's.phase==="hole-results"&&!!s.nextError');
  const failure = (await read(host)).nextError;
  assert.match(failure, /Injected next-course fetch failure/);
  console.log('Next-course load failed recoverably:', failure);

  // The host panel offers retry and skip; the guest sees the alert banner.
  await host.call('Page.bringToFront');
  await host.evalJS('document.querySelector("button[aria-label=\'Party controls\']").click()');
  await waitFor(
    host,
    '!![...document.querySelectorAll("button")].find(x=>x.textContent==="Retry next hole")',
  );
  assert.equal(
    await host.evalJS(
      '!![...document.querySelectorAll("button")].find(x=>x.textContent==="Skip unloaded hole")',
    ),
    true,
  );
  assert.equal(await guest.evalJS('!!document.querySelector("p[role=alert]")'), true);

  // Retrying performs a fresh lazy load, which succeeds, and the match resumes.
  await host.evalJS(
    '[...document.querySelectorAll("button")].find(x=>x.textContent==="Retry next hole").click()',
  );
  await expect(host, 's.phase==="playing"&&s.holeIndex===1&&s.mapReady&&!s.nextError');
  await expect(guest, 's.phase==="playing"&&s.holeIndex===1&&s.mapReady&&!s.nextError');
  assert.equal(await host.evalJS(`(async()=>${store}.nextError)()`), null);
  assert.equal(await guest.evalJS('!!document.querySelector("p[role=alert]")'), false);
  console.log('Retry recovered the match:', await read(host), await read(guest));

  await giveUp(guest);
  await giveUp(host);
  await expect(host, 's.phase==="final"', 15000);
  await expect(guest, 's.phase==="final"', 15000);
  await waitFor(host, 'document.body.innerText.includes("Party over")');
  await waitFor(guest, 'document.body.innerText.includes("Party over")');
  assert.equal(host.events.filter((event) => event.type === 'exception').length, 0);
  assert.equal(guest.events.filter((event) => event.type === 'exception').length, 0);
  console.log('PASS next-course failure is recoverable through the host UI');
} finally {
  guest?.close();
  server?.kill();
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}
