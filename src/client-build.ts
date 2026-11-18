/**
 * Which prepared client is on disk, if any.
 *
 * This exists because a prepared client can be **stale but complete**. A `web/`
 * left over from an earlier checkout starts without error and serves a client
 * whose patches do not match the server that is running, so the failure appears
 * as a button that does nothing rather than as a startup error. Reporting the
 * build stamp at `/health` turns that silent mismatch into something an operator
 * can compare against the checkout they meant to deploy.
 *
 * A missing stamp is not an error: a client prepared before stamps existed, or one
 * supplied by a container mount, has none. It is reported as `null` so "unknown"
 * is distinguishable from "a build nobody recognises".
 */

import path from 'node:path';

export interface ClientBuild {
  /** Short hash over the patcher and every snippet it splices. */
  clientBuild: string;
  /** How many archived assets the build was prepared from. */
  assets: number;
}

export async function readClientBuild(webRoot: string): Promise<ClientBuild | null> {
  try {
    const stamp: unknown = await Bun.file(path.join(webRoot, 'build.json')).json();
    if (typeof stamp !== 'object' || stamp === null) {
      return null;
    }
    const record = stamp as Record<string, unknown>;
    if (typeof record.clientBuild !== 'string' || typeof record.assets !== 'number') {
      return null;
    }
    return { clientBuild: record.clientBuild, assets: record.assets };
  } catch {
    // Absent or unreadable: both mean the same thing to an operator, which is
    // that this build cannot be identified. Never let it stop the service.
    return null;
  }
}
