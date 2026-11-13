import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatElapsedTime,
  pendingIndicatorText,
  sessionRequestPreviewText,
  shouldShowTypingAnimation,
} from './pending-indicator.mjs';

test('elapsed request time uses readable seconds, minutes, and hours', () => {
  assert.equal(formatElapsedTime(0), '0 sec');
  assert.equal(formatElapsedTime(1_999), '1 sec');
  assert.equal(formatElapsedTime(61_999), '1 min 1 sec');
  assert.equal(formatElapsedTime(3_661_000), '1 hr 1 min 1 sec');
  assert.equal(formatElapsedTime(3_600_000), '1 hr 0 min 0 sec');
  assert.equal(formatElapsedTime(Number.NaN), '0 sec');
});

test('pending indicator reserves animated dots for active model work', () => {
  assert.equal(pendingIndicatorText('running'), null);
  assert.equal(pendingIndicatorText('submitting'), null);
  assert.equal(pendingIndicatorText('queued'), 'Waiting in queue');
  assert.equal(pendingIndicatorText('queued', 3), 'Waiting in queue · position 3');
  assert.equal(pendingIndicatorText('cancelling'), 'Cancelling response…');
  assert.equal(pendingIndicatorText('awaiting-command-approval'), 'Waiting for terminal command approval…');
});

test('session preview describes model work until the response is ready', () => {
  assert.equal(sessionRequestPreviewText({ status: 'running' }), 'Thinking…');
  assert.equal(sessionRequestPreviewText({ status: 'finishing' }), 'Finishing response…');
  assert.equal(sessionRequestPreviewText({ status: 'completed' }), 'Finishing response…');
  assert.equal(sessionRequestPreviewText({ status: 'failed' }), 'Finishing response…');
  assert.equal(sessionRequestPreviewText({ status: 'queued', queuePosition: 2 }), 'Queued · 2');
});

test('typing indicator remains visible until a response finishes', () => {
  assert.equal(shouldShowTypingAnimation({ status: 'running' }), true);
  assert.equal(shouldShowTypingAnimation({ status: 'finishing' }), true);
  assert.equal(shouldShowTypingAnimation({ status: 'completed' }), false);
  assert.equal(shouldShowTypingAnimation({ status: 'failed' }), false);
});
