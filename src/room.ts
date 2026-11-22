import { parseBallAppearance } from './ball-cosmetics.js';
import { isHostAction, normalizedName } from './host-actions.js';
import { JoinRefused } from './join-errors.js';
import { newReplayId, RoundReplayCapture, type ReplayRound } from './replays.js';
import { randomUUID, randomBytes, randomInt } from 'node:crypto';
import { logEvent } from './event-log.js';
import {
  MAP_SOURCE,
  LATE_JOIN,
  MAX_HISTORY_COURSES,
  MAX_MATCH_HISTORY,
  defaults,
  isRecord,
  errorMessage,
  type RoomConfig,
  type RoomPhase,
  type CourseIndex,
  type CourseSpecification,
  type PrepareMatch,
  type LoadCourse,
  type PublicCourse,
} from './domain.js';
import {
  aliveTeamCount,
  assignTeam,
  assignTeams,
  computeStandings,
  compareTournament,
  effectiveStrokes,
  summarizeTeams,
} from './room-scoring.js';
import { buildCheckpoint, restoreRoom } from './room-persistence.js';
import { normaliseShot } from './replay/constants.js';
import { preparedModelLoader } from './replay/models.js';
import { verifyReplayedRound, unverifiableReason } from './replay/verify.js';
import type {
  RoomSocket,
  Identity,
  Player,
  RoundRecord,
  RoundScore,
  RoundStatus,
  RoomOptions,
  RoomCheckpoint,
  BallPosition,
  PartySnapshot,
  RosterEntry,
  Standing,
  RateBudget,
  MatchSummary,
  TeamSummary,
  TournamentRow,
  TournamentState,
} from './room-types.js';
import type { BoardFrame, ServerFrame } from './protocol.js';

/**
 * A capability both for joining back and for holding the crown: 192 bits from
 * the CSPRNG, which is far beyond guessable. These are the two secrets in the
 * system, and their lifetimes are deliberate rather than forgotten:
 *
 *  - An identity session lives as long as the room does. It has to, because it
 *    is what a reloaded tab resumes with; expiring it would either strand a
 *    player mid-match or force a name prompt on refresh. The room itself is
 *    reclaimed after 30 minutes with nobody connected, which is the real bound.
 *  - The host capability is rotated on every hand-over, so a departed host's
 *    token stops working immediately rather than being inherited by whoever
 *    happens to hold the old one.
 *
 * Neither is ever projected outward: `roster`, `snapshot`, `board`,
 * `standings`, the admin view and the audit log all omit them, and a session is
 * delivered only in the response to the identity request that asked for it.
 * `tests/room.test.js` drives a whole party to prove that holds for every frame
 * and every projection, and `tests/admin.test.js` covers the admin view.
 */
const token = () => randomBytes(24).toString('base64url');

/** Draw one vote ticket uniformly; without any votes every course is eligible. */
export function drawWeightedCourse<Choice extends { votes: number }>(
  choices: Choice[],
  draw: (maximum: number) => number = randomInt,
): Choice {
  const total = choices.reduce((sum, choice) => sum + choice.votes, 0);
  if (!total) {
    return choices[draw(choices.length)];
  }
  let ticket = draw(total);
  for (const choice of choices) {
    if (ticket < choice.votes) {
      return choice;
    }
    ticket -= choice.votes;
  }
  throw new Error('Invalid weighted course draw');
}

/**
 * A per-connection ceiling on client frames, so one socket cannot spend the
 * whole room's CPU. Multiplayer play is not chatty: a client reports readiness
 * once per round, a stroke count when it changes, a few position updates per
 * second while aiming, and a completion at the end. The budget is therefore
 * sized well above real play and refilled continuously, so a correct client
 * never notices it, while a loop of frames is stopped instead of multiplied by
 * the number of players in the room.
 */
const MESSAGE_BURST = 120;
const MESSAGE_REFILL_PER_SECOND = 60;
/**
 * A frame that changes the server's view of a player and then fans out to every
 * other player is the expensive kind. It is what makes flooding worthwhile, so
 * it gets its own, much smaller budget: a player's stroke count can only change
 * when they take a stroke.
 */
const BOARD_BURST = 10;
const BOARD_REFILL_PER_SECOND = 4;

/**
 * Bytes queued for one socket before its presence updates are dropped.
 *
 * Presence is sent ten times a second per player, so a client on a slow link
 * accumulates a backlog that grows faster than it drains; continuing to queue
 * makes the delay permanent rather than temporary. Above this, that socket stops
 * receiving presence until it catches up. The figure is generous - a presence
 * frame is a few hundred bytes, so this is several seconds of updates - because
 * dropping them too eagerly makes ghosts stutter on links that are merely busy.
 */
const PRESENCE_BACKLOG_LIMIT = 64 * 1024;

/**
 * A tournament is a small fixed number of matches. Twenty is a generous evening and
 * keeps the accumulated table meaningful; the per-match history is bounded separately.
 */
const MIN_TOURNAMENT_ROUNDS = 2;
const MAX_TOURNAMENT_ROUNDS = 20;

/**
 * A token bucket: capacity is the burst, and it refills at a fixed rate. Time is
 * taken as a parameter rather than read here so the decision is the same in a
 * test as in the server.
 */
function freshBudget(capacity: number, now: number): RateBudget {
  return { tokens: capacity, updatedAt: now };
}
/** Spend one token if there is one; answers whether the frame may proceed. */
function spend(budget: RateBudget, capacity: number, perSecond: number, now: number): boolean {
  const elapsedSeconds = Math.max(0, now - budget.updatedAt) / 1000;
  budget.tokens = Math.min(capacity, budget.tokens + elapsedSeconds * perSecond);
  budget.updatedAt = now;
  if (budget.tokens < 1) {
    return false;
  }
  budget.tokens -= 1;
  return true;
}

/**
 * Round start waits for connected players to report their scene as prepared,
 * but never longer than this after the countdown elapses. Without the gate a
 * slow client's loading time is silently deducted from everybody's round;
 * without the bound one stalled or half-open client could hold the match.
 */
const READY_GRACE_MS = 10_000;
/**
 * A host whose connection drops keeps authority for this long, so a tunnel, a
 * refresh or a brief network blip does not hand the party to somebody else.
 * Deliberately leaving hands it over at once.
 */
const HOST_SUCCESSION_GRACE_MS = 30_000;
function isIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum
  );
}
function isPositionCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) < 1e5;
}
export class Room {
  readonly code: string;
  readonly catalog: CourseIndex;
  readonly countdown: number;
  readonly results: number;
  readonly votingMs: number;
  voteCourses: PublicCourse[][] = [];
  readonly voteRevealMs: number;
  vote: {
    id: string;
    target: number;
    endsAt: number;
    ballots: Map<string, string>;
    resolved?: NonNullable<PartySnapshot['vote']>;
  } | null = null;
  readonly onIdle: (room: Room) => void;
  readonly onChange: (room: Room) => void;
  readonly onFinalize: (room: Room) => void;
  readonly onReplayRound: RoomOptions['onReplayRound'];
  replayId: string | null = null;
  replayAvailable = false;
  replayCapture: RoundReplayCapture | null = null;
  recordEligible = true;
  readonly prepareMatch: PrepareMatch | null;
  readonly loadMap: LoadCourse | null;
  starting = false;
  loadingNext = false;
  nextLoadError: string | null = null;
  retryingNext = false;
  nextLoadGeneration = 0;
  recoveryNotice = false;
  randomSeen: string[] = [];
  lastActivity = Date.now();
  lastCheckpoint = 0;
  hostToken = token();
  hostUid: string | null = null;
  hostTransfer: { fromUid: string; toUid: string; at: number } | null = null;
  hostSuccessionTimer: ReturnType<typeof setTimeout> | undefined;
  issued = new Map<string, Identity>();
  bannedNames = new Set<string>();
  pausedAt: number | null = null;
  playlistRevision = 0;
  /**
   * Which preparation attempt is current.
   *
   * Preparation runs across upstream fetches and can be cancelled, so its result
   * needs an identity. `starting` cannot serve: it is a boolean that a cancel sets
   * false and a new start sets true again, so a stale attempt would see `true` and
   * start a match nobody asked for.
   */
  private prepareGeneration = 0;
  /**
   * Which prefetch attempt is current. A prefetch is speculative work whose result
   * is only valid while the same course still occupies the same slot, so it needs
   * the same identity a real load has.
   */
  private prefetchGeneration = 0;
  private playlistEditPending = false;
  players = new Map<string, Player>();
  phase: RoomPhase = 'lobby';
  roundHistory: RoundRecord[] = [];
  /**
   * Completed matches, newest first. Survives a rematch and a restart; only the
   * current match's `roundHistory` is cleared. Bounded so a long-lived party cannot
   * grow it without limit.
   */
  matchHistory: MatchSummary[] = [];
  /**
   * Tournament progress, kept across matches and rematches.
   *
   * `null` when tournament play is off. It is reset when the first match of a new
   * tournament starts, not when the previous one ends, so the final board and the
   * lobby can keep showing the result until the host starts again.
   */
  tournament: TournamentState | null = null;
  initialPlayers = 0;
  private readonly admittedParticipants = new Set<string>();
  config: RoomConfig = { ...defaults, selectedHoleIds: [] };
  /**
   * Increments on every accepted configuration change.
   *
   * Settings edits are partial merges, so the *server* never sees an out-of-order
   * write: frames arrive on one socket in order. Derived updates are different.
   * A playlist import or a generator run reads the configuration, awaits network
   * work, and then writes a whole playlist back. If a newer edit lands during
   * that wait, applying the older result would silently discard it — the classic
   * lost update. Callers capture this counter before awaiting and hand it back,
   * and `applyPlaylist` refuses if anything changed in between.
   *
   * Deliberately not persisted in the checkpoint. It only orders work within one
   * process lifetime, and a restore means the process that owned any in-flight
   * work is gone, so a fresh counter is correct rather than lossy.
   *
   * This is lobby configuration; `playlistRevision` covers a different scope, the
   * remaining holes edited during play, and increments on `startPrepared` and
   * `replaceUpcoming`. A lobby edit during a playlist import moves this counter
   * but not that one, which is why both exist.
   */
  configRevision = 0;
  holeIds: string[] = [];
  specs: CourseSpecification[] = [];
  holeIndex = 0;
  matchId: string | null = null;
  startsAt = 0;
  roundTimerMs = defaults.timerMs;
  /** The approved countdown must finish before play may begin. */
  playNotBefore = 0;
  /** Latest instant the start may wait for a client to report its scene. */
  readyDeadline = 0;
  positions = new Map<string, BallPosition>();
  timer: ReturnType<typeof setTimeout> | undefined;
  closed = false;

  constructor(
    code: string,
    catalog: CourseIndex,
    {
      countdown = 5000,
      results = 4000,
      votingMs = 15000,
      voteRevealMs = 3400,
      onIdle = () => {},
      onChange = () => {},
      onFinalize = () => {},
      onReplayRound,
      prepareMatch = null,
      loadMap = null,
    }: RoomOptions = {},
  ) {
    this.code = code;
    this.catalog = catalog;
    this.countdown = countdown;
    this.results = results;
    this.votingMs = votingMs;
    this.voteRevealMs = voteRevealMs;
    this.onIdle = onIdle;
    this.onChange = onChange;
    this.onFinalize = onFinalize;
    this.onReplayRound = onReplayRound;
    this.prepareMatch = prepareMatch;
    this.loadMap = loadMap;
  }

  private audit(event: string, details: Record<string, unknown> = {}) {
    logEvent(event, {
      room: this.code,
      matchId: this.matchId,
      holeIndex: this.holeIndex,
      courseId: this.holeIds[this.holeIndex] ?? null,
      phase: this.phase,
      ...details,
    });
  }

