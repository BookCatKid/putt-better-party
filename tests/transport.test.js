import { test, expect, beforeEach, afterEach } from 'bun:test';
import { connectBetterParty } from '../scripts/party-transport.js';

/**
 * Reconnect delays are jittered by ±20% in production, which is what stops a whole
 * party retrying in lockstep after a restart. Most tests here are about something
 * else and assume the plain backoff, so randomness is pinned to the middle of the
 * band - `Math.random()` returning 0.5 yields exactly the unjittered delay. The
 * backoff test varies it deliberately to prove the bound holds at both extremes.
 */
const realRandom = Math.random;
beforeEach(() => {
  Math.random = () => 0.5;
});
afterEach(() => {
  Math.random = realRandom;
});

/** Controllable fake clock replacing setTimeout/setInterval/clearTimeout/clearInterval. */
function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => now,
    pendingCount: () => timers.size,
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { id, fn, at: now + (ms || 0), interval: false });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    setInterval(fn, ms) {
      const id = nextId++;
      timers.set(id, { id, fn, at: now + (ms || 0), every: ms || 0, interval: true });
      return id;
    },
    clearInterval(id) {
      timers.delete(id);
    },
    advance(ms) {
      const end = now + ms;
      let guard = 0;
      while (guard++ < 10_000) {
        let due = null;
        for (const timer of timers.values()) {
          if (timer.at <= end && (due === null || timer.at < due.at)) {
            due = timer;
          }
        }
        if (due === null) {
          break;
        }
        now = due.at;
        if (due.interval) {
          due.at = now + due.every;
        } else {
          timers.delete(due.id);
        }
        due.fn();
      }
      now = end;
    },
  };
}

/** Minimal state store matching the upstream store surface used by the adapter. */
function fakeStore(initial = {}) {
  const listeners = new Set();
  const store = {
    state: { ...initial },
    setState(patch) {
      Object.assign(store.state, patch);
      for (const listener of listeners) {
        listener();
      }
    },
    subscribe(fn) {
      listeners.add(fn);
      return { unsubscribe: () => listeners.delete(fn) };
    },
  };
  return store;
}

/** Fake WebSocket whose instances record sends and expose test triggers. */
function fakeWebSocketFactory() {
  const sockets = [];
  class FakeWebSocket {
    static OPEN = 1;
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      sockets.push(this);
    }
    send(data) {
      if (this.readyState !== FakeWebSocket.OPEN) {
        throw Error('Socket is not open');
      }
      this.sent.push(JSON.parse(data));
    }
    close() {
      this.readyState = 3;
      // A real close() is followed by a close event; mimic it synchronously.
      if (this.onclose) {
        this.onclose({ code: 1006, reason: '' });
      }
    }
    open() {
      this.readyState = FakeWebSocket.OPEN;
      this.onopen();
    }
    message(message) {
      this.onmessage({ data: JSON.stringify(message) });
    }
    raw(text) {
      this.onmessage({ data: text });
    }
    drop(code = 1006, reason = '') {
      this.readyState = 3;
      this.onclose({ code, reason });
    }
  }
  FakeWebSocket.sockets = sockets;
  return FakeWebSocket;
}

/** Recording fakes for the upstream store bindings and a matching bindings object. */
function fakeEnvironment(clockOptions = {}) {
  const clock = clockOptions.clock || fakeClock();
  // Mirrors the upstream party store's initial shape, including the roster
  // count the host-authority frames must preserve.
  const partyStore = fakeStore({
    matchId: null,
    holeIndex: 0,
    holeIds: [],
    phase: 'lobby',
    mapReady: false,
    selfRole: 'player',
    count: 0,
    roster: [],
  });
  // The upstream game store always carries an attempt sequence: installing a
  // level advances it, so the transport can tell a fresh attempt from a stale
  // one even when the course identifier is identical.
  const gameStore = fakeStore({ strokes: 0, phase: 'aiming', level: null, attemptSeq: 0 });
  const settingsStore = fakeStore({ ghosts: true });
  const scene = { ballPos: { x: 1, y: 0, z: 2 }, pointer: { x: 0, z: 0, active: false } };
  const log = { connection: [], identity: [], errors: [], finals: [], acks: [], hostTokens: [] };
  // The route records the prepared level ID; tests set it directly.
  let sceneReadyLevelId = null;
  let registeredSender = null;
  const WebSocket = fakeWebSocketFactory();
  const bindings = {
    WebSocket,
    location: { protocol: 'http:', host: 'test.local' },
    document: { visibilityState: 'hidden' },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
    partyStore,
    gameStore,
    settingsStore,
    scene,
    connection: (connected, failure) => log.connection.push({ connected, failure }),
    // Defaults to "the party is still there", so tests that are not about a
    // vanished party keep retrying exactly as before.
    probeRoom: async () => 200,
    registerSender: (sender) => {
      registeredSender = sender;
    },
    // Mirrors the upstream identity binding, which writes the crown and count
    // into the party store as well as the roster.
    setIdentity: (isHost, count, role) => {
      log.identity.push({ isHost, count, role });
      partyStore.setState({
        isHost,
        count: count ?? partyStore.state.count,
        selfRole: role ?? partyStore.state.selfRole,
      });
    },
    updateParty: (message) => {
      const { t, ...rest } = message;
      partyStore.setState(rest);
    },
    setFlyCamera: () => {},
    setRoster: () => {},
    setBoard: () => {},
    setFinal: (final) => log.finals.push(final),
    sceneReadyLevelId: () => sceneReadyLevelId,
    capturedHostToken: (token) => log.hostTokens.push(['captured', token]),
    dropHostToken: () => log.hostTokens.push(['dropped']),
    removeGhost: () => {},
    showCompletion: () => {},
    ghostHue: () => 0,
    setError: (message) => log.errors.push(message),
    updateGhost: () => {},
    isSpectator: () => false,
    ack: (message) => log.acks.push(message),
  };
  return {
    clock,
    partyStore,
    gameStore,
    settingsStore,
    scene,
    log,
    WebSocket,
    bindings,
    sender: () => registeredSender,
    setSceneReadyLevelId: (levelId) => {
      sceneReadyLevelId = levelId;
    },
  };
}

const IDENTITY = { uid: 'uid-1', name: 'Tester', hue: 10, session: 'sess', instance: 'inst-1' };

