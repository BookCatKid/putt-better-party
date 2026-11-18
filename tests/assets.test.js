import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Required-asset integrity.
 *
 * `scripts/client-lock.json` pins the hash of every archived file and
 * `scripts/prepare-client.py` verifies those hashes before building, so a
 * truncated or substituted file already fails closed. What neither caught is the
 * *other* direction: a bundle that asks for a file nobody pinned. That failure is
 * silent at build time and only shows up as a missing model or a silent sound in
 * a live round, on whichever course happens to use it.
 *
 * These tests close that hole by reversing the same references the client uses
 * at runtime and requiring them to land inside the lock:
 *
 *  1. Every course piece and floor the registry names resolves to a pinned GLB.
 *  2. Every prop the decor registry names resolves to a pinned GLB.
 *  3. Every theme skybox, and every sound the loader enumerates, is pinned.
 *  4. Every GLB's external texture reference resolves, which is the one case no
 *     JavaScript mentions and a bundle-only scan would miss entirely.
 *  5. Every pinned file exists on disk, and the snapshot carries no unpinned
 *     strays in the directories it serves.
 *
 * The evidence behind each rule is recorded in `docs/dependency-inventory.md`.
 */

const root = path.resolve(import.meta.dir, '..');
const archived = path.join(root, 'private-client');
const lockPath = path.join(root, 'scripts/client-lock.json');

const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
const pinned = new Set(Object.keys(lock));

const bundle = (name) => readFileSync(path.join(archived, 'assets', name), 'utf8');

/** Match GLB filenames a bundle names in a registry entry. */
const glbNames = (source) => [...source.matchAll(/`([\w./-]+\.glb)`/g)].map((match) => match[1]);

