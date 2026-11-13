import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const MAX_SESSIONS = 10_000;
const MAX_MESSAGES_PER_SESSION = 10_000;
const MAX_MESSAGE_LENGTH = 24_000;
const MAX_SESSION_CONTENT = 8_000_000;
const MAX_TITLE_LENGTH = 120;
const MAX_SELECTED_DOCUMENTS = 100;
const MAX_RETRIEVED_DOCUMENTS = 10_000;
const MAX_SOURCES_PER_MESSAGE = 100;
const MAX_SOURCE_EXCERPT_LENGTH = 12_000;
const MAX_CONTEXT_USAGE_PER_MESSAGE = 100;
const MAX_CONTEXT_USAGE_EXCERPT_LENGTH = 1_600;
const MAX_TRACE_BYTES = 1_000_000;
const MAX_TRACE_STEPS = 20;
const MAX_TRACE_COLLECTION_ITEMS = 100;
const DOCUMENT_ID_PATTERN = /^[0-9a-f-]{36}$/u;
const CONTEXT_USAGE_METHODS = new Set([
  'attached-document',
  'document-search',
  'document-read',
  'folder-overview',
  'folder-instructions',
  'folder-read',
  'folder-grep',
]);
const AGENT_STEP_STATUSES = new Set(['success', 'failed', 'rejected', 'complete', 'needs_human']);

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function traceString(value, name, maxLength = 12_000, allowEmpty = true) {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || value.length > maxLength) {
    throw new Error(`Conversation contains an invalid agent trace ${name}.`);
  }
  return value;
}

function validateTraceJson(value, depth = 0, budget = { nodes: 10_000 }) {
  budget.nodes -= 1;
  if (budget.nodes < 0 || depth > 12) throw new Error('Conversation agent trace contains overly complex data.');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return traceString(value, 'value', 12_000);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (value.length > MAX_TRACE_COLLECTION_ITEMS) throw new Error('Conversation agent trace contains too many values.');
    return value.map((item) => validateTraceJson(item, depth + 1, budget));
  }
  if (!isRecord(value)) throw new Error('Conversation agent trace contains non-JSON data.');
  const entries = Object.entries(value);
  if (entries.length > MAX_TRACE_COLLECTION_ITEMS
    || entries.some(([key]) => key === '__proto__' || key === 'constructor' || key === 'prototype')) {
    throw new Error('Conversation agent trace contains invalid object data.');
  }
  return Object.fromEntries(entries.map(([key, child]) => [
    traceString(key, 'object key', 256, false),
    validateTraceJson(child, depth + 1, budget),
  ]));
}

