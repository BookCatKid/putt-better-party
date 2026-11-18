/**
 * Headers every response carries on a real deployment.
 *
 * These are applied once at the edge of the HTTP handler rather than repeated at
 * each of the dozen places a `Response` is constructed, so a new route cannot
 * forget them and an existing one cannot drift.
 */

/**
 * Capabilities the pinned client never asks for.
 *
 * This is a traceable list rather than a reflex. The bundled client was searched
 * for `getUserMedia`, `mediaDevices`, `geolocation`, `PaymentRequest`,
 * `navigator.serial`, `navigator.hid`, `navigator.usb`, `navigator.bluetooth`
 * and `requestMIDIAccess`, and it uses none of them. It does use
 * `requestFullscreen` and `navigator.clipboard.writeText`, so neither is denied
 * here: doing so would break the fullscreen button and the share link.
 */
const DENIED_PERMISSIONS = [
  'camera',
  'microphone',
  'geolocation',
  'payment',
  'usb',
  'serial',
  'hid',
  'bluetooth',
  'midi',
] as const;

export interface DeploymentHeaderOptions {
  /**
   * True when the canonical origin is HTTPS, i.e. the service runs behind a
   * TLS-terminating proxy.
   */
  https: boolean;
}

/**
 * The headers to add, as a plain map.
 *
 * `strict-transport-security` is only present on an HTTPS deployment. A browser
 * that receives HSTS over plain HTTP ignores it at best; the damage is worse
 * when the same host name is later reached over HTTP for a local test, because a
 * previously pinned host is refused outright before the request is sent.
 */
export function deploymentHeaders({ https }: DeploymentHeaderOptions): Record<string, string> {
  const headers: Record<string, string> = {
    'permissions-policy': DENIED_PERMISSIONS.map((name) => `${name}=()`).join(', '),
    'x-frame-options': 'DENY',
  };
  if (https) {
    headers['strict-transport-security'] = 'max-age=31536000; includeSubDomains';
  }
  return headers;
}

/**
 * Add {@link deploymentHeaders} to a finished response.
 *
 * A `Response` is immutable, so this rebuilds one around the same body. Headers
 * already set win: a route that chose its own value did so deliberately, and
 * silently overwriting it here would produce a difference that only shows up in
 * a browser.
 */
export function withDeploymentHeaders(
  answered: Response,
  options: DeploymentHeaderOptions,
): Response {
  const headers = new Headers(answered.headers);
  for (const [name, value] of Object.entries(deploymentHeaders(options))) {
    if (!headers.has(name)) {
      headers.set(name, value);
    }
  }
  return new Response(answered.body, {
    status: answered.status,
    statusText: answered.statusText,
    headers,
  });
}
