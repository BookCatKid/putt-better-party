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
 *
 * ## Why re-captures are byte-stable
 *
 * A documentation screenshot that changes on every re-run makes every diff
 * review worthless: a real UI change is then indistinguishable from the shot
 * being taken a second later. Five things varied. Each is pinned by the cheapest
 * means that does not hide what the product actually renders.
 *
 *  - **Ball colours.** `Room.issue` draws a random hue per player, so every
 *    capture had different swatches and different balls on the course. This is
 *    pinned through the product: `/api/join` already accepts the `ball` the
 *    entry screen persists in `localStorage`, so the host gets a saved ball
 *    preference before it joins and each guest sends one with its join. The
 *    rendered colours are the registry's own palette values, not overrides.
 *  - **The opening course.** The first hole is drawn from the playlist by a
 *    weighted vote, so a three-course playlist dealt a different hole — and a
 *    different scene — on every run. The playlist is narrowed to one course
 *    before the party starts, which leaves the draw a single possible outcome
 *    while still running the normal vote path. The three-course playlist is
 *    still what the playlist screenshot shows.
 *  - **The animation clock.** The lobby backdrop and the in-game scene animate
 *    continuously, so two shots of the same screen never matched. Both
 *    `performance.now` and the timestamp handed to `requestAnimationFrame` are
 *    pinned before any application script runs, which leaves the renderer
 *    drawing the first frame of the real scene forever. It is the same geometry,
 *    camera, materials and lighting — just always at t=0. Pinning the frame
 *    timestamp matters separately: the course's moving obstacles are stepped
 *    from it, not from `performance.now`.
 *  - **The settling ball.** The render clock is pinned but the physics step is
 *    real, so the ball creeps its last fraction of a millimetre into the spawn
 *    point. A capture waits until its position has been unchanged for several
 *    consecutive samples before taking the frame.
 *  - **Per-run readings.** The room code is random characters from
 *    `/api/create`, and the hole clock and the HUD countdown are stopwatches
 *    that read a different value on every run. No product path pins them
 *    (the code must stay unguessable, and a clock that does not move would be a
 *    bug), so their *text* is replaced with a fixed reading. Only the characters
 *    change: the element, its classes, its font and its layout are the ones the
 *    product rendered, so the image still shows the real chrome. A
 *    `MutationObserver` keeps the reading fixed against the clocks' own
 *    re-renders, and the capture is verified and retaken if a re-render still
 *    won the race.
 *
 * Two more sources of churn were timing rather than randomness, and are fixed by
 * waiting instead of pinning: catalogue thumbnails are lazy, so a capture waits
 * for the ones on screen to load, and the three guests join in sequence because
 * the roster lists players in arrival order.
 *
 * Everything else — the roster, the playlist, the course, the HUD, the scene —
 * is real. Course titles, ratings and thumbnails come from the live catalogue
 * and can therefore change as upstream changes, which is expected of
 * documentation.
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

/**
 * Pin the animation clock for the whole document, before the application loads.
 *
 * A constant `performance.now` gives the engine's `THREE.Clock` a zero delta, so
 * the scene keeps drawing its first frame instead of advancing. The timestamp
 * handed to `requestAnimationFrame` is pinned as well: the course's moving
 * obstacles are stepped from that value rather than from `performance.now`, so
 * pinning only the latter still let a gate arm advance between two captures.
 */
await client.call('Page.addScriptToEvaluateOnNewDocument', {
  source: [
    'performance.now = () => 0;',
    'const requestFrame = window.requestAnimationFrame;',
    'window.requestAnimationFrame = (callback) => requestFrame.call(window, () => callback(0));',
  ].join('\n'),
});

/**
 * Fixed readings for the values no product path can pin: the random room code
 * and the two stopwatches. Each entry is a selector and the text to show; a
 * selector that is not on screen is skipped, so one list covers every shot.
 */
const pinnedReadings = [
  // A code from the same five-character alphabet the service draws from, so the
  // shot shows the real layout and letter spacing rather than a placeholder.
  ['.bp-dashboard-code', 'QK7MR'],
  ['.bp-hole-clock', 'Time 0:14.208'],
  // The countdown is the only large tabular-numeral span in the HUD; a broader
  // `.tabular-nums` selector would also rewrite the per-player rank and time
  // columns, which are not per-run data.
  ['.bp-party-status .text-lg.tabular-nums', '0:45'],
];

/**
 * Enforce those readings from inside the page.
 *
 * The hole clock ticks every 100ms and the HUD countdown every 250ms, so
 * writing the text once and then capturing loses the race: a re-render lands
 * between the two and the shot shows a different number. A `MutationObserver`
 * rewrites the text on every mutation instead, and observer callbacks run as
 * microtasks — before the frame is painted — so whatever the compositor
 * captures has the fixed reading.
 *
 * It must be reinstalled after a navigation: creating or joining a party is a
 * full document load, which discards observers on the old document. `shoot`
 * installs it before every capture, so that is handled in one place.
 */
const installReadingPin = () =>
  client.evalJS(
    '(()=>{const pinned=' +
      JSON.stringify(pinnedReadings) +
      ';const apply=()=>{for(const [selector,text] of pinned){' +
      'for(const el of document.querySelectorAll(selector)){' +
      'if(el.textContent!==text) el.textContent=text;}}};' +
      'apply();window.__bpReadingPin&&window.__bpReadingPin.disconnect();' +
      'window.__bpReadingPin=new MutationObserver(apply);' +
      'window.__bpReadingPin.observe(document.body,{subtree:true,childList:true,characterData:true});' +
      'return true})()',
  );

