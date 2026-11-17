function BpGuestPlaylist(){
 const config=j(R,s=>s.config),titles=j(R,s=>s.playlistTitles)??{};
 const h=q.createElement;
 return h('div',{className:'mb-4 rounded-xl bg-white/5 p-3 text-left'},[
  h('p',{className:'mb-2 text-sm font-bold'},config.holes+' holes · '+Math.round(config.timerMs/1000)+'s · '+(config.elimination?'Elimination':'Stroke play')),
  config.mapSource==='picked'?h('ol',{className:'bp-guest-course-list'},(config.selectedHoleIds??[]).map((id,i)=>h('li',{key:i+':'+id},[h('img',{src:'/api/preview/'+encodeURIComponent(id),alt:'',loading:'lazy'}),h('span',{},(i+1)+'. '+(titles[id]??id))]))):h('p',{className:'text-xs text-white/70'},'Random holes')
 ]);
}
function BpScorecard(){
 const history=j(R,s=>s.roundHistory),final=j(R,s=>s.final),[open,setOpen]=q.useState(false);
 if(!history?.length||!final?.standings?.length)return null;
 const h=q.createElement;
 return h('section',{className:'bp-scorecard'},[
  h('button',{type:'button',onClick:()=>setOpen(!open),'aria-expanded':open,className:'rounded-full bg-white/10 px-4 py-2 text-xs font-semibold'},open?'Hide scorecard':'Scorecard'),
  open&&h('div',{className:'bp-scorecard-scroll'},h('table',{},[
   h('thead',{},[h('tr',{},[h('th',{},'Hole'),...history.map(r=>h('th',{key:r.index,title:r.title},r.index+1)),h('th',{},'Total')]),h('tr',{},[h('th',{},'Par'),...history.map(r=>h('td',{key:r.index},r.status==='skipped'?'—':r.par)),h('td',{},'')])]),
   h('tbody',{},final.standings.map(p=>h('tr',{key:p.uid},[h('th',{},p.name),...history.map(r=>{const a=r.rows.find(x=>x.uid===p.uid);return h('td',{key:r.index,title:r.title+' · '+(a?.status??r.status),className:a?.status==='holed'?'bp-holed':''},r.status==='skipped'?'Skip':a?.strokes??(a?.status==='eliminated'?'DNF':'—'))}),h('td',{},p.totalStrokes)])))
  ]))
 ]);
}

function BpLobbyOptions(){
 const config=j(R,s=>s.config),preparing=j(R,s=>s.preparing),connected=j(R,s=>s.bpConnected),count=j(R,s=>s.count),h=q.createElement;
 return h('div',{className:'bp-lobby-options'},[
  h('label',{},[h('span',{},'Maximum players'),h('select',{'aria-label':'Maximum players',disabled:preparing||!connected,value:config.maxPlayers,onChange:e=>L({maxPlayers:Number(e.target.value)})},[...new Set([2,4,6,8,10,12,16,20,30,50,config.maxPlayers])].sort((a,b)=>a-b).map(n=>h('option',{key:n,value:n,disabled:n<count},n)))]),
  h('label',{},[h('span',{},'Lock party'),h('input',{type:'checkbox','aria-label':'Lock party',checked:!!config.locked,disabled:preparing||!connected,onChange:e=>L({locked:e.target.checked})})]),
  config.locked&&h('p',{className:'text-xs text-white/60'},'Existing players can reconnect. New players cannot join.')
 ]);
}
function BpRecoveryNotice(){
 const recovered=j(R,s=>s.recoveryNotice);
 return recovered?q.createElement('p',{className:'mb-3 rounded-xl bg-amber-500/10 p-3 text-xs text-amber-200',role:'status'},'The server restarted. Your party and settings were recovered; start a new match when ready.'):null;
}
function BpUpcoming(){
 const ids=j(R,s=>s.holeIds),index=j(R,s=>s.holeIndex),titles=j(R,s=>s.playlistTitles);
 if(!ids[index+1]||!titles?.[ids[index+1]])return null;
 return q.createElement('p',{className:'bp-upcoming',title:titles[ids[index+1]]},'Next: '+titles[ids[index+1]]);
}

function BpNumericField({label,value,min,max,apply,disabled,unit,sliderStep=1}){
 const h=q.createElement,[draft,setDraft]=q.useState(String(value)),[slider,setSlider]=q.useState(value),cancel=q.useRef(false);
 q.useEffect(()=>{setDraft(String(value));setSlider(value)},[value]);
 function commit(){
  if(cancel.current){cancel.current=false;setDraft(String(value));return}
  const n=Number(draft);
  if(draft.trim()&&Number.isInteger(n)&&n>=min&&n<=max){if(n!==value)apply(n);setDraft(String(n));setSlider(n)}
  else setDraft(String(value));
 }
 function slide(e){const n=Number(e.target.value);setSlider(n);setDraft(String(n));if(n!==value)apply(n)}
 return h('div',{className:'bp-number-row'},[h('span',{},label),h('div',{className:'bp-number-wrap'},[
  h('input',{type:'range','aria-label':label+' slider',min,max,step:sliderStep,value:slider,disabled,onChange:slide,className:'bp-number-slider'}),
  h('div',{className:'bp-number-box'},[
   h('input',{type:'number','aria-label':label,min,max,step:1,value:draft,disabled,onChange:e=>setDraft(e.target.value),onBlur:commit,onKeyDown:e=>{if(e.key==='Enter'){e.preventDefault();e.currentTarget.blur()}if(e.key==='Escape'){cancel.current=true;e.currentTarget.blur()}}}),
   unit&&h('span',{className:'bp-number-unit'},unit)
  ])
 ])]);
}
function BpNumericSettings(){
 const c=j(R,s=>s.config),disabled=j(R,s=>s.preparing||s.bpPickerBusy||!s.bpConnected),h=q.createElement;
 return h(q.Fragment,{},[
  c.mapSource==='random'&&h(BpNumericField,{label:'Holes',value:c.holes,min:1,max:9,apply:holes=>L({holes}),disabled}),
  h(BpNumericField,{label:'Timer',value:Math.round(c.timerMs/1000),min:20,max:300,apply:n=>L({timerMs:n*1000}),disabled,unit:'s'})
 ]);
}


function BpGuestStarting(){
 const preparing=j(R,s=>s.preparing),phase=j(R,s=>s.phase);
 if(!preparing||phase!=='lobby')return null;
 const h=q.createElement;
 return h('div',{className:'bp-guest-starting',role:'status','aria-live':'polite'},[
  h('span',{className:'bp-loading-spinner','aria-hidden':true}),
  h('div',{},[h('p',{className:'bp-starting-title'},'The host has started the party'),h('p',{className:'bp-starting-detail'},'Loading courses…')])
 ]);
}
