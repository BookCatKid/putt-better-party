const bpPending = new Map();
const sendPartyCommand = (message) => u?.(message);
export function bpPickerBusy(value) {
  partyRuntimeStore.setState((partyState) => ({ ...partyState, bpPickerBusy: !!value }));
}
export function bpConnection(connected, failure = '') {
  partyRuntimeStore.setState((partyState) => ({
    ...partyState,
    bpConnected: connected,
    bpEverConnected: connected || !!partyState.bpEverConnected,
    bpConnectionError: failure || null,
  }));
  if (!connected) {
    for (const [id, pendingAction] of bpPending) {
      clearTimeout(pendingAction.timer);
      pendingAction.reject(Error('Party connection lost. Reconnect or create a new party.'));
      bpPending.delete(id);
    }
  }
}
export function bpAck(message) {
  const pendingAction = bpPending.get(message.requestId);
  if (!pendingAction) {
    return;
  }
  clearTimeout(pendingAction.timer);
  bpPending.delete(message.requestId);
  message.ok
    ? pendingAction.resolve()
    : pendingAction.reject(Error(message.msg || 'Host command rejected'));
}
/**
 * Run a host command. `argument` carries the command's own parameter: a number
 * of seconds for time extensions, a player UID for a host hand-over.
 */
export function bpHostAction(action, argument) {
  const partyState = partyRuntimeStore.state;
  if (!partyState.isHost || !partyState.bpConnected || !u) {
    return Promise.reject(Error('Party is disconnected. Reconnect or create a new party.'));
  }
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      bpPending.delete(requestId);
      reject(Error('No response from party server. Check the connection.'));
    }, 4000);
    bpPending.set(requestId, { resolve, reject, timer });
    if (
      sendPartyCommand({
        t: 'host-action',
        action,
        seconds: typeof argument === 'number' ? argument : undefined,
        uid: typeof argument === 'string' ? argument : undefined,
        matchId: partyState.matchId,
        holeIndex: partyState.holeIndex,
        requestId,
      }) !== true
    ) {
      clearTimeout(timer);
      bpPending.delete(requestId);
      reject(Error('Party connection lost.'));
    }
  });
}

/**
 * Leave on purpose. This is different from closing the tab: the server hands
 * host authority on at once instead of waiting out the reconnect grace period.
 * Only the explicit departure control calls it, because an adapter teardown
 * also happens when the route merely re-subscribes.
 */
export function bpLeaveParty() {
  sendPartyCommand({ t: 'leave' });
}

/**
 * Adopt a capability token the server handed over with host authority. The
 * token is what authorises privileged HTTP calls such as importing courses.
 */
export function receiveTransportHostToken(token) {
  if (typeof token !== 'string' || !token) {
    return;
  }
  const code = partyRuntimeStore.state.code;
  if (code) {
    sessionStorage.setItem('bp.host.' + code, token);
  }
}

/** Give up the capability token when authority is revoked. */
export function clearTransportHostToken() {
  const code = partyRuntimeStore.state.code;
  if (code) {
    sessionStorage.removeItem('bp.host.' + code);
  }
}

/** Level ID the route has prepared, or null while it is still preparing. */
export function transportSceneReadyLevelId() {
  const partyState = partyRuntimeStore.state;
  return partyState.bpSceneReady ?? null;
}

// Called by the original renderer's scene-preparation callback.
export function bpScenePrepared(levelId) {
  if (partyRuntimeStore.state.active && partyRuntimeStore.state.bpSceneReady !== levelId) {
    partyRuntimeStore.setState((partyState) => ({ ...partyState, bpSceneReady: levelId }));
  }
}

export function bpCastVote(courseId) {
  const state = partyRuntimeStore.state;
  if (state.bpConnected && state.vote) {
    sendPartyCommand({ t: 'course-vote', voteId: state.vote.id, courseId });
  }
}

export function bpReceiveVote(message) {
  partyRuntimeStore.setState((state) => {
    if (!state.vote || message.vote?.id !== state.vote.id) {
      return state;
    }
    return {
      ...state,
      vote: { ...message.vote, endsAt: Date.now() + message.vote.endsAt - message.now },
    };
  });
}
