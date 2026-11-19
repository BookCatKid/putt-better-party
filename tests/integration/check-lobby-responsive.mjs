import assert from 'node:assert/strict';
import { connect, waitFor } from './cdp.mjs';

/*
 * Lobby responsiveness across the viewport edges a phone can actually reach.
 *
 * The dashboard pins its header and footer and scrolls only the body, so the
 * failure mode at very short viewports is not a squeezed panel — it is the
 * footer being pushed past max-height and clipped by overflow: hidden, which
 * makes Start and Leave unreachable. A compact-chrome media query below
 * 440 CSS px of height keeps both pinned ends inside the box; these sweeps
 * assert the controls, not the media query, so a regression that only hides
 * the buttons still fails.
 *
 * The playlist dialog is exercised at the same widths with a real imported
 * playlist: course ids come from the live catalog and are registered through
 * /api/import (the same route the picker uses), because the room rejects
 * selectedHoleIds it has never seen.
 */
const base = process.env.BASE || 'http://127.0.0.1:8789';
const debugging = 'http://127.0.0.1:9239';
const target = (await fetch(debugging + '/json/list').then((response) => response.json())).find(
  (entry) => entry.type === 'page',
);
const client = await connect(target);
const runtime = '(await import("/assets/runtime-DL2fiDAQ.js"))';
const state = (condition) =>
  waitFor(
    client,
    '(async()=>{const s=' +
      runtime +
      '.E.state;return (' +
      condition +
      ')&&!document.querySelector(".bp-party-loading")})()',
    45000,
  );
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
const viewport = (width, height, mobile = width < 700) =>
  client.call('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile,
  });
