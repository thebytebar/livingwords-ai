import assert from 'node:assert/strict';
import test from 'node:test';
import { readChatCompletionStream } from './chat-completion-stream.mjs';

function streamFrom(chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
}

test('chat completion stream assembles split SSE events and reports finish reason', async () => {
  const chunks = [];
  let activityCount = 0;
  const body = streamFrom([
    'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}\r\n\r\n',
    'data: {"choices":[{"delta":{"content":" there."},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ]);

  const result = await readChatCompletionStream(body, (chunk) => chunks.push(chunk), () => activityCount++);

  assert.deepEqual(chunks, ['Hello', ' there.']);
  assert.ok(activityCount > 0);
  assert.deepEqual(result, { answer: 'Hello there.', finishReason: 'stop', toolCalls: [] });
});

test('chat completion stream preserves output-limit finish reason', async () => {
  const body = streamFrom([
    'data: {"choices":[{"delta":{"content":"Partial"},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n',
  ]);

  const result = await readChatCompletionStream(body, () => {});

  assert.deepEqual(result, { answer: 'Partial', finishReason: 'length', toolCalls: [] });
});

test('chat completion stream assembles structured terminal tool calls', async () => {
  const body = streamFrom([
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"run_terminal_","arguments":"{\\"command\\":"}}]},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"command","arguments":"\\"pwd\\"}"}}]},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
  ]);

  const result = await readChatCompletionStream(body, () => {});

  assert.deepEqual(result, {
    answer: '',
    finishReason: 'tool_calls',
    toolCalls: [{ name: 'run_terminal_command', arguments: '{"command":"pwd"}' }],
  });
});

test('chat completion stream reports malformed events and server errors', async () => {
  await assert.rejects(
    readChatCompletionStream(streamFrom(['data: nope\n\n']), () => {}),
    /invalid streaming event/u,
  );
  await assert.rejects(
    readChatCompletionStream(
      streamFrom(['data: {"error":{"message":"generation failed"}}\n\n']),
      () => {},
    ),
    /generation failed/u,
  );
});
