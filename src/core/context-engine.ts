import { performance } from 'node:perf_hooks';
import type {
  AgentContext,
  AgentConversationTurn,
  AgentToolSpec,
  JsonValue,
  Step,
} from './agent-loop.js';

export interface ContextAssemblyInput {
  task: string;
  conversation_history: readonly AgentConversationTurn[];
  supplemental_context?: JsonValue;
  step_number: number;
  previous_steps: readonly Step[];
  signal?: AbortSignal;
}

export interface ContextAssemblyResult {
  context: AgentContext;
  context_compaction: string | null;
  input_characters_before_compaction: number;
  input_characters_after_compaction: number;
  estimated_prompt_tokens: number;
  prompt_estimate_method: 'serialized_chars_div_4' | 'runtime_usage_calibrated';
  context_assembly_ms: number;
}

export interface AgentContextEngine {
  assemble(input: ContextAssemblyInput): Promise<ContextAssemblyResult>;
  observeUsage(inputCharacters: number, actualInputTokens: number): void;
}

export interface LocalContextEngineOptions {
  system_prompt: string;
  tools: readonly AgentToolSpec[] | (() => readonly AgentToolSpec[]);
  max_context_characters: number;
  max_prompt_tokens?: number;
  max_summary_characters: number;
  recent_steps_to_keep: number;
  summarize?: (steps: readonly Step[], existing_summary: string) => Promise<string> | string;
}

function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
}

const OBSERVATION_KEY_PRIORITY = [
  'citationId', 'name', 'url', 'page', 'excerpt', 'passage', 'passages',
  'query', 'result', 'local', 'iso', 'timeZone', 'title', 'text', 'content',
  'message', 'truncated',
];
const OMITTED_OBSERVATION_KEYS = new Set([
  'duration', 'latency', 'token_usage', 'guardrail_decisions', 'verification',
  'status', 'trace', 'metadata',
]);

function compactObservationValue(value: JsonValue, budget: number): JsonValue {
  if (typeof value === 'string') return value.slice(0, budget);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    const items: JsonValue[] = [];
    for (const item of value.slice(0, 4)) {
      const remaining = budget - JSON.stringify(items).length - 4;
      if (remaining < 80) break;
      items.push(compactObservationValue(item, Math.min(800, remaining)));
    }
    return items;
  }
  const entries = Object.entries(value as Record<string, JsonValue>)
    .filter(([key]) => !OMITTED_OBSERVATION_KEYS.has(key))
    .sort(([left], [right]) => {
      const leftIndex = OBSERVATION_KEY_PRIORITY.indexOf(left);
      const rightIndex = OBSERVATION_KEY_PRIORITY.indexOf(right);
      return (leftIndex < 0 ? OBSERVATION_KEY_PRIORITY.length : leftIndex)
        - (rightIndex < 0 ? OBSERVATION_KEY_PRIORITY.length : rightIndex);
    });
  const result: Record<string, JsonValue> = {};
  for (const [key, item] of entries) {
    const remaining = budget - JSON.stringify(result).length - key.length - 8;
    if (remaining < 80) break;
    result[key] = compactObservationValue(item, Math.min(1_200, remaining));
  }
  return result;
}

function compactForModel(value: JsonValue, serializedBudget: number): JsonValue {
  let valueBudget = serializedBudget;
  while (valueBudget > 1) {
    const compacted = compactObservationValue(value, valueBudget);
    if (JSON.stringify(compacted).length <= serializedBudget) return compacted;
    valueBudget = Math.max(1, Math.floor(valueBudget * 0.75));
  }
  return compactObservationValue(value, 1);
}

function observationText(value: JsonValue, budget: number): string {
  if (typeof value === 'string') return value.slice(0, budget);
  if (value === null || typeof value !== 'object') return String(value);
  if (Array.isArray(value)) {
    return value.map((item) => `- ${observationText(item, Math.floor(budget / Math.max(value.length, 1)))}`)
      .join('\n').slice(0, budget);
  }
  return Object.entries(value)
    .map(([key, item]) => `${key}: ${observationText(item, Math.max(100, budget - key.length - 4))}`)
    .join('\n')
    .slice(0, budget);
}

