import { randomUUID, randomBytes, randomInt } from 'node:crypto';
import { logEvent } from './event-log.js';
import {
  MAP_SOURCE,
  LATE_JOIN,
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
} from './room-types.js';

const token = () => randomBytes(24).toString('base64url');
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
export const defaults: Readonly<RoomConfig> = Object.freeze({
  holes: 3,
  timerMs: 60000,
  elimination: true,
  maxPlayers: 50,
  mapSource: MAP_SOURCE.RANDOM,
  selectedHoleIds: [],
  locked: false,
  excludeDaily: false,
  randomHoles: 3,
  lateJoin: LATE_JOIN.ALWAYS,
  courseVoting: false,
});
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
  vote: { id: string; target: number; endsAt: number; ballots: Map<string, string> } | null = null;
  readonly onIdle: (room: Room) => void;
  readonly onChange: (room: Room) => void;
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
  players = new Map<string, Player>();
  phase: RoomPhase = 'lobby';
  roundHistory: RoundRecord[] = [];
  initialPlayers = 0;
  private readonly admittedParticipants = new Set<string>();
  config: RoomConfig = { ...defaults, selectedHoleIds: [] };
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
      onIdle = () => {},
      onChange = () => {},
      prepareMatch = null,
      loadMap = null,
    }: RoomOptions = {},
  ) {
    this.code = code;
    this.catalog = catalog;
    this.countdown = countdown;
    this.results = results;
    this.votingMs = votingMs;
    this.onIdle = onIdle;
    this.onChange = onChange;
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

  issue(name: unknown, uid?: unknown, session?: unknown): Identity {
    this.lastActivity = Date.now();
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 24) {
      throw new Error('Name must contain 1–24 characters');
    }
    const previous = typeof uid === 'string' ? this.issued.get(uid) : undefined;
    if (previous && previous.session === session) {
      return previous;
    }
    if (this.config.locked) {
      throw new Error('This party is locked to existing players.');
    }
    if (uid && session) {
      throw new Error('Session expired; join again with a new identity.');
    }
    if ([...this.players.values()].filter((player) => player.ws).length >= this.config.maxPlayers) {
      throw new Error('Party is full.');
    }
    if (this.issued.size >= 200) {
      throw new Error('Room identity limit reached');
    }
    const identity = {
      uid: randomUUID(),
      session: token(),
      name: name.trim(),
      hue: randomInt(360),
    };
    this.issued.set(identity.uid, identity);
    this.audit('identity_issued', { uid: identity.uid, name: identity.name });
    this.changed();
    return identity;
  }
  send(ws: RoomSocket, message: unknown) {
    try {
      ws.send(JSON.stringify(message));
    } catch {}
  }
  broadcast(message: unknown) {
    for (const player of this.players.values()) {
      if (player.ws) {
        this.send(player.ws, message);
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
    // Includes newly admitted players in the solo-vs-multiplayer elimination rule.
    this.initialPlayers++;
    this.audit('late_player_admitted', { uid: player.uid, name: player.name });
  }

  roster() {
    return [...this.players.values()]
      .filter((player) => player.ws || this.phase !== 'lobby')
      .map((player) => ({
        id: player.id,
        uid: player.uid,
        name: player.name,
        hue: player.hue,
        role: player.role,
        spectatorReason: this.spectatorReason(player),
        isHost: player.uid === this.hostUid,
        ready: player.ready,
        alive: player.alive,
        connected: !!player.ws,
      }));
  }
  standings() {
    return [...this.players.values()]
      .filter((player) => player.participated)
      .sort(
        (leftPlayer, rightPlayer) =>
          rightPlayer.holesSurvived - leftPlayer.holesSurvived ||
          Number(rightPlayer.alive) - Number(leftPlayer.alive) ||
          leftPlayer.totalStrokes - rightPlayer.totalStrokes ||
          (leftPlayer.totalTimeMs ?? 0) - (rightPlayer.totalTimeMs ?? 0) ||
          leftPlayer.name.localeCompare(rightPlayer.name),
      )
      .map((player, index) => ({
        uid: player.uid,
        name: player.name,
        hue: player.hue,
        rank: index + 1,
        holesSurvived: player.holesSurvived,
        totalStrokes: player.totalStrokes,
        totalTimeMs: player.totalTimeMs ?? 0,
        holeTimeMs: player.holeTimeMs ?? null,
        alive: player.alive,
        strokes: player.strokes,
        finished: player.done,
      }));
  }
  board() {
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
        id: '',
        ws: null,
        role: this.phase === 'lobby' ? 'player' : 'spectator',
        ready: false,
        alive: this.phase === 'lobby',
        participated: false,
        holesSurvived: 0,
        totalStrokes: 0,
        totalTimeMs: 0,
        strokes: 0,
        done: false,
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
    if (this.vote?.target === 0 && !player.participated) {
      // No hole has started yet: allow new arrivals to join the opening vote
      // and play from hole one, regardless of the mid-match admission policy.
      this.admitLatePlayer(player);
    }
    if (
      player.joinAfterHole !== undefined &&
      !player.participated &&
      (this.phase === 'countdown' ||
        (this.phase === 'playing' && Date.now() < this.startsAt + this.roundTimerMs)) &&
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
    if (reload && this.phase === 'countdown') {
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
    if (
      (message.t === 'prog' || message.t === 'forfeit' || message.f === 1) &&
      ('matchId' in message || 'holeIndex' in message) &&
      (message.matchId !== this.matchId || message.holeIndex !== this.holeIndex)
    ) {
      this.audit('stale_round_message', {
        uid: player.uid,
        kind: message.f === 1 ? 'finish' : message.t,
      });
      return;
    }
    switch (message.t) {
      case 'join':
        return;
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
        if (!host) {
          this.error(ws, 'not-host', 'Only the host can manage the party.');
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
        const action = [
          'end',
          'skip',
          'time',
          'restart',
          'retry-next',
          'skip-next',
          'transfer-host',
        ].includes(String(message.action))
          ? String(message.action)
          : 'unknown';
        const actionMatch = this.matchId;
        const actionHole = this.holeIndex;
        this.audit('host_action_requested', {
          uid: player.uid,
          action,
          ...(typeof message.seconds === 'number' ? { seconds: message.seconds } : {}),
        });
        const ok = this.hostAction(ws, message);
        this.audit('host_action_result', {
          uid: player.uid,
          action,
          accepted: ok === true,
          previousMatchId: actionMatch,
          previousHoleIndex: actionHole,
        });
        return ack(
          ok === true,
          ok === true ? undefined : 'That action is not available right now.',
        );
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
        if (this.playable(player) && isIntegerInRange(message.st, 0, 200)) {
          if (player.strokes !== message.st) {
            this.audit('stroke_count', {
              uid: player.uid,
              previous: player.strokes,
              strokes: message.st,
            });
          }
          player.strokes = message.st;
          this.broadcast(this.board());
        }
        return;
      case 'forfeit':
        if (this.playable(player)) {
          this.finish(player, false);
        }
        return;
      default:
        break;
    }
    if (message.f === 1) {
      if (
        this.playable(player) &&
        isIntegerInRange(message.s, Math.max(1, player.strokes), 200) &&
        message.p === this.specs[this.holeIndex]?.par
      ) {
        player.strokes = message.s;
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
      const now = Date.now();
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
    ]) {
      if (key in configuration) {
        candidate[key] = configuration[key];
      }
    }
    if (
      !isIntegerInRange(candidate.timerMs, 20000, 300000) ||
      typeof candidate.elimination !== 'boolean' ||
      !isIntegerInRange(candidate.maxPlayers, 1, 50) ||
      typeof candidate.locked !== 'boolean' ||
      typeof candidate.excludeDaily !== 'boolean' ||
      typeof candidate.courseVoting !== 'boolean' ||
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
    };
    if (next.mapSource === MAP_SOURCE.RANDOM) {
      const count = 'holes' in configuration ? configuration.holes : this.config.randomHoles;
      if (!isIntegerInRange(count, 1, 9)) {
        return this.error(ws, 'invalid-config', 'Random matches must contain 1–9 holes.');
      }
      next.randomHoles = count;
      next.holes = count;
    } else {
      next.holes = Math.max(1, next.selectedHoleIds.length);
    }
    this.config = next;
    this.audit('configuration_changed', { uid: ws.data.uid, config: next });
    this.changed();
    this.broadcast(this.snapshot());
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
      this.starting = true;
      this.changed();
      this.broadcast(this.snapshot());
      Promise.resolve()
        .then(() => prepareMatch(configuration, previousSeen))
        .then(({ ids, specs, seen, ballots }) => {
          if (!this.closed && this.phase === 'lobby' && this.starting && this.hostUid === hostUid) {
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
        role: 'player',
        alive: true,
        participated: true,
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
        player.joinAfterHole !== undefined &&
        player.joinAfterHole < this.holeIndex
      ) {
        this.admitLatePlayer(player);
      }
      player.strokes = 0;
      player.done = false;
      player.holeTimeMs = undefined;
      player.success = false;
      player.lastPosition = 0;
      player.sceneReady = false;
      if (player.roundSpectator && player.alive) {
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
      deadline: this.startsAt + this.roundTimerMs,
      awaitingPlayers: waiting.length,
    });
    this.state();
    this.schedule(() => this.endHole(), this.roundTimerMs);
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
    if (message.matchId !== this.matchId || message.holeIndex !== this.holeIndex) {
      return;
    }
    if (typeof message.levelId === 'string' && !this.knownLevelIds().includes(message.levelId)) {
      return;
    }
    if (player.sceneReady || ws !== player.ws) {
      return;
    }
    player.sceneReady = true;
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
    const ballot = this.voteSnapshot();
    if (!ballot || this.phase !== 'hole-results') {
      return;
    }
    const maximum = Math.max(...ballot.choices.map((choice) => choice.votes));
    const tied = ballot.choices.filter((choice) => choice.votes === maximum);
    const winner = tied[randomInt(tied.length)];
    const course = this.voteCourses[ballot.target].find((choice) => choice.id === winner.id);
    if (!course) {
      throw new Error('Missing validated vote winner');
    }
    this.holeIds[ballot.target] = course.id;
    this.specs[ballot.target] = structuredClone(course.spec);
    this.audit('course_vote_closed', {
      target: ballot.target,
      title: course.title,
      choices: ballot.choices,
      winner: winner.id,
    });
    this.vote = null;
    this.holeIndex = ballot.target;
    this.begin();
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
      .then((item) => {
        if (stale()) {
          return;
        }
        this.audit('course_load_succeeded', { target, targetCourseId: id, name: item.spec.name });
        this.specs[target] = structuredClone(item.spec);
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
      player.alive &&
      player.participated &&
      !player.done &&
      Date.now() <= this.startsAt + this.roundTimerMs
    );
  }
  elapsedHoleMs() {
    if (this.phase === 'countdown') {
      return 0;
    }
    return Math.max(0, Math.min(this.roundTimerMs, Date.now() - this.startsAt));
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
        s: player.strokes,
        p: this.specs[this.holeIndex].par,
      });
    }
    this.broadcast(this.board());
    this.checkRoundDone();
  }
  checkRoundDone() {
    if (
      this.phase === 'playing' &&
      [...this.players.values()]
        .filter((player) => player.participated && player.alive)
        .every((player) => player.done)
    ) {
      this.endHole();
    }
  }
  hostAction(ws: RoomSocket, message: Record<string, unknown>) {
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
              strokes: player.success ? player.strokes : null,
              status: player.success ? 'holed' : 'ended',
              timeMs: player.holeTimeMs ?? this.elapsedHoleMs(),
            })),
        );
        for (const player of this.players.values()) {
          if (player.participated && player.alive && player.success) {
            player.totalStrokes += player.strokes;
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
      this.roundTimerMs = Math.min(900000, this.roundTimerMs + message.seconds * 1000);
      this.schedule(
        () => this.endHole(),
        Math.max(0, this.startsAt + this.roundTimerMs - Date.now()),
      );
      this.broadcast(this.snapshot());
      return true;
    }
    if (message.action === 'restart' && ['countdown', 'playing'].includes(this.phase)) {
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
  finalize() {
    clearTimeout(this.timer);
    this.loadingNext = false;
    this.vote = null;
    this.voteCourses = [];
    this.phase = 'final';
    this.state();
    const standings = this.standings();
    this.audit('match_finalized', { standings, rounds: this.roundHistory });
    this.broadcast({ t: 'final', podium: standings.slice(0, 3), standings });
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
          strokes: player.strokes,
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
        strokes: Math.max(player.strokes, this.specs[this.holeIndex].par + 5),
        status: 'timeout',
        timeMs: this.roundTimerMs,
      };
    });
    this.recordRound('completed', scores);
    for (const player of active) {
      player.done = true;
      player.holeTimeMs ??= this.elapsedHoleMs();
      if (player.success) {
        player.totalStrokes += player.strokes;
        player.totalTimeMs = (player.totalTimeMs ?? 0) + player.holeTimeMs;
        player.holesSurvived++;
      } else if (this.config.elimination) {
        player.alive = false;
        player.role = 'spectator';
      } else {
        player.totalStrokes += Math.max(player.strokes, this.specs[this.holeIndex].par + 5);
        player.holeTimeMs = this.roundTimerMs;
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
    this.audit('round_results', { standings: this.standings(), scores });
    this.state();
    this.schedule(() => {
      const alive = [...this.players.values()].filter(
        (player) => player.participated && player.alive,
      ).length;
      if (
        this.holeIndex + 1 >= this.holeIds.length ||
        (this.config.elimination && (alive === 0 || (this.initialPlayers > 1 && alive === 1)))
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
    this.vote = null;
    this.voteCourses = [];
    this.recoveryNotice = false;
    this.roundHistory = [];
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
        joinAfterHole: undefined,
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
  checkpoint(): RoomCheckpoint {
    // Persist only room configuration, public course metadata and credentials.
    // Never serialize course specifications, positions, sockets or timers.
    const titles = Object.fromEntries(
      this.config.selectedHoleIds.map((id) => [id, this.catalog.get(id)?.title ?? id]),
    );
    return {
      version: 1,
      code: this.code,
      hostToken: this.hostToken,
      hostUid: this.hostUid,
      hostTransfer: this.hostTransfer ? { ...this.hostTransfer } : null,
      issued: [...this.issued.values()],
      config: structuredClone(this.config),
      titles,
      randomSeen: [...this.randomSeen],
      phase: this.phase,
      starting: this.starting,
      lastActivity: this.lastActivity,
      recoveryNotice: this.recoveryNotice,
    };
  }
  restore(data: RoomCheckpoint) {
    this.hostToken = data.hostToken;
    this.hostUid = data.hostUid;
    const transfer = data.hostTransfer;
    this.hostTransfer =
      transfer && typeof transfer.toUid === 'string' && typeof transfer.fromUid === 'string'
        ? { fromUid: transfer.fromUid, toUid: transfer.toUid, at: Number(transfer.at) || 0 }
        : null;
    this.issued = new Map(data.issued.map((identity) => [identity.uid, identity]));
    this.config = {
      ...defaults,
      ...data.config,
      lateJoin: data.config.lateJoin ?? LATE_JOIN.NEVER,
      randomHoles:
        data.config.randomHoles ??
        (data.config.mapSource === MAP_SOURCE.RANDOM ? data.config.holes : 3),
    };
    this.randomSeen = Array.isArray(data.randomSeen) ? data.randomSeen.slice(0, 10000) : [];
    this.lastActivity = data.lastActivity;
    this.recoveryNotice = !!data.recoveryNotice || data.phase !== 'lobby' || !!data.starting;
    for (const id of this.config.selectedHoleIds) {
      if (!this.catalog.has(id)) {
        this.catalog.set(id, { id, title: data.titles?.[id] ?? id });
      }
    }
    // A restarted process cannot recover the original client physics state.
    // Restore as a lobby rather than resuming a partially scored round.
    this.phase = 'lobby';
    this.audit('room_recovered', {
      previousPhase: data.phase,
      recoveryNotice: this.recoveryNotice,
    });
  }
  dispose() {
    this.audit('room_disposed', { standings: this.standings() });
    this.closed = true;
    clearTimeout(this.timer);
    this.clearHostSuccession();
  }
}
