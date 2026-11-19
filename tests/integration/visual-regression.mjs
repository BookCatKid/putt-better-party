import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect, waitFor, pause } from './cdp.mjs';

/*
 * Visual baseline capture for the approved screens.
 *
 * Run under the shared browser harness:
 *
 *   BROWSER_SCRIPT=tests/integration/visual-regression.mjs \
 *     VISUAL_DIR=tests/visual-baseline bun run test:browser
 *
 * writes one PNG per named screen into VISUAL_DIR (default
 * tests/visual-baseline/). Re-run with a different VISUAL_DIR after a change
 * and compare with:
 *
 *   bun tests/visual-diff.mjs tests/visual-baseline <fresh-dir>
 *
 * Baselines are deliberately machine-local (font rasterisation and WebGL
 * output differ between platforms), which is why the directory is gitignored:
 * capture once per machine, then diff after an intentional change instead of
 * eyeballing a redesign.
 *
 * Two determinism rules keep diffs meaningful:
 *
 *  - The live WebGL canvas is hidden for party-surface captures. The lobby
 *    overlay is bg-black/55 over the running scene, which is never
 *    pixel-stable; hiding the canvas leaves a flat background and diffs only
 *    the authored chrome. (This is also why screenshots are never functional
 *    proof — the check-* suites measure layout and behaviour.)
 *  - Upstream data is redacted to fixed strings before the shot: course
 *    titles, authors, ratings, daily badges, thumbnails and the invite code
 *    all vary run to run, so unredacted captures would flag upstream drift
 *    rather than our changes. Card structure, spacing and controls are left
 *    fully intact.
 *
 * Captures cover the surfaces we own deterministically: home, name entry, the
 * lobby dashboard at desktop and mobile widths, and the playlist dialog with
 * a real imported playlist. Transient states (the 12s-bounded loading screen),
 * live-data surfaces (leaderboard, vote, in-play HUD) are covered by the
 * behavioural suites instead, where a wrong pixel cannot pass anyway.
 */

const base = process.env.BASE || 'http://127.0.0.1:8789';
const visualDir = process.env.VISUAL_DIR || 'tests/visual-baseline';
const debugging = 'http://127.0.0.1:9239';
const target = (await fetch(debugging + '/json/list').then((response) => response.json())).find(
  (entry) => entry.type === 'page',
);
const client = await connect(target);
const runtime = '(await import("/assets/runtime-DL2fiDAQ.js"))';
mkdirSync(visualDir, { recursive: true });

const viewport = (width, height, mobile = width < 700) =>
  client.call('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile,
  });
const click = (title) =>
  client.evalJS(
    '[...document.querySelectorAll("button")].find(b=>b.textContent===' +
      JSON.stringify(title) +
      ').click()',
  );
