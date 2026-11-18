import assert from 'node:assert/strict';

import { connect, pause, waitFor } from './cdp.mjs';

/**
 * The shared entry screen is the same screen through join, rejoin and load.
 *
 * Home, the name-entry screen, and the "Loading party…" state are three different
 * components that must look like one screen: the same wordmark, the same party
 * code, and nothing that jumps as the page moves between them. A regression here
 * does not throw - it shows players a flash of a different layout, or a
 * half-broken one, at the moment they are least sure the app works.
 *
 * This drives the real route at desktop, 390px and 320px and measures the states
 * rather than eyeballing them:
 *
 *  1. The wordmark keeps its size, spacing and weight across every state, so the
 *     title does not resize between joining and loading.
 *  2. The screen is horizontally centred and does not overflow.
 *  3. The party code is visible in the name-entry and loading states.
 *  4. The loading state has a spinner and announces itself as a status.
 *  5. The primary button is a full-width rounded control, as on home.
 *  6. Reduced motion stops the spinner instead of spinning it forever.
 */

const base = process.env.BASE || 'http://127.0.0.1:8789';
const DEBUGGING = 'http://127.0.0.1:9239';

const targets = await fetch(DEBUGGING + '/json/list').then((response) => response.json());
const pageTarget = targets.find((target) => target.type === 'page');
assert(pageTarget, 'expected a debuggable page target');

const client = await connect(pageTarget);

/** Read the geometry and typography of whatever entry screen is showing. */
const MEASURE = `(() => {
  const main = document.querySelector('main.bp-home');
  if (!main) {
    return { present: false };
  }
  const entry = main.querySelector('.bp-entry');
  const wordmark = main.querySelector('.bp-wordmark');
  const code = main.querySelector('.bp-join-code');
  const spinner = main.querySelector('.bp-loading-spinner');
  const message = main.querySelector('.bp-loading-message');
  const primary = main.querySelector('.bp-create');
  const entryBox = entry ? entry.getBoundingClientRect() : null;
  const primaryBox = primary ? primary.getBoundingClientRect() : null;
  const wordmarkStyle = wordmark ? getComputedStyle(wordmark) : null;
  return {
    present: true,
    classes: main.className,
    wordmark: wordmark
      ? {
          text: wordmark.textContent,
          fontSize: wordmarkStyle.fontSize,
          letterSpacing: wordmarkStyle.letterSpacing,
          fontWeight: wordmarkStyle.fontWeight,
        }
      : null,
    code: code ? code.textContent : null,
    spinner: spinner ? { animation: getComputedStyle(spinner).animationName } : null,
    message: message ? { text: message.textContent, role: message.getAttribute('role') } : null,
    primary: primary
      ? {
          text: primary.textContent,
          radius: getComputedStyle(primary).borderTopLeftRadius,
          width: Math.round(primaryBox.width),
        }
      : null,
    entryLeft: entryBox ? Math.round(entryBox.left) : null,
    entryWidth: entryBox ? Math.round(entryBox.width) : null,
    viewport: window.innerWidth,
    overflow: document.documentElement.scrollWidth > window.innerWidth,
  };
})()`;

/** True while the entry screen is mounted and its stylesheet has applied. */
const PRESENT = `(()=>{
  const main = document.querySelector('main.bp-home');
  if (!(main && main.querySelector('.bp-entry'))) {
    return false;
  }
  // A first paint can happen before the stylesheet applies, which would measure
  // user-agent defaults and compare them against themselves. Require the real
  // stylesheet to be live before treating a sample as a view of the design.
  return [...document.styleSheets].some((sheet) => sheet.cssRules.length > 100);
})()`;

/** True while the loading variant specifically is mounted. */
const LOADING =
  '(()=>{const m=document.querySelector("main.bp-home.bp-party-loading");return !!(m&&m.querySelector(".bp-entry"))})()';

/**
 * Measure the current screen.
 *
 * The wait and the measurement are separate evaluations, and the route swaps one
 * entry component for another between them, so the element can disappear in
 * between. Retrying the whole read makes the sample atomic enough to be about the
 * screen rather than about the swap.
 */
async function measure(label) {
  for (let attempt = 0; attempt < 60; attempt++) {
    await waitFor(client, PRESENT, 30000);
    const result = await client.evalJS(MEASURE);
    if (result.present) {
      return result;
    }
    await pause(50);
  }
  assert.fail(`${label}: expected the entry screen to stay mounted`);
}

/** Wait for the route to leave the entry screen and show the game instead. */
async function waitForGame() {
  await waitFor(client, '!document.querySelector("main.bp-home")', 60000);
}

/** Centred, unclipped, and no horizontal scrollbar. */
function assertCentred(result, label) {
  assert(!result.overflow, `${label}: the page must not scroll horizontally`);
  if (result.entryWidth !== null && result.entryWidth < result.viewport) {
    const centre = result.entryLeft + result.entryWidth / 2;
    assert(
      Math.abs(centre - result.viewport / 2) <= 1,
      `${label}: entry must be centred (centre ${centre} of ${result.viewport})`,
    );
  }
}

/** The loading screen must look like the screen it replaced. */
function assertSameSightline(baseline, loading, label) {
  for (const property of ['fontSize', 'letterSpacing', 'fontWeight']) {
    assert.equal(
      loading.wordmark[property],
      baseline.wordmark[property],
      `${label}: wordmark ${property} must not change between entry and loading`,
    );
  }
}

