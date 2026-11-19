"""Apply hash-pinned changes to copies of the original client bundles."""

import hashlib
import json
import os
import re
import shutil
from pathlib import Path

root = Path(__file__).resolve().parent.parent
private = root / "private-client"

# Preparation builds into a staging directory and publishes it only when every
# patch has applied and every patched bundle still parses, so a failed or partial
# build can never be served. `BP_STAGE_WEB` is that staging directory. It is set
# by prepare-client.py; running this module directly without it is a mistake that
# should be loud rather than quietly rewriting the live client.
_stage = os.environ.get("BP_STAGE_WEB")
if not _stage:
    raise SystemExit("patch-client.py must run through prepare-client.py")
web = Path(_stage)
if not web.is_dir():
    raise SystemExit(f"Staging directory does not exist: {web}")


# Executed by prepare-client.py after copying immutable bundles.
def replace_once(s, a, b):
    count = s.count(a)
    assert count == 1, (a[:100], count)
    return s.replace(a, b, 1)


def patch(name, fn):
    p = web / "assets" / name
    s = p.read_text()
    p.write_text(fn(s))


def index_patch(s):
    # Retain router/React/shared exports, replace only the site's hydration entry.
    a = "(0,O.startTransition)(()=>{(0,Hs.hydrateRoot)(document,(0,k.jsx)(O.StrictMode,{children:(0,k.jsx)(Vs,{})}))});"
    b = (root / "scripts/client-bootstrap.js").read_text()
    return replace_once(s, a, b)


patch("index-DFMxt6BL.js", index_patch)


def route_patch(source):
    source = replace_once(
        source,
        "let t=await c({data:{id:e}})",
        'let t=await fetch("/api/map/"+encodeURIComponent(e)).then(r=>r.json())',
    )
    start = source.index("function E(){")
    end = source.index("export{E as component}", start)
    return (
        source[:start]
        + """
const partyRouteReact = y, partyRouteJsx = x, partyRouteStore = u;
const selectPartyRouteState = l, joinPartyRuntime = f, resetPartyRuntime = p;
const defaultPartyLevel = C, defaultPartySeed = S, loadPartyLevel = T;
const setPartyMapReady = d, sanitizePartyLevel = g, validatePartyLevel = h, PartyGameRoot = m;
"""
        + (root / "scripts/party-loading.js").read_text()
        + (root / "scripts/party-overlay.js").read_text()
        + (root / "scripts/party-entry.js").read_text()
        + (root / "scripts/party-route.js").read_text()
        + source[end:].replace("export{E as component}", "export{PartyRoute as component}", 1)
    )


patch("party._code-D3a-IB4-.js", route_patch)


