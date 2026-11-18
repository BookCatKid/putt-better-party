import { test, expect } from 'bun:test';
import {
  readServerConfig,
  websocketOriginFor,
  DEFAULT_HOSTNAME,
  DEFAULT_PORT,
} from '../src/config.js';

/**
 * The configuration boundary. A local run must answer whichever loopback
 * spelling the browser used, while a deployment behind a proxy must answer only
 * the origin it was configured with. Both are easy to get wrong in a way no
 * other test would notice: the service would simply refuse every request, or
 * quietly accept one it should not.
 */
test('a default configuration is loopback only and answers every loopback spelling', () => {
  const config = readServerConfig({});
  expect(config.hostname).toBe(DEFAULT_HOSTNAME);
  expect(config.port).toBe(DEFAULT_PORT);
  expect(config.loopbackOnly).toBe(true);
  // The README tells a reader to open `localhost`, so that spelling has to work
  // as well as the address the listener is actually bound to.
  expect(config.allowedOrigins).toContain('http://127.0.0.1:' + DEFAULT_PORT);
  expect(config.allowedOrigins).toContain('http://localhost:' + DEFAULT_PORT);
  expect(config.allowedOrigins).toContain('http://[::1]:' + DEFAULT_PORT);
  expect(config.canonicalOrigin).toBe('http://127.0.0.1:' + DEFAULT_PORT);
  expect(config.allowedHosts).toContain('localhost:' + DEFAULT_PORT);
  expect(config.websocketOrigins).toContain('ws://127.0.0.1:' + DEFAULT_PORT);
});

test('a configured public origin is the only one answered, and carries no loopback', () => {
  const config = readServerConfig({
    PORT: '9000',
    BP_HOST: '0.0.0.0',
    BP_PUBLIC_ORIGIN: 'https://party.example.com',
  });
  expect(config.hostname).toBe('0.0.0.0');
  expect(config.port).toBe(9000);
  // Behind a proxy, answering a direct loopback request would bypass whatever
  // the proxy enforces, so no local spelling is added to the list.
  expect(config.allowedOrigins).toEqual(['https://party.example.com']);
  expect(config.allowedHosts).toEqual(['party.example.com']);
  expect(config.canonicalOrigin).toBe('https://party.example.com');
  expect(config.loopbackOnly).toBe(false);
  // A default HTTPS port is omitted from an origin, so the Host header matches.
  expect(config.websocketOrigins).toEqual(['wss://party.example.com']);
});

test('a public origin with an explicit port keeps it, in both schemes', () => {
  const config = readServerConfig({ BP_PUBLIC_ORIGIN: 'http://party.example.com:8080' });
  expect(config.allowedOrigins).toEqual(['http://party.example.com:8080']);
  expect(config.allowedHosts).toEqual(['party.example.com:8080']);
  expect(config.websocketOrigins).toEqual(['ws://party.example.com:8080']);
  expect(config.loopbackOnly).toBe(false);
});

test('the origin allowlist is exact, so a lookalike host is never admitted', () => {
  const config = readServerConfig({ BP_PUBLIC_ORIGIN: 'https://party.example.com' });
  // The failure mode this guards is a suffix or prefix test: with one, each of
  // these would be accepted while looking almost like the allowed origin.
  for (const hostile of [
    'https://party.example.com.evil.test',
    'https://evil.test/party.example.com',
    'https://evilparty.example.com',
    'https://party.example.co',
  ]) {
    expect(config.allowedOrigins.includes(hostile)).toBe(false);
    expect(config.allowedHosts.includes(new URL(hostile).host)).toBe(false);
  }
  // A scheme is not part of a `Host` header, so the plain-HTTP spelling of the
  // right host is separated by the origin check rather than the host check.
  // That is why every state-changing request and the WebSocket upgrade are
  // checked against the origin list, not the host list alone.
  expect(config.allowedHosts.includes('party.example.com')).toBe(true);
  expect(config.allowedOrigins.includes('http://party.example.com')).toBe(false);
});

test('an invalid port is refused rather than silently defaulted', () => {
  for (const port of ['0', '-1', '65536', '80.5', 'eighty']) {
    expect(() => readServerConfig({ PORT: port })).toThrow();
  }
});

test('a public origin must be a bare origin, not a path or a scheme-less host', () => {
  for (const value of [
    'party.example.com',
    'ftp://party.example.com',
    'https://party.example.com/party',
    'https://party.example.com/?a=1',
    'https://user:pass@party.example.com',
  ]) {
    expect(() => readServerConfig({ BP_PUBLIC_ORIGIN: value })).toThrow();
  }
});

test('the websocket scheme follows the HTTP scheme', () => {
  expect(websocketOriginFor('http://127.0.0.1:8789')).toBe('ws://127.0.0.1:8789');
  expect(websocketOriginFor('https://party.example.com')).toBe('wss://party.example.com');
  expect(websocketOriginFor('https://party.example.com:8443')).toBe('wss://party.example.com:8443');
});