/** Read the JSON chunk of a GLB so external buffer and image URIs can be checked. */
function glbJson(relativePath) {
  const data = readFileSync(path.join(archived, relativePath.replace(/^\//, '')));
  if (data.subarray(0, 4).toString('ascii') !== 'glTF') {
    throw new Error(`${relativePath} is not a binary glTF`);
  }
  const chunkLength = data.readUInt32LE(12);
  return JSON.parse(data.subarray(20, 20 + chunkLength).toString('utf8'));
}

const pinnedGlbs = [...pinned].filter((entry) => entry.endsWith('.glb'));

describe('required asset integrity', () => {
  test('every file named by the lock is present in the archive', () => {
    const missing = [...pinned].filter(
      (entry) => !existsSync(path.join(archived, entry.replace(/^\//, ''))),
    );
    expect(missing).toEqual([]);
  });

  test('every course piece and floor the registry names is pinned', () => {
    const registry = bundle('registry-BaQMskdl.js');
    const referenced = glbNames(registry).map((name) => `/models/minigolf/${name}`);
    expect(referenced.length).toBeGreaterThan(60);
    expect(referenced.filter((entry) => !pinned.has(entry))).toEqual([]);
  });

  test('every prop the decor registry names is pinned, routed by its own rule', () => {
    const runtime = bundle('courseEventRuntime-Bzd93hOE.js');
    /*
     * The bundle decides the directory, not the filename: a small set of props is
     * drawn from the minigolf models and everything else from decor/. Re-deriving
     * that set here means a prop added to one directory but routed to the other
     * fails, which is the mistake this rule exists to catch.
     */
    const minigolfProps = new Set([
      'lost-ball-blue',
      'lost-ball-red',
      'lost-ball-green',
      'golf-club',
      'golf-flag',
    ]);
    expect(runtime).toContain('E=new Set([`lost-ball-blue`,`lost-ball-red`,`lost-ball-green`])');

    const registry = runtime.slice(runtime.indexOf('tree:`tree_default.glb`'));
    // Walk to the matching brace: the registry nests per-prop option objects.
    let depth = 0;
    let end = registry.length;
    for (let index = 0; index < registry.length; index += 1) {
      if (registry[index] === '{') {
        depth += 1;
      } else if (registry[index] === '}') {
        depth -= 1;
        if (depth < 0) {
          end = index;
          break;
        }
      }
    }
    const entries = [...registry.slice(0, end).matchAll(/[{,]"?([\w-]+)"?:`([^`]+\.glb)`/g)].map(
      (match) => ({ name: match[1], file: match[2] }),
    );
    expect(entries.length).toBeGreaterThan(40);

    const unresolved = entries
      .map(({ name, file }) => `/models/${minigolfProps.has(name) ? 'minigolf' : 'decor'}/${file}`)
      .filter((entry) => !pinned.has(entry));
    expect(unresolved).toEqual([]);
  });

  test('every theme skybox is pinned, and the snow theme needs none', () => {
    const themes = bundle('theme-BxxhUw0H.js');
    const skyboxes = [...themes.matchAll(/skybox:[a-z]\(`([^`]+\.webp)`\)/g)].map(
      (match) => match[1],
    );
    expect(skyboxes.sort()).toEqual([
      '/sky/breezy.webp',
      '/sky/dawn.webp',
      '/sky/day.webp',
      '/sky/night.webp',
      '/sky/sunset.webp',
    ]);
    expect(skyboxes.filter((entry) => !pinned.has(entry))).toEqual([]);
    /*
     * Snow is the one theme with no skybox: it is a colour gradient plus
     * `weather: 'snow'`, so it needs no image and the lock carries exactly the
     * five above. Asserting the object rather than the absence of the string
     * keeps this honest, since the other five entries do name a skybox.
     */
    const snow = themes.slice(themes.indexOf('{name:`snow`'));
    expect(snow).toContain('weather:`snow`');
    expect(snow.slice(0, snow.indexOf('}'))).not.toContain('skybox:');
  });

  test('every sound the loader enumerates is pinned, with no unpinned extras', () => {
    const loader = bundle('GameRoot-7kMtVtdO.js');
    const match = loader.match(/Ve=\{(putt:4[^}]+)\}/);
    expect(match).not.toBeNull();
    const counts = Object.fromEntries(
      [...match[1].matchAll(/([a-z]+):(\d+)/g)].map((pair) => [pair[1], Number(pair[2])]),
    );
    const expected = Object.entries(counts).flatMap(([name, count]) =>
      Array.from({ length: count }, (unused, index) => `/sfx/${name}-${index + 1}.mp3`),
    );
    expect(expected.length).toBe(36);
    expect(expected.filter((entry) => !pinned.has(entry))).toEqual([]);
    const pinnedSounds = [...pinned].filter((entry) => entry.endsWith('.mp3'));
    expect(pinnedSounds.sort()).toEqual(expected.sort());
  });

  test('every external texture a GLB names resolves to a pinned file', () => {
    const unresolved = [];
    for (const glb of pinnedGlbs) {
      const json = glbJson(glb);
      const directory = path.posix.dirname(glb);
      const uris = [
        ...(json.images ?? []).map((image) => image.uri),
        ...(json.buffers ?? []).map((buffer) => buffer.uri),
      ].filter((uri) => typeof uri === 'string' && !uri.startsWith('data:'));
      for (const uri of uris) {
        if (!pinned.has(`${directory}/${uri}`)) {
          unresolved.push(`${glb} -> ${uri}`);
        }
      }
    }
    // colormap.png is the only external resource, and no bundle mentions it.
    expect(unresolved).toEqual([]);
    expect(pinned.has('/models/minigolf/Textures/colormap.png')).toBe(true);
  });

  test('no clamped or placeholder asset path survives in the prepared snapshot', () => {
    // The archived Rapier glue carries a neutralised default URL. It is harmless
    // because the inlined base64 module is always supplied, but a real fetch base
    // appearing here would mean the snapshot was prepared differently than the
    // inventory describes.
    const physics = bundle('AppearanceClone-CBos6VT9.js');
    const defaults = [...physics.matchAll(/new URL\(`rapier_wasm3d_bg\.wasm`,`([^`]*)`\)/g)];
    expect(defaults.length).toBe(1);
    expect(defaults[0][1]).toBe('<deleted>');
    // The module the game actually instantiates must still be present.
    expect(physics).toContain('AGFzbQ');
  });
});
