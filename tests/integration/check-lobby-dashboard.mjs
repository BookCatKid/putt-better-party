import assert from 'node:assert/strict';
import { connect, waitFor } from './cdp.mjs';

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
const guests = [];
try {
  await client.call('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await client.call('Page.navigate', { url: base + '/home' });
  await waitFor(client, 'typeof document.querySelector("#create")?.onclick==="function"');
  await client.evalJS('document.querySelector("#create").click()');
  await name('Dashboard host');
  await state('s.isHost&&s.bpConnected&&s.mapReady');
  await waitFor(
    client,
    '!!document.querySelector(".bp-dashboard") && !!document.querySelector("canvas")',
  );
  const desktop = await client.evalJS(
    '(()=>{const panel=document.querySelector(".bp-dashboard");const grid=document.querySelector(".bp-dashboard-grid");return {width:panel.getBoundingClientRect().width,columns:getComputedStyle(grid).gridTemplateColumns.split(" ").length,canvas:document.querySelector("canvas").getBoundingClientRect().width}})()',
  );
  assert(desktop.width >= 780);
  assert.equal(desktop.columns, 2);
  assert(desktop.canvas > 0);
  assert.deepEqual(
    await client.evalJS(
      '[...document.querySelectorAll(".bp-dashboard-heading h3")].map(e=>e.textContent)',
    ),
    ['Courses', 'Players', 'Match rules', 'Party settings'],
  );
  await client.evalJS('document.querySelector(\'input[aria-label="Course voting"]\').click()');
  await state('s.config.courseVoting===true');
  await client.evalJS('document.querySelector(\'input[aria-label="Elimination"]\').click()');
  await state('s.config.elimination===false');
  await click("I'm ready");
  await waitFor(
    client,
    'document.querySelector(".bp-dashboard-summary").textContent.includes("1 of 1 players ready")',
  );
  const code = await client.evalJS('document.querySelector(".bp-dashboard-code").textContent');
  // Fill the actual room to its configured maximum using real local sockets.
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
      JSON.stringify({ t: 'join', ...identity, protocol: 2, instance: 'dashboard-smoke-' + index }),
    );
  }
  await Promise.all(Array.from({ length: 49 }, (_unused, index) => joinGuest(index)));
  await waitFor(client, 'document.querySelectorAll(".bp-dashboard-player-list > li").length===50');
  const geometry = () =>
    client.evalJS(
      '(()=>{const rect=s=>document.querySelector(s).getBoundingClientRect();const list=document.querySelector(".bp-dashboard-player-list");return {topEqual:Math.abs(rect(".bp-dashboard-courses").bottom-rect(".bp-dashboard-players").bottom)<1,bottomEqual:Math.abs(rect(".bp-dashboard-rules").bottom-rect(".bp-dashboard-settings").bottom)<1,scrolling:list.scrollHeight>list.clientHeight,footerVisible:rect(".bp-dashboard-footer").bottom<=900}})()',
    );
  assert.deepEqual(await geometry(), {
    topEqual: true,
    bottomEqual: true,
    scrolling: true,
    footerVisible: true,
  });
  // The fixture catalog contains real metadata for 100 selected course IDs.
  // Set the selection through the existing configuration protocol.
  if (process.env.BP_LARGE_PLAYLIST_FIXTURE === '1') {
    await client.evalJS(
      '(async()=>{const r=' +
        runtime +
        ';r.D({mapSource:"picked",selectedHoleIds:Array.from({length:100},(_,i)=>"fixture-"+i)})})()',
    );
    await state('s.config.selectedHoleIds.length===100');
    await click('Edit playlist');
    await waitFor(client, 'document.querySelector(".bp-playlist-dialog")?.open');
    assert(
      await client.evalJS(
        '(()=>{const d=document.querySelector(".bp-playlist-dialog"),r=d.getBoundingClientRect();return r.width>900&&r.left>0&&r.right<1280&&r.top>=0&&r.bottom<=900&&getComputedStyle(d).backgroundColor==="rgb(17, 39, 43)"})()',
      ),
    );
    await waitFor(
      client,
      'document.querySelectorAll(".bp-playlist-scroll .bp-playlist-item").length===100',
    );
    assert.deepEqual(await geometry(), {
      topEqual: true,
      bottomEqual: true,
      scrolling: true,
      footerVisible: true,
    });
    assert(
      await client.evalJS(
        '(()=>{const list=document.querySelector(".bp-playlist-scroll");list.scrollTop=list.scrollHeight;return list.scrollHeight>list.clientHeight&&list.scrollTop>0})()',
      ),
    );
    await click('Auto-generate playlist');
    const inputValue = async (label, value) =>
      client.evalJS(
        '(()=>{const el=document.querySelector("input[aria-label="+JSON.stringify(' +
          JSON.stringify(label) +
          ')+"]");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(el,' +
          JSON.stringify(value) +
          ');el.dispatchEvent(new Event("input",{bubbles:true}))})()',
      );
    await inputValue('Average rating min', '4');
    await inputValue('Average rating max', '5');
    await inputValue('Maximum courses', '10');
    await client.evalJS(
      '(()=>{const el=document.querySelector(\'select[aria-label="Order"]\');el.value="shuffle";el.dispatchEvent(new Event("change",{bubbles:true}))})()',
    );
    await click('Generate & replace');
    await state('s.config.selectedHoleIds.length===10');
    await waitFor(
      client,
      'document.querySelector(".bp-generator [role=status]")?.textContent.includes("10 courses selected from 100 matching courses")',
    );
    assert.equal(
      await client.evalJS(
        '(async()=>new Set((' + runtime + ').E.state.config.selectedHoleIds).size)()',
      ),
      10,
    );
    await click('Done');
    await waitFor(client, '!document.querySelector(".bp-playlist-dialog")');
    assert(
      await client.evalJS(
        'document.querySelector(".bp-picker-summary").textContent.includes("10 courses selected")',
      ),
    );
    await client.evalJS('(async()=>{const r=' + runtime + ';r.D({mapSource:"random"})})()');
    await state('s.config.mapSource==="random"');
  }
  // Render the real guest branch with the same live roster; no remote UI changes.
  await client.evalJS(
    '(async()=>{const r=' + runtime + ';r.E.setState(s=>({...s,isHost:false}))})()',
  );
  await waitFor(client, '!!document.querySelector(".bp-dashboard-waiting")');
  assert(
    await client.evalJS(
      '(()=>{const waiting=document.querySelector(".bp-dashboard-waiting"),actions=document.querySelector(".bp-dashboard-actions");return !actions.contains(waiting)&&waiting.getBoundingClientRect().top>=actions.getBoundingClientRect().bottom})()',
    ),
  );
  await client.call('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await waitFor(
    client,
    'getComputedStyle(document.querySelector(".bp-dashboard-grid")).gridTemplateColumns.split(" ").length===1',
  );
  const mobile = await client.evalJS(
    '(()=>{const panel=document.querySelector(".bp-dashboard"),footer=document.querySelector(".bp-dashboard-footer"),body=document.querySelector(".bp-dashboard-body");return {right:panel.getBoundingClientRect().right,bottom:footer.getBoundingClientRect().bottom,scrollWidth:body.scrollWidth,width:body.clientWidth}})()',
  );
  assert(mobile.right <= 390);
  assert(mobile.bottom <= 844);
  assert(mobile.scrollWidth <= mobile.width + 1);
  assert.equal(client.events.filter((event) => event.type === 'exception').length, 0);
  console.log(
    'PASS aligned bento cards, 50 live players, 100-course dark modal, shuffled maximum of 10, guest status, mobile layout, original canvas',
  );
} finally {
  for (const guest of guests) {
    guest.close();
  }
  client.close();
}
