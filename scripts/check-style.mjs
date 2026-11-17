import {connect,waitFor} from './cdp.mjs';
import assert from 'node:assert/strict';
const target=(await fetch('http://127.0.0.1:9239/json/list').then(r=>r.json())).find(t=>t.type==='page');
const c=await connect(target);
try{
 await c.call('Page.navigate',{url:'http://127.0.0.1:8789/home'});
 await waitFor(c,'!!document.querySelector("#create")');
 await c.evalJS('document.querySelector("#create").click()');
 await waitFor(c,'!!document.querySelector("input[placeholder=\\\"Your name\\\"]")');
 const joinStyle=await c.evalJS('(()=>{let x=document.querySelector("main"),p=x.parentElement;return {display:getComputedStyle(p).display,position:getComputedStyle(p).position,width:getComputedStyle(x).maxWidth,sheets:[...document.styleSheets].map(s=>s.cssRules.length)}})()');
 assert.equal(joinStyle.display,'flex');assert.equal(joinStyle.position,'fixed');assert(joinStyle.sheets.some(n=>n>3));
 await c.evalJS('(()=>{let x=document.querySelector("input[placeholder=\\\"Your name\\\"]");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(x,"Style test");x.dispatchEvent(new Event("input",{bubbles:true}));})()');
 await waitFor(c,'!![...document.querySelectorAll("button")].find(b=>b.textContent==="Join"&&!b.disabled)');
 await c.evalJS('[...document.querySelectorAll("button")].find(b=>b.textContent==="Join").click()');
 await waitFor(c,'!!document.querySelector("select[aria-label=\\\"Party map selection\\\"]")',30000);
 const style=await c.evalJS('(()=>{let x=[...document.querySelectorAll("h1,h2")].find(x=>x.textContent==="Party lobby");let p=x.closest(".rounded-3xl");return {lobbyWidth:getComputedStyle(p).maxWidth,headingSize:getComputedStyle(x).fontSize,headingWeight:getComputedStyle(x).fontWeight,font:getComputedStyle(x).fontFamily,background:getComputedStyle(p).backgroundColor,layout:getComputedStyle(p.parentElement).display}})()');
 console.log('Join styles',joinStyle,'Lobby styles',style);
 assert.equal(style.layout,'flex');assert.notEqual(style.background,'rgba(0, 0, 0, 0)');assert.notEqual(style.lobbyWidth,'none');
 const png=await c.call('Page.captureScreenshot',{format:'png'});
 await Bun.write('style-proof.png',Buffer.from(png.data,'base64'));
 await c.evalJS('(()=>{let s=document.querySelector("select[aria-label=\\\"Party map selection\\\"]");s.value="picked";s.dispatchEvent(new Event("change",{bubbles:true}));})()');
 await waitFor(c,'!!document.querySelector("button[aria-label^=\\\"Add \\\"]")',30000);
 const body=await c.evalJS('document.body.innerText');
 assert(!body.includes('Cached / local'));assert(!body.includes('Random cached holes'));assert(body.includes('422 courses'));
 console.log('PASS actual browser CSS and public-only picker');
 const pic=await c.call('Page.captureScreenshot',{format:'png'});await Bun.write('picker-proof.png',Buffer.from(pic.data,'base64'));
}finally{c.close()}
