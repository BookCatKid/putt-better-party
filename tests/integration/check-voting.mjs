import { connect, waitFor, pause } from './cdp.mjs';
import assert from 'node:assert/strict';

const base = process.env.BASE || 'http://127.0.0.1:8789';
const debugging = 'http://127.0.0.1:9239';
const runtime = '(await import("/assets/runtime-DL2fiDAQ.js"))';
const client = await connect(
  (await fetch(debugging + '/json/list').then((response) => response.json())).find(
    (target) => target.type === 'page',
  ),
);
const state = (condition, timeout = 45000) =>
  waitFor(
    client,
    '(async()=>{const r=' +
      runtime +
      ',s=r.E.state,g=r.m.state;return (' +
      condition +
      ')&&!document.querySelector(".bp-party-loading")})()',
    timeout,
  );
let guest;
const post = async (path, body) => {
  const response = await fetch(base + path, {
    method: 'POST',
    headers: { origin: base, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert(response.ok, String(response.status));
  return response.json();
};
try {
  await client.call('Page.navigate', { url: base + '/home' });
  await waitFor(client, 'typeof document.querySelector("#create")?.onclick==="function"');
  await client.evalJS('document.querySelector("#create").click()');
  await waitFor(client, 'document.querySelector("input")?.placeholder==="Your name"');
  await client.evalJS(
    '(()=>{const el=document.querySelector("input");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(el,"Vote host");el.dispatchEvent(new Event("input",{bubbles:true}))})()',
  );
  await waitFor(
    client,
    '[...document.querySelectorAll("button")].some(b=>b.textContent==="Join"&&!b.disabled)',
  );
  await client.evalJS(
    '[...document.querySelectorAll("button")].find(b=>b.textContent==="Join").click()',
  );
  await state('s.isHost && s.mapReady && s.bpConnected');
  const choice = 'document.querySelector(\'input[aria-label="Course voting"]\')';
  await waitFor(client, '!!' + choice);
  assert.equal(
    await client.evalJS(
      'document.querySelector(\'input[aria-label="Exclude daily holes"]\').closest("label").nextElementSibling.querySelector(\'input[aria-label="Course voting"]\')!==null',
    ),
    true,
  );

  assert.equal(await client.evalJS(choice + '.checked'), false);
  await client.evalJS(choice + '.click()');
  await state('s.config.courseVoting===true');
  await client.evalJS(
    '(async()=>{const r=' + runtime + ';r.D({holes:2,timerMs:90000,elimination:false})})()',
  );
  await state('s.config.holes===2 && !s.config.elimination');
  const code = await client.evalJS('location.pathname.split("/").at(-1)');
  const identity = await post('/api/join', { code, name: 'Vote guest' });
  guest = new WebSocket(base.replace('http', 'ws') + '/ws/party/' + code, {
    headers: { origin: base },
  });
  let snapshot;
  guest.onmessage = (event) => {
    const frame = JSON.parse(event.data);
    if (frame.t === 'party') {
      snapshot = frame;
    }
  };
  await new Promise((resolve, reject) => {
    guest.onopen = resolve;
    guest.onerror = reject;
  });
  const send = (message) => guest.send(JSON.stringify(message));
  send({ t: 'join', ...identity, protocol: 2, instance: 'vote-integration' });
  await state('s.roster.length===2');
  await client.evalJS(
    '[...document.querySelectorAll("button")].find(b=>b.textContent==="Start party").click()',
  );
  await state('s.vote?.target===0 && document.querySelectorAll(".bp-vote-course").length===3');
  assert.equal(
    await client.evalJS('document.querySelector(".bp-course-vote h3").textContent'),
    'Vote for hole 1',
  );
  assert.equal(await client.evalJS('document.body.innerText.includes("Hole 1 of 2 done")'), false);
  // Scene fallback: while the opening ballot is up, no candidate course has been
  // chosen, so the route keeps the neutral lobby level instead of showing an
  // empty or stale course. The ballot must not wait for a candidate to load.
  const fallback = await client.evalJS(
    '(async()=>{const g=(' +
      runtime +
      ').m.state;return {level:g.level?.id??null,phase:g.phase}})()',
  );
  assert(fallback.level !== null, 'the ballot must be shown over a real scene rather than nothing');
  assert.equal(
    await client.evalJS('!!document.querySelector(".bp-party-loading")'),
    false,
    'the ballot must not be hidden behind the loading screen',
  );
  console.log('PASS opening ballot keeps the neutral scene and never blocks on a candidate');
  const first = await client.evalJS('(async()=>(' + runtime + ').E.state.vote.choices[2].id)()');
  await client.evalJS('document.querySelectorAll(".bp-vote-course")[2].click()');
  await waitFor(
    client,
    'document.querySelectorAll(".bp-vote-course")[2].getAttribute("aria-pressed")==="true"',
  );
  send({ t: 'course-vote', voteId: snapshot.vote.id, courseId: first });
  await waitFor(
    client,
    'document.querySelectorAll(".bp-vote-tally")[2].textContent.includes("2 votes")',
  );
  console.log('PASS opening ballot before first hole');
  await state('s.phase==="playing"&&!!document.querySelector(".bp-hole-clock")');
  assert.equal(await client.evalJS('(async()=>(' + runtime + ').E.state.holeIds[0])()'), first);
  const initial = await client.evalJS('document.querySelector(".bp-hole-clock").textContent');
  await pause(500);
  assert.notEqual(
    await client.evalJS('document.querySelector(".bp-hole-clock").textContent'),
    initial,
  );
  // Inject a completed local attempt into the real game store. The production
  // transport must report it and the server, not this fixture, records the time.
  const finish = () =>
    client.evalJS(
      '(async()=>{const r=' +
        runtime +
        ';r.m.setState(g=>({...g,phase:"holed",strokes:2,result:{strokes:2,par:g.level.par,levelId:g.level.id,card:"rg",path:[],restarts:0}}))})()',
    );
  await finish();
  await state('s.board.standings.find(p=>p.uid===s.self.uid)?.holeTimeMs!=null');
  const frozen = await client.evalJS('document.querySelector(".bp-hole-clock").textContent');
  await pause(500);
  assert.equal(await client.evalJS('document.querySelector(".bp-hole-clock").textContent'), frozen);
  send({
    f: 1,
    s: 2,
    p: snapshot.currentMap.par,
    matchId: snapshot.matchId,
    holeIndex: snapshot.holeIndex,
  });
  await state(
    's.vote?.choices?.length===3 && document.querySelectorAll(".bp-vote-course").length===3',
  );
  const target = await client.evalJS('(async()=>(' + runtime + ').E.state.vote.choices[1].id)()');
  await client.evalJS('document.querySelectorAll(".bp-vote-course")[1].click()');
  await waitFor(
    client,
    'document.querySelectorAll(".bp-vote-course")[1].getAttribute("aria-pressed")==="true"',
  );
  send({ t: 'course-vote', voteId: snapshot.vote.id, courseId: target });
  await waitFor(
    client,
    'document.querySelectorAll(".bp-vote-tally")[1].textContent.includes("2 votes")',
  );
  console.log(
    'PASS timer counts up and freezes; three ballot choices, selected state and live tallies',
  );
  await state('s.phase==="playing"&&s.holeIndex===1', 40000);
  assert.equal(await client.evalJS('(async()=>(' + runtime + ').E.state.holeIds[1])()'), target);
  await finish();
  await state('s.board.standings.find(p=>p.uid===s.self.uid)?.holeTimeMs!=null');
  send({
    f: 1,
    s: 2,
    p: snapshot.currentMap.par,
    matchId: snapshot.matchId,
    holeIndex: snapshot.holeIndex,
  });
  await state('s.phase==="final"');
  await waitFor(
    client,
    '[...document.querySelectorAll("button")].some(b=>b.textContent==="Scorecard")',
  );
  await client.evalJS(
    '[...document.querySelectorAll("button")].find(b=>b.textContent==="Scorecard").click()',
  );
  await waitFor(client, 'document.querySelectorAll(".bp-cell-time").length===6');
  assert.equal(client.events.filter((event) => event.type === 'exception').length, 0);
  console.log(
    'PASS winning course loads, per-hole times recorded in final scorecard, no browser exceptions',
  );
} finally {
  guest?.close();
  client.close();
}
