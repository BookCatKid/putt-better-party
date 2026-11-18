import assert from 'node:assert/strict';
import { connect, waitFor } from './cdp.mjs';

const base = process.env.BASE || 'http://127.0.0.1:8789';
const debugging = 'http://127.0.0.1:' + (process.env.BP_DEBUG_PORT || '9239');
const client = await connect(
  (await fetch(debugging + '/json/list').then((response) => response.json())).find(
    (target) => target.type === 'page',
  ),
);
const runtime = '(await import("/assets/runtime-DL2fiDAQ.js"))';
const state = (condition) =>
  waitFor(
    client,
    '(async()=>{const r=' +
      runtime +
      ',s=r.E.state;return (' +
      condition +
      ')&&!document.querySelector(".bp-party-loading")})()',
    45000,
  );
const clickText = (title) =>
  client.evalJS(
    '[...document.querySelectorAll("button")].find(b=>b.textContent===' +
      JSON.stringify(title) +
      ').click()',
  );
const input = async (selector, value) => {
  await client.evalJS(
    '(()=>{const el=document.querySelector(' +
      JSON.stringify(selector) +
      ');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(el,' +
      JSON.stringify(value) +
      ');el.dispatchEvent(new Event("input",{bubbles:true}))})()',
  );
};
const post = async (path, body) => {
  const response = await fetch(base + path, {
    method: 'POST',
    headers: { origin: base, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert(response.ok, String(response.status));
  return response.json();
};
let host;
try {
  await client.call('Page.navigate', { url: base + '/home' });
  await waitFor(client, 'typeof document.querySelector("#create")?.onclick==="function"');
  await client.evalJS('document.querySelector("#create").click()');
  await waitFor(client, 'document.querySelector("input")?.placeholder==="Your name"');
  await input('input', 'Generator host');
  await clickText('Join');
  await state('s.isHost&&s.bpConnected&&s.mapReady');
  await client.evalJS(
    '(()=>{const el=document.querySelector(\'select[aria-label="Party map selection"]\');el.value="picked";el.dispatchEvent(new Event("change",{bubbles:true}))})()',
  );
  await state('s.config.mapSource==="picked"');
  await waitFor(
    client,
    '[...document.querySelectorAll("button")].some(b=>b.textContent==="Auto-generate playlist")',
  );
  await clickText('Auto-generate playlist');
  await input('input[aria-label="Average rating min"]', '4');
  await input('input[aria-label="Average strokes max"]', '5');
  await input('input[aria-label="Par max"]', '4');
  await clickText('At or below par');
  await clickText('Generate & replace');
  await state('s.config.selectedHoleIds.length===2');
  assert.deepEqual(
    await client.evalJS('(async()=>(' + runtime + ').E.state.config.selectedHoleIds)()'),
    ['fixture-one', 'fixture-three'],
  );
  await waitFor(
    client,
    'document.querySelector(".bp-generator [role=status]").textContent.includes("2 matching courses")',
  );
  console.log('PASS compound generator filters populate the real host playlist');
  await client.call('Page.navigate', { url: base + '/home' });

  // Run an independent random party using actual WebSocket completion frames.
  // The fixture is isolated; no public leaderboard or upstream party is touched.
  const party = await post('/api/create', {});
  const identity = await post('/api/join', { code: party.code, name: 'Leaderboard probe' });
  host = new WebSocket(base.replace('http', 'ws') + '/ws/party/' + party.code, {
    headers: { origin: base },
  });
  let snapshot;
  host.onmessage = (event) => {
    const frame = JSON.parse(event.data);
    if (frame.t === 'party') {
      snapshot = frame;
    }
  };
  await new Promise((resolve, reject) => {
    host.onopen = resolve;
    host.onerror = reject;
  });
  const send = (body) => host.send(JSON.stringify(body));
  const expectSnapshot = async (condition) => {
    for (let attempt = 0; attempt < 400; attempt++) {
      if (snapshot && condition(snapshot)) {
        return;
      }
      await Bun.sleep(25);
    }
    throw Error('Missing expected snapshot');
  };
  send({
    t: 'join',
    ...identity,
    host: party.hostToken,
    protocol: 2,
    instance: 'leaderboard-probe',
  });
  await expectSnapshot((frame) => frame.phase === 'lobby');
  send({ t: 'config', config: { holes: 1, elimination: false } });
  await expectSnapshot((frame) => frame.config.holes === 1);
  send({ t: 'start' });
  await expectSnapshot((frame) => frame.phase === 'playing');
  send({ f: 1, s: 7, p: snapshot.currentMap.par, matchId: snapshot.matchId, holeIndex: 0 });
  await expectSnapshot((frame) => frame.phase === 'final');
  const result = await fetch(base + '/api/leaderboard?holes=1').then((response) => response.json());
  assert.equal(result.rows.find((score) => score.name === 'Leaderboard probe').strokes, 7);
  await client.call('Page.navigate', { url: base + '/leaderboard' });
  await waitFor(client, '!!document.querySelector(\'button[aria-label="1 hole"]\')');
  await client.evalJS('document.querySelector(\'button[aria-label="1 hole"]\').click()');
  await waitFor(
    client,
    'document.querySelector("#scores").textContent.includes("Leaderboard probe")',
  );
  await input('#search', 'Leaderboard probe');
  await waitFor(client, 'document.querySelector("#scores").children.length===1');
  assert.equal(
    await client.evalJS('document.querySelector("#scores tr td:nth-child(3)").textContent'),
    '7',
  );
  assert.equal(client.events.filter((event) => event.type === 'exception').length, 0);
  console.log(
    'PASS finalization records random match, leaderboard page renders and filters by hole count and player',
  );
} finally {
  host?.close();
  client.close();
}