function validateTrace(trace) {
  if (!isRecord(trace) || trace.schema_version !== 1
    || typeof trace.run_id !== 'string' || !trace.run_id || trace.run_id.length > 128
    || typeof trace.task !== 'string' || !trace.task || trace.task.length > 12_000
    || typeof trace.started_at !== 'string' || !Number.isFinite(Date.parse(trace.started_at))
    || typeof trace.completed_at !== 'string' || !Number.isFinite(Date.parse(trace.completed_at))
    || !Array.isArray(trace.steps) || trace.steps.length > MAX_TRACE_STEPS) {
    throw new Error('Conversation contains an invalid agent trace.');
  }
  let serialized;
  try {
    serialized = JSON.stringify(trace);
  } catch (error) {
    throw new Error('Conversation agent trace cannot be serialized.', { cause: error });
  }
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > MAX_TRACE_BYTES) {
    throw new Error('Conversation agent trace exceeds the local storage limit.');
  }
  const runtimeMetrics = trace.runtime_metrics === undefined ? undefined : (() => {
    if (!isRecord(trace.runtime_metrics)) {
      throw new Error('Conversation agent trace contains invalid runtime metrics.');
    }
    if ('skill_routing_ms' in trace.runtime_metrics && 'workflow_routing_ms' in trace.runtime_metrics) {
      throw new Error('Conversation agent trace contains invalid runtime metrics.');
    }
    const metrics = {};
    for (const [key, value] of [
      ['queue_wait_ms', trace.runtime_metrics.queue_wait_ms],
      ['skill_routing_ms', trace.runtime_metrics.skill_routing_ms
        ?? trace.runtime_metrics.workflow_routing_ms],
    ]) {
      if (value !== undefined) {
        if (!Number.isSafeInteger(value) || value < 0) {
          throw new Error('Conversation agent trace contains invalid runtime metrics.');
        }
        metrics[key] = value;
      }
    }
    const supportedMetrics = new Set(['queue_wait_ms', 'skill_routing_ms', 'workflow_routing_ms']);
    if (Object.keys(trace.runtime_metrics).some((key) => !supportedMetrics.has(key))) {
      throw new Error('Conversation agent trace contains invalid runtime metrics.');
    }
    return metrics;
  })();

  const steps = trace.steps.map((step, index) => {
    if (!isRecord(step) || step.step_number !== index + 1
      || typeof step.timestamp !== 'string' || !Number.isFinite(Date.parse(step.timestamp))
      || !(step.thought === null || typeof step.thought === 'string' && step.thought.length <= 12_000)
      || !(step.tool_calls === null || Array.isArray(step.tool_calls)
        && step.tool_calls.length <= MAX_TRACE_COLLECTION_ITEMS)
      || !(step.observation === null || Array.isArray(step.observation)
        && step.observation.length <= MAX_TRACE_COLLECTION_ITEMS)
      || !(step.error === null || typeof step.error === 'string' && step.error.length <= 12_000)
      || !AGENT_STEP_STATUSES.has(step.status)
      || !(step.token_usage === null || isRecord(step.token_usage))
      || (step.output_token_limit !== undefined
        && (!Number.isSafeInteger(step.output_token_limit) || step.output_token_limit < 1))
      || !Number.isFinite(step.latency_ms) || step.latency_ms < 0
      || ['context_assembly_ms', 'model_latency_ms', 'tool_execution_ms',
        'input_characters_before_compaction', 'input_characters_after_compaction', 'estimated_prompt_tokens']
        .some((key) => step[key] !== undefined
          && (!Number.isSafeInteger(step[key]) || step[key] < 0))
      || (step.prompt_estimate_method !== undefined
        && !['serialized_chars_div_4', 'runtime_usage_calibrated'].includes(step.prompt_estimate_method))
      || !Array.isArray(step.guardrail_decisions) || step.guardrail_decisions.length > MAX_TRACE_COLLECTION_ITEMS
      || !Array.isArray(step.verification) || step.verification.length > MAX_TRACE_COLLECTION_ITEMS
      || (step.tool_events !== undefined && (!Array.isArray(step.tool_events)
        || step.tool_events.length > MAX_TRACE_COLLECTION_ITEMS))
      || !(step.final_answer === null || typeof step.final_answer === 'string' && step.final_answer.length <= 24_000)
      || !(step.context_compaction === null
        || typeof step.context_compaction === 'string' && step.context_compaction.length <= 12_000)) {
      throw new Error('Conversation contains an invalid agent trace step.');
    }
    const toolCalls = step.tool_calls?.map((call) => {
      if (!isRecord(call) || typeof call.name !== 'string' || !call.name || call.name.length > 256
        || !Object.hasOwn(call, 'arguments')
        || (call.id !== undefined && (typeof call.id !== 'string' || call.id.length > 256))) {
        throw new Error('Conversation agent trace contains an invalid tool call.');
      }
      return {
        name: call.name,
        arguments: validateTraceJson(call.arguments),
        ...(call.id !== undefined ? { id: call.id } : {}),
      };
    }) ?? null;
    const observations = step.observation?.map((observation) => {
      if (!isRecord(observation) || typeof observation.name !== 'string' || !observation.name
        || observation.name.length > 256 || !['success', 'failed', 'not_executed'].includes(observation.status)
        || (observation.error !== undefined
          && (typeof observation.error !== 'string' || observation.error.length > 12_000))
        || (observation.result !== undefined && observation.status !== 'success')) {
        throw new Error('Conversation agent trace contains an invalid observation.');
      }
      return {
        name: observation.name,
        status: observation.status,
        ...(observation.result !== undefined ? { result: validateTraceJson(observation.result) } : {}),
        ...(observation.error !== undefined ? { error: observation.error } : {}),
      };
    }) ?? null;
    const tokenUsage = step.token_usage === null ? null : Object.fromEntries(
      ['input_tokens', 'output_tokens', 'total_tokens']
        .filter((key) => step.token_usage[key] !== undefined)
        .map((key) => {
          if (!Number.isSafeInteger(step.token_usage[key]) || step.token_usage[key] < 0) {
            throw new Error('Conversation agent trace contains invalid token usage.');
          }
          return [key, step.token_usage[key]];
        }),
    );
    if (step.token_usage && Object.keys(tokenUsage).length === 0) {
      throw new Error('Conversation agent trace contains invalid token usage.');
    }
    const guardrailDecisions = step.guardrail_decisions.map((decision) => {
      if (!isRecord(decision) || typeof decision.rule !== 'string' || !decision.rule
        || decision.rule.length > 256
        || !['allowed', 'rejected', 'needs_human', 'stopped'].includes(decision.decision)
        || typeof decision.details !== 'string' || decision.details.length > 12_000
        || (decision.tool_name !== undefined
          && (typeof decision.tool_name !== 'string' || decision.tool_name.length > 256))) {
        throw new Error('Conversation agent trace contains an invalid guardrail decision.');
      }
      return {
        rule: decision.rule,
        decision: decision.decision,
        details: decision.details,
        ...(decision.tool_name !== undefined ? { tool_name: decision.tool_name } : {}),
      };
    });
    const verification = step.verification.map((item) => {
      if (!isRecord(item) || !['passed', 'failed', 'skipped'].includes(item.status)
        || typeof item.details !== 'string' || item.details.length > 12_000
        || !['tool', 'run'].includes(item.phase)
        || (item.tool_name !== undefined && (typeof item.tool_name !== 'string' || item.tool_name.length > 256))) {
        throw new Error('Conversation agent trace contains an invalid verification result.');
      }
      return {
        status: item.status,
        details: item.details,
        phase: item.phase,
        ...(item.tool_name !== undefined ? { tool_name: item.tool_name } : {}),
      };
    });
    const toolEvents = step.tool_events?.map((event) => {
      if (!isRecord(event) || !Number.isSafeInteger(event.step_number) || event.step_number !== step.step_number
        || !Number.isSafeInteger(event.call_index) || event.call_index < 0
        || typeof event.tool_name !== 'string' || !event.tool_name || event.tool_name.length > 256
        || typeof event.timestamp !== 'string' || !Number.isFinite(Date.parse(event.timestamp))
        || !['pending', 'running', 'success', 'failed', 'rejected', 'needs_human', 'not_executed'].includes(event.status)
        || !Object.hasOwn(event, 'arguments')
        || (event.error !== undefined && (typeof event.error !== 'string' || event.error.length > 12_000))
        || (event.result !== undefined && event.status !== 'success')) {
        throw new Error('Conversation agent trace contains an invalid tool event.');
      }
      return {
        step_number: event.step_number,
        call_index: event.call_index,
        tool_name: event.tool_name,
        timestamp: event.timestamp,
        arguments: event.arguments === null ? null : validateTraceJson(event.arguments),
        status: event.status,
        ...(event.result !== undefined ? { result: validateTraceJson(event.result) } : {}),
        ...(event.error !== undefined ? { error: event.error } : {}),
      };
    });
    return {
      step_number: step.step_number,
      timestamp: step.timestamp,
      thought: step.thought,
      tool_calls: toolCalls,
      observation: observations,
      error: step.error,
      status: step.status,
      token_usage: tokenUsage,
      ...(step.output_token_limit !== undefined ? { output_token_limit: step.output_token_limit } : {}),
      latency_ms: step.latency_ms,
      ...(step.context_assembly_ms !== undefined ? { context_assembly_ms: step.context_assembly_ms } : {}),
      ...(step.model_latency_ms !== undefined ? { model_latency_ms: step.model_latency_ms } : {}),
      ...(step.tool_execution_ms !== undefined ? { tool_execution_ms: step.tool_execution_ms } : {}),
      ...(step.input_characters_before_compaction !== undefined
        ? { input_characters_before_compaction: step.input_characters_before_compaction }
        : {}),
      ...(step.input_characters_after_compaction !== undefined
        ? { input_characters_after_compaction: step.input_characters_after_compaction }
        : {}),
      ...(step.estimated_prompt_tokens !== undefined
        ? { estimated_prompt_tokens: step.estimated_prompt_tokens }
        : {}),
      ...(step.prompt_estimate_method !== undefined
        ? { prompt_estimate_method: step.prompt_estimate_method }
        : {}),
      guardrail_decisions: guardrailDecisions,
      verification,
      ...(toolEvents !== undefined ? { tool_events: toolEvents } : {}),
      final_answer: step.final_answer,
      context_compaction: step.context_compaction,
    };
  });

  return {
    schema_version: 1,
    run_id: trace.run_id,
    task: trace.task,
    started_at: trace.started_at,
    completed_at: trace.completed_at,
    ...(runtimeMetrics !== undefined ? { runtime_metrics: runtimeMetrics } : {}),
    steps,
  };
}

