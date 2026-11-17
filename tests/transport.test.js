import { test, expect } from 'bun:test';
import { connectBetterParty } from '../scripts/party-transport.js';

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
  const partyStore = fakeStore({
    matchId: null,
    holeIndex: 0,
    holeIds: [],
    phase: 'lobby',
    mapReady: false,
    selfRole: 'player',
  });
  const gameStore = fakeStore({ strokes: 0, phase: 'aiming', level: null });
  const settingsStore = fakeStore({ ghosts: true });
  const scene = { ballPos: { x: 1, y: 0, z: 2 }, pointer: { x: 0, z: 0, active: false } };
  const log = { connection: [], identity: [], errors: [], finals: [], acks: [] };
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
    registerSender: (sender) => {
      registeredSender = sender;
    },
    setIdentity: (isHost, count, role) => log.identity.push({ isHost, count, role }),
    updateParty: (message) => {
      const { t, ...rest } = message;
      partyStore.setState(rest);
    },
    setFlyCamera: () => {},
    setRoster: () => {},
    setBoard: () => {},
    setFinal: (final) => log.finals.push(final),
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
  expect(env.log.errors.length).toBe(0);
  expect(env.sender()({ t: 'ping' })).toBe(true);
  expect(socket.sent.length).toBe(framesBefore + 1);
  dispose();
});

test('reconnect backoff doubles from one second to a 15 second cap and resets after recovery', () => {
  const env = fakeEnvironment();
  const dispose = connectBetterParty('ABCDE', IDENTITY, { bindings: env.bindings });
  const delays = [];
  // The first socket exists from the initial connect; each drop schedules the next.
  env.WebSocket.sockets[0].open();
  env.WebSocket.sockets[0].drop();
  let expected = 1000;
  for (let attempt = 0; attempt < 6; attempt++) {
    env.clock.advance(expected);
    const socket = env.WebSocket.sockets[env.WebSocket.sockets.length - 1];
    socket.open();
    socket.drop();
    delays.push(expected);
    expected = Math.min(expected * 2, 15_000);
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
  // returns with a fresh game state. Still no stale completion.
  env.partyStore.setState({ mapReady: false });
  env.gameStore.setState({ level: { id: 'next' }, strokes: 0, phase: 'aiming', result: undefined });
  env.partyStore.setState({ mapReady: true });
  env.gameStore.setState({ strokes: 1 });
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