def transport_patch(source):
    # Preserve completed-run recording when the server has no deadline.
    source = replace_once(
        source,
        "Date.now()<r.timerEndsAt",
        "(!r.timerEndsAt||Date.now()<r.timerEndsAt)",
    )
    # The original Zn adapter owns only the party socket and state-store bindings.
    # Leave the surrounding rendering, input and simulation functions untouched.
    start = source.index("function Zn(")
    end = source.index("function Qn(", start)
    bindings = """
const transportPartyStore = M;
const transportGameStore = B;
const transportSettings = E;
const transportScene = V;
const registerTransportSender = ie;
const setTransportIdentity = re;
const updateTransportParty = P;
const setTransportFlyCamera = ne;
const setTransportRoster = ve;
const setTransportBoard = ue;
const setTransportFinal = F;
const removeTransportGhost = Me;
const showTransportCompletion = Fe;
const transportGhostHue = je;
const setTransportError = N;
const updateTransportGhost = Ne;
const isTransportSpectator = _e;
"""
    transport_source = (root / "scripts/party-transport.js").read_text()
    # The test-only export is meaningless inside the bundle and is stripped here.
    transport_source = transport_source.replace("export { connectBetterParty };\n", "")
    source = (
        source[:start]
        + bindings
        + transport_source
        + "\nfunction Zn(code,identity,options){return connectBetterParty(code,identity,options)}\n"
        + source[end:]
    )
    source = replace_once(
        source,
        "ne=(0,J.useCallback)(()=>{window.setTimeout(()=>j(!0),2500)},[])",
        "ne=(0,J.useCallback)(()=>{bpScenePrepared(l.id);window.setTimeout(()=>j(!0),2500)},[l])",
    )
    # The original Dn ball starts at [0, radius, 0] and consumes the
    # runtime's one-shot teleport AFTER the physics step. A replacement
    # Rapier world can therefore advance at the origin, or miss a teleport
    # consumed by the outgoing world. Give the party body its actual tee
    # and initialize each fresh attempt/body before either physics driver.
    source = replace_once(
        source,
        "function Dn({century:e=!1})",
        "function Dn({century:e=!1,bpLevel,bpRuntimeReady})",
    )
    source = replace_once(
        source,
        "return S((a,o)=>{let p=t?o:Math.min(o,_n)",
        """const bpAttempt = (0,J.useRef)(null);
    const bpSpawn = bpLevel ? Lr(bpLevel).spawn : null;
    W(()=>{
      const body=n.current, game=B.state;
      if(!bpSpawn || !bpRuntimeReady.current || !body || game.level?.id!==bpLevel.id) return;
      if(bpAttempt.current?.body===body && bpAttempt.current.seq===game.attemptSeq) return;
      bpAttempt.current={body,seq:game.attemptSeq};
      if(game.phase!==`aiming` || game.strokes!==0) return;
      body.setTranslation({x:bpSpawn[0],y:bpSpawn[1]+K.ballRadius,z:bpSpawn[2]},true);
      body.setLinvel(gn,true);
      body.setAngvel(gn,true);
      if(N.current){
        N.current=false;
        body.setBodyType(f.Dynamic,true);
        if(r.current) r.current.visible=true;
        if(i.current) i.current.visible=e;
      }
      V.discontinuitySeq++;
      V.ballPos.set(bpSpawn[0],bpSpawn[1]+K.ballRadius,bpSpawn[2]);
    },-101);
    return S((a,o)=>{let p=t?o:Math.min(o,_n)""",
    )
    source = replace_once(
        source,
        "let h=n.current;if(!h)return;let g=B.state;if(g.teleport)",
        "let h=n.current;if(!h)return;let g=B.state;if(bpLevel&&(!bpRuntimeReady.current||g.level?.id!==bpLevel.id))return;if(g.teleport)",
    )
    source = replace_once(
        source,
        "position:[0,K.ballRadius,0],onCollisionEnter",
        "position:bpSpawn?[bpSpawn[0],bpSpawn[1]+K.ballRadius,bpSpawn[2]]:[0,K.ballRadius,0],onCollisionEnter",
    )
    source = replace_once(
        source,
        "(0,Y.jsx)(Dn,{century:m})",
        "!bpHideLocalBall&&(0,Y.jsx)(Dn,{century:m,bpLevel:_e?l:void 0,bpRuntimeReady:z})",
    )
    # The original ball is a Rapier rigid body (Dn), with separate aim and
    # shadow meshes. Do not mount any of them until the party role is known.
    # Keep the canvas, course and socket mounted for spectators.
    source = replace_once(
        source,
        "let l=(0,J.useMemo)(()=>wt(e),[e]);Wr(l);",
        "let l=(0,J.useMemo)(()=>wt(e),[e]);Wr(l);const bpPaused=w(transportPartyStore,e=>!!e.bpPausedAt),bpAdminAttempt=w(transportPartyStore,e=>e.bpAttempt??0);",
    )
    source = replace_once(
        source, "paused:Ye(l)===2,debug:Gr", "paused:Ye(l)===2||bpPaused,debug:Gr"
    )
    source = replace_once(
        source,
        "Ye(l)===2?`${l.id}:2`:`legacy`",
        "(Ye(l)===2?`${l.id}:2`:`legacy`)+':'+bpAdminAttempt",
    )
    source = replace_once(source, "!t&&e&&n>0?(Yt.copy", "!t&&e&&n>0&&j()?(Yt.copy")
    source = replace_once(
        source,
        "d=w(A,k),p=w(A,te)",
        "bpColor=w(transportPartyStore,e=>{const player=e.roster.find(p=>p.uid===e.self?.uid);return player?.colorOverride?'hsl('+player.hue+',75%,62%)':null}),d=w(A,k),p=w(A,te)",
    )
    source = replace_once(source, "m.color.set(d)", "m.color.set(bpColor??d)")
    # Use roster hue for actual remote ball mesh, not just the name tag.
    source = source.replace(
        "t.ballColor?$.set(t.ballColor):$.setHSL(t.hue/360,.75,.62)", "bpGhostColor(e,t,$)"
    )
    source += """
function bpGhostColor(id,ghost,color){
  const player=transportPartyStore.state.roster.find(member=>member.id===id);
  if(player?.colorOverride){color.setHSL(player.hue/360,.75,.62);return}
  if(ghost.ballColor){color.set(ghost.ballColor);return}
  color.setHSL((player?.hue??ghost.hue)/360,.75,.62)
}
"""
    source = replace_once(
        source,
        "Se=ge||xe;return",
        """bpSpectating=w(M,e=>e.active&&e.selfRole===`spectator`),bpHideLocalBall=w(M,e=>e.active&&(!e.bpInitialSnapshot||e.selfRole===`spectator`||!e.roster.some(p=>p.uid===e.self?.uid))),bpWatchPhase=w(transportGameStore,e=>e.phase),bpFollowId=w(M,e=>followTarget(e,bpWatchPhase)?.id??null),bpObserver=w(M,e=>canWatch(e,bpWatchPhase)),Se=ge||xe||bpSpectating||bpObserver;return""",
    )
    source = replace_once(
        source,
        "(0,Y.jsx)(ir,{}),(0,Y.jsx)(hr,{})",
        "!bpHideLocalBall&&(0,Y.jsx)(ir,{}),!bpHideLocalBall&&(0,Y.jsx)(hr,{})",
    )
    source = replace_once(
        source,
        "(0,Y.jsx)(en,{}),(0,Y.jsx)(nn,{})",
        "(0,Y.jsx)(en,{}),!bpHideLocalBall&&(0,Y.jsx)(nn,{})",
    )
    source = replace_once(
        source,
        "Se?(0,Y.jsx)(Fr,{}):(0,Y.jsx)(Pr,{overview:l.overview,overviewRoots:p})",
        "bpFollowId?(0,Y.jsx)(BpFollowCamera,{targetId:bpFollowId},bpFollowId):Se?(0,Y.jsx)(Fr,{}):(0,Y.jsx)(Pr,{overview:l.overview,overviewRoots:p})",
    )
    source = replace_once(
        source,
        "let s=E.state.ghosts,c=bt(s,U.size,On)",
        "let s=E.state.ghosts||!!followTarget(M.state,B.state.phase),c=bt(s,U.size,On)",
    )
    source += (
        "\nconst followUseFrame=W,followUseThree=G,followReact=J,FollowVector=H,followGhosts=U,followScene=V;\n"
        + (root / "scripts/follow-camera.js").read_text()
    )
    return (
        "import{bpConnection,bpAck,bpScenePrepared,transportSceneReadyLevelId,"
        'receiveTransportHostToken,clearTransportHostToken,bpReceiveVote,bpWatchLive,bpHostNotice}from"./runtime-DL2fiDAQ.js";'
        'import{followTarget,canWatch,liveGhost}from"./bp-spectator-follow.js";' + source
    )