function validateSources(message) {
  if (message.sources === undefined) return undefined;
  if (message.role !== 'assistant' || !Array.isArray(message.sources)
    || message.sources.length > MAX_SOURCES_PER_MESSAGE) {
    throw new Error('Conversation contains invalid document citations.');
  }
  const citationIds = new Set();
  return message.sources.map((source) => {
    if (!source || typeof source !== 'object' || Array.isArray(source)
      || typeof source.citationId !== 'string' || !/^S\d{1,3}$/u.test(source.citationId)
      || citationIds.has(source.citationId)
      || typeof source.documentId !== 'string' || !DOCUMENT_ID_PATTERN.test(source.documentId)
      || typeof source.name !== 'string' || !source.name || source.name.length > 1_024
      || (source.page !== null && (!Number.isSafeInteger(source.page) || source.page < 1))
      || typeof source.excerpt !== 'string' || !source.excerpt
      || source.excerpt.length > MAX_SOURCE_EXCERPT_LENGTH) {
      throw new Error('Conversation contains an invalid document citation.');
    }
    citationIds.add(source.citationId);
    return {
      citationId: source.citationId,
      documentId: source.documentId,
      name: source.name,
      page: source.page,
      excerpt: source.excerpt,
    };
  });
}

function validateContextUsage(message) {
  if (message.contextUsage === undefined) return undefined;
  if (message.role !== 'assistant' || !Array.isArray(message.contextUsage)
    || message.contextUsage.length > MAX_CONTEXT_USAGE_PER_MESSAGE) {
    throw new Error('Conversation contains invalid document context provenance.');
  }
  return message.contextUsage.map((usage) => {
    if (!usage || typeof usage !== 'object' || Array.isArray(usage)
      || typeof usage.documentId !== 'string' || !DOCUMENT_ID_PATTERN.test(usage.documentId)
      || typeof usage.name !== 'string' || !usage.name || usage.name.length > 1_024
      || !CONTEXT_USAGE_METHODS.has(usage.method)
      || (usage.page !== null && (!Number.isSafeInteger(usage.page) || usage.page < 1))
      || (usage.startLine !== undefined && (!Number.isSafeInteger(usage.startLine) || usage.startLine < 1))
      || (usage.endLine !== undefined && (!Number.isSafeInteger(usage.endLine) || usage.endLine < 1))
      || ((usage.startLine === undefined) !== (usage.endLine === undefined))
      || (usage.startLine !== undefined && usage.endLine < usage.startLine)
      || typeof usage.excerpt !== 'string' || !usage.excerpt
      || usage.excerpt.length > MAX_CONTEXT_USAGE_EXCERPT_LENGTH
      || typeof usage.truncated !== 'boolean') {
      throw new Error('Conversation contains invalid document context provenance.');
    }
    return {
      documentId: usage.documentId,
      name: usage.name,
      method: usage.method,
      page: usage.page,
      ...(usage.startLine !== undefined ? { startLine: usage.startLine, endLine: usage.endLine } : {}),
      excerpt: usage.excerpt,
      truncated: usage.truncated,
    };
  });
}

