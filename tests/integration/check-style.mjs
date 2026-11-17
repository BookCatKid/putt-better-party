import { connect, waitFor } from './cdp.mjs';
import assert from 'node:assert/strict';
const target = (
  await fetch('http://127.0.0.1:9239/json/list').then((response) => response.json())
).find((pageTarget) => pageTarget.type === 'page');
const client = await connect(target);
try {
  await client.call('Page.navigate', {
    url: (process.env.BASE || 'http://127.0.0.1:8789') + '/home',
  });
  await waitFor(client, 'typeof document.querySelector("#create")?.onclick === "function"');
  await client.evalJS('document.querySelector("#create").click()');
  await waitFor(client, '!!document.querySelector("input[placeholder=\\"Your name\\"]")');
  const joinStyle = await client.evalJS(
    '(()=>{let x=document.querySelector("main.bp-home"),p=x.querySelector(".bp-entry");return {display:getComputedStyle(x).display,position:getComputedStyle(x).position,width:getComputedStyle(p).maxWidth,sheets:[...document.styleSheets].map(s=>s.cssRules.length)}})()',
  );
  assert.equal(joinStyle.display, 'grid');
  assert.equal(joinStyle.width, '400px');
  assert(joinStyle.sheets.some((count) => count > 3));
  await client.evalJS(
    '(()=>{let x=document.querySelector("input[placeholder=\\"Your name\\"]");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(x,"Style test");x.dispatchEvent(new Event("input",{bubbles:true}));})()',
  );
  await waitFor(
    client,
    '!![...document.querySelectorAll("button")].find(b=>b.textContent==="Join"&&!b.disabled)',
  );
  await client.evalJS(
    '[...document.querySelectorAll("button")].find(b=>b.textContent==="Join").click()',
  );
  await waitFor(
    client,
    '!!document.querySelector("select[aria-label=\\"Party map selection\\"]")',
    30000,
  );
  const style = await client.evalJS(
    '(()=>{let x=[...document.querySelectorAll("h1,h2")].find(x=>x.textContent==="Party lobby");let p=x.closest(".rounded-3xl");return {lobbyWidth:getComputedStyle(p).maxWidth,headingSize:getComputedStyle(x).fontSize,headingWeight:getComputedStyle(x).fontWeight,font:getComputedStyle(x).fontFamily,background:getComputedStyle(p).backgroundColor,layout:getComputedStyle(p.parentElement).display}})()',
  );
  console.log('Join styles', joinStyle, 'Lobby styles', style);
  assert.equal(style.layout, 'flex');
  assert.notEqual(style.background, 'rgba(0, 0, 0, 0)');
  assert.notEqual(style.lobbyWidth, 'none');
  const png = await client.call('Page.captureScreenshot', { format: 'png' });
  await Bun.write('style-proof.png', Buffer.from(png.data, 'base64'));
  await client.evalJS(
    '(()=>{let s=document.querySelector("select[aria-label=\\"Party map selection\\"]");s.value="picked";s.dispatchEvent(new Event("change",{bubbles:true}));})()',
  );
  await waitFor(client, '!!document.querySelector("button[aria-label^=\\"Add \\"]")', 30000);
  const body = await client.evalJS('document.body.innerText');
  assert(!body.includes('Cached / local'));
  assert(!body.includes('Random cached holes'));
  assert(await client.evalJS('document.querySelectorAll(".bp-catalog-scroll li").length>0'));
  console.log('PASS actual browser CSS and public-only picker');
  const pic = await client.call('Page.captureScreenshot', { format: 'png' });
  await Bun.write('picker-proof.png', Buffer.from(pic.data, 'base64'));
} finally {
  client.close();
}
