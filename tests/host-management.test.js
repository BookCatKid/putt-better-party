import { expect, test } from 'bun:test';
import { Room } from '../src/room.js';

const maps = new Map(
  ['p', 'q', 'r'].map((id) => [id, { id, title: id, spec: { id, name: id, par: 3 } }]),
);
const socket = () => ({
  data: {},
  frames: [],
  send(message) {
    this.frames.push(JSON.parse(message));
  },
  close() {
    this.closed = true;
  },
});
function enter(room, name, host = false, identity = room.issue(name)) {
  const ws = socket();
  room.handle(ws, {
    t: 'join',
    ...identity,
    protocol: 2,
    ...(host ? { host: room.hostToken } : {}),
  });
  return { ws, identity, player: room.players.get(identity.uid) };
}
let sequence = 0;
function command(room, sender, action, args = {}) {
  const requestId = String(++sequence);
  room.handle(sender.ws, {
    t: 'host-action',
    action,
    requestId,
    matchId: room.matchId,
    holeIndex: room.holeIndex,
    ...args,
  });
  return requestId;
}
const ack = (sender, id) =>
  sender.ws.frames.find((frame) => frame.t === 'host-ack' && frame.requestId === id)?.ok;
const apply = (room, sender, action, args = {}) =>
  expect(ack(sender, command(room, sender, action, args))).toBe(true);
