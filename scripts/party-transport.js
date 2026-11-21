import { createReplayRecorder } from './replay-timeline.js';
/**
 * Party WebSocket adapter for the original game's state stores and presence API.
 * Wire fields and the 100ms ghost update loop follow the pinned GameCanvas bundle.
 * Every environment touchpoint (socket constructor, timers, location, document and
 * the upstream state-store bindings) resolves through an injectable bindings object
 * so the adapter can be exercised offline; production falls back to the bundle globals.
 */
// Chromium rejects timer globals invoked with a foreign receiver, so production
// bindings call them directly instead of being handed the global itself. Injected
// test bindings are used as given.
/** @param {() => void} handler @param {number} delayMs */
const globalSetTimeout = (handler, delayMs) => setTimeout(handler, delayMs);
/** @param {TimerHandle | undefined} handle */
const globalClearTimeout = (handle) => clearTimeout(handle);
/** @param {() => void} handler @param {number} delayMs */
const globalSetInterval = (handler, delayMs) => setInterval(handler, delayMs);
/** @param {TimerHandle | undefined} handle */
const globalClearInterval = (handle) => clearInterval(handle);

/**
 * How much of the server's round budget the client declines to use.
 *
 * The runtime turns the server's absolute `startsAt` into a client deadline by
 * adding `timerMs`, anchored on the moment the snapshot arrives. That deadline
 * therefore lands one one-way trip *after* the server's own
 * `startsAt + timerMs`: for that long the client shows time the server will not
 * accept, and a shot taken at the very end is sent, rejected and lost. Trimming
 * the budget keeps the visible deadline inside the server's window.
 *
 * Only the end is moved. `startsAt` is untouched, so play is never unblocked
 * early - the opposite hazard, where the client lets a player putt before the
 * server accepts, would be worse than a slightly short timer. A quarter second is
 * imperceptible on a countdown and covers a normal one-way trip with jitter.
 */
const CLOCK_SAFETY_MARGIN_MS = 250;

/**
 * @param {Partial<TransportBindings>} [injected]
 * @returns {TransportBindings}
 */
function resolveTransportBindings(injected) {
  const provided = injected || {};
  return {
    WebSocket: provided.WebSocket ?? WebSocket,
    location: provided.location ?? location,
    document: provided.document ?? document,
    setTimeout: provided.setTimeout ?? globalSetTimeout,
    clearTimeout: provided.clearTimeout ?? globalClearTimeout,
    setInterval: provided.setInterval ?? globalSetInterval,
    clearInterval: provided.clearInterval ?? globalClearInterval,
    probeRoom:
      provided.probeRoom ??
      ((roomCode) =>
        fetch('/api/room/' + encodeURIComponent(roomCode), {
          signal: AbortSignal.timeout(5_000),
        }).then((response) => response.status)),
    partyStore: provided.partyStore ?? transportPartyStore,
    gameStore: provided.gameStore ?? transportGameStore,
    settingsStore: provided.settingsStore ?? transportSettings,
    scene: provided.scene ?? transportScene,
    connection: provided.connection ?? bpConnection,
    registerSender: provided.registerSender ?? registerTransportSender,
    setIdentity: provided.setIdentity ?? setTransportIdentity,
    capturedHostToken: provided.capturedHostToken ?? receiveTransportHostToken,
    dropHostToken: provided.dropHostToken ?? clearTransportHostToken,
    updateParty: provided.updateParty ?? updateTransportParty,
    setFlyCamera: provided.setFlyCamera ?? setTransportFlyCamera,
    setRoster: provided.setRoster ?? setTransportRoster,
    setBoard: provided.setBoard ?? setTransportBoard,
    setFinal: provided.setFinal ?? setTransportFinal,
    removeGhost: provided.removeGhost ?? removeTransportGhost,
    showCompletion: provided.showCompletion ?? showTransportCompletion,
    ghostHue: provided.ghostHue ?? transportGhostHue,
    setError: provided.setError ?? setTransportError,
    updateGhost: provided.updateGhost ?? updateTransportGhost,
    sceneReadyLevelId: provided.sceneReadyLevelId ?? transportSceneReadyLevelId,
    isSpectator: provided.isSpectator ?? isTransportSpectator,
    ack: provided.ack ?? bpAck,
    notice: provided.notice ?? (provided.partyStore ? () => {} : bpHostNotice),
    updateVote: provided.updateVote ?? (provided.partyStore ? () => {} : bpReceiveVote),
  };
}

