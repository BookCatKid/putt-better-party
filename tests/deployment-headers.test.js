import { test, expect } from 'bun:test';
import { deploymentHeaders, withDeploymentHeaders } from '../src/deployment-headers.js';

/**
 * Deployment headers.
 *
 * These are the difference between a service that is merely reachable and one
 * that is safe to put behind TLS: transport security, a frame policy, and the
 * set of browser capabilities the page is allowed to ask for. Each assertion
 * below exists because getting it wrong fails silently — a header that is absent
 * or sent in the wrong deployment looks identical to one that works.
 */

test('an HTTPS deployment asks browsers to stay on HTTPS for a year', () => {
  const headers = deploymentHeaders({ https: true });
  expect(headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
});

test('a plain-HTTP run sends no HSTS header at all', () => {
  const headers = deploymentHeaders({ https: false });
  // A local run is HTTP on loopback. A browser that pinned that host to HTTPS
  // would then refuse the next plain request outright, before it hit the network,
  // and there would be no way back except clearing the browser's state.
  expect(headers['strict-transport-security']).toBeUndefined();
  expect('strict-transport-security' in headers).toBe(false);
});

test('the page is denied the capabilities the client never uses', () => {
  const policy = deploymentHeaders({ https: false })['permissions-policy'];
  for (const capability of [
    'camera',
    'microphone',
    'geolocation',
    'payment',
    'usb',
    'serial',
    'hid',
    'bluetooth',
    'midi',
  ]) {
    expect(policy).toContain(`${capability}=()`);
  }
});

test('fullscreen and clipboard are left enabled, because the client uses them', () => {
  const policy = deploymentHeaders({ https: false })['permissions-policy'];
  // The fullscreen button calls `requestFullscreen` and the share control calls
  // `navigator.clipboard.writeText`. Denying either would break a working feature
  // in the name of a header, so this test is the guard against a future
  // well-intentioned tightening.
  expect(policy).not.toContain('fullscreen');
  expect(policy).not.toContain('clipboard');
});

test('frames are denied, since nothing may embed the game', () => {
  // The CSP already carries `frame-ancestors 'none'`; this is the older header
  // for browsers that read it instead, and the two must not disagree.
  expect(deploymentHeaders({ https: false })['x-frame-options']).toBe('DENY');
});

test('applying the headers leaves the body, status and existing headers intact', async () => {
  const original = new Response('hello', {
    status: 418,
    headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' },
  });
  const decorated = withDeploymentHeaders(original, { https: true });
  expect(decorated.status).toBe(418);
  expect(decorated.headers.get('content-type')).toBe('text/plain');
  expect(decorated.headers.get('cache-control')).toBe('no-store');
  expect(decorated.headers.get('x-frame-options')).toBe('DENY');
  expect(await decorated.text()).toBe('hello');
});

test('a route that set its own header is not overruled', () => {
  const own = new Response('ok', { headers: { 'x-frame-options': 'SAMEORIGIN' } });
  const decorated = withDeploymentHeaders(own, { https: false });
  // The edge adds what is missing rather than overwriting a deliberate choice.
  expect(decorated.headers.get('x-frame-options')).toBe('SAMEORIGIN');
  // ...but still supplies the ones it did not set.
  expect(decorated.headers.get('permissions-policy')).toContain('camera=()');
});
