/**
 * Where the verifier finds the course piece models.
 *
 * The models are part of the prepared client: the same `web/` tree the server
 * already serves, under `models/minigolf/`. Resolving them from that tree —
 * rather than a second copy — keeps the verifier reading exactly the bytes the
 * client's own loader got, so a prepared build that drifted is caught by the
 * client-build stamp rather than by a divergent replay.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Build a `loadPiece` for the prepared client's model directory.
 *
 * `webRoot` is injectable so tests and offline tooling can point at the
 * archived snapshot in `private-client/` instead of a prepared build. The
 * default is the server's own served root, `src/../web`.
 */
export function preparedModelLoader(
  webRoot = path.resolve(import.meta.dir, '../../web'),
): (name: string) => Uint8Array | null {
  const modelDir = path.join(webRoot, 'models', 'minigolf');
  return (name: string) => {
    // A registry entry is the only way a name reaches here, so it is always a
    // file name — but a bad entry must not be able to escape the directory.
    if (name !== path.basename(name)) {
      return null;
    }
    try {
      return readFileSync(path.join(modelDir, name));
    } catch {
      return null;
    }
  };
}