/** Drive one full connection through hello, snapshot, roster and board. */
function handshake(
  env,
  socket,
  { matchId = 'm1', holeIndex = 0, phase = 'playing', mapId = 'p' } = {},
) {
  socket.open();
  socket.message({ t: 'hello', id: 'conn-1', isHost: false, count: 1, role: 'player' });
  socket.message({
    t: 'party',
    matchId,
    holeIndex,
    phase,
    holeIds: ['p'],
    currentMap: { id: mapId },
  });
  socket.message({ t: 'roster', players: [] });
  socket.message({ t: 'board', standings: [], alive: 1, holed: 0 });
  // The route sets map readiness once the level has loaded, outside the snapshot.
  env.partyStore.setState({ mapReady: true });
}

test('handshake orders join first and enables sends only after snapshot, roster and board', () => {
  const env = fakeEnvironment();
  const dispose = connectBetterParty('ABCDE', IDENTITY, { bindings: env.bindings });
  const socket = env.WebSocket.sockets[0];
  expect(socket.url).toBe('ws://test.local/ws/party/ABCDE');
  socket.open();
  // The join frame is sent without synchronization; nothing else may be sent yet.
  expect(socket.sent.length).toBe(1);
  expect(socket.sent[0].t).toBe('join');
  expect(socket.sent[0].uid).toBe(IDENTITY.uid);
  expect(env.sender()({ t: 'ping' })).toBe(false);
  socket.message({ t: 'party', matchId: 'm1', holeIndex: 0, phase: 'playing', holeIds: ['p'] });
  socket.message({ t: 'roster', players: [] });
  // Board still missing: the adapter must stay unsynchronized.
  expect(env.sender()({ t: 'ping' })).toBe(false);
  expect(env.log.connection.some((entry) => entry.connected === true)).toBe(false);
  socket.message({ t: 'board', standings: [], alive: 1, holed: 0 });
  expect(env.log.connection.some((entry) => entry.connected === true)).toBe(true);
  expect(env.sender()({ t: 'ping' })).toBe(true);
  expect(socket.sent.some((frame) => frame.t === 'ping')).toBe(true);
  dispose();
});

test('the lobby-preloaded level allows progress immediately after the first snapshot', () => {
  // In the browser the lobby already loaded the first hole: map readiness is
  // true before the first snapshot arrives. That snapshot introduces the round
  // instead of changing it, so progress must not be latched behind a reload.
  const env = fakeEnvironment();
  env.partyStore.setState({ mapReady: true });
  env.gameStore.setState({ level: { id: 'p' }, strokes: 0, phase: 'aiming' });
  const dispose = connectBetterParty('ABCDE', IDENTITY, { bindings: env.bindings });
  const socket = env.WebSocket.sockets[0];
  handshake(env, socket, { matchId: 'm1', holeIndex: 0, phase: 'playing', mapId: 'p' });
  env.gameStore.setState({ strokes: 1 });
  const progress = socket.sent.filter((frame) => frame.t === 'prog');
  // The adapter reports the preloaded zero-stroke state on sync, then the stroke.
  expect(progress.length).toBe(2);
  expect(progress[1]).toMatchObject({ st: 1, matchId: 'm1', holeIndex: 0 });
  dispose();
});

test('malformed and unknown frames are ignored without breaking the connection', () => {
  const env = fakeEnvironment();
  const dispose = connectBetterParty('ABCDE', IDENTITY, { bindings: env.bindings });
  const socket = env.WebSocket.sockets[0];
  handshake(env, socket);
  const framesBefore = socket.sent.length;
  socket.raw('not json at all');
  socket.raw('[]');
  socket.raw('42');
  socket.message({ t: 'unknown-frame', x: 1 });
  // A handshake clears the error field, so count only messages actually raised.
  expect(env.log.errors.filter(Boolean).length).toBe(0);
  expect(env.sender()({ t: 'ping' })).toBe(true);
  expect(socket.sent.length).toBe(framesBefore + 1);
  dispose();
});

test('reconnect backoff doubles to a cap, stays jittered and resets after recovery', () => {
  /**
   * Measure the delay one drop actually waits, by stepping the fake clock one
   * millisecond at a time until the next socket appears. Measuring rather than
   * assuming is the point: it is what makes an absent jitter visible.
   */
  function measuredDelay(random, prepare) {
    Math.random = () => random;
    const fresh = fakeEnvironment();
    const stop = connectBetterParty('ABCDE', IDENTITY, { bindings: fresh.bindings });
    prepare(fresh);
    // Captured after preparing, so the loop waits for the *next* socket only.
    const before = fresh.WebSocket.sockets.length;
    let elapsed = 0;
    while (fresh.WebSocket.sockets.length === before && elapsed < 60_000) {
      fresh.clock.advance(1);
      elapsed += 1;
    }
    stop();
    return elapsed;
  }

  const dropFirst = (fresh) => {
    fresh.WebSocket.sockets[0].open();
    fresh.WebSocket.sockets[0].drop();
  };

  // The band is ±20%, and 0.5 is its middle: the delay is the plain backoff.
  expect(measuredDelay(0.5, dropFirst)).toBe(1000);
  // The extremes prove the spread is real. Without it both of these are 1000, and
  // every client dropped by one event would retry at the same instant.
  expect(measuredDelay(0, dropFirst)).toBe(800);
  expect(measuredDelay(0.999999, dropFirst)).toBe(1200);

  // The doubling sequence holds at every draw, and stops at the cap.
  const env = fakeEnvironment();
  const dispose = connectBetterParty('ABCDE', IDENTITY, { bindings: env.bindings });
  Math.random = () => 0.5;
  env.WebSocket.sockets[0].open();
  env.WebSocket.sockets[0].drop();
  const delays = [];
  let base = 1000;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    env.clock.advance(base);
    const socket = env.WebSocket.sockets[env.WebSocket.sockets.length - 1];
    socket.open();
    socket.drop();
    delays.push(base);
    base = Math.min(base * 2, 15_000);
  }
  expect(delays).toEqual([1000, 2000, 4000, 8000, 15_000, 15_000]);

  // A completed handshake resets the backoff to the initial delay.
  env.clock.advance(15_000);
  const recovered = env.WebSocket.sockets[env.WebSocket.sockets.length - 1];
  handshake(env, recovered);
  recovered.drop();
  env.clock.advance(999);
  expect(env.WebSocket.sockets.length).toBe(8);
  env.clock.advance(1);
  expect(env.WebSocket.sockets.length).toBe(9);
  dispose();
});