const name = async (value) => {
  await waitFor(client, 'document.querySelector("input")?.placeholder==="Your name"');
  await client.evalJS(
    '(()=>{const el=document.querySelector("input");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(el,' +
      JSON.stringify(value) +
      ');el.dispatchEvent(new Event("input",{bubbles:true}))})()',
  );
  await click('Join');
};
const shoot = async (file) => {
  // Let layout and font shaping settle before freezing the pixels.
  await pause(400);
  const shot = await client.call('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(visualDir, file), Buffer.from(shot.data, 'base64'));
  console.log('captured', file);
};

/* Replace run-varying data with fixed strings; structure is untouched. */
const redact = () =>
  client.evalJS(`(() => {
    // The invite code and each player's ball swatch are per-run data, like the
    // catalog fields: fixed here so a diff flags our chrome, not the RNG.
    const code = document.querySelector('.bp-dashboard-code');
    if (code) code.textContent = 'ABCDE';
    const joinCode = document.querySelector('.bp-join-code strong');
    if (joinCode) joinCode.textContent = 'ABCDE';
    document.querySelectorAll('.bp-dashboard-player-list li .rounded-full').forEach((swatch) => {
      swatch.style.background = '#34d399';
    });
    document.querySelectorAll('canvas').forEach((canvas) => {
      canvas.style.visibility = 'hidden';
    });
    document.querySelectorAll('.bp-catalog-scroll > ul > li').forEach((card, index) => {
      card.querySelectorAll('img').forEach((img) => { img.style.visibility = 'hidden'; });
      const title = card.querySelector('.p-3 a');
      if (title) title.textContent = 'Course ' + (index + 1);
      const badge = [...card.querySelectorAll('a')].find((a) => a.textContent.startsWith('Daily #'));
      if (badge) badge.textContent = 'Daily #7';
      const byline = card.querySelector('.p-3 p');
      if (byline) byline.textContent = 'by Maker · today';
      const rating = card.querySelector('.p-3 .mt-2');
      if (rating) {
        rating.firstElementChild.textContent = '★★★★☆ 4.0 (12)';
        rating.lastElementChild.textContent = '⛳ 99';
      }
    });
    document.querySelectorAll('.bp-playlist-item').forEach((item, index) => {
      item.querySelectorAll('img, .bp-thumb-fallback').forEach((img) => { img.style.visibility = 'hidden'; });
      const title = item.querySelector('p, span');
      if (title) title.textContent = 'Course ' + (index + 1);
    });
    const more = document.querySelector('.bp-catalog-scroll .mt-6');
    if (more) more.textContent = 'More courses';
    return true;
  })()`);

const guests = [];
async function joinGuest(code, index) {
  const response = await fetch(base + '/api/join', {
    method: 'POST',
    headers: { origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({ code, name: 'Guest ' + index }),
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
  guest.send(JSON.stringify({ t: 'join', ...identity, protocol: 2, instance: 'visual-' + index }));
}

try {
  /* Home. */
  await viewport(1280, 800, false);
  await client.call('Page.navigate', { url: base + '/home' });
  await waitFor(client, 'typeof document.querySelector("#create")?.onclick==="function"');
  await shoot('home-desktop.png');
  await viewport(390, 844);
  await shoot('home-mobile.png');

  /* Name entry, then the joined lobby dashboard. */
  await viewport(1280, 800, false);
  await client.evalJS('document.querySelector("#create").click()');
  await waitFor(client, '!!document.querySelector(".bp-join-code")');
  await redact();
  await shoot('entry-desktop.png');
  await name('Baseline host');
  await waitFor(
    client,
    '(async()=>{const s=' + runtime + '.E.state;return s.bpConnected&&s.mapReady})()',
    60000,
  );
  await waitFor(client, '!!document.querySelector(".bp-dashboard")');
  const code = await client.evalJS('document.querySelector(".bp-dashboard-code").textContent');
  await Promise.all([joinGuest(code, 'A'), joinGuest(code, 'B')]);
  await waitFor(client, 'document.querySelectorAll(".bp-dashboard-player-list > li").length===3');
  await redact();
  await shoot('lobby-desktop.png');
  await viewport(390, 844);
  await shoot('lobby-mobile.png');

  /* The playlist dialog over a real imported playlist. */
  await viewport(1280, 800, false);
  const catalog = await fetch(base + '/api/catalog?sort=new').then((response) => response.json());
  const ids = catalog.holes.slice(0, 3).map((hole) => hole.id);
  for (const id of ids) {
    const status = await client.evalJS(
      '(async()=>{const s=' +
        runtime +
        '.E.state;const response=await fetch("/api/import",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({code:s.code,uid:s.self.uid,session:s.self.session,host:sessionStorage.getItem("bp.host."+s.code),id:' +
        JSON.stringify(id) +
        '})});return response.status})()',
      30000,
    );
    if (status !== 200) {
      throw Error('import of catalog course failed: ' + status);
    }
  }
  await client.evalJS(
    '(async()=>{const r=' +
      runtime +
      ';r.D({mapSource:"picked",selectedHoleIds:' +
      JSON.stringify(ids) +
      '})})()',
  );
  await waitFor(
    client,
    'document.querySelector(".bp-picker-summary")?.textContent.includes("3 courses selected")',
  );
  await click('Edit playlist');
  await waitFor(client, 'document.querySelector(".bp-playlist-dialog")?.open', 20000);
  await waitFor(
    client,
    'document.querySelectorAll(".bp-playlist-scroll .bp-playlist-item").length===3',
  );
  await waitFor(
    client,
    'document.querySelectorAll(".bp-catalog-scroll > ul > li").length>=6',
    45000,
  );
  await redact();
  await shoot('dialog-desktop.png');
  await viewport(390, 844);
  await redact();
  await shoot('dialog-mobile.png');

  console.log('visual-regression: captured to ' + visualDir);
} finally {
  for (const guest of guests) {
    guest.close();
  }
  client.close();
}
process.exit(0);
