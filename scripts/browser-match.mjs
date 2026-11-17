import { connect, waitFor, pause } from './cdp.mjs';
const base = process.env.BASE || 'http://127.0.0.1:8789',
  debug = 'http://127.0.0.1:9239';
const targets = await fetch(debug + '/json/list').then((r) => r.json());
const host = await connect(targets.find((t) => t.type === 'page'));
let guest;
const state = '(await import("/assets/runtime-DL2fiDAQ.js")).E.state';
const game = '(await import("/assets/runtime-DL2fiDAQ.js")).m.state';
const read = async (c) =>
  c.evalJS(
    `(async()=>{const s=${state},g=${game};return {phase:s.phase,host:s.isHost,count:s.count,mapReady:s.mapReady,map:s.currentMap?.name,ids:s.holeIds,level:g.level?.name,strokes:g.strokes,gamePhase:g.phase,canvas:document.querySelectorAll("canvas").length,error:s.error}})()`,
  );
const expect = async (c, cond, ms = 30000) =>
  waitFor(c, `(async()=>{const s=${state},g=${game};return (${cond})})()`, ms);
const join = async (c, name) => {
  await waitFor(c, '!!document.querySelector("input[placeholder=\\"Your name\\"]")');
  await c.evalJS(
    `(()=>{let x=document.querySelector("input");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(x,${JSON.stringify(name)});x.dispatchEvent(new Event("input",{bubbles:true}));})()`,
  );
  await waitFor(
    c,
    '!![...document.querySelectorAll("button")].find(x=>x.textContent==="Join"&&!x.disabled)',
  );
  await c.evalJS(
    '[...document.querySelectorAll("button")].find(x=>x.textContent==="Join").click()',
  );
  await expect(c, 's.roster.length>0 && s.mapReady && !!g.level', 45000);
};
try {
  await host.call('Page.navigate', { url: base + '/home' });
  await waitFor(host, '!!document.querySelector("#create")');
  await host.evalJS('document.querySelector("#create").click()');
  await waitFor(host, 'location.pathname.startsWith("/party/")');
  await join(host, 'Host');
  await expect(host, 's.isHost');
  const url = await host.evalJS('location.href');
  console.log('Room', url, 'host', await read(host));
  const target = await fetch(debug + '/json/new?' + encodeURIComponent(url), {
    method: 'PUT',
  }).then((r) => r.json());
  guest = await connect(target);
  await join(guest, 'Guest');
  await expect(host, 's.roster.length===2');
  console.log('Two browser clients', await read(host), await read(guest));
  await host.evalJS(
    `(()=>{let x=document.querySelector("select[aria-label='Party map selection']");x.value="picked";x.dispatchEvent(new Event("change",{bubbles:true}));})()`,
  );
  await waitFor(
    host,
    '!!document.querySelector("button[aria-label=\\"Add Titling At Windmills\\"]")',
    25000,
  );
  await host.evalJS(
    'document.querySelector("button[aria-label=\\"Add Titling At Windmills\\"]").click()',
  );
  await expect(host, 's.config.selectedHoleIds?.length===1');
  await host.evalJS(
    '[...document.querySelectorAll("button")].find(b=>b.getAttribute("aria-label")?.startsWith("Add ")).click()',
  );
  await expect(host, 's.config.selectedHoleIds?.length===2');
  console.log(
    'Selected live public map',
    await host.evalJS(`(async()=>{const s=${state};return s.config})()`),
  );
  await host.evalJS(
    '(async()=>{(await import("/assets/runtime-DL2fiDAQ.js")).D({timerMs:20000,elimination:false})})()',
  );
  await expect(host, 's.config.timerMs===20000');
  await host.evalJS(
    '[...document.querySelectorAll("button")].find(x=>x.textContent==="Start party").click()',
  );
  await expect(host, 's.phase==="countdown" && s.currentMap?.name==="Titling At Windmills"');
  await expect(guest, 's.phase==="countdown"||s.phase==="playing"');
  console.log('Countdown', await read(host), await read(guest));
  await expect(
    guest,
    's.phase==="playing"&&s.mapReady&&g.level?.name==="Titling At Windmills"&&document.querySelectorAll("canvas").length>0',
    30000,
  );
  await expect(
    host,
    's.phase==="playing"&&s.mapReady&&g.level?.name==="Titling At Windmills"&&document.querySelectorAll("canvas").length>0',
    30000,
  );
  console.log(
    'Original engine loaded public course in both browsers',
    await read(host),
    await read(guest),
  );
  if (guest) {
    await guest.call('Page.bringToFront');
    // Real mouse drag through the original input handlers; no score or game-state injection.
    const rect = await guest.evalJS(
      '(()=>{const b=document.querySelector("canvas").getBoundingClientRect();return {x:b.x+b.width*.5,y:b.y+b.height*.6}})()',
    );
    await guest.call('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: rect.x,
      y: rect.y,
      button: 'left',
      clickCount: 1,
    });
    await guest.call('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: rect.x,
      y: rect.y + 120,
      button: 'left',
      buttons: 1,
    });
    await pause(100);
    await guest.call('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: rect.x,
      y: rect.y + 120,
      button: 'left',
      clickCount: 1,
    });
    console.log('After actual pointer drag', await read(guest));
  }
  async function giveUp(c) {
    await c.call('Page.bringToFront');
    await waitFor(
      c,
      '!![...document.querySelectorAll("button")].find(x=>x.textContent==="Give up")',
      10000,
    );
    await c.evalJS(
      '[...document.querySelectorAll("button")].find(x=>x.textContent==="Give up").click()',
    );
    await c.evalJS(
      '[...document.querySelectorAll("button")].find(x=>x.textContent==="Yes").click()',
    );
  }
  // Use only original UI controls; no synthetic score or state injection.
  await giveUp(guest);
  await giveUp(host);
  await expect(host, 's.holeIndex===1&&s.phase==="playing"&&s.mapReady', 30000);
  await expect(guest, 's.holeIndex===1&&s.phase==="playing"&&s.mapReady', 30000);
  console.log('Both clients loaded second hole', await read(host), await read(guest));
  await giveUp(guest);
  await giveUp(host);
  await expect(host, 's.phase==="final"', 15000);
  await expect(guest, 's.phase==="final"', 15000);
  await waitFor(host, 'document.body.innerText.includes("Party over")');
  await waitFor(guest, 'document.body.innerText.includes("Party over")');
  console.log('Final host', await host.evalJS('document.body.innerText'));
  console.log('Final guest', await guest.evalJS('document.body.innerText'));
  await host.evalJS(
    '[...document.querySelectorAll("button")].find(x=>x.textContent.toLowerCase().includes("back to lobby")).click()',
  );
  await expect(host, 's.phase==="lobby"');
  await expect(guest, 's.phase==="lobby"');
  console.log(
    'PASS two-player, two-hole public playlist, actual input, give-up, final results, back to lobby',
  );
} finally {
  for (const [label, c] of [
    ['Host', host],
    ['Guest', guest],
  ])
    if (c) {
      console.log(label + ' events', JSON.stringify(c.events.slice(-50)));
      console.log(
        label + ' external network requests',
        JSON.stringify(
          [...c.requests.values()].filter(
            (url) =>
              url && !url.startsWith(base) && !url.startsWith('data:') && !url.startsWith('blob:'),
          ),
        ),
      );
      c.close();
    }
}