const guests = [];
try {
  await viewport(1280, 800, false);
  await client.call('Page.navigate', { url: base + '/home' });
  await waitFor(client, 'typeof document.querySelector("#create")?.onclick==="function"');
  await client.evalJS('document.querySelector("#create").click()');
  await name('Responsive host');
  await state('s.isHost&&s.bpConnected&&s.mapReady');
  await waitFor(client, '!!document.querySelector(".bp-dashboard")');
  const code = await client.evalJS('document.querySelector(".bp-dashboard-code").textContent');
  // A handful of real socket guests, so the player list has actual rows.
  async function joinGuest(index) {
    const response = await fetch(base + '/api/join', {
      method: 'POST',
      headers: { origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ code, name: 'Guest ' + index }),
    });
    assert(response.ok);
    const identity = await response.json();
    const guest = new WebSocket(base.replace('http', 'ws') + '/ws/party/' + code, {
      headers: { origin: base },
    });
    guests.push(guest);
    await new Promise((resolve, reject) => {
      guest.onopen = resolve;
      guest.onerror = reject;
    });
    guest.send(
      JSON.stringify({ t: 'join', ...identity, protocol: 2, instance: 'responsive-' + index }),
    );
  }
  await Promise.all(Array.from({ length: 4 }, (_unused, index) => joinGuest(index)));
  await waitFor(client, 'document.querySelectorAll(".bp-dashboard-player-list > li").length===5');

  /*
   * Every footer control must sit inside the viewport. That is the assertion
   * the 568x320 landscape layout failed before compact chrome: the buttons
   * were painted past the panel's clipped edge.
   */
  const dashboardFits = (width, height) =>
    client.evalJS(
      '(()=>{const q=s=>document.querySelector(s)?.getBoundingClientRect();' +
        'const panel=q(".bp-dashboard"),footer=q(".bp-dashboard-footer");' +
        'const actions=[...document.querySelectorAll(".bp-dashboard-actions button")].map(b=>b.getBoundingClientRect());' +
        'const doc=document.documentElement;return {' +
        'inside:panel.left>=-0.5&&panel.right<=' +
        (width + 0.5) +
        '&&panel.top>=-0.5&&panel.bottom<=' +
        (height + 0.5) +
        ',' +
        'footerIn:footer.bottom<=' +
        (height + 0.5) +
        '&&footer.top>=-0.5,' +
        'actionsIn:actions.length>0&&actions.every(r=>r.bottom<=' +
        (height + 0.5) +
        '&&r.right<=' +
        (width + 0.5) +
        '&&r.top>=-0.5),' +
        'noDocOverflow:doc.scrollWidth<=doc.clientWidth,' +
        'columns:getComputedStyle(document.querySelector(".bp-dashboard-grid")).gridTemplateColumns.split(" ").length}})()',
    );
  const cases = [
    [1280, 800, 2],
    [390, 844, 1],
    [320, 568, 1],
    [844, 390, 2],
    [568, 320, 1],
  ];
  for (const [width, height, columns] of cases) {
    await viewport(width, height);
    await waitFor(
      client,
      'getComputedStyle(document.querySelector(".bp-dashboard-grid")).gridTemplateColumns.split(" ").length===' +
        columns,
    );
    assert.deepEqual(await dashboardFits(width, height), {
      inside: true,
      footerIn: true,
      actionsIn: true,
      noDocOverflow: true,
      columns,
    });
  }

  /*
   * A real picked playlist: ids are registered through /api/import (fetch +
   * validate the upstream detail, the picker route) and then selected through
   * the ordinary config frame, so configure() sees known course ids.
   */
  const catalog = await fetch(base + '/api/catalog?sort=new').then((response) => response.json());
  const ids = catalog.holes.slice(0, 3).map((hole) => hole.id);
  assert.equal(ids.length, 3);
  for (const id of ids) {
    const imported = await client.evalJS(
      '(async()=>{const s=' +
        runtime +
        '.E.state;const response=await fetch("/api/import",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({code:s.code,uid:s.self.uid,session:s.self.session,host:sessionStorage.getItem("bp.host."+s.code),id:' +
        JSON.stringify(id) +
        '})});return response.status})()',
      30000,
    );
    assert.equal(imported, 200, 'import of catalog course ' + id);
  }
  await client.evalJS(
    '(async()=>{const r=' +
      runtime +
      ';r.D({mapSource:"picked",selectedHoleIds:' +
      JSON.stringify(ids) +
      '})})()',
  );
  await state('s.config.mapSource==="picked"&&s.config.selectedHoleIds.length===3');
  await waitFor(
    client,
    'document.querySelector(".bp-picker-summary")?.textContent.includes("3 courses selected")',
  );

  // The playlist dialog is a fixed modal: it must fit inside the viewport at
  // every width, with Done reachable, and its layout must collapse to one
  // column at narrow widths instead of crushing the catalog column.
  const dialogFits = (width, height) =>
    client.evalJS(
      '(()=>{const q=s=>document.querySelector(s)?.getBoundingClientRect();' +
        'const dialog=document.querySelector(".bp-playlist-dialog");' +
        'const rect=dialog.getBoundingClientRect();' +
        'const done=[...dialog.querySelectorAll("button")].find(b=>b.textContent==="Done").getBoundingClientRect();' +
        'const community=dialog.querySelector(".bp-community");' +
        'const layout=dialog.querySelector(".bp-catalog-layout");return {' +
        'inside:rect.left>=-0.5&&rect.right<=' +
        (width + 0.5) +
        '&&rect.top>=-0.5&&rect.bottom<=' +
        (height + 0.5) +
        ',' +
        'doneIn:done.bottom<=' +
        (height + 0.5) +
        '&&done.top>=-0.5,' +
        'columns:getComputedStyle(layout).gridTemplateColumns.split(" ").length,' +
        'pickedItems:document.querySelectorAll(".bp-playlist-scroll .bp-playlist-item").length,' +
        'noCommOverflow:!community||community.scrollWidth<=community.clientWidth+1}})()',
    );
  const dialogCases = [
    [1280, 800, 2],
    [390, 844, 1],
    [320, 568, 1],
    [568, 320, 1],
  ];
  for (const [width, height, columns] of dialogCases) {
    await viewport(width, height);
    await click('Edit playlist');
    await waitFor(client, 'document.querySelector(".bp-playlist-dialog")?.open', 20000);
    await waitFor(
      client,
      'document.querySelectorAll(".bp-playlist-scroll .bp-playlist-item").length===3',
    );
    const measured = await dialogFits(width, height);
    assert.deepEqual(measured, {
      inside: true,
      doneIn: true,
      columns,
      pickedItems: 3,
      noCommOverflow: true,
    });
    await click('Done');
    await waitFor(client, '!document.querySelector(".bp-playlist-dialog[open]")', 10000);
  }

  /*
   * Touch and keyboard reorder. HTML5 drag-and-drop does not fire on touch,
   * so the arrow/remove buttons are the only mobile path: they must be real
   * buttons at a hittable size, and Space on a focused button must reorder
   * through the real input pipeline rather than a scripted click().
   */
  await viewport(390, 844);
  await click('Edit playlist');
  await waitFor(client, 'document.querySelector(".bp-playlist-dialog")?.open', 20000);
  await waitFor(
    client,
    'document.querySelectorAll(".bp-playlist-scroll .bp-playlist-item").length===3',
  );

  /*
   * The community card's Stats expander: a real toggle per card, fetching
   * /api/hole-stats on first expand like the official gallery does. The dl
   * must show Completions from the card and Avg strokes resolved live — a
   * number, or — when the course genuinely has no average yet.
   */
  await waitFor(
    client,
    'document.querySelectorAll(".bp-catalog-scroll > ul > li").length>=6',
    45000,
  );
  await client.evalJS(
    'document.querySelector(".bp-catalog-scroll > ul > li button[aria-expanded]").click()',
  );
  await waitFor(client, '!!document.querySelector(".bp-catalog-scroll dl")');
  await waitFor(
    client,
    '[...document.querySelectorAll(".bp-catalog-scroll dl dd")][1]?.textContent!=="…"',
    20000,
  );
  const statsPanel = await client.evalJS(
    '(()=>{const dl=document.querySelector(".bp-catalog-scroll dl");return {' +
      'labels:[...dl.querySelectorAll("dt")].map(e=>e.textContent),' +
      'completions:dl.querySelector("dd").textContent,' +
      'strokes:[...dl.querySelectorAll("dd")][1].textContent,' +
      'expanded:document.querySelector(".bp-catalog-scroll button[aria-expanded]").getAttribute("aria-expanded")}})()',
  );
  assert.deepEqual(statsPanel.labels, ['Completions', 'Avg strokes']);
  assert(statsPanel.completions.startsWith('⛳ '), JSON.stringify(statsPanel));
  assert(/^—$|^\d+\.\d$/.test(statsPanel.strokes), JSON.stringify(statsPanel));
  assert.equal(statsPanel.expanded, 'true');
  const targets = await client.evalJS(
    '[...document.querySelectorAll(".bp-playlist-actions button")].map(b=>{const r=b.getBoundingClientRect();return r.width>=24&&r.height>=24&&b.tagName==="BUTTON"})',
  );
  assert.equal(targets.length, 9);
  assert(targets.every(Boolean), 'playlist action buttons below the 24px touch target');
  const orderBefore = await client.evalJS(
    '(async()=>(' + runtime + ').E.state.config.selectedHoleIds.join(","))()',
  );
  await client.evalJS('document.querySelectorAll(".bp-playlist-actions button")[1].focus()');
  for (const type of ['keyDown', 'keyUp']) {
    await client.call('Input.dispatchKeyEvent', {
      type,
      key: ' ',
      code: 'Space',
      windowsVirtualKeyCode: 32,
    });
  }
  await waitFor(
    client,
    '(async()=>(' +
      runtime +
      ').E.state.config.selectedHoleIds.join(","))()!==' +
      JSON.stringify(orderBefore),
  );
  // The real Space press puts the page in keyboard modality, so scripted
  // focus now matches :focus-visible and the ring must actually paint.
  await client.evalJS('document.querySelectorAll(".bp-playlist-actions button")[4].focus()');
  const ring = await client.evalJS(
    '(()=>{const s=getComputedStyle(document.activeElement);return {w:s.outlineWidth,style:s.outlineStyle}})()',
  );
  assert.deepEqual(ring, { w: '2px', style: 'solid' });
  await click('Done');
  await waitFor(client, '!document.querySelector(".bp-playlist-dialog[open]")', 10000);

  // Restore a neutral viewport and leave the dashboard reachable behind us.
  await viewport(1280, 800, false);
  console.log('check-lobby-responsive: ok');
} finally {
  for (const guest of guests) {
    guest.close();
  }
  client.close();
}
process.exit(0);
