import { connect, waitFor } from './cdp.mjs';
import assert from 'node:assert/strict';
const base = process.env.BASE || 'http://127.0.0.1:8789';
const c = await connect(
  (await fetch('http://127.0.0.1:9239/json/list').then((r) => r.json())).find(
    (t) => t.type === 'page',
  ),
);
try {
  for (const [width, height] of [
    [1100, 700],
    [390, 844],
    [320, 568],
  ]) {
    await c.call('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await c.call('Page.navigate', { url: base + '/home' });
    await waitFor(c, 'typeof document.querySelector("#create")?.onclick==="function"');
    const r = await c.evalJS(
      '(()=>{const box=s=>document.querySelector(s).getBoundingClientRect().toJSON(),h=box("h1"),a=box("#create"),b=box(".bp-separator"),f=box("#join");return {headingGap:a.top-h.bottom,aboveDivider:b.top-a.bottom,belowDivider:f.top-b.bottom,buttonHeight:a.height,buttonWeight:getComputedStyle(document.querySelector("#create")).fontWeight,overflow:document.documentElement.scrollWidth>innerWidth,center:Math.round(a.x+a.width/2),window:innerWidth}})()',
    );
    console.log('Measured', width, height, r);
    assert(r.headingGap >= 36);
    assert(r.aboveDivider >= 22);
    assert(r.belowDivider >= 22);
    assert(r.buttonHeight >= 56);
    assert(!r.overflow);
    assert(Math.abs(r.center - r.window / 2) <= 1);
    console.log('PASS', width, height, r);
  }
  assert.equal(c.events.filter((e) => e.type === 'exception').length, 0);
} finally {
  c.close();
}