/** True when every pinned reading currently on screen shows its fixed text. */
const readingsPinned = () =>
  client.evalJS(
    '(' +
      JSON.stringify(pinnedReadings) +
      ').every(([selector, text]) => [...document.querySelectorAll(selector)]' +
      '.every((el) => el.textContent === text))',
  );

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

/**
 * Wait until the ball has come to rest at the spawn point.
 *
 * The render clock is pinned, but the physics step is driven by real time, so
 * the ball settles its last fraction of a millimetre over the first moment of a
 * hole. Two captures taken a frame apart therefore showed the ball at slightly
 * different heights — the largest remaining diff in the in-game shots. The
 * threshold is deliberately far below a subpixel at 2x DPR, and it must hold
 * for several consecutive samples, because the capture happens a moment after
 * this returns and a ball still creeping would have moved again by then.
 *
 * Screens with no course on them (home, the lobby, the picker) have no ball, so
 * this returns immediately rather than waiting for something that will never
 * appear.
 */
const waitForBallAtRest = async () => {
  const position = async () => {
    try {
      return await client.evalJS(
        '(async()=>{const r=' + runtime + ';const p=r.r?.ballPos;return p?[p.x,p.y,p.z]:null})()',
      );
    } catch {
      // Importing the party runtime on a page that has no party surface throws;
      // there is no ball to settle there.
      return null;
    }
  };
  let previous = await position();
  if (!previous) {
    return;
  }
  let stable = 0;
  for (let attempt = 0; attempt < 100; attempt++) {
    await pause(100);
    const current = await position();
    if (!current) {
      return;
    }
    const moved = Math.max(...current.map((value, index) => Math.abs(value - previous[index])));
    previous = current;
    stable = moved < 1e-6 ? stable + 1 : 0;
    if (stable >= 5) {
      return;
    }
  }
  throw Error('the ball never came to rest before the capture');
};

/**
 * Wait until every thumbnail actually on screen in the course picker has loaded.
 *
 * Catalogue thumbnails are fetched from the live service and are `loading="lazy"`,
 * so the picker renders its cards before the images arrive, and cards below the
 * fold never load at all in a headless browser. A shot taken before the visible
 * ones arrive shows an empty placeholder card, which is what made two playlist
 * captures differ by a whole tile. The check is therefore limited to images
 * intersecting the viewport; `complete` covers success and failure alike, so a
 * genuinely broken thumbnail falls back to its placeholder instead of hanging.
 */
const waitForThumbnails = () =>
  waitFor(
    client,
    '[...document.querySelectorAll(".bp-catalog-scroll img")].filter((img) => {' +
      'const box = img.getBoundingClientRect();' +
      'return box.bottom > 0 && box.top < innerHeight && box.right > 0 && box.left < innerWidth;' +
      '}).every((img) => img.complete)',
    45000,
  );

const shoot = async (file) => {
  // Font shaping and the level's first frames are not instant; a shot taken too
  // early shows a half-drawn scene.
  await pause(900);
  // A navigation discards the previous document's observer, so reinstall it
  // before each shot; the readings it pins only exist on the party surfaces.
  await installReadingPin();
  // Images can still be in flight when the surrounding chrome has rendered.
  await waitForThumbnails();
  // Settle the ball last, so the physics step has no time to move it again
  // between this returning and the compositor taking the frame.
  await waitForBallAtRest();
  // The observer keeps the readings fixed from inside the page, so a capture is
  // almost always already correct. React can still re-render a value in the
  // moment between the compositor taking the frame and this check reading it
  // back, so capture, verify, and retake rather than trusting one attempt.
  for (let attempt = 0; attempt < 6; attempt++) {
    const shot = await client.call('Page.captureScreenshot', { format: 'png' });
    if (await readingsPinned()) {
      writeFileSync(join(outputDir, file), Buffer.from(shot.data, 'base64'));
      console.log('captured', join(outputDir, file));
      return;
    }
  }
  throw Error('pinned readings never settled for ' + file);
};

const guests = [];
async function joinGuest(code, name, ball) {
  const response = await fetch(base + '/api/join', {
    method: 'POST',
    headers: { origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({ code, name, ball }),
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

  /* Create a party and name the host, keeping the ball the entry screen saves. */
  await client.evalJS('localStorage.setItem("bp.ball.v1", JSON.stringify({key:"ball-coral"}))');
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
  // Joined in sequence, not concurrently: the roster lists players in the order
  // they arrived, so three parallel joins would order the rows differently on
  // every run and change the shot.
  await joinGuest(code, 'Ada', { key: 'ball-mint' });
  await joinGuest(code, 'Grace', { key: 'ball-sky' });
  await joinGuest(code, 'Alan', { key: 'ball-lemon' });
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

  // The opening hole is drawn from the playlist by a weighted vote, so three
  // courses give a different hole — and a different scene — on every run.
  // Narrowing the playlist to one course before starting leaves the draw with a
  // single outcome: the vote still opens and resolves through the normal path,
  // it just cannot pick anything else. The playlist screenshot above already
  // shows the full three-course list.
  await client.evalJS(
    '(async()=>{const r=' +
      runtime +
      ';r.D({mapSource:"picked",selectedHoleIds:' +
      JSON.stringify([chosen[0]]) +
      '})})()',
  );

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
