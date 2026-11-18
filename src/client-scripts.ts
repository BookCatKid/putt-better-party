/**
 * The three standalone browser scripts are authored as TypeScript.
 *
 * They are not snippets spliced into the pinned client - they are whole pages'
 * worth of behaviour loaded by their own `<script type="module">` tags - so they
 * can be real `.ts` and type-checked by the same strict configuration as the
 * backend. The browsers still need JavaScript, so this module is the one place
 * that strips the types, and the running server uses it. Generating the JavaScript
 * into the repository instead would mean a build artifact that can drift from its
 * source.
 *
 * They are modules rather than classic scripts so each page gets its own scope:
 * as classic scripts they would share one global namespace and their helper names
 * would collide. Nothing may be imported, though, because there is no bundler here
 * and a bare import would 404 in the browser. That is asserted rather than assumed.
 */

import path from 'node:path';

/** A standalone client script: its authored source and the asset it is served as. */
export interface ClientScript {
  /** File name under `scripts/`, including the `.ts` extension. */
  readonly source: string;
  /** Public asset name the page loads, such as `bp-home.js`. */
  readonly asset: string;
}

export const CLIENT_SCRIPTS: readonly ClientScript[] = [
  { source: 'home.ts', asset: 'bp-home.js' },
  { source: 'leaderboard.ts', asset: 'bp-leaderboard.js' },
  { source: 'admin.ts', asset: 'admin.js' },
];

export interface TranspiledScript {
  readonly asset: string;
  readonly javascript: string;
}

/**
 * Strip the types from one script.
 *
 * Bun's transpiler is used rather than a bundler because these files must stay
 * single self-contained modules. The output is checked for imports so that a
 * future `import` fails here rather than as a 404 in the browser, where a module
 * import of a path that is not served would break the whole page.
 */
export function transpileClientScript(source: string, javascript: string): string {
  const result = new Bun.Transpiler({ loader: 'ts' }).transformSync(javascript);
  const strayImport = /^\s*import\b/m.exec(result);
  if (strayImport) {
    throw new Error(
      `${source} is served as a self-contained module, so it cannot import ${strayImport[0].trim()}.`,
    );
  }
  return result;
}

/** Transpile every standalone script, in declaration order. */
export async function transpileClientScripts(
  scriptsDirectory: string,
): Promise<TranspiledScript[]> {
  return Promise.all(
    CLIENT_SCRIPTS.map(async ({ source, asset }) => {
      const file = Bun.file(path.join(scriptsDirectory, source));
      if (!(await file.exists())) {
        throw new Error(`Missing client script: ${path.join(scriptsDirectory, source)}`);
      }
      return { asset, javascript: transpileClientScript(source, await file.text()) };
    }),
  );
}

/**
 * Serve the transpiled JavaScript for one public asset name.
 *
 * The results are cached because a page reload should not re-transpile, but the
 * cache is keyed by asset name only: these files are authored source that changes
 * with a deploy, not user data, so there is nothing to invalidate at runtime.
 */
export class ClientScriptAssets {
  private readonly scriptsDirectory: string;
  private readonly cache = new Map<string, string>();

  constructor(scriptsDirectory: string) {
    this.scriptsDirectory = scriptsDirectory;
  }

  /** The JavaScript for `asset`, or `null` when no authored script has that name. */
  async javascriptFor(asset: string): Promise<string | null> {
    const cached = this.cache.get(asset);
    if (cached !== undefined) {
      return cached;
    }
    const entry = CLIENT_SCRIPTS.find((script) => script.asset === asset);
    if (!entry) {
      return null;
    }
    const file = Bun.file(path.join(this.scriptsDirectory, entry.source));
    if (!(await file.exists())) {
      throw new Error(`Missing client script: ${path.join(this.scriptsDirectory, entry.source)}`);
    }
    const javascript = transpileClientScript(entry.source, await file.text());
    this.cache.set(asset, javascript);
    return javascript;
  }
}
