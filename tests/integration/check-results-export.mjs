import assert from 'node:assert/strict';
import { connect, waitFor, clickButton } from './cdp.mjs';
import { closePlaylistEditor, openPlaylistEditor } from './playlist-editor.mjs';

/**
 * Exporting results from the browser.
 *
 * The download is captured in the page rather than read from disk: the blob URL is
 * kept and the anchor's filename recorded, so the test sees exactly what the user
 * would have saved. The CSV is then compared with the on-screen scorecard, and both
 * files are checked for anything private.
 */

const base = process.env.BASE || 'http://127.0.0.1:8789';
const targets = await fetch('http://127.0.0.1:9239/json/list').then((response) => response.json());
const client = await connect(targets.find((target) => target.type === 'page'));
const state = '(await import("/assets/runtime-DL2fiDAQ.js")).E.state';
const expect = (condition, timeout = 30000) =>
  waitFor(
    client,
    `(async()=>{const s=${state};return (${condition})&&!document.querySelector(".bp-party-loading")})()`,
    timeout,
  );
const click = (label) => clickButton(client, label, { selector: 'button,a' });
/** The most recent download, as text. */
const lastDownload = () =>
  client.evalJS(`(async () => {
    const download = window.bpDownloads.at(-1);
    if (!download) {
      return null;
    }
    return { name: download.name, text: await download.blob.text() };
  })()`);

try {
  await client.call('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      const NativeSocket = window.WebSocket;
      window.bpPartySockets = [];
      window.WebSocket = class extends NativeSocket {
        constructor(...args) {
          super(...args);
          if (String(args[0]).includes('/ws/party/')) {
            window.bpPartySockets.push(this);
          }
        }
      };
      // Capture downloads instead of letting them leave the browser. The blob and
      // the anchor's filename are exactly what the user would have saved.
      window.bpDownloads = [];
      const nativeCreate = URL.createObjectURL;
      URL.createObjectURL = (blob) => {
        const url = nativeCreate.call(URL, blob);
        window.bpPendingBlob = blob;
        return url;
      };
      const nativeClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {
        if (this.download && window.bpPendingBlob) {
          window.bpDownloads.push({ name: this.download, blob: window.bpPendingBlob });
          window.bpPendingBlob = null;
        }
        return nativeClick.call(this);
      };
    `,
  });

  await client.call('Page.navigate', { url: base + '/home' });
  await waitFor(client, 'typeof document.querySelector("#create")?.onclick === "function"');
  await client.evalJS('document.querySelector("#create").click()');
  await waitFor(client, '!!document.querySelector(".bp-name-input")');
  await client.evalJS(`
    (() => {
      const input = document.querySelector('.bp-name-input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Export host');
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

  await client.evalJS(
    '(()=>{let x=document.querySelector("[aria-label=\\"Party map selection\\"]");x.value="picked";x.dispatchEvent(new Event("change",{bubbles:true}));})()',
  );
  await openPlaylistEditor(client);
  await waitFor(client, 'document.querySelectorAll(".bp-catalog-scroll li img").length>=24');
  await client.evalJS(
    '[...document.querySelectorAll("button")].find(b=>b.getAttribute("aria-label")?.startsWith("Add ")).click()',
  );
  await expect('s.config.selectedHoleIds.length===1', 25000);
  await closePlaylistEditor(client);

  await click('Start party');
  await expect('s.phase==="playing"&&s.mapReady');
  const par = await client.evalJS(`(async()=>${state}.currentMap.par)()`);
  await client.evalJS(
    `window.bpPartySockets.at(-1).send(JSON.stringify({ f: 1, s: ${par}, p: ${par} }))`,
  );
  await expect('s.phase==="final"', 30000);

  // 1. The CSV, exported from the scorecard.
  await waitFor(client, '!!document.querySelector(".bp-scorecard")', 30000);
  await click('Export CSV');
  const csv = await lastDownload();
  assert(csv, 'a CSV download happened');
  assert.match(csv.name, /^better-party-\d{4}-\d{2}-\d{2}-[0-9a-f]+\.csv$/);
  const csvLines = csv.text.trim().split('\r\n');
  assert.equal(csvLines[0], 'Hole,1,Total,To par');
  assert.equal(csvLines[1].split(',')[0], 'Course');
  assert.equal(csvLines[2], 'Par,' + par + ',,');
  assert.equal(csvLines[3], 'Export host,' + par + ',' + par + ',E');
  // The same numbers the screen shows.
  const screenTotal = await client.evalJS(
    `(async()=>String(${state}.final.standings[0].totalStrokes))()`,
  );
  assert.equal(csvLines[3].split(',')[2], screenTotal);
  console.log('PASS the CSV export matches the scorecard and its totals');

  // 2. The file carries nothing private.
  for (const forbidden of ['uid', 'session', 'token', 'hue', 'ball', 'spec']) {
    assert(!csv.text.toLowerCase().includes(forbidden), 'CSV must not contain ' + forbidden);
  }
  console.log('PASS the CSV carries no credential or cosmetic');

  // 3. Back to the lobby: the history export.
  await click('🔄 Back to lobby');
  await waitFor(
    client,
    '!!document.querySelector(".bp-dashboard-overlay") && !document.querySelector(".bp-party-loading")',
  );
  await waitFor(client, '!!document.querySelector(".bp-dashboard-history")');
  await click('Export history (JSON)');
  const json = await lastDownload();
  assert(json, 'a JSON download happened');
  assert.match(json.name, /^better-party-history-\d{4}-\d{2}-\d{2}\.json$/);
  const parsed = JSON.parse(json.text);
  assert.equal(parsed.format, 'better-party.results');
  assert.equal(parsed.version, 1);
  assert.equal(parsed.matches.length, 1);
  assert.equal(parsed.matches[0].holes, 1);
  assert.equal(parsed.matches[0].courses[0].par, par);
  assert.equal(parsed.matches[0].standings[0].name, 'Export host');
  assert.deepEqual(Object.keys(parsed.matches[0].standings[0]).sort(), [
    'holesSurvived',
    'name',
    'rank',
    'totalStrokes',
    'totalTimeMs',
  ]);
  for (const forbidden of ['uid', 'session', 'token', 'spec', 'matchId']) {
    assert(!json.text.includes(forbidden), 'JSON must not contain ' + forbidden);
  }
  console.log('PASS the history JSON is versioned, projected and free of internal ids');

  const exceptions = client.events.filter((event) => event.type === 'exception');
  assert.equal(exceptions.length, 0, JSON.stringify(exceptions));
  console.log('PASS no page exceptions');
} finally {
  client.close();
}
