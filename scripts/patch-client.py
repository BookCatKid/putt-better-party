# Executed by prepare-client.py after copying immutable bundles.
def replace_once(s,a,b):
 assert s.count(a)==1, (a[:100],s.count(a))
 return s.replace(a,b,1)
def patch(name,fn):
 p=web/'assets'/name;s=p.read_text();p.write_text(fn(s))
def index_patch(s):
 # Retain router/React/shared exports, replace only the site's hydration entry.
 a='(0,O.startTransition)(()=>{(0,Hs.hydrateRoot)(document,(0,k.jsx)(O.StrictMode,{children:(0,k.jsx)(Vs,{})}))});'
 b='''const bpRoot=Xn({component:()=> (0,k.jsx)(or,{})}),bpHome=Jn({getParentRoute:()=>bpRoot,path:`/`,component:()=> (location.replace('/home'),null)}),bpParty=Jn({getParentRoute:()=>bpRoot,path:`/party/$code`,component:M(()=>import('./party._code-D3a-IB4-.js'),'component')});const bpRouter=dr({routeTree:bpRoot.addChildren([bpHome,bpParty]),defaultPreload:false});window.__TSS_START_OPTIONS__={serializationAdapters:[]};(0,Hs.createRoot)(document.getElementById('app')).render((0,k.jsx)(mr,{router:bpRouter}));'''
 return replace_once(s,a,b)
patch('index-DFMxt6BL.js',index_patch)
def route_patch(s):
 s=replace_once(s,'let{code:e}=s.useParams()','let e=decodeURIComponent(location.pathname.split("/").at(-1))')
 s=replace_once(s,'let t=await c({data:{id:e}})','let t=await fetch("/api/map/"+encodeURIComponent(e)).then(r=>r.json())')
 # Derive the title from the original party state, including actual course metadata.
 s=replace_once(s,'a=l(u,e=>e.matchId),o=l(u,e=>e.error)','a=l(u,e=>e.matchId),bpPhase=l(u,e=>e.phase),o=l(u,e=>e.error)')
 s=replace_once(s,'[O,k]=(0,y.useState)(C);return','[O,k]=(0,y.useState)(C);(0,y.useEffect)(()=>{document.title=!t?"Join "+e+" · Better Party":bpPhase==="lobby"?"Party "+e+" · Better Party":bpPhase==="final"?"Results · Better Party":i?.name?i.name+" · Hole "+(r+1)+"/"+n.length+" · Better Party":"Party "+e+" · Better Party"},[e,t,bpPhase,i,r,n.length]);return')
 # Independent identity and name entry, same runtime join; no official verification/auth.
 start=s.index('function D({code:e})')
 end=s.index('export{E as component}',start)
 return s[:start]+'''function D({code:e}){let[t,n]=y.useState(sessionStorage.getItem("bp.name."+e)??""),[r,i]=y.useState(""),[a,o]=y.useState(false),[resume,setResume]=y.useState(()=>!!(sessionStorage.getItem("bp.uid."+e)&&sessionStorage.getItem("bp.session."+e)&&sessionStorage.getItem("bp.name."+e))),joining=y.useRef(false);async function join(){if(!t.trim()||joining.current)return;joining.current=true;o(true);i("");try{let old=sessionStorage.getItem("bp.uid."+e),host=sessionStorage.getItem("bp.host."+e);let res=await fetch("/api/join",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({code:e,name:t.trim(),uid:old,session:sessionStorage.getItem("bp.session."+e),host})});let j=await res.json();if(!res.ok){if(j.error?.includes("Session expired")){sessionStorage.removeItem("bp.uid."+e);sessionStorage.removeItem("bp.session."+e)}throw Error(j.error)}sessionStorage.setItem("bp.lastRoom",e);sessionStorage.setItem("bp.name."+e,j.name);sessionStorage.setItem("bp.uid."+e,j.uid);sessionStorage.setItem("bp.session."+e,j.session);f(e,{uid:j.uid,name:j.name,hue:j.hue,session:j.session,instance:crypto.randomUUID()},host??undefined)}catch(err){i(err.message);setResume(false)}finally{joining.current=false;o(false)}}y.useEffect(()=>{if(resume)join()},[e]);return x.jsx("main",{className:"bp-home",children:x.jsxs("section",{className:"bp-entry",children:[x.jsxs("h1",{className:"bp-wordmark",children:["better",x.jsx("span",{children:".party"})]}),x.jsxs("p",{className:"bp-join-code",children:["Party ",x.jsx("strong",{children:e})]}),resume?x.jsxs("p",{role:"status",className:"bp-resume-status",children:[x.jsx("span",{className:"bp-loading-spinner","aria-hidden":true}),"Rejoining party…"]}):x.jsxs("form",{className:"bp-join-form",onSubmit:e=>{e.preventDefault();join()},children:[x.jsx("input",{autoFocus:true,placeholder:"Your name","aria-label":"Your name",maxLength:24,value:t,onChange:e=>n(e.target.value),className:"bp-name-input",autoComplete:"nickname"}),x.jsx("button",{type:"submit",disabled:a||!t.trim(),className:"bp-create",children:a?"Joining…":"Join"})]}),r&&x.jsx("p",{className:"bp-entry-error",role:"alert",children:r}),x.jsx("a",{href:"/home",className:"bp-resume bp-back",children:"Back to home"})]})})}'''+s[end:]