const target = (player, value) => ({ uid: player.identity.uid, value });
async function playing(room, host) {
  room.handle(host.ws, {
    t: 'config',
    config: {
      holes: 3,
      mapSource: 'picked',
      selectedHoleIds: ['p', 'q', 'r'],
      elimination: false,
      timerMs: 20000,
    },
  });
  room.handle(host.ws, { t: 'start' });
  for (let attempt = 0; attempt < 100 && room.phase !== 'playing'; attempt++) {
    await Bun.sleep(5);
  }
  expect(room.phase).toBe('playing');
}
test('fixed co-host role, owner-only delegation, persistent rename and ball color', () => {
  const room = new Room('ABCDE', maps);
  try {
    const host = enter(room, 'Host', true);
    const co = enter(room, 'Guest');
    const third = enter(room, 'Third');
    expect(ack(co, command(room, co, 'rename', target(third, 'New')))).toBe(false);
    apply(room, host, 'grant-cohost', target(co));
    apply(room, co, 'rename', target(third, 'New'));
    apply(room, co, 'color', target(third, 42));
    expect(third.player.name).toBe('New');
    expect(third.player.hue).toBe(42);
    expect(room.issued.get(third.identity.uid).colorOverride).toBe(true);
    expect(ack(co, command(room, co, 'kick', target(host)))).toBe(false);
    expect(ack(co, command(room, co, 'grant-cohost', target(third)))).toBe(false);
    room.close(co.ws);
    const returned = enter(room, 'Guest', false, co.identity);
    expect(returned.player.coHost).toBe(true);
    apply(room, host, 'revoke-cohost', target(returned));
    expect(ack(returned, command(room, returned, 'rename', target(third, 'Bad')))).toBe(false);
  } finally {
    room.dispose();
  }
});
test('kick revokes the session; ban rejects normalized names; lock rejects new users', () => {
  const room = new Room('ABCDE', maps);
  try {
    const host = enter(room, 'Host', true);
    const guest = enter(room, 'Guest');
    const banned = enter(room, 'Player');
    apply(room, host, 'kick', target(guest));
    expect(guest.ws.closed).toBe(true);
    expect(room.issued.has(guest.identity.uid)).toBe(false);
    expect(enter(room, 'Guest', false, guest.identity).ws.closed).toBe(true);
    apply(room, host, 'ban', target(banned));
    expect(() => room.issue('  PLAYER  ')).toThrow('banned');
    apply(room, host, 'lock-party');
    expect(() => room.issue('Someone')).toThrow('locked');
    expect(room.issue('Host', host.identity.uid, host.identity.session).uid).toBe(
      host.identity.uid,
    );
    apply(room, host, 'unlock-party');
    expect(room.issue('Someone').name).toBe('Someone');
  } finally {
    room.dispose();
  }
});
test('host lock, score adjustment, restart epoch, and spectator transitions', async () => {
  const room = new Room('ABCDE', maps, { countdown: 5, results: 1000 });
  try {
    const host = enter(room, 'Host', true);
    const guest = enter(room, 'Guest');
    await playing(room, host);
    room.handle(guest.ws, { t: 'prog', st: 4 });
    apply(room, host, 'adjust-strokes', target(guest, -2));
    expect(room.effectiveStrokes(guest.player)).toBe(2);
    expect(guest.player.strokes).toBe(4);
    apply(room, host, 'reset-strokes', target(guest));
    expect(room.effectiveStrokes(guest.player)).toBe(0);
    apply(room, host, 'lock-putting', target(guest));
    room.handle(guest.ws, { t: 'prog', st: 5 });
    expect(guest.player.strokes).toBe(4);
    apply(room, host, 'unlock-putting', target(guest));
    apply(room, host, 'restart-player', target(guest));
    expect(guest.player.strokes).toBe(0);
    expect(guest.player.attempt).toBe(1);
    const scope = { matchId: room.matchId, holeIndex: room.holeIndex };
    room.handle(guest.ws, { t: 'prog', st: 8, ...scope, attempt: 0 });
    expect(guest.player.strokes).toBe(0);
    room.handle(guest.ws, { t: 'scene', ...scope, attempt: 1, levelId: room.specs[0].id });
    expect(guest.player.sceneReady).toBe(true);
    room.handle(guest.ws, { t: 'prog', st: 1, ...scope, attempt: 1 });
    expect(guest.player.strokes).toBe(1);
    apply(room, host, 'spectate-player', target(guest));
    expect(guest.player.role).toBe('spectator');
    apply(room, host, 'revive-player', target(guest));
    expect(guest.player.role).toBe('player');
    expect(guest.player.attempt).toBe(2);
    apply(room, host, 'forfeit-player', target(guest));
    expect(guest.player.done).toBe(true);
    apply(room, host, 'admit-all');
    expect(guest.player.done).toBe(false);
    expect(room.recordEligible).toBe(false);
  } finally {
    room.dispose();
  }
});
test('pause freezes server clock, rejects shots, and resume shifts the deadline', async () => {
  const room = new Room('ABCDE', maps, { countdown: 5 });
  try {
    const host = enter(room, 'Host', true);
    const guest = enter(room, 'Guest');
    await playing(room, host);
    const startsAt = room.startsAt;
    apply(room, host, 'pause');
    const elapsed = room.elapsedHoleMs();
    await Bun.sleep(40);
    expect(room.elapsedHoleMs()).toBe(elapsed);
    room.handle(guest.ws, { t: 'prog', st: 3 });
    expect(guest.player.strokes).toBe(0);
    apply(room, host, 'resume');
    expect(room.pausedAt).toBe(null);
    expect(room.startsAt - startsAt).toBeGreaterThanOrEqual(35);
    apply(room, host, 'remaining-time', { value: 90 });
    expect(room.config.timerMs).toBe(90000);
    expect(room.roundTimerMs).toBe(20000);
    apply(room, host, 'force-next');
    expect(room.phase).toBe('hole-results');
    expect(room.roundHistory[0].status).toBe('completed');
  } finally {
    room.dispose();
  }
});
test('upcoming course edits are revision-checked, immutable prefix, and restart retains the edited list', async () => {
  const room = new Room('ABCDE', maps, {
    countdown: 5,
    loadMap: async (id) => ({ id, spec: { id, name: id, par: 3 } }),
  });
  try {
    const host = enter(room, 'Host', true);
    await playing(room, host);
    const revision = room.playlistRevision;
    apply(room, host, 'playlist', { ids: ['r', 'q'], revision });
    expect(room.holeIds).toEqual(['p', 'r', 'q']);
    expect(room.specs[0].id).toBe('p');
    expect(ack(host, command(room, host, 'playlist', { ids: ['q'], revision }))).toBe(false);
    const request = command(room, host, 'add-course', {
      value: 'extra',
      revision: room.playlistRevision,
    });
    for (let attempt = 0; attempt < 100 && ack(host, request) === undefined; attempt++) {
      await Bun.sleep(5);
    }
    expect(ack(host, request)).toBe(true);
    expect(room.holeIds).toEqual(['p', 'r', 'q', 'extra']);
    const match = room.matchId;
    apply(room, host, 'restart-match');
    expect(room.matchId).not.toBe(match);
    expect(room.holeIds).toEqual(['p', 'r', 'q', 'extra']);
    expect(room.recordEligible).toBe(false);
  } finally {
    room.dispose();
  }
});

test('a ban can be lifted by name, and only the host can lift it', () => {
  const room = new Room('ABCDE', maps);
  try {
    const host = enter(room, 'Host', true);
    const guest = enter(room, 'Guest');
    const banned = enter(room, 'Player');
    apply(room, host, 'ban', target(banned));
    expect(() => room.issue('Player')).toThrow('banned');

    // A banned player is removed from `players`, so there is no uid left to
    // target: the ban can only be lifted by the name that was banned.
    apply(room, host, 'unban', { value: '  player  ' });
    expect(room.issue('Player').name).toBe('Player');

    // A guest must not be able to lift someone else's ban.
    apply(room, host, 'ban', target(enter(room, 'Other')));
    expect(ack(guest, command(room, guest, 'unban', { value: 'Other' }))).toBe(false);
    expect(() => room.issue('Other')).toThrow('banned');

    // Lifting a name that is not banned is refused rather than reported as done.
    expect(ack(host, command(room, host, 'unban', { value: 'Nobody' }))).toBe(false);
  } finally {
    room.dispose();
  }
});
