import {connect,waitFor} from './cdp.mjs';
import assert from 'node:assert/strict';
const base=process.env.BASE||'http://127.0.0.1:8790',headers={origin:base,'content-type':'application/json'};
const post=async(path,data)=>{const r=await fetch(base+path,{method:'POST',headers,body:JSON.stringify(data)}),j=await r.json();assert(r.ok,JSON.stringify(j));return j};
const room=await post('/api/create',{}),host=await post('/api/join',{code:room.code,name:'Host'});
const ws=new WebSocket(base.replace('http','ws')+'/ws/party/'+room.code,{headers:{origin:base}});
const frames=[];ws.onmessage=e=>frames.push(JSON.parse(e.data));
await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject});
ws.send(JSON.stringify({t:'join',...host,host:room.hostToken,protocol:2,instance:'guest-loading-test'}));
const c=await connect((await fetch('http://127.0.0.1:9239/json/list').then(r=>r.json())).find(t=>t.type==='page'));
try{
 await c.call('Page.navigate',{url:base+'/party/'+room.code});
 await waitFor(c,'document.querySelector("input")?.placeholder==="Your name"');
 await c.evalJS('(()=>{let x=document.querySelector("input");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(x,"Guest");x.dispatchEvent(new Event("input",{bubbles:true}));})()');
 await waitFor(c,'[...document.querySelectorAll("button")].some(b=>b.textContent==="Join"&&!b.disabled)');
 await c.evalJS('[...document.querySelectorAll("button")].find(b=>b.textContent==="Join").click()');
 await waitFor(c,'document.body.innerText.includes("Waiting for the host to start")');
 await c.evalJS('window.bpSawLoading=false;window.bpLoadingText="";new MutationObserver(()=>{let x=document.querySelector(".bp-guest-starting");if(x){window.bpSawLoading=true;window.bpLoadingText=x.innerText}}).observe(document.body,{childList:true,subtree:true,characterData:true})');
 ws.send(JSON.stringify({t:'start'}));
 await waitFor(c,'window.bpSawLoading===true',25000);
 const message=await c.evalJS('window.bpLoadingText');
 assert(message.includes('The host has started the party'));assert(message.includes('Loading courses'));
 console.log('PASS guest sees authoritative loading indication:',message);
 await waitFor(c,'(async()=>{let s=(await import("/assets/runtime-DL2fiDAQ.js")).E.state;return ["countdown","playing"].includes(s.phase)&&!document.querySelector(".bp-guest-starting")})()',40000);
 assert(frames.some(m=>m.t==='party'&&m.phase==='lobby'&&m.preparing));
 console.log('PASS loading indication disappears when game starts');
 assert.equal(c.events.filter(e=>e.type==='exception').length,0);
}finally{ws.close();c.close()}
