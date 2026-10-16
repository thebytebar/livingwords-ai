import assert from 'node:assert/strict';
import test from 'node:test';
import {
  pendingIndicatorText,
  sessionRequestPreviewText,
  shouldShowTypingAnimation,
} from './pending-indicator.mjs';

test('pending indicator reserves animated dots for active model work', () => {
  assert.equal(pendingIndicatorText('running'), null);
  assert.equal(pendingIndicatorText('submitting'), null);
  assert.equal(pendingIndicatorText('queued'), 'Waiting in queue');
  assert.equal(pendingIndicatorText('queued', 3), 'Waiting in queue · position 3');
  assert.equal(pendingIndicatorText('cancelling'), 'Cancelling response…');
  assert.equal(pendingIndicatorText('awaiting-command-approval'), 'Waiting for terminal command approval…');
});

test('session preview leaves typing as soon as a request finishes', () => {
  assert.equal(sessionRequestPreviewText({ status: 'running', answer: 'Partial' }), 'Typing…');
  assert.equal(sessionRequestPreviewText({ status: 'finishing', answer: 'Partial' }), 'Finishing response…');
  assert.equal(sessionRequestPreviewText({ status: 'completed', answer: 'Final' }), 'Finishing response…');
  assert.equal(sessionRequestPreviewText({ status: 'failed' }), 'Finishing response…');
  assert.equal(sessionRequestPreviewText({ status: 'queued', queuePosition: 2 }), 'Queued · 2');
});

test('typing animation is hidden once response text starts streaming', () => {
  assert.equal(shouldShowTypingAnimation({ status: 'running', answer: '' }), true);
  assert.equal(shouldShowTypingAnimation({ status: 'running', answer: 'Hello' }), false);
});
