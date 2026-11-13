import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyLocalRequestMode,
  REQUEST_MODE_CONFIDENCE_THRESHOLD,
} from './request-mode-classifier.mjs';

test('request mode classifier makes a bounded no-tool call and accepts the confidence cutoff', async () => {
  const history = Array.from({ length: 5 }, (_, index) => ({
    role: 'user',
    content: `History ${index}: ${'x'.repeat(600)}`,
  }));
  const result = await classifyLocalRequestMode({
    model: {
      async respond(input, { signal }) {
        assert.ok(signal);
        assert.match(input.system_prompt, /untrusted data/u);
        assert.deepEqual(input.tools, []);
        assert.equal(input.max_output_tokens, 48);
        assert.equal(input.temperature, 0);
        assert.deepEqual(input.context.supplemental_context.available_modes, [
          'chat', 'web', 'terminal', 'documents', 'panel',
        ]);
        assert.equal(input.context.conversation_history.length, 4);
        assert.equal(input.context.conversation_history[0].content.length, 500);
        return {
          done: true,
          final_answer: JSON.stringify({
            mode: 'documents',
            confidence: REQUEST_MODE_CONFIDENCE_THRESHOLD,
          }),
        };
      },
    },
    task: 'Summarize these notes.',
    history,
    hasDocumentTools: true,
    hasOpenTabs: true,
    signal: new AbortController().signal,
  });

  assert.equal(result, 'documents');
});

test('request mode classifier rejects malformed, unsupported, or uncertain results', async () => {
  for (const response of [
    { done: false, final_answer: '{"mode":"web","confidence":0.99}' },
    { done: true, tool_calls: [{ name: 'web_research' }] },
    { done: true, final_answer: '```json\n{"mode":"web","confidence":0.99}\n```' },
    { done: true, final_answer: '{"mode":"web","confidence":0.79}' },
    { done: true, final_answer: '{"mode":"skill","confidence":0.99}' },
    { done: true, final_answer: '{"mode":"documents","confidence":0.99,"extra":true}' },
    { done: true, final_answer: '{"mode":"chat","confidence":1.1}' },
  ]) {
    const result = await classifyLocalRequestMode({
      model: { async respond() { return response; } },
      task: 'Maybe this needs a specialized tool.',
    });
    assert.equal(result, null, JSON.stringify(response));
  }
});

test('request mode classifier only offers modes available in the request context', async () => {
  const result = await classifyLocalRequestMode({
    model: {
      async respond(input) {
        assert.deepEqual(input.context.supplemental_context.available_modes, [
          'chat', 'web', 'terminal',
        ]);
        return { done: true, final_answer: '{"mode":"panel","confidence":0.99}' };
      },
    },
    task: 'Read this tab.',
  });

  assert.equal(result, null);
});

test('request mode classifier propagates model failures for the caller to handle', async () => {
  await assert.rejects(classifyLocalRequestMode({
    model: {
      async respond() {
        throw new Error('Model unavailable.');
      },
    },
    task: 'Check the latest release.',
  }), /Model unavailable/u);
});

test('request mode classifier validates its input', async () => {
  await assert.rejects(classifyLocalRequestMode({
    model: {},
    task: 'Hello.',
  }), TypeError);
});