function compactStep(step: Step): Step {
  return {
    step_number: step.step_number,
    timestamp: step.timestamp,
    tool_events: [],
    thought: null,
    tool_calls: step.tool_calls?.map(({ name, arguments: args, id }) => ({
      name,
      arguments: args === null
        ? null
        : JSON.stringify(compactObservationValue(args, 350)),
      ...(id ? { id } : {}),
    })) as Step['tool_calls'],
    observation: step.observation?.map((item) => ({
      name: item.name,
      status: item.status,
      ...(item.result !== undefined
        ? { result: compactForModel(item.result, 1_800) }
        : {}),
      ...(item.error ? { error: item.error.slice(0, 400) } : {}),
    })) as Step['observation'],
    error: step.error?.slice(0, 400) ?? null,
    status: step.status,
    token_usage: null,
    latency_ms: 0,
    guardrail_decisions: [],
    verification: [],
    final_answer: null,
    context_compaction: null,
  };
}

function minimalContextStep(step: Step): Step {
  return {
    ...step,
    thought: null,
    tool_calls: step.tool_calls?.map(({ name }) => ({ name, arguments: null })) ?? null,
    observation: step.observation?.map(({ name, status }) => ({ name, status })) ?? null,
    error: null,
    token_usage: null,
    guardrail_decisions: [],
    verification: [],
    tool_events: [],
    final_answer: null,
    context_compaction: null,
  };
}

function fallbackSummary(steps: readonly Step[], existing: string): string {
  const updates = steps.map((step) => {
    const calls = step.tool_calls?.map(({ name, arguments: args }) =>
      `${name}${args ? `(${JSON.stringify(args).slice(0, 250)})` : ''}`).join(', ');
    const outputs = step.observation?.map((item) => {
      if (item.error) return `${item.name} error: ${item.error.slice(0, 300)}`;
      if (item.result !== undefined) {
        return `${item.name}: ${observationText(compactForModel(item.result, 700), 700)}`;
      }
      return `${item.name}: no result`;
    }).join('; ');
    return `Step ${step.step_number}: ${[calls, outputs].filter(Boolean).join(' -> ') || step.error?.slice(0, 300) || 'no action'}`;
  });
  return [existing, ...updates].filter(Boolean).join('\n').slice(-2_000);
}

function summarizeConversationTurn(turn: AgentConversationTurn): string {
  const content = turn.content.replace(/\s+/gu, ' ').trim();
  const excerpt = content.length > 600
    ? `${content.slice(0, 450)} … ${content.slice(-120)}`
    : content;
  return `${turn.role}: ${excerpt}`;
}

function boundConversationSummary(combined: string, maxCharacters: number): string {
  if (maxCharacters <= 0) return '';
  if (combined.length <= maxCharacters) return combined;
  const marker = '\n… older messages summarized …\n';
  if (maxCharacters <= marker.length) return combined.slice(-maxCharacters);
  const contentBudget = maxCharacters - marker.length;
  const headLength = Math.ceil(contentBudget / 2);
  const tailLength = contentBudget - headLength;
  return `${combined.slice(0, headLength)}${marker}${tailLength > 0 ? combined.slice(-tailLength) : ''}`;
}

function appendConversationSummary(
  existing: string,
  turn: AgentConversationTurn,
  maxCharacters: number,
): string {
  const combined = [existing, summarizeConversationTurn(turn)].filter(Boolean).join('\n');
  return boundConversationSummary(combined, maxCharacters);
}

