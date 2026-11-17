function BpHostMenu({settingsOpen,closeSettings}){
 const active=j(R,s=>s.active),host=j(R,s=>s.isHost),phase=j(R,s=>s.phase),hole=j(R,s=>s.holeIndex);
 const [open,setOpen]=q.useState(false),[confirm,setConfirm]=q.useState(null),[pending,setPending]=q.useState(false),[error,setError]=q.useState('');
 q.useEffect(()=>{setOpen(false);setConfirm(null)},[phase,hole]);
 q.useEffect(()=>{if(settingsOpen){setOpen(false);setConfirm(null)}},[settingsOpen]);
 q.useEffect(()=>{if(!open)return;const key=e=>{if(e.key==='Escape'){setOpen(false);setConfirm(null)}};window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key)},[open]);
 if(!active||!host||!['playing','countdown','hole-results'].includes(phase))return null;
 const h=q.createElement,live=phase==='playing'||phase==='countdown';
 const run=async(action,seconds)=>{if(pending)return;setPending(true);setError('');try{await bpHostAction(action,seconds);setOpen(false);setConfirm(null)}catch(e){setError(e.message)}finally{setPending(false)}};
 const btn=(label,fn,disabled=false,cls='')=>h('button',{type:'button',onClick:fn,disabled:disabled||pending,className:'bp-host-item '+cls},label);
 return h('div',{className:'relative bp-host-control'},[
  h('button',{type:'button','aria-label':'Party controls','aria-expanded':open,title:'Party controls',className:'pointer-events-auto rounded-xl bg-black/50 px-3 py-2 text-lg transition hover:bg-black/70',onClick:()=>{closeSettings();setOpen(v=>!v);setConfirm(null)}},h('svg',{width:20,height:20,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:2,strokeLinecap:'round',strokeLinejoin:'round','aria-hidden':true},[h('path',{d:'M4 21V4m0 1c5-4 8 4 16 0v10c-8 4-11-4-16 0'})])),
  open&&h('div',{className:'bp-host-panel pointer-events-auto absolute right-0 top-12 rounded-2xl bg-[#11272b] p-4 shadow-2xl'},[
   h('h3',{className:'mb-3 text-sm font-bold'},'Party controls'),error&&h('p',{role:'alert',className:'mb-2 text-xs text-red-300'},error),pending&&h('p',{role:'status',className:'text-xs'},'Applying…'),
   confirm?h('div',{className:'bp-host-confirm'},[h('p',{},confirm==='end'?'End the party now?':confirm==='skip'?'Skip this hole for everyone?':'Restart this hole for everyone?'),h('div',{className:'bp-host-time'},[btn('Cancel',()=>setConfirm(null)),btn('Confirm',()=>run(confirm),false,'bp-danger')])]):[
    h('p',{className:'text-xs text-white/70'},'Add time'),
    h('div',{className:'bp-host-time'},[15,30,60].map(s=>btn('+'+s+'s',()=>run('time',s),phase!=='playing'))),
    btn('Skip level',()=>setConfirm('skip'),!live),
    btn('Restart level',()=>setConfirm('restart'),!live),
    btn('End party',()=>setConfirm('end'),false,'bp-danger')
   ]
  ])
 ]);
}

function BpConnectionNotice(){
 const active=j(R,s=>s.active),connected=j(R,s=>s.bpConnected);
 const [show,setShow]=q.useState(false);
 q.useEffect(()=>{if(!active||connected){setShow(false);return}const t=setTimeout(()=>setShow(true),2000);return()=>clearTimeout(t)},[active,connected]);
 return active&&!connected&&show?q.createElement('div',{className:'bp-disconnected',role:'alert'},['Party disconnected. Reconnecting… ',q.createElement('a',{href:'/home'},'Return to party home')]):null;
}