test('handshake timeout closes a silent socket and schedules a reconnect', () => {
  const env = fakeEnvironment();
  const dispose = connectBetterParty('ABCDE', IDENTITY, { bindings: env.bindings });
  const socket = env.WebSocket.sockets[0];
  socket.open();
  env.clock.advance(12_000);
  expect(socket.readyState).toBe(3);
  expect(env.log.connection.at(-1).connected).toBe(false);
  env.clock.advance(1000);
  expect(env.WebSocket.sockets.length).toBe(2);
  dispose();
});

test('a completed handshake disarms the 12 second connection deadline', () => {
  const env = fakeEnvironment();
  const dispose = connectBetterParty('ABCDE', IDENTITY, { bindings: env.bindings });
  const socket = env.WebSocket.sockets[0];
  handshake(env, socket);
  // Answer the heartbeat as a live server would; this test is about the opening
  // deadline, not about a socket that has gone silent.
  for (let elapsed = 0; elapsed < 60_000; elapsed += 5000) {
    env.clock.advance(5000);
    socket.message({ t: 'pong' });
  }
  expect(socket.readyState).toBe(1);
  expect(env.WebSocket.sockets.length).toBe(1);
  expect(env.log.connection.filter((entry) => entry.connected === false).length).toBe(1);
  dispose();
});

test('a partial handshake times out when the board never arrives', () => {
  const env = fakeEnvironment();
  const dispose = connectBetterParty('ABCDE', IDENTITY, { bindings: env.bindings });
  const socket = env.WebSocket.sockets[0];
  socket.open();
  socket.message({ t: 'hello', id: 'conn-1', isHost: false, count: 1, role: 'player' });
  socket.message({
    t: 'party',
    matchId: 'm1',
    holeIndex: 0,
    phase: 'playing',
    holeIds: ['p'],
    currentMap: { id: 'p' },
  });
  socket.message({ t: 'roster', players: [] });
  env.clock.advance(11_999);
  expect(socket.readyState).toBe(1);
  expect(env.sender()({ t: 'ping' })).toBe(false);
  env.clock.advance(1);
  expect(socket.readyState).toBe(3);
  expect(env.log.connection.at(-1).connected).toBe(false);
  dispose();
});

test('roster and board arriving before the snapshot do not synchronize early', () => {
  const env = fakeEnvironment();
  const dispose = connectBetterParty('ABCDE', IDENTITY, { bindings: env.bindings });
  const socket = env.WebSocket.sockets[0];
  socket.open();
  socket.message({ t: 'hello', id: 'conn-1', isHost: false, count: 1, role: 'player' });
  // Out of order relative to the server's usual sequence: state first.
  socket.message({ t: 'roster', players: [] });
  socket.message({ t: 'board', standings: [], alive: 1, holed: 0 });
  expect(env.sender()({ t: 'ping' })).toBe(false);
  expect(env.log.connection.some((entry) => entry.connected === true)).toBe(false);
  socket.message({
    t: 'party',
    matchId: 'm1',
    holeIndex: 0,
    phase: 'playing',
    holeIds: ['p'],
    currentMap: { id: 'p' },
  });
  env.partyStore.setState({ mapReady: true });
  expect(env.log.connection.some((entry) => entry.connected === true)).toBe(true);
  expect(env.sender()({ t: 'ping' })).toBe(true);
  dispose();
});

test('final standings are re-delivered by a reconnecting server, not reused from the old socket', () => {
  const env = fakeEnvironment();
  const dispose = connectBetterParty('ABCDE', IDENTITY, { bindings: env.bindings });
  let socket = env.WebSocket.sockets[0];
  handshake(env, socket, { phase: 'final' });
  socket.message({ t: 'final', podium: [{ id: 'old', name: 'Old' }], standings: [] });
  expect(env.log.finals.at(-1)).toMatchObject({ podium: [{ id: 'old', name: 'Old' }] });
  socket.drop();
  env.clock.advance(1000);
  socket = env.WebSocket.sockets[1];
  handshake(env, socket, { phase: 'final' });
  expect(env.log.finals.length).toBe(1);
  socket.message({ t: 'final', podium: [{ id: 'new', name: 'New' }], standings: [] });
  expect(env.log.finals.length).toBe(2);
  expect(env.log.finals.at(-1)).toMatchObject({ podium: [{ id: 'new', name: 'New' }] });
  dispose();
});

test('replacement-tab close is terminal: no further reconnects and the error is surfaced', () => {
  const env = fakeEnvironment();
  const dispose = connectBetterParty('ABCDE', IDENTITY, { bindings: env.bindings });
  const socket = env.WebSocket.sockets[0];
  handshake(env, socket);
  socket.drop(1000, 'Reconnected');
  expect(env.log.connection.at(-1)).toEqual({
    connected: false,
    failure: 'This party is open in another tab.',
  });
  env.clock.advance(60_000);
  expect(env.WebSocket.sockets.length).toBe(1);
  dispose();
});

test('invalid-join and full errors are terminal; other errors allow reconnection', () => {
  const env = fakeEnvironment();
  const dispose = connectBetterParty('ABCDE', IDENTITY, { bindings: env.bindings });
  let socket = env.WebSocket.sockets[0];
  handshake(env, socket);
  socket.message({ t: 'error', code: 'not-host', msg: 'Only the host can configure the lobby.' });
  expect(env.log.errors).toContain('Only the host can configure the lobby.');
  socket.drop();
  env.clock.advance(1000);
  expect(env.WebSocket.sockets.length).toBe(2);
  socket = env.WebSocket.sockets[1];
  handshake(env, socket);
  socket.message({ t: 'error', code: 'full', msg: 'Room is full' });
  env.clock.advance(60_000);
  expect(env.WebSocket.sockets.length).toBe(2);
  dispose();
});