function validateGenerationDuration(message) {
  if (message.generationDurationMs === undefined) return undefined;
  if (message.role !== 'assistant'
    || !Number.isSafeInteger(message.generationDurationMs)
    || message.generationDurationMs < 0) {
    throw new Error('Conversation contains an invalid response generation duration.');
  }
  return message.generationDurationMs;
}

function validateSkillSelection(message) {
  if (message.skillSelection === undefined) return undefined;
  const selection = message.skillSelection;
  if (message.role !== 'assistant' || !selection || typeof selection !== 'object'
    || Array.isArray(selection)
    || typeof selection.id !== 'string' || !selection.id || selection.id.length > 128
    || typeof selection.name !== 'string' || !selection.name || selection.name.length > 120
    || (selection.requiresConfirmation !== undefined
      && typeof selection.requiresConfirmation !== 'boolean')) {
    throw new Error('Conversation contains an invalid skill selection.');
  }
  return {
    id: selection.id,
    name: selection.name,
    ...(selection.requiresConfirmation === true ? { requiresConfirmation: true } : {}),
  };
}

function validateFormattingTokens(message) {
  if (message.formattingTokens === undefined) return undefined;
  if (message.role !== 'user' || !Array.isArray(message.formattingTokens)
    || message.formattingTokens.length > 100) {
    throw new Error('Conversation contains invalid composer formatting.');
  }
  let previousEnd = 0;
  return message.formattingTokens.map((token) => {
    const kind = token?.kind === 'workflow' ? 'skill' : token?.kind;
    if (!token || typeof token !== 'object' || Array.isArray(token)
      || !['tool', 'skill'].includes(kind)
      || !Number.isSafeInteger(token.start) || !Number.isSafeInteger(token.end)
      || token.start < previousEnd || token.end <= token.start
      || token.end > message.content.length
      || (kind === 'tool' && !message.content.slice(token.start, token.end).startsWith('@'))
      || (kind === 'skill' && !message.content.slice(token.start, token.end).startsWith('/'))) {
      throw new Error('Conversation contains invalid composer formatting.');
    }
    previousEnd = token.end;
    return { start: token.start, end: token.end, kind };
  });
}

