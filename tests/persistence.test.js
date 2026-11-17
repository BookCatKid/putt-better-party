import {test,expect} from 'bun:test';
import {RoomStore} from '../src/room-store.js';
import {Room} from '../src/room.js';
import {chooseRandom} from '../src/random-selection.js';
const mock=()=>({data:{},frames:[],send(s){this.frames.push(JSON.parse(s))},close(){this.closed=true}});
function join(r,j,host=false){const ws=mock();r.handle(ws,{t:'join',protocol:2,...j,host:host?r.hostToken:undefined});return ws}
test('room recovery retains credentials, playlist metadata, lock and random history, never map specs',()=>{
 const store=new RoomStore(':memory:'),catalog=new Map([['public1',{title:'Test',spec:{id:'private-engine-data',pieces:[1],par:3}}]]);
 const r=new Room('ABCDE',catalog,{onChange:r=>store.save(r)});
 const host=r.issue('Host'),guest=r.issue('Guest'),h=join(r,host,true);join(r,guest);
 r.handle(h,{t:'config',config:{mapSource:'picked',selectedHoleIds:['public1'],locked:true}});
 r.randomSeen=['previous'];r.handle(h,{t:'start'});
 const raw=store.db.query('SELECT payload FROM rooms WHERE code=?').get('ABCDE').payload;
 expect(raw).not.toContain('private-engine-data');expect(raw).not.toContain('pieces');
 r.dispose();
 const restoredCatalog=new Map(),newRoom=store.load(restoredCatalog).get('ABCDE');
 expect(newRoom.phase).toBe('lobby');expect(newRoom.recoveryNotice).toBe(true);
 expect(newRoom.hostToken).toBe(r.hostToken);expect(newRoom.hostUid).toBe(host.uid);
 expect(newRoom.config.selectedHoleIds).toEqual(['public1']);expect(newRoom.config.locked).toBe(true);expect(newRoom.randomSeen).toEqual(['previous']);
 expect(restoredCatalog.get('public1')).toEqual({id:'public1',title:'Test'});
 expect(()=>newRoom.issue('Unknown')).toThrow();expect(newRoom.issue('Host',host.uid,host.session)).toEqual(host);
 const ws=join(newRoom,host,true);expect(ws.frames.some(f=>f.t==='hello'&&f.isHost)).toBe(true);
 expect(JSON.stringify(ws.frames)).not.toContain(guest.session);
 newRoom.dispose();store.close()
});
test('locked rooms admit returning identities but reject new ones; expiry removes saved rooms',()=>{
 const store=new RoomStore(':memory:'),r=new Room('ABCDE',new Map(),{onChange:r=>store.save(r)});
 const host=r.issue('Host'),g=r.issue('Guest'),h=join(r,host,true),guest=join(r,g);
 r.handle(h,{t:'config',config:{locked:true,maxPlayers:2}});
 expect(()=>r.issue('Other')).toThrow();r.close(guest);expect(r.issue('Guest',g.uid,g.session)).toEqual(g);
 expect(join(r,g).frames.some(f=>f.t==='hello')).toBe(true);
 r.lastActivity=Date.now()-1800001;store.save(r);expect(store.load(new Map()).size).toBe(0);r.dispose();store.close()
});
test('random assignments avoid history until pool exhaustion, then wrap without repeating within a match',async()=>{
 const holes=Array.from({length:26},(_,i)=>({id:'hole'+i}));
 const calls=[];const browse=async({offset})=>{calls.push(offset);return {total:holes.length,holes:holes.slice(offset,offset+24)}};
 const a=await chooseRandom({browse,count:9,seen:[],pick:()=>0});
 const b=await chooseRandom({browse,count:9,seen:a.seen,pick:()=>0});
 expect(a.ids.every(id=>!b.ids.includes(id))).toBe(true);expect(b.seen.length).toBe(18);
 const c=await chooseRandom({browse,count:9,seen:b.seen,pick:()=>0});
 expect(c.ids.slice(0,8).every(id=>!b.seen.includes(id))).toBe(true);expect(new Set(c.ids).size).toBe(9);expect(c.seen.length).toBe(1);expect(calls).toContain(24)
});

test('daily exclusion refreshes every match, covers every daily page, and allows future scheduled holes',async()=>{
 const holes=Array.from({length:28},(_,i)=>({id:'hole'+i}));
 holes[0].scheduledDay=8;holes[1].scheduledDay=12;
 let featured=[{id:'hole0',scheduledDay:8},{id:'hole1',scheduledDay:12},...Array.from({length:23},(_,i)=>({id:'other'+i,scheduledDay:7})),{id:'hole2',scheduledDay:9}];
 const requests=[];const browse=async p=>{requests.push(p);let list=p.daily?featured:holes;return {total:list.length,holes:list.slice(p.offset,p.offset+24),nextOffset:p.offset+24<list.length?p.offset+24:null}};
 const a=await chooseRandom({browse,count:3,excludeDaily:true,currentDay:10,pick:()=>0});
 expect(a.ids).toEqual(['hole1','hole3','hole4']);expect(requests.some(p=>p.daily&&p.offset===24&&p.fresh)).toBe(true);
 featured=[...featured,{id:'hole3',scheduledDay:11}];
 const b=await chooseRandom({browse,count:3,excludeDaily:true,currentDay:12,pick:()=>0});
 expect(b.ids).toEqual(['hole4','hole5','hole6']);
 expect(requests.filter(p=>p.daily&&p.offset===0).length).toBe(2);
 const c=await chooseRandom({browse,count:3,excludeDaily:false,currentDay:12,pick:()=>0});
 expect(c.ids).toEqual(['hole0','hole1','hole2']);
});
