import assert from 'node:assert/strict';
import { connect, waitFor } from './cdp.mjs';

const base = process.env.BASE || 'http://127.0.0.1:8789';
const debug = process.env.DEBUG_URL || 'http://127.0.0.1:9239';
const runtime = '(await import("/assets/runtime-DL2fiDAQ.js"))';
const client = await connect(
  (await fetch(debug + '/json/list').then((response) => response.json())).find(
    (target) => target.type === 'page',
  ),
);
let remote;
const state = (condition) =>
  waitFor(
    client,
    `(async()=>{const s=${runtime}.E.state;return (${condition})&&!document.querySelector(".bp-party-loading")})()`,
    45000,
  );
const click = (label) =>
  client.evalJS(
    `[...document.querySelectorAll("button")].find(b=>b.textContent===${JSON.stringify(label)}||b.getAttribute("aria-label")===${JSON.stringify(label)}).click()`,
  );
const post = async (path, data) => {
  const response = await fetch(base + path, {
    method: 'POST',
    headers: { origin: base, 'content-type': 'application/json' },
    body: JSON.stringify(data),
  });
  const result = await response.json();
  assert(response.ok, JSON.stringify(result));
  return result;
};
try {
  await client.call('Page.navigate', { url: base + '/home' });
  await waitFor(client, 'typeof document.querySelector("#create")?.onclick==="function"');
  await client.evalJS('document.querySelector("#create").click()');
  await waitFor(client, 'document.querySelectorAll(".bp-ball-swatch").length===15');
  for (const width of [375, 1280]) {
    await client.call('Emulation.setDeviceMetricsOverride', {
      width,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const sizes = await client.evalJS(
      '[...document.querySelectorAll(".bp-ball-swatch")].map(button=>{const rect=button.getBoundingClientRect();return {width:rect.width,height:rect.height,left:rect.left,right:rect.right}})',
    );
    assert(
      sizes.every(
        (size) =>
          Math.abs(size.width - size.height) < 0.1 &&
          size.width === 36 &&
          size.left >= 0 &&
          size.right <= width,
      ),
      JSON.stringify(sizes),
    );
  }
  await client.call('Emulation.clearDeviceMetricsOverride');
  console.log('PASS circular ball swatches at mobile and desktop widths');

  assert.equal(
    await client.evalJS(
      'document.querySelector("[aria-label=Classic]").getAttribute("aria-pressed")',
    ),
    'true',
  );
  await click('Galaxy');
  await waitFor(
    client,
    'document.querySelector("[aria-label=Galaxy]").getAttribute("aria-pressed")==="true"',
  );
  await click('Custom');
  await client.evalJS(
    `(()=>{const input=document.querySelector('[aria-label="Custom ball color"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,"#123456");input.dispatchEvent(new Event("input",{bubbles:true}));input.dispatchEvent(new Event("change",{bubbles:true}))})()`,
  );
  await waitFor(
    client,
    'document.querySelector(".bp-ball-selection").textContent.includes("#123456")',
  );
  await client.evalJS(
    `(()=>{const input=document.querySelector('[aria-label="Your name"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,"Custom player");input.dispatchEvent(new Event("input",{bubbles:true}))})()`,
  );
  await click('Join');
  await state(
    's.isHost&&s.mapReady&&s.roster.find(p=>p.uid===s.self.uid)?.ball?.color==="#123456"',
  );
  const code = await client.evalJS(`(async()=>${runtime}.E.state.code)()`);
  const identity = await post('/api/join', { code, name: 'Animated', ball: { key: 'ball-fire' } });
  remote = new WebSocket(base.replace('http', 'ws') + '/ws/party/' + code, {
    headers: { origin: base },
  });
  let snapshot;
  let roster;
  remote.onmessage = (event) => {
    const frame = JSON.parse(event.data);
    if (frame.t === 'party') {
      snapshot = frame;
    }
    if (frame.t === 'roster') {
      roster = frame.players;
    }
  };
  await new Promise((resolve, reject) => {
    remote.onopen = resolve;
    remote.onerror = reject;
  });
  remote.send(JSON.stringify({ t: 'join', protocol: 2, ...identity }));
  await state('s.roster.some(p=>p.name==="Animated"&&p.ball.key==="ball-fire")');
  // Observe the original Three.js rendering call. It exposes the actual
  // rendered scene, not a substitute mesh or synthetic shader.
  await client.evalJS(
    `(async()=>{const three=await import("/assets/three.module-DJ81ilGZ.js");const proto=three.mt.prototype;const original=proto.updateMatrixWorld;proto.updateMatrixWorld=function(...args){if(this.isScene)window.bpTestScene=this;return original.apply(this,args)}})()`,
  );
  await client.evalJS(
    `(async()=>{const r=${runtime};r.D({holes:1,timerMs:120000,elimination:false})})()`,
  );
  await state('s.config.holes===1&&!s.config.elimination');
  await click('Start party');
  await state('s.phase==="playing"&&s.mapReady');
  const remoteId = roster.find((player) => player.uid === identity.uid).id;
  const position = await client.evalJS(`(async()=>${runtime}.r.ballPos.toArray())()`);
  remote.send(
    JSON.stringify({
      x: position[0] + 0.5,
      y: position[1],
      z: position[2],
      px: position[0],
      pz: position[2],
      c: 0,
      m: 0,
      matchId: snapshot.matchId,
      holeIndex: snapshot.holeIndex,
    }),
  );
  await waitFor(
    client,
    `(async()=>{const presence=await import("/assets/presence-GRnSPemt.js");return presence.i.get(${JSON.stringify(remoteId)})?.ballEffect==="fire"})()`,
  );
  await waitFor(
    client,
    `(()=>{let solid=false,shader=false;window.bpTestScene?.traverse(mesh=>{if(!mesh.isMesh)return;const material=mesh.material;if(material?.color?.getHexString()==="123456")solid=true;if(material?.isShaderMaterial&&material.uniforms?.uAlpha?.value===.7)shader=true});return solid&&shader})()`,
  );
  console.log(
    'PASS original 15-swatches picker, custom RGB material and actual remote animated shader',
  );
  assert.equal(client.events.filter((event) => event.type === 'exception').length, 0);
} finally {
  remote?.close();
  console.log(
    'Browser exceptions',
    client.events
      .filter((event) => event.type === 'exception' || event.type === 'crash')
      .slice(-10),
  );
  client.close();
}
