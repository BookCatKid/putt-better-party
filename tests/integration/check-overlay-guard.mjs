import assert from 'node:assert/strict';

import { connect, pause, waitFor } from './cdp.mjs';

/**
 * The game must not take input while a blocking overlay is in front of it.
 *
 * The engine binds its input on `window` rather than on the canvas, so an overlay
 * that merely covers the scene does not stop the engine hearing the keyboard. This
 * was a real defect: with "Loading party…" up, a keydown still reached the window
 * listeners, and with the lobby up neither the scene nor the controls around it were
 * inert, so a keyboard user could tab into a game they could not see or play.
 *
 * Both overlays now mark themselves with `data-bp-blocking-overlay` and one guard in
 * `scripts/party-overlay.js` makes everything around them inert and swallows the
 * engine's input events at capture phase. What matters is that this is real, so the
 * assertions are about observable behaviour rather than about the attributes we
 * happen to set:
 *
 *  1. A keydown that reaches `window` in bubble phase - exactly how the engine
 *     listens - does not happen while an overlay is up.
 *  2. Tab never lands outside the blocking overlay.
 *  3. The overlay's own controls still work, so blocking did not become a dead end.
 *  4. When the overlay goes, the engine hears the keyboard again and nothing is
 *     left inert.
 *
 * Point 1 is the one that cannot be satisfied by marking elements: it needs the
 * capture-phase guard, and it is the assertion that would have caught the original
 * bug on its own.
 */

const base = process.env.BASE || 'http://127.0.0.1:8789';
const DEBUGGING = 'http://127.0.0.1:9239';

const targets = await fetch(DEBUGGING + '/json/list').then((response) => response.json());
const pageTarget = targets.find((target) => target.type === 'page');
assert(pageTarget, 'expected a debuggable page target');

const client = await connect(pageTarget);

/** True while an overlay that can actually be seen is marked as blocking. */
const OVERLAY_UP = `(() => {
  const overlays = [...document.querySelectorAll('[data-bp-blocking-overlay]')];
  return overlays.some((overlay) => overlay.checkVisibility());
})()`;

/**
 * Count keydowns that survive to a bubble-phase listener on `window`.
 *
 * The engine registers exactly this, so a non-zero count means a key pressed while
 * the overlay is up would have reached the game. Capture phase is not counted: the
 * guard legitimately runs there, and it is what stops the event going further.
 */
const INSTALL_ENGINE_PROBE = `(() => {
  window.__bpEngineKeydowns = 0;
  if (!window.__bpEngineProbe) {
    window.__bpEngineProbe = () => {
      window.__bpEngineKeydowns += 1;
    };
    window.addEventListener('keydown', window.__bpEngineProbe);
  }
  return true;
})()`;

/** Describe where focus currently is, relative to the blocking overlay. */
const FOCUS_STATE = `(() => {
  const overlay = [...document.querySelectorAll('[data-bp-blocking-overlay]')]
    .filter((element) => element.checkVisibility())
    .pop();
  const active = document.activeElement;
  return {
    inOverlay: !!(overlay && active && overlay.contains(active)),
    tag: active ? active.tagName : null,
    label: active
      ? (active.getAttribute('aria-label') || active.textContent || active.placeholder || '')
          .trim()
          .slice(0, 32)
      : null,
  };
})()`;

/** How many focusable elements outside the overlay are still reachable. */
const REACHABLE_OUTSIDE = `(() => {
  const overlay = [...document.querySelectorAll('[data-bp-blocking-overlay]')]
    .filter((element) => element.checkVisibility())
    .pop();
  if (!overlay) {
    return { overlay: false };
  }
  const focusable = [
    ...document.querySelectorAll('a[href], button, input, select, textarea, [tabindex]'),
  ];
  const outside = focusable.filter(
    (element) => !overlay.contains(element) && !element.closest('[inert]'),
  );
  return {
    overlay: true,
    outside: outside.map((element) => element.tagName + '.' + String(element.className).split(' ')[0]),
  };
})()`;