patch('party._code-D3a-IB4-.js',route_patch)
def transport_patch(s):
 s=replace_once(s,'host:n.hostToken,protocol:2','host:n.hostToken,session:t.session,instance:t.instance,protocol:2')
 s=replace_once(s,'P({phase:t.phase,holeIndex:t.holeIndex','P({recoveryNotice:t.recoveryNotice,randomHistoryCount:t.randomHistoryCount,preparing:t.preparing,playlistTitles:t.playlistTitles,roundHistory:t.roundHistory,initialPlayers:t.initialPlayers,phase:t.phase,holeIndex:t.holeIndex')
 # Resend current stroke/finish state after reconnect once the same hole's authoritative state arrives.
 a=s.index('function Zn(');b=s.index('function Qn(',a);part=s[a:b]
 part=replace_once(part,'r.onopen=()=>{a=1e3,s=0,','r.onopen=()=>{a=1e3,s=0,')
 part=replace_once(part,'case`hello`:c=t.id,re(t.isHost,t.count,t.role);return;','case`hello`:c=t.id,bpConnection(true),re(t.isHost,t.count,t.role);return;case`host-ack`:bpAck(t);return;case`pong`:return;')
 part=replace_once(part,'r.onclose=()=>{if(r=null,!i)','r.onclose=()=>{bpConnection(false);if(r=null,!i)')
 part=replace_once(part,'p();let m=e=>{r&&r.readyState===WebSocket.OPEN&&r.send(JSON.stringify(e))};','p();let m=e=>{if(!r||r.readyState!==WebSocket.OPEN)return false;if(e.t===`prog`||e.t===`forfeit`||e.f===1)e={...e,matchId:M.state.matchId,holeIndex:M.state.holeIndex};r.send(JSON.stringify(e));return true};const bpHeartbeat=setInterval(()=>m({t:`ping`}),15000);')
 part=replace_once(part,'i=!0,ie(null),clearInterval(v)','i=!0,bpConnection(false),ie(null),clearInterval(bpHeartbeat),clearInterval(v)')
 # Keep the existing match-aware subscribe logic; ensure completion/progress are resent only
 # when the connection returns to the same current map and hole.
 part=replace_once(part,'case`party`:(t.holeIndex!==f','case`party`:let bpSame=M.state.matchId===t.matchId&&M.state.holeIndex===t.holeIndex&&M.state.mapReady;(t.matchId!==M.state.matchId||t.holeIndex!==f')
 part=replace_once(part,'&&ne(!1);return;case`roster`','&&ne(!1);if(bpSame&&t.phase===`playing`&&M.state.selfRole!==`spectator`&&r?.readyState===WebSocket.OPEN){let g=B.state;if(g.phase===`holed`&&g.result)r.send(JSON.stringify({f:1,s:g.result.strokes,p:g.result.par,matchId:t.matchId,holeIndex:t.holeIndex}));else if(g.phase===`forfeit`)r.send(JSON.stringify({t:`forfeit`,matchId:t.matchId,holeIndex:t.holeIndex}));else r.send(JSON.stringify({t:`prog`,st:g.strokes,matchId:t.matchId,holeIndex:t.holeIndex}))}return;case`roster`')
 return 'import{bpConnection,bpAck}from"./runtime-DL2fiDAQ.js";'+s[:a]+part+s[b:]
