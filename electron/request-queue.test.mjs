import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequestQueue, RequestCancelledError } from './request-queue.mjs';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test('request queue runs requests FIFO and reports their positions', async () => {
  const activities = [];
  const queue = createRequestQueue({ onStateChange: (state) => activities.push(state) });
  const first = deferred();
  const order = [];
  const firstPromise = queue.enqueue({
    requestId: 'first',
    sessionId: 'session-1',
    run: async () => {
      order.push('first');
      return first.promise;
    },
  });
  const secondPromise = queue.enqueue({
    requestId: 'second',
    sessionId: 'session-2',
    run: async () => {
      order.push('second');
      return 'second result';
    },
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['first']);
  assert.equal(queue.waitingCount, 1);
  assert.deepEqual(activities.find((item) => item.requestId === 'second'), {
    requestId: 'second',
    sessionId: 'session-2',
    status: 'queued',
    queuePosition: 1,
  });

  first.resolve('first result');
  assert.equal(await firstPromise, 'first result');
  assert.equal(await secondPromise, 'second result');
  assert.deepEqual(order, ['first', 'second']);
  assert.equal(queue.activeRequestId, null);
});

test('request queue caps waiting requests and allows one outstanding request per conversation', async () => {
  const first = deferred();
  const queue = createRequestQueue({ maxWaitingRequests: 1 });
  const firstPromise = queue.enqueue({
    requestId: 'active',
    sessionId: 'same-session',
    run: () => first.promise,
  });
  const secondPromise = queue.enqueue({
    requestId: 'waiting',
    sessionId: 'other-session',
    run: async () => 'done',
  });

  assert.throws(
    () => queue.enqueue({ requestId: 'duplicate-session', sessionId: 'same-session', run: async () => '' }),
    /already has a queued or active request/u,
  );
  assert.throws(
    () => queue.enqueue({ requestId: 'overflow', sessionId: 'third-session', run: async () => '' }),
    /queue is full/u,
  );

  first.resolve('done');
  await Promise.all([firstPromise, secondPromise]);
});

test('queued requests can be cancelled without running', async () => {
  const first = deferred();
  const events = [];
  const queue = createRequestQueue({ onStateChange: (state) => events.push(state) });
  const firstPromise = queue.enqueue({
    requestId: 'active',
    sessionId: 'session-1',
    run: () => first.promise,
  });
  const queuedPromise = queue.enqueue({
    requestId: 'queued',
    sessionId: 'session-2',
    run: async () => assert.fail('Cancelled request must not run.'),
  });
  const rejected = assert.rejects(queuedPromise, RequestCancelledError);

  assert.deepEqual(queue.cancel('queued'), { sessionId: 'session-2' });
  assert.equal(queue.waitingCount, 0);
  assert.equal(queue.cancel('queued'), null);
  await rejected;
  assert.ok(events.some((item) => item.requestId === 'queued' && item.status === 'cancelled'));

  first.resolve('done');
  await firstPromise;
});

test('a failed request releases its conversation and advances the queue', async () => {
  const events = [];
  const queue = createRequestQueue({ onStateChange: (state) => events.push(state) });
  const failedPromise = queue.enqueue({
    requestId: 'failed',
    sessionId: 'session-1',
    run: async () => {
      throw new Error('generation failed');
    },
  });
  const failed = assert.rejects(failedPromise, /generation failed/u);
  const nextPromise = queue.enqueue({
    requestId: 'next',
    sessionId: 'session-2',
    run: async () => 'next result',
  });

  await failed;
  assert.equal(await nextPromise, 'next result');
  const retryPromise = queue.enqueue({
    requestId: 'retry',
    sessionId: 'session-1',
    run: async () => 'retry result',
  });
  assert.equal(await retryPromise, 'retry result');
  assert.ok(events.some((item) => item.requestId === 'failed' && item.status === 'failed'));
  assert.ok(events.some((item) => item.requestId === 'next' && item.status === 'completed'));
});

test('running requests receive abort and the next request waits for them to settle', async () => {
  const active = deferred();
  const events = [];
  const order = [];
  let signal;
  const queue = createRequestQueue({ onStateChange: (state) => events.push(state) });
  const activePromise = queue.enqueue({
    requestId: 'active',
    sessionId: 'session-1',
    run: (requestSignal) => {
      signal = requestSignal;
      order.push('active');
      return active.promise;
    },
  });
  const rejected = assert.rejects(activePromise, RequestCancelledError);
  const waitingPromise = queue.enqueue({
    requestId: 'waiting',
    sessionId: 'session-2',
    run: async () => {
      order.push('waiting');
      return 'done';
    },
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(queue.cancel('active'), { sessionId: 'session-1' });
  assert.equal(signal.aborted, true);
  assert.deepEqual(order, ['active']);
  assert.ok(events.some((item) => item.requestId === 'active' && item.status === 'cancelling'));

  active.resolve('late result');
  await rejected;
  assert.equal(await waitingPromise, 'done');
  assert.deepEqual(order, ['active', 'waiting']);
  assert.ok(events.some((item) => item.requestId === 'active' && item.status === 'cancelled'));
});
