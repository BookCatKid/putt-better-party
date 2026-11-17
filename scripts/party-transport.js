/**
 * Party WebSocket adapter for the original game's state stores and presence API.
 * Wire fields and the 100ms ghost update loop follow the pinned GameCanvas bundle.
 * Every environment touchpoint (socket constructor, timers, location, document and
 * the upstream state-store bindings) resolves through an injectable bindings object
 * so the adapter can be exercised offline; production falls back to the bundle globals.
 */
// Chromium rejects timer globals invoked with a foreign receiver, so production
// bindings call them without one. Injected test bindings are used as given.
const globalSetTimeout = (...timerArgs) => setTimeout(...timerArgs);
const globalClearTimeout = (handle) => clearTimeout(handle);
const globalSetInterval = (...timerArgs) => setInterval(...timerArgs);
const globalClearInterval = (handle) => clearInterval(handle);

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
    partyStore: provided.partyStore ?? transportPartyStore,
    gameStore: provided.gameStore ?? transportGameStore,
    settingsStore: provided.settingsStore ?? transportSettings,
    scene: provided.scene ?? transportScene,
    connection: provided.connection ?? bpConnection,
    registerSender: provided.registerSender ?? registerTransportSender,
    setIdentity: provided.setIdentity ?? setTransportIdentity,
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
    isSpectator: provided.isSpectator ?? isTransportSpectator,
    ack: provided.ack ?? bpAck,
  };
}

function connectBetterParty(code, identity, options = {}) {
  const bind = resolveTransportBindings(options.bindings);
  const { hostToken, onError } = options;
  const initialRetryDelay = 1000;
  let socket = null;
  let disposed = false;
  let reconnectTimer;
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
  let completionSent = false;
  let forfeitSent = false;
  let roundChangePending = false;
  let sawMapReadyFalse = false;

  function socketOpen() {
    return socket?.readyState === bind.WebSocket.OPEN;
  }

  function send(message, requireSynchronization = true) {
    if (!socketOpen() || (requireSynchronization && !synchronized)) {
      return false;
    }
    let packet = message;
    if (message.t === 'prog' || message.t === 'forfeit' || message.f === 1) {
      const { matchId, holeIndex } = bind.partyStore.state;
      packet = { ...message, matchId, holeIndex };
    }
    socket.send(JSON.stringify(packet));
    return true;
  }

  function reportProgress() {
    observePartyState();
    const party = bind.partyStore.state;
    if (
      !synchronized ||
      roundChangePending ||
      party.phase !== 'playing' ||
      !party.mapReady ||
      party.selfRole === 'spectator'
    ) {
      return;
    }
    const game = bind.gameStore.state;
    if (game.strokes !== lastStrokeCount && game.phase !== 'holed') {
      if (send({ t: 'prog', st: game.strokes })) {
        lastStrokeCount = game.strokes;
      }
    }
    if (game.phase === 'forfeit' && !forfeitSent) {
      forfeitSent = send({ t: 'forfeit' });
    }
    if (game.phase === 'holed' && game.result && !completionSent) {
      completionSent = send({ f: 1, s: game.result.strokes, p: game.result.par });
    }
  }

  function completeHandshake() {
    if (synchronized || awaitingSnapshot || !receivedRoster || !receivedBoard) {
      return;
    }
    synchronized = true;
    retryDelay = initialRetryDelay;
    bind.connection(true);
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
    return (
      !!party.currentMap?.id && party.mapReady === true && game.level?.id === party.currentMap.id
    );
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
    }
    // A snapshot only describes a round change when this connection already
    // knew a round. The very first snapshot introduces the round instead: the
    // route has either preloaded this level in the lobby or loads it now and
    // raises map readiness before play, so no staleness latch is needed.
    const hadRound = previous.matchId != null;
    const roundChanged =
      hadRound && (!sameRound || (message.phase === 'lobby' && previous.phase !== 'lobby'));
    if (roundChanged) {
      roundChangePending = true;
      if (bind.partyStore.state.mapReady !== true) {
        sawMapReadyFalse = true;
      }
    }

    bind.updateParty(message);
    if (message.phase === 'countdown' || message.phase === 'playing') {
      bind.setFlyCamera(false);
    }
    awaitingSnapshot = false;
    completeHandshake();
  }

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

    switch (message.t) {
      case 'hello':
        connectionId = message.id;
        bind.setIdentity(message.isHost, message.count, message.role);
        return;
      case 'party':
        receiveSnapshot(message);
        return;
      case 'roster':
        bind.setRoster(message.players);
        receivedRoster = true;
        completeHandshake();
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
      case 'host-ack':
        bind.ack(message);
        return;
      default:
        return;
    }
  }

  function scheduleReconnect() {
    if (disposed || terminalError) {
      return;
    }
    bind.clearTimeout(reconnectTimer);
    reconnectTimer = bind.setTimeout(connect, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 15_000);
  }

  function connect() {
    if (disposed || terminalError) {
      return;
    }
    synchronized = false;
    awaitingSnapshot = true;
    receivedRoster = false;
    receivedBoard = false;
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
      socket = null;
      synchronized = false;
      // The backend explicitly replaces the previous connection using this close reason.
      // Do not let two tabs continually evict each other.
      if (event.code === 1000 && event.reason === 'Reconnected') {
        terminalError = 'This party is open in another tab.';
      }
      bind.connection(false, terminalError);
      scheduleReconnect();
    };
  }

  let lastPosition = '';
  let lastPositionAt = 0;
  function publishPosition() {
    if (
      !synchronized ||
      !socketOpen() ||
      bind.document.visibilityState === 'hidden' ||
      !bind.settingsStore.state.ghosts ||
      bind.isSpectator()
    ) {
      return;
    }
    const { ballPos, pointer } = bind.scene;
    const cup = bind.gameStore.state.level?.cup;
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
    const payload = JSON.stringify(position);
    const now = Date.now();
    if (payload !== lastPosition || now - lastPositionAt >= 2000) {
      lastPosition = payload;
      lastPositionAt = now;
      socket.send(payload);
    }
  }

  bind.connection(false);
  connect();
  bind.registerSender(send);
  const gameSubscription = bind.gameStore.subscribe(reportProgress);
  const heartbeat = bind.setInterval(() => send({ t: 'ping' }), 15_000);
  const presenceTimer = bind.setInterval(publishPosition, 100);

  return () => {
    disposed = true;
    bind.connection(false);
    bind.registerSender(null);
    bind.clearTimeout(handshakeTimer);
    bind.clearTimeout(reconnectTimer);
    bind.clearInterval(heartbeat);
    bind.clearInterval(presenceTimer);
    gameSubscription.unsubscribe();
    socket?.close();
    socket = null;
  };
}

// Test-only export: the patcher strips this line when inserting the adapter
// into the pinned GameCanvas bundle.
export { connectBetterParty };
