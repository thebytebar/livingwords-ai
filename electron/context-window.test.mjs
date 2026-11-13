import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CONTEXT_WINDOW_PRESETS,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  MAX_TOOL_TURN_OUTPUT_TOKENS,
  contextWindowPreset,
  isContextWindowTokens,
  responseTokenLimitForContext,
  validateContextWindowTokens,
} from './context-window.mjs';

test('context window presets default to 16K and cap responses for the local model', () => {
  assert.equal(DEFAULT_CONTEXT_WINDOW_TOKENS, 16_384);
  assert.equal(MAX_TOOL_TURN_OUTPUT_TOKENS, 1_500);
  assert.deepEqual(CONTEXT_WINDOW_PRESETS.map(({ label }) => label), ['8K', '16K', '32K', '64K', '128K']);
  assert.deepEqual(
    CONTEXT_WINDOW_PRESETS.map(({ tokens }) => responseTokenLimitForContext(tokens)),
    [2_000, 3_000, 3_000, 3_000, 3_000],
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