patch("GameCanvas-C5hQh1sR.js", transport_patch)


def pause_physics_patch(source):
    source = 'import{bpPhysicsPaused}from"./runtime-DL2fiDAQ.js";' + source
    source = replace_once(
        source, "r?.version!==2&&e(t,n)", "r?.version!==2&&!bpPhysicsPaused()&&e(t,n)"
    )
    source = replace_once(
        source,
        "if(document.hidden){e.clock.setHidden(!0);return}let a=[...e.subscribers]",
        "let bpHidden=document.hidden||bpPhysicsPaused();if(e.clock.hidden!==bpHidden)e.clock.setHidden(bpHidden);if(bpHidden)return;let a=[...e.subscribers]",
    )
    return source


patch("AppearanceClone-CBos6VT9.js", pause_physics_patch)


def runtime_patch(s):
    # The original playable gate treats timerEndsAt=0 as unlimited.
    s = replace_once(s, "&&n?n+e.timerMs:0", "&&n&&e.timerMs?n+e.timerMs:0")
    s = replace_once(
        s,
        "active:!0,code:e,hostToken:n,self:t,selfRole:",
        "active:!0,replayId:null,vote:null,bpAttempt:0,bpResetPending:false,bpPausedAt:null,bpCoHost:false,bpPuttingLocked:false,bpStrokeAdjustment:0,bpHostNotice:null,bpWatchChoice:null,bpWatchLive:false,bpInitialSnapshot:false,bpSceneReady:null,bpConnected:false,bpEverConnected:false,bpConnectionError:null,awaitingPlayers:0,roster:[],board:null,final:null,code:e,hostToken:n,self:t,selfRole:",
    )
    s = replace_once(
        s,
        "active:!1,selfRole:",
        "active:!1,replayId:null,vote:null,bpAttempt:0,bpResetPending:false,bpPausedAt:null,bpCoHost:false,bpPuttingLocked:false,bpStrokeAdjustment:0,bpHostNotice:null,bpWatchChoice:null,bpWatchLive:false,bpInitialSnapshot:false,bpSceneReady:null,bpConnected:false,bpEverConnected:false,bpConnectionError:null,awaitingPlayers:0,selfRole:",
    )
    s = replace_once(
        s,
        "phase:e.phase,holeIndex:e.holeIndex",
        "bpPlaylistRevision:e.playlistRevision??0,bpPausedAt:e.pausedAt?Date.now()+e.pausedAt-e.now:null,recordEligible:e.recordEligible!==false,replayId:e.replayId??null,vote:e.vote?{...e.vote,endsAt:Date.now()+e.vote.endsAt-e.now}:null,bpInitialSnapshot:true,recoveryNotice:!!e.recoveryNotice,randomHistoryCount:e.randomHistoryCount??0,preparing:!!e.preparing,awaitingPlayers:e.awaitingPlayers??0,nextError:e.nextError??null,playlistTitles:e.playlistTitles??{},roundHistory:e.roundHistory??[],initialPlayers:e.initialPlayers??0,phase:e.phase,holeIndex:e.holeIndex",
    )
    s = replace_once(
        s,
        "e.active?c()||e.phase!==`playing`||!e.mapReady",
        "e.active?!e.bpConnected||bpInputBlocked()||c()||e.phase!==`playing`||!e.mapReady",
    )
    s = replace_once(
        s,
        "t.state.active&&(e.phase===`holed`",
        "(t.state.active||(i.state.active&&i.state.phase===`playing`&&i.state.selfRole===`player`))&&(e.phase===`holed`",
    )
    # Roster updates also carry host-issued attempt epochs and the input gate.
    # Preserve the native store identity and role/fly-camera transitions.
    s = replace_once(
        s,
        "roster:e,count:e.length,isHost:a?.isHost??t.isHost",
        "roster:e,count:e.length,bpCoHost:!!a?.coHost,bpPuttingLocked:!!a?.puttingLocked,bpResetPending:!!a?.resetPending,bpStrokeAdjustment:a?.strokeAdjustment??0,bpAttempt:a?.attempt??0,...((a?.attempt??0)!==(t.bpAttempt??0)?{mapReady:false,bpSceneReady:null}:{}),isHost:a?.isHost??t.isHost",
    )
    # The release path checks the same input authorization as pointer-down.
    # Cancel charging without touching an already rolling ball.
    s = replace_once(
        s,
        "function A(e){w.state.phase===`charging`&&",
        "function A(e){if(bpInputBlocked()){V.aim.active=false;V.aim.power=0;k();return}w.state.phase===`charging`&&",
    )
    return s + "\nconst partyRuntimeStore = i;\n" + (root / "scripts/party-runtime.js").read_text()


