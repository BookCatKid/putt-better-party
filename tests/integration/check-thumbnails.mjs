import assert from 'node:assert/strict';
import { connect, waitFor } from './cdp.mjs';
import { openPlaylistEditor } from './playlist-editor.mjs';

/**
 * Thumbnails: lazy loading, a failed preview, and the box staying put.
 *
 * Previews come from upstream, so a card can be drawn before its picture exists and
 * the picture can fail. What matters is that the card keeps its original dimensions
 * either way and that a failure is shown as a placeholder rather than a broken image.
 */

const base = process.env.BASE || 'http://127.0.0.1:8789';
const targets = await fetch('http://127.0.0.1:9239/json/list').then((response) => response.json());
const client = await connect(targets.find((target) => target.type === 'page'));
const cards = `document.querySelectorAll('.bp-catalog-scroll li').length`;
const hole = (id, title) => ({ id, title, author: 'maker', ratingAvg: 4, ratingCount: 3 });

try {
  await client.call('Page.navigate', { url: base + '/home' });
  await waitFor(client, 'typeof document.querySelector("#create")?.onclick === "function"');
  await client.evalJS('document.querySelector("#create").click()');
  await waitFor(client, '!!document.querySelector(".bp-name-input")');
  await client.evalJS(`
    (() => {
      const input = document.querySelector('.bp-name-input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Thumb test');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  const joinButton = `[...document.querySelectorAll(".bp-join-form button")].find(b => b.textContent === "Join")`;
  await waitFor(client, `!!${joinButton} && !${joinButton}.disabled`);
  await client.evalJS(`${joinButton}.click()`);
  await waitFor(
    client,
    '!!document.querySelector(".bp-dashboard-overlay") && !document.querySelector(".bp-party-loading")',
  );

  // Five real courses, so their previews genuinely load, plus one id that is a valid
  // shape but not listed - which the preview route refuses.
  const catalog = await fetch(base + '/api/catalog?sort=new&offset=0').then((response) =>
    response.json(),
  );
  const real = catalog.holes.slice(0, 5).map((entry) => hole(entry.id, entry.title));
  const missing = hole('zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz', 'Missing course');
  await client.evalJS(`
    (() => {
      const original = window.fetch.bind(window);
      window.fetch = (input, options) => {
        const url = typeof input === 'string' ? input : input.url;
        if (!url.startsWith('/api/catalog')) return original(input, options);
        return Promise.resolve(new Response(JSON.stringify({
          holes: ${JSON.stringify([...real, missing])},
          total: 6,
          nextOffset: null,
          offset: 0,
        }), { status: 200, headers: { 'content-type': 'application/json' } }));
      };
    })()
  `);

  await client.evalJS(
    '(()=>{let x=document.querySelector("[aria-label=\\"Party map selection\\"]");x.value="picked";x.dispatchEvent(new Event("change",{bubbles:true}));})()',
  );
  await openPlaylistEditor(client);
  await waitFor(client, `${cards}===6`);

  // 1. The first four are eager, the fifth is lazy - the original loading behaviour.
  const loading = await client.evalJS(`
    [...document.querySelectorAll('.bp-catalog-scroll li img')].slice(0, 5).map(img => img.getAttribute('loading'))
  `);
  assert.deepEqual(loading, ['eager', 'eager', 'eager', 'eager', 'lazy']);
  console.log('PASS the first four thumbnails load eagerly and the rest lazily');

  // 2. The real previews actually arrive, and keep the card's aspect ratio.
  await waitFor(
    client,
    `[...document.querySelectorAll('.bp-catalog-scroll li img')].filter(i => i.complete && i.naturalWidth > 0).length >= 5`,
    30000,
  );
  const loaded = await client.evalJS(`
    (() => {
      const img = document.querySelector('.bp-catalog-scroll li img');
      const box = img.getBoundingClientRect();
      return {
        aspect: getComputedStyle(img).aspectRatio,
        width: Math.round(box.width),
        height: Math.round(box.height),
        ratio: Math.round((box.width / box.height) * 100) / 100,
      };
    })()
  `);
  assert.equal(loaded.aspect.replace(/\s/g, ''), '1200/630');
  assert(
    Math.abs(loaded.ratio - 1200 / 630) < 0.02,
    'the thumbnail keeps 1200:630: ' + loaded.ratio,
  );
  console.log('PASS a loaded thumbnail keeps the original card dimensions');

  // 3. The refused preview retries once and then becomes a placeholder of the same
  //    size, so the grid does not reflow.
  await waitFor(client, `!!document.querySelector('.bp-thumb-fallback')`, 30000);
  const fallback = await client.evalJS(`
    (() => {
      const element = document.querySelector('.bp-thumb-fallback');
      const box = element.getBoundingClientRect();
      const image = document.querySelector('.bp-catalog-scroll li img');
      const imageBox = image.getBoundingClientRect();
      return {
        text: element.textContent,
        role: element.getAttribute('role'),
        label: element.getAttribute('aria-label'),
        width: Math.round(box.width),
        height: Math.round(box.height),
        imageWidth: Math.round(imageBox.width),
        imageHeight: Math.round(imageBox.height),
        brokenImages: [...document.querySelectorAll('.bp-catalog-scroll li img')].filter(i => i.complete && i.naturalWidth === 0).length,
      };
    })()
  `);
  assert.equal(fallback.text, 'M', 'the placeholder shows the course initial');
  assert.equal(fallback.role, 'img');
  assert.equal(fallback.label, 'Missing course');
  assert.equal(fallback.brokenImages, 0, 'no broken image is left on screen');
  assert(Math.abs(fallback.width - fallback.imageWidth) <= 1, 'same width as a real thumbnail');
  assert(Math.abs(fallback.height - fallback.imageHeight) <= 1, 'same height as a real thumbnail');

  // The retry is a real second attempt, not the same failure replayed: the server is
  // asked again, with a cache-busting parameter, before the placeholder is shown.
  const previewRequests = [...client.requests.values()].filter((url) =>
    url.includes('zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'),
  );
  assert.equal(previewRequests.length, 2, JSON.stringify(previewRequests));
  assert.equal(
    previewRequests.some((url) => url.includes('retry=1')),
    true,
    'the retry is a distinct request: ' + JSON.stringify(previewRequests),
  );
  console.log('PASS a failed thumbnail becomes a same-size placeholder after a retry');

  const exceptions = client.events.filter((event) => event.type === 'exception');
  assert.equal(exceptions.length, 0, JSON.stringify(exceptions));
  console.log('PASS no page exceptions');
} finally {
  client.close();
}
