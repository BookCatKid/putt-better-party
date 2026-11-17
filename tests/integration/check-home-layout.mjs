import { connect, waitFor } from './cdp.mjs';
import assert from 'node:assert/strict';
const base = process.env.BASE || 'http://127.0.0.1:8789';
const client = await connect(
  (await fetch('http://127.0.0.1:9239/json/list').then((response) => response.json())).find(
    (target) => target.type === 'page',
  ),
);
try {
  for (const [width, height] of [
    [1100, 700],
    [390, 844],
    [320, 568],
  ]) {
    await client.call('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await client.call('Page.navigate', { url: base + '/home' });
    await waitFor(client, 'typeof document.querySelector("#create")?.onclick==="function"');
    const response = await client.evalJS(
      '(()=>{const box=s=>document.querySelector(s).getBoundingClientRect().toJSON(),h=box("h1"),a=box("#create"),b=box(".bp-separator"),f=box("#join");return {headingGap:a.top-h.bottom,aboveDivider:b.top-a.bottom,belowDivider:f.top-b.bottom,buttonHeight:a.height,buttonWeight:getComputedStyle(document.querySelector("#create")).fontWeight,overflow:document.documentElement.scrollWidth>innerWidth,center:Math.round(a.x+a.width/2),window:innerWidth}})()',
    );
    console.log('Measured', width, height, response);
    assert(response.headingGap >= 36);
    assert(response.aboveDivider >= 22);
    assert(response.belowDivider >= 22);
    assert(response.buttonHeight >= 56);
    assert(!response.overflow);
    assert(Math.abs(response.center - response.window / 2) <= 1);
    console.log('PASS', width, height, response);
  }
  assert.equal(client.events.filter((event) => event.type === 'exception').length, 0);
} finally {
  client.close();
}