test('messages from a replaced socket are ignored', () => {
  const env = fakeEnvironment();
  const dispose = connectBetterParty('ABCDE', IDENTITY, { bindings: env.bindings });
  const first = env.WebSocket.sockets[0];
  handshake(env, first);
  first.drop();
  env.clock.advance(1000);
  const second = env.WebSocket.sockets[1];
  handshake(env, second);
  // A late frame delivered on the old socket must not touch state or sends.
  first.message({ t: 'final', podium: [], standings: [] });
  expect(env.log.finals.length).toBe(0);
  expect(second.sent.length).toBeGreaterThan(0);
  dispose();
});

test('disposal stops timers, unregisters the sender and closes the socket', () => {
  const env = fakeEnvironment();
  const dispose = connectBetterParty('ABCDE', IDENTITY, { bindings: env.bindings });
  const socket = env.WebSocket.sockets[0];
  handshake(env, socket);
  expect(env.sender()).not.toBeNull();
  expect(env.clock.pendingCount()).toBeGreaterThan(0);
  dispose();
  expect(env.sender()).toBeNull();
  expect(env.clock.pendingCount()).toBe(0);
  expect(socket.readyState).toBe(3);
  expect(env.log.connection.at(-1).connected).toBe(false);
});

test('completion and forfeit are retransmitted after a same-round reconnect', () => {
  const env = fakeEnvironment();
  const dispose = connectBetterParty('ABCDE', IDENTITY, { bindings: env.bindings });
  let socket = env.WebSocket.sockets[0];
  handshake(env, socket);
  // The route finishes loading the level into the game store; the local game
  // then reaches a completed state and the completion frame goes out.
  env.gameStore.setState({
    level: { id: 'p' },
    strokes: 2,
    phase: 'holed',
    result: { strokes: 2, par: 3 },
  });
  const firstCompletion = socket.sent.filter((frame) => frame.t === 'f' || frame.f === 1);
  expect(firstCompletion.length).toBe(1);
  expect(firstCompletion[0]).toMatchObject({ f: 1, s: 2, p: 3, matchId: 'm1', holeIndex: 0 });
  // The connection drops after the write was accepted; the round is unchanged.
  socket.drop();
  env.clock.advance(1000);
  socket = env.WebSocket.sockets[1];
  handshake(env, socket);
  const retransmitted = socket.sent.filter((frame) => frame.f === 1);
  expect(retransmitted.length).toBe(1);
  expect(retransmitted[0]).toMatchObject({ f: 1, s: 2, p: 3, matchId: 'm1', holeIndex: 0 });
  // A further snapshot for the same round does not produce duplicates.
  socket.message({
    t: 'party',
    matchId: 'm1',
    holeIndex: 0,
    phase: 'playing',
    holeIds: ['p'],
    currentMap: { id: 'p' },
  });
  env.gameStore.setState({ strokes: 2 });
  expect(socket.sent.filter((frame) => frame.f === 1).length).toBe(1);
  dispose();
});

test('forfeit is retransmitted after a same-round reconnect and not duplicated', () => {
  const env = fakeEnvironment();
  const dispose = connectBetterParty('ABCDE', IDENTITY, { bindings: env.bindings });
  let socket = env.WebSocket.sockets[0];
  handshake(env, socket);
  env.gameStore.setState({ level: { id: 'p' }, phase: 'forfeit' });
  expect(socket.sent.some((frame) => frame.t === 'forfeit')).toBe(true);
  socket.drop();
  env.clock.advance(1000);
  socket = env.WebSocket.sockets[1];
  handshake(env, socket);
  expect(socket.sent.filter((frame) => frame.t === 'forfeit').length).toBe(1);
  env.gameStore.setState({ phase: 'forfeit' });
  expect(socket.sent.filter((frame) => frame.t === 'forfeit').length).toBe(1);
  dispose();
});

test('completion is not retransmitted when the round changed during the disconnect', () => {
  const env = fakeEnvironment();
  const dispose = connectBetterParty('ABCDE', IDENTITY, { bindings: env.bindings });
  let socket = env.WebSocket.sockets[0];
  handshake(env, socket);
  env.gameStore.setState({
    level: { id: 'p' },
    strokes: 2,
    phase: 'holed',
    result: { strokes: 2, par: 3 },
  });
  expect(socket.sent.some((frame) => frame.f === 1)).toBe(true);
  socket.drop();
  env.clock.advance(1000);
  socket = env.WebSocket.sockets[1];
  // The server moved to the next hole while the client was disconnected; the
  // local game state is still the completed previous hole.
  handshake(env, socket, { matchId: 'm1', holeIndex: 1, mapId: 'next' });
  // No completion may be sent from the stale game state.
  expect(socket.sent.some((frame) => frame.f === 1)).toBe(false);
  // The route reloads: map readiness clears, the new level loads and readiness
  // returns with a fresh game state. Installing the new level advances the
  // attempt sequence, which is what proves the stale attempt is gone.
  env.partyStore.setState({ mapReady: false });
  env.gameStore.setState({ level: { id: 'next' }, strokes: 0, phase: 'aiming', result: undefined });
  env.partyStore.setState({ mapReady: true });
  env.gameStore.setState({ strokes: 1, attemptSeq: 1 });
  expect(socket.sent.some((frame) => frame.f === 1)).toBe(false);
  expect(socket.sent.some((frame) => frame.t === 'prog')).toBe(true);
  dispose();
});

test('ghost positions from other players are forwarded and self positions are dropped', () => {
  const env = fakeEnvironment();
  const seen = [];
  env.bindings.updateGhost = (position) => seen.push(position);
  const dispose = connectBetterParty('ABCDE', IDENTITY, { bindings: env.bindings });
  const socket = env.WebSocket.sockets[0];
  handshake(env, socket);
  socket.message({
    t: 'b',
    s: [
      { id: 'conn-1', x: 1 },
      { id: 'other', x: 2 },
    ],
  });
  expect(seen).toEqual([{ id: 'other', x: 2 }]);
  dispose();
});