patch("runtime-DL2fiDAQ.js", runtime_patch)


def game_patch(s):
    s = replace_once(s, "children:Pt(c)", "children:i?Pt(c):`∞`")
    s = replace_once(s, "let c=i?i-Date.now():0", "let c=i?i-bpClockNow():0")
    s = (
        'import{bpHostAction,bpPickerBusy,bpLeaveParty,bpCastVote,bpSelectWatchTarget,bpClockNow}from"./runtime-DL2fiDAQ.js";'
        + s
    )
    a = s.index("function At(")
    b = s.index("function jt(", a)
    s = (
        s[:a]
        + "\nconst BetterPartyReact = q, useBetterPartyState = j, betterPartyStore = R, updateBetterPartyConfig = L;\n"
        + (root / "scripts/picker.js").read_text()
        + "\nfunction At(props){return CommunityCoursePicker(props)}\n"
        + s[b:]
    )
    # Replace only the lobby overlay; retain the original scene, camera,
    # route, stores and Ready/Start runtime functions unchanged.
    a = s.index("function Mt(")
    b = s.index("function Nt(", a)
    s = (
        s[:a]
        + "\nconst bpSetReady = de, bpStartMatch = le, BpOriginalLobbyPlayer = jt;\n"
        + (root / "scripts/lobby.js").read_text()
        + "\nfunction Mt(){return (0,J.jsx)(BpLobbyDashboard,{})}\n"
        + s[b:]
    )
    s = replace_once(
        s,
        "children:d?`Tallying the winners…`:`Next hole starting…`",
        "children:R.state.preparing?`Loading next community hole…`:d?`Tallying the winners…`:`Next hole starting…`",
    )
    s = replace_once(
        s,
        "a.holes-1||c<=1",
        "a.holes-1||(a.elimination&&(c===0||(R.state.initialPlayers>1&&c===1)))",
    )
    # Leaving on purpose tells the server so, which hands host authority on at
    # once instead of waiting out the reconnect grace period.
    s = replace_once(
        s,
        "{href:`/party`,className:`mt-3 block text-xs font-semibold text-white/40 no-underline hover:text-white/70`,children:`Leave party`}",
        "{href:`/party`,onClick:()=>bpLeaveParty(),className:`mt-3 block text-xs font-semibold text-white/40 no-underline hover:text-white/70`,children:`Leave party`}",
    )
    s = replace_once(
        s,
        "b?ne===`playing`&&i!==`holed`&&i!==`forfeit`&&(0,J.jsx)(Ut,{}):w?null:",
        "b?ne===`playing`&&i!==`holed`&&i!==`forfeit`&&(0,J.jsx)(Ut,{}):w?T===`playing`&&!D&&i!==`holed`&&i!==`forfeit`&&(0,J.jsx)(Ut,{}):",
    )
    s = replace_once(
        s,
        "(0,J.jsx)(It,{}),(0,J.jsx)(Lt,{})",
        "(0,J.jsx)(It,{}),(0,J.jsx)(BpConnectionNotice,{}),(0,J.jsx)(Lt,{})",
    )
    s = replace_once(
        s,
        "children:[`alive `,a.alive,` · holed `,a.holed]}),",
        "children:[`alive `,a.alive,` · holed `,a.holed]}),(0,J.jsx)(BpUpcoming,{}),",
    )
    s = replace_once(
        s,
        "pointer-events-none absolute right-3 top-3 z-10 w-56 rounded-2xl bg-black/60 p-3",
        "pointer-events-none absolute right-3 z-10 w-56 rounded-2xl bg-black/60 p-3 bp-party-status",
    )
    s = replace_once(
        s,
        '(0,J.jsx)(a,{to:`/`,"aria-label":`Back to home`,className:`pointer-events-auto shrink-0 rounded-xl bg-black/50 p-2 text-white transition hover:bg-black/70`',
        '(0,J.jsx)(`a`,{href:`/home`,"aria-label":`Back to home`,className:`pointer-events-auto shrink-0 rounded-xl bg-black/50 p-2 text-white transition hover:bg-black/70 bp-toolbar-home`',
    )
    s = replace_once(
        s,
        "className:`flex shrink-0 items-start gap-2`,children:[s&&",
        "className:`flex shrink-0 items-start gap-2 bp-toolbar`,children:[s&&",
    )
    # Party spectators use the original free camera, with no local score or
    # putting controls. The overlay uses the same HUD typography and contrast.
    s = replace_once(s, "O=x||E,k=()=>", "O=x||E||D,k=()=>")
    s = replace_once(
        s,
        "children:[s&&(0,J.jsx)(`div`,{className:`rounded-xl bg-black/50 px-4",
        "children:[s&&!D&&(0,J.jsx)(`div`,{className:`rounded-xl bg-black/50 px-4",
    )
    s = replace_once(
        s,
        "i===`charging`&&(0,J.jsx)(`p`,{className:`rounded-full bg-black/50",
        "i===`charging`&&!D&&(0,J.jsx)(`p`,{className:`rounded-full bg-black/50",
    )
    s = replace_once(
        s,
        "w&&(i===`holed`||i===`forfeit`||D))&&(0,J.jsx)(`button`",
        "w&&!D&&(i===`holed`||i===`forfeit`))&&(0,J.jsx)(`button`",
    )
    s = replace_once(
        s,
        "children:[w&&T===`playing`&&i===`holed`",
        "children:[(0,J.jsx)(BpSpectating,{}),w&&!D&&T===`playing`&&i===`holed`",
    )
    # Extend the existing results panel and scoreboard, retaining the archived HUD.
    s = replace_once(
        s,
        "o=j(R,e=>e.self?.uid);if(!e||t!==`hole-results`)",
        "o=j(R,e=>e.self?.uid),bpVote=j(R,e=>e.vote);if(!e||t!==`hole-results`)",
    )
    s = replace_once(
        s,
        "className:`mx-6 max-h-[88dvh] w-full max-w-sm overflow-y-auto rounded-3xl bg-[#11272b]/95 p-6 text-center shadow-2xl`,children:[(0,J.jsxs)(`p`,{className:`text-xs font-bold uppercase tracking-widest text-white/45`",
        "className:`mx-6 max-h-[88dvh] w-full ${bpVote?`max-w-3xl`:`max-w-sm`} overflow-y-auto rounded-3xl bg-[#11272b]/95 p-6 text-center shadow-2xl`,children:[(0,J.jsxs)(`p`,{className:`text-xs font-bold uppercase tracking-widest text-white/45`",
    )
    s = replace_once(
        s,
        "(0,J.jsx)(`p`,{className:`text-sm font-semibold text-white/60`,children:R.state.preparing?",
        "bpVote?(0,J.jsx)(BpCourseVote,{}):(0,J.jsx)(`p`,{className:`text-sm font-semibold text-white/60`,children:R.state.preparing?",
    )
    # The original results HUD normally assumes a completed round. An opening
    # ballot must never say that hole one is already done or announce winners.
    s = replace_once(
        s,
        "if(!e||t!==`hole-results`)return null;let s=n?.standings",
        "if(!e||t!==`hole-results`)return null;if(bpVote?.target===0)return(0,J.jsx)(`div`,{className:`pointer-events-auto absolute inset-0 z-10 flex items-center justify-center bg-black/50`,children:(0,J.jsx)(`div`,{className:`mx-6 max-h-[88dvh] w-full max-w-3xl overflow-y-auto rounded-3xl bg-[#11272b]/95 p-6 text-center shadow-2xl`,children:(0,J.jsx)(BpCourseVote,{})})});let s=n?.standings",
    )
    for name, total in [("Ft", False), ("Lt", False), ("Ht", True)]:
        a = s.index("function " + name + "(")
        b = s.index("function ", a + 10)
        part = s[a:b]
        part = replace_once(
            part,
            "children:[`⛳`,e.holesSurvived,` · `,e.totalStrokes]})",
            "children:[`⛳`,e.holesSurvived,` · `,e.totalStrokes]}),(0,J.jsx)(BpPlayerTime,{row:e"
            + (",total:true" if total else "")
            + "})",
        )
        s = s[:a] + part + s[b:]
    s = replace_once(
        s,
        "(0,J.jsx)(BpSpectating,{}),w&&!D",
        "(0,J.jsx)(BpSpectating,{}),(0,J.jsx)(BpHoleClock,{}),w&&!D",
    )
    # Observer-only controls use the original renderer's ghost positions and
    # never mount alongside the ordinary active-player camera.
    s = (
        'import{canWatch,watchChoice,watchCandidates,followTarget}from"./bp-spectator-follow.js";'
        + s
    )
    s = replace_once(
        s,
        "(0,J.jsxs)(`span`,{className:`flex-1 truncate text-xs font-medium ${e.alive?`text-white/90`:`text-white/35 line-through`}`,children:[e.name,t?` (you)`:``]})",
        "(0,J.jsx)(BpWatchName,{row:e,isSelf:t})",
    )
    s = replace_once(
        s,
        "(0,J.jsx)(BpSpectating,{}),(0,J.jsx)(BpHoleClock,{})",
        "(0,J.jsx)(BpSpectating,{}),(0,J.jsx)(BpFollowControls,{}),(0,J.jsx)(BpHoleClock,{})",
    )
    s = replace_once(
        s,
        "O=x||E||D,k=()=>",
        "bpStrokeAdjustment=j(R,e=>e.bpStrokeAdjustment??0),bpObserver=w&&T===`playing`&&(D||i===`holed`||i===`forfeit`),O=x||E||D||bpObserver,k=()=>",
    )
    s = replace_once(
        s,
        "w&&!D&&(i===`holed`||i===`forfeit`))&&(0,J.jsx)(`button`",
        "w&&!bpObserver&&!D&&(i===`holed`||i===`forfeit`))&&(0,J.jsx)(`button`",
    )
    s = replace_once(
        s,
        "O&&(0,J.jsx)(`p`,{className:`rounded-full bg-black/50 px-4 py-1.5 text-xs font-medium`,children:`Free cam:",
        "O&&!bpObserver&&(0,J.jsx)(`p`,{className:`rounded-full bg-black/50 px-4 py-1.5 text-xs font-medium`,children:`Free cam:",
    )
    s += "\nconst followGameStore=z;\n" + (root / "scripts/follow-controls.js").read_text()
    s = replace_once(
        s,
        "children:[o,` `,(0,J.jsxs)",
        "children:[Math.max(0,o+bpStrokeAdjustment),` `,(0,J.jsxs)",
    )
    s = replace_once(
        s,
        "(0,J.jsx)(BpWatchName,{row:e,isSelf:t})",
        "(0,J.jsx)(BpWatchName,{row:e,isSelf:t}),(0,J.jsx)(BpPlayerMenu,{uid:e.uid})",
    )
    s = replace_once(
        s,
        "children:e.role===`spectator`?`👀`:e.ready?`✅`:`·`})]",
        "children:e.role===`spectator`?`👀`:e.ready?`✅`:`·`}),(0,J.jsx)(BpPlayerMenu,{uid:e.uid})]",
    )
    s = replace_once(
        s,
        "(0,J.jsx)(BpSpectating,{}),(0,J.jsx)(BpFollowControls,{})",
        "(0,J.jsx)(BpSpectating,{}),(0,J.jsx)(BpManagementNotice,{}),(0,J.jsx)(BpFollowControls,{})",
    )
    # Host menu is a sibling of the settings wrapper, not inside it.
    a = s.index("function It(")
    s = s[:a] + (root / "scripts/match-details.js").read_text() + s[a:]
    s = (
        s[:a]
        + (root / "scripts/host-menu.js").read_text()
        + (root / "scripts/player-management.js").read_text()
        + s[a:]
    )
    s = replace_once(
        s,
        '})]})]})]})]}),(0,J.jsxs)(`div`,{"data-overview-hud":`bottom`',
        '})]})]}),(0,J.jsx)(BpHostMenu,{settingsOpen:A,closeSettings:()=>ie(false)})]})]}),(0,J.jsxs)(`div`,{"data-overview-hud":`bottom`',
    )
    a = s.index("function Ht(")
    b = s.index("function ", a + 10)
    part = s[a:b]
    part = replace_once(
        part,
        "(0,J.jsx)(`ul`,{className:`mb-5 flex flex-col",
        "(0,J.jsx)(BpScorecard,{}),(0,J.jsx)(`ul`,{className:`mb-5 flex flex-col",
    )
    s = s[:a] + part + s[b:]
    for component_name in ("Lt", "Ht"):
        start = s.index("function " + component_name + "(")
        end = s.index("function ", start + 10)
        part = s[start:end]
        part = replace_once(part, "(0,J.jsx)(yt,{mode:`party`})", "(0,J.jsx)(BpReplayLink,{})")
        s = s[:start] + part + s[end:]
    return s


