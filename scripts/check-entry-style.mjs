import {connect,waitFor} from './cdp.mjs';
import assert from 'node:assert/strict';
const base=process.env.BASE||'http://127.0.0.1:8789';
const c=await connect((await fetch('http://127.0.0.1:9239/json/list').then(r=>r.json())).find(t=>t.type==='page'));
const styles=()=>c.evalJS('(()=>{const s=e=>getComputedStyle(e),head=document.querySelector(".bp-wordmark"),entry=document.querySelector(".bp-entry"),btn=document.querySelector(".bp-create"),i=document.querySelector(".bp-entry input");return {background:s(document.body).backgroundImage,foreground:s(document.body).color,heading:s(head).fontSize,font:s(head).fontFamily,headingWeight:s(head).fontWeight,accent:s(head.querySelector("span")).color,width:entry.getBoundingClientRect().width,button:{background:s(btn).backgroundColor,radius:s(btn).borderRadius,height:btn.getBoundingClientRect().height},input:{background:s(i).backgroundColor,border:s(i).borderColor,radius:s(i).borderRadius,height:i.getBoundingClientRect().height},overflow:document.documentElement.scrollWidth>innerWidth}})()');
try{
 for(const [width,height] of [[1100,700],[390,844],[320,568]]){
  await c.call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
  await c.call('Page.navigate',{url:base+'/home'});
  await waitFor(c,'typeof document.querySelector("#create")?.onclick==="function"');
  const home=await styles();assert(!home.overflow);
  await c.evalJS('document.querySelector("#create").click()');
  await waitFor(c,'!!document.querySelector(".bp-name-input")');
  const join=await styles();assert.deepEqual(join,home);assert(join.background.includes('radial-gradient'));
  await c.evalJS('document.querySelector(".bp-back").click()');
  await waitFor(c,'location.pathname==="/home"&&typeof document.querySelector("#create")?.onclick==="function"');
  assert.deepEqual(await styles(),home);
  console.log('PASS identical entry styles and back navigation',width,height);
 }
 assert.equal(c.events.filter(e=>e.type==='exception').length,0);
}finally{c.close()}
