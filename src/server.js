import {Room} from './room.js';
import {RoomStore} from './room-store.js';
import {maps,fetchPublicMap,prepareMatch} from './catalog.js';
import {browse,preview,rememberPublicMetadata} from './upstream.js';
import {randomInt} from 'node:crypto';
import path from 'node:path';
import {existsSync} from 'node:fs';

const port=Number(process.env.PORT||8789),root=path.resolve(import.meta.dir,'../web');
const store=new RoomStore(process.env.BP_DB||path.resolve(import.meta.dir,'../state/rooms.sqlite'));
const loadMap=id=>fetchPublicMap(id,{saved:true});
const rooms=store.load(maps,{prepareMatch,loadMap});
for(const [id,m] of maps)rememberPublicMetadata(id,m.title);
const response=(data,status=200)=>Response.json(data,{status});
const csp="default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws://127.0.0.1:"+port+"; worker-src 'self' blob:; font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";
const page=(s)=>new Response(s,{headers:{'content-type':'text/html; charset=utf-8','content-security-policy':csp,'referrer-policy':'no-referrer','cache-control':'no-store'}});
const jsonBody=async r=>{if(Number(r.headers.get('content-length'))>1000000)throw Error('Request too large');return await r.json()};
const html='<!doctype html><html lang="en" class="dark"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Party · Better Party</title><link rel="icon" href="/favicon.ico" type="image/x-icon"><link rel="stylesheet" href="/assets/styles-S28F_fms.css"><body class="bp-page"><div id="app"></div><script type="module" src="/assets/index-DFMxt6BL.js"></script></body></html>';
const origin='http://127.0.0.1:'+port;
const server=Bun.serve({hostname:'127.0.0.1',port,maxRequestBodySize:1024*1024,
 async fetch(req,s){
 const u=new URL(req.url),p=u.pathname;
 if(req.headers.get('host')!=='127.0.0.1:'+port)return new Response('Invalid host',{status:403});
 if(p.startsWith('/ws/party/')){const room=rooms.get(p.split('/').at(-1));if(!room||req.headers.get('origin')!==origin)return new Response('Room not found or invalid origin',{status:403});return s.upgrade(req,{data:{room,uid:null}})?undefined:new Response('Bad upgrade',{status:400})}
 if(p==='/favicon.ico')return new Response(Bun.file(path.join(root,'favicon.ico')),{headers:{'content-type':'image/x-icon','cache-control':'public, max-age=3600','x-content-type-options':'nosniff'}});
 if(p==='/health')return response({ok:true,rooms:rooms.size,maps:maps.size});
 if(req.method==='POST'&&req.headers.get('origin')!==origin)return response({error:'Invalid origin'},403);
 try{
 if(p==='/api/create'&&req.method==='POST'){
  if(rooms.size>=100)return response({error:'Room limit reached'},429);
  let code;do{code=Array.from({length:5},()=> 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[randomInt(32)]).join('')}while(rooms.has(code));
  const room=new Room(code,maps,{prepareMatch,loadMap,onChange:r=>store.save(r)});rooms.set(code,room);store.save(room);return response({code,hostToken:room.hostToken});
 }
 if(p.startsWith('/api/room/')&&req.method==='GET'){const room=rooms.get(p.slice(10));return room?response({code:room.code,phase:room.phase,locked:room.config.locked,players:room.roster().length}):response({error:'Room does not exist'},404)}
 if(p==='/api/join'&&req.method==='POST'){const j=await jsonBody(req),r=rooms.get(j.code);if(!r)return response({error:'Room does not exist'},404);return response(r.issue(j.name,j.uid,j.session))}
 if((p==='/api/import'||p==='/api/import-playlist')&&req.method==='POST'){
  const j=await jsonBody(req),r=rooms.get(j.code),player=r?.players.get(j.uid);
  const allowed=()=>r&&r.phase==='lobby'&&!r.starting&&r.hostUid===j.uid&&player?.ws&&j.host===r.hostToken&&j.session===r.issued.get(j.uid)?.session;
  if(!allowed())return response({error:'Only a connected lobby host may import maps'},403);
  if(p==='/api/import'){
   await fetchPublicMap(j.id,{saved:j.saved===true});
   const {spec,...meta}=maps.get(j.id);return response(meta)
  }
  if(!Array.isArray(j.ids)||j.ids.length<1||j.ids.some(id=>typeof id!=='string'||!/^[a-zA-Z0-9_-]{5,64}$/.test(id)))return response({error:'Invalid saved playlist'},400);
  const items=[];
  for(const id of new Set(j.ids))items.push(await fetchPublicMap(id,{saved:true}));
  if(!allowed())return response({error:'The lobby changed while loading the playlist'},409);
  r.configure(player.ws,{mapSource:'picked',selectedHoleIds:j.ids,holes:j.ids.length});
  return response({holes:items.map(({spec,...meta})=>meta)})
 }
 if(p==='/api/catalog'){
  let page=await browse(Object.fromEntries(u.searchParams));
  return response(page)
 }

 if(p.startsWith('/api/preview/')&&req.method==='GET')return await preview(decodeURIComponent(p.slice(13)));
 if(p.startsWith('/api/map/')){const m=maps.get(decodeURIComponent(p.slice(9)));return m?.spec?response(m):response({error:'Map missing'},404)}
 if(p==='/home'||p==='/')return page(await Bun.file(new URL('./home.html',import.meta.url)).text());
 if(p==='/party')return page(await Bun.file(new URL('./home.html',import.meta.url)).text());
 if(/^\/party\/[A-Z2-9]{5}$/.test(p))return page(html);
 if(p.startsWith('/_serverFn/')){console.log('Blocked unrelated official server function',p);return response({error:'Official API disabled'},404)}
 if(/^\/(assets|models|sfx|sky)\//.test(p)){const full=path.resolve(root,'.'+decodeURIComponent(p));if(full.startsWith(root+'/')&&existsSync(full))return new Response(Bun.file(full),{headers:{'x-content-type-options':'nosniff','cache-control':'no-store'}});console.log('Missing asset',p);return new Response('Missing asset',{status:404})}
 return new Response('Not found',{status:404})
 }catch(e){return response({error:e.message},400)}
 },websocket:{maxPayloadLength:1024*1024,idleTimeout:120,open(ws){setTimeout(()=>{if(!ws.data.uid)ws.close(1008,'Join required')},10000)},message(ws,raw){try{ws.data.room.handle(ws,JSON.parse(raw.toString()))}catch(e){ws.data.room.error(ws,'bad-message','Invalid message');console.error(e.message)}},close(ws){ws.data.room.close(ws)}}});
setInterval(()=>{for(const r of rooms.values())r.tick()},100);
// Reclaim empty rooms, including never-joined rooms, after 30 minutes.
setInterval(()=>{for(const [code,r] of rooms){if(![...r.players.values()].some(p=>p.ws)&&Date.now()-r.lastActivity>1800000){r.dispose();rooms.delete(code);store.remove(code)}}},60000);
console.log('Better Party local only:',server.url.href);
