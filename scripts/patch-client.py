"""Apply hash-pinned changes to copies of the original client bundles."""

import re
import shutil
from pathlib import Path

root = Path(__file__).resolve().parent.parent
web = root / "web"
private = root / "private-client"


# Executed by prepare-client.py after copying immutable bundles.
def replace_once(s, a, b):
    assert s.count(a) == 1, (a[:100], s.count(a))
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
        + (root / "scripts/party-entry.js").read_text()
        + (root / "scripts/party-route.js").read_text()
        + source[end:].replace("export{E as component}", "export{PartyRoute as component}", 1)
    )


patch("party._code-D3a-IB4-.js", route_patch)


def transport_patch(source):
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
    source = (
        source[:start]
        + bindings
        + (root / "scripts/party-transport.js").read_text()
        + "\nfunction Zn(code,identity,options){return connectBetterParty(code,identity,options)}\n"
        + source[end:]
    )
    source = replace_once(
        source,
        "ne=(0,J.useCallback)(()=>{window.setTimeout(()=>j(!0),2500)},[])",
        "ne=(0,J.useCallback)(()=>{bpScenePrepared(l.id);window.setTimeout(()=>j(!0),2500)},[l.id])",
    )
    return 'import{bpConnection,bpAck,bpScenePrepared}from"./runtime-DL2fiDAQ.js";' + source


patch("GameCanvas-C5hQh1sR.js", transport_patch)


def runtime_patch(s):
    s = replace_once(
        s,
        "active:!0,code:e,hostToken:n,self:t,selfRole:",
        "active:!0,bpInitialSnapshot:false,bpSceneReady:null,bpConnected:false,bpEverConnected:false,bpConnectionError:null,roster:[],board:null,final:null,code:e,hostToken:n,self:t,selfRole:",
    )
    s = replace_once(
        s,
        "active:!1,selfRole:",
        "active:!1,bpInitialSnapshot:false,bpSceneReady:null,bpConnected:false,bpEverConnected:false,bpConnectionError:null,selfRole:",
    )
    s = replace_once(
        s,
        "phase:e.phase,holeIndex:e.holeIndex",
        "bpInitialSnapshot:true,recoveryNotice:!!e.recoveryNotice,randomHistoryCount:e.randomHistoryCount??0,preparing:!!e.preparing,nextError:e.nextError??null,playlistTitles:e.playlistTitles??{},roundHistory:e.roundHistory??[],initialPlayers:e.initialPlayers??0,phase:e.phase,holeIndex:e.holeIndex",
    )
    s = replace_once(
        s,
        "e.active?c()||e.phase!==`playing`||!e.mapReady",
        "e.active?!e.bpConnected||c()||e.phase!==`playing`||!e.mapReady",
    )
    s = replace_once(
        s,
        "t.state.active&&(e.phase===`holed`",
        "(t.state.active||(i.state.active&&i.state.phase===`playing`&&i.state.selfRole===`player`))&&(e.phase===`holed`",
    )
    return s + "\nconst partyRuntimeStore = i;\n" + (root / "scripts/party-runtime.js").read_text()


patch("runtime-DL2fiDAQ.js", runtime_patch)


