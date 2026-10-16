import { responseTokenLimitForContext } from './context-window.mjs';
import { createInactivityTimeout } from './inactivity-timeout.mjs';
import { readChatCompletionStream } from './chat-completion-stream.mjs';

const DEFAULT_INACTIVITY_TIMEOUT_MS = 120_000;

export function createLocalAgentModel({
  endpoint,
  contextWindowTokens,
  fetchImpl = fetch,
  inactivityTimeoutMs = DEFAULT_INACTIVITY_TIMEOUT_MS,
}) {
  if (!endpoint || typeof endpoint.url !== 'string' || !endpoint.url
    || typeof endpoint.model !== 'string' || !endpoint.model
    || typeof fetchImpl !== 'function'
    || !Number.isSafeInteger(contextWindowTokens) || contextWindowTokens < 1
    || !Number.isSafeInteger(inactivityTimeoutMs) || inactivityTimeoutMs < 1) {
    throw new Error('Local agent model configuration is invalid.');
  }

  return Object.freeze({
    async respond({ system_prompt: systemPrompt, context, tools }, { signal, on_token }) {
      const inactivityTimeout = createInactivityTimeout(
        inactivityTimeoutMs,
        `Local assistant did not stream response data for ${inactivityTimeoutMs / 1_000} seconds.`,
      );
      try {
        const modelTools = tools.map((tool) => ({
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.input_schema ?? {
              type: 'object',
              properties: {},
              additionalProperties: true,
            },
          },
        }));
        const userPrompt = JSON.stringify({
          task: context.task,
          conversation_history: context.conversation_history,
          summary: context.summary,
          recent_steps: context.recent_steps,
          step_number: context.step_number,
          ...(context.supplemental_context !== undefined
            ? { supplemental_context: context.supplemental_context }
            : {}),
        });
        const response = await fetchImpl(`${endpoint.url}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: endpoint.model,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
            ...(modelTools.length > 0 ? { tools: modelTools, tool_choice: 'auto' } : {}),
            temperature: 0.2,
            max_tokens: responseTokenLimitForContext(contextWindowTokens),
            stream: true,
          }),
          signal: signal
            ? AbortSignal.any([signal, inactivityTimeout.signal])
            : inactivityTimeout.signal,
        });
        if (!response.ok) {
          throw new Error(`Local assistant returned HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
        }
        const completion = await readChatCompletionStream(
          response.body,
          on_token ?? (() => {}),
          inactivityTimeout.reset,
        );
        const toolCalls = completion.toolCalls.map((call) => {
          let arguments_ = call.arguments;
          try {
            arguments_ = JSON.parse(call.arguments);
          } catch {
            arguments_ = call.arguments;
          }
          return { name: call.name, arguments: arguments_ };
        });
        const thought = typeof completion.reasoning === 'string' ? completion.reasoning.trim() : '';
        return {
          done: toolCalls.length === 0,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {
            final_answer: completion.answer.trim(),
          }),
          ...(thought ? { thought } : {}),
          ...(completion.tokenUsage ? { token_usage: completion.tokenUsage } : {}),
          finish_reason: completion.finishReason,
        };
      } finally {
        inactivityTimeout.dispose();
      }
    },
  });
}