/** Type a name and submit the join form. */
async function joinWithName(name) {
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
  const states = {};

  for (const [width, height] of [
    [1100, 700],
    [390, 844],
    [320, 568],
  ]) {
    await client.call('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });

    // 1. The home screen, which is the baseline the other states must match.
    await client.call('Page.navigate', { url: base + '/home' });
    const home = await measure(`home ${width}`);
    assertCentred(home, `home ${width}`);
    assert.equal(home.wordmark.text, 'better.party', `${width}: wordmark text`);
    assert(home.primary, `${width}: home must show its create button`);
    assert.equal(home.primary.width, home.entryWidth, `${width}: home button is full width`);

    // 2. Create a party and land on the route that owns the entry, load and rejoin
    //    states. The name-entry screen is the route's own entry screen.
    await waitFor(
      client,
      'typeof document.querySelector("#create")?.onclick === "function"',
      20000,
    );
    await client.evalJS('document.querySelector("#create").click()');
    await waitFor(client, 'location.pathname.startsWith("/party/")', 20000);
    const code = await client.evalJS('location.pathname.split("/").pop()');
    const entry = await measure(`entry ${width}`);
    assertCentred(entry, `entry ${width}`);
    assert.equal(entry.wordmark.text, 'better.party', `${width}: entry wordmark text`);
    assert((entry.code ?? '').includes(code), `${width}: entry must show the party code`);
    assertSameSightline(home, entry, `${width} home to entry`);

    // 3. Joining shows the loading state. It must keep the wordmark and code and
    //    add a real spinner.
    await joinWithName('Entry Probe');
    await waitFor(client, LOADING, 30000);
    const loading = await measure(`loading ${width}`);
    assertCentred(loading, `loading ${width}`);
    assert.equal(loading.wordmark.text, 'better.party', `${width}: loading wordmark text`);
    assert(
      (loading.code ?? '').includes(code),
      `${width}: loading must show the party code ${code}, saw ${loading.code}`,
    );
    assert(loading.spinner, `${width}: joining must show the spinner`);
    assert.equal(loading.message?.role, 'status', `${width}: the loading message is a status`);
    assertSameSightline(entry, loading, `${width} entry to loading`);

    // 4. The game replaces the entry screen once the party is ready. Reloading from
    //    there exercises the rejoin path, which renders the same loading screen.
    await waitForGame();
    await client.call('Page.reload');
    await waitFor(client, LOADING, 30000);
    const rejoin = await measure(`rejoin ${width}`);
    assertCentred(rejoin, `rejoin ${width}`);
    assert.equal(rejoin.wordmark.text, 'better.party', `${width}: rejoin wordmark text`);
    assert(
      (rejoin.code ?? '').includes(code),
      `${width}: rejoin must show the party code ${code}, saw ${rejoin.code}`,
    );
    assert(rejoin.spinner, `${width}: rejoining must show the spinner`);
    assert.equal(rejoin.message?.role, 'status', `${width}: the rejoin message is a status`);
    assertSameSightline(home, rejoin, `${width} home to rejoin`);

    // The recovery actions on the loading screen are the same full-width rounded
    // controls as home's primary button.
    const actions = await client.evalJS(
      '(()=>{const b=document.querySelector("main.bp-party-loading .bp-loading-action");' +
        'if(!b)return null;const s=getComputedStyle(b);return {radius:s.borderTopLeftRadius,display:s.display}})()',
    );
    assert(actions, `${width}: the loading screen must offer a way back`);
    assert.notEqual(actions.radius, '0px', `${width}: recovery actions must stay rounded`);

    states[width] = { home, entry, loading, rejoin };
    console.log(`PASS ${width}x${height} shared entry screen`, {
      wordmark: rejoin.wordmark.fontSize,
      code: rejoin.code,
      spinner: rejoin.spinner.animation,
      overflow: rejoin.overflow,
    });

    // 5. Return to home so the next viewport starts from a known screen.
    await waitForGame();
    await client.call('Page.navigate', { url: base + '/home' });
  }

  // A 320px viewport must not shrink the wordmark to unreadability, and a wide one
  // must not let it sprawl.
  for (const [width, result] of Object.entries(states)) {
    const size = Number.parseFloat(result.rejoin.wordmark.fontSize);
    assert(size >= 32, `${width}: wordmark must stay readable, got ${size}px`);
    assert(size <= 64, `${width}: wordmark must not sprawl, got ${size}px`);
  }

  // Reduced motion must stop the spinner animating rather than spinning forever.
  await client.call('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  });
  const lastCode = Object.values(states).at(-1).rejoin.code.trim().split(' ').pop();
  await client.call('Page.navigate', { url: `${base}/party/${lastCode}` });
  await waitFor(client, LOADING, 30000);
  const reduced = await measure('reduced motion');
  assert(reduced.spinner, 'the loading screen must still show a spinner under reduced motion');
  assert.equal(reduced.spinner.animation, 'none', 'reduced motion must stop the spinner animation');

  // Nothing above may have thrown in the page.
  const exceptions = client.events.filter((event) => event.type === 'exception');
  assert.equal(exceptions.length, 0, 'no page exceptions during the entry screens');
  console.log('PASS entry screen is identical through join, rejoin and load at every viewport');
} finally {
  await client.call('Emulation.clearDeviceMetricsOverride').catch(() => {});
  await client.call('Emulation.setEmulatedMedia', { features: [] }).catch(() => {});
  client.close();
}