patch('GameCanvas-C5hQh1sR.js',transport_patch)
def runtime_patch(s):
 s=replace_once(s,'phase:e.phase,holeIndex:e.holeIndex','recoveryNotice:!!e.recoveryNotice,randomHistoryCount:e.randomHistoryCount??0,preparing:!!e.preparing,playlistTitles:e.playlistTitles??{},roundHistory:e.roundHistory??[],initialPlayers:e.initialPlayers??0,phase:e.phase,holeIndex:e.holeIndex')
 s=replace_once(s,'e.active?c()||e.phase!==`playing`||!e.mapReady','e.active?!e.bpConnected||c()||e.phase!==`playing`||!e.mapReady')
 s=replace_once(s,'t.state.active&&(e.phase===`holed`','(t.state.active||(i.state.active&&i.state.phase===`playing`&&i.state.selfRole===`player`))&&(e.phase===`holed`')
 return s+"""
const bpPending=new Map();
export function bpPickerBusy(value){i.setState(s=>({...s,bpPickerBusy:!!value}))}
export function bpConnection(connected){
 i.setState(s=>({...s,bpConnected:connected}));
 if(!connected)for(const [id,p] of bpPending){clearTimeout(p.timer);p.reject(Error('Party connection lost. Reconnect or create a new party.'));bpPending.delete(id)}
}
export function bpAck(m){const p=bpPending.get(m.requestId);if(!p)return;clearTimeout(p.timer);bpPending.delete(m.requestId);m.ok?p.resolve():p.reject(Error(m.msg||'Host command rejected'))}
export function bpHostAction(action,seconds){const s=i.state;
 if(!s.isHost||!s.bpConnected||!u)return Promise.reject(Error('Party is disconnected. Reconnect or create a new party.'));
 const requestId=crypto.randomUUID();
 return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{bpPending.delete(requestId);reject(Error('No response from party server. Check the connection.'))},4000);bpPending.set(requestId,{resolve,reject,timer});if(u({t:'host-action',action,seconds,matchId:s.matchId,holeIndex:s.holeIndex,requestId})!==true){clearTimeout(timer);bpPending.delete(requestId);reject(Error('Party connection lost.'))}});
}
"""

patch('runtime-DL2fiDAQ.js',runtime_patch)