test('a prepared scene announces readiness for the current round exactly once', () => {
  const env = fakeEnvironment();
  const dispose = connectBetterParty('ABCDE', IDENTITY, { bindings: env.bindings });
  const socket = env.WebSocket.sockets[0];
  socket.open();
  expect(socket.sent[0]).toMatchObject({ t: 'join', scene: true });
  socket.message({ t: 'hello', id: 'conn-1', isHost: false, count: 1, role: 'player' });
  socket.message({
    t: 'party',
    matchId: 'm1',
    holeIndex: 0,
    phase: 'countdown',
    holeIds: ['p'],
    currentMap: { id: 'p' },
  });
  socket.message({ t: 'roster', players: [] });
  socket.message({ t: 'board', standings: [], alive: 1, holed: 0 });
  // The level is not prepared yet, so no readiness claim is possible.
  expect(socket.sent.some((frame) => frame.t === 'scene')).toBe(false);
  env.setSceneReadyLevelId('p');
  env.gameStore.setState({ strokes: 0 });
  const sceneFrames = socket.sent.filter((frame) => frame.t === 'scene');
  expect(sceneFrames.length).toBe(1);
  expect(sceneFrames[0]).toMatchObject({ matchId: 'm1', holeIndex: 0, levelId: 'p' });
  // Repeated store updates do not repeat the announcement.
  env.gameStore.setState({ strokes: 1 });
  expect(socket.sent.filter((frame) => frame.t === 'scene').length).toBe(1);
  // A new round with a new prepared level announces again.
  socket.message({
    t: 'party',
    matchId: 'm1',
    holeIndex: 1,
    phase: 'countdown',
    holeIds: ['p', 'q'],
    currentMap: { id: 'q' },
  });
  env.setSceneReadyLevelId('q');
  env.gameStore.setState({ strokes: 0 });
  const roundTwo = socket.sent.filter((frame) => frame.t === 'scene').at(-1);
  expect(roundTwo).toMatchObject({ matchId: 'm1', holeIndex: 1, levelId: 'q' });
  expect(socket.sent.filter((frame) => frame.t === 'scene').length).toBe(2);
  dispose();
});

test('readiness is never announced from a prepared level of a different course', () => {
  const env = fakeEnvironment();
  const dispose = connectBetterParty('ABCDE', IDENTITY, { bindings: env.bindings });
  const socket = env.WebSocket.sockets[0];
  socket.open();
  socket.message({ t: 'hello', id: 'conn-1', isHost: false, count: 1, role: 'player' });
  socket.message({
    t: 'party',
    matchId: 'm1',
    holeIndex: 0,
    phase: 'countdown',
    holeIds: ['p'],
    currentMap: { id: 'p' },
  });
  socket.message({ t: 'roster', players: [] });
  socket.message({ t: 'board', standings: [], alive: 1, holed: 0 });
  // The route still has the previous course prepared while it reloads.
  env.setSceneReadyLevelId('previous-course');
  env.gameStore.setState({ strokes: 0 });
  expect(socket.sent.some((frame) => frame.t === 'scene')).toBe(false);
  dispose();
});

test('a granted crown adopts the rotated capability; a revoked one drops it', () => {
  const env = fakeEnvironment();
  const dispose = connectBetterParty('ABCDE', IDENTITY, { bindings: env.bindings });
  const socket = env.WebSocket.sockets[0];
  socket.open();
  socket.message({ t: 'hello', id: 'conn-1', isHost: false, count: 2, role: 'player' });
  socket.message({ t: 'roster', players: [] });
  socket.message({ t: 'board', standings: [], alive: 1, holed: 0 });

  // The server rotates the capability whenever authority moves, so the frame
  // that grants the crown must also carry the new token.
  socket.message({ t: 'host-granted', fromUid: 'previous-host', token: 'capability-2' });
  expect(env.log.hostTokens).toEqual([['captured', 'capability-2']]);
  expect(env.log.identity.at(-1)).toMatchObject({ isHost: true });
  expect(env.log.identity.at(-1).count).toBe(2);
  expect(env.partyStore.state.isHost).toBe(true);

  // Losing the crown must not leave a stale capability that could still import
  // courses or re-claim authority.
  socket.message({ t: 'host-revoked', uid: 'new-host' });
  expect(env.log.hostTokens.at(-1)).toEqual(['dropped']);
  expect(env.partyStore.state.isHost).toBe(false);
  expect(env.log.identity.at(-1).count).toBe(2);

  // A frame without a token never invents one.
  socket.message({ t: 'host-granted', fromUid: 'previous-host' });
  expect(env.log.hostTokens.filter((entry) => entry[0] === 'captured').length).toBe(1);
  dispose();
});

test('a hand-over is what a reconnect claims with', () => {
  // The adapter caches the capability for its join frame, so a moved crown has
  // to update the cache as well as the stored copy.
  const env = fakeEnvironment();
  const dispose = connectBetterParty('ABCDE', IDENTITY, {
    bindings: env.bindings,
    hostToken: 'capability-1',
  });
  const first = env.WebSocket.sockets[0];
  first.open();
  expect(first.sent[0]).toMatchObject({ host: 'capability-1' });
  first.message({ t: 'hello', id: 'conn-1', isHost: true, count: 1, role: 'player' });
  first.message({ t: 'roster', players: [] });
  first.message({ t: 'board', standings: [], alive: 1, holed: 0 });
  first.message({ t: 'host-revoked', uid: 'new-host' });
  first.close(1006, 'network');
  env.clock.advance(1000);
  const second = env.WebSocket.sockets[1];
  second.open();
  // Without the crown the reconnect must not claim authority with the stale one.
  expect(second.sent[0].host).toBe(undefined);

  second.message({ t: 'hello', id: 'conn-2', isHost: false, count: 1, role: 'player' });
  second.message({ t: 'roster', players: [] });
  second.message({ t: 'board', standings: [], alive: 1, holed: 0 });
  second.message({ t: 'host-granted', fromUid: 'previous-host', token: 'capability-3' });
  second.close(1006, 'network');
  env.clock.advance(4000);
  const third = env.WebSocket.sockets[2];
  third.open();
  expect(third.sent[0]).toMatchObject({ host: 'capability-3' });
  dispose();
});

