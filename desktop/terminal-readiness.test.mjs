import assert from 'node:assert/strict';
import test from 'node:test';
import { createTerminalReadiness } from './terminal-readiness.mjs';

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test('terminal readiness waits for rendered shell output to settle', async () => {
  const readiness = createTerminalReadiness({ quietPeriodMs: 25, timeoutMs: 200 });
  let isReady = false;
  const ready = readiness.waitUntilReady().then(() => { isReady = true; });

  readiness.observeRenderedOutput();
  await delay(10);
  assert.equal(isReady, false);
  readiness.observeRenderedOutput();
  await ready;
  assert.equal(isReady, true);
});

test('terminal readiness fails if no initial shell prompt is rendered', async () => {
  const readiness = createTerminalReadiness({ quietPeriodMs: 5, timeoutMs: 10 });

  await assert.rejects(readiness.waitUntilReady(), /did not display its initial prompt/u);
});

test('terminal readiness reports shell exit while waiting for its prompt', async () => {
  const readiness = createTerminalReadiness({ quietPeriodMs: 5, timeoutMs: 100 });
  const ready = readiness.waitUntilReady();
  readiness.fail(new Error('shell exited'));

  await assert.rejects(ready, /shell exited/u);
});
