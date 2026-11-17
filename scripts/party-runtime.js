const bpPending = new Map();
const sendPartyCommand = (message) => u?.(message);
export function bpPickerBusy(value) {
  partyRuntimeStore.setState((partyState) => ({ ...partyState, bpPickerBusy: !!value }));
}
export function bpConnection(connected) {
  partyRuntimeStore.setState((partyState) => ({ ...partyState, bpConnected: connected }));
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
export function bpHostAction(action, seconds) {
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
        seconds,
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

// Called by the original renderer's scene-preparation callback.
export function bpScenePrepared(levelId) {
  if (partyRuntimeStore.state.active && partyRuntimeStore.state.bpSceneReady !== levelId) {
    partyRuntimeStore.setState((partyState) => ({ ...partyState, bpSceneReady: levelId }));
  }
}