function validateSession(session) {
  if (!session || typeof session !== 'object'
    || typeof session.id !== 'string' || !session.id
    || typeof session.title !== 'string' || session.title.length > MAX_TITLE_LENGTH
    || typeof session.createdAt !== 'string' || !Number.isFinite(Date.parse(session.createdAt))
    || typeof session.updatedAt !== 'string' || !Number.isFinite(Date.parse(session.updatedAt))
    || !Array.isArray(session.messages) || session.messages.length > MAX_MESSAGES_PER_SESSION) {
    throw new Error('Conversation data is invalid.');
  }

  if (session.selectedDocumentIds !== undefined
    && (!Array.isArray(session.selectedDocumentIds)
      || session.selectedDocumentIds.length > MAX_SELECTED_DOCUMENTS
      || session.selectedDocumentIds.some((id) => typeof id !== 'string' || !DOCUMENT_ID_PATTERN.test(id))
      || new Set(session.selectedDocumentIds).size !== session.selectedDocumentIds.length)) {
    throw new Error('Conversation has invalid selected documents.');
  }
  if (session.retrievedDocumentIds !== undefined
    && (!Array.isArray(session.retrievedDocumentIds)
      || session.retrievedDocumentIds.length > MAX_RETRIEVED_DOCUMENTS
      || session.retrievedDocumentIds.some((id) => typeof id !== 'string' || !DOCUMENT_ID_PATTERN.test(id))
      || new Set(session.retrievedDocumentIds).size !== session.retrievedDocumentIds.length)) {
    throw new Error('Conversation has invalid retrieved documents.');
  }

  let contentLength = 0;
  const messages = session.messages.map((message) => {
    if (!message || typeof message !== 'object'
      || !['user', 'assistant'].includes(message.role)
      || (message.status !== undefined
        && (message.role !== 'assistant'
          || !['cancelled', 'truncated', 'interrupted'].includes(message.status)))
      || typeof message.content !== 'string'
      || message.content.length > MAX_MESSAGE_LENGTH) {
      throw new Error('Conversation contains an invalid message.');
    }
    contentLength += message.content.length;
    const sources = validateSources(message);
    const contextUsage = validateContextUsage(message);
    const generationDurationMs = validateGenerationDuration(message);
    const skillSelection = validateSkillSelection(message);
    const formattingTokens = validateFormattingTokens(message);
    const trace = message.trace === undefined ? undefined : validateTrace(message.trace);
    if (trace !== undefined) {
      if (message.role !== 'assistant') throw new Error('Only assistant responses can contain an agent trace.');
      contentLength += Buffer.byteLength(JSON.stringify(trace), 'utf8');
    }
    if (sources) {
      contentLength += sources.reduce((total, source) => total + source.excerpt.length, 0);
    }
    if (contextUsage) {
      contentLength += contextUsage.reduce((total, usage) => total + usage.excerpt.length, 0);
    }
    if (contentLength > MAX_SESSION_CONTENT) throw new Error('Conversation exceeds the local storage limit.');
    return {
      role: message.role,
      content: message.content,
      ...(message.status !== undefined ? { status: message.status } : {}),
      ...(sources !== undefined ? { sources } : {}),
      ...(contextUsage !== undefined ? { contextUsage } : {}),
      ...(generationDurationMs !== undefined ? { generationDurationMs } : {}),
      ...(skillSelection !== undefined ? { skillSelection } : {}),
      ...(formattingTokens !== undefined ? { formattingTokens } : {}),
      ...(trace !== undefined ? { trace } : {}),
    };
  });

  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    selectedDocumentIds: [...(session.selectedDocumentIds ?? [])],
    retrievedDocumentIds: [...(session.retrievedDocumentIds ?? [])],
    messages,
  };
}