patch("GameRoot-7kMtVtdO.js", game_patch)


def replay_patch(source):
    return (
        'import{sampleAt as bpSampleAt,activeNodesAt as bpActiveNodesAt}from"./replay-timeline.js";\n'
        + source
        + "\n"
        + (root / "scripts/party-replay-scene.js").read_text()
    )


patch("Replay3D-Cz9axXph.js", replay_patch)
# Strip the captured CSS import of Google fonts for isolated local mode.
p = web / "assets/styles-S28F_fms.css"
s = p.read_text()
p.write_text(
    re.sub(r'^@import "[^"]+";', "", s, count=1)
    + "\n"
    + (root / "scripts/better-party.css").read_text()
)
# Server-side original validator import closure. This is generated output, so it is
# written into the staging directory next to the prepared client and published with
# it. It must never be written under private-client/, which holds the immutable
# archived originals that the lock hashes.
validation = web / "validation"
validation.mkdir(exist_ok=True)
for path in json.loads((root / "scripts/client-lock.json").read_text()):
    if path.startswith("/assets/") and path.endswith(".js"):
        source = private / path.lstrip("/")
        shutil.copyfile(source, validation / source.name)
(validation / "index-DFMxt6BL.js").write_text(
    "export const Xt={state:{active:false}}; export const A=new Map();"
)
# A build stamp, so a prepared client can say which source produced it. Without
# one, a `web/` left over from an earlier checkout starts silently and serves a
# client whose patches do not match the server that is running - the failure shows
# up as a broken button rather than an error. The hash is over the patcher's own
# inputs: the Python patcher and every snippet it splices, so any change to the
# client build changes the stamp.
build_inputs = [root / "scripts" / "patch-client.py"] + sorted(
    root / "scripts" / name
    for name in (
        "client-bootstrap.js",
        "party-loading.js",
        "party-overlay.js",
        "party-entry.js",
        "party-route.js",
        "party-runtime.js",
        "party-transport.js",
        "picker.js",
        "lobby.js",
        "match-details.js",
        "host-menu.js",
        "player-management.js",
        "better-party.css",
        "party-replay-scene.js",
        "replay-timeline.js",
        "replay-page.js",
        "spectator-follow.js",
        "follow-camera.js",
        "follow-controls.js",
    )
)
build_hash = hashlib.sha256()
for path in build_inputs:
    build_hash.update(path.name.encode())
    build_hash.update(path.read_bytes())
(web / "build.json").write_text(
    json.dumps(
        {
            "clientBuild": build_hash.hexdigest()[:16],
            "assets": len(json.loads((root / "scripts/client-lock.json").read_text())),
        },
        indent=2,
    )
    + "\n"
)
print(
    "Patched isolated browser bootstrap, local join, local catalog, original validation; Party transport, scene readiness, and initial ball placement patched; shot physics unchanged."
)
