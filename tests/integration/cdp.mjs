export const pause = (ms) => new Promise((response) => setTimeout(response, ms));
export async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  const events = [];
  const requests = new Map();
  let seq = 0;
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const pendingRequest = pending.get(message.id);
      if (pendingRequest) {
        pending.delete(message.id);
        clearTimeout(pendingRequest.timer);
        message.error
          ? pendingRequest.reject(Error(JSON.stringify(message.error)))
          : pendingRequest.resolve(message.result);
      }
    } else {
      if (message.method === 'Network.requestWillBeSent') {
        requests.set(message.params.requestId, message.params.request.url);
      }
      if (message.method === 'Runtime.exceptionThrown') {
        events.push({
          type: 'exception',
          text:
            message.params.exceptionDetails.exception?.description ||
            message.params.exceptionDetails.text,
        });
      }
      if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
        events.push({
          type: 'error',
          text: message.params.entry.text,
          url: message.params.entry.url,
        });
      }
      if (message.method === 'Network.loadingFailed') {
        events.push({
          type: 'failed',
          text: message.params.errorText,
          url: requests.get(message.params.requestId),
        });
      }
      if (message.method === 'Network.responseReceived' && message.params.response.status >= 400) {
        events.push({
          type: 'http',
          text: String(message.params.response.status),
          url: message.params.response.url,
        });
      }
      if (
        message.method === 'Network.webSocketFrameSent' ||
        message.method === 'Network.webSocketFrameReceived'
      ) {
        try {
          const packet = JSON.parse(message.params.response.payloadData);
          if (packet.t || packet.f) {
            events.push({
              type: message.method.endsWith('Sent') ? 'sent' : 'received',
              msg: packet.t ?? 'completion',
              phase: packet.phase,
              name: packet.currentMap?.name,
              play: packet.holeIds,
              count: packet.count,
            });
          }
        } catch {}
      }
    }
  };
  ws.onclose = () => {
    for (const pendingRequest of pending.values()) {
      clearTimeout(pendingRequest.timer);
      pendingRequest.reject(Error('Browser disconnected'));
    }
    pending.clear();
  };
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Error('CDP timeout: ' + method));
      }, 8000);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evalJS = async (expression) => {
    const response = await call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails) {
      throw Error(
        response.exceptionDetails.exception?.description || response.exceptionDetails.text,
      );
    }
    return response.result.value;
  };
  await call('Page.enable');
  await call('Runtime.enable');
  await call('Log.enable');
  await call('Network.enable');
  return { call, evalJS, events, requests, close: () => ws.close() };
}
export async function waitFor(client, expression, timeout = 30000) {
  const until = Date.now() + timeout;
  let error;
  while (Date.now() < until) {
    try {
      const response = await client.evalJS(expression);
      if (response) {
        return response;
      }
    } catch (event) {
      error = event;
    }
    await pause(200);
  }
  throw Error(
    'Timed out: ' +
      expression +
      ' ' +
      (error ?? '') +
      '\n' +
      JSON.stringify(client.events.slice(-20)),
  );
}
