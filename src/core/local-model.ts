import { ensureLocalModelServer } from './model-server.js';

export interface LocalModelOptions {
  baseUrl?: string;
  model?: string;
  temperature?: number;
}

const DEFAULT_BASE_URL = 'http://127.0.0.1:8080/v1';
const DEFAULT_MODEL = 'mlx-community/gemma-4-e2b-it-4bit';

export async function generateLocalChatCompletion(
  systemPrompt: string,
  userPrompt: string,
  maxTokens = 384,
  options: LocalModelOptions = {},
): Promise<string> {
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 512) {
    throw new Error('maxTokens must be an integer between 1 and 512 for the 8 GB memory profile');
  }

  const baseUrl = (options.baseUrl ?? process.env.LW_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/u, '');
  const requestedModel = options.model ?? process.env.LW_MODEL ?? DEFAULT_MODEL;
  const model = await ensureLocalModelServer({ baseUrl, modelId: requestedModel });
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: options.temperature ?? 0.2,
        max_tokens: maxTokens,
      }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (error) {
    throw new Error(
      `Could not reach the local model server at ${baseUrl}. Check that the configured local OpenAI-compatible server is running.`,
      { cause: error },
    );
  }

  if (!response.ok) {
    const body = (await response.text()).slice(0, 500);
    throw new Error(`Local model server returned HTTP ${response.status}: ${body}`);
  }

  const payload: unknown = await response.json();
  if (!payload || typeof payload !== 'object' || !('choices' in payload) || !Array.isArray(payload.choices)) {
    throw new Error('Local model server returned an invalid chat-completion response');
  }
  const content = payload.choices[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('Local model server returned no answer text');
  }
  return content.trim();
}

export const gemma4DefaultModel = DEFAULT_MODEL;
