const bpPending = new Map();
export function bpPickerBusy(value) {
  i.setState((s) => ({ ...s, bpPickerBusy: !!value }));
}
export function bpConnection(connected) {
  i.setState((s) => ({ ...s, bpConnected: connected }));
  if (!connected)
    for (const [id, p] of bpPending) {
      clearTimeout(p.timer);
      p.reject(Error('Party connection lost. Reconnect or create a new party.'));
      bpPending.delete(id);
    }
}
export function bpAck(m) {
  const p = bpPending.get(m.requestId);
  if (!p) return;
  clearTimeout(p.timer);
  bpPending.delete(m.requestId);
  m.ok ? p.resolve() : p.reject(Error(m.msg || 'Host command rejected'));
}
export function bpHostAction(action, seconds) {
  const s = i.state;
  if (!s.isHost || !s.bpConnected || !u)
    return Promise.reject(Error('Party is disconnected. Reconnect or create a new party.'));
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      bpPending.delete(requestId);
      reject(Error('No response from party server. Check the connection.'));
    }, 4000);
    bpPending.set(requestId, { resolve, reject, timer });
    if (
      u({
        t: 'host-action',
        action,
        seconds,
        matchId: s.matchId,
        holeIndex: s.holeIndex,
        requestId,
      }) !== true
    ) {
      clearTimeout(timer);
      bpPending.delete(requestId);
      reject(Error('Party connection lost.'));
    }
  });
}