test('a half-open socket is abandoned once its heartbeats go unanswered', () => {
  // A dead peer on a live TCP path never delivers a close event, so the adapter
  // would otherwise stay "connected" forever and swallow every stroke the player
  // makes. Two unanswered heartbeats are the signal to reconnect.
  const env = fakeEnvironment();
  const dispose = connectBetterParty('ABCDE', IDENTITY, { bindings: env.bindings });
  const stalled = env.WebSocket.sockets[0];
  handshake(env, stalled);
  // The peer is gone but the socket still reports itself open.
  stalled.readyState = 1;
  expect(env.log.connection.at(-1).connected).toBe(true);

  env.clock.advance(15_000);
  expect(stalled.sent.filter((frame) => frame.t === 'ping').length).toBe(1);
  env.clock.advance(15_000);
  expect(stalled.sent.filter((frame) => frame.t === 'ping').length).toBe(2);
  // Still no reply, so the third heartbeat gives up instead of sending.
  env.clock.advance(15_000);
  expect(stalled.sent.filter((frame) => frame.t === 'ping').length).toBe(2);
  expect(env.log.connection.at(-1).connected).toBe(false);

  env.clock.advance(1000);
  const recovered = env.WebSocket.sockets[1];
  expect(recovered).toBeDefined();
  handshake(env, recovered);
  expect(env.log.connection.at(-1).connected).toBe(true);
  dispose();
});

test('any server frame clears the heartbeat debt', () => {
  const env = fakeEnvironment();
  const dispose = connectBetterParty('ABCDE', IDENTITY, { bindings: env.bindings });
  const socket = env.WebSocket.sockets[0];
  handshake(env, socket);
  env.clock.advance(15_000);
  expect(socket.sent.filter((frame) => frame.t === 'ping').length).toBe(1);
  // The pong arrives, so the next heartbeat starts from zero again.
  socket.message({ t: 'pong' });
  env.clock.advance(15_000);
  env.clock.advance(15_000);
  expect(socket.sent.filter((frame) => frame.t === 'ping').length).toBe(3);
  expect(env.log.connection.filter((entry) => entry.connected === false).length).toBe(1);
  expect(env.WebSocket.sockets.length).toBe(1);
  dispose();
});

test('a disconnect while the ball is still moving neither completes nor double-counts', () => {
  // The guest drops mid-swing: the shot is charging locally and no result
  // exists yet. Nothing may be reported for the round, and the reconnect must
  // wait for the fresh attempt rather than inventing a score.
  const env = fakeEnvironment();
  const dispose = connectBetterParty('ABCDE', IDENTITY, { bindings: env.bindings });
  let socket = env.WebSocket.sockets[0];
  handshake(env, socket);
  env.gameStore.setState({ level: { id: 'p' }, strokes: 1, phase: 'charging' });
  expect(socket.sent.filter((frame) => frame.t === 'prog').at(-1)).toMatchObject({ st: 1 });
  expect(socket.sent.some((frame) => frame.f === 1)).toBe(false);

  socket.drop();
  env.clock.advance(1000);
  socket = env.WebSocket.sockets[1];
  handshake(env, socket);
  // The same round is still in flight; the charge is reported again but nothing
  // is claimed as finished.
  expect(socket.sent.some((frame) => frame.f === 1)).toBe(false);
  expect(socket.sent.some((frame) => frame.t === 'forfeit')).toBe(false);
  // Finishing the swing after the reconnect delivers exactly one completion.
  env.gameStore.setState({ phase: 'holed', strokes: 2, result: { strokes: 2, par: 3 } });
  expect(socket.sent.filter((frame) => frame.f === 1).length).toBe(1);
  dispose();
});

test('a disconnect during the countdown does not claim a score or readiness from a stale level', () => {
  const env = fakeEnvironment();
  const dispose = connectBetterParty('ABCDE', IDENTITY, { bindings: env.bindings });
  let socket = env.WebSocket.sockets[0];
  socket.open();
  socket.message({ t: 'hello', id: 'conn-1', isHost: false, count: 1, role: 'player' });
  socket.message({
    t: 'party',
    matchId: 'm1',
    holeIndex: 0,
    phase: 'countdown',
    holeIds: ['p'],
    currentMap: { id: 'p' },
  });
  socket.message({ t: 'roster', players: [] });
  socket.message({ t: 'board', standings: [], alive: 1, holed: 0 });
  env.setSceneReadyLevelId('p');
  env.gameStore.setState({ strokes: 0 });
  expect(socket.sent.filter((frame) => frame.t === 'scene').length).toBe(1);

  socket.drop();
  env.clock.advance(1000);
  socket = env.WebSocket.sockets[1];
  socket.open();
  expect(socket.sent[0]).toMatchObject({ t: 'join', scene: true });
  socket.message({ t: 'hello', id: 'conn-2', isHost: false, count: 1, role: 'player' });
  socket.message({
    t: 'party',
    matchId: 'm1',
    holeIndex: 0,
    phase: 'countdown',
    holeIds: ['p'],
    currentMap: { id: 'p' },
  });
  socket.message({ t: 'roster', players: [] });
  socket.message({ t: 'board', standings: [], alive: 1, holed: 0 });
  // The round is the same one the level was prepared for, so readiness is
  // restated on the new connection: the server dropped the old document's
  // report along with the socket.
  expect(socket.sent.filter((frame) => frame.t === 'scene').length).toBe(1);
  expect(socket.sent.some((frame) => frame.f === 1)).toBe(false);
  dispose();
});

test('readiness is not restated for a round this connection has not prepared', () => {
  // The reconnect lands on a round the client has no level for yet. Claiming
  // readiness from the previous round's prepared level would start the countdown
  // before the course is on screen.
  const env = fakeEnvironment();
  const dispose = connectBetterParty('ABCDE', IDENTITY, { bindings: env.bindings });
  let socket = env.WebSocket.sockets[0];
  socket.open();
  socket.message({ t: 'hello', id: 'conn-1', isHost: false, count: 1, role: 'player' });
  socket.message({
    t: 'party',
    matchId: 'm1',
    holeIndex: 0,
    phase: 'countdown',
    holeIds: ['p', 'q'],
    currentMap: { id: 'p' },
  });
  socket.message({ t: 'roster', players: [] });
  socket.message({ t: 'board', standings: [], alive: 1, holed: 0 });
  env.setSceneReadyLevelId('p');
  env.gameStore.setState({ strokes: 0 });
  expect(socket.sent.filter((frame) => frame.t === 'scene').length).toBe(1);

  socket.drop();
  env.clock.advance(1000);
  socket = env.WebSocket.sockets[1];
  socket.open();
  socket.message({ t: 'hello', id: 'conn-2', isHost: false, count: 1, role: 'player' });
  // The server had advanced to hole 2 while the client was away, and the route
  // still has hole 1 prepared.
  socket.message({
    t: 'party',
    matchId: 'm1',
    holeIndex: 1,
    phase: 'countdown',
    holeIds: ['p', 'q'],
    currentMap: { id: 'q' },
  });
  socket.message({ t: 'roster', players: [] });
  socket.message({ t: 'board', standings: [], alive: 1, holed: 0 });
  env.gameStore.setState({ strokes: 1 });
  expect(socket.sent.some((frame) => frame.t === 'scene')).toBe(false);
  // Once the new course is prepared the report is made for that round.
  env.setSceneReadyLevelId('q');
  env.gameStore.setState({ strokes: 0 });
  const frames = socket.sent.filter((frame) => frame.t === 'scene');
  expect(frames.length).toBe(1);
  expect(frames[0]).toMatchObject({ matchId: 'm1', holeIndex: 1, levelId: 'q' });
  dispose();
});

