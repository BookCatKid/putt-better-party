import { randomUUID, randomBytes, randomInt } from 'node:crypto';
import {
  MAP_SOURCE,
  isRecord,
  errorMessage,
  type RoomConfig,
  type RoomPhase,
  type CourseIndex,
  type CourseSpecification,
  type PrepareMatch,
  type LoadCourse,
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
  readonly onIdle: (room: Room) => void;
  readonly onChange: (room: Room) => void;
  readonly prepareMatch: PrepareMatch | null;
  readonly loadMap: LoadCourse | null;
  starting = false;
  loadingNext = false;
  recoveryNotice = false;
  randomSeen: string[] = [];
  lastActivity = Date.now();
  lastCheckpoint = 0;
  hostToken = token();
  hostUid: string | null = null;
  issued = new Map<string, Identity>();
  players = new Map<string, Player>();
  phase: RoomPhase = 'lobby';
  roundHistory: RoundRecord[] = [];
  initialPlayers = 0;
  config: RoomConfig = { ...defaults, selectedHoleIds: [] };
  holeIds: string[] = [];
  specs: CourseSpecification[] = [];
  holeIndex = 0;
  matchId: string | null = null;
  startsAt = 0;
  roundTimerMs = defaults.timerMs;
  positions = new Map<string, BallPosition>();
  timer: ReturnType<typeof setTimeout> | undefined;
  closed = false;

  constructor(
    code: string,
    catalog: CourseIndex,
    {
      countdown = 5000,
      results = 4000,
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
    this.onIdle = onIdle;
    this.onChange = onChange;
    this.prepareMatch = prepareMatch;
    this.loadMap = loadMap;
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
    this.send(ws, { t: 'error', code, msg });
  }
  snapshot(): PartySnapshot {
    return {
      t: 'party',
      recoveryNotice: this.recoveryNotice,
      randomHistoryCount: this.randomSeen.length,
      preparing: this.starting || this.loadingNext,
      playlistTitles: Object.fromEntries(
        [...this.config.selectedHoleIds, ...this.holeIds].map((id) => [
          id,
          this.catalog.get(id)?.title || id,
        ]),
      ),
      roundHistory: this.roundHistory,
      initialPlayers: this.initialPlayers,
      phase: this.phase,
      holeIndex: this.holeIndex,
      holeIds: this.holeIds,
      currentMap: this.specs[this.holeIndex] ?? null,
      matchId: this.matchId,
      config: structuredClone(this.config),
      startsAt: this.startsAt,
      timerMs: ['countdown', 'playing'].includes(this.phase)
        ? this.roundTimerMs
        : this.config.timerMs,
      now: Date.now(),
    };
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
        isHost: player.uid === this.hostUid,
        ready: player.ready,
        alive: player.alive,
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
          leftPlayer.name.localeCompare(rightPlayer.name),
      )
      .map((player, index) => ({
        uid: player.uid,
        name: player.name,
        hue: player.hue,
        rank: index + 1,
        holesSurvived: player.holesSurvived,
        totalStrokes: player.totalStrokes,
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
        strokes: 0,
        done: false,
      };
      this.players.set(identity.uid, player);
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
      ['countdown', 'playing'].includes(this.phase) &&
      player.participated &&
      player.alive &&
      this.phase === 'playing'
    ) {
      // A new document has lost its local physics state; do not allow restarting that hole.
      player.done = true;
      player.success = player.success === true;
      player.roundSpectator = true;
      player.role = 'spectator';
    }
    player.instance = message.instance;
    player.id = randomUUID();
    player.ws = ws;
    ws.data.uid = player.uid;
    this.changed();
    this.send(ws, {
      t: 'hello',
      id: player.id,
      isHost: player.uid === this.hostUid,
      count: this.roster().length,
      role: player.role,
    });
    this.send(ws, this.snapshot());
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
  close(ws: RoomSocket) {
    const player = this.players.get(ws.data.uid ?? '');
    if (!player || player.ws !== ws) {
      return;
    }
    player.ws = null;
    this.lastActivity = Date.now();
    this.positions.delete(player.id);
    this.broadcast({ t: 'bye', id: player.id });
    if (this.phase === 'lobby' && player.uid !== this.hostUid) {
      this.players.delete(player.uid);
    }
    this.rosterBroadcast();
    this.changed();
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
      return;
    }
    switch (message.t) {
      case 'join':
        return;
      case 'ready':
        if (this.phase === 'lobby' && typeof message.v === 'boolean') {
          player.ready = message.v;
          this.rosterBroadcast();
        }
        return;
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
        if (message.matchId !== this.matchId || message.holeIndex !== this.holeIndex) {
          return ack(false, 'The round changed. Try again.');
        }
        const ok = this.hostAction(ws, message);
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
      case 'prog':
        if (this.playable(player) && isIntegerInRange(message.st, 0, 200)) {
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
        .then(({ ids, specs, seen }) => {
          if (!this.closed && this.phase === 'lobby' && this.starting && this.hostUid === hostUid) {
            this.holeIds = ids;
            this.specs = specs;
            if (Array.isArray(seen)) {
              this.randomSeen = seen;
            }
            this.startPrepared();
          }
        })
        .catch((error) => {
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
    this.startPrepared();
  }
  startPrepared() {
    this.matchId = randomUUID();
    this.holeIndex = 0;
    this.roundHistory = [];
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
        strokes: 0,
        done: false,
        ready: false,
      });
    }
    this.initialPlayers = [...this.players.values()].filter((player) => player.participated).length;
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
    this.roundTimerMs = this.config.timerMs;
    this.phase = 'countdown';
    this.startsAt = Date.now() + this.countdown;
    this.positions.clear();
    for (const player of this.players.values()) {
      player.strokes = 0;
      player.done = false;
      player.success = false;
      player.lastPosition = 0;
      if (player.roundSpectator && player.alive) {
        player.role = 'player';
        player.roundSpectator = false;
      }
    }
    this.state();
    this.schedule(() => {
      this.phase = 'playing';
      this.state();
      this.schedule(
        () => this.endHole(),
        Math.max(0, this.startsAt + this.roundTimerMs - Date.now()),
      );
    }, this.countdown);
  }
  advance() {
    const next = this.holeIndex + 1;
    if (next >= this.holeIds.length) {
      this.finalize();
      return;
    }
    if (this.specs[next]) {
      this.holeIndex = next;
      this.begin();
      return;
    }
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
    const old = this.holeIndex;
    const id = this.holeIds[next];
    Promise.resolve()
      .then(() => loadMap(id))
      .then((item) => {
        if (
          this.closed ||
          this.matchId !== match ||
          this.holeIndex !== old ||
          this.phase !== 'hole-results'
        ) {
          return;
        }
        this.specs[next] = structuredClone(item.spec);
        this.loadingNext = false;
        this.holeIndex = next;
        this.begin();
      })
      .catch((error) => {
        if (
          this.closed ||
          this.matchId !== match ||
          this.holeIndex !== old ||
          this.phase !== 'hole-results'
        ) {
          return;
        }
        this.loadingNext = false;
        for (const player of this.players.values()) {
          if (player.ws) {
            this.error(
              player.ws,
              'map-load-failed',
              'Could not load the next public hole: ' + errorMessage(error),
            );
          }
        }
        this.finalize();
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
  finish(player: Player, success: boolean) {
    player.done = true;
    player.success = success;
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
            })),
        );
        for (const player of this.players.values()) {
          if (player.participated && player.alive && player.success) {
            player.totalStrokes += player.strokes;
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
    this.error(ws, 'invalid-host-action', 'That action is not available right now.');
    return false;
  }
  recordRound(status: RoundStatus, rows: RoundScore[]) {
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
    this.phase = 'final';
    this.state();
    const standings = this.standings();
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
        return { uid: player.uid, strokes: player.strokes, status: 'holed' };
      }
      if (this.config.elimination) {
        return { uid: player.uid, strokes: null, status: 'eliminated' };
      }
      return {
        uid: player.uid,
        strokes: Math.max(player.strokes, this.specs[this.holeIndex].par + 5),
        status: 'timeout',
      };
    });
    this.recordRound('completed', scores);
    for (const player of active) {
      player.done = true;
      if (player.success) {
        player.totalStrokes += player.strokes;
        player.holesSurvived++;
      } else if (this.config.elimination) {
        player.alive = false;
        player.role = 'spectator';
      } else {
        player.totalStrokes += Math.max(player.strokes, this.specs[this.holeIndex].par + 5);
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
    clearTimeout(this.timer);
    this.loadingNext = false;
    this.phase = 'lobby';
    this.recoveryNotice = false;
    this.roundHistory = [];
    this.initialPlayers = 0;
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
        roundSpectator: false,
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
    this.issued = new Map(data.issued.map((identity) => [identity.uid, identity]));
    this.config = {
      ...defaults,
      ...data.config,
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
  }
  dispose() {
    this.closed = true;
    clearTimeout(this.timer);
  }
}