  /**
   * Forget the oldest credential that nobody could still be using.
   *
   * `issued` is insertion-ordered, so the first entry is the longest-held. Two
   * identities are never forgotten: the host's, because authority is bound to it,
   * and anyone still in `players`, because a disconnected player mid-match is kept
   * precisely so they can reconnect and reclaim their score.
   *
   * Everything else is a player who joined and left the lobby. Their credential
   * would have restored their old name and hue, so forgetting it is a small loss
   * rather than a broken return: they can join again as a new identity.
   */
  private evictDormantIdentity(): void {
    for (const uid of this.issued.keys()) {
      if (uid === this.hostUid || this.players.has(uid)) {
        continue;
      }
      this.issued.delete(uid);
      return;
    }
  }

  issue(name: unknown, uid?: unknown, session?: unknown, ball?: unknown): Identity {
    this.lastActivity = Date.now();
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 24) {
      throw new JoinRefused('invalid-name', 'Name must contain 1–24 characters');
    }
    const previous = typeof uid === 'string' ? this.issued.get(uid) : undefined;
    if (previous && previous.session === session) {
      return previous;
    }
    if (this.bannedNames.has(normalizedName(name))) {
      throw new JoinRefused('banned', 'This name is banned from the party.');
    }
    if (this.config.locked) {
      throw new JoinRefused('locked', 'This party is locked to existing players.');
    }
    if (uid && session) {
      throw new JoinRefused('session-expired', 'Session expired; join again with a new identity.');
    }
    if ([...this.players.values()].filter((player) => player.ws).length >= this.config.maxPlayers) {
      throw new JoinRefused('full', 'Party is full.');
    }
    if (this.issued.size >= 200) {
      // Issued credentials are what let a returning player keep their identity and
      // score, so they are never dropped while they might still be used. But a
      // long-lived party accumulates one per join, and without any cleanup the
      // 200th drop-in would permanently close the party to everyone new. Make room
      // first, and only refuse when nothing is safe to forget.
      this.evictDormantIdentity();
      if (this.issued.size >= 200) {
        throw new JoinRefused('identity-limit', 'Room identity limit reached');
      }
    }
    const identity = {
      uid: randomUUID(),
      session: token(),
      name: name.trim(),
      hue: randomInt(360),
      ...(ball !== undefined ? { ball: parseBallAppearance(ball) } : {}),
    };
    this.issued.set(identity.uid, identity);
    this.audit('identity_issued', { uid: identity.uid, name: identity.name });
    this.changed();
    return identity;
  }
  send(ws: RoomSocket, message: ServerFrame) {
    try {
      ws.send(JSON.stringify(message));
    } catch {}
  }
  /**
   * Deliver one frame to every connected player.
   *
   * The frame is serialized once and that string is handed to each socket. A
   * snapshot carries the current course specification, which is the whole level
   * geometry and by far the largest thing this service sends, so serializing per
   * socket made one broadcast cost grow with the player count: measured with
   * fifty players, a single frame took 0.146 ms and 144 KiB when each socket
   * serialized it, against 0.003 ms and the same 144 KiB serializing once.
   * Sockets only write bytes; none of them mutate the frame.
   */
  broadcast(message: ServerFrame) {
    const connected = [...this.players.values()].filter((player) => player.ws);
    if (!connected.length) {
      return;
    }
    let serialized: string;
    try {
      serialized = JSON.stringify(message);
    } catch {
      // A frame that cannot be serialized would fail for every socket, so there
      // is nothing to deliver and nothing useful to report per player.
      return;
    }
    // Presence is the only frame that fans out continuously and is worthless once
    // stale, so it is the only one a backed-up socket may miss. Results, scores,
    // rosters, errors and acknowledgements always go: dropping one of those would
    // leave a client with a state it can never reconcile.
    const lossy = message.t === 'b';
    for (const player of connected) {
      const ws = player.ws;
      if (!ws) {
        continue;
      }
      if (lossy && (ws.getBufferedAmount?.() ?? 0) > PRESENCE_BACKLOG_LIMIT) {
        continue;
      }
      try {
        ws.send(serialized);
      } catch {
        // One broken socket must not stop the others receiving the frame.
      }
    }
  }
  error(ws: RoomSocket, code: string, msg: string) {
    this.audit('room_error', { uid: ws.data.uid ?? null, code });
    this.send(ws, { t: 'error', code, msg });
  }
  playlistTitle(id: string) {
    return this.catalog.get(id)?.title || id;
  }
  snapshot(): PartySnapshot {
    return {
      t: 'party',
      pausedAt: this.pausedAt,
      playlistRevision: this.playlistRevision,
      recordEligible: this.recordEligible,
      replayId: this.replayAvailable ? this.replayId : null,
      recoveryNotice: this.recoveryNotice,
      randomHistoryCount: this.randomSeen.length,
      preparing: this.starting || this.loadingNext,
      awaitingPlayers: this.phase === 'countdown' ? this.playersAwaitingScene() : 0,
      nextError: this.nextLoadError,
      vote: this.voteSnapshot(),
      playlistTitles: Object.fromEntries(
        [
          ...this.config.selectedHoleIds,
          ...this.holeIds.slice(0, this.config.courseVoting ? this.holeIndex + 1 : undefined),
        ].map((id) => [id, this.playlistTitle(id)]),
      ),
      roundHistory: this.roundHistory,
      matchHistory: this.matchHistory,
      teams: this.teams(),
      tournament: this.config.tournament ? this.tournament : null,
      initialPlayers: this.initialPlayers,
      phase: this.phase,
      holeIndex: this.holeIndex,
      holeIds: this.holeIds,
      currentMap: this.vote?.target === 0 ? null : (this.specs[this.holeIndex] ?? null),
      matchId: this.matchId,
      config: structuredClone(this.config),
      startsAt: this.startsAt,
      timerMs: ['countdown', 'playing'].includes(this.phase)
        ? this.roundTimerMs
        : this.config.timerMs,
      now: Date.now(),
    };
  }
  /** Names of still-connected players the countdown gate is waiting for. */
  playersAwaitingScene() {
    return this.playersExpectedToLoad().filter((player) => !player.sceneReady).length;
  }
  spectatorReason(player: Player) {
    if (player.role !== 'spectator') {
      return null;
    }
    if (player.hostSpectator) {
      return 'host-spectator';
    }
    if (player.participated) {
      return player.alive ? 'round-forfeit' : 'eliminated';
    }
    if (player.joinAfterHole !== undefined && this.holeIndex + 1 < this.holeIds.length) {
      return 'next-hole';
    }
    return 'next-match';
  }

  /** Admit only first-time participants. Missing earlier holes never earn
   * scores, and an eliminated or deliberately departed identity cannot reset. */
  admitLatePlayer(player: Player) {
    if (this.admittedParticipants.has(player.uid)) {
      return;
    }
    this.admittedParticipants.add(player.uid);
    Object.assign(player, {
      role: 'player',
      alive: true,
      participated: true,
      roundSpectator: false,
      joinAfterHole: undefined,
      strokes: 0,
      done: false,
      success: false,
      sceneReady: false,
    });
    // A late joiner is balanced onto the smaller team rather than left off one.
    this.assignTeam(player);
    // Includes newly admitted players in the solo-vs-multiplayer elimination rule.
    this.initialPlayers++;
    this.audit('late_player_admitted', { uid: player.uid, name: player.name });
  }

  roster(): RosterEntry[] {
    return [...this.players.values()]
      .filter((player) => player.ws || this.phase !== 'lobby')
      .map((player) => ({
        id: player.id,
        uid: player.uid,
        name: player.name,
        hue: player.hue,
        ...(player.ball && !player.colorOverride ? { ball: player.ball } : {}),
        role: player.role,
        spectatorReason: this.spectatorReason(player),
        isHost: player.uid === this.hostUid,
        ready: player.ready,
        alive: player.alive,
        connected: !!player.ws,
        ...(player.colorOverride ? { colorOverride: true } : {}),
        ...(player.coHost ? { coHost: true } : {}),
        ...(player.hostSpectator ? { hostSpectator: true } : {}),
        ...(player.puttingLocked ? { puttingLocked: true } : {}),
        ...(player.attempt ? { attempt: player.attempt, resetPending: !player.sceneReady } : {}),
        ...(player.strokeAdjustment ? { strokeAdjustment: player.strokeAdjustment } : {}),
      }));
  }
  /** The two team slots and who is on each; see `summarizeTeams` for the rules. */
  teams(): TeamSummary[] {
    return summarizeTeams(this.players, this.config);
  }
  /** Split the match's participants into two teams; see `room-scoring`. */
  private assignTeams() {
    assignTeams(this.players, this.config);
  }
  /** Put a newcomer on the smaller team; ties go to the first team. */
  private assignTeam(player: Player) {
    assignTeam(this.players, player, this.config);
  }
  private aliveTeamCount(): number {
    return aliveTeamCount(this.players, this.config);
  }
  /** The scoreboard rows; see `computeStandings` for team aggregation and rank order. */
  standings(): Standing[] {
    return computeStandings(this.players, this.config);
  }
  board(): BoardFrame {
    const rows = [...this.players.values()].filter((player) => player.alive && player.participated);
    return {
      t: 'board',
      standings: this.standings(),
      alive: rows.length,
      holed: rows.filter((player) => player.success).length,
    };
  }
  rosterBroadcast() {
    this.broadcast({ t: 'roster', players: this.roster() });
  }
  state() {
    this.changed();
    this.broadcast(this.snapshot());
    this.rosterBroadcast();
    this.broadcast(this.board());
  }
  join(ws: RoomSocket, message: Record<string, unknown>) {
    const identity = typeof message.uid === 'string' ? this.issued.get(message.uid) : undefined;
    if (message.protocol !== 2 || !identity || message.session !== identity.session) {
      this.error(ws, 'invalid-join', 'Obtain a local join credential first.');
      ws.close(1008);
      return;
    }
    this.lastActivity = Date.now();
    let player = this.players.get(identity.uid);
    const reportsSceneReadiness = message.scene === true;
    const returning = !!player;
    const previouslyParticipated = !!player?.participated;
    const replacedSocket = !!player?.ws;
    const reload =
      !!player && player.instance !== undefined && player.instance !== message.instance;
    const claimsHost =
      message.host === this.hostToken && (!this.hostUid || this.hostUid === identity.uid);
    if (
      !player &&
      identity.uid !== this.hostUid &&
      !claimsHost &&
      [...this.players.values()].filter((member) => member.ws).length >= this.config.maxPlayers
    ) {
      this.error(ws, 'full', 'Room is full');
      ws.close(1008);
      return;
    }
    if (claimsHost) {
      this.hostUid = identity.uid;
      // The host came back inside the grace period, so keep the party theirs.
      this.clearHostSuccession();
    }
    if (!player) {
      player = {
        uid: identity.uid,
        name: identity.name,
        hue: identity.hue,
        ball: identity.ball,
        colorOverride: identity.colorOverride,
        coHost: identity.coHost && identity.uid !== this.hostUid,
        hostSpectator: identity.hostSpectator,
        puttingLocked: identity.puttingLocked,
        id: '',
        ws: null,
        role: this.phase === 'lobby' && !identity.hostSpectator ? 'player' : 'spectator',
        ready: false,
        alive: this.phase === 'lobby' && !identity.hostSpectator,
        participated: false,
        holesSurvived: 0,
        totalStrokes: 0,
        totalTimeMs: 0,
        strokes: 0,
        done: false,
        messageBudget: freshBudget(MESSAGE_BURST, Date.now()),
        boardBudget: freshBudget(BOARD_BURST, Date.now()),
      };
      this.players.set(identity.uid, player);
      if (
        this.config.lateJoin !== LATE_JOIN.NEVER &&
        !this.admittedParticipants.has(identity.uid) &&
        ['countdown', 'playing', 'hole-results'].includes(this.phase)
      ) {
        player.joinAfterHole = this.holeIndex;
      }
    }
    if (this.vote?.target === 0 && !player.participated && !player.hostSpectator) {
      // No hole has started yet: allow new arrivals to join the opening vote
      // and play from hole one, regardless of the mid-match admission policy.
      this.admitLatePlayer(player);
    }
    if (
      player.joinAfterHole !== undefined &&
      !player.hostSpectator &&
      !player.participated &&
      (this.phase === 'countdown' ||
        (this.phase === 'playing' &&
          (!this.roundTimerMs ||
            (this.pausedAt ?? Date.now()) < this.startsAt + this.roundTimerMs))) &&
      (this.config.lateJoin === LATE_JOIN.ALWAYS ||
        (this.phase === 'countdown' && player.joinAfterHole < this.holeIndex))
    ) {
      this.admitLatePlayer(player);
    }
    if (player.ws && player.ws !== ws) {
      const old = player.ws;
      player.ws = null;
      old.close(1000, 'Reconnected');
      this.broadcast({ t: 'bye', id: player.id });
      this.positions.delete(player.id);
    }
    if (
      reload &&
      previouslyParticipated &&
      ['countdown', 'playing'].includes(this.phase) &&
      player.participated &&
      player.alive &&
      this.phase === 'playing'
    ) {
      // A new document has lost its local physics state; do not allow restarting that hole.
      player.holeTimeMs ??= this.elapsedHoleMs();
      player.done = true;
      player.success = player.success === true;
      player.roundSpectator = true;
      player.role = 'spectator';
    }
    if (reload && (this.phase === 'countdown' || player.attempt)) {
      // The page reloaded, so the previous document's prepared scene is gone.
      player.sceneReady = false;
    }
    player.reportsSceneReadiness = reportsSceneReadiness;
    player.instance = message.instance;
    player.id = randomUUID();
    player.ws = ws;
    ws.data.uid = player.uid;
    this.audit('player_joined', {
      uid: player.uid,
      name: player.name,
      connectionId: player.id,
      host: player.uid === this.hostUid,
      role: player.role,
      returning,
      replacedSocket,
      reload,
    });
    this.changed();
    this.send(ws, {
      t: 'hello',
      id: player.id,
      isHost: player.uid === this.hostUid,
      count: this.roster().length,
      role: player.role,
    });
    if (this.vote || (!previouslyParticipated && player.participated)) {
      // Every client needs the updated participant count for elimination UI.
      this.broadcast(this.snapshot());
    } else {
      this.send(ws, this.snapshot());
    }
    this.rosterBroadcast();
    this.broadcast(this.board());
    if (this.phase === 'playing') {
      this.checkRoundDone();
    }
    if (this.phase === 'final') {
      const standings = this.standings();
      this.send(ws, { t: 'final', podium: standings.slice(0, 3), standings });
    }
  }
  /**
   * Hand host authority to another connected player. Authority moves in one
   * step: the new host can act immediately and the old host cannot act at all,
   * including through the connection it still holds. The capability token is
   * rotated and delivered to the new host over its own authenticated socket,
   * so the previous host's copy stops authorising anything.
   */
  transferHost(fromUid: string, toUid: string): boolean {
    const next = this.players.get(toUid);
    if (fromUid !== this.hostUid || !next || !next.ws || next.uid === fromUid) {
      return false;
    }
    const previous = this.players.get(fromUid);
    this.hostUid = toUid;
    next.coHost = false;
    const identity = this.issued.get(toUid);
    if (identity) {
      identity.coHost = false;
    }
    this.audit('host_transferred', { fromUid, toUid, reason: 'manual' });
    this.hostTransfer = { fromUid, toUid, at: Date.now() };
    this.clearHostSuccession();
    // Rotate the capability so the previous host's token cannot import maps or
    // re-claim authority after it has given the party away.
    this.hostToken = token();
    if (previous?.ws) {
      this.send(previous.ws, { t: 'host-revoked', uid: toUid });
    }
    // The new capability travels over the new host's own authenticated socket.
    this.send(next.ws, { t: 'host-granted', fromUid, token: this.hostToken });
    // Everybody sees the moved crown in the same snapshot and roster.
    this.state();
    return true;
  }
  /**
   * Connected candidates in join order, excluding `exceptUid`. Players are
   * preferred to spectators, who are only considered when nobody else is left:
   * a hostless party is worse than a spectator holding the crown, because that
   * spectator can then hand it on.
   */
  hostCandidates(exceptUid: string | null) {
    const eligible = [...this.players.values()].filter(
      (player) => player.ws && player.uid !== exceptUid,
    );
    const players = eligible.filter((player) => player.role !== 'spectator');
    return players.length > 0 ? players : eligible;
  }
  /**
   * A host that disconnected may legitimately be coming back, so succession
   * waits out a grace period. Deliberate departure skips the wait entirely.
   */
  scheduleHostSuccession() {
    this.clearHostSuccession();
    if (this.hostCandidates(this.hostUid).length === 0) {
      return;
    }
    this.hostSuccessionTimer = setTimeout(() => {
      this.hostSuccessionTimer = undefined;
      if (!this.closed && !this.players.get(this.hostUid ?? '')?.ws) {
        this.promoteSuccessor();
      }
    }, HOST_SUCCESSION_GRACE_MS);
  }
  clearHostSuccession() {
    clearTimeout(this.hostSuccessionTimer);
    this.hostSuccessionTimer = undefined;
  }
  /**
   * Move authority to the longest-present eligible player. The room calls this
   * only after the grace period, so a returning host always wins a race against
   * a slow reconnect. The promoted player inherits an identity, not the token.
   */
  promoteSuccessor(): string | null {
    const successor = this.hostCandidates(this.hostUid)[0];
    if (!successor) {
      return null;
    }
    const previousUid = this.hostUid;
    this.hostUid = successor.uid;
    successor.coHost = false;
    const identity = this.issued.get(successor.uid);
    if (identity) {
      identity.coHost = false;
    }
    this.audit('host_transferred', {
      fromUid: previousUid,
      toUid: successor.uid,
      reason: 'succession',
    });
    this.hostTransfer = { fromUid: previousUid ?? '', toUid: successor.uid, at: Date.now() };
    // Nobody can recover the departed host's capability, so rotate it instead.
    this.hostToken = token();
    this.send(successor.ws as RoomSocket, {
      t: 'host-granted',
      fromUid: previousUid,
      token: this.hostToken,
    });
    this.state();
    return successor.uid;
  }
  /**
   * Remove a player who explicitly left. The host hand-over is immediate because
   * the departure is unambiguous, unlike a dropped connection.
   */
  leave(ws: RoomSocket, player: Player) {
    const wasHost = player.uid === this.hostUid;
    this.audit('player_disconnected', {
      uid: player.uid,
      name: player.name,
      connectionId: player.id,
      role: player.role,
      strokes: player.strokes,
      finished: player.done,
      deliberate: true,
    });
    this.players.delete(player.uid);
    this.positions.delete(player.id);
    ws.data.uid = null;
    this.broadcast({ t: 'bye', id: player.id });
    ws.close(1000, 'Left party');
    if (wasHost) {
      this.clearHostSuccession();
      this.promoteSuccessor();
    }
    this.vote?.ballots.delete(player.uid);
    this.broadcastVote();
    this.rosterBroadcast();
    this.changed();
    this.onIdle(this);
  }
  close(ws: RoomSocket) {
    const player = this.players.get(ws.data.uid ?? '');
    if (!player || player.ws !== ws) {
      return;
    }
    this.audit('player_disconnected', {
      uid: player.uid,
      name: player.name,
      connectionId: player.id,
      role: player.role,
      strokes: player.strokes,
      finished: player.done,
    });
    player.ws = null;
    this.broadcastVote();
    this.lastActivity = Date.now();
    this.positions.delete(player.id);
    this.broadcast({ t: 'bye', id: player.id });
    if (this.phase === 'lobby' && player.uid !== this.hostUid) {
      this.players.delete(player.uid);
    }
    this.rosterBroadcast();
    // The roster broadcast above carries `connected`, but the in-game HUD and the
    // results list both read the *board*, which is only sent when something is
    // scored. Without this, a player who drops mid-hole stays "present" on the
    // live standings until the next stroke or hole boundary repaints it.
    this.broadcast(this.board());
    this.changed();
    if (player.uid === this.hostUid) {
      // An outage may be temporary, so the crown waits rather than moving at once.
      this.scheduleHostSuccession();
    }
    this.onIdle(this);
  }
  handle(ws: RoomSocket, message: unknown) {
    if (!isRecord(message)) {
      return;
    }
    if (!ws.data.uid) {
      if (message.t === 'join') {
        this.join(ws, message);
      }
      return;
    }
    const player = this.players.get(ws.data.uid ?? '');
    if (!player || player.ws !== ws) {
      return;
    }
    this.lastActivity = Date.now();
    const host = player.uid === this.hostUid;
    const manager = host || player.coHost === true;
    const now = Date.now();
    if (!spend(player.messageBudget, MESSAGE_BURST, MESSAGE_REFILL_PER_SECOND, now)) {
      // Dropping rather than answering is deliberate: a client that is flooding
      // must not be able to make the server write back to it. The first frame
      // over budget is reported so an honest client with a real bug can see it.
      if (!player.messageBudgetReported) {
        player.messageBudgetReported = true;
        this.audit('message_budget_exhausted', { uid: player.uid, kind: message.t ?? null });
      }
      return;
    }
    if (
      (message.t === 'prog' ||
        message.t === 'forfeit' ||
        message.t === 'replay-samples' ||
        message.t === 'shot' ||
        message.f === 1 ||
        'x' in message) &&
      ('matchId' in message || 'holeIndex' in message) &&
      (message.matchId !== this.matchId || message.holeIndex !== this.holeIndex)
    ) {
      this.audit('stale_round_message', {
        uid: player.uid,
        kind: message.f === 1 ? 'finish' : message.t,
      });
      return;
    }
    if (
      (message.t === 'prog' ||
        message.t === 'forfeit' ||
        message.t === 'replay-samples' ||
        message.t === 'shot' ||
        message.f === 1 ||
        'x' in message) &&
      player.attempt &&
      (message.attempt !== player.attempt || !player.sceneReady)
    ) {
      return;
    }
    switch (message.t) {
      case 'join':
        return;
      case 'replay-samples':
        if (
          message.matchId === this.matchId &&
          message.holeIndex === this.holeIndex &&
          this.playable(player)
        ) {
          this.replayCapture?.append(player, message.replay, this.elapsedHoleMs());
        }
        return;
      case 'shot': {
        // The exact input of the stroke the client is taking, sent before the
        // trajectory it produces is reported. Recording it here is what lets the
        // server replay the shot and check the result it is asked to believe.
        // A shot that fails validation is not an error — an old client simply
        // never sends the frame — it is only dropped from the record.
        if (!this.playable(player) || player.puttingLocked) {
          return;
        }
        const shot = normaliseShot({ dir: message.dir, power: message.power });
        if (shot) {
          this.replayCapture?.recordShot(player, shot);
        }
        return;
      }
      case 'course-vote':
        return this.castVote(player, message);
      case 'ready':
        if (this.phase === 'lobby' && typeof message.v === 'boolean') {
          if (player.ready !== message.v) {
            this.audit('player_ready', { uid: player.uid, ready: message.v });
          }
          player.ready = message.v;
          this.rosterBroadcast();
        }
        return;
      case 'scene':
        // The original client's lobby ready flag and its renderer readiness are
        // different signals, so they use different frames.
        return this.acknowledgeScene(ws, message, player);
      case 'config':
        if (!host || this.phase !== 'lobby') {
          return this.error(ws, 'not-host', 'Only the host can configure the lobby.');
        }
        return this.configure(ws, message.config);
      case 'start':
        if (host && this.phase === 'lobby') {
          this.start(ws);
        }
        return;
      case 'ping':
        if (this.lastActivity - (this.lastCheckpoint ?? 0) > 60000) {
          this.lastCheckpoint = this.lastActivity;
          this.changed();
        }
        return this.send(ws, { t: 'pong' });
      case 'host-action': {
        const ack = (ok: boolean, msg?: string) => {
          if (typeof message.requestId === 'string' && message.requestId.length <= 80) {
            this.send(ws, { t: 'host-ack', requestId: message.requestId, ok, msg });
          }
        };
        if (!manager) {
          this.error(ws, 'not-host', 'Only the host or a co-host can manage the party.');
          return ack(false, 'Only the host can manage the party.');
        }
        // A hand-over is a party-level action, not a round action: it stays
        // meaningful between rounds and in the lobby, where there is no round
        // identity to match.
        if (
          message.action !== 'transfer-host' &&
          (message.matchId !== this.matchId || message.holeIndex !== this.holeIndex)
        ) {
          return ack(false, 'The round changed. Try again.');
        }
        const action = isHostAction(message.action) ? message.action : 'unknown';
        if (action === 'unknown') {
          return ack(false, 'Unknown host action.');
        }
        if (!host && ['transfer-host', 'grant-cohost', 'revoke-cohost'].includes(action)) {
          return ack(false, 'Only the host can change party authority.');
        }
        const actionMatch = this.matchId;
        const actionHole = this.holeIndex;
        this.audit('host_action_requested', {
          uid: player.uid,
          action,
          ...(typeof message.seconds === 'number' ? { seconds: message.seconds } : {}),
        });
        const complete = (ok: boolean) => {
          this.audit('host_action_result', {
            uid: player.uid,
            action,
            accepted: ok,
            previousMatchId: actionMatch,
            previousHoleIndex: actionHole,
          });
          return ack(ok, ok ? undefined : 'That action is not available right now.');
        };
        if (action === 'add-course') {
          void this.addUpcomingCourse(player, message).then(complete, () => complete(false));
          return;
        }
        return complete(this.hostAction(ws, message));
      }
      case 'rematch':
        if (host && this.phase === 'final') {
          this.reset();
        }
        return;
      case 'leave':
        // A deliberate departure is not an outage: hand the crown on at once
        // rather than making the remaining players wait out the grace period.
        this.leave(ws, player);
        return;
      case 'prog':
        if (
          this.playable(player) &&
          !player.puttingLocked &&
          isIntegerInRange(message.st, 0, 200)
        ) {
          // A progress report is a level, not an event: repeating the count
          // already recorded changes nothing, so it must not cost a board
          // broadcast to every player. Without this, one client could make the
          // server serialize and fan out the standings as fast as it can write.
          if (player.strokes === message.st) {
            return;
          }
          // A board broadcast is the expensive kind, so a player cannot change
          // their reported count faster than they could take real strokes.
          if (!spend(player.boardBudget, BOARD_BURST, BOARD_REFILL_PER_SECOND, Date.now())) {
            return;
          }
          this.audit('stroke_count', {
            uid: player.uid,
            previous: player.strokes,
            strokes: message.st,
          });
          player.strokes = message.st;
          this.broadcast(this.board());
        }
        return;
      case 'forfeit':
        if (this.playable(player)) {
          this.replayCapture?.append(player, message.replay, this.elapsedHoleMs(), true);
          this.finish(player, false);
        }
        return;
      default:
        break;
    }
    if (message.f === 1) {
      if (
        this.playable(player) &&
        (!player.puttingLocked || message.s === player.strokes) &&
        isIntegerInRange(message.s, Math.max(1, player.strokes), 200) &&
        message.p === this.specs[this.holeIndex]?.par
      ) {
        // A finish frame names the number of strokes it claims. When the client
        // also sent `shot` frames, that number is checkable against the inputs
        // the server recorded. A mismatch is reported, never enforced: an old
        // client sends no shot frames at all, and a legitimate restart can reset
        // one side first, so rejecting on this would fail honest players.
        const recordedShots = this.replayCapture?.recordedShotCount(player) ?? 0;
        if (recordedShots > 0 && recordedShots !== message.s) {
          this.audit('shot_count_mismatch', {
            uid: player.uid,
            reported: message.s,
            recorded: recordedShots,
          });
        }
        player.strokes = message.s;
        this.replayCapture?.append(player, message.replay, this.elapsedHoleMs(), true);
        this.finish(player, true);
      }
      return;
    }
    if (
      player.role === 'player' &&
      isPositionCoordinate(message.x) &&
      isPositionCoordinate(message.y) &&
      isPositionCoordinate(message.z) &&
      isPositionCoordinate(message.px) &&
      isPositionCoordinate(message.pz) &&
      (message.c === 0 || message.c === 1) &&
      (message.m === 0 || message.m === 1)
    ) {
      if (now - (player.lastPosition ?? 0) < 40) {
        return;
      }
      player.lastPosition = now;
      this.positions.set(player.id, {
        id: player.id,
        x: message.x,
        y: message.y,
        z: message.z,
        px: message.px,
        pz: message.pz,
        c: message.c,
        m: message.m,
        ...(isPositionCoordinate(message.d) ? { d: message.d } : {}),
      });
    }
  }
  configure(ws: RoomSocket, configuration: unknown) {
    if (this.starting) {
      return this.error(ws, 'starting', 'Please wait while courses are loading.');
    }
    if (!isRecord(configuration)) {
      return;
    }
    const candidate: Record<string, unknown> = { ...this.config };
    for (const key of [
      'holes',
      'timerMs',
      'elimination',
      'maxPlayers',
      'mapSource',
      'selectedHoleIds',
      'locked',
      'excludeDaily',
      'lateJoin',
      'courseVoting',
      'teams',
      'tournament',
      'tournamentRounds',
    ]) {
      if (key in configuration) {
        candidate[key] = configuration[key];
      }
    }
    if (
      !isIntegerInRange(candidate.timerMs, 0, 86_400_000) ||
      typeof candidate.elimination !== 'boolean' ||
      !isIntegerInRange(candidate.maxPlayers, 1, 50) ||
      typeof candidate.locked !== 'boolean' ||
      typeof candidate.excludeDaily !== 'boolean' ||
      typeof candidate.courseVoting !== 'boolean' ||
      typeof candidate.teams !== 'boolean' ||
      typeof candidate.tournament !== 'boolean' ||
      !isIntegerInRange(candidate.tournamentRounds, MIN_TOURNAMENT_ROUNDS, MAX_TOURNAMENT_ROUNDS) ||
      (candidate.lateJoin !== LATE_JOIN.NEVER &&
        candidate.lateJoin !== LATE_JOIN.NEXT_HOLE &&
        candidate.lateJoin !== LATE_JOIN.ALWAYS) ||
      (candidate.mapSource !== MAP_SOURCE.RANDOM && candidate.mapSource !== MAP_SOURCE.PICKED) ||
      !Array.isArray(candidate.selectedHoleIds) ||
      candidate.selectedHoleIds.some((id) => typeof id !== 'string' || !this.catalog.has(id))
    ) {
      return this.error(ws, 'invalid-config', 'Invalid configuration or unknown public map.');
    }
    const next: RoomConfig = {
      holes: this.config.holes,
      timerMs: candidate.timerMs,
      elimination: candidate.elimination,
      maxPlayers: candidate.maxPlayers,
      mapSource: candidate.mapSource,
      selectedHoleIds: candidate.selectedHoleIds,
      locked: candidate.locked,
      excludeDaily: candidate.excludeDaily,
      randomHoles: this.config.randomHoles,
      lateJoin: candidate.lateJoin,
      courseVoting: candidate.courseVoting && candidate.mapSource === MAP_SOURCE.RANDOM,
      teams: candidate.teams,
      tournament: candidate.tournament,
      tournamentRounds: candidate.tournamentRounds,
    };
    if (next.mapSource === MAP_SOURCE.RANDOM) {
      const count = 'holes' in configuration ? configuration.holes : this.config.randomHoles;
      if (!isIntegerInRange(count, 1, 10_000)) {
        return this.error(ws, 'invalid-config', 'Random matches must contain 1–10,000 holes.');
      }
      next.randomHoles = count;
      next.holes = count;
    } else {
      next.holes = Math.max(1, next.selectedHoleIds.length);
    }
    if (!next.tournament) {
      // Progress for a rule that is no longer on would be stale, and turning it back
      // on should start cleanly rather than resume a forgotten table.
      this.tournament = null;
    }
    this.config = next;
    this.configRevision += 1;
    this.audit('configuration_changed', { uid: ws.data.uid, config: next });
    this.changed();
    this.broadcast(this.snapshot());
  }
  /**
   * Apply a playlist computed from network work, but only if nothing changed
   * while it was in flight.
   *
   * A playlist import or generator run reads the configuration, awaits upstream
   * fetches, then writes the whole playlist back. If the host edited anything
   * during that wait, writing the older result would discard their edit with no
   * error shown — the request would report success and the newer state would
   * simply disappear. `revision` is the counter captured before the await.
   *
   * Returns false when the write was refused. The caller turns that into an
   * explicit conflict, because a silent no-op is the failure this guards against.
   */
  applyPlaylist(ws: RoomSocket, selectedHoleIds: string[], revision: number) {
    if (revision !== this.configRevision) {
      this.error(
        ws,
        'config-changed',
        'Settings changed while the playlist was loading. Try again to keep both.',
      );
      return false;
    }
    const before = this.configRevision;
    this.configure(ws, { mapSource: MAP_SOURCE.PICKED, selectedHoleIds });
    // `configure` rejects an unknown course without changing anything, so a
    // revision that did not move means the playlist was refused and the host has
    // already been told why.
    return this.configRevision !== before;
  }
  /**
   * Abandon a preparation that is still running.
   *
   * Course loading can stall on an upstream fetch with no bound of its own, and
   * while it runs the lobby is locked: settings cannot change and the match cannot
   * start. Without a cancel the only way out was to wait or reload the page, and a
   * reload leaves the room still preparing for as long as the fetch hangs.
   */
  cancelPreparation(): boolean {
    if (!this.starting) {
      return false;
    }
    // Invalidating the generation is what makes the cancellation real: the fetch
    // may still resolve later, and its result must be discarded rather than
    // starting a match the host already gave up on.
    this.prepareGeneration += 1;
    this.starting = false;
    this.announce('The host cancelled course loading');
    this.state();
    return true;
  }
  start(ws: RoomSocket) {
    if (this.config.mapSource === MAP_SOURCE.PICKED && !this.config.selectedHoleIds.length) {
      return this.error(ws, 'empty-playlist', 'Choose at least one course');
    }
    if (this.starting) {
      return;
    }
    this.audit('match_prepare_requested', { uid: ws.data.uid, config: this.config });
    const prepareMatch = this.prepareMatch;
    if (prepareMatch) {
      // Preparation is bound to the authenticated host identity, not the
      // original socket: a reconnect during preparation must not cancel it.
      const hostUid = this.hostUid;
      const configuration = structuredClone(this.config);
      const previousSeen = [...this.randomSeen];
      // Preparation is the one operation that can be cancelled while it runs, so
      // its result is only valid for the attempt that started it. Every other
      // check below could pass for a stale attempt - `starting` is a boolean, and a
      // cancel followed by a new start makes it true again - so the generation is
      // what actually decides.
      const generation = ++this.prepareGeneration;
      this.starting = true;
      this.changed();
      this.broadcast(this.snapshot());
      Promise.resolve()
        .then(() => prepareMatch(configuration, previousSeen))
        .then(({ ids, specs, seen, ballots }) => {
          if (
            generation === this.prepareGeneration &&
            !this.closed &&
            this.phase === 'lobby' &&
            this.hostUid === hostUid
          ) {
            if (
              configuration.courseVoting &&
              (!ballots ||
                ballots.length !== configuration.holes ||
                ballots.some(
                  (choices) =>
                    choices.length !== 3 ||
                    new Set(choices.map((course) => course.id)).size !== choices.length,
                ))
            ) {
              throw new Error('Could not prepare all course voting choices');
            }
            this.holeIds = ids;
            this.specs = specs;
            this.voteCourses = ballots ?? [];
            if (Array.isArray(seen)) {
              this.randomSeen = seen;
            }
            this.startPrepared();
          }
        })
        .catch((error) => {
          this.audit('match_prepare_failed', { code: 'map-load-failed' });
          const hostSocket = this.players.get(this.hostUid ?? '')?.ws;
          if (hostSocket) {
            this.error(hostSocket, 'map-load-failed', errorMessage(error));
          }
        })
        .finally(() => {
          // A stale attempt must not clear `starting` for the attempt that replaced
          // it, or a cancel followed by a new start would unlock configuration
          // while the new preparation is still running.
          if (generation !== this.prepareGeneration) {
            return;
          }
          this.starting = false;
          if (!this.closed) {
            this.changed();
            this.broadcast(this.snapshot());
          }
        });
      return;
    }
    if (this.config.courseVoting) {
      return this.error(ws, 'map-load-failed', 'Course voting requires a prepared public catalog.');
    }
    const source = [...this.catalog.keys()];
    if (!source.length) {
      return this.error(ws, 'empty-catalog', 'No validated maps');
    }
    let deck: string[] = [];
    const random = () => {
      if (!deck.length) {
        deck = source.slice();
      }
      return deck.splice(randomInt(deck.length), 1)[0];
    };
    this.holeIds =
      this.config.mapSource === MAP_SOURCE.PICKED
        ? this.config.selectedHoleIds.slice()
        : Array.from({ length: this.config.holes }, random);
    this.specs = this.holeIds.map((id) => {
      const course = this.catalog.get(id);
      if (!course?.spec) {
        throw new Error('Selected course specification is missing');
      }
      return structuredClone(course.spec);
    });
    this.voteCourses = [];
    this.startPrepared();
  }
  startPrepared() {
    this.pausedAt = null;
    this.playlistRevision++;
    this.recordEligible =
      !this.config.courseVoting &&
      ![...this.players.values()].some((player) => player.puttingLocked || player.hostSpectator);
    this.replayId = this.onReplayRound ? newReplayId() : null;
    this.replayAvailable = false;
    this.replayCapture = null;
    this.matchId = randomUUID();
    this.holeIndex = 0;
    this.roundHistory = [];
    this.vote = null;
    this.nextLoadError = null;
    this.retryingNext = false;
    this.recoveryNotice = false;
    for (const [uid, player] of this.players) {
      if (!player.ws) {
        this.players.delete(uid);
        continue;
      }
      Object.assign(player, {
        role: player.hostSpectator ? 'spectator' : 'player',
        alive: !player.hostSpectator,
        participated: !player.hostSpectator,
        roundSpectator: false,
        holesSurvived: 0,
        totalStrokes: 0,
        totalTimeMs: 0,
        holeTimeMs: undefined,
        strokes: 0,
        done: false,
        success: false,
        ready: false,
      });
    }
    this.admittedParticipants.clear();
    for (const player of this.players.values()) {
      if (player.participated) {
        this.admittedParticipants.add(player.uid);
        player.joinAfterHole = undefined;
      }
    }
    this.initialPlayers = this.admittedParticipants.size;
    // Teams are formed from the players actually in the party at this moment, so a
    // rematch re-forms them rather than carrying a stale split.
    this.assignTeams();
    if (this.config.tournament && (!this.tournament || this.tournament.finished)) {
      // A finished tournament stays on screen until the host starts again; this is
      // the moment a new one begins.
      this.tournament = {
        rounds: this.config.tournamentRounds,
        completed: 0,
        standings: [],
        finished: false,
      };
    }
    this.audit('match_started', {
      config: this.config,
      courses: this.holeIds.map((id) => ({ id, title: this.playlistTitle(id) })),
      players: [...this.players.values()].map(({ uid, name, role }) => ({ uid, name, role })),
    });
    if (this.config.courseVoting && this.voteCourses[0]?.length === 3) {
      this.openVote(0);
      return;
    }
    this.begin();
  }
  schedule(callback: () => void, delayMs: number) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (!this.closed) {
        callback();
      }
    }, delayMs);
  }
  begin() {
    this.vote = null;
    this.pausedAt = null;
    this.replayCapture = this.replayId
      ? new RoundReplayCapture(this.specs[this.holeIndex] ?? null)
      : null;
    this.roundTimerMs = this.config.timerMs;
    this.phase = 'countdown';
    this.playNotBefore = Date.now() + this.countdown;
    this.startsAt = this.playNotBefore;
    this.readyDeadline = this.playNotBefore + READY_GRACE_MS;
    this.positions.clear();
    for (const player of this.players.values()) {
      if (
        player.ws &&
        !player.participated &&
        !player.hostSpectator &&
        player.joinAfterHole !== undefined &&
        player.joinAfterHole < this.holeIndex
      ) {
        this.admitLatePlayer(player);
      }
      player.strokes = 0;
      player.strokeAdjustment = 0;
      player.done = false;
      player.holeTimeMs = undefined;
      player.success = false;
      player.lastPosition = 0;
      player.sceneReady = false;
      if (player.roundSpectator && player.alive && !player.hostSpectator) {
        player.role = 'player';
        player.roundSpectator = false;
      }
    }
    this.audit('round_countdown', {
      courseTitle: this.specs[this.holeIndex]?.name,
      par: this.specs[this.holeIndex]?.par,
      startsAt: this.startsAt,
      timerMs: this.roundTimerMs,
    });
    this.state();
    this.schedule(() => this.startPlay(), this.countdown);
  }
  /**
   * Warm the next course while this one is being played.
   *
   * A picked playlist deliberately fetches only its first course up front - a
   * playlist can hold thousands of holes and loading them all before the match
   * would be a long stall and a lot of upstream traffic. The cost was paid at every
   * hole boundary instead: the room sat on the previous hole's results while the
   * next course was fetched. Fetching it a hole early moves that wait into the time
   * the players are already playing, so the transition is immediate.
   *
   * Bounded on purpose: exactly one hole ahead, never a whole playlist, and only
   * when the specification is actually missing. A prefetch failure is silent -
   * `loadNext` retries it at the boundary and reports properly there, so a transient
   * upstream blip cannot leave the room carrying an error it did not need.
   */
  private prefetchNext() {
    const loadMap = this.loadMap;
    const target = this.holeIndex + 1;
    const id = this.holeIds[target];
    if (
      !loadMap ||
      !id ||
      this.specs[target] ||
      this.closed ||
      this.loadingNext ||
      // A voting match is a random match, and a random match prepares every course
      // up front, so this is currently unreachable - it is kept because it is the
      // condition that would stop wasted upstream work if random playlists ever
      // became lazy, and it costs one comparison.
      this.config.courseVoting ||
      this.phase !== 'playing'
    ) {
      return;
    }
    const match = this.matchId;
    const hole = this.holeIndex;
    const generation = ++this.prefetchGeneration;
    // Every condition that would make the result wrong: the match or hole moved,
    // the room closed, a newer prefetch began, or - the one a hole-index check
    // alone would miss - the host edited the upcoming list so a different course
    // now occupies this slot.
    const stale = () =>
      this.closed ||
      this.phase === 'final' ||
      this.matchId !== match ||
      this.holeIndex !== hole ||
      this.holeIds[target] !== id ||
      this.prefetchGeneration !== generation;
    Promise.resolve()
      .then(() => loadMap(id))
      .then((loadedCourse) => {
        if (stale() || this.specs[target]) {
          return;
        }
        this.specs[target] = structuredClone(loadedCourse.spec);
        this.audit('course_prefetched', { target, targetCourseId: id });
      })
      .catch(() => {
        // Deliberately silent; see the comment above.
      });
  }
  /**
   * Players the countdown waits for: connected, participating, and using a
   * client that reports scene readiness. A client that never reports cannot be
   * awaited without stalling every round, so its loading time stays its own.
   */
  playersExpectedToLoad() {
    return [...this.players.values()].filter(
      (player) =>
        player.alive &&
        player.participated &&
        player.ws &&
        !player.roundSpectator &&
        !player.hostSpectator &&
        player.reportsSceneReadiness,
    );
  }
  /**
   * Begin play once the countdown has elapsed and every client expected to load
   * has its scene, or the grace deadline passes. Called by the countdown timer,
   * the grace deadline and a scene report; all three paths converge here so the
   * approval of the countdown and the wait for slow clients cannot conflict.
   */
  startPlay() {
    if (this.phase !== 'countdown') {
      return;
    }
    const untilCountdownElapsed = this.playNotBefore - Date.now();
    if (untilCountdownElapsed > 0) {
      // Readiness may only extend the approved countdown, never shorten it.
      this.schedule(() => this.startPlay(), untilCountdownElapsed);
      return;
    }
    const waiting = this.playersExpectedToLoad().filter((player) => !player.sceneReady);
    if (waiting.length && Date.now() < this.readyDeadline) {
      // Stay in countdown, which the original client already renders as "not
      // playable": its input gate and timer both require the playing phase. An
      // early report calls back in here through acknowledgeScene; otherwise the
      // deadline re-checks, so the wait is bounded. Nobody is charged round time
      // for the wait because the round clock starts with the playing phase.
      this.schedule(() => this.startPlay(), Math.max(50, this.readyDeadline - Date.now()));
      this.broadcast(this.snapshot());
      return;
    }
    clearTimeout(this.timer);
    // The round timer starts when play starts, so nobody loses time to loading.
    this.startsAt = Date.now();
    this.phase = 'playing';
    this.audit('round_started', {
      deadline: this.roundTimerMs ? this.startsAt + this.roundTimerMs : null,
      awaitingPlayers: waiting.length,
    });
    this.state();
    if (this.roundTimerMs) {
      this.schedule(() => this.endHole(), this.roundTimerMs);
    }
    this.prefetchNext();
  }
  /**
   * Every identity the current hole can legitimately be known by. The catalog
   * addresses a course by its public ID, while the renderer and the desktop
   * editor name the same course by the identifier inside its specification, so
   * a readiness report may carry either one.
   */
  knownLevelIds() {
    const specId = this.specs[this.holeIndex]?.id;
    return [this.holeIds[this.holeIndex], typeof specId === 'string' ? specId : undefined].filter(
      (id): id is string => typeof id === 'string' && id.length > 0,
    );
  }
  /**
   * A client reports that its level is prepared for the current round. The
   * report is scoped to match and hole so a stale document cannot unblock a
   * newer round.
   */
  acknowledgeScene(ws: RoomSocket, message: Record<string, unknown>, player: Player) {
    if (
      message.matchId !== this.matchId ||
      message.holeIndex !== this.holeIndex ||
      (player.attempt && message.attempt !== player.attempt)
    ) {
      return;
    }
    if (typeof message.levelId === 'string' && !this.knownLevelIds().includes(message.levelId)) {
      return;
    }
    if (player.sceneReady || ws !== player.ws) {
      return;
    }
    player.sceneReady = true;
    if (player.attempt) {
      this.rosterBroadcast();
    }
    this.audit('scene_ready', { uid: player.uid });
    if (this.phase === 'countdown') {
      this.startPlay();
    }
  }
  voteSnapshot(): PartySnapshot['vote'] {
    const vote = this.vote;
    if (!vote) {
      return null;
    }
    if (vote.resolved) {
      return vote.resolved;
    }
    const ballots = [...vote.ballots].filter(([uid]) => this.players.get(uid)?.ws);
    return {
      id: vote.id,
      target: vote.target,
      endsAt: vote.endsAt,
      choices: this.voteCourses[vote.target].map(
        ({ id, title, author, par, ratingAvg, ratingCount }) => ({
          id,
          title,
          author,
          par,
          ratingAvg,
          ratingCount,
          votes: ballots.filter(([_uid, choice]) => choice === id).length,
        }),
      ),
      ballots: Object.fromEntries(ballots),
    };
  }

  broadcastVote() {
    if (this.vote) {
      this.broadcast({ t: 'course-vote', vote: this.voteSnapshot(), now: Date.now() });
    }
  }

  castVote(player: Player, message: Record<string, unknown>) {
    const vote = this.vote;
    if (
      !vote ||
      vote.resolved ||
      this.phase !== 'hole-results' ||
      message.voteId !== vote.id ||
      Date.now() >= vote.endsAt ||
      typeof message.courseId !== 'string' ||
      !this.voteCourses[vote.target].some((course) => course.id === message.courseId)
    ) {
      return;
    }
    if (vote.ballots.get(player.uid) === message.courseId) {
      return;
    }
    vote.ballots.set(player.uid, message.courseId);
    this.broadcastVote();
  }

  openVote(target: number) {
    this.phase = 'hole-results';
    this.vote = {
      id: randomUUID(),
      target,
      endsAt: Date.now() + this.votingMs,
      ballots: new Map(),
    };
    this.audit('course_vote_opened', {
      target,
      courses: this.voteCourses[target].map((course) => course.id),
    });
    this.state();
    this.schedule(() => this.resolveVote(), this.votingMs);
  }

  resolveVote() {
    const vote = this.vote;
    const ballot = this.voteSnapshot();
    if (!vote || !ballot || vote.resolved || this.phase !== 'hole-results') {
      return;
    }
    const winner = drawWeightedCourse(ballot.choices);
    const course = this.voteCourses[ballot.target].find((choice) => choice.id === winner.id);
    if (!course) {
      throw new Error('Missing validated vote winner');
    }
    this.audit('course_vote_closed', {
      target: ballot.target,
      title: course.title,
      choices: ballot.choices,
      winner: winner.id,
    });
    // Keep the results overlay and frozen draw available to every client,
    // including reconnecting clients, until the reveal has finished.
    vote.resolved = {
      ...ballot,
      endsAt: Date.now() + this.voteRevealMs,
      resolution: { winnerId: winner.id, durationMs: this.voteRevealMs },
    };
    this.broadcastVote();
    this.schedule(() => {
      if (this.vote !== vote || this.phase !== 'hole-results') {
        return;
      }
      this.holeIds[ballot.target] = course.id;
      this.specs[ballot.target] = structuredClone(course.spec);
      this.holeIndex = ballot.target;
      this.begin();
    }, this.voteRevealMs);
  }

  advance() {
    const next = this.holeIndex + 1;
    if (next >= this.holeIds.length) {
      this.finalize();
      return;
    }
    if (this.config.courseVoting && this.voteCourses[next]?.length > 1) {
      this.openVote(next);
      return;
    }
    if (this.specs[next]) {
      this.holeIndex = next;
      this.begin();
      return;
    }
    this.loadNext(next);
  }
  /**
   * Load the course at `target` while the room stays on the completed hole's
   * results. A failure is recoverable: the host can retry, skip the unloaded
   * hole or end the party instead of the match terminating automatically.
   */
  loadNext(target: number) {
    const loadMap = this.loadMap;
    if (!loadMap) {
      this.finalize();
      return;
    }
    clearTimeout(this.timer);
    this.loadingNext = true;
    // A retry begins a new attempt, so the previous failure is no longer the state.
    // Leaving it set made the snapshot say "failed" while the retry was loading.
    this.nextLoadError = null;
    this.phase = 'hole-results';
    this.state();
    const match = this.matchId;
    const completed = this.holeIndex;
    const generation = ++this.nextLoadGeneration;
    const id = this.holeIds[target];
    this.audit('course_load_started', { target, targetCourseId: id });
    const stale = () =>
      this.closed ||
      this.matchId !== match ||
      this.holeIndex !== completed ||
      this.phase !== 'hole-results' ||
      this.nextLoadGeneration !== generation;
    Promise.resolve()
      .then(() => loadMap(id))
      .then((loadedCourse) => {
        if (stale()) {
          return;
        }
        this.audit('course_load_succeeded', {
          target,
          targetCourseId: id,
          name: loadedCourse.spec.name,
        });
        this.specs[target] = structuredClone(loadedCourse.spec);
        this.loadingNext = false;
        this.retryingNext = false;
        this.nextLoadError = null;
        this.holeIndex = target;
        this.begin();
      })
      .catch((error) => {
        if (stale()) {
          return;
        }
        this.loadingNext = false;
        this.retryingNext = false;
        this.audit('course_load_failed', { target, targetCourseId: id, code: 'map-load-failed' });
        this.nextLoadError = 'Could not load the next public hole: ' + errorMessage(error);
        this.state();
      });
  }
  playable(player: Player) {
    return (
      this.phase === 'playing' &&
      this.pausedAt === null &&
      player.role === 'player' &&
      player.alive &&
      player.participated &&
      !player.done &&
      (!this.roundTimerMs || Date.now() <= this.startsAt + this.roundTimerMs)
    );
  }
  elapsedHoleMs() {
    if (this.phase === 'countdown') {
      return 0;
    }
    return Math.max(
      0,
      Math.min(this.roundTimerMs || Infinity, (this.pausedAt ?? Date.now()) - this.startsAt),
    );
  }
  finish(player: Player, success: boolean) {
    player.holeTimeMs = this.elapsedHoleMs();
    player.done = true;
    player.success = success;
    this.audit(success ? 'player_holed' : 'player_forfeited', {
      uid: player.uid,
      name: player.name,
      strokes: player.strokes,
      timeMs: player.holeTimeMs,
      par: this.specs[this.holeIndex]?.par,
    });
    if (success) {
      this.broadcast({
        t: 'f',
        id: player.id,
        s: this.effectiveStrokes(player),
        p: this.specs[this.holeIndex].par,
      });
    }
    this.broadcast(this.board());
    this.checkRoundDone();
  }
  checkRoundDone() {
    if (
      this.phase === 'playing' &&
      this.pausedAt === null &&
      [...this.players.values()]
        .filter((player) => player.participated && player.alive)
        .every((player) => player.done)
    ) {
      this.endHole();
    }
  }
  /** A player's hole score after host adjustment; see `room-scoring`. */
  effectiveStrokes(player: Player) {
    return effectiveStrokes(player);
  }

  private announce(message: string) {
    this.broadcast({ t: 'host-notice', message });
  }

  private changedGameplay(message: string) {
    if (this.matchId && this.phase !== 'final') {
      this.recordEligible = false;
    }
    this.announce(message);
  }

  private resetPlayerAttempt(player: Player) {
    player.attempt = (player.attempt ?? 0) + 1;
    player.strokes = 0;
    player.strokeAdjustment = 0;
    player.done = false;
    player.success = false;
    player.holeTimeMs = undefined;
    player.sceneReady = false;
    player.lastPosition = 0;
    this.positions.delete(player.id);
    this.broadcast({ t: 'bye', id: player.id });
    this.replayCapture?.resetPlayer(player.uid);
  }

  private returnPlayer(player: Player) {
    player.hostSpectator = false;
    const identity = this.issued.get(player.uid);
    if (identity) {
      identity.hostSpectator = false;
    }
    player.roundSpectator = false;
    player.role = 'player';
    player.alive = true;
    player.joinAfterHole = undefined;
    if (this.phase !== 'lobby') {
      if (!player.participated) {
        this.admitLatePlayer(player);
      }
      this.resetPlayerAttempt(player);
    }
  }

  private managePlayer(ws: RoomSocket, message: Record<string, unknown>): boolean {
    const target = typeof message.uid === 'string' ? this.players.get(message.uid) : undefined;
    if (
      !target ||
      target.uid === ws.data.uid ||
      (target.uid === this.hostUid && ws.data.uid !== this.hostUid)
    ) {
      return false;
    }
    const value = message.value;
    const live = this.phase === 'playing' || this.phase === 'countdown';
    let notice: string;
    switch (message.action) {
      case 'rename': {
        if (
          typeof value !== 'string' ||
          !value.trim() ||
          value.trim().length > 24 ||
          this.bannedNames.has(normalizedName(value))
        ) {
          return false;
        }
        const previous = target.name;
        target.name = value.trim();
        const identity = this.issued.get(target.uid);
        if (identity) {
          identity.name = target.name;
        }
        notice = previous + ' was renamed to ' + target.name;
        break;
      }
      case 'color': {
        if (!isIntegerInRange(value, 0, 359)) {
          return false;
        }
        target.hue = value;
        target.colorOverride = true;
        const identity = this.issued.get(target.uid);
        if (identity) {
          identity.hue = value;
          identity.colorOverride = true;
        }
        notice = target.name + ' changed ball color';
        break;
      }
      case 'grant-cohost':
      case 'revoke-cohost':
        if (ws.data.uid !== this.hostUid || target.uid === this.hostUid) {
          return false;
        }
        target.coHost = message.action === 'grant-cohost';
        notice = target.name + (target.coHost ? ' is now a co-host' : ' is no longer a co-host');
        break;
      case 'restart-player':
        if (!live || !target.ws || !target.alive || target.role !== 'player') {
          return false;
        }
        this.resetPlayerAttempt(target);
        notice = target.name + ' restarted the hole';
        break;
      case 'forfeit-player':
        if (!live || !target.alive || target.done || target.role !== 'player') {
          return false;
        }
        target.role = 'spectator';
        target.roundSpectator = true;
        target.done = true;
        target.success = false;
        target.holeTimeMs = this.elapsedHoleMs();
        this.positions.delete(target.id);
        this.broadcast({ t: 'bye', id: target.id });
        notice = target.name + ' forfeited the hole';
        break;
      case 'spectate-player':
        if (this.phase === 'final' || target.hostSpectator) {
          return false;
        }
        target.hostSpectator = true;
        target.role = 'spectator';
        target.alive = false;
        target.done = true;
        target.success = false;
        target.ready = false;
        target.joinAfterHole = undefined;
        this.positions.delete(target.id);
        this.broadcast({ t: 'bye', id: target.id });
        notice = target.name + ' was moved to spectators';
        break;
      case 'return-player':
      case 'revive-player':
        if (
          !(live || this.phase === 'lobby') ||
          !target.ws ||
          (target.role === 'player' && target.alive)
        ) {
          return false;
        }
        this.returnPlayer(target);
        notice = target.name + ' returned to play';
        break;
      case 'reset-strokes':
      case 'adjust-strokes': {
        if (!live || !target.participated || !target.alive) {
          return false;
        }
        const current = this.effectiveStrokes(target);
        if (message.action === 'adjust-strokes' && !isIntegerInRange(value, -200, 200)) {
          return false;
        }
        const desired = message.action === 'reset-strokes' ? 0 : current + Number(value);
        target.strokeAdjustment =
          Math.max(target.success ? 1 : 0, Math.min(200, desired)) - target.strokes;
        notice = target.name + ' now has ' + this.effectiveStrokes(target) + ' strokes';
        break;
      }
      case 'lock-putting':
      case 'unlock-putting':
        if (this.phase === 'final') {
          return false;
        }
        target.puttingLocked = message.action === 'lock-putting';
        notice = target.name + (target.puttingLocked ? ' cannot putt' : ' can putt again');
        break;
      case 'kick':
      case 'ban': {
        if (target.uid === this.hostUid) {
          return false;
        }
        if (message.action === 'ban') {
          if (this.bannedNames.size >= 200) {
            return false;
          }
          this.bannedNames.add(normalizedName(target.name));
        }
        this.issued.delete(target.uid);
        this.players.delete(target.uid);
        this.positions.delete(target.id);
        this.vote?.ballots.delete(target.uid);
        if (target.ws) {
          this.error(
            target.ws,
            'invalid-join',
            message.action === 'ban'
              ? 'You were banned from this party.'
              : 'You were kicked from this party.',
          );
          target.ws.data.uid = null;
          target.ws.close(1008, 'Removed by host');
        }
        this.broadcast({ t: 'bye', id: target.id });
        this.broadcastVote();
        notice = target.name + (message.action === 'ban' ? ' was banned' : ' was kicked');
        break;
      }
      default:
        return false;
    }
    const identity = this.issued.get(target.uid);
    if (identity) {
      identity.coHost = target.coHost;
      identity.hostSpectator = target.hostSpectator;
      identity.puttingLocked = target.puttingLocked;
    }
    if (['color', 'grant-cohost', 'revoke-cohost'].includes(String(message.action))) {
      this.announce(notice);
    } else {
      this.changedGameplay(notice);
    }
    this.state();
    if (this.phase === 'final') {
      const standings = this.standings();
      this.broadcast({ t: 'final', podium: standings.slice(0, 3), standings });
    }
    this.checkRoundDone();
    return true;
  }

  private editablePlaylist() {
    return ['playing', 'countdown'].includes(this.phase) && !this.starting && !this.loadingNext;
  }

  private replaceUpcoming(ids: string[], added?: { id: string; spec: CourseSpecification }) {
    if (!this.editablePlaylist() || ids.length + this.holeIndex + 1 > 10000) {
      return false;
    }
    const previous = new Map(this.holeIds.map((id, index) => [id, this.specs[index]]));
    const prefix = this.holeIndex + 1;
    this.holeIds = [...this.holeIds.slice(0, prefix), ...ids];
    const specs = this.specs.slice(0, prefix);
    for (const [index, id] of ids.entries()) {
      const spec = added?.id === id ? added.spec : (previous.get(id) ?? this.catalog.get(id)?.spec);
      if (spec) {
        specs[prefix + index] = structuredClone(spec);
      }
    }
    this.specs = specs;
    this.voteCourses = [];
    this.config = { ...this.config, holes: this.holeIds.length, courseVoting: false };
    this.playlistRevision++;
    this.changedGameplay('The host edited the remaining holes');
    this.state();
    return true;
  }

  private async addUpcomingCourse(player: Player, message: Record<string, unknown>) {
    if (
      !this.editablePlaylist() ||
      this.playlistEditPending ||
      message.revision !== this.playlistRevision ||
      typeof message.value !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(message.value) ||
      !this.loadMap ||
      this.holeIds.length >= 10000
    ) {
      return false;
    }
    const id = message.value;
    const match = this.matchId;
    const hole = this.holeIndex;
    const revision = this.playlistRevision;
    this.playlistEditPending = true;
    try {
      const loaded = await this.loadMap(id);
      if (
        this.closed ||
        !player.ws ||
        this.players.get(player.uid) !== player ||
        (player.uid !== this.hostUid && !player.coHost) ||
        this.matchId !== match ||
        this.holeIndex !== hole ||
        this.playlistRevision !== revision ||
        !this.editablePlaylist()
      ) {
        return false;
      }
      return this.replaceUpcoming([...this.holeIds.slice(hole + 1), id], { id, spec: loaded.spec });
    } finally {
      this.playlistEditPending = false;
    }
  }

  private scheduleRemainingTime() {
    clearTimeout(this.timer);
    if (this.phase === 'playing' && this.pausedAt === null && this.roundTimerMs) {
      this.schedule(
        () => this.endHole(),
        Math.max(0, this.startsAt + this.roundTimerMs - Date.now()),
      );
    }
  }

  hostAction(ws: RoomSocket, message: Record<string, unknown>): boolean {
    const action = message.action;
    const live = this.phase === 'playing' || this.phase === 'countdown';
    if (
      [
        'rename',
        'color',
        'restart-player',
        'forfeit-player',
        'spectate-player',
        'return-player',
        'revive-player',
        'reset-strokes',
        'adjust-strokes',
        'lock-putting',
        'unlock-putting',
        'kick',
        'ban',
        'grant-cohost',
        'revoke-cohost',
      ].includes(String(action))
    ) {
      return this.managePlayer(ws, message);
    }
    // While courses are loading almost nothing may change, because the prepared
    // result is built from the configuration as it was. Cancelling is the exception
    // that makes the lock survivable.
    if (this.starting && action !== 'transfer-host' && action !== 'cancel-preparation') {
      return false;
    }
    switch (action) {
      case 'cancel-preparation':
        return this.cancelPreparation();
      case 'unban': {
        // A banned player is removed from `players`, so there is no uid to target
        // and the ban can only be lifted by name. Without this the ban was
        // one-way for the life of the room: a host who banned the wrong person,
        // or banned someone in jest, had no way to undo it.
        const name = typeof message.value === 'string' ? message.value : '';
        const normalized = normalizedName(name);
        if (!normalized || !this.bannedNames.delete(normalized)) {
          return false;
        }
        this.announce('The host lifted a ban on ' + name.trim());
        this.state();
        return true;
      }
      case 'pause':
        if (this.phase !== 'playing' || this.pausedAt !== null) {
          return false;
        }
        this.pausedAt = Date.now();
        clearTimeout(this.timer);
        this.changedGameplay('The host paused the match');
        this.state();
        return true;
      case 'resume':
        if (this.phase !== 'playing' || this.pausedAt === null) {
          return false;
        }
        this.startsAt += Date.now() - this.pausedAt;
        this.pausedAt = null;
        this.announce('The host resumed the match');
        this.state();
        this.scheduleRemainingTime();
        this.checkRoundDone();
        return true;
      case 'lock-party':
      case 'unlock-party':
        this.config = { ...this.config, locked: action === 'lock-party' };
        this.announce(
          this.config.locked ? 'The host locked the party' : 'The host unlocked the party',
        );
        this.state();
        return true;
      case 'skip-vote':
        if (!this.vote || this.vote.resolved) {
          return false;
        }
        this.resolveVote();
        return true;
      case 'remaining-time':
        if (!live || !isIntegerInRange(message.value, 0, 86400)) {
          return false;
        }
        this.config = { ...this.config, timerMs: message.value * 1000 };
        this.changedGameplay('The host changed the time limit for future holes');
        this.state();
        return true;
      case 'disable-elimination':
        if (!live || !this.config.elimination) {
          return false;
        }
        this.config = { ...this.config, elimination: false };
        this.changedGameplay('The host disabled elimination');
        this.state();
        return true;
      case 'admit-all': {
        if (!live) {
          return false;
        }
        const targets = [...this.players.values()].filter(
          (player) => player.ws && player.role === 'spectator',
        );
        if (!targets.length) {
          return false;
        }
        for (const player of targets) {
          this.returnPlayer(player);
        }
        this.changedGameplay('The host admitted all spectators');
        this.state();
        return true;
      }
      case 'force-next':
        if (this.phase !== 'playing') {
          return false;
        }
        this.changedGameplay('The host ended the current hole');
        this.endHole();
        return true;
      case 'restart-match':
        if (!this.matchId || this.phase === 'final' || this.loadingNext || !this.specs[0]) {
          return false;
        }
        this.nextLoadGeneration++;
        this.voteCourses = [];
        this.pausedAt = null;
        this.startPrepared();
        this.changedGameplay('The host restarted the match with the same courses');
        this.broadcast(this.snapshot());
        return true;
      case 'playlist': {
        const ids = message.ids;
        const upcoming = new Set(this.holeIds.slice(this.holeIndex + 1));
        if (
          message.revision !== this.playlistRevision ||
          !Array.isArray(ids) ||
          ids.length > 10000 ||
          !ids.every((id): id is string => typeof id === 'string' && upcoming.has(id))
        ) {
          return false;
        }
        return this.replaceUpcoming(ids);
      }
    }

    if (message.action === 'transfer-host') {
      // Deliberate hand-over: the named player must be connected right now.
      return this.transferHost(
        ws.data.uid ?? '',
        typeof message.uid === 'string' ? message.uid : '',
      );
    }
    if (message.action === 'end' && ['countdown', 'playing', 'hole-results'].includes(this.phase)) {
      // Close the match with scores from completed rounds. Do not penalize an interrupted round.
      if (this.phase === 'playing' || this.phase === 'countdown') {
        this.recordRound(
          'ended',
          [...this.players.values()]
            .filter((player) => player.participated && player.alive)
            .map((player) => ({
              uid: player.uid,
              strokes: player.success ? this.effectiveStrokes(player) : null,
              status: player.success ? 'holed' : 'ended',
              timeMs: player.holeTimeMs ?? this.elapsedHoleMs(),
            })),
        );
        for (const player of this.players.values()) {
          if (player.participated && player.alive && player.success) {
            player.totalStrokes += this.effectiveStrokes(player);
            player.totalTimeMs =
              (player.totalTimeMs ?? 0) + (player.holeTimeMs ?? this.elapsedHoleMs());
            player.holesSurvived++;
          }
        }
      }
      this.finalize();
      return true;
    }
    if (message.action === 'skip' && ['countdown', 'playing'].includes(this.phase)) {
      this.changedGameplay('The host skipped the hole');
      clearTimeout(this.timer);
      this.recordRound('skipped', []);
      // Administrative skip voids this hole for everybody: no strokes or eliminations.
      if (this.holeIndex + 1 >= this.holeIds.length) {
        this.finalize();
        return true;
      }
      this.advance();
      return true;
    }
    if (
      message.action === 'time' &&
      this.phase === 'playing' &&
      typeof message.seconds === 'number' &&
      [15, 30, 60].includes(message.seconds)
    ) {
      if (!this.roundTimerMs) {
        return true; // An unlimited round cannot be extended.
      }
      this.roundTimerMs = Math.min(86_400_000, this.roundTimerMs + message.seconds * 1000);
      this.changedGameplay('The host extended the current hole');
      this.scheduleRemainingTime();
      this.broadcast(this.snapshot());
      return true;
    }
    if (message.action === 'restart' && ['countdown', 'playing'].includes(this.phase)) {
      this.changedGameplay('The host restarted the hole');
      // New match identity forces the original route to reload even when the map ID is unchanged.
      this.matchId = randomUUID();
      this.begin();
      return true;
    }
    if (
      message.action === 'retry-next' &&
      this.phase === 'hole-results' &&
      this.nextLoadError &&
      !this.retryingNext
    ) {
      this.retryingNext = true;
      this.loadNext(this.holeIndex + 1);
      return true;
    }
    if (
      message.action === 'skip-next' &&
      this.phase === 'hole-results' &&
      this.nextLoadError &&
      !this.retryingNext
    ) {
      this.nextLoadError = null;
      // Invalidate any in-flight retry for the hole being voided.
      this.nextLoadGeneration++;
      this.retryingNext = false;
      const failed = this.holeIndex + 1;
      this.roundHistory.push({
        index: failed,
        id: this.holeIds[failed],
        title: this.playlistTitle(this.holeIds[failed]),
        status: 'skipped',
        rows: [],
      });
      if (failed + 1 >= this.holeIds.length) {
        this.finalize();
        return true;
      }
      const following = failed + 1;
      if (this.specs[following]) {
        this.holeIndex = following;
        this.begin();
        return true;
      }
      this.loadNext(following);
      return true;
    }
    this.error(ws, 'invalid-host-action', 'That action is not available right now.');
    return false;
  }
  recordRound(status: RoundStatus, rows: RoundScore[]) {
    if (this.replayId && this.replayCapture && this.onReplayRound) {
      try {
        const round = this.replayCapture.finish(
          this.holeIndex,
          this.specs[this.holeIndex]?.name ?? this.holeIds[this.holeIndex],
          status,
          rows,
          this.players,
        );
        this.replayAvailable = this.onReplayRound(this.replayId, round) || this.replayAvailable;
        this.verifyRoundTracks(round);
      } catch (error) {
        // Replay storage failure must never alter scoring or stop a match.
        console.error('Replay archive write failed:', errorMessage(error));
      }
      this.replayCapture = null;
    }
    this.audit('round_recorded', {
      status,
      title: this.specs[this.holeIndex]?.name,
      par: this.specs[this.holeIndex]?.par,
      rows,
    });
    this.roundHistory.push({
      index: this.holeIndex,
      id: this.holeIds[this.holeIndex],
      title: this.specs[this.holeIndex]?.name ?? this.holeIds[this.holeIndex],
      par: this.specs[this.holeIndex]?.par,
      status,
      rows,
    });
  }
  /**
   * Replay each holed track's recorded shot inputs and check the reported
   * trajectory against the physics that produced it.
   *
   * The check runs after the round is stored and is deliberately asynchronous:
   * its verdict lands in the audit log and never changes a score. A course that
   * uses event devices is refused by the verifier rather than replayed
   * approximately, so those rounds simply produce no verdict.
   */
  private verifyRoundTracks(round: ReplayRound) {
    if (!round.level) {
      return;
    }
    const level = round.level;
    if (unverifiableReason(level)) {
      return;
    }
    /*
     * Ask before replaying whether this course can be modelled at all. The
     * verifier would return `ok: false` with `failure: 'event-course'` for an
     * event, spline, active-zone or loop course, and this method audits
     * `result.ok` - so writing that through would record an honest player on a
     * confetti course as a failed verification, indistinguishable in the log
     * from a fabricated trajectory. Refusing to model a course is not a
     * finding about the player, so it produces no verdict at all.
     */
    for (const track of round.tracks) {
      if (track.status !== 'holed' || !track.shots?.length || !track.native?.trajectory.length) {
        continue;
      }
      void verifyReplayedRound({
        specification: level,
        shots: track.shots,
        reported: track.native,
        reportedHoled: true,
        loadPiece: preparedModelLoader(),
      }).then((result) => {
        this.audit('shot_verification', {
          uid: track.name,
          ok: result.ok,
          failure: result.failure ?? null,
          detail: result.detail ?? null,
          shots: result.shots,
          maxPathDeviationCm: Math.round(result.maxPathDeviationCm * 100) / 100,
        });
      });
    }
  }
  finalize() {
    clearTimeout(this.timer);
    this.loadingNext = false;
    this.vote = null;
    this.voteCourses = [];
    this.phase = 'final';
    this.pausedAt = null;
    this.onFinalize(this);
    // Recorded before the snapshot is broadcast, so the history the clients receive
    // already contains the match that just ended.
    const standings = this.standings();
    this.recordMatchSummary(standings);
    this.recordTournamentRound(standings);
    this.state();
    this.audit('match_finalized', { standings, rounds: this.roundHistory });
    this.broadcast({ t: 'final', podium: standings.slice(0, 3), standings });
  }
  /**
   * Keep a compact summary of the match that just ended.
   *
   * The current match is also the newest entry, so a client can show the previous
   * matches with `matchHistory.slice(1)`. Recording is keyed on `matchId`, which
   * makes a repeated `finalize()` a no-op rather than a duplicate.
   *
   * Nothing here is playable: the courses are ids, titles and pars, never a
   * specification. Nothing here is a credential: the rows carry a display name and
   * the scores, not a uid, session or token.
   */
  private recordMatchSummary(standings: Standing[]) {
    if (!this.matchId || this.matchHistory[0]?.matchId === this.matchId) {
      return;
    }
    const courses = this.holeIds.slice(0, MAX_HISTORY_COURSES).map((id, index) => ({
      id,
      title: this.playlistTitle(id),
      par: this.specs[index]?.par ?? null,
    }));
    this.matchHistory = [
      {
        matchId: this.matchId,
        endedAt: Date.now(),
        holes: this.holeIds.length,
        courses,
        standings: standings.slice(0, 50).map((row) => ({
          name: row.name,
          rank: row.rank,
          holesSurvived: row.holesSurvived,
          totalStrokes: row.totalStrokes,
          totalTimeMs: row.totalTimeMs,
        })),
      },
      ...this.matchHistory,
    ].slice(0, MAX_MATCH_HISTORY);
  }
  /**
   * Add one finished match to the tournament table.
   *
   * Points are `competitors - rank + 1`, so the winner of a larger field earns more and
   * last place still earns one for turning up. A competitor who missed a match keeps
   * their earlier points and is not charged for the gap.
   *
   * The competitor is whatever the final board ranked: a player normally, a team slot
   * in team play. Keying on that id is what makes the tournament table and the board
   * agree about who earned what.
   */
  private recordTournamentRound(standings: Standing[]) {
    if (!this.config.tournament || !this.tournament || this.tournament.finished) {
      return;
    }
    if (!standings.length) {
      return;
    }
    const byUid = new Map(this.tournament.standings.map((row) => [row.uid, row]));
    for (const row of standings) {
      const entry: TournamentRow = byUid.get(row.uid) ?? {
        uid: row.uid,
        name: row.name,
        hue: row.hue,
        rank: 0,
        points: 0,
        wins: 0,
        matches: 0,
        totalStrokes: 0,
      };
      entry.name = row.name;
      entry.hue = row.hue;
      entry.points += standings.length - row.rank + 1;
      entry.wins += row.rank === 1 ? 1 : 0;
      entry.matches += 1;
      entry.totalStrokes += row.totalStrokes;
      byUid.set(row.uid, entry);
    }
    const completed = this.tournament.completed + 1;
    this.tournament = {
      rounds: this.tournament.rounds,
      completed,
      standings: [...byUid.values()]
        .sort(compareTournament)
        .map((row, index) => ({ ...row, rank: index + 1 })),
      finished: completed >= this.tournament.rounds,
    };
  }
  endHole() {
    if (this.phase !== 'playing') {
      return;
    }
    clearTimeout(this.timer);
    const active = [...this.players.values()].filter(
      (player) => player.alive && player.participated,
    );
    // The original results UI says non-finishers are eliminated. Exact tie/penalty
    // policy is not available in the client bundles; use a documented local rule.
    const scores: RoundScore[] = active.map((player) => {
      if (player.success) {
        return {
          uid: player.uid,
          strokes: this.effectiveStrokes(player),
          status: 'holed',
          timeMs: player.holeTimeMs ?? this.elapsedHoleMs(),
        };
      }
      if (this.config.elimination) {
        return {
          uid: player.uid,
          strokes: null,
          status: 'eliminated',
          timeMs: player.holeTimeMs ?? this.elapsedHoleMs(),
        };
      }
      return {
        uid: player.uid,
        strokes: Math.max(this.effectiveStrokes(player), this.specs[this.holeIndex].par + 5),
        status: 'timeout',
        timeMs: this.roundTimerMs || player.holeTimeMs || this.elapsedHoleMs(),
      };
    });
    this.recordRound('completed', scores);
    for (const player of active) {
      player.done = true;
      player.holeTimeMs ??= this.elapsedHoleMs();
      if (player.success) {
        player.totalStrokes += this.effectiveStrokes(player);
        player.totalTimeMs = (player.totalTimeMs ?? 0) + player.holeTimeMs;
        player.holesSurvived++;
      } else if (this.config.elimination) {
        player.alive = false;
        player.role = 'spectator';
      } else {
        player.totalStrokes += Math.max(
          this.effectiveStrokes(player),
          this.specs[this.holeIndex].par + 5,
        );
        player.holeTimeMs = this.roundTimerMs || player.holeTimeMs;
        player.totalTimeMs = (player.totalTimeMs ?? 0) + player.holeTimeMs;
        player.holesSurvived++;
      }
    }
    if (!this.config.elimination) {
      for (const player of active) {
        if (player.roundSpectator) {
          player.role = 'player';
          player.roundSpectator = false;
        }
      }
    }
    this.phase = 'hole-results';
    this.pausedAt = null;
    this.audit('round_results', { standings: this.standings(), scores });
    this.state();
    this.schedule(() => {
      const alive = [...this.players.values()].filter(
        (player) => player.participated && player.alive,
      ).length;
      const teams = this.teams();
      // In team play the party ends when one team is left, not when one player is:
      // a surviving team-mate must not be made to play on alone.
      const decidedByTeams =
        teams.length > 0 &&
        (this.aliveTeamCount() === 0 || (teams.length > 1 && this.aliveTeamCount() === 1));
      if (
        this.holeIndex + 1 >= this.holeIds.length ||
        (this.config.elimination &&
          (decidedByTeams ||
            (!teams.length && (alive === 0 || (this.initialPlayers > 1 && alive === 1)))))
      ) {
        this.finalize();
      } else {
        this.advance();
      }
    }, this.results);
  }
  reset() {
    this.audit('match_reset', { standings: this.standings() });
    clearTimeout(this.timer);
    this.loadingNext = false;
    this.nextLoadError = null;
    this.retryingNext = false;
    this.phase = 'lobby';
    this.config = {
      ...this.config,
      holes:
        this.config.mapSource === MAP_SOURCE.RANDOM
          ? this.config.randomHoles
          : this.config.selectedHoleIds.length,
    };
    for (const identity of this.issued.values()) {
      identity.hostSpectator = false;
      identity.puttingLocked = false;
    }
    this.pausedAt = null;
    this.vote = null;
    this.voteCourses = [];
    this.recoveryNotice = false;
    this.roundHistory = [];
    this.replayCapture = null;
    this.replayId = null;
    this.replayAvailable = false;
    this.initialPlayers = 0;
    this.admittedParticipants.clear();
    this.holeIndex = 0;
    this.holeIds = [];
    this.specs = [];
    this.matchId = null;
    this.startsAt = 0;
    this.positions.clear();
    for (const [id, player] of this.players) {
      if (!player.ws && id !== this.hostUid) {
        this.players.delete(id);
        continue;
      }
      Object.assign(player, {
        role: 'player',
        alive: true,
        participated: false,
        ready: false,
        strokes: 0,
        done: false,
        holesSurvived: 0,
        totalStrokes: 0,
        totalTimeMs: 0,
        holeTimeMs: undefined,
        roundSpectator: false,
        hostSpectator: false,
        puttingLocked: false,
        strokeAdjustment: 0,
        joinAfterHole: undefined,
        team: undefined,
      });
    }
    this.state();
  }
  tick() {
    if (this.positions.size && ['playing', 'countdown'].includes(this.phase)) {
      this.broadcast({ t: 'b', s: [...this.positions.values()] });
      this.positions.clear();
    }
  }
  changed() {
    this.onChange(this);
  }
  /** The durable snapshot; `room-persistence` owns what is (and is not) saved. */
  checkpoint(): RoomCheckpoint {
    return buildCheckpoint(this);
  }
  restore(data: RoomCheckpoint) {
    const outcome = restoreRoom(this, data);
    this.audit('room_recovered', outcome);
  }
  dispose() {
    this.audit('room_disposed', { standings: this.standings() });
    this.closed = true;
    clearTimeout(this.timer);
    this.clearHostSuccession();
  }
}
