import {randomInt} from 'node:crypto';
// Draw a uniformly shuffled sequence of current catalog positions, excluding
// previous random assignments. Only request pages actually needed.
export async function featuredDailyIds(browse,currentDay){
 const ids=new Set();let offset=0,visited=new Set();
 while(offset!==null){
  if(visited.has(offset)||visited.size>=500)throw Error('Invalid daily catalog pagination');
  visited.add(offset);
  const page=await browse({sort:'new',offset,daily:true,fresh:true});
  if(!Array.isArray(page.holes)||!('nextOffset' in page))throw Error('Daily catalog unavailable');
  for(const h of page.holes)if(typeof h.id==='string'&&(!Number.isFinite(h.scheduledDay)||h.scheduledDay<=currentDay))ids.add(h.id);
  if(page.nextOffset!==null&&(!Number.isInteger(page.nextOffset)||page.nextOffset<=offset))throw Error('Invalid daily catalog pagination');
  offset=page.nextOffset;
 }
 return ids;
}
export async function chooseRandom({browse,count,seen=[],pick=randomInt,excludeDaily=false,currentDay=Infinity}){
 const excluded=excludeDaily?await featuredDailyIds(browse,currentDay):new Set();
 const getPage=offset=>browse({sort:'new',offset,fresh:excludeDaily});
 const first=await getPage(0);
 const total=first.total;
 if(!Number.isInteger(total)||total<count||total>10000)throw Error('Not enough public courses');
 const history=new Set(seen),pages=new Map([[0,first]]),ids=[],available=Array.from({length:total},(_,i)=>i),deferred=[];
 while(ids.length<count&&available.length){
  const i=available.splice(pick(available.length),1)[0],offset=Math.floor(i/24)*24;
  if(!pages.has(offset))pages.set(offset,await getPage(offset));
  const hole=pages.get(offset).holes[i-offset],id=hole?.id;
  if(excludeDaily&&(excluded.has(id)||(Number.isFinite(hole?.scheduledDay)&&hole.scheduledDay<=currentDay)))continue;
  if(!id||ids.includes(id)||deferred.includes(id))continue;
  if(history.has(id))deferred.push(id);
  else{ids.push(id);history.add(id)}
 }
 if(ids.length<count){
  // The old pool is exhausted. Begin a new cycle, but do not repeat within this match.
  history.clear();
  for(const id of deferred){if(ids.length>=count)break;ids.push(id);history.add(id)}
 }
 if(ids.length!==count)throw Error(excludeDaily?'Not enough non-daily public holes available; change the filter or hole count':'Public catalog changed while selecting holes; retry');
 return {ids,seen:[...history]};
}
