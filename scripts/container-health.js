/**
 * Container health probe.
 *
 * `curl` is not in the runtime image, so the probe uses the runtime itself. It is
 * also not as simple as fetching `/health`: the service refuses any request whose
 * `Host` is not one it was configured for, and a proxied deployment is configured
 * for exactly one public origin. A probe sending `127.0.0.1` would therefore get a
 * `403` from a perfectly healthy service and mark it unhealthy.
 *
 * So this derives the `Host` from `BP_PUBLIC_ORIGIN` when it is set, and falls
 * back to loopback for a local run.
 */

const port = process.env.PORT ?? '8789';
const publicOrigin = process.env.BP_PUBLIC_ORIGIN;

let host = `127.0.0.1:${port}`;
if (publicOrigin) {
  try {
    // `URL` normalises away a default port, which is exactly what a `Host`
    // header carries, so an origin of `https://party.example.com` becomes
    // `party.example.com` rather than `party.example.com:443`.
    host = new URL(publicOrigin).host;
  } catch {
    console.error(`BP_PUBLIC_ORIGIN is not a URL: ${publicOrigin}`);
    process.exit(1);
  }
}

try {
  const answered = await fetch(`http://127.0.0.1:${port}/health`, {
    headers: { host },
    signal: AbortSignal.timeout(5000),
  });
  if (!answered.ok) {
    console.error(`Health answered ${answered.status}`);
    process.exit(1);
  }
  const report = await answered.json();
  if (report?.ok !== true) {
    console.error(`Health did not report ok: ${JSON.stringify(report)}`);
    process.exit(1);
  }
  process.exit(0);
} catch (error) {
  console.error(`Health probe failed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
