import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
  CLIENT_SCRIPTS,
  ClientScriptAssets,
  transpileClientScript,
  transpileClientScripts,
} from '../src/client-scripts.js';

/**
 * The standalone browser scripts are authored as TypeScript.
 *
 * Three pages - the home screen, the leaderboard and the admin dashboard - load
 * their own scripts rather than the pinned client. They were plain `.js` with no
 * type checking at all; they are now `.ts` under the same strict settings as the
 * backend. Browsers cannot run TypeScript, so `src/client-scripts.ts` strips the
 * types at the point of serving.
 *
 * That seam is what these tests pin. If transpilation produced an import the page
 * would break in the browser with no server-side error, and if it kept a type
 * annotation the script would fail to parse - both fail here instead.
 */

const root = path.resolve(import.meta.dir, '..');
const scriptsDirectory = path.join(root, 'scripts');

test('every declared script exists as TypeScript and no stale .js copy remains', () => {
  for (const { source, asset } of CLIENT_SCRIPTS) {
    expect(existsSync(path.join(scriptsDirectory, source))).toBe(true);
    // The generated name must not be checked in: it is produced at serve time, so
    // a committed copy could silently drift from its source.
    expect(existsSync(path.join(scriptsDirectory, asset))).toBe(false);
    expect(source.endsWith('.ts')).toBe(true);
    expect(asset.endsWith('.js')).toBe(true);
  }
});

test('the pages load the scripts as modules', () => {
  // Module loading gives each page its own scope. As classic scripts they shared
  // one global namespace and their helper names collided.
  const pages = [
    ['src/home.html', '/assets/bp-home.js'],
    ['src/leaderboard.html', '/assets/bp-leaderboard.js'],
    ['src/admin.html', '/admin.js'],
  ];
  for (const [page, src] of pages) {
    const markup = readFileSync(path.join(root, page), 'utf8');
    expect(markup).toContain(`<script type="module" src="${src}">`);
    // No non-module tag for the same asset, which would load it twice.
    expect(markup).not.toContain(`<script src="${src}"`);
  }
});

test('transpilation strips the types and keeps the code', async () => {
  const transpiled = await transpileClientScripts(scriptsDirectory);
  expect(transpiled.length).toBe(CLIENT_SCRIPTS.length);
  for (const { asset, javascript } of transpiled) {
    // No TypeScript-only syntax survives.
    expect(javascript).not.toMatch(/\binterface\s+\w+\s*\{/);
    expect(javascript).not.toMatch(/:\s*(string|number|boolean|unknown|void)\b/);
    expect(javascript).not.toMatch(/\bas\s+(const|unknown|string|number)\b/);
    // And the script is not empty or truncated.
    expect(javascript.length).toBeGreaterThan(200);
    // It parses as an ES module, which is how the browser will load it.
    expect(() => new Bun.Transpiler({ loader: 'js' }).transformSync(javascript)).not.toThrow();
    expect(asset.endsWith('.js')).toBe(true);
  }
});

test('an import is rejected, because there is no bundler to resolve it', () => {
  // A bare import would 404 in the browser and break the whole page, and the
  // failure would be invisible to the server. It must fail at serve time instead.
  expect(() =>
    transpileClientScript(
      'example.ts',
      "import { thing } from './other.js';\nconsole.log(thing);\n",
    ),
  ).toThrow(/self-contained module/);
});

test('the module directive alone is allowed', () => {
  // `export {}` is what marks a file as a module; it resolves nothing, so it is
  // the one permitted export.
  expect(() =>
    transpileClientScript('example.ts', 'const value: number = 1;\nexport {};\n'),
  ).not.toThrow();
});

test('the server serves each script by asset name and reports unknown names', async () => {
  const assets = new ClientScriptAssets(scriptsDirectory);
  for (const { asset } of CLIENT_SCRIPTS) {
    const javascript = await assets.javascriptFor(asset);
    expect(typeof javascript).toBe('string');
    expect((javascript ?? '').length).toBeGreaterThan(200);
    // Cached: the same string is returned on the second read.
    expect(await assets.javascriptFor(asset)).toBe(javascript);
  }
  expect(await assets.javascriptFor('bp-not-a-script.js')).toBeNull();
});

test('the served script defines the behaviour each page needs', async () => {
  const assets = new ClientScriptAssets(scriptsDirectory);
  // Spot-check the page-specific logic actually reaches the browser, so a script
  // that transpiled to nothing usable fails here rather than in a manual click.
  expect(await assets.javascriptFor('bp-home.js')).toContain('/api/create');
  expect(await assets.javascriptFor('bp-leaderboard.js')).toContain('/api/leaderboard?');
  const admin = await assets.javascriptFor('admin.js');
  expect(admin).toContain('/api/admin/');
  // Player names and event details must never be rendered as markup.
  expect(admin).toContain('textContent');
  expect(admin).not.toContain('innerHTML');
});
