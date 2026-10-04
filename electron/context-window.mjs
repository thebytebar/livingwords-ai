export const CONTEXT_WINDOW_PRESETS = Object.freeze([
  Object.freeze({ label: '8K', tokens: 8_192, meterTokens: 8_000 }),
  Object.freeze({ label: '16K', tokens: 16_384, meterTokens: 16_000 }),
  Object.freeze({ label: '32K', tokens: 32_768, meterTokens: 32_000 }),
  Object.freeze({ label: '64K', tokens: 65_536, meterTokens: 64_000 }),
  Object.freeze({ label: '128K', tokens: 131_072, meterTokens: 128_000 }),
]);

export const DEFAULT_CONTEXT_WINDOW_TOKENS = 32_768;
export const MAX_RESPONSE_TOKENS = 10_000;

export function isContextWindowTokens(value) {
  return CONTEXT_WINDOW_PRESETS.some((preset) => preset.tokens === value);
}

export function validateContextWindowTokens(value) {
  if (!isContextWindowTokens(value)) {
    throw new Error('Context window must be one of the supported preset sizes.');
  }
  return value;
}

export function responseTokenLimitForContext(value) {
  validateContextWindowTokens(value);
  return Math.min(Math.floor((value / 4) / 1_000) * 1_000, MAX_RESPONSE_TOKENS);
}

export function contextWindowPreset(value) {
  validateContextWindowTokens(value);
  return CONTEXT_WINDOW_PRESETS.find((preset) => preset.tokens === value);
}
