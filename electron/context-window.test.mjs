import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CONTEXT_WINDOW_PRESETS,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  contextWindowPreset,
  isContextWindowTokens,
  responseTokenLimitForContext,
  validateContextWindowTokens,
} from './context-window.mjs';

test('context window presets default to 32K and map to their response limits', () => {
  assert.equal(DEFAULT_CONTEXT_WINDOW_TOKENS, 32_768);
  assert.deepEqual(CONTEXT_WINDOW_PRESETS.map(({ label }) => label), ['8K', '16K', '32K', '64K', '128K']);
  assert.deepEqual(
    CONTEXT_WINDOW_PRESETS.map(({ tokens }) => responseTokenLimitForContext(tokens)),
    [2_000, 4_000, 8_000, 10_000, 10_000],
  );
});

test('context window presets expose display limits and reject unsupported sizes', () => {
  assert.deepEqual(contextWindowPreset(65_536), {
    label: '64K',
    tokens: 65_536,
    meterTokens: 64_000,
  });
  assert.equal(isContextWindowTokens(32_768), true);
  assert.equal(isContextWindowTokens(24_000), false);
  assert.throws(() => validateContextWindowTokens(24_000), /supported preset sizes/u);
  assert.throws(() => responseTokenLimitForContext(24_000), /supported preset sizes/u);
});
