import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalAgentModel } from './agent-model-adapter.mjs';

function streamResponse(events) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  }));
}

test('local agent adapter forwards structured context, streamed text, usage, and finish reason', async () => {
  let request;
  const model = createLocalAgentModel({
    endpoint: { url: 'http://127.0.0.1:8080/v1', model: 'local-model' },
    contextWindowTokens: 32_768,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return streamResponse([
        { choices: [{ delta: { reasoning_content: 'Review the claim.' }, finish_reason: null }] },
        { choices: [{ delta: { content: 'Verified ' }, finish_reason: null }] },
        {
          choices: [{ delta: { content: 'answer.' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
        },
      ]);
    },
  });
  const chunks = [];
  const context = {
    task: 'Explain the result',
    conversation_history: [{ role: 'user', content: 'Prior question' }],
    summary: 'Earlier context',
    recent_steps: [],
    step_number: 2,
    supplemental_context: {
      sources: [{ citationId: 'S1', name: 'notes.md', excerpt: 'A local note.' }],
    },
  };

  const result = await model.respond({
    system_prompt: 'Be accurate.',
    context,
    tools: [],
  }, { on_token: (chunk) => chunks.push(chunk) });

  assert.equal(request.url, 'http://127.0.0.1:8080/v1/chat/completions');
  const body = JSON.parse(request.options.body);
  assert.deepEqual(body.messages, [
    { role: 'system', content: 'Be accurate.' },
    {
      role: 'user',
      content: JSON.stringify({
        task: context.task,
        conversation_history: context.conversation_history,
        summary: context.summary,
        recent_steps: context.recent_steps,
        step_number: context.step_number,
        supplemental_context: context.supplemental_context,
      }),
    },
  ]);
  assert.equal('tools' in body, false);
  assert.deepEqual(chunks, ['Verified ', 'answer.']);
  assert.deepEqual(result, {
    done: true,
    final_answer: 'Verified answer.',
    thought: 'Review the claim.',
    token_usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 },
    finish_reason: 'stop',
  });
});

test('local agent adapter maps streamed tool calls to harness calls', async () => {
  const model = createLocalAgentModel({
    endpoint: { url: 'http://127.0.0.1:8080/v1', model: 'local-model' },
    contextWindowTokens: 32_768,
    fetchImpl: async () => streamResponse([
      {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              function: { name: 'lookup', arguments: '{"query":"hope"}' },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      },
    ]),
  });

  const result = await model.respond({
    system_prompt: 'Be accurate.',
    context: {
      task: 'Look up hope',
      conversation_history: [],
      summary: '',
      recent_steps: [],
      step_number: 1,
    },
    tools: [{
      name: 'lookup',
      description: 'Search information.',
      input_schema: { type: 'object', properties: { query: { type: 'string' } } },
    }],
  }, {});

  assert.equal(result.done, false);
  assert.deepEqual(result.tool_calls, [{ name: 'lookup', arguments: { query: 'hope' } }]);
  assert.equal(result.finish_reason, 'tool_calls');
});
