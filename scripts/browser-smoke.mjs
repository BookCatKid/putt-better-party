import { connect, waitFor } from './cdp.mjs';
const base = 'http://127.0.0.1:8789',
  debug = 'http://127.0.0.1:9239';
const targets = await fetch(debug + '/json/list').then((r) => r.json());
const c = await connect(targets.find((t) => t.type === 'page'));
const join = async (c, name) => {
  await waitFor(c, '!!document.querySelector("input")');
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
  await waitFor(c, 'document.body.innerText.includes("Party lobby")', 45000);
};
try {
  await c.call('Page.navigate', { url: base + '/home' });
  await waitFor(c, '!!document.querySelector("#create")');
  await c.evalJS('document.querySelector("#create").click()');
  await waitFor(c, 'location.pathname.startsWith("/party/")');
  console.log('Room', await c.evalJS('location.pathname'));
  await join(c, 'Alice');
  console.log('Host body', await c.evalJS('document.body.innerText'));
  console.log('Canvas', await c.evalJS('document.querySelectorAll("canvas").length'));
  console.log('Events', JSON.stringify(c.events.slice(-30)));
  const url = await c.evalJS('location.href');
  const target = await fetch(debug + '/json/new?' + encodeURIComponent(url), {
    method: 'PUT',
  }).then((r) => r.json());
  const d = await connect(target);
  try {
    await join(d, 'Bob');
    await waitFor(c, 'document.body.innerText.includes("Bob")');
    console.log('Two-player lobby', await c.evalJS('document.body.innerText'));
    console.log('Guest lobby', await d.evalJS('document.body.innerText'));
    console.log('Guest events', JSON.stringify(d.events.slice(-25)));
  } finally {
    d.close();
  }
} finally {
  console.log('Host diagnostics', JSON.stringify(c.events.slice(-30)));
  c.close();
}