test('a full reload during a round forfeits one hole and never resurrects the old score', () => {
  // A full reload is a new document: it has no local physics state, so the
  // server forfeits the hole and turns the player into a round spectator. The
  // new document must not push the previous document's score at the new round.
  const env = fakeEnvironment();
  const dispose = connectBetterParty('ABCDE', IDENTITY, { bindings: env.bindings });
  const first = env.WebSocket.sockets[0];
  handshake(env, first);
  env.gameStore.setState({ level: { id: 'p' }, strokes: 3, phase: 'charging' });

  // A reload is a fresh adapter instance with a new instance id, which is how
  // the server distinguishes it from a reconnect.
  dispose();
  const reloadedIdentity = { ...IDENTITY, instance: 'inst-2' };
  const disposeReload = connectBetterParty('ABCDE', reloadedIdentity, { bindings: env.bindings });
  env.clock.advance(1000);
  const second = env.WebSocket.sockets.at(-1);
  second.open();
  expect(second.sent[0]).toMatchObject({ t: 'join', instance: 'inst-2' });
  second.message({ t: 'hello', id: 'conn-2', isHost: false, count: 1, role: 'spectator' });
  second.message({
    t: 'party',
    matchId: 'm1',
    holeIndex: 0,
    phase: 'playing',
    holeIds: ['p'],
    currentMap: { id: 'p' },
  });
  second.message({ t: 'roster', players: [] });
  second.message({ t: 'board', standings: [], alive: 1, holed: 0 });
  // A spectator reports nothing: no progress and no completion from the state the
  // previous document was carrying.
  env.gameStore.setState({ strokes: 3, phase: 'charging' });
  expect(second.sent.some((frame) => frame.t === 'prog')).toBe(false);
  expect(second.sent.some((frame) => frame.f === 1)).toBe(false);
  expect(second.sent.some((frame) => frame.t === 'scene')).toBe(false);
  disposeReload();
});

test('a disconnect during the results phase settles rather than replaying the hole', () => {
  // Between holes the round is over for everybody: the client is on the results
  // screen and the server is loading the next course. A drop here must not
  // resend the previous hole's score or claim the next one is ready.
  const env = fakeEnvironment();
  const dispose = connectBetterParty('ABCDE', IDENTITY, { bindings: env.bindings });
  let socket = env.WebSocket.sockets[0];
  handshake(env, socket);
  env.gameStore.setState({
    level: { id: 'p' },
    strokes: 2,
    phase: 'holed',
    result: { strokes: 2, par: 3 },
  });
  socket.message({
    t: 'party',
    matchId: 'm1',
    holeIndex: 0,
    phase: 'hole-results',
    holeIds: ['p', 'q'],
    currentMap: { id: 'p' },
  });
  expect(socket.sent.filter((frame) => frame.f === 1).length).toBe(1);

  socket.drop();
  env.clock.advance(1000);
  socket = env.WebSocket.sockets[1];
  handshake(env, socket, { matchId: 'm1', holeIndex: 0, phase: 'hole-results', mapId: 'p' });
  // The hole is already scored, so the new connection claims nothing: a
  // completion is only meaningful while the round is being played. Restating it
  // here would be a stale result arriving after the server settled the hole.
  expect(socket.sent.filter((frame) => frame.f === 1).length).toBe(0);
  expect(socket.sent.some((frame) => frame.t === 'prog')).toBe(false);

  // The next hole arrives; the previous score must not travel with it.
  socket.message({
    t: 'party',
    matchId: 'm1',
    holeIndex: 1,
    phase: 'countdown',
    holeIds: ['p', 'q'],
    currentMap: { id: 'q' },
  });
  env.gameStore.setState({ strokes: 0, phase: 'aiming', result: undefined });
  expect(socket.sent.filter((frame) => frame.f === 1).length).toBe(0);
  expect(socket.sent.some((frame) => frame.t === 'forfeit')).toBe(false);
  dispose();
});

test('a restart of the same course does not let the finished attempt report again', () => {
  const env = fakeEnvironment();
  const dispose = connectBetterParty('ABCDE', IDENTITY, { bindings: env.bindings });
  const socket = env.WebSocket.sockets[0];
  handshake(env, socket);
  // The player holes out on hole 0 of course `p`.
  env.gameStore.setState({
    level: { id: 'p' },
    strokes: 2,
    phase: 'holed',
    result: { strokes: 2, par: 3 },
  });
  expect(socket.sent.filter((frame) => frame.f === 1).length).toBe(1);

  // The host restarts the hole. A restart mints a new match identity but keeps
  // the very same course, so the map ID alone cannot tell the two attempts apart.
  socket.message({
    t: 'party',
    matchId: 'm2',
    holeIndex: 0,
    phase: 'countdown',
    holeIds: ['p'],
    currentMap: { id: 'p' },
  });
  // The route reloads the identical course: readiness clears, the renderer tears
  // the old level down, and readiness returns before the fresh attempt is
  // installed. The game store therefore still holds the finished attempt.
  env.partyStore.setState({ mapReady: false });
  env.gameStore.setState({ strokes: 2 });
  env.partyStore.setState({ mapReady: true });
  socket.message({
    t: 'party',
    matchId: 'm2',
    holeIndex: 0,
    phase: 'playing',
    holeIds: ['p'],
    currentMap: { id: 'p' },
  });
  env.gameStore.setState({ strokes: 2 });

  // The previous attempt already reported; the restarted hole has not been played.
  expect(socket.sent.filter((frame) => frame.f === 1).length).toBe(1);

  // Installing the fresh attempt advances the sequence, which is what proves the
  // stale result is gone. Only then may the new attempt report.
  env.gameStore.setState({
    level: { id: 'p' },
    strokes: 1,
    phase: 'holed',
    result: { strokes: 1, par: 3 },
    attemptSeq: 1,
  });
  const frames = socket.sent.filter((frame) => frame.f === 1);
  expect(frames.length).toBe(2);
  expect(frames[1]).toMatchObject({ s: 1 });
  dispose();
});

