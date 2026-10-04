import assert from 'node:assert/strict';
import test from 'node:test';
import { createInactivityTimeout } from './inactivity-timeout.mjs';

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test('inactivity timeout aborts with a timeout error', async () => {
  const timeout = createInactivityTimeout(15, 'No response data received.');
  try {
    await new Promise((resolve) => timeout.signal.addEventListener('abort', resolve, { once: true }));
    assert.equal(timeout.signal.reason.name, 'TimeoutError');
    assert.equal(timeout.signal.reason.message, 'No response data received.');
  } finally {
    timeout.dispose();
  }
});

test('inactivity timeout restarts when activity is reported', async () => {
  const timeout = createInactivityTimeout(50, 'No response data received.');
  try {
    await delay(30);
    timeout.reset();
    await delay(30);
    assert.equal(timeout.signal.aborted, false);
    await new Promise((resolve) => timeout.signal.addEventListener('abort', resolve, { once: true }));
    assert.equal(timeout.signal.aborted, true);
  } finally {
    timeout.dispose();
  }
});

test('inactivity timeout validates its configuration', () => {
  assert.throws(() => createInactivityTimeout(0, 'timeout'), /positive whole number/u);
  assert.throws(() => createInactivityTimeout(10, ''), /requires an error message/u);
});