def game_patch(s):
    s = 'import{bpHostAction,bpPickerBusy}from"./runtime-DL2fiDAQ.js";' + s
    a = s.index("function At(")
    b = s.index("function jt(", a)
    s = (
        s[:a]
        + "\nconst BetterPartyReact = q, useBetterPartyState = j, betterPartyStore = R, updateBetterPartyConfig = L;\n"
        + (root / "scripts/picker.js").read_text()
        + "\nfunction At(props){return CommunityCoursePicker(props)}\n"
        + s[b:]
    )
    a = s.index("function Mt(")
    b = s.index("function Nt(", a)
    s = (
        s[:a]
        + replace_once(
            s[a:b],
            "mx-6 max-h-[88dvh] w-full max-w-sm overflow-y-auto rounded-3xl bg-[#11272b] p-7",
            "mx-6 max-h-[88dvh] w-full max-w-6xl overflow-y-auto rounded-3xl bg-[#11272b] p-7 bp-lobby",
        )
        + s[b:]
    )
    a = s.index("function Mt(")
    b = s.index("function Nt(", a)
    part = s[a:b]
    first = part.index("s.mapSource===`random`&&(0,J.jsxs)(`label`")
    last = part.index(
        "(0,J.jsxs)(`label`,{className:`flex items-center justify-between gap-3 text-xs font-medium text-white/85`,children:[(0,J.jsx)(`span`,{children:`Elimination`})",
        first,
    )
    part = part[:first] + "(0,J.jsx)(BpNumericSettings,{})," + part[last:]
    s = s[:a] + part + s[b:]
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
    s = replace_once(
        s,
        "s=j(R,e=>e.config),[c,l]",
        "s=j(R,e=>e.config),bpPreparing=j(R,e=>e.preparing||e.bpPickerBusy),[c,l]",
    )
    s = replace_once(
        s,
        "disabled:s.mapSource===`picked`&&!s.selectedHoleIds?.length",
        "disabled:bpPreparing||(s.mapSource===`picked`&&!s.selectedHoleIds?.length)",
    )
    s = replace_once(
        s,
        "a&&(0,J.jsxs)(`div`,{className:`mb-5 flex flex-col gap-3 rounded-xl bg-white/5 p-3 text-left`",
        "!a&&(0,J.jsx)(BpGuestPlaylist,{}),a&&(0,J.jsxs)(`div`,{className:`mb-5 flex flex-col gap-3 rounded-xl bg-white/5 p-3 text-left`",
    )
    s = replace_once(
        s, "(0,J.jsx)(At,{config:s}),", "(0,J.jsx)(At,{config:s}),(0,J.jsx)(BpLobbyOptions,{}),"
    )
    s = replace_once(
        s,
        "children:`Party lobby`}),n&&",
        "children:`Party lobby`}),(0,J.jsx)(BpRecoveryNotice,{}),n&&",
    )
    s = replace_once(
        s, "children:`Start party`", "children:bpPreparing?`Loading courses…`:`Start party`"
    )
    s = replace_once(
        s,
        "!a&&(0,J.jsx)(BpGuestPlaylist,{}),",
        "!a&&(0,J.jsxs)(J.Fragment,{children:[(0,J.jsx)(BpGuestPlaylist,{}),(0,J.jsx)(BpGuestStarting,{})]}),",
    )
    s = replace_once(
        s,
        "(0,J.jsx)(`p`,{className:`text-xs text-white/50`,children:`Waiting for the host to start…`})",
        "!bpPreparing&&(0,J.jsx)(`p`,{className:`text-xs text-white/50`,children:`Waiting for the host to start…`})",
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
    # Host menu is a sibling of the settings wrapper, not inside it.
    a = s.index("function It(")
    s = s[:a] + (root / "scripts/match-details.js").read_text() + s[a:]
    s = s[:a] + (root / "scripts/host-menu.js").read_text() + s[a:]
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
    return s


patch("GameRoot-7kMtVtdO.js", game_patch)
# Strip the captured CSS import of Google fonts for isolated local mode.
p = web / "assets/styles-S28F_fms.css"
s = p.read_text()
p.write_text(
    re.sub(r'^@import "[^"]+";', "", s, count=1)
    + "\n"
    + (root / "scripts/better-party.css").read_text()
)
# Server-side original validator import closure: only index browser dependency stubbed.
validation = root / "private-client" / "validation"
validation.mkdir(exist_ok=True)
for source in (private / "assets").glob("*.js"):
    shutil.copyfile(source, validation / source.name)
(validation / "index-DFMxt6BL.js").write_text(
    "export const Xt={state:{active:false}}; export const A=new Map();"
)
print(
    "Patched isolated browser bootstrap, local join, local catalog, original validation; Party transport and scene readiness changes only in GameCanvas; physics unchanged."
)
