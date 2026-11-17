import { connect, waitFor } from './cdp.mjs';
import assert from 'node:assert/strict';
const base = process.env.BASE || 'http://127.0.0.1:8789',
  debug = 'http://127.0.0.1:9239';
const c = await connect(
  (await fetch(debug + '/json/list').then((r) => r.json())).find((t) => t.type === 'page'),
);
const state = '(await import("/assets/runtime-DL2fiDAQ.js")).E.state';
const expect = (cond) => waitFor(c, `(async()=>{const s=${state};return (${cond})})()`, 25000);
const click = async (label) => {
  const r = await c.evalJS(
    `(()=>{const b=[...document.querySelectorAll("button,a")].find(b=>b.textContent===${JSON.stringify(label)}||b.getAttribute("aria-label")===${JSON.stringify(label)});if(!b||b.disabled)return null;b.scrollIntoView({block:"nearest"});const r=b.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;return {x,y,hit:b.contains(document.elementFromPoint(x,y))}})()`,
  );
  assert(r?.hit, 'Not pointer-clickable: ' + label + ' ' + JSON.stringify(r));
  await c.call('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: r.x,
    y: r.y,
    button: 'left',
    clickCount: 1,
  });
  await c.call('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: r.x,
    y: r.y,
    button: 'left',
    clickCount: 1,
  });
};
try {
  await c.call('Page.navigate', { url: base + '/home' });
  await waitFor(c, 'typeof document.querySelector("#create")?.onclick==="function"');
  assert.equal(await c.evalJS('!!document.querySelector("#catalog")'), false);
  console.log('PASS home has no community catalog');
  await c.evalJS('document.querySelector("#create").click()');
  await waitFor(c, '[...document.querySelectorAll("input")].some(x=>x.placeholder==="Your name")');
  await c.evalJS(
    '(()=>{let x=document.querySelector("input");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(x,"UI Test");x.dispatchEvent(new Event("input",{bubbles:true}));})()',
  );
  await waitFor(
    c,
    '[...document.querySelectorAll("button")].some(b=>b.textContent==="Join"&&!b.disabled)',
  );
  await click('Join');
  await expect('s.isHost&&s.mapReady');
  async function setNumber(label, value) {
    await c.evalJS(
      `(()=>{const x=[...document.querySelectorAll("input")].find(x=>x.getAttribute("aria-label")===${JSON.stringify(label)});if(x.type!=="number")throw Error("not a number input");x.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(x,${JSON.stringify(String(value))});x.dispatchEvent(new Event("input",{bubbles:true}));})()`,
    );
    await c.call('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
    });
    await c.call('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
    });
  }
  await setNumber('Holes', 7);
  await expect('s.config.holes===7');
  await setNumber('Timer', 127);
  await expect('s.config.timerMs===127000');
  await c.evalJS(
    '[...document.querySelectorAll("input")].find(x=>x.getAttribute("aria-label")==="Exclude daily holes").click()',
  );
  await expect('s.config.excludeDaily');
  await waitFor(
    c,
    '[...document.querySelectorAll("input")].filter(x=>x.type==="range"&&["Holes slider","Timer slider"].includes(x.getAttribute("aria-label"))).length===2',
  );
  assert.equal(
    await c.evalJS(
      '[...document.querySelectorAll("input")].find(x=>x.getAttribute("aria-label")==="Timer slider").value',
    ),
    '127',
  );
  await c.evalJS(
    '[...document.querySelectorAll("input")].find(x=>x.getAttribute("aria-label")==="Holes slider").focus()',
  );
  await c.call('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'ArrowLeft',
    code: 'ArrowLeft',
    windowsVirtualKeyCode: 37,
  });
  await c.call('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'ArrowLeft',
    code: 'ArrowLeft',
    windowsVirtualKeyCode: 37,
  });
  await expect('s.config.holes===6');
  assert.equal(
    await c.evalJS(
      '[...document.querySelectorAll("input")].find(x=>x.getAttribute("aria-label")==="Holes").value',
    ),
    '6',
  );
  await setNumber('Holes', 7);
  await expect('s.config.holes===7');
  const code = await c.evalJS(`(async()=>${state}.code)()`);
  assert.equal(
    await c.evalJS(
      '[...document.querySelectorAll("a,button")].filter(x=>x.getAttribute("aria-label")==="Back to home").length',
    ),
    1,
  );
  await click('Back to home');
  await waitFor(
    c,
    'location.pathname==="/home"&&typeof document.querySelector("#create")?.onclick==="function"',
  );
  await waitFor(c, '!document.querySelector("#resume").hidden');
  assert.equal(
    await c.evalJS('document.querySelector("#resume").textContent'),
    'Return to ' + code,
  );
  const uid = await c.evalJS('sessionStorage.getItem(' + JSON.stringify('bp.uid.' + code) + ')');
  await click('Return to ' + code);
  await expect('s.isHost&&s.mapReady&&s.config.holes===7&&s.config.timerMs===127000');
  assert.equal(await c.evalJS(`(async()=>${state}.self.uid)()`), uid);
  assert.equal(
    await c.evalJS('[...document.querySelectorAll("input")].some(x=>x.placeholder==="Your name")'),
    false,
  );
  console.log('PASS automatic return with same identity and settings');
  await c.evalJS(
    '(()=>{let x=document.querySelector("[aria-label=\\"Party map selection\\"]");x.value="picked";x.dispatchEvent(new Event("change",{bubbles:true}));})()',
  );
  await waitFor(c, 'document.querySelectorAll(".bp-catalog-scroll li img").length>=24');
  await waitFor(
    c,
    '[...document.querySelectorAll(".bp-catalog-scroll li img")].filter(x=>x.complete&&x.naturalWidth>0).length>=2',
  );
  const info = await c.evalJS(
    '(()=>{let el=document.querySelector(".bp-catalog-scroll li"),img=el.querySelector("img"),grid=el.parentElement;return {cards:grid.children.length,columns:getComputedStyle(grid).gridTemplateColumns,image:img.naturalWidth,aspect:getComputedStyle(img).aspectRatio,background:getComputedStyle(document.querySelector(".bp-community")).backgroundColor}})()',
  );
  console.log('PASS community cards', info);
  assert.equal(info.cards, 24);
  await c.evalJS(
    '[...document.querySelectorAll("button")].find(b=>b.getAttribute("aria-label")?.startsWith("Add ")).click()',
  );
  await expect('s.config.selectedHoleIds.length===1');
  await waitFor(c, '!!document.querySelector(".bp-playlist-item img")');
  await c.evalJS(
    '[...document.querySelectorAll("button")].filter(b=>b.getAttribute("aria-label")?.startsWith("Add "))[1].click()',
  );
  await expect('s.config.selectedHoleIds.length===2');
  for (let i = 3; i <= 11; i++) {
    await waitFor(
      c,
      '[...document.querySelectorAll("button")].some(b=>b.getAttribute("aria-label")?.startsWith("Add ")&&!b.disabled)',
    );
    await c.evalJS(
      '[...document.querySelectorAll("button")].find(b=>b.getAttribute("aria-label")?.startsWith("Add ")&&!b.disabled).click()',
    );
    await expect('s.config.selectedHoleIds.length===' + i);
  }
  console.log('PASS eleven manual playlist entries');
  assert.equal(
    await c.evalJS(
      '[...document.querySelectorAll("input")].some(x=>x.getAttribute("aria-label")==="Exclude daily holes")',
    ),
    false,
  );
  await c.evalJS(
    '(()=>{let x=[...document.querySelectorAll("input")].find(x=>x.getAttribute("aria-label")==="Playlist name");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(x,"Test playlist");x.dispatchEvent(new Event("input",{bubbles:true}));})()',
  );
  await click('Save playlist');
  await waitFor(
    c,
    '[...document.querySelectorAll("select")].find(x=>x.getAttribute("aria-label")==="Saved playlists").options.length>1',
  );
  const original = await c.evalJS(`(async()=>${state}.config.selectedHoleIds)()`);
  await click('Clear');
  await expect('s.config.selectedHoleIds.length===0');
  await click('Load saved playlist');
  await expect('s.config.selectedHoleIds.length===11');
  const restored = await c.evalJS(`(async()=>${state}.config.selectedHoleIds)()`);
  assert.deepEqual(restored, original);
  console.log('PASS save, clear, reload playlist', restored.length);
  const mode = async (v) =>
    c.evalJS(
      `(()=>{const x=[...document.querySelectorAll("select")].find(x=>x.getAttribute("aria-label")==="Party map selection");x.value=${JSON.stringify(v)};x.dispatchEvent(new Event("change",{bubbles:true}));})()`,
    );
  await mode('random');
  await expect('s.config.holes===7&&s.config.excludeDaily');
  await mode('picked');
  await expect('s.config.holes===11');
  await c.evalJS(
    '(async()=>{(await import("/assets/runtime-DL2fiDAQ.js")).D({timerMs:60000,elimination:false})})()',
  );
  await expect('!s.config.elimination');
  await click('Start party');
  await expect('s.phase==="playing"&&s.mapReady');
  await click('Party controls');
  await click('Skip level');
  await click('Confirm');
  await expect('s.holeIndex===1&&s.phase==="playing"&&s.mapReady');
  await click('Party controls');
  await click('End party');
  await click('Confirm');
  await expect('s.phase==="final"&&s.final?.standings?.length===1');
  await click('Scorecard');
  await waitFor(c, '!!document.querySelector(".bp-scorecard table")');
  const table = await c.evalJS('document.querySelector(".bp-scorecard table").innerText');
  assert(table.includes('Skip'));
  assert(table.includes('UI Test'));
  console.log('PASS visible scorecard', table);
  assert.equal(
    c.events.filter((e) => e.type === 'exception').length,
    0,
    'Browser runtime exceptions',
  );
} finally {
  console.log(
    'Browser errors',
    JSON.stringify(c.events.filter((e) => e.type === 'exception' || e.type === 'http').slice(-10)),
  );
  c.close();
}
