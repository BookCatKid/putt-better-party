import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { assetCacheControl } from '../src/request-guards.js';

/**
 * Local static serving: generated assets and server HTML must use matching
 * versions, and the cache policy must match how names relate to bytes.
 */

const root = path.resolve(import.meta.dir, '..');
const lock = JSON.parse(readFileSync(path.join(root, 'scripts/client-lock.json'), 'utf8'));
const routesSource = readFileSync(path.join(root, 'src/http-routes.ts'), 'utf8');

test('the HTML shell only ever references lock-pinned asset names', () => {
  // The party page hardcodes the entry chunk and stylesheet. Both must name a
  // pinned file, or the served HTML and the prepared assets disagree about
  // which build exists — the "matching versions" requirement. Only the `html`
  // literal is checked: authored bp-*.js are served unpinned by design.
  const shell = routesSource.match(/const html =\s*'([\s\S]*?)';/);
  expect(shell).not.toBeNull();
  const referenced = [...shell[1].matchAll(/\/assets\/([\w.-]+\.(?:js|css))/g)].map(
    (match) => match[1],
  );
  expect(referenced.length).toBeGreaterThanOrEqual(2);
  for (const name of referenced) {
    // `toHaveProperty` would parse the `.js` as a path separator; a direct key
    // check avoids the notation entirely.
    expect(Object.hasOwn(lock, `/assets/${name}`), `HTML references unpinned ${name}`).toBe(true);
  }
});

test('content-hash-suffixed bundles are immutable; stable names are not', () => {
  // Name-equals-content: same filename can only hold the same bytes.
  expect(assetCacheControl('/assets/index-DFMxt6BL.js')).toBe(
    'public, max-age=31536000, immutable',
  );
  expect(assetCacheControl('/assets/styles-S28F_fms.css')).toBe(
    'public, max-age=31536000, immutable',
  );
  // Stable names could carry new bytes after an upstream adoption.
  expect(assetCacheControl('/assets/bp-home.js')).toBe('no-store');
  expect(assetCacheControl('/assets/party-route.js')).toBe('no-store');
  expect(assetCacheControl('/models/minigolf/piece-straight.glb')).toBe('no-store');
  expect(assetCacheControl('/sky/day.webp')).toBe('no-store');
  expect(assetCacheControl('/sfx/swish-1.mp3')).toBe('no-store');
  // A suffix-shaped media file still declines immutability: the rule is only
  // safe where the bundler itself guarantees name==content (js/css chunks).
  expect(assetCacheControl('/models/decor/cactus-A1b2C3d4.glb')).toBe('no-store');
});

test('the server never offers a service worker', () => {
  // The pinned submit route calls navigator.serviceWorker.register('/sw.js');
  // as long as this server 404s it, the registration fails into the client's
  // own .catch(()=>{}) and no SW can cache party assets on this origin.
  expect(Object.keys(lock)).not.toContain('/sw.js');
  // And no authored file may register one either.
  for (const name of ['party-entry.js', 'client-bootstrap.js', 'party-route.js']) {
    const authored = readFileSync(path.join(root, 'scripts', name), 'utf8');
    expect(authored, `${name} must not register a service worker`).not.toContain('serviceWorker');
  }
});