/** Press one key through CDP, both halves of the event. */
async function press(key, code, virtualKeyCode) {
  await client.call('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key,
    code,
    windowsVirtualKeyCode: virtualKeyCode,
  });
  await client.call('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    code,
    windowsVirtualKeyCode: virtualKeyCode,
  });
  await pause(90);
}

/** Press Tab and report where focus landed. */
async function tab() {
  await press('Tab', 'Tab', 9);
  return client.evalJS(FOCUS_STATE);
}

/** Assert that the engine heard nothing, then reset the counter. */
async function expectEngineBlocked(label) {
  // The keys are the engine's own shortcuts: R restarts, C toggles the camera
  // lock, and a bare arrow key is movement. All three are handled on window.
  await press('r', 'KeyR', 82);
  await press('c', 'KeyC', 67);
  await press('ArrowUp', 'ArrowUp', 38);
  const heard = await client.evalJS('window.__bpEngineKeydowns');
  assert.equal(heard, 0, `${label}: the engine must not hear keys while an overlay is up`);
  await client.evalJS('window.__bpEngineKeydowns = 0');
}

/** Assert that the engine hears keys again, which proves the guard was released. */
async function expectEngineLive(label) {
  await press('r', 'KeyR', 82);
  const heard = await client.evalJS('window.__bpEngineKeydowns');
  assert(heard > 0, `${label}: the engine must hear keys once no overlay is up`);
  await client.evalJS('window.__bpEngineKeydowns = 0');
}

/** Create a party and join it, leaving the route on its blocking screens. */
async function joinNewParty(name) {
  await client.call('Page.navigate', { url: base + '/home' });
  await waitFor(client, 'typeof document.querySelector("#create")?.onclick === "function"', 30000);
  await client.evalJS('document.querySelector("#create").click()');
  await waitFor(client, 'location.pathname.startsWith("/party/")', 30000);
  await waitFor(client, '!!document.querySelector("input[placeholder=\\"Your name\\"]")', 30000);
  await client.evalJS(
    `(()=>{const x=document.querySelector("input[placeholder=\\"Your name\\"]");` +
      `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(x,${JSON.stringify(name)});` +
      `x.dispatchEvent(new Event("input",{bubbles:true}));})()`,
  );
  await waitFor(
    client,
    '!![...document.querySelectorAll("button")].find(b=>b.textContent==="Join"&&!b.disabled)',
    30000,
  );
  await client.evalJS(
    '[...document.querySelectorAll("button")].find(b=>b.textContent==="Join").click()',
  );
}