test('a party that no longer exists stops retrying instead of looping forever', async () => {
  // A reclaimed or mistyped party refuses the upgrade, which arrives as an
  // abnormal close indistinguishable from a network blip. Without the probe the
  // page retries every fifteen seconds forever while claiming to reconnect.
  let probes = 0;
  const env = fakeEnvironment();
  env.bindings.probeRoom = async () => {
    probes += 1;
    return 404;
  };
  const dispose = connectBetterParty('ABCDE', IDENTITY, { bindings: env.bindings });
  env.WebSocket.sockets[0].open();
  // Never handshakes: the upgrade itself was refused.
  env.WebSocket.sockets[0].drop();
  await Bun.sleep(1);
  expect(probes).toBe(1);
  expect(env.log.connection.at(-1)).toEqual({
    connected: false,
    failure: 'This party no longer exists.',
  });
  // No reconnect is scheduled, however long we wait.
  env.clock.advance(60_000);
  expect(env.WebSocket.sockets.length).toBe(1);
  dispose();
});

test('a failed probe is treated as a connection problem, not a missing party', async () => {
  let probes = 0;
  const env = fakeEnvironment();
  env.bindings.probeRoom = async () => {
    probes += 1;
    throw new Error('network down');
  };
  const dispose = connectBetterParty('ABCDE', IDENTITY, { bindings: env.bindings });
  env.WebSocket.sockets[0].open();
  env.WebSocket.sockets[0].drop();
  await Bun.sleep(1);
  expect(probes).toBe(1);
  // The party may be fine; the network is not. Keep retrying.
  env.clock.advance(1000);
  expect(env.WebSocket.sockets.length).toBe(2);
  dispose();
});

test('a socket that handshaked and then dropped retries without probing', async () => {
  // The party was live a moment ago, so the close is a drop, not a refusal. An
  // HTTP round trip on every blip would be pure overhead.
  let probes = 0;
  const env = fakeEnvironment();
  env.bindings.probeRoom = async () => {
    probes += 1;
    return 200;
  };
  const dispose = connectBetterParty('ABCDE', IDENTITY, { bindings: env.bindings });
  const socket = env.WebSocket.sockets[0];
  handshake(env, socket);
  socket.drop();
  await Bun.sleep(1);
  expect(probes).toBe(0);
  env.clock.advance(1000);
  expect(env.WebSocket.sockets.length).toBe(2);
  dispose();
});

test('an outage warning does not survive the recovery that ends it', () => {
  // The overlay renders `connectionError || mapError || error`, so a warning left
  // in the runtime error field reappears under the next map load and reports a
  // problem that was resolved minutes ago.
  const env = fakeEnvironment();
  const dispose = connectBetterParty('ABCDE', IDENTITY, { bindings: env.bindings });
  const first = env.WebSocket.sockets[0];
  handshake(env, first);
  // Something went wrong while connected, then the socket dropped.
  first.message({ t: 'error', code: 'map-load-failed', msg: 'Could not load the course.' });
  expect(env.log.errors.at(-1)).toBe('Could not load the course.');
  first.drop();
  expect(env.log.connection.at(-1)).toEqual({ connected: false, failure: '' });

  env.clock.advance(1000);
  const second = env.WebSocket.sockets[1];
  handshake(env, second);
  // Recovery clears both the connection failure and the stale error.
  expect(env.log.connection.at(-1)).toEqual({ connected: true, failure: undefined });
  expect(env.log.errors.at(-1)).toBe('');
  dispose();
});

test('an error raised after synchronization is not cleared by unrelated traffic', () => {
  // Clearing on recovery must not become "clear on every frame": a host command
  // that was just refused has to stay readable.
  const env = fakeEnvironment();
  const dispose = connectBetterParty('ABCDE', IDENTITY, { bindings: env.bindings });
  const socket = env.WebSocket.sockets[0];
  handshake(env, socket);
  socket.message({ t: 'error', code: 'not-host', msg: 'Only the host can do that.' });
  socket.message({ t: 'roster', players: [] });
  socket.message({ t: 'board', standings: [], alive: 1, holed: 0 });
  expect(env.log.errors.at(-1)).toBe('Only the host can do that.');
  dispose();
});

test('presence is published every 100 ms, the cadence the pinned client uses', () => {
  // The relay rate is a compatibility contract: the original GameCanvas sends at
  // 100 ms and the ghost interpolation is tuned to it. Changing it needs measured
  // justification, so it is pinned here rather than left to drift.
  const env = fakeEnvironment();
  env.bindings.document.visibilityState = 'visible';
  const dispose = connectBetterParty('ABCDE', IDENTITY, { bindings: env.bindings });
  const socket = env.WebSocket.sockets[0];
  handshake(env, socket, {
    phase: 'playing',
    mapReady: true,
    holeIds: ['p'],
    currentMap: { id: 'p' },
  });
  env.partyStore.setState({ mapReady: true });
  const sent = () => socket.sent.filter((frame) => typeof frame.x === 'number').length;
  const before = sent();

  // Just under the interval: nothing yet.
  env.clock.advance(99);
  expect(sent()).toBe(before);
  // Crossing it publishes exactly one position.
  env.clock.advance(1);
  expect(sent()).toBe(before + 1);
  // The ball moves, and the next interval publishes again: a cadence rather than a
  // single send. An unchanged position is deliberately coalesced, so the ball has to
  // move for this to measure the interval rather than the dedupe.
  env.scene.ballPos.x = 4;
  env.clock.advance(100);
  expect(sent()).toBe(before + 2);
  dispose();
});
