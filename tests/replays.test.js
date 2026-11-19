import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { ReplayArchive, RoundReplayCapture, newReplayId } from '../src/replays.js';
import { Room } from '../src/room.js';
import { sampleAt, activeNodesAt, createReplayRecorder } from '../scripts/replay-timeline.js';

const host = { uid: 'private-id', name: 'Host', hue: 10 };
const guest = { uid: 'other-private-id', name: 'Guest', hue: 150 };
const level = { id: 'level', name: 'Fixture', par: 2 };
const batch = (samples, states = []) => ({ samples, states });
test('shared playback clock interpolates physical positions but never interpolates teleports or recording gaps', () => {
  const samples = [100, 0, 10, 0, 1, 150, 100, 20, 0, 0, 200, 500, 10, 0, 1, 1000, 1000, 10, 0, 0];
  expect(sampleAt(samples, 0)).toBeNull();
  expect(sampleAt(samples, 125)).toEqual({ x: 0.5, y: 0.15, z: 0 });
  expect(sampleAt(samples, 175)).toEqual({ x: 1, y: 0.2, z: 0 });
  expect(sampleAt(samples, 200)).toEqual({ x: 5, y: 0.1, z: 0 });
  expect(sampleAt(samples, 500)).toEqual({ x: 5, y: 0.1, z: 0 });
  expect(sampleAt(samples, 1500)).toEqual({ x: 10, y: 0.1, z: 0 });
  const states = [
    { at: 100, nodes: ['door'] },
    { at: 300, nodes: [] },
  ];
  expect(activeNodesAt(states, 0)).toEqual([]);
  expect(activeNodesAt(states, 200)).toEqual(['door']);
  expect(activeNodesAt(states, 400)).toEqual([]);
});
test('client recorder captures waiting and moving balls independently of presence; preserves native payload and resets between attempts', () => {
  const recorder = createReplayRecorder();
  const party = {
    phase: 'playing',
    mapReady: true,
    selfRole: 'player',
    matchId: 'first',
    holeIndex: 0,
    startAt: 1000,
    currentMap: level,
  };
  const game = { level, phase: 'aiming', result: null };
  const scene = {
    ballPos: { x: 1, y: 0.15, z: 2 },
    discontinuitySeq: 0,
    activeEventNodes: [],
    traj: [100, 15, 200],
    eventTimeline: [],
  };
  expect(recorder.sample(party, game, scene, 1000)).toBe(true);
  expect(recorder.sample(party, game, scene, 1050)).toBe(true);
  scene.ballPos.x = 3;
  scene.activeEventNodes = ['door'];
  recorder.sample(party, game, scene, 1100);
  const payload = recorder.payload(party, game, scene);
  expect(payload.samples).toEqual([0, 100, 15, 200, 1, 50, 100, 15, 200, 0, 100, 300, 15, 200, 0]);
  expect(payload.states).toEqual([
    { at: 0, nodes: [] },
    { at: 100, nodes: ['door'] },
  ]);
  recorder.sent();
  game.result = { path: [1, 2, 3, 2] };
  expect(recorder.payload(party, game, scene, true).native).toEqual({
    path: [1, 2, 3, 2],
    trajectory: [100, 15, 200],
    events: [],
  });
  party.matchId = 'second';
  party.startAt = 2000;
  recorder.sample(party, game, scene, 2000);
  expect(recorder.payload(party, game, scene).samples).toEqual([0, 300, 15, 200, 1]);
});
test('round archive validates sample limits, deduplicates retransmissions, isolates tracks and omits credentials', () => {
  const capture = new RoundReplayCapture(level);
  capture.append(host, batch([0, 10, 10, 20, 1, 50, 20, 10, 20, 0]), 100);
  capture.append(host, batch([0, 10, 10, 20, 1, 50, 20, 10, 20, 0]), 100);
  capture.append(host, batch([100, -50000000, 0, 0, 0]), 100);
  capture.append(
    guest,
    batch([20, 0, 10, 20, 1, 70, 100, 10, 20, 0], [{ at: 20, nodes: ['gate'] }]),
    100,
  );
  capture.append(
    host,
    {
      ...batch([100, 30, 10, 20, 0]),
      native: { path: [0, 0, 1, 1], trajectory: [10, 10, 20, 30, 10, 20], events: [] },
    },
    100,
    true,
  );
  const round = capture.finish(
    0,
    'Fixture',
    'completed',
    [
      { uid: host.uid, strokes: 1, status: 'holed', timeMs: 100 },
      { uid: guest.uid, strokes: 8, status: 'timeout', timeMs: 100 },
    ],
    new Map([
      [host.uid, host],
      [guest.uid, guest],
    ]),
  );
  expect(round.tracks[0].samples).toHaveLength(15);
  expect(round.tracks[1].samples).toHaveLength(10);
  expect(round.tracks[0].native.trajectory).toHaveLength(6);
  expect(round.durationMs).toBe(100);
  expect(JSON.stringify(round)).not.toContain('private-id');
  const db = new Database(':memory:');
  try {
    const archive = new ReplayArchive(db);
    const id = newReplayId();
    expect(id).toHaveLength(32);
    expect(archive.record(id, round)).toBe(true);
    expect(archive.summary(id).rounds[0].players[0]).toMatchObject({
      name: 'Host',
      recorded: true,
      native: true,
      strokes: 1,
    });
    expect(JSON.parse(Buffer.from(archive.round(id, 0)).toString())).toEqual(round);
    expect(new ReplayArchive(db).summary(id).rounds).toHaveLength(1);
    archive.prune(Date.now() + 8 * 86400000);
    expect(archive.summary(id)).toBeNull();
    expect(archive.round(id, 0)).toBeNull();
  } finally {
    db.close();
  }
});
test('round scoped capture accepts only authorized current players and publishes one replay per completed hole', async () => {
  const db = new Database(':memory:');
  const archive = new ReplayArchive(db);
  const room = new Room('ABCDE', new Map([['course', { id: 'course', spec: level }]]), {
    countdown: 1,
    results: 1,
    onReplayRound: archive.record.bind(archive),
  });
  const identity = room.issue('Host');
  const ws = { data: {}, send() {}, close() {} };
  try {
    room.handle(ws, { t: 'join', ...identity, host: room.hostToken, protocol: 2 });
    room.handle(ws, {
      t: 'config',
      config: { mapSource: 'picked', selectedHoleIds: ['course'], elimination: false },
    });
    room.handle(ws, { t: 'start' });
    for (let attempt = 0; attempt < 100 && room.phase !== 'playing'; attempt++) {
      await Bun.sleep(5);
    }
    expect(room.phase).toBe('playing');
    const scope = { matchId: room.matchId, holeIndex: 0 };
    room.handle(ws, {
      t: 'replay-samples',
      ...scope,
      matchId: 'wrong',
      replay: batch([0, 999, 0, 0, 0]),
    });
    room.handle(ws, { t: 'replay-samples', ...scope, replay: batch([0, 100, 10, 200, 1]) });
    room.handle(ws, { f: 1, s: 1, p: 2, ...scope, replay: batch([10, 200, 10, 300, 0]) });
    expect(room.snapshot().replayId).toBe(room.replayId);
    const data = JSON.parse(Buffer.from(archive.round(room.replayId, 0)).toString());
    expect(data.tracks[0].samples).toEqual([0, 100, 10, 200, 1, 10, 200, 10, 300, 0]);
    expect(data.tracks[0].strokes).toBe(1);
    expect(data.tracks[0].status).toBe('holed');
  } finally {
    room.dispose();
    db.close();
  }
});
