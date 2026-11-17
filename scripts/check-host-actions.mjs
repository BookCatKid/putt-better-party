import {connect,waitFor} from './cdp.mjs';
import assert from 'node:assert/strict';
const base=process.env.BASE||'http://127.0.0.1:8790',debug='http://127.0.0.1:9239';
const c=await connect((await fetch(debug+'/json/list').then(r=>r.json())).find(t=>t.type==='page'));
const state='(await import("/assets/runtime-DL2fiDAQ.js")).E.state';
const expect=cond=>waitFor(c,`(async()=>{const s=${state};return (${cond})})()`,25000);
const click=async label=>{
 const r=await c.evalJS(`(()=>{const b=[...document.querySelectorAll("button")].find(b=>b.textContent===${JSON.stringify(label)}||b.getAttribute("aria-label")===${JSON.stringify(label)});if(!b||b.disabled)return null;b.scrollIntoView({block:"nearest"});const r=b.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;return {x,y,hit:b.contains(document.elementFromPoint(x,y))}})()`);
 assert(r?.hit,'Not pointer-clickable: '+label+' '+JSON.stringify(r));
 await c.call('Input.dispatchMouseEvent',{type:'mousePressed',x:r.x,y:r.y,button:'left',clickCount:1});
 await c.call('Input.dispatchMouseEvent',{type:'mouseReleased',x:r.x,y:r.y,button:'left',clickCount:1});
};
const game='(await import("/assets/runtime-DL2fiDAQ.js")).m.state';
const read=()=>c.evalJS(`(async()=>{let s=${state},g=${game};return {matchId:s.matchId,holeIndex:s.holeIndex,name:g.level?.name,attempt:g.attemptSeq,strokes:g.strokes,ends:s.timerEndsAt,connected:s.bpConnected,phase:s.phase,levelId:g.level?.id}})()`);
try{
 await c.call('Page.navigate',{url:base+'/home'});await waitFor(c,'!!document.querySelector("#create")');
 await c.evalJS('document.querySelector("#create").click()');
 await waitFor(c,'[...document.querySelectorAll("input")].some(x=>x.placeholder==="Your name")');
 await c.evalJS('(()=>{let x=document.querySelector("input");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(x,"UI Test");x.dispatchEvent(new Event("input",{bubbles:true}));})()');
 await waitFor(c,'[...document.querySelectorAll("button")].some(b=>b.textContent==="Join"&&!b.disabled)');await click('Join');await expect('s.isHost&&s.mapReady');
 await c.evalJS('(()=>{let x=document.querySelector("[aria-label=\\\"Party map selection\\\"]");x.value="picked";x.dispatchEvent(new Event("change",{bubbles:true}));})()');
 await waitFor(c,'document.querySelectorAll(".bp-catalog-scroll li img").length>=24');
 await waitFor(c,'[...document.querySelectorAll(".bp-catalog-scroll li img")].filter(x=>x.complete&&x.naturalWidth>0).length>=2');
 const info=await c.evalJS('(()=>{let el=document.querySelector(".bp-catalog-scroll li"),img=el.querySelector("img"),grid=el.parentElement;return {cards:grid.children.length,columns:getComputedStyle(grid).gridTemplateColumns,image:img.naturalWidth,aspect:getComputedStyle(img).aspectRatio,background:getComputedStyle(document.querySelector(".bp-community")).backgroundColor}})()');console.log("PASS community cards",info);assert.equal(info.cards,24);
 await c.evalJS('[...document.querySelectorAll("button")].find(b=>b.getAttribute("aria-label")?.startsWith("Add ")).click()');await expect('s.config.selectedHoleIds.length===1');
 await waitFor(c,'!!document.querySelector(".bp-playlist-item img")');
 await c.evalJS('[...document.querySelectorAll("button")].filter(b=>b.getAttribute("aria-label")?.startsWith("Add "))[1].click()');await expect('s.config.selectedHoleIds.length===2');
 await c.evalJS('(async()=>{(await import("/assets/runtime-DL2fiDAQ.js")).D({timerMs:60000,elimination:false})})()');await expect('!s.config.elimination');
 await click('Start party');await expect('s.phase==="playing"&&s.mapReady');
 const rect=await c.evalJS('(()=>{let a=document.querySelector(".bp-toolbar").getBoundingClientRect(),b=document.querySelector(".bp-party-status").getBoundingClientRect();return {toolbarBottom:a.bottom,statusTop:b.top}})()');console.log('HUD bounds',rect);assert(rect.statusTop>=rect.toolbarBottom);
 const before=await read();
 await click('Party controls');await waitFor(c,'!!document.querySelector(".bp-host-panel")');
 await click('+30s');await expect('s.timerEndsAt-s.startAt===90000');
 const added=await read();assert(added.ends-before.ends>=29500);console.log('PASS pointer-based add time',before.ends,added.ends);
 await click('Party controls');await click('Restart level');await click('Confirm');
 await expect('s.matchId!=='+JSON.stringify(before.matchId)+'&&s.phase==="playing"&&s.mapReady');
 const restarted=await read();assert.equal(restarted.holeIndex,before.holeIndex);assert.equal(restarted.name,before.name);assert(restarted.attempt>before.attempt);assert.equal(restarted.strokes,0);
 console.log('PASS pointer-based restart with real game attempt reset',before,restarted);
 await click('Party controls');await click('Skip level');await click('Confirm');
 await expect('s.holeIndex===1&&s.phase==="playing"&&s.mapReady');
 const skipped=await read();assert.notEqual(skipped.name,before.name);assert(skipped.attempt>restarted.attempt);console.log('PASS pointer-based skip loaded different map',skipped);
 await click('Party controls');await click('End party');await click('Confirm');await expect('s.phase==="final"');console.log('PASS pointer-based end');

}finally{console.log('Browser errors',JSON.stringify(c.events.filter(e=>e.type==='exception'||e.type==='http').slice(-10)));c.close()}
