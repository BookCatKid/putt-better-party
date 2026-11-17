import { connect, waitFor } from './cdp.mjs';
import assert from 'node:assert/strict';
const base = process.env.BASE || 'http://127.0.0.1:8790',
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
} finally {
  console.log('Browser errors', JSON.stringify(c.events.filter((e) => e.type === 'exception')));
  c.close();
}
