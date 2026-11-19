// Packed samples: elapsed milliseconds, x/y/z in centimetres, discontinuity.
export const SAMPLE_FIELDS = 5;

/** @param {number[]} samples @param {number} timeMs */
export function sampleAt(samples, timeMs) {
  const count = samples.length / SAMPLE_FIELDS;
  if (!count || timeMs < samples[0]) {
    return null;
  }
  let low = 0;
  let high = count - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (samples[mid * SAMPLE_FIELDS] <= timeMs) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  const offset = low * SAMPLE_FIELDS;
  const next = offset + SAMPLE_FIELDS;
  let fraction = 0;
  if (next < samples.length && !samples[next + 4] && samples[next] - samples[offset] <= 500) {
    fraction = Math.min(1, (timeMs - samples[offset]) / (samples[next] - samples[offset]));
  }
  /** @param {number} index */
  const coordinate = (index) => {
    const start = samples[offset + index];
    return (start + (fraction ? (samples[next + index] - start) * fraction : 0)) / 100;
  };
  return { x: coordinate(1), y: coordinate(2), z: coordinate(3) };
}

/** @typedef {{at: number, nodes: string[]}} ReplayDeviceState */
/** @param {ReplayDeviceState[]} states @param {number} timeMs */
export function activeNodesAt(states, timeMs) {
  for (let index = states.length - 1; index >= 0; index--) {
    if (states[index].at <= timeMs) {
      return states[index].nodes;
    }
  }
  return [];
}

export function createReplayRecorder() {
  /** @type {string | null} */
  let key = null;
  /** @type {number[]} */
  let samples = [];
  /** @type {ReplayDeviceState[]} */
  let states = [];
  let lastAt = -1;
  /** @type {number | undefined} */
  let lastSequence;
  /** @type {string | null} */
  let lastNodes = null;
  return {
    /** @param {SnippetPartyState} party @param {SnippetGameState} game @param {SnippetScene} scene @param {number} now */
    sample(party, game, scene, now, force = false) {
      if (
        party.phase !== 'playing' ||
        !party.mapReady ||
        party.selfRole === 'spectator' ||
        !party.matchId ||
        !party.startAt ||
        !scene.ballPos ||
        game.level?.id !== party.currentMap?.id
      ) {
        return false;
      }
      const round = party.matchId + ':' + party.holeIndex;
      if (key !== round) {
        key = round;
        samples = [];
        states = [];
        lastAt = -1;
        lastSequence = undefined;
        lastNodes = null;
      }
      const at = Math.min(900000, Math.max(0, Math.round(now - party.startAt)));
      if (at <= lastAt || (!force && lastAt >= 0 && at - lastAt < 40)) {
        return false;
      }
      const { x, y, z } = scene.ballPos;
      if (![x, y, z].every((value) => Number.isFinite(value) && Math.abs(value) < 100000)) {
        return false;
      }
      // Keep memory bounded if the transport goes offline.
      if (samples.length >= 128 * SAMPLE_FIELDS) {
        samples.splice(0, SAMPLE_FIELDS);
      }
      const jump = lastAt < 0 || at - lastAt > 500 || scene.discontinuitySeq !== lastSequence;
      samples.push(at, Math.round(x * 100), Math.round(y * 100), Math.round(z * 100), Number(jump));
      lastAt = at;
      lastSequence = scene.discontinuitySeq;
      const nodes = [...(scene.activeEventNodes ?? [])].sort();
      const signature = JSON.stringify(nodes);
      if (signature !== lastNodes) {
        if (states.length >= 128) {
          states.shift();
        }
        states.push({ at, nodes });
        lastNodes = signature;
      }
      return true;
    },
    /** @param {SnippetPartyState} party @param {SnippetGameState} game @param {SnippetScene} scene */
    payload(party, game, scene, final = false) {
      if (key !== party.matchId + ':' + party.holeIndex || (!samples.length && !final)) {
        return undefined;
      }
      /** @type {{samples: number[], states: ReplayDeviceState[], native?: {path:number[], trajectory:number[], events: {sample:number,node:string}[]}}} */
      const result = { samples: samples.slice(), states: states.slice() };
      if (final && game.result && Array.isArray(scene.traj)) {
        result.native = {
          path: (game.result.path ?? []).slice(),
          trajectory: scene.traj.slice(),
          events: (scene.eventTimeline ?? []).map((event) => ({ ...event })),
        };
      }
      return result;
    },
    sent() {
      samples = [];
      states = [];
    },
  };
}
