import { randomUUID, randomBytes, randomInt } from 'node:crypto';
const token = () => randomBytes(24).toString('base64url');
export const defaults = Object.freeze({
  holes: 3,
  timerMs: 60000,
  elimination: true,
  maxPlayers: 50,
  mapSource: 'random',
  selectedHoleIds: [],
  locked: false,
  excludeDaily: false,
  randomHoles: 3,
});
const integer = (v, a, b) => Number.isInteger(v) && v >= a && v <= b;
const num = (v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e5;
export class Room {
  constructor(
    code,
    catalog,
    {
      countdown = 5000,
      results = 4000,
      onIdle = () => {},
      onChange = () => {},
      prepareMatch = null,
      loadMap = null,
    } = {},
  ) {
    Object.assign(this, {
      code,
      catalog,
      countdown,
      results,
      onIdle,
      onChange,
      prepareMatch,
      loadMap,
      starting: false,
      loadingNext: false,
      recoveryNotice: false,
      randomSeen: [],
      lastActivity: Date.now(),
      hostToken: token(),
      hostUid: null,
      issued: new Map(),
      players: new Map(),
      phase: 'lobby',
      roundHistory: [],
      initialPlayers: 0,
      config: { ...defaults },
      holeIds: [],
      specs: [],
      holeIndex: 0,
      matchId: null,
      startsAt: 0,
      roundTimerMs: defaults.timerMs,
      positions: new Map(),
      timer: null,
      closed: false,
    });
  }
  issue(name, uid, session) {
    this.lastActivity = Date.now();
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 24)
      throw Error('Name must contain 1–24 characters');
    const previous = this.issued.get(uid);
    if (previous && previous.session === session) return previous;
    if (this.config.locked) throw Error('This party is locked to existing players.');
    if (uid && session) throw Error('Session expired; join again with a new identity.');
    if ([...this.players.values()].filter((p) => p.ws).length >= this.config.maxPlayers)
      throw Error('Party is full.');
    if (this.issued.size >= 200) throw Error('Room identity limit reached');
    const j = { uid: randomUUID(), session: token(), name: name.trim(), hue: randomInt(360) };
    this.issued.set(j.uid, j);
    this.changed();
    return j;
  }
  send(ws, m) {
    try {
      ws.send(JSON.stringify(m));
    } catch {}
  }
  broadcast(m) {
    for (const p of this.players.values()) if (p.ws) this.send(p.ws, m);
  }
  error(ws, code, msg) {
    this.send(ws, { t: 'error', code, msg });
  }
  snapshot() {
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
      .filter((p) => p.ws || this.phase !== 'lobby')
      .map((p) => ({
        id: p.id,
        uid: p.uid,
        name: p.name,
        hue: p.hue,
        role: p.role,
        isHost: p.uid === this.hostUid,
        ready: p.ready,
        alive: p.alive,
      }));
  }
  standings() {
    return [...this.players.values()]
      .filter((p) => p.participated)
      .sort(
        (a, b) =>
          b.holesSurvived - a.holesSurvived ||
          Number(b.alive) - Number(a.alive) ||
          a.totalStrokes - b.totalStrokes ||
          a.name.localeCompare(b.name),
      )
      .map((p, i) => ({
        uid: p.uid,
        name: p.name,
        hue: p.hue,
        rank: i + 1,
        holesSurvived: p.holesSurvived,
        totalStrokes: p.totalStrokes,
        alive: p.alive,
        strokes: p.strokes,
        finished: p.done,
      }));
  }
  board() {
    const rows = [...this.players.values()].filter((p) => p.alive && p.participated);
    return {
      t: 'board',
      standings: this.standings(),
      alive: rows.length,
      holed: rows.filter((p) => p.success).length,
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
  join(ws, m) {
    if (
      m.protocol !== 2 ||
      !this.issued.has(m.uid) ||
      m.session !== this.issued.get(m.uid).session
    ) {
      this.error(ws, 'invalid-join', 'Obtain a local join credential first.');
      ws.close(1008);
      return;
    }
    this.lastActivity = Date.now();
    let p = this.players.get(m.uid);
    const reload = !!p && p.instance !== undefined && p.instance !== m.instance;
    if (
      !p &&
      m.uid !== this.hostUid &&
      m.host !== this.hostToken &&
      [...this.players.values()].filter((p) => p.ws).length >= this.config.maxPlayers
    ) {
      this.error(ws, 'full', 'Room is full');
      ws.close(1008);
      return;
    }
    if (m.host === this.hostToken && (!this.hostUid || this.hostUid === m.uid))
      this.hostUid = m.uid;
    if (!p) {
      p = {
        uid: m.uid,
        name: this.issued.get(m.uid).name,
        hue: this.issued.get(m.uid).hue,
        role: this.phase === 'lobby' ? 'player' : 'spectator',
        ready: false,
        alive: this.phase === 'lobby',
        participated: false,
        holesSurvived: 0,
        totalStrokes: 0,
        strokes: 0,
        done: false,
      };
      this.players.set(m.uid, p);
    }
    if (p.ws && p.ws !== ws) {
      const old = p.ws;
      p.ws = null;
      old.close(1000, 'Reconnected');
      this.broadcast({ t: 'bye', id: p.id });
      this.positions.delete(p.id);
    }
    if (
      reload &&
      ['countdown', 'playing'].includes(this.phase) &&
      p.participated &&
      p.alive &&
      this.phase === 'playing'
    ) {
      // A new document has lost its local physics state; do not allow restarting that hole.
      p.done = true;
      p.success = p.success === true;
      p.roundSpectator = true;
      p.role = 'spectator';
    }
    p.instance = m.instance;
    p.id = randomUUID();
    p.ws = ws;
    ws.data.uid = p.uid;
    this.changed();
    this.send(ws, {
      t: 'hello',
      id: p.id,
      isHost: p.uid === this.hostUid,
      count: this.roster().length,
      role: p.role,
    });
    this.send(ws, this.snapshot());
    this.rosterBroadcast();
    this.broadcast(this.board());
    if (this.phase === 'playing') this.checkRoundDone();
    if (this.phase === 'final') {
      const standings = this.standings();
      this.send(ws, { t: 'final', podium: standings.slice(0, 3), standings });
    }
  }
  close(ws) {
    const p = this.players.get(ws.data.uid);
    if (!p || p.ws !== ws) return;
    p.ws = null;
    this.lastActivity = Date.now();
    this.positions.delete(p.id);
    this.broadcast({ t: 'bye', id: p.id });
    if (this.phase === 'lobby' && p.uid !== this.hostUid) this.players.delete(p.uid);
    this.rosterBroadcast();
    this.changed();
    this.onIdle(this);
  }
  handle(ws, m) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) return;
    if (!ws.data.uid) {
      if (m.t === 'join') this.join(ws, m);
      return;
    }
    const p = this.players.get(ws.data.uid);
    if (!p || p.ws !== ws) return;
    this.lastActivity = Date.now();
    const host = p.uid === this.hostUid;
    if (
      (m.t === 'prog' || m.t === 'forfeit' || m.f === 1) &&
      ('matchId' in m || 'holeIndex' in m) &&
      (m.matchId !== this.matchId || m.holeIndex !== this.holeIndex)
    )
      return;
    switch (m.t) {
      case 'join':
        return;
      case 'ready':
        if (this.phase === 'lobby' && typeof m.v === 'boolean') {
          p.ready = m.v;
          this.rosterBroadcast();
        }
        return;
      case 'config':
        if (!host || this.phase !== 'lobby')
          return this.error(ws, 'not-host', 'Only the host can configure the lobby.');
        return this.configure(ws, m.config);
      case 'start':
        if (host && this.phase === 'lobby') this.start(ws);
        return;
      case 'ping':
        if (this.lastActivity - (this.lastCheckpoint ?? 0) > 60000) {
          this.lastCheckpoint = this.lastActivity;
          this.changed();
        }
        return this.send(ws, { t: 'pong' });
      case 'host-action': {
        const ack = (ok, msg) => {
          if (typeof m.requestId === 'string' && m.requestId.length <= 80)
            this.send(ws, { t: 'host-ack', requestId: m.requestId, ok, msg });
        };
        if (!host) {
          this.error(ws, 'not-host', 'Only the host can manage the party.');
          return ack(false, 'Only the host can manage the party.');
        }
        if (m.matchId !== this.matchId || m.holeIndex !== this.holeIndex)
          return ack(false, 'The round changed. Try again.');
        const ok = this.hostAction(ws, m);
        return ack(
          ok === true,
          ok === true ? undefined : 'That action is not available right now.',
        );
      }
      case 'rematch':
        if (host && this.phase === 'final') this.reset();
        return;
      case 'prog':
        if (this.playable(p) && integer(m.st, 0, 200)) {
          p.strokes = m.st;
          this.broadcast(this.board());
        }
        return;
      case 'forfeit':
        if (this.playable(p)) this.finish(p, false);
        return;
      default:
        break;
    }
    if (m.f === 1) {
      if (
        this.playable(p) &&
        integer(m.s, Math.max(1, p.strokes), 200) &&
        m.p === this.specs[this.holeIndex]?.par
      ) {
        p.strokes = m.s;
        this.finish(p, true);
      }
      return;
    }
    if (
      p.role === 'player' &&
      ['x', 'y', 'z', 'px', 'pz'].every((k) => num(m[k])) &&
      (m.c === 0 || m.c === 1) &&
      (m.m === 0 || m.m === 1)
    ) {
      const now = Date.now();
      if (now - (p.lastPosition ?? 0) < 40) return;
      p.lastPosition = now;
      this.positions.set(p.id, {
        id: p.id,
        x: m.x,
        y: m.y,
        z: m.z,
        px: m.px,
        pz: m.pz,
        c: m.c,
        m: m.m,
        ...(num(m.d) ? { d: m.d } : {}),
      });
    }
  }
  configure(ws, c) {
    if (this.starting) return this.error(ws, 'starting', 'Please wait while courses are loading.');
    if (!c || typeof c !== 'object' || Array.isArray(c)) return;
    const next = { ...this.config };
    for (const k of [
      'holes',
      'timerMs',
      'elimination',
      'maxPlayers',
      'mapSource',
      'selectedHoleIds',
      'locked',
      'excludeDaily',
    ])
      if (k in c) next[k] = c[k];
    if (
      !integer(next.timerMs, 20000, 300000) ||
      typeof next.elimination !== 'boolean' ||
      !integer(next.maxPlayers, 1, 50) ||
      typeof next.locked !== 'boolean' ||
      typeof next.excludeDaily !== 'boolean' ||
      !['random', 'picked'].includes(next.mapSource) ||
      !Array.isArray(next.selectedHoleIds) ||
      next.selectedHoleIds.some((id) => typeof id !== 'string' || !this.catalog.has(id))
    )
      return this.error(ws, 'invalid-config', 'Invalid configuration or unknown public map.');
    if (next.mapSource === 'random') {
      const count = 'holes' in c ? c.holes : this.config.randomHoles;
      if (!integer(count, 1, 9))
        return this.error(ws, 'invalid-config', 'Random matches must contain 1–9 holes.');
      next.randomHoles = count;
      next.holes = count;
    } else next.holes = Math.max(1, next.selectedHoleIds.length);
    this.config = next;
    this.changed();
    this.broadcast(this.snapshot());
  }
  start(ws) {
    if (this.config.mapSource === 'picked' && !this.config.selectedHoleIds.length)
      return this.error(ws, 'empty-playlist', 'Choose at least one course');
    if (this.starting) return;
    if (this.prepareMatch) {
      this.starting = true;
      this.changed();
      this.broadcast(this.snapshot());
      Promise.resolve()
        .then(() => this.prepareMatch(structuredClone(this.config), [...this.randomSeen]))
        .then(({ ids, specs, seen }) => {
          if (!this.closed && this.phase === 'lobby' && this.players.get(this.hostUid)?.ws === ws) {
            this.holeIds = ids;
            this.specs = specs;
            if (Array.isArray(seen)) this.randomSeen = seen;
            this.startPrepared();
          }
        })
        .catch((e) => this.error(ws, 'map-load-failed', e.message))
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
    if (!source.length) return this.error(ws, 'empty-catalog', 'No validated maps');
    let deck = [];
    const random = () => {
      if (!deck.length) deck = source.slice();
      return deck.splice(randomInt(deck.length), 1)[0];
    };
    this.holeIds =
      this.config.mapSource === 'picked'
        ? this.config.selectedHoleIds.slice()
        : Array.from({ length: this.config.holes }, random);
    this.specs = this.holeIds.map((id) => structuredClone(this.catalog.get(id).spec));
    this.startPrepared();
  }
  startPrepared() {
    this.matchId = randomUUID();
    this.holeIndex = 0;
    this.roundHistory = [];
    this.recoveryNotice = false;
    for (const [uid, p] of this.players) {
      if (!p.ws) {
        this.players.delete(uid);
        continue;
      }
      Object.assign(p, {
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
    this.initialPlayers = [...this.players.values()].filter((p) => p.participated).length;
    this.begin();
  }
  schedule(fn, ms) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (!this.closed) fn();
    }, ms);
  }
  begin() {
    this.roundTimerMs = this.config.timerMs;
    this.phase = 'countdown';
    this.startsAt = Date.now() + this.countdown;
    this.positions.clear();
    for (const p of this.players.values()) {
      p.strokes = 0;
      p.done = false;
      p.success = false;
      p.lastPosition = 0;
      if (p.roundSpectator && p.alive) {
        p.role = 'player';
        p.roundSpectator = false;
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
    if (!this.loadMap) {
      this.finalize();
      return;
    }
    clearTimeout(this.timer);
    this.loadingNext = true;
    this.phase = 'hole-results';
    this.state();
    const match = this.matchId,
      old = this.holeIndex,
      id = this.holeIds[next];
    Promise.resolve()
      .then(() => this.loadMap(id))
      .then((item) => {
        if (
          this.closed ||
          this.matchId !== match ||
          this.holeIndex !== old ||
          this.phase !== 'hole-results'
        )
          return;
        this.specs[next] = structuredClone(item.spec);
        this.loadingNext = false;
        this.holeIndex = next;
        this.begin();
      })
      .catch((e) => {
        if (
          this.closed ||
          this.matchId !== match ||
          this.holeIndex !== old ||
          this.phase !== 'hole-results'
        )
          return;
        this.loadingNext = false;
        for (const p of this.players.values())
          if (p.ws)
            this.error(
              p.ws,
              'map-load-failed',
              'Could not load the next public hole: ' + e.message,
            );
        this.finalize();
      });
  }
  playable(p) {
    return (
      this.phase === 'playing' &&
      p.alive &&
      p.participated &&
      !p.done &&
      Date.now() <= this.startsAt + this.roundTimerMs
    );
  }
  finish(p, success) {
    p.done = true;
    p.success = success;
    if (success)
      this.broadcast({ t: 'f', id: p.id, s: p.strokes, p: this.specs[this.holeIndex].par });
    this.broadcast(this.board());
    this.checkRoundDone();
  }
  checkRoundDone() {
    if (
      this.phase === 'playing' &&
      [...this.players.values()].filter((p) => p.participated && p.alive).every((p) => p.done)
    )
      this.endHole();
  }
  hostAction(ws, m) {
    if (m.action === 'end' && ['countdown', 'playing', 'hole-results'].includes(this.phase)) {
      // Close the match with scores from completed rounds. Do not penalize an interrupted round.
      if (this.phase === 'playing' || this.phase === 'countdown') {
        this.recordRound(
          'ended',
          [...this.players.values()]
            .filter((p) => p.participated && p.alive)
            .map((p) => ({
              uid: p.uid,
              strokes: p.success ? p.strokes : null,
              status: p.success ? 'holed' : 'ended',
            })),
        );
        for (const p of this.players.values())
          if (p.participated && p.alive && p.success) {
            p.totalStrokes += p.strokes;
            p.holesSurvived++;
          }
      }
      this.finalize();
      return true;
    }
    if (m.action === 'skip' && ['countdown', 'playing'].includes(this.phase)) {
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
    if (m.action === 'time' && this.phase === 'playing' && [15, 30, 60].includes(m.seconds)) {
      this.roundTimerMs = Math.min(900000, this.roundTimerMs + m.seconds * 1000);
      this.schedule(
        () => this.endHole(),
        Math.max(0, this.startsAt + this.roundTimerMs - Date.now()),
      );
      this.broadcast(this.snapshot());
      return true;
    }
    if (m.action === 'restart' && ['countdown', 'playing'].includes(this.phase)) {
      // New match identity forces the original route to reload even when the map ID is unchanged.
      this.matchId = randomUUID();
      this.begin();
      return true;
    }
    this.error(ws, 'invalid-host-action', 'That action is not available right now.');
    return false;
  }
  recordRound(status, rows) {
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
    if (this.phase !== 'playing') return;
    clearTimeout(this.timer);
    const active = [...this.players.values()].filter((p) => p.alive && p.participated);
    // The original results UI says non-finishers are eliminated. Exact tie/penalty
    // policy is not available in the client bundles; use a documented local rule.
    const scores = active.map((p) => ({
      uid: p.uid,
      strokes: p.success
        ? p.strokes
        : this.config.elimination
          ? null
          : Math.max(p.strokes, this.specs[this.holeIndex].par + 5),
      status: p.success ? 'holed' : this.config.elimination ? 'eliminated' : 'timeout',
    }));
    this.recordRound('completed', scores);
    for (const p of active) {
      p.done = true;
      if (p.success) {
        p.totalStrokes += p.strokes;
        p.holesSurvived++;
      } else if (this.config.elimination) {
        p.alive = false;
        p.role = 'spectator';
      } else {
        p.totalStrokes += Math.max(p.strokes, this.specs[this.holeIndex].par + 5);
        p.holesSurvived++;
      }
    }
    if (!this.config.elimination)
      for (const p of active)
        if (p.roundSpectator) {
          p.role = 'player';
          p.roundSpectator = false;
        }
    this.phase = 'hole-results';
    this.state();
    this.schedule(() => {
      const alive = [...this.players.values()].filter((p) => p.participated && p.alive).length;
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
    for (const [id, p] of this.players) {
      if (!p.ws && id !== this.hostUid) {
        this.players.delete(id);
        continue;
      }
      Object.assign(p, {
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
  checkpoint() {
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
  restore(data) {
    this.hostToken = data.hostToken;
    this.hostUid = data.hostUid;
    this.issued = new Map(data.issued.map((j) => [j.uid, j]));
    this.config = {
      ...defaults,
      ...data.config,
      randomHoles:
        data.config.randomHoles ?? (data.config.mapSource === 'random' ? data.config.holes : 3),
    };
    this.randomSeen = Array.isArray(data.randomSeen) ? data.randomSeen.slice(0, 10000) : [];
    this.lastActivity = data.lastActivity;
    this.recoveryNotice = !!data.recoveryNotice || data.phase !== 'lobby' || !!data.starting;
    for (const id of this.config.selectedHoleIds)
      if (!this.catalog.has(id)) this.catalog.set(id, { id, title: data.titles?.[id] ?? id });
    // A restarted process cannot recover the original client physics state.
    // Restore as a lobby rather than resuming a partially scored round.
    this.phase = 'lobby';
  }
  dispose() {
    this.closed = true;
    clearTimeout(this.timer);
  }
}
