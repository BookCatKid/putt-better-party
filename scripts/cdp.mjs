export const pause=ms=>new Promise(r=>setTimeout(r,ms));
export async function connect(target){
 const ws=new WebSocket(target.webSocketDebuggerUrl),pending=new Map(),events=[],requests=new Map();let seq=0;
 await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=rej});
 ws.onmessage=e=>{let m=JSON.parse(e.data);if(m.id){let p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result)}}else{
  if(m.method==='Network.requestWillBeSent')requests.set(m.params.requestId,m.params.request.url);
  if(m.method==='Runtime.exceptionThrown')events.push({type:'exception',text:m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text});
  if(m.method==='Log.entryAdded'&&m.params.entry.level==='error')events.push({type:'error',text:m.params.entry.text,url:m.params.entry.url});
  if(m.method==='Network.loadingFailed')events.push({type:'failed',text:m.params.errorText,url:requests.get(m.params.requestId)});
  if(m.method==='Network.responseReceived'&&m.params.response.status>=400)events.push({type:'http',text:String(m.params.response.status),url:m.params.response.url});
  if(m.method==='Network.webSocketFrameSent'||m.method==='Network.webSocketFrameReceived'){try{let j=JSON.parse(m.params.response.payloadData);if(j.t||j.f)events.push({type:m.method.endsWith('Sent')?'sent':'received',msg:j.t??'completion',phase:j.phase,name:j.currentMap?.name,play:j.holeIds,count:j.count})}catch{}}
 }};
 ws.onclose=()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('Browser disconnected'))}pending.clear()};
 const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;const timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout: '+method))},8000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}))});
 const evalJS=async expression=>{let r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value};
 await call('Page.enable');await call('Runtime.enable');await call('Log.enable');await call('Network.enable');
 return {call,evalJS,events,requests,close:()=>ws.close()};
}
export async function waitFor(c,expression,timeout=30000){
 const until=Date.now()+timeout;let error;
 while(Date.now()<until){try{let r=await c.evalJS(expression);if(r)return r}catch(e){error=e}await pause(200)}
 throw Error('Timed out: '+expression+' '+(error??'')+'\n'+JSON.stringify(c.events.slice(-20)));
}
