export function createTerminalReadiness({ quietPeriodMs = 100, timeoutMs = 5_000 } = {}) {
  if (!Number.isInteger(quietPeriodMs) || quietPeriodMs < 0
    || !Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError('Terminal readiness timing is invalid.');
  }

  let sawRenderedOutput = false;
  let isWaiting = false;
  let settled = false;
  let failure = null;
  let quietTimer;
  let timeoutTimer;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  ready.catch(() => {});

  function clearTimers() {
    clearTimeout(quietTimer);
    clearTimeout(timeoutTimer);
  }

  function finish(error) {
    if (settled) return;
    settled = true;
    clearTimers();
    if (error) rejectReady(error);
    else resolveReady();
  }

  function settleAfterQuietPeriod() {
    clearTimeout(quietTimer);
    if (!isWaiting || !sawRenderedOutput || settled) return;
    quietTimer = setTimeout(() => finish(), quietPeriodMs);
  }

  return Object.freeze({
    observeRenderedOutput() {
      if (settled) return;
      sawRenderedOutput = true;
      settleAfterQuietPeriod();
    },
    waitUntilReady() {
      if (!isWaiting) {
        isWaiting = true;
        if (failure) {
          finish(failure);
        } else {
          timeoutTimer = setTimeout(() => {
            finish(new Error('The shell did not display its initial prompt in time.'));
          }, timeoutMs);
          settleAfterQuietPeriod();
        }
      }
      return ready;
    },
    fail(error) {
      if (settled) return;
      failure = error instanceof Error ? error : new Error(String(error));
      if (isWaiting) finish(failure);
    },
  });
}
