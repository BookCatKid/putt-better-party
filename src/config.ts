/**
 * Service configuration read from the environment.
 *
 * This is a boundary: every value here comes from outside the process and is
 * either validated or replaced with a safe default, so the server can consume
 * it without re-checking. Keeping it separate from `server.ts` also makes the
 * decisions testable without binding a socket or touching a database.
 *
 * The security-relevant part is the origin allowlist. The service refuses a
 * request whose `Host` is not one it answers to, and refuses a state-changing
 * request or WebSocket upgrade whose `Origin` is not on the list. Both are
 * exact matches rather than suffix or prefix tests, so a hostile DNS name
 * cannot borrow the allowance by ending in or containing a trusted one.
 */

/** A loopback listener is the default: nothing is reachable off the machine. */
export const DEFAULT_HOSTNAME = '127.0.0.1';
export const DEFAULT_PORT = 8789;

/**
 * Addresses that all mean "this machine". They are interchangeable for a local
 * run, so the allowlist includes all of them; a browser that opened the page at
 * `localhost` sends that origin with its requests and would otherwise be
 * refused by a server that only knows `127.0.0.1`. `[::1]` is listed for a
 * deployment that binds the IPv6 loopback with `BP_HOST`; the default listener
 * is IPv4, so it simply never sees that spelling.
 */
const LOOPBACK_HOSTNAMES = ['127.0.0.1', 'localhost', '[::1]'] as const;

export interface ServerConfig {
  /** Address the HTTP and WebSocket listener binds to. */
  hostname: string;
  port: number;
  /** The origin used in the CSP and in links, i.e. the first allowed origin. */
  canonicalOrigin: string;
  /** Exact origins this service answers. Never empty. */
  allowedOrigins: readonly string[];
  /** Every `Host` header value implied by {@link allowedOrigins}. */
  allowedHosts: readonly string[];
  /** WebSocket origin for each allowed origin, for the CSP. */
  websocketOrigins: readonly string[];
  /** True when every allowed origin is an HTTP loopback address. */
  loopbackOnly: boolean;
}

function readPort(raw: string | undefined): number {
  if (raw === undefined || raw === '') {
    return DEFAULT_PORT;
  }
  const port = Number(raw);
  // A port is a TCP port: an integer in range, not a float, a negative or NaN.
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  return port;
}

function readHostname(raw: string | undefined): string {
  const hostname = (raw ?? '').trim();
  return hostname === '' ? DEFAULT_HOSTNAME : hostname;
}

/**
 * A canonical origin must be a bare origin: a scheme, a host and an optional
 * port, with no path, query or credentials. `URL` happily accepts all of those,
 * and a path here would silently never match a real `Origin` header.
 */
function readCanonicalOrigin(raw: string | undefined): string | null {
  const value = (raw ?? '').trim();
  if (value === '') {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('BP_PUBLIC_ORIGIN must be an absolute http or https URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('BP_PUBLIC_ORIGIN must be an absolute http or https URL');
  }
  if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
    throw new Error('BP_PUBLIC_ORIGIN must be an origin with no path, query or fragment');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error('BP_PUBLIC_ORIGIN must not carry credentials');
  }
  // `URL.origin` already omits a default port, which is exactly what a Host
  // header omits too; adding one would never match.
  return parsed.origin;
}

/** `http://host:port` becomes `ws://host:port`, `https` becomes `wss`. */
export function websocketOriginFor(httpOrigin: string): string {
  const parsed = new URL(httpOrigin);
  const scheme = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${parsed.host}`;
}

export function readServerConfig(
  env: Record<string, string | undefined> = process.env,
): ServerConfig {
  const port = readPort(env.PORT);
  const hostname = readHostname(env.BP_HOST);
  const configured = readCanonicalOrigin(env.BP_PUBLIC_ORIGIN);

  // A configured public origin is the whole allowlist: behind a proxy the
  // service must not also answer direct loopback-host requests, because those
  // bypass whatever the proxy enforces. Without one the service is a local run,
  // so every loopback spelling of the same port is allowed.
  const allowedOrigins = configured
    ? [configured]
    : LOOPBACK_HOSTNAMES.map((loopback) => `http://${loopback}:${port}`);

  const allowedHosts = [...new Set(allowedOrigins.map((value) => new URL(value).host))];
  const websocketOrigins = allowedOrigins.map(websocketOriginFor);
  const loopbackOnly = allowedOrigins.every((value) => {
    const host = new URL(value).hostname;
    return (LOOPBACK_HOSTNAMES as readonly string[]).includes(host);
  });

  return {
    hostname,
    port,
    canonicalOrigin: allowedOrigins[0] as string,
    allowedOrigins,
    allowedHosts,
    websocketOrigins,
    loopbackOnly,
  };
}