export function waitForSignal<T>(value: PromiseLike<T> | T, signal?: AbortSignal): Promise<T> {
  if (!signal) return Promise.resolve(value);
  if (signal.aborted) {
    void Promise.resolve(value).catch(() => {});
    return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('Run was stopped by the caller.'));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(signal.reason instanceof Error ? signal.reason : new Error('Run was stopped by the caller.'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(value).then(
      (result) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

export function createLocalContextEngine(options: LocalContextEngineOptions) {
  let summary = '';
  let summarizedStepCount = 0;
  let observedCharactersPerToken = 4;
  let hasRuntimeUsageAnchor = false;

  return Object.freeze({
    observeUsage(inputCharacters: number, actualInputTokens: number) {
      if (!Number.isSafeInteger(inputCharacters) || inputCharacters < 1
        || !Number.isSafeInteger(actualInputTokens) || actualInputTokens < 1) return;
      const observedRatio = Math.min(4, Math.max(1, inputCharacters / actualInputTokens));
      observedCharactersPerToken = Math.min(
        4,
        Math.max(1, observedCharactersPerToken * 0.5 + observedRatio * 0.5),
      );
      hasRuntimeUsageAnchor = true;
    },
    async assemble(input: ContextAssemblyInput): Promise<ContextAssemblyResult> {
      const startedAt = performance.now();
      let contextCompaction: string | null = null;
      const recent = input.previous_steps.slice(-options.recent_steps_to_keep);
      const olderCount = input.previous_steps.length - recent.length;
      if (olderCount > summarizedStepCount) {
        const toSummarize = input.previous_steps.slice(summarizedStepCount, olderCount);
        const nextSummary = options.summarize
          ? await waitForSignal(options.summarize(toSummarize, summary), input.signal)
          : fallbackSummary(toSummarize, summary);
        if (typeof nextSummary !== 'string') throw new Error('Context summarizer must return text.');
        summary = nextSummary.slice(-options.max_summary_characters);
        summarizedStepCount = olderCount;
        contextCompaction = `Summarized ${toSummarize.length} earlier step(s) into bounded context.`;
      }

      const contextSteps = input.previous_steps.slice(-options.recent_steps_to_keep).map(compactStep);
      const conversationHistory = [...input.conversation_history];
      let conversationSummary = '';
      const createContext = (recentSteps: readonly Step[]): AgentContext => ({
        task: input.task,
        conversation_history: conversationHistory,
        ...(conversationSummary ? { conversation_summary: conversationSummary } : {}),
        summary,
        recent_steps: recentSteps,
        step_number: input.step_number,
        ...(input.supplemental_context !== undefined
          ? { supplemental_context: input.supplemental_context }
          : {}),
      });
      const inputCharacters = (context: AgentContext) => JSON.stringify({
        system_prompt: options.system_prompt,
        context,
        tools: typeof options.tools === 'function' ? options.tools() : options.tools,
      }).length;
      const contextCharacters = (context: AgentContext) => JSON.stringify(context).length;
      const isOverBudget = (context: AgentContext) => contextCharacters(context) > options.max_context_characters
        || (options.max_prompt_tokens !== undefined
          && inputCharacters(context) / observedCharactersPerToken > options.max_prompt_tokens);
      let context = createContext(contextSteps);
      const inputCharactersBeforeCompaction = inputCharacters(context);

      while (isOverBudget(context) && conversationHistory.length > 8) {
        const olderTurn = conversationHistory.shift();
        if (olderTurn) {
          conversationSummary = appendConversationSummary(
            conversationSummary,
            olderTurn,
            options.max_summary_characters,
          );
          contextCompaction = 'Summarized older conversation messages to fit the context budget.';
        }
        context = createContext(contextSteps);
      }
      while (isOverBudget(context) && conversationSummary.length > 0) {
        conversationSummary = boundConversationSummary(
          conversationSummary,
          Math.floor(conversationSummary.length / 2),
        );
        context = createContext(contextSteps);
      }
      while (isOverBudget(context) && conversationHistory.length > 0) {
        const olderTurn = conversationHistory.shift();
        if (olderTurn) {
          conversationSummary = appendConversationSummary(
            conversationSummary,
            olderTurn,
            options.max_summary_characters,
          );
        }
        context = createContext(contextSteps);
        while (isOverBudget(context) && conversationSummary.length > 0) {
          conversationSummary = boundConversationSummary(
            conversationSummary,
            Math.floor(conversationSummary.length / 2),
          );
          context = createContext(contextSteps);
        }
      }
      while (contextSteps.length > 1 && isOverBudget(context)) {
        const removed = contextSteps.shift();
        if (removed) {
          summary = fallbackSummary([removed], summary).slice(-options.max_summary_characters);
          summarizedStepCount = Math.max(summarizedStepCount, removed.step_number);
          contextCompaction = 'Trimmed older structured steps to fit the context budget.';
        }
        context = createContext(contextSteps);
      }
      if (isOverBudget(context) && contextSteps.length === 1) {
        contextSteps[0] = minimalContextStep(contextSteps[0]!);
        contextCompaction = 'Reduced the latest structured step to fit the context budget.';
        context = createContext(contextSteps);
      }
      while (isOverBudget(context) && summary.length > 0) {
        summary = summary.slice(Math.ceil(summary.length / 2));
        contextCompaction = 'Trimmed the summary to fit the context budget.';
        context = createContext(contextSteps);
      }
      if (isOverBudget(context)) {
        throw new Error('The task and fixed prompt content exceed the configured context budget.');
      }

      const inputCharactersAfterCompaction = inputCharacters(context);
      return {
        context,
        context_compaction: contextCompaction,
        input_characters_before_compaction: inputCharactersBeforeCompaction,
        input_characters_after_compaction: inputCharactersAfterCompaction,
        estimated_prompt_tokens: Math.ceil(inputCharactersAfterCompaction / observedCharactersPerToken),
        prompt_estimate_method: hasRuntimeUsageAnchor
          ? 'runtime_usage_calibrated'
          : 'serialized_chars_div_4',
        context_assembly_ms: Math.max(0, Math.round(performance.now() - startedAt)),
      };
    },
  });
}
