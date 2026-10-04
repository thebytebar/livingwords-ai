export function createInactivityTimeout(timeoutMs, message) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError('Inactivity timeout must be a positive whole number of milliseconds.');
  }
  if (typeof message !== 'string' || !message.trim()) {
    throw new TypeError('Inactivity timeout requires an error message.');
  }

  const controller = new AbortController();
  let timer;
  let disposed = false;

  function reset() {
    if (disposed || controller.signal.aborted) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      controller.abort(new DOMException(message, 'TimeoutError'));
    }, timeoutMs);
  }

  reset();
  return {
    signal: controller.signal,
    reset,
    dispose() {
      disposed = true;
      clearTimeout(timer);
    },
  };
}
