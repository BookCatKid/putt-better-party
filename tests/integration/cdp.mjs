export const pause = (ms) => new Promise((response) => setTimeout(response, ms));
export async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  const events = [];
  const requests = new Map();
  const listeners = new Map();
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
      const listener = listeners.get(message.method);
      listener?.(message.params);
      if (message.method === 'Network.requestWillBeSent') {
        requests.set(message.params.requestId, message.params.request.url);
      }
      if (message.method === 'Inspector.targetCrashed') {
        // A crashed renderer never answers again; surface it as a crash rather
        // than letting every later evaluation time out.
        events.push({ type: 'crash', text: 'Renderer target crashed' });
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
  const call = (method, params = {}, timeout = 8000) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Error('CDP timeout: ' + method));
      }, timeout);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evalJS = async (expression, timeout = 8000) => {
    const response = await call(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      timeout,
    );
    if (response.exceptionDetails) {
      throw Error(
        response.exceptionDetails.exception?.description || response.exceptionDetails.text,
      );
    }
    return response.result.value;
  };
  await call('Page.enable');
  await call('Runtime.enable');
  await call('Inspector.enable');
  await call('Log.enable');
  await call('Network.enable');
  // Subscribe to one protocol event; each event name has at most one listener.
  const on = (method, listener) => listeners.set(method, listener);
  return { call, evalJS, events, requests, on, close: () => ws.close() };
}
export async function waitFor(client, expression, timeout = 30000) {
  const until = Date.now() + timeout;
  let error;
  while (Date.now() < until) {
    try {
      // A busy software-rendered page can stall the main thread past the
      // default per-request timeout; keep retrying within the caller's budget
      // instead of aborting the whole wait on one slow evaluation.
      const attemptTimeout = Math.max(1000, Math.min(8000, until - Date.now()));
      const response = await client.evalJS(expression, attemptTimeout);
      if (response) {
        return response;
      }
    } catch (event) {
      error = event;
    }
    const crash = client.events.find((event) => event.type === 'crash');
    if (crash) {
      throw Error('Browser target crashed while waiting for: ' + expression);
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
