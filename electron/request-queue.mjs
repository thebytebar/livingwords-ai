export class RequestCancelledError extends Error {
  constructor() {
    super('Request was cancelled.');
    this.name = 'RequestCancelledError';
    this.code = 'REQUEST_CANCELLED';
  }
}

export function createRequestQueue({ maxWaitingRequests = 10, onStateChange = () => {} } = {}) {
  if (!Number.isInteger(maxWaitingRequests) || maxWaitingRequests < 0) {
    throw new Error('maxWaitingRequests must be a non-negative integer.');
  }

  const waiting = [];
  const requestsBySession = new Map();
  let active = null;

  function publish(entry, status, queuePosition) {
    onStateChange({
      requestId: entry.requestId,
      sessionId: entry.sessionId,
      status,
      ...(queuePosition === undefined ? {} : { queuePosition }),
    });
  }

  function updateWaitingPositions() {
    waiting.forEach((entry, index) => publish(entry, 'queued', index + 1));
  }

  function finish(entry, status, value, reject) {
    publish(entry, status);
    requestsBySession.delete(entry.sessionId);
    if (active === entry) active = null;
    if (status === 'completed') entry.resolve(value);
    else if (reject) entry.reject(value);
  }

  function startNext() {
    if (active || waiting.length === 0) return;
    const entry = waiting.shift();
    active = entry;
    entry.controller = new AbortController();
    publish(entry, 'running');
    updateWaitingPositions();

    Promise.resolve()
      .then(() => {
        if (entry.controller.signal.aborted) throw new RequestCancelledError();
        return entry.run(entry.controller.signal);
      })
      .then(
        (result) => {
          if (entry.controller.signal.aborted) {
            finish(entry, 'cancelled', new RequestCancelledError(), true);
          } else {
            finish(entry, 'completed', result, false);
          }
        },
        (error) => {
          if (entry.controller.signal.aborted) {
            finish(entry, 'cancelled', new RequestCancelledError(), true);
          } else {
            publish(entry, 'failed');
            requestsBySession.delete(entry.sessionId);
            if (active === entry) active = null;
            entry.reject(error);
          }
        },
      )
      .finally(() => {
        if (active === entry) active = null;
        startNext();
      });
  }

  return Object.freeze({
    enqueue({ requestId, sessionId, run }) {
      if (typeof requestId !== 'string' || !requestId
        || typeof sessionId !== 'string' || !sessionId
        || typeof run !== 'function') {
        throw new Error('A request ID, conversation ID, and request function are required.');
      }
      if (requestsBySession.has(sessionId)) {
        throw new Error('This conversation already has a queued or active request.');
      }
      if (active && waiting.length >= maxWaitingRequests) {
        throw new Error('The request queue is full. Wait for a response or cancel a queued request.');
      }
      if (waiting.some((entry) => entry.requestId === requestId) || active?.requestId === requestId) {
        throw new Error('Request ID is already in use.');
      }

      let resolve;
      let reject;
      const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      });
      const entry = { requestId, sessionId, run, resolve, reject };
      requestsBySession.set(sessionId, entry);
      waiting.push(entry);
      publish(entry, 'queued', waiting.length);
      startNext();
      return promise;
    },

    cancel(requestId) {
      const queuedIndex = waiting.findIndex((entry) => entry.requestId === requestId);
      if (queuedIndex >= 0) {
        const [entry] = waiting.splice(queuedIndex, 1);
        finish(entry, 'cancelled', new RequestCancelledError(), true);
        updateWaitingPositions();
        return { sessionId: entry.sessionId };
      }
      if (active?.requestId === requestId && !active.controller.signal.aborted) {
        active.controller.abort(new RequestCancelledError());
        publish(active, 'cancelling');
        return { sessionId: active.sessionId };
      }
      return null;
    },

    get waitingCount() {
      return waiting.length;
    },

    get activeRequestId() {
      return active?.requestId ?? null;
    },
  });
}
