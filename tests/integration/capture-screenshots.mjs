/**
 * Capture the screenshots the README shows.
 *
 * Unlike `visual-regression.mjs`, nothing here is redacted and the WebGL canvas
 * is left visible: these images exist to show a reader what the product looks
 * like, so hiding the game or replacing course titles with "Course 1" would
 * defeat the purpose. That also means they cannot double as visual baselines —
 * the course a screenshot shows changes upstream — so they are committed to
 * `docs/screenshots/` as documentation, not compared by any test.
 *
 * The captures are from a real prepared client against a real service and a real
 * public catalogue, with a real second player joined over the protocol. Nothing
 * is mocked or drawn by hand.
 *
 * Usage, with a service already running on BASE:
 *
 *   bun run capture:screenshots
 *
 * Re-run it after an intentional UI change and commit the result.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect, waitFor, pause } from './cdp.mjs';

const base = process.env.BASE || 'http://127.0.0.1:8789';
const outputDir = process.env.SCREENSHOT_DIR || 'docs/screenshots';
const debugging = 'http://127.0.0.1:9239';

mkdirSync(outputDir, { recursive: true });

const targets = await fetch(debugging + '/json/list').then((response) => response.json());
const client = await connect(targets.find((entry) => entry.type === 'page'));
const runtime = '(await import("/assets/runtime-DL2fiDAQ.js"))';

const viewport = (width, height, mobile = width < 700) =>
  client.call('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 2,
    mobile,
  });

const click = (label) =>
  client.evalJS(
    '[...document.querySelectorAll("button")].find(b=>b.textContent===' +
      JSON.stringify(label) +
      ').click()',
  );

const shoot = async (file) => {
  // Font shaping and the level's first frames are not instant; a shot taken too
  // early shows a half-drawn scene.
  await pause(900);
  const shot = await client.call('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(outputDir, file), Buffer.from(shot.data, 'base64'));
  console.log('captured', join(outputDir, file));
};

const guests = [];
async function joinGuest(code, name) {
  const response = await fetch(base + '/api/join', {
    method: 'POST',
    headers: { origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({ code, name }),
  });
  const identity = await response.json();
  const guest = new WebSocket(base.replace('http', 'ws') + '/ws/party/' + code, {
    headers: { origin: base },
  });
  guests.push(guest);
  await new Promise((resolve, reject) => {
    guest.onopen = resolve;
    guest.onerror = reject;
  });
  guest.send(JSON.stringify({ t: 'join', ...identity, protocol: 2, instance: 'shot-' + name }));
  return identity;
}

try {
  /* The home screen: what someone sees first. */
  await viewport(1280, 800, false);
  await client.call('Page.navigate', { url: base + '/home' });
  await waitFor(client, 'typeof document.querySelector("#create")?.onclick==="function"');
  await shoot('home.png');

  /* Create a party and name the host. */
  await client.evalJS('document.querySelector("#create").click()');
  await waitFor(client, 'document.querySelector("input")?.placeholder==="Your name"');
  await client.evalJS(
    '(()=>{const el=document.querySelector("input");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(el,"Host");el.dispatchEvent(new Event("input",{bubbles:true}))})()',
  );
  await click('Join');

  /* The lobby, with a full compliment of players. */
  await waitFor(
    client,
    '(async()=>{const s=' + runtime + '.E.state;return s.bpConnected&&s.mapReady})()',
    90000,
  );
  await waitFor(client, '!!document.querySelector(".bp-dashboard")');
  const code = await client.evalJS('document.querySelector(".bp-dashboard-code").textContent');
  await Promise.all([joinGuest(code, 'Ada'), joinGuest(code, 'Grace'), joinGuest(code, 'Alan')]);
  await waitFor(client, 'document.querySelectorAll(".bp-dashboard-player-list > li").length===4');
  await shoot('lobby.png');

  /* Build a playlist from real public courses. */
  const catalog = await fetch(base + '/api/catalog?sort=top').then((response) => response.json());
  // The newest listing can include a course the pinned validator refuses, so the
  // shot uses the highest-rated page and skips anything that will not import.
  const chosen = [];
  for (const hole of catalog.holes) {
    const status = await client.evalJS(
      '(async()=>{const s=' +
        runtime +
        '.E.state;const response=await fetch("/api/import",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({code:s.code,uid:s.self.uid,session:s.self.session,host:sessionStorage.getItem("bp.host."+s.code),id:' +
        JSON.stringify(hole.id) +
        '})});return response.status})()',
      30000,
    );
    if (status === 200) {
      chosen.push(hole.id);
    }
    if (chosen.length === 3) {
      break;
    }
  }
  if (chosen.length === 0) {
    throw Error('no catalog course could be imported for the playlist screenshot');
  }
  await client.evalJS(
    '(async()=>{const r=' +
      runtime +
      ';r.D({mapSource:"picked",selectedHoleIds:' +
      JSON.stringify(chosen) +
      '})})()',
  );
  await click('Edit playlist');
  await waitFor(client, 'document.querySelectorAll(".bp-catalog-scroll li").length>0', 45000);
  await shoot('playlist.png');
  await click('Done');
  // The picker covers the lobby, so the next shot is only the intended screen
  // once it is gone.
  await waitFor(client, '!document.querySelector(".bp-catalog-scroll")', 15000);

  /* Start the party and wait for the hole itself. */
  await click('Start party');
  await waitFor(
    client,
    '(async()=>{const s=' +
      runtime +
      '.E.state;const g=' +
      runtime +
      '.m.state;return s.phase==="playing"&&g.phase==="aiming"})()',
    120000,
  );
  await shoot('in-game.png');

  /* The same hole on a phone, to show the layout holds up. */
  await viewport(390, 844);
  await pause(1200);
  await shoot('in-game-mobile.png');
} finally {
  for (const guest of guests) {
    guest.close();
  }
  client.close();
}
