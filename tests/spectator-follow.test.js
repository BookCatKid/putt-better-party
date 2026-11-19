import { test, expect } from 'bun:test';
import {
  canWatch,
  followTarget,
  watchCandidates,
  watchChoice,
  liveGhost,
} from '../scripts/spectator-follow.js';

const player = (uid) => ({ uid, id: uid + '-socket', name: uid, role: 'player', connected: true });
const row = (uid) => ({ uid, alive: true, finished: false });
const party = () => ({
  active: true,
  phase: 'playing',
  selfRole: 'spectator',
  self: { uid: 'self' },
  matchId: 'match',
  holeIndex: 0,
  roster: [player('self'), player('first'), player('second')],
  board: { standings: [row('self'), row('first'), row('second')] },
});
const choose = (state, target) => {
  state.bpWatchChoice = { matchId: state.matchId, holeIndex: state.holeIndex, target };
};
test('observer camera is available only for spectators and finished players', () => {
  const state = party();
  expect(canWatch(state, 'aiming')).toBe(true);
  expect(followTarget(state, 'aiming').uid).toBe('first');
  state.selfRole = 'player';
  expect(followTarget(state, 'aiming')).toBeNull();
  expect(followTarget(state, 'rolling')).toBeNull();
  expect(followTarget(state, 'holed').uid).toBe('first');
  expect(followTarget(state, 'forfeit').uid).toBe('first');
  state.phase = 'countdown';
  expect(followTarget(state, 'holed')).toBeNull();
});
test('manual target follows stable identity across socket replacement and falls back on completion or disconnect', () => {
  const state = party();
  choose(state, 'second');
  expect(followTarget(state, 'aiming').id).toBe('second-socket');
  state.roster[2].id = 'replacement';
  expect(followTarget(state, 'aiming').id).toBe('replacement');
  state.board.standings[2].finished = true;
  expect(followTarget(state, 'aiming').uid).toBe('first');
  state.roster[1].connected = false;
  expect(followTarget(state, 'aiming')).toBeNull();
  expect(watchCandidates(state)).toEqual([]);
});
test('free camera is respected until the next round and choices never leak across matches', () => {
  const state = party();
  choose(state, 'free');
  expect(followTarget(state, 'aiming')).toBeNull();
  state.holeIndex++;
  expect(watchChoice(state)).toBe('auto');
  expect(followTarget(state, 'aiming').uid).toBe('first');
  choose(state, 'second');
  state.matchId = 'restart';
  expect(followTarget(state, 'aiming').uid).toBe('first');
});
test('camera uses exactly the rendered ghost coordinates and refuses stale or malformed data', () => {
  const ghost = { cx: 1, cy: 2, cz: 3, lastSeen: 1000 };
  const ghosts = new Map([['socket', ghost]]);
  expect(liveGhost(ghosts, 'socket', 2000)).toBe(ghost);
  expect(liveGhost(ghosts, 'socket', 5001)).toBeNull();
  expect(liveGhost(ghosts, 'missing', 2000)).toBeNull();
  ghost.cx = Infinity;
  expect(liveGhost(ghosts, 'socket', 2000)).toBeNull();
});
