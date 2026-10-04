export async function readChatCompletionStream(body, onChunk, onActivity = () => {}) {
  if (!body || typeof body.getReader !== 'function') {
    throw new Error('Local assistant returned no streaming response body.');
  }
  if (typeof onChunk !== 'function') {
    throw new TypeError('A response chunk handler is required.');
  }
  if (typeof onActivity !== 'function') {
    throw new TypeError('A response activity handler must be a function.');
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let answer = '';
  let finishReason = null;
  const toolCalls = new Map();

  function processFrame(frame) {
    const data = frame.split(/\r\n|\n|\r/u)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /u, ''))
      .join('\n');
    if (!data || data === '[DONE]') return;

    let payload;
    try {
      payload = JSON.parse(data);
    } catch (error) {
      throw new Error('Local assistant returned an invalid streaming event.', { cause: error });
    }
    if (!payload || typeof payload !== 'object') {
      throw new Error('Local assistant returned an invalid streaming event.');
    }
    if (payload.error) {
      const detail = typeof payload.error.message === 'string'
        ? payload.error.message
        : JSON.stringify(payload.error);
      throw new Error(`Local assistant stream failed: ${detail}`);
    }
    if (!Array.isArray(payload.choices)) {
      throw new Error('Local assistant returned a streaming event without choices.');
    }

    for (const choice of payload.choices) {
      if (typeof choice?.finish_reason === 'string') finishReason = choice.finish_reason;
      const delta = choice?.delta;
      const chunk = delta?.content;
      if (typeof chunk === 'string' && chunk) {
        answer += chunk;
        onChunk(chunk);
      }
      if (Array.isArray(delta?.tool_calls)) {
        for (const part of delta.tool_calls) {
          if (!Number.isInteger(part?.index) || part.index < 0 || part.index > 3) {
            throw new Error('Local assistant returned an invalid terminal tool call.');
          }
          const previous = toolCalls.get(part.index) ?? { name: '', arguments: '' };
          const name = part.function?.name;
          const argumentsChunk = part.function?.arguments;
          if (name !== undefined && typeof name !== 'string') {
            throw new Error('Local assistant returned an invalid terminal tool name.');
          }
          if (argumentsChunk !== undefined && typeof argumentsChunk !== 'string') {
            throw new Error('Local assistant returned invalid terminal tool arguments.');
          }
          previous.name += name ?? '';
          previous.arguments += argumentsChunk ?? '';
          if (previous.name.length > 128 || previous.arguments.length > 4_096) {
            throw new Error('Local assistant terminal tool request is too large.');
          }
          toolCalls.set(part.index, previous);
        }
      }
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (value?.byteLength) onActivity();
      buffer += decoder.decode(value, { stream: !done });
      let boundary;
      while ((boundary = /\r?\n\r?\n/u.exec(buffer))) {
        processFrame(buffer.slice(0, boundary.index));
        buffer = buffer.slice(boundary.index + boundary[0].length);
      }
      if (done) break;
    }
    if (buffer.trim()) processFrame(buffer);
  } finally {
    reader.releaseLock();
  }

  return {
    answer,
    finishReason,
    toolCalls: [...toolCalls.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, call]) => call),
  };
}
