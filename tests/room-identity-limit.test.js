import { test, expect } from 'bun:test';
import { Room } from '../src/room.js';

const maps = new Map([['p', { id: 'p', spec: { id: 'p', name: 'Example', par: 3 } }]]);
const socket = () => ({
  data: {},
  frames: [],
  send(serializedMessage) {
    this.frames.push(JSON.parse(serializedMessage));
  },
  close() {
    this.closed = true;
  },
});

/** A lobby guest who joined and left, leaving a dormant credential behind. */
function leaveLobbyGuest(room, name) {
  const identity = room.issue(name);
  const ws = socket();
  room.handle(ws, { t: 'join', ...identity, protocol: 2 });
  room.close(ws);
  return identity;
}

test('a full identity table makes room instead of closing the party', () => {
  const room = new Room('ABCDE', maps);
  try {
    const host = room.issue('Host');
    const hostSocket = socket();
    room.handle(hostSocket, { t: 'join', ...host, protocol: 2, host: room.hostToken });

    // 199 guests who joined and left. Without cleanup the next join would be
    // refused forever, which would silently close a long-lived party to newcomers.
    const left = [];
    for (let index = 0; index < 199; index += 1) {
      left.push(leaveLobbyGuest(room, 'Guest ' + index));
    }
    expect(room.issued.size).toBe(200);

    const newcomer = room.issue('Newcomer');
    expect(newcomer.name).toBe('Newcomer');
    expect(room.issued.size).toBe(200);

    // The host and everyone who is still present keep their credential.
    expect(room.issued.has(host.uid)).toBe(true);
    expect(room.issued.has(newcomer.uid)).toBe(true);
    // The oldest dormant one is the one forgotten, and it is gone.
    expect(room.issued.has(left[0].uid)).toBe(false);
    // The most recent returner still has theirs, so recent players are not the
    // ones sacrificed.
    expect(room.issued.has(left.at(-1).uid)).toBe(true);
  } finally {
    room.dispose();
  }
});

test('a disconnected player mid-match keeps the credential they will return with', async () => {
  const room = new Room('ABCDE', maps, { countdown: 5, results: 5 });
  try {
    const host = room.issue('Host');
    const hostSocket = socket();
    room.handle(hostSocket, {
      t: 'join',
      ...host,
      protocol: 2,
      host: room.hostToken,
      scene: true,
    });
    // A long party fills the identity table while still in the lobby, which is
    // where leavers are removed from `players` and their credentials go dormant.
    for (let index = 0; index < 199; index += 1) {
      leaveLobbyGuest(room, 'Guest ' + index);
    }
    expect(room.issued.size).toBe(200);

    room.handle(hostSocket, {
      t: 'config',
      config: { mapSource: 'picked', selectedHoleIds: ['p'], elimination: false },
    });
    room.handle(hostSocket, { t: 'start' });
    room.handle(hostSocket, { t: 'scene', matchId: room.matchId, holeIndex: 0, levelId: 'p' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    room.startPlay();
    expect(room.phase).toBe('playing');

    // Outside the lobby a player is *kept* in `players` when their socket drops,
    // precisely so they can reconnect and reclaim their score. Evicting their
    // credential would make that return land as a stranger with no score.
    const present = room.issue('Present');
    const presentSocket = socket();
    room.handle(presentSocket, { t: 'join', ...present, protocol: 2 });
    room.close(presentSocket);
    expect(room.players.has(present.uid)).toBe(true);
    expect(room.issued.has(present.uid)).toBe(true);

    // Another newcomer forces another eviction; it must take a dormant credential
    // and never the host's or the mid-match player's.
    room.issue('Newcomer');
    expect(room.issued.has(present.uid)).toBe(true);
    expect(room.issued.has(host.uid)).toBe(true);
    expect(room.issued.size).toBe(200);
  } finally {
    room.dispose();
  }
});
