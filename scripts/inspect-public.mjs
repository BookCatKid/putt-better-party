import {n as serverRef} from '../private-client/assets/createServerFn-BfnFvdmx.js';
globalThis.window={__TSS_START_OPTIONS__:{serializationAdapters:[]}};
const ID='f97883d5e5a6b99b27465e8906c5bb388ff1314417b2b803d49645320e231be7',DETAIL='fd5b893e239211c8e662cb5e9d4f489b73a752eaf01715a1a8c41808babe622d';
const allowed=new Map([[ID,'GET'],[DETAIL,'POST']]);
async function publicFetch(relative,opts){
 const u=new URL(relative,'https://putt.day'),id=u.pathname.split('/').at(-1);
 if(u.origin!=='https://putt.day'||u.pathname!=='/_serverFn/'+id||allowed.get(id)!==opts.method)throw Error('Unexpected original client request');
 const headers=new Headers(opts.headers);headers.delete('cookie');headers.delete('authorization');headers.set('referer','https://putt.day/holes');
 const r=await fetch(u,{...opts,headers,redirect:'error',signal:AbortSignal.timeout(15000)});
 console.log('HTTP',opts.method,id.slice(0,8),r.status,r.headers.get('content-type'));
 if(!r.ok)throw Error('Public catalog HTTP '+r.status);
 return r;
}
const result=async(id,method,data)=>{
 const r=await serverRef(id)({data,method,fetch:publicFetch});
 if(r.error)throw Error(String(r.error));return r.result;
};
const page=await result(ID,'GET',{sort:'new',limit:24,offset:0});
console.log('Page',Object.keys(page),'total',page.total,'nextOffset',page.nextOffset);
console.log('First',page.holes[0]);
const row=page.holes[0];
const detail=await result(DETAIL,'POST',{id:row.id});
if(!detail?.spec)throw Error('No public spec returned');
console.log('Detail',Object.keys(detail),'spec',detail.spec.name,detail.spec.par,detail.spec.runtimeVersion);
await Bun.write('maps/public-'+row.id+'.json',JSON.stringify({...row,...detail},null,2));
