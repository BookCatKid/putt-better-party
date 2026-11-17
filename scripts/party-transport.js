/**
 * Party WebSocket adapter for the original game's state stores and presence API.
 * Wire fields and the 100ms ghost update loop follow the pinned GameCanvas bundle.
 */
function connectBetterParty(code, identity, options = {}) {
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

  function socketOpen() {
    return socket?.readyState === WebSocket.OPEN;
  }

  function send(message, requireSynchronization = true) {
    if (!socketOpen() || (requireSynchronization && !synchronized)) {
      return false;
    }
    let packet = message;
    if (message.t === 'prog' || message.t === 'forfeit' || message.f === 1) {
      const { matchId, holeIndex } = transportPartyStore.state;
      packet = { ...message, matchId, holeIndex };
    }
    socket.send(JSON.stringify(packet));
    return true;
  }

  function reportProgress() {
    const party = transportPartyStore.state;
    if (
      !synchronized ||
      party.phase !== 'playing' ||
      !party.mapReady ||
      party.selfRole === 'spectator'
    ) {
      return;
    }
    const game = transportGameStore.state;
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
    clearTimeout(handshakeTimer);
    synchronized = true;
    retryDelay = initialRetryDelay;
    bpConnection(true);
    reportProgress();
  }

  function receiveSnapshot(message) {
    const previous = transportPartyStore.state;
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

    updateTransportParty(message);
    if (message.phase === 'countdown' || message.phase === 'playing') {
      setTransportFlyCamera(false);
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
        setTransportIdentity(message.isHost, message.count, message.role);
        return;
      case 'party':
        receiveSnapshot(message);
        return;
      case 'roster':
        setTransportRoster(message.players);
        receivedRoster = true;
        completeHandshake();
        return;
      case 'board':
        setTransportBoard({
          standings: message.standings,
          alive: message.alive,
          holed: message.holed,
        });
        receivedBoard = true;
        completeHandshake();
        return;
      case 'final':
        setTransportFinal({ podium: message.podium, standings: message.standings });
        return;
      case 'bye':
        removeTransportGhost(message.id);
        return;
      case 'f':
        showTransportCompletion({
          id: message.id,
          hue: transportGhostHue(message.id),
          strokes: message.s,
          par: message.p,
          at: Date.now(),
        });
        return;
      case 'error':
        setTransportError(message.msg ?? message.code);
        if (message.code === 'invalid-join' || message.code === 'full') {
          terminalError = message.msg || 'Could not join this party.';
        }
        onError?.(message.code, message.msg);
        return;
      case 'b':
        for (const position of message.s) {
          if (position.id !== connectionId) {
            updateTransportGhost(position);
          }
        }
        return;
      case 'host-ack':
        bpAck(message);
        return;
      default:
        return;
    }
  }

  function scheduleReconnect() {
    if (disposed || terminalError) {
      return;
    }
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, retryDelay);
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
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let nextSocket;
    try {
      nextSocket = new WebSocket(
        protocol + '//' + location.host + '/ws/party/' + encodeURIComponent(code),
      );
    } catch {
      scheduleReconnect();
      return;
    }
    socket = nextSocket;
    handshakeTimer = setTimeout(() => nextSocket.close(), 12_000);
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
      clearTimeout(handshakeTimer);
      socket = null;
      synchronized = false;
      // The backend explicitly replaces the previous connection using this close reason.
      // Do not let two tabs continually evict each other.
      if (event.code === 1000 && event.reason === 'Reconnected') {
        terminalError = 'This party is open in another tab.';
      }
      bpConnection(false, terminalError);
      scheduleReconnect();
    };
  }

  let lastPosition = '';
  let lastPositionAt = 0;
  function publishPosition() {
    if (
      !synchronized ||
      !socketOpen() ||
      document.visibilityState === 'hidden' ||
      !transportSettings.state.ghosts ||
      isTransportSpectator()
    ) {
      return;
    }
    const { ballPos, pointer } = transportScene;
    const cup = transportGameStore.state.level?.cup;
    const position = {
      x: Number(ballPos.x.toFixed(2)),
      y: Number(ballPos.y.toFixed(2)),
      z: Number(ballPos.z.toFixed(2)),
      px: Number(pointer.x.toFixed(2)),
      pz: Number(pointer.z.toFixed(2)),
      c: Number(transportGameStore.state.phase === 'charging'),
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

  bpConnection(false);
  connect();
  registerTransportSender(send);
  const subscription = transportGameStore.subscribe(reportProgress);
  const heartbeat = setInterval(() => send({ t: 'ping' }), 15_000);
  const presenceTimer = setInterval(publishPosition, 100);

  return () => {
    disposed = true;
    bpConnection(false);
    registerTransportSender(null);
    clearTimeout(handshakeTimer);
    clearTimeout(reconnectTimer);
    clearInterval(heartbeat);
    clearInterval(presenceTimer);
    subscription.unsubscribe();
    socket?.close();
    socket = null;
  };
}
