import assert from 'node:assert/strict';
import { connect, waitFor } from './cdp.mjs';
import { openPlaylistEditor } from './playlist-editor.mjs';

/**
 * Catalogue pagination.
 *
 * The live catalogue is a moving list, so these checks drive a controlled one: the
 * offsets, duplicates, end-of-list marker and failure are all scripted. That is the
 * only way to assert what happens when a cursor repeats or a page fails, which is
 * exactly where pagination goes wrong.
 */

const base = process.env.BASE || 'http://127.0.0.1:8789';
const targets = await fetch('http://127.0.0.1:9239/json/list').then((response) => response.json());
const client = await connect(targets.find((target) => target.type === 'page'));
const cards = `document.querySelectorAll('.bp-catalog-scroll li').length`;
const status = `document.querySelector('.bp-catalog-scroll div.mt-6 p')?.textContent ?? ''`;
const setPlan = (plan) => client.evalJS(`window.bpCatalogPlan = ${JSON.stringify(plan)}`);
const setSearch = (text) =>
  client.evalJS(`
    (() => {
      const input = document.querySelector('input[aria-label="Find party holes"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(text)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
const click = async (label) => {
  const found = await client.evalJS(
    `(()=>{const b=[...document.querySelectorAll("button")].find(b=>b.textContent===${JSON.stringify(label)}||b.getAttribute("aria-label")===${JSON.stringify(label)});if(!b||b.disabled)return null;b.scrollIntoView({block:"nearest"});const r=b.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;return {x,y,hit:b.contains(document.elementFromPoint(x,y))}})()`,
  );
  assert(found?.hit, 'Not pointer-clickable: ' + label + ' ' + JSON.stringify(found));
  for (const type of ['mousePressed', 'mouseReleased']) {
    await client.call('Input.dispatchMouseEvent', {
      type,
      x: found.x,
      y: found.y,
      button: 'left',
      clickCount: 1,
    });
  }
};

const hole = (id) => ({ id, title: 'Course ' + id, author: 'maker', ratingAvg: 4, ratingCount: 3 });
const page = (holes, nextOffset, total) => ({ holes, nextOffset, total, offset: 0 });

try {
  await client.call('Page.navigate', { url: base + '/home' });
  await waitFor(client, 'typeof document.querySelector("#create")?.onclick === "function"');
  await client.evalJS('document.querySelector("#create").click()');
  await waitFor(client, '!!document.querySelector(".bp-name-input")');
  await client.evalJS(`
    (() => {
      const input = document.querySelector('.bp-name-input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Paging test');
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

  // Replace the catalogue with a scripted one; everything else passes through.
  await client.evalJS(`
    (() => {
      const original = window.fetch.bind(window);
      window.bpCatalogCalls = [];
      window.fetch = (input, options) => {
        const url = typeof input === 'string' ? input : input.url;
        if (!url.startsWith('/api/catalog')) return original(input, options);
        const offset = new URL(url, location.origin).searchParams.get('offset') ?? '0';
        const plan = window.bpCatalogPlan;
        window.bpCatalogCalls.push(offset);
        if (plan.failOnce) {
          plan.failOnce = false;
          return Promise.reject(new Error('The catalogue could not be reached.'));
        }
        const body = plan.pages[offset] ?? { holes: [], nextOffset: null, total: 0, offset: 0 };
        return Promise.resolve(new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }));
      };
    })()
  `);

  await client.evalJS(
    '(()=>{let x=document.querySelector("[aria-label=\\"Party map selection\\"]");x.value="picked";x.dispatchEvent(new Event("change",{bubbles:true}));})()',
  );

  // 1. A second page appends, deduplicates an entry that moved between pages, and
  //    then states the end of the list.
  await setPlan({
    pages: {
      0: page([hole('aaaaa'), hole('bbbbb')], 2, 3),
      2: page([hole('bbbbb'), hole('ccccc')], null, 3),
    },
  });
  await openPlaylistEditor(client);
  await waitFor(client, `${cards}===2`);
  await click('Load more');
  await waitFor(client, `${cards}===3`);
  assert.match(await client.evalJS(status), /3 holes · end of list/);
  assert.equal(
    await client.evalJS(`[...document.querySelectorAll('.bp-catalog-scroll li')].length`),
    3,
    'the repeated entry is not shown twice',
  );
  assert.equal(
    await client.evalJS(
      `[...document.querySelectorAll('button')].some(b => b.textContent === 'Load more')`,
    ),
    false,
    'no load-more button at the end of the list',
  );
  console.log('PASS pages append, duplicates are dropped and the end of the list is stated');

  // 2. An empty result says so rather than looking like a failure.
  await setPlan({ pages: { 0: page([], null, 0) } });
  await setSearch('nothing matches this');
  await waitFor(client, `${cards}===0`);
  await waitFor(
    client,
    `document.querySelector('.bp-catalog-scroll p')?.textContent.includes('No holes match')`,
  );
  console.log('PASS an empty result explains itself');

  // 3. A failed first page offers a retry, and the retry loads it.
  await setPlan({ failOnce: true, pages: { 0: page([hole('aaaaa')], null, 1) } });
  await setSearch('retry me');
  await waitFor(client, `!!document.querySelector('button[aria-label="Retry catalogue"]')`);
  assert.equal(await client.evalJS(cards), 0);
  await click('Retry catalogue');
  await waitFor(client, `${cards}===1`);
  console.log('PASS a failed page can be retried');

  // 4. A cursor that comes back unchanged ends the list instead of looping.
  await setPlan({
    pages: {
      0: page([hole('aaaaa'), hole('bbbbb')], 2, 9),
      2: page([hole('aaaaa'), hole('bbbbb')], 2, 9),
    },
  });
  await setSearch('stale cursor');
  await waitFor(client, `${cards}===2`);
  await click('Load more');
  // Wait for the status rather than the button: while loading the button's label is
  // "Loading…", so "no Load more button" is true before the page has settled.
  await waitFor(client, `(${status}).includes('end of list')`);
  assert.equal(await client.evalJS(cards), 2, 'nothing was duplicated');
  assert.equal(
    await client.evalJS(
      `[...document.querySelectorAll('button')].some(b => b.textContent === 'Load more')`,
    ),
    false,
    'no load-more button once the cursor stops advancing',
  );
  console.log('PASS a repeated cursor ends the list rather than looping');

  const exceptions = client.events.filter((event) => event.type === 'exception');
  assert.equal(exceptions.length, 0, JSON.stringify(exceptions));
  console.log('PASS no page exceptions');
} finally {
  client.close();
}
