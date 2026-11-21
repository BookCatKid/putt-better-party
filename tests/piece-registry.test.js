/**
 * The piece table in `src/replay/piece-registry.ts` is generated from the
 * pinned client's `registry-*.js`. This test re-derives that map straight from
 * the archived bundle — the same way the table was generated — and asserts
 * every entry agrees, so the table cannot drift from the client it claims to
 * describe.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const clientAssets = path.join(root, 'private-client', 'assets');
const modelDir = path.join(root, 'private-client', 'models', 'minigolf');

/**
 * Evaluate the bundle's `R = { ... }` registry literal with its helper
 * functions stubbed, recovering each entry's fields as plain data. This is the
 * same derivation `piece-registry.ts` was generated from, kept here so the
 * table is checked against the bundle rather than trusted.
 */
function bundleRegistry() {
  const file = readdirSync(clientAssets).find(
    (name) => name.startsWith('registry-') && name.endsWith('.js'),
  );
  const source = readFileSync(path.join(clientAssets, file), 'utf8');
  const start = source.indexOf(',R={') + 3;
  let depth = 0;
  let end = start;
  for (; end < source.length; end += 1) {
    if (source[end] === '{') {
      depth += 1;
    } else if (source[end] === '}') {
      depth -= 1;
      if (depth === 0) {
        break;
      }
    }
  }
  const body = source.slice(start, end + 1);

  // A stub that works as a function, an array, or an object of anything — the
  // socket/footprint fields the entries carry are not needed for the table.
  const makeStub = () => {
    const fn = function () {
      return makeStub();
    };
    return new Proxy(fn, {
      get: (target, property) => {
        if (property === Symbol.iterator) {
          return function* () {};
        }
        if (property === 'length') {
          return 0;
        }
        return makeStub();
      },
      apply: () => makeStub(),
      construct: () => makeStub(),
    });
  };

  const env = {
    P: (glb, extra = {}) => ({ glb, ...extra }),
    F: (glb, sockets) => ({ glb, sockets }),
    L: (entry, label) => ({ ...entry, safetyNet: 'deck', label }),
  };
  let registry;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const names = Object.keys(env);
    try {
      registry = new Function(...names, `return ${body};`)(...names.map((name) => env[name]));
      break;
    } catch (error) {
      const missing =
        /(\w+) is not defined/.exec(String(error.message)) ??
        /(\w+) is not a function/.exec(String(error.message));
      if (!missing) {
        throw error;
      }
      env[missing[1]] = makeStub();
    }
  }
  if (!registry) {
    throw new Error('could not evaluate the bundle registry literal');
  }
  return registry;
}

describe('piece-registry drift guard', () => {
  test('every table entry matches the bundle registry', async () => {
    const { pieceTemplate, pieceNames, NO_SKIRT_PIECES } =
      await import('../src/replay/piece-registry.ts');
    const bundle = bundleRegistry();
    for (const [name, entry] of Object.entries(bundle)) {
      const template = pieceTemplate(name);
      expect(template).not.toBeNull();
      expect(template.glb).toBe(entry.glb);
      expect(template.floorGlb ?? null).toBe(entry.floorGlb ?? null);
      expect(template.lift ?? null).toBe(typeof entry.lift === 'number' ? entry.lift : null);
      expect(!!template.noCollide).toBe(entry.noCollide === true);
      expect(!!template.noSkirt).toBe(entry.skirt === 'none');
      expect(template.safetyNet ?? null).toBe(entry.safetyNet ?? null);
      expect(template.special ?? null).toBe(entry.special ?? null);
    }
    // And the table has no entries the bundle does not know.
    for (const name of pieceNames()) {
      expect(Object.hasOwn(bundle, name)).toBe(true);
    }
    // The three hole pieces are excluded from skirts by the client's own
    // `Re` set, independent of the registry's skirt field.
    for (const name of ['hole-round', 'hole-square', 'hole-open']) {
      expect(NO_SKIRT_PIECES.has(name)).toBe(true);
    }
  });

  test('every referenced model file exists in the archived snapshot', async () => {
    const { pieceTemplate, pieceNames } = await import('../src/replay/piece-registry.ts');
    for (const name of pieceNames()) {
      const template = pieceTemplate(name);
      for (const file of [template.glb, template.floorGlb].filter(Boolean)) {
        const bytes = readFileSync(path.join(modelDir, file));
        // glTF magic — a real model, not an HTML error page saved by mistake.
        expect(bytes.subarray(0, 4).toString('latin1')).toBe('glTF');
      }
    }
  });
});