function validateSessions(value) {
  if (!Array.isArray(value) || value.length > MAX_SESSIONS) {
    throw new Error('The saved conversation list is invalid.');
  }
  const sessions = value.map(validateSession);
  const ids = new Set(sessions.map(({ id }) => id));
  if (ids.size !== sessions.length) throw new Error('The saved conversation list contains duplicate IDs.');
  return sessions;
}

export function createConversationStore(filePath) {
  async function readSessions() {
    let contents;
    try {
      contents = await readFile(filePath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw new Error(`Could not read local conversations: ${error.message}`, { cause: error });
    }

    let parsed;
    try {
      parsed = JSON.parse(contents);
    } catch (error) {
      throw new Error('The saved conversation file is not valid JSON.', { cause: error });
    }
    return validateSessions(parsed);
  }

  async function writeSessions(sessions) {
    const validatedSessions = validateSessions(sessions);
    await mkdir(dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(validatedSessions)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporaryPath, filePath);
    } catch (error) {
      throw new Error(`Could not save local conversations: ${error.message}`, { cause: error });
    }
  }

  return Object.freeze({
    list: readSessions,
    async get(id) {
      if (typeof id !== 'string' || !id) throw new Error('Conversation ID is invalid.');
      const sessions = await readSessions();
      const session = sessions.find((item) => item.id === id);
      if (!session) throw new Error('Conversation does not exist.');
      return session;
    },
    async create() {
      const sessions = await readSessions();
      const now = new Date().toISOString();
      const session = {
        id: randomUUID(),
        title: 'New conversation',
        createdAt: now,
        updatedAt: now,
        selectedDocumentIds: [],
        retrievedDocumentIds: [],
        messages: [],
      };
      sessions.unshift(session);
      await writeSessions(sessions);
      return session;
    },
    async save(input) {
      const session = validateSession(input);
      const sessions = await readSessions();
      const index = sessions.findIndex((item) => item.id === session.id);
      if (index < 0) throw new Error('Cannot save a conversation that does not exist.');
      sessions[index] = session;
      await writeSessions(sessions);
      return session;
    },
    async appendMessage(id, message) {
      if (typeof id !== 'string' || !id) throw new Error('Conversation ID is invalid.');
      const sessions = await readSessions();
      const index = sessions.findIndex((session) => session.id === id);
      if (index < 0) throw new Error('Cannot update a conversation that does not exist.');
      const updated = validateSession({
        ...sessions[index],
        updatedAt: new Date().toISOString(),
        messages: [...sessions[index].messages, message],
      });
      sessions[index] = updated;
      await writeSessions(sessions);
      return updated;
    },
    async removeDocumentSelection(documentId, sessionId, retainedFileIds) {
      if (typeof documentId !== 'string' || !DOCUMENT_ID_PATTERN.test(documentId)) {
        throw new Error('Document ID is invalid.');
      }
      if (sessionId !== undefined && (typeof sessionId !== 'string' || !sessionId)) {
        throw new Error('Conversation ID is invalid.');
      }
      if (retainedFileIds !== undefined
        && (!Array.isArray(retainedFileIds)
          || retainedFileIds.length > MAX_RETRIEVED_DOCUMENTS
          || retainedFileIds.some((id) => typeof id !== 'string' || !DOCUMENT_ID_PATTERN.test(id)))) {
        throw new Error('Retained document IDs are invalid.');
      }
      const retained = retainedFileIds === undefined ? null : new Set(retainedFileIds);
      const sessions = await readSessions();
      let changed = false;
      const updated = sessions.map((session) => {
        if (sessionId !== undefined && session.id !== sessionId) return session;
        const selectedDocumentIds = session.selectedDocumentIds.filter((id) => id !== documentId);
        const retrievedDocumentIds = retained
          ? session.retrievedDocumentIds.filter((id) => retained.has(id))
          : session.retrievedDocumentIds;
        let messagesChanged = false;
        const messages = retained
          ? session.messages.map((message) => {
            if (message.role !== 'assistant') return message;
            const removedCitationIds = new Set();
            const sources = Array.isArray(message.sources)
              ? message.sources.filter((source) => {
                  if (retained.has(source.documentId)) return true;
                  removedCitationIds.add(source.citationId);
                  return false;
                })
              : undefined;
            const contextUsage = Array.isArray(message.contextUsage)
              ? message.contextUsage.filter((usage) => retained.has(usage.documentId))
              : undefined;
            if (removedCitationIds.size === 0
              && (!contextUsage || contextUsage.length === message.contextUsage.length)) return message;
            messagesChanged = true;
            const content = removedCitationIds.size > 0
              ? message.content.replace(/\[S\d{1,3}\]/gu, (marker) =>
                removedCitationIds.has(marker.slice(1, -1)) ? '' : marker)
                .replace(/[ \t]{2,}/gu, ' ')
                .replace(/ +([,.;!?])/gu, '$1')
              : message.content;
            return {
              ...message,
              content,
              ...(sources !== undefined
                ? (sources.length > 0 ? { sources } : { sources: undefined })
                : {}),
              ...(contextUsage !== undefined ? { contextUsage } : {}),
            };
          })
          : session.messages;
        if (selectedDocumentIds.length === session.selectedDocumentIds.length
          && retrievedDocumentIds.length === session.retrievedDocumentIds.length
          && !messagesChanged) return session;
        changed = true;
        return {
          ...session,
          updatedAt: new Date().toISOString(),
          selectedDocumentIds,
          retrievedDocumentIds,
          messages,
        };
      });
      if (changed) await writeSessions(updated);
    },
    async delete(id) {
      if (typeof id !== 'string' || !id) throw new Error('Conversation ID is invalid.');
      const sessions = await readSessions();
      const remaining = sessions.filter((session) => session.id !== id);
      if (remaining.length === sessions.length) throw new Error('Cannot delete a conversation that does not exist.');
      await writeSessions(remaining);
    },
  });
}
