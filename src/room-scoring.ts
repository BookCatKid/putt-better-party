/**
 * Scoring for the room state machine: the pure part of the leaderboard.
 *
 * Everything here is a function of the players map and the configuration —
 * nothing broadcasts, schedules or touches sockets — so the standings rules
 * are exercisable without a room. `Room` delegates to these and keeps the
 * stateful half (recording rounds, broadcasting boards) itself.
 */
import type { RoomConfig } from './domain.js';
import type { Player, Standing, TeamSummary } from './room-types.js';

/**
 * Team play is two fixed teams, formed from the players present when the match
 * starts. Fixed names and hues keep the scoreboard readable without a naming UI, and
 * two teams is the smallest arrangement where the rule is meaningful: with one team
 * there is nothing to beat.
 */
const TEAM_NAMES = ['Team 1', 'Team 2'] as const;
const TEAM_HUES = [205, 25] as const;

/**
 * A player's effective hole score: what they reported plus any host adjustment,
 * floored at one stroke once they holed and capped at the protocol maximum.
 */
export function effectiveStrokes(player: Player) {
  return Math.min(
    200,
    Math.max(player.success ? 1 : 0, player.strokes + (player.strokeAdjustment ?? 0)),
  );
}

/**
 * The one ranking rule, for players and teams alike.
 *
 * Survival first, then the lower score, then the faster time, then the name. The
 * pinned client indexes one medal per rank, so the order must be total and the ranks
 * must be dense; a name tiebreak is what guarantees both.
 */
export function compareStandings(
  left: {
    holesSurvived: number;
    alive: boolean;
    totalStrokes: number;
    totalTimeMs?: number;
    name: string;
  },
  right: {
    holesSurvived: number;
    alive: boolean;
    totalStrokes: number;
    totalTimeMs?: number;
    name: string;
  },
): number {
  return (
    right.holesSurvived - left.holesSurvived ||
    Number(right.alive) - Number(left.alive) ||
    left.totalStrokes - right.totalStrokes ||
    (left.totalTimeMs ?? 0) - (right.totalTimeMs ?? 0) ||
    left.name.localeCompare(right.name)
  );
}

/**
 * Tournament order: points, then match wins, then the lower cumulative score, then
 * name. Dense ranks are assigned after sorting so the client can render a numbered
 * list without inventing an order of its own.
 */
export function compareTournament(
  left: { points: number; wins: number; totalStrokes: number; name: string },
  right: { points: number; wins: number; totalStrokes: number; name: string },
): number {
  return (
    right.points - left.points ||
    right.wins - left.wins ||
    left.totalStrokes - right.totalStrokes ||
    left.name.localeCompare(right.name)
  );
}

/**
 * The two team slots and who is on each.
 *
 * Empty when team play is off or no match has started yet, which is what makes
 * `computeStandings` fall back to per-player rows rather than inventing teams.
 * Eliminated members stay in their team: their score is part of the team total.
 */
export function summarizeTeams(
  players: ReadonlyMap<string, Player>,
  config: RoomConfig,
): TeamSummary[] {
  if (!config.teams) {
    return [];
  }
  const members: string[][] = [[], []];
  for (const player of players.values()) {
    if (player.team === undefined || !player.participated) {
      continue;
    }
    members[player.team]?.push(player.uid);
  }
  return members
    .map((uids, index) => ({
      id: 'team-' + (index + 1),
      name: TEAM_NAMES[index],
      hue: TEAM_HUES[index],
      members: uids,
    }))
    .filter((team) => team.members.length > 0);
}

/**
 * Split the players present at the start into two teams, in join order.
 *
 * Alternating is deterministic and keeps the sides within one player of each other,
 * so nobody can claim the split was chosen to favour them.
 */
export function assignTeams(players: ReadonlyMap<string, Player>, config: RoomConfig) {
  if (!config.teams) {
    return;
  }
  const participants = [...players.values()].filter((player) => player.participated);
  participants.forEach((player, index) => {
    player.team = index % 2;
  });
}

/** Put a newcomer on the smaller team; ties go to the first team. */
export function assignTeam(
  players: ReadonlyMap<string, Player>,
  player: Player,
  config: RoomConfig,
) {
  if (!config.teams) {
    return;
  }
  const counts = [0, 0];
  for (const other of players.values()) {
    if (other === player || other.team === undefined || !other.participated) {
      continue;
    }
    counts[other.team] += 1;
  }
  player.team = counts[1] < counts[0] ? 1 : 0;
}

export function aliveTeamCount(players: ReadonlyMap<string, Player>, config: RoomConfig): number {
  return summarizeTeams(players, config).filter((team) =>
    team.members.some((uid) => players.get(uid)?.alive),
  ).length;
}

/**
 * Team standings: one row per team, aggregated from its members.
 *
 * A team survives as long as any member does, so `holesSurvived` is the furthest
 * any member got. The total is the sum of what its members actually scored -
 * elimination charges nothing, so a wiped team keeps only the holes it played.
 */
function teamStandings(players: ReadonlyMap<string, Player>, config: RoomConfig): Standing[] {
  return summarizeTeams(players, config)
    .map((team) => {
      const members = team.members
        .map((uid) => players.get(uid))
        .filter((player): player is Player => player !== undefined);
      const totalStrokes = members.reduce((total, player) => total + player.totalStrokes, 0);
      const totalTimeMs = members.reduce((total, player) => total + (player.totalTimeMs ?? 0), 0);
      return {
        uid: team.id,
        name: team.name,
        hue: team.hue,
        rank: 0,
        holesSurvived: Math.max(0, ...members.map((player) => player.holesSurvived)),
        totalStrokes,
        totalTimeMs,
        holeTimeMs: null,
        alive: members.some((player) => player.alive),
        strokes: 0,
        finished: !members.some((player) => player.alive),
        connected: members.some((player) => !!player.ws),
      };
    })
    .sort(compareStandings)
    .map((row, index) => ({ ...row, rank: index + 1 }));
}

/** The scoreboard rows: team aggregates when team play is on, per-player otherwise. */
export function computeStandings(
  players: ReadonlyMap<string, Player>,
  config: RoomConfig,
): Standing[] {
  if (config.teams && summarizeTeams(players, config).length) {
    return teamStandings(players, config);
  }
  return [...players.values()]
    .filter((player) => player.participated)
    .sort(compareStandings)
    .map((player, index) => ({
      uid: player.uid,
      name: player.name,
      hue: player.hue,
      ...(player.ball && !player.colorOverride ? { ball: player.ball } : {}),
      rank: index + 1,
      holesSurvived: player.holesSurvived,
      totalStrokes: player.totalStrokes,
      totalTimeMs: player.totalTimeMs ?? 0,
      holeTimeMs: player.holeTimeMs ?? null,
      alive: player.alive,
      strokes: effectiveStrokes(player),
      finished: player.done,
      connected: !!player.ws,
    }));
}