def game_patch(s):
 s='import{bpHostAction,bpPickerBusy}from"./runtime-DL2fiDAQ.js";'+s
 a=s.index('function At(');b=s.index('function jt(',a);s=s[:a]+(root/'scripts/picker.js').read_text()+s[b:]
 a=s.index('function Mt(');b=s.index('function Nt(',a);s=s[:a]+replace_once(s[a:b],'mx-6 max-h-[88dvh] w-full max-w-sm overflow-y-auto rounded-3xl bg-[#11272b] p-7','mx-6 max-h-[88dvh] w-full max-w-6xl overflow-y-auto rounded-3xl bg-[#11272b] p-7 bp-lobby')+s[b:]
 a=s.index('function Mt(');b=s.index('function Nt(',a);part=s[a:b]
 first=part.index('s.mapSource===`random`&&(0,J.jsxs)(`label`')
 last=part.index('(0,J.jsxs)(`label`,{className:`flex items-center justify-between gap-3 text-xs font-medium text-white/85`,children:[(0,J.jsx)(`span`,{children:`Elimination`})',first)
 part=part[:first]+'(0,J.jsx)(BpNumericSettings,{}),'+part[last:]
 s=s[:a]+part+s[b:]
 s=replace_once(s,'children:d?`Tallying the winners…`:`Next hole starting…`','children:R.state.preparing?`Loading next community hole…`:d?`Tallying the winners…`:`Next hole starting…`')
 s=replace_once(s,'a.holes-1||c<=1','a.holes-1||(a.elimination&&(c===0||(R.state.initialPlayers>1&&c===1)))')
 s=replace_once(s,'s=j(R,e=>e.config),[c,l]','s=j(R,e=>e.config),bpPreparing=j(R,e=>e.preparing||e.bpPickerBusy),[c,l]')
 s=replace_once(s,'disabled:s.mapSource===`picked`&&!s.selectedHoleIds?.length','disabled:bpPreparing||(s.mapSource===`picked`&&!s.selectedHoleIds?.length)')
 s=replace_once(s,'a&&(0,J.jsxs)(`div`,{className:`mb-5 flex flex-col gap-3 rounded-xl bg-white/5 p-3 text-left`','!a&&(0,J.jsx)(BpGuestPlaylist,{}),a&&(0,J.jsxs)(`div`,{className:`mb-5 flex flex-col gap-3 rounded-xl bg-white/5 p-3 text-left`')
 s=replace_once(s,'(0,J.jsx)(At,{config:s}),','(0,J.jsx)(At,{config:s}),(0,J.jsx)(BpLobbyOptions,{}),')
 s=replace_once(s,'children:`Party lobby`}),n&&','children:`Party lobby`}),(0,J.jsx)(BpRecoveryNotice,{}),n&&')
 s=replace_once(s,'children:`Start party`','children:bpPreparing?`Loading courses…`:`Start party`')
 s=replace_once(s,'!a&&(0,J.jsx)(BpGuestPlaylist,{}),','!a&&(0,J.jsxs)(J.Fragment,{children:[(0,J.jsx)(BpGuestPlaylist,{}),(0,J.jsx)(BpGuestStarting,{})]}),')
 s=replace_once(s,'(0,J.jsx)(`p`,{className:`text-xs text-white/50`,children:`Waiting for the host to start…`})','!bpPreparing&&(0,J.jsx)(`p`,{className:`text-xs text-white/50`,children:`Waiting for the host to start…`})')

 s=replace_once(s,'b?ne===`playing`&&i!==`holed`&&i!==`forfeit`&&(0,J.jsx)(Ut,{}):w?null:','b?ne===`playing`&&i!==`holed`&&i!==`forfeit`&&(0,J.jsx)(Ut,{}):w?T===`playing`&&!D&&i!==`holed`&&i!==`forfeit`&&(0,J.jsx)(Ut,{}):')
 s=replace_once(s,'(0,J.jsx)(It,{}),(0,J.jsx)(Lt,{} as never)' if False else '(0,J.jsx)(It,{}),(0,J.jsx)(Lt,{})','(0,J.jsx)(It,{}),(0,J.jsx)(BpConnectionNotice,{}),(0,J.jsx)(Lt,{})')
 s=replace_once(s,'children:[`alive `,a.alive,` · holed `,a.holed]}),','children:[`alive `,a.alive,` · holed `,a.holed]}),(0,J.jsx)(BpUpcoming,{}),')
 s=replace_once(s,'pointer-events-none absolute right-3 top-3 z-10 w-56 rounded-2xl bg-black/60 p-3','pointer-events-none absolute right-3 z-10 w-56 rounded-2xl bg-black/60 p-3 bp-party-status')
 s=replace_once(s,'(0,J.jsx)(a,{to:`/`,"aria-label":`Back to home`,className:`pointer-events-auto shrink-0 rounded-xl bg-black/50 p-2 text-white transition hover:bg-black/70`','(0,J.jsx)(`a`,{href:`/home`,"aria-label":`Back to home`,className:`pointer-events-auto shrink-0 rounded-xl bg-black/50 p-2 text-white transition hover:bg-black/70 bp-toolbar-home`')
 s=replace_once(s,'className:`flex shrink-0 items-start gap-2`,children:[s&&','className:`flex shrink-0 items-start gap-2 bp-toolbar`,children:[s&&')
 s=replace_once(s,'children:`⚙️`}),A&&','children:`⚙️`}),A&&')
 # Host menu is a sibling of the settings wrapper, not inside it.
 a=s.index('function It(')
 s=s[:a]+(root/'scripts/match-details.js').read_text()+s[a:]
 s=s[:a]+(root/'scripts/host-menu.js').read_text()+s[a:]
 s=replace_once(s,'})]})]})]})]}),(0,J.jsxs)(`div`,{"data-overview-hud":`bottom`','})]})]}),(0,J.jsx)(BpHostMenu,{settingsOpen:A,closeSettings:()=>ie(false)})]})]}),(0,J.jsxs)(`div`,{"data-overview-hud":`bottom`')
 a=s.index('function Ht(');b=s.index('function ',a+10)
 part=s[a:b];part=replace_once(part,'(0,J.jsx)(`ul`,{className:`mb-5 flex flex-col','(0,J.jsx)(BpScorecard,{}),(0,J.jsx)(`ul`,{className:`mb-5 flex flex-col')
 s=s[:a]+part+s[b:]
 return s
patch('GameRoot-7kMtVtdO.js',game_patch)
# Strip the captured CSS import of Google fonts for isolated local mode.
p=web/'assets/styles-S28F_fms.css';s=p.read_text();p.write_text(re.sub(r'^@import "[^"]+";', '',s,count=1)+'\n'+(root/'scripts/better-party.css').read_text())
# Server-side original validator import closure: only index browser dependency stubbed.
validation=root/'private-client'/'validation'
validation.mkdir(exist_ok=True)
for source in (private/'assets').glob('*.js'):
 shutil.copyfile(source,validation/source.name)
(validation/'index-DFMxt6BL.js').write_text('export const Xt={state:{active:false}}; export const A=new Map();')
print('Patched isolated browser bootstrap, local join, local catalog, original validation; Only party transport changed in GameCanvas; physics unchanged.')