try {
  await joinNewParty('Overlay Guard');

  // ---- 1. The loading screen blocks the engine and owns focus ----------------
  await waitFor(client, OVERLAY_UP, 30000);
  await client.evalJS(INSTALL_ENGINE_PROBE);
  await expectEngineBlocked('loading');

  // Tab must not escape into the scene behind the loading screen. The scene
  // container is allowed to be the fallback focus target, but nothing inside it
  // may be reachable.
  const escapes = [];
  for (let index = 0; index < 6; index++) {
    const focus = await tab();
    if (!focus.inOverlay && focus.tag !== 'BODY') {
      escapes.push(focus);
    }
  }
  assert.deepEqual(escapes, [], 'loading: Tab must not reach the scene behind the overlay');

  const loadingReach = await client.evalJS(REACHABLE_OUTSIDE);
  assert(loadingReach.overlay, 'the loading screen must mark itself as blocking');
  const loadingSceneButtons = loadingReach.outside.filter((name) =>
    /BUTTON|INPUT|SELECT|TEXTAREA/.test(name),
  );
  assert.deepEqual(
    loadingSceneButtons,
    [],
    `loading: no control behind the overlay may stay reachable, saw ${loadingSceneButtons.join(', ')}`,
  );

  // The overlay's own recovery control must still work: blocking cannot become a
  // dead end. "Back to home" is the one action present in every loading state.
  const homeLink = await client.evalJS(
    `(()=>{const overlay=[...document.querySelectorAll('[data-bp-blocking-overlay]')].pop();` +
      `const link=overlay&&overlay.querySelector('a[href="/home"]');` +
      `if(!link)return null;link.focus();return document.activeElement===link;})()`,
  );
  assert(homeLink, 'loading: the overlay actions must remain focusable');

  // ---- 2. The lobby blocks the engine too -----------------------------------
  await waitFor(
    client,
    '!!document.querySelector("select[aria-label=\\"Party map selection\\"]")',
    60000,
  );
  await waitFor(client, '!document.querySelector("main.bp-party-loading")', 60000);
  await pause(500);
  await client.evalJS(INSTALL_ENGINE_PROBE);
  await expectEngineBlocked('lobby');

  // Focus must be inside the lobby, and Tab must stay there.
  const lobbyFocus = await client.evalJS(FOCUS_STATE);
  assert(lobbyFocus.inOverlay, `lobby: focus must start inside the lobby, was ${lobbyFocus.tag}`);
  const lobbyEscapes = [];
  for (let index = 0; index < 8; index++) {
    const focus = await tab();
    if (!focus.inOverlay) {
      lobbyEscapes.push(focus);
    }
  }
  assert.deepEqual(lobbyEscapes, [], 'lobby: Tab must stay inside the lobby');

  const lobbyReach = await client.evalJS(REACHABLE_OUTSIDE);
  // The scene container itself is the documented fallback focus target and is the
  // lobby overlay's own ancestor, so `inert` cannot apply to it. What must not be
  // reachable is the canvas and the controls under it.
  const lobbyControls = lobbyReach.outside.filter((name) =>
    /BUTTON|INPUT|SELECT|TEXTAREA/.test(name),
  );
  assert.deepEqual(
    lobbyReach.outside,
    ['DIV.bp-party-view'],
    `lobby: only the scene container may remain, saw ${lobbyReach.outside.join(', ')}`,
  );
  assert.deepEqual(lobbyControls, [], 'lobby: no control behind the lobby may stay reachable');
  assert.equal(
    await client.evalJS(
      `(()=>{const c=document.querySelector('canvas');return !!(c&&c.closest('[inert]'))})()`,
    ),
    true,
    'lobby: the canvas itself must be inert',
  );

  // ---- 3. Releasing the overlay gives the game its input back ---------------
  await client.evalJS(
    `(()=>{for (const el of document.querySelectorAll('[data-bp-blocking-overlay]')) el.removeAttribute('data-bp-blocking-overlay');return 1})()`,
  );
  await pause(500);
  await expectEngineLive('after release');
  assert.equal(
    await client.evalJS(`document.querySelectorAll('[inert]').length`),
    0,
    'after release no element may be left inert',
  );
  assert.equal(
    await client.evalJS(`document.querySelector('.bp-party-view')?.getAttribute('aria-hidden')`),
    null,
    'after release the scene must not stay hidden from assistive technology',
  );

  // ---- 4. A rejoin blocks again, which is the state players hit most -------
  const code = await client.evalJS('location.pathname.split("/").pop()');
  await client.call('Page.navigate', { url: `${base}/party/${code}` });
  await waitFor(client, OVERLAY_UP, 30000);
  await client.evalJS(INSTALL_ENGINE_PROBE);
  await expectEngineBlocked('rejoin');
  const rejoinReach = await client.evalJS(REACHABLE_OUTSIDE);
  const rejoinControls = rejoinReach.outside.filter((name) =>
    /BUTTON|INPUT|SELECT|TEXTAREA/.test(name),
  );
  assert.deepEqual(rejoinControls, [], 'rejoin: no control behind the overlay may stay reachable');

  const exceptions = client.events.filter((event) => event.type === 'exception');
  assert.equal(exceptions.length, 0, 'no page exceptions while guarding the scene');

  console.log('PASS loading, lobby and rejoin all block the engine and keep Tab inside');
} finally {
  await client.call('Emulation.clearDeviceMetricsOverride').catch(() => {});
  client.close();
}
