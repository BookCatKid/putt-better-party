import { connect, waitFor, clickButton } from './cdp.mjs';
import assert from 'node:assert/strict';
const base = process.env.BASE || 'http://127.0.0.1:8789';
const debug = 'http://127.0.0.1:9239';
const client = await connect(
  (await fetch(debug + '/json/list').then((response) => response.json())).find(
    (target) => target.type === 'page',
  ),
);
const state = '(await import("/assets/runtime-DL2fiDAQ.js")).E.state';
const expect = (cond) =>
  waitFor(
    client,
    `(async()=>{const s=${state};return (${cond})&&!document.querySelector(".bp-party-loading")})()`,
    25000,
  );
const click = (label) => clickButton(client, label, { selector: 'button,a' });
try {
  await client.call('Page.navigate', { url: base + '/home' });
  await waitFor(client, 'typeof document.querySelector("#create")?.onclick==="function"');
  assert.equal(await client.evalJS('!!document.querySelector("#catalog")'), false);
  console.log('PASS home has no community catalog');
  await client.evalJS('document.querySelector("#create").click()');
  await waitFor(
    client,
    '[...document.querySelectorAll("input")].some(x=>x.placeholder==="Your name")',
  );
  await client.evalJS(
    '(()=>{let x=document.querySelector("input");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(x,"UI Test");x.dispatchEvent(new Event("input",{bubbles:true}));})()',
  );
  await waitFor(
    client,
    '[...document.querySelectorAll("button")].some(b=>b.textContent==="Join"&&!b.disabled)',
  );
  await click('Join');
  await expect('s.isHost&&s.mapReady');
  async function setNumber(label, value) {
    await client.evalJS(
      `(()=>{const x=[...document.querySelectorAll("input")].find(x=>x.getAttribute("aria-label")===${JSON.stringify(label)});if(x.type!=="number")throw Error("not a number input");x.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(x,${JSON.stringify(String(value))});x.dispatchEvent(new Event("input",{bubbles:true}));})()`,
    );
    await client.call('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
    });
    await client.call('Input.dispatchKeyEvent', {
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
  await client.evalJS(
    '[...document.querySelectorAll("input")].find(x=>x.getAttribute("aria-label")==="Exclude daily holes").click()',
  );
  await expect('s.config.excludeDaily');
  await waitFor(
    client,
    '[...document.querySelectorAll("input")].filter(x=>x.type==="range"&&["Holes slider","Timer slider"].includes(x.getAttribute("aria-label"))).length===2',
  );
  assert.equal(
    await client.evalJS(
      '[...document.querySelectorAll("input")].find(x=>x.getAttribute("aria-label")==="Timer slider").value',
    ),
    '127',
  );
  await client.evalJS(
    '[...document.querySelectorAll("input")].find(x=>x.getAttribute("aria-label")==="Holes slider").focus()',
  );
  await client.call('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'ArrowLeft',
    code: 'ArrowLeft',
    windowsVirtualKeyCode: 37,
  });
  await client.call('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'ArrowLeft',
    code: 'ArrowLeft',
    windowsVirtualKeyCode: 37,
  });
  await expect('s.config.holes===6');
  assert.equal(
    await client.evalJS(
      '[...document.querySelectorAll("input")].find(x=>x.getAttribute("aria-label")==="Holes").value',
    ),
    '6',
  );
  await setNumber('Holes', 7);
  await expect('s.config.holes===7');
  const code = await client.evalJS(`(async()=>${state}.code)()`);
  // The toolbar is behind the lobby dashboard, which is a blocking overlay by
  // design, so "Back to home" is only reachable once the party is running. Start
  // it first; the settings below are what the resume path has to bring back.
  await click('Start party');
  await expect('s.phase==="playing"&&s.mapReady');
  assert.equal(
    await client.evalJS(
      '[...document.querySelectorAll("a,button")].filter(x=>x.getAttribute("aria-label")==="Back to home").length',
    ),
    1,
  );
  await click('Back to home');
  await waitFor(
    client,
    'location.pathname==="/home"&&typeof document.querySelector("#create")?.onclick==="function"',
  );
  await waitFor(client, '!document.querySelector("#resume").hidden');
  assert.equal(
    await client.evalJS('document.querySelector("#resume").textContent'),
    'Return to ' + code,
  );
  const uid = await client.evalJS(
    'sessionStorage.getItem(' + JSON.stringify('bp.uid.' + code) + ')',
  );
  await click('Return to ' + code);
  await expect('s.isHost&&s.mapReady&&s.config.holes===7&&s.config.timerMs===127000');
  assert.equal(await client.evalJS(`(async()=>${state}.self.uid)()`), uid);
  assert.equal(
    await client.evalJS(
      '[...document.querySelectorAll("input")].some(x=>x.placeholder==="Your name")',
    ),
    false,
  );
  console.log('PASS automatic return with same identity and settings');
} finally {
  console.log(
    'Browser errors',
    JSON.stringify(client.events.filter((event) => event.type === 'exception')),
  );
  client.close();
}