/**
 * @param {string} code
 * @param {{ uid: string; name: string; hue: number; session?: string; instance?: unknown }} identity
 * @param {TransportOptions} [options]
 */
function connectBetterParty(code, identity, options = {}) {
  const bind = resolveTransportBindings(options.bindings);
  const { onError } = options;
  // The capability is not fixed for the life of the connection: authority can
  // move, and a reconnect has to claim with whatever the current host holds.
  let hostToken = options.hostToken;
  const initialRetryDelay = 1000;
  const maximumRetryDelay = 15_000;
  /**
   * Reconnect delays are jittered by ±20%.
   *
   * Without it, every client dropped by the same event - a restart, a blip on the
   * shared host - retries at the same instant and then doubles together, so the
   * server takes the whole party back in synchronised waves. The spread is small
   * enough that a reconnect stays prompt and large enough to break up the herd.
   */
  const retryJitter = 0.2;
  /**
   * Bytes queued on our own socket before presence samples are skipped.
   *
   * Matches the server's limit for the same reason: presence is the only frame
   * sent on a timer, so it is the only one worth dropping when the link is behind.
   * Results and acknowledgements are never dropped here - they are not timer-driven.
   */
  const PRESENCE_BACKLOG_LIMIT = 64 * 1024;
  /** @type {WebSocket | null} */
  let socket = null;
  let disposed = false;
  /** @type {TimerHandle | undefined} */
  let reconnectTimer;
  /** @type {TimerHandle | undefined} */
  let handshakeTimer;
  let retryDelay = initialRetryDelay;
  let connectionId = '';
  let synchronized = false;
  let awaitingSnapshot = true;
  let receivedRoster = false;
  let receivedBoard = false;
  let terminalError = '';
  let lastHoleIndex = -1;
  let lastStrokeCount = -1;
  let lastShotCount = 0;
  let completionSent = false;
  let forfeitSent = false;
  let roundChangePending = false;
  let sawMapReadyFalse = false;
  // The attempt sequence the game store held when the round changed. A new
  // attempt has to advance it before progress may be reported again.
  /** @type {number | null} */
  let attemptAtRoundChange = null;
  let announcedSceneKey = '';
  // A socket can be half-open: the peer is gone but no close event ever arrives,
  // so sends keep "succeeding" into the void. Counting unanswered heartbeats is
  // the only way to notice, and a real drop is what forces a reconnect.
  let unansweredPings = 0;
  const replayRecorder = createReplayRecorder();

  function socketOpen() {
    return socket?.readyState === bind.WebSocket.OPEN;
  }

  /**
   * @param {unknown} message
   * @param {boolean} [requireSynchronization]
   * @returns {boolean}
   */
  function send(message, requireSynchronization = true) {
    if (!socketOpen() || (requireSynchronization && !synchronized)) {
      return false;
    }
    if (typeof message !== 'object' || message === null) {
      return false;
    }
    const frame = /** @type {Record<string, unknown>} */ (message);
    let packet = frame;
    if (
      frame.t === 'prog' ||
      frame.t === 'forfeit' ||
      frame.t === 'replay-samples' ||
      frame.t === 'shot' ||
      frame.t === 'scene' ||
      frame.f === 1
    ) {
      const { matchId, holeIndex, bpAttempt } = bind.partyStore.state;
      packet = { ...frame, matchId, holeIndex, ...(bpAttempt ? { attempt: bpAttempt } : {}) };
    }
    if (!socket) {
      return false;
    }
    socket.send(JSON.stringify(packet));
    return true;
  }

  /**
   * Tell the server this client's level is prepared for the current round. The
   * server gates the round start on that report, so it must carry the round
   * identity: a stale document's report cannot unblock a newer round.
   */
  function reportSceneReadiness() {
    const party = bind.partyStore.state;
    const levelId = bind.sceneReadyLevelId();
    // The route may still hold the previous course while it reloads, so only a
    // prepared level matching the round's map counts as ready.
    if (!party.matchId || !levelId || levelId !== party.currentMap?.id) {
      return;
    }
    if (
      (party.bpResetPending && (roundChangePending || !party.mapReady)) ||
      (party.phase !== 'countdown' && !(party.phase === 'playing' && party.bpResetPending))
    ) {
      return;
    }
    const key =
      party.matchId + ':' + party.holeIndex + ':' + levelId + ':' + (party.bpAttempt ?? 0);
    if (announcedSceneKey === key) {
      return;
    }
    if (send({ t: 'scene', matchId: party.matchId, holeIndex: party.holeIndex, levelId })) {
      announcedSceneKey = key;
    }
  }

  function reportProgress() {
    observePartyState();
    reportSceneReadiness();
    const party = bind.partyStore.state;
    if (
      !synchronized ||
      roundChangePending ||
      party.phase !== 'playing' ||
      !party.mapReady ||
      party.bpPausedAt ||
      party.bpResetPending ||
      party.selfRole === 'spectator'
    ) {
      return;
    }
    const game = bind.gameStore.state;
    // The exact shot input is sent as the stroke is taken, before the
    // trajectory it produced is reported. The server records these frames so it
    // can replay the shot and check the reported result against the physics.
    // `game.shots` is a list the pinned bundle already keeps; it only grows.
    const shots = Array.isArray(game.shots) ? game.shots : [];
    if (shots.length < lastShotCount) {
      // A restart discards the attempt's shots; the server drops its copy in
      // the same epoch, so resynchronise rather than skipping the fresh ones.
      lastShotCount = shots.length;
    }
    if (shots.length > lastShotCount) {
      for (const shot of shots.slice(lastShotCount)) {
        if (
          shot &&
          Array.isArray(shot.dir) &&
          send({
            t: 'shot',
            dir: [Number(shot.dir[0]), Number(shot.dir[1])],
            power: Number(shot.power),
          })
        ) {
          lastShotCount += 1;
        } else {
          break; // A send that failed leaves the count so the shot is retried.
        }
      }
    }
    if (!party.bpPuttingLocked && game.strokes !== lastStrokeCount && game.phase !== 'holed') {
      if (send({ t: 'prog', st: game.strokes })) {
        lastStrokeCount = game.strokes;
      }
    }
    if (game.phase === 'forfeit' && !forfeitSent) {
      replayRecorder.sample(party, game, bind.scene, Date.now(), true);
      const replay = replayRecorder.payload(party, game, bind.scene, true);
      forfeitSent = send({ t: 'forfeit', ...(replay ? { replay } : {}) });
      if (forfeitSent) {
        replayRecorder.sent();
      }
    }
    if (game.phase === 'holed' && game.result && !completionSent) {
      replayRecorder.sample(party, game, bind.scene, Date.now(), true);
      const replay = replayRecorder.payload(party, game, bind.scene, true);
      completionSent = send({
        f: 1,
        s: game.result.strokes,
        p: game.result.par,
        ...(replay ? { replay } : {}),
      });
      if (completionSent) {
        replayRecorder.sent();
      }
    }
  }

  function completeHandshake() {
    if (synchronized || awaitingSnapshot || !receivedRoster || !receivedBoard) {
      return;
    }
    // The handshake deadline only guards the opening exchange; a synchronized
    // connection must not be closed by its own timeout.
    bind.clearTimeout(handshakeTimer);
    synchronized = true;
    retryDelay = initialRetryDelay;
    bind.connection(true);
    // This is the one point where the connection has provably recovered, so it is
    // where a warning from the outage stops being true. `bpConnection(true)` clears
    // the connection failure; the runtime's own error field is separate and would
    // otherwise survive a drop and reappear under the next map load, reporting a
    // problem that was resolved minutes ago.
    bind.setError('');
    reportProgress();
  }

  /**
   * After the round changes, the local game state is stale until the route
   * reloads the level. Progress, forfeit and completion messages must not be
   * sent from a stale game state because they would be scoped to the new round.
   * The route signals a reload by clearing map readiness and confirms the fresh
   * attempt by restoring it; the game store then updates with the new level.
   * This is observed from the game-store subscription to avoid cross-store
   * reads inside the party store's reactive subscription.
   */
  function freshAttemptConfirmed() {
    const party = bind.partyStore.state;
    const game = bind.gameStore.state;
    if (
      !party.currentMap?.id ||
      party.mapReady !== true ||
      game.level?.id !== party.currentMap.id
    ) {
      return false;
    }
    // A restart or a repeat of the same course reuses the very same course
    // identifier, so the level ID cannot prove that the renderer installed a new
    // attempt: the game store may still hold the previous attempt, finished and
    // complete. Installing a level advances the attempt sequence exactly once,
    // so an unchanged sequence means the stale attempt is still in place.
    return typeof game.attemptSeq !== 'number' || game.attemptSeq !== attemptAtRoundChange;
  }

  function observePartyState() {
    if (!roundChangePending) {
      return;
    }
    const mapReady = bind.partyStore.state.mapReady === true;
    if (!mapReady) {
      sawMapReadyFalse = true;
      return;
    }
    if (sawMapReadyFalse && freshAttemptConfirmed()) {
      roundChangePending = false;
      sawMapReadyFalse = false;
    }
  }

  /** @param {Record<string, any>} message */
  function receiveSnapshot(message) {
    const previous = bind.partyStore.state;
    const sameRound =
      previous.matchId === message.matchId &&
      previous.holeIndex === message.holeIndex &&
      previous.holeIds[previous.holeIndex] === message.holeIds[message.holeIndex];

    if (
      !sameRound ||
      lastHoleIndex !== message.holeIndex ||
      message.phase === 'lobby' ||
      awaitingSnapshot
    ) {
      lastHoleIndex = message.holeIndex;
      completionSent = false;
      forfeitSent = false;
      lastStrokeCount = -1;
      lastShotCount = 0;
    }
    // A snapshot only describes a round change when this connection already
    // knew a round. The very first snapshot introduces the round instead: the
    // route has either preloaded this level in the lobby or loads it now and
    // raises map readiness before play, so no staleness latch is needed.
    const hadRound = previous.matchId != null;
    const roundChanged =
      hadRound && (!sameRound || (message.phase === 'lobby' && previous.phase !== 'lobby'));
    if (roundChanged) {
      for (const player of previous.roster ?? []) {
        bind.removeGhost(player.id);
      }
      lastPosition = '';
      roundChangePending = true;
      // Remember which attempt was live when the round changed, so the fresh
      // attempt can be told apart from the stale one even when the course is
      // identical.
      const sequence = bind.gameStore.state.attemptSeq;
      attemptAtRoundChange = typeof sequence === 'number' ? sequence : null;
      if (bind.partyStore.state.mapReady !== true) {
        sawMapReadyFalse = true;
      }
    }

    if (message.pausedAt && !previous.bpPausedAt) {
      completionSent = false;
      forfeitSent = false;
      lastStrokeCount = -1;
    }
    bind.updateParty(
      message.phase === 'playing' && typeof message.timerMs === 'number'
        ? // See CLOCK_SAFETY_MARGIN_MS: the runtime derives the client deadline from
          // this budget, so trimming it here is what keeps that deadline inside the
          // server's acceptance window. The start is deliberately untouched.
          { ...message, timerMs: Math.max(0, message.timerMs - CLOCK_SAFETY_MARGIN_MS) }
        : message,
    );
    if (
      (message.phase === 'countdown' || message.phase === 'playing') &&
      previous.selfRole !== 'spectator'
    ) {
      bind.setFlyCamera(false);
    }
    awaitingSnapshot = false;
    completeHandshake();
    if (previous.bpPausedAt && !message.pausedAt) {
      reportProgress();
    }
  }

  /**
   * Follow a server-side hand-over. Only the crown and, for the new host, the
   * capability change here; the roster arrives in its own frame.
   */
  /** @param {{ token?: unknown }} message @param {boolean} isHost */
  function adoptHostAuthority(message, isHost) {
    if (isHost) {
      if (typeof message.token === 'string') {
        hostToken = message.token;
        bind.capturedHostToken(message.token);
      }
    } else {
      hostToken = undefined;
      bind.dropHostToken();
    }
    const party = bind.partyStore.state;
    bind.setIdentity(isHost, party.count, party.selfRole);
  }

  /** @param {MessageEvent} event */
  function receive(event) {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!message || typeof message !== 'object') {
      return;
    }
    // Anything at all from the server proves the connection is alive, including
    // the pong that answers our own heartbeat.
    unansweredPings = 0;

    switch (message.t) {
      case 'hello':
        connectionId = message.id;
        bind.setIdentity(message.isHost, message.count, message.role);
        return;
      case 'party':
        receiveSnapshot(message);
        return;
      case 'roster': {
        const previousAttempt = bind.partyStore.state.bpAttempt ?? 0;
        const member = Array.isArray(message.players)
          ? message.players.find(
              /** @param {{uid?: string, attempt?: number}} player */ (player) =>
                player.uid === identity.uid,
            )
          : undefined;
        if (member && (member.attempt ?? 0) !== previousAttempt) {
          roundChangePending = true;
          sawMapReadyFalse = true;
          attemptAtRoundChange = bind.gameStore.state.attemptSeq ?? null;
          announcedSceneKey = '';
          completionSent = false;
          forfeitSent = false;
          lastStrokeCount = -1;
          lastPosition = '';
        }
        bind.setRoster(message.players);
        receivedRoster = true;
        completeHandshake();
        return;
      }
      case 'host-notice':
        if (typeof message.message === 'string') {
          bind.notice(message.message);
        }
        return;
      case 'course-vote':
        bind.updateVote(message);
        return;
      case 'board':
        bind.setBoard({
          standings: message.standings,
          alive: message.alive,
          holed: message.holed,
        });
        receivedBoard = true;
        completeHandshake();
        return;
      case 'final':
        bind.setFinal({ podium: message.podium, standings: message.standings });
        return;
      case 'bye':
        bind.removeGhost(message.id);
        return;
      case 'f':
        bind.showCompletion({
          id: message.id,
          hue: bind.ghostHue(message.id),
          strokes: message.s,
          par: message.p,
          at: Date.now(),
        });
        return;
      case 'error':
        bind.setError(message.msg ?? message.code);
        if (message.code === 'invalid-join' || message.code === 'full') {
          terminalError = message.msg || 'Could not join this party.';
        }
        onError?.(message.code, message.msg);
        return;
      case 'b':
        for (const position of message.s) {
          if (position.id !== connectionId) {
            bind.updateGhost(position);
          }
        }
        return;
      case 'host-granted':
        // The server rotates the capability token whenever authority moves, so
        // the new host has to adopt it together with the crown. The lobby count
        // is untouched because this frame does not change who is present.
        adoptHostAuthority(message, true);
        return;
      case 'host-revoked':
        adoptHostAuthority(message, false);
        return;
      case 'host-ack':
        bind.ack(message);
        return;
      default:
        return;
    }
  }

  /**
   * The delay for this attempt: the current backoff, spread by the jitter.
   *
   * Kept separate from the doubling so the bound is stated once and the test can
   * pin it: the result is always within ±`retryJitter` of `retryDelay`.
   */
  function nextRetryDelay() {
    const spread = retryDelay * retryJitter;
    return Math.round(retryDelay - spread + Math.random() * spread * 2);
  }

  function scheduleReconnect() {
    if (disposed || terminalError) {
      return;
    }
    bind.clearTimeout(reconnectTimer);
    reconnectTimer = bind.setTimeout(connect, nextRetryDelay());
    retryDelay = Math.min(retryDelay * 2, maximumRetryDelay);
  }

  function connect() {
    if (disposed || terminalError) {
      return;
    }
    synchronized = false;
    awaitingSnapshot = true;
    receivedRoster = false;
    receivedBoard = false;
    unansweredPings = 0;
    // A new connection has to state its readiness again: the server may have
    // dropped the previous document's report, and repeating it is harmless
    // because a round that already knows we are ready ignores the repeat.
    announcedSceneKey = '';
    const protocol = bind.location.protocol === 'https:' ? 'wss:' : 'ws:';
    let nextSocket;
    try {
      nextSocket = new bind.WebSocket(
        protocol + '//' + bind.location.host + '/ws/party/' + encodeURIComponent(code),
      );
    } catch {
      scheduleReconnect();
      return;
    }
    socket = nextSocket;
    handshakeTimer = bind.setTimeout(() => nextSocket.close(), 12_000);
    nextSocket.onopen = () => {
      send(
        {
          t: 'join',
          uid: identity.uid,
          name: identity.name,
          hue: identity.hue,
          host: hostToken,
          session: identity.session,
          instance: identity.instance,
          protocol: 2,
          // Declares that this client reports scene readiness each round, so
          // the server may wait for it before starting the round timer.
          scene: true,
        },
        false,
      );
    };
    nextSocket.onmessage = (event) => {
      if (!disposed && socket === nextSocket) {
        receive(event);
      }
    };
    nextSocket.onclose = (event) => {
      if (disposed || socket !== nextSocket) {
        return;
      }
      bind.clearTimeout(handshakeTimer);
      // Captured before the flag is cleared: it says whether *this* socket ever
      // completed a handshake, which is what makes the probe below worthwhile.
      const hadSynchronized = synchronized;
      socket = null;
      synchronized = false;
      // The backend explicitly replaces the previous connection using this close reason.
      // Do not let two tabs continually evict each other.
      if (event.code === 1000 && event.reason === 'Reconnected') {
        terminalError = 'This party is open in another tab.';
      }
      bind.connection(false, terminalError);
      if (terminalError) {
        return;
      }
      // The retry is scheduled immediately, exactly as before, so a network blip
      // reconnects with no added latency. The probe below only *cancels* it, and
      // only when the server says the party is gone.
      scheduleReconnect();
      if (!hadSynchronized) {
        void cancelReconnectIfPartyIsGone();
      }
    };
  }

  /**
   * Stop a scheduled retry when the party no longer exists.
   *
   * A refused upgrade (a reclaimed or mistyped party) and a network failure both
   * arrive as an abnormal close with no usable code, so retrying blindly means a
   * stale URL reconnects every fifteen seconds forever while the page says
   * "Reconnecting party…". One cheap status check separates them: `404` is the
   * server saying the party is gone, which is permanent and deserves an
   * explanation instead of an endless retry. Anything else - including the probe
   * itself failing - is a connection problem, so the already-scheduled retry
   * stands.
   */
  async function cancelReconnectIfPartyIsGone() {
    let status;
    try {
      status = await bind.probeRoom(code);
    } catch {
      return;
    }
    // A close or a terminal frame may have landed while the probe was in flight.
    if (disposed || terminalError || status !== 404) {
      return;
    }
    terminalError = 'This party no longer exists.';
    bind.clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    bind.connection(false, terminalError);
  }

  let lastPosition = '';
  let lastPositionAt = 0;
  function publishPosition() {
    if (bind.partyStore.state.bpResetPending || roundChangePending) {
      reportProgress();
    }
    const party = bind.partyStore.state;
    if (
      !synchronized ||
      !socketOpen() ||
      bind.document.visibilityState === 'hidden' ||
      !bind.settingsStore.state.ghosts ||
      !party.mapReady ||
      party.bpResetPending ||
      roundChangePending ||
      !['countdown', 'playing'].includes(party.phase) ||
      bind.isSpectator()
    ) {
      return;
    }
    const { ballPos, pointer } = bind.scene;
    const cup = bind.gameStore.state.level?.cup;
    /** @type {{ x: number; y: number; z: number; px: number; pz: number; c: number; m: number; d?: number }} */
    const position = {
      x: Number(ballPos.x.toFixed(2)),
      y: Number(ballPos.y.toFixed(2)),
      z: Number(ballPos.z.toFixed(2)),
      px: Number(pointer.x.toFixed(2)),
      pz: Number(pointer.z.toFixed(2)),
      c: Number(bind.gameStore.state.phase === 'charging'),
      m: Number(!!pointer.active),
    };
    if (cup) {
      position.d = Number(Math.hypot(ballPos.x - cup[0], ballPos.z - cup[2]).toFixed(2));
    }
    const payload = JSON.stringify({
      ...position,
      matchId: party.matchId,
      holeIndex: party.holeIndex,
      ...(party.bpAttempt ? { attempt: party.bpAttempt } : {}),
    });
    const now = Date.now();
    if (payload !== lastPosition || now - lastPositionAt >= 2000) {
      // Presence is the only thing this adapter sends on a timer, so it is the only
      // thing worth dropping when the socket is behind. Queueing more would make a
      // slow link's delay permanent rather than temporary; skipping a sample costs a
      // slightly staler ghost, and the next sample fixes it.
      if ((socket?.bufferedAmount ?? 0) > PRESENCE_BACKLOG_LIMIT) {
        return;
      }
      lastPosition = payload;
      lastPositionAt = now;
      socket?.send(payload);
    }
  }

  bind.connection(false);
  connect();
  bind.registerSender(send);
  const gameSubscription = bind.gameStore.subscribe(reportProgress);
  /**
   * A half-open socket accepts writes but never answers them, so a client that
   * only waits for a close event keeps showing itself as connected while the
   * player's strokes go nowhere. Two unanswered heartbeats are treated as a
   * dropped connection and the normal reconnect path takes over.
   *
   * This is also why a throttled or suspended background tab is never declared
   * dead without evidence. Browsers slow `setInterval` in hidden tabs and stop it
   * entirely while a tab is frozen, so a backgrounded client sends *fewer* pings,
   * not more - and a ping only counts against the connection once it has actually
   * been written. The debt is cleared by any inbound frame, so a tab that resumes
   * and answers is back to zero immediately. Judging a tab on elapsed wall time
   * instead would kill exactly the connections that were merely asleep.
   */
  const heartbeat = bind.setInterval(() => {
    if (unansweredPings >= 2) {
      const stalled = socket;
      socket = null;
      synchronized = false;
      bind.clearTimeout(handshakeTimer);
      bind.connection(false);
      scheduleReconnect();
      // Best effort: the close is what tells the server, when it can be told.
      stalled?.close();
      return;
    }
    if (send({ t: 'ping' })) {
      unansweredPings++;
    }
  }, 15_000);
  const presenceTimer = bind.setInterval(publishPosition, 100);
  // Presence can be hidden or disabled; replay capture is a separate recorder.
  const replayTimer = bind.setInterval(() => {
    if (!synchronized || roundChangePending || completionSent || forfeitSent) {
      return;
    }
    const party = bind.partyStore.state;
    if (party.bpPausedAt || party.bpResetPending) {
      return;
    }
    const game = bind.gameStore.state;
    replayRecorder.sample(party, game, bind.scene, Date.now());
  }, 50);
  const replayUpload = bind.setInterval(() => {
    if (!synchronized || roundChangePending || completionSent || forfeitSent) {
      return;
    }
    const party = bind.partyStore.state;
    if (
      party.phase !== 'playing' ||
      party.bpPausedAt ||
      party.bpResetPending ||
      party.selfRole === 'spectator'
    ) {
      return;
    }
    const replay = replayRecorder.payload(party, bind.gameStore.state, bind.scene);
    if (
      replay &&
      send({ t: 'replay-samples', matchId: party.matchId, holeIndex: party.holeIndex, replay })
    ) {
      replayRecorder.sent();
    }
  }, 1000);

  return () => {
    disposed = true;
    bind.connection(false);
    bind.registerSender(null);
    bind.clearTimeout(handshakeTimer);
    bind.clearTimeout(reconnectTimer);
    bind.clearInterval(heartbeat);
    bind.clearInterval(presenceTimer);
    bind.clearInterval(replayTimer);
    bind.clearInterval(replayUpload);
    gameSubscription.unsubscribe();
    socket?.close();
    socket = null;
  };
}

// Test-only export: the patcher strips this line when inserting the adapter
// into the pinned GameCanvas bundle.
export { connectBetterParty };
