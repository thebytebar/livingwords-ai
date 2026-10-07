import assert from 'node:assert/strict';
import test from 'node:test';
import { isNearScrollBottom, preservedScrollTop } from './chat-scroll.mjs';

test('chat scroll follows the response until the user scrolls away from the bottom', () => {
  assert.equal(isNearScrollBottom({ scrollHeight: 1_000, clientHeight: 400, scrollTop: 560 }), true);
  assert.equal(isNearScrollBottom({ scrollHeight: 1_000, clientHeight: 400, scrollTop: 500 }), false);
});

test('chat scroll restoration preserves the reader position while content grows', () => {
  assert.equal(preservedScrollTop(250, 1_500, 400), 250);
  assert.equal(preservedScrollTop(900, 1_000, 400), 600);
});
