import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createAgentHarness,
  serializeTrace,
  type AgentModelResponse,
  type AgentTool,
} from './agent-loop.js';
import { createDocumentAgentContext } from '../../electron/document-agent.mjs';

function scriptedModel(responses: AgentModelResponse[], onRequest?: (step: number) => void) {
  let index = 0;
  return {
    async respond() {
      onRequest?.(index + 1);
      const response = responses[index++];
      if (!response) throw new Error('No scripted response remains.');
      return response;
    },
  };
}

test('single-shot completion returns an append-only JSON-serializable trace and metrics', async () => {
  const harness = createAgentHarness({
    model: scriptedModel([{
      thought: 'The task needs no tool.',
      done: true,
      final_answer: 'Finished.',
      token_usage: { input_tokens: 12, output_tokens: 5 },
    }]),
  });

  const result = await harness.run('Answer this task.');
  const serialized = serializeTrace(result.trace);

  assert.equal(result.final_answer, 'Finished.');
  assert.equal(result.success, true);
  assert.equal(result.stop_reason, 'task_complete');
  assert.equal(result.trace.steps.length, 1);
  assert.equal(result.trace.steps[0]?.status, 'complete');
  assert.equal(result.trace.steps[0]?.thought, 'The task needs no tool.');
  assert.equal(result.metrics.total_tokens, 17);
  assert.equal(result.metrics.steps_taken, 1);
  assert.deepEqual(JSON.parse(serialized), result.trace);
});

test('run forwards structured conversation history and streamed token chunks', async () => {
  const tokens: string[] = [];
  const supplementalContext = {
    sources: [{ citationId: 'S1', name: 'notes.md', excerpt: 'A local passage.' }],
  };
  const result = await createAgentHarness({
    model: {
      async respond({ context }, { on_token }) {
        assert.deepEqual(context.conversation_history, [
          { role: 'user', content: 'Earlier question.' },
          { role: 'assistant', content: 'Earlier answer.' },
        ]);
        assert.deepEqual(context.supplemental_context, supplementalContext);
        on_token?.('The ');
        on_token?.('answer.');
        return { done: true, final_answer: 'The answer.', finish_reason: 'stop' };
      },
    },
  }).run('Follow up.', {
    history: [
      { role: 'user', content: 'Earlier question.' },
      { role: 'assistant', content: 'Earlier answer.' },
    ],
    supplemental_context: supplementalContext,
    on_token: (chunk) => tokens.push(chunk),
  });

  assert.deepEqual(tokens, ['The ', 'answer.']);
  assert.equal(result.finish_reason, 'stop');
  assert.equal(result.success, true);
});

test('multiple tool calls execute within one step and receive deterministic verification', async () => {
  const environment = { release: 'draft', inspected: false };
  const calls: string[] = [];
  const tools: AgentTool[] = [
    {
      name: 'publish_release',
      description: 'Publish a named release.',
      validate_input: (args) => typeof args === 'object' && args !== null
        && 'name' in args && typeof args.name === 'string' ? null : 'Release name is required.',
      async execute() {
        calls.push('publish');
        environment.release = 'published';
        return { release: environment.release };
      },
      verify: () => ({
        passed: environment.release === 'published',
        details: `Environment release is ${environment.release}.`,
      }),
    },
    {
      name: 'inspect_release',
      description: 'Inspect the current release state.',
      async execute() {
        calls.push('inspect');
        environment.inspected = true;
        return { ...environment };
      },
      verify: (_args, result) => ({
        passed: environment.inspected && (result as { release?: string }).release === 'published',
        details: 'Release state was inspected after publishing.',
      }),
    },
  ];
  const harness = createAgentHarness({
    model: scriptedModel([
      {
        thought: 'Publish, then inspect the environment state.',
        done: false,
        tool_calls: [
          { name: 'publish_release', arguments: { name: '1.0' }, id: 'publish-1' },
          { name: 'inspect_release', arguments: {} },
        ],
        token_usage: { total_tokens: 20 },
      },
      { done: true, final_answer: 'Release 1.0 is published and inspected.' },
    ]),
    tools,
    require_verification: true,
  });

  const result = await harness.run('Publish release 1.0 and verify its state.');

  assert.equal(result.success, true);
  assert.equal(result.metrics.steps_taken, 2);
  assert.deepEqual(calls, ['publish', 'inspect']);
  assert.equal(result.trace.steps[0]?.tool_calls?.length, 2);
  assert.deepEqual(result.trace.steps[0]?.verification.map(({ status }) => status), ['passed', 'passed']);
  assert.deepEqual(result.trace.steps[0]?.observation?.map(({ status }) => status), ['success', 'success']);
  assert.equal(result.trace.steps[1]?.status, 'complete');
});

test('tool lifecycle events publish before execution finishes and before the step trace', async () => {
  let signalToolStarted!: () => void;
  let releaseTool!: () => void;
  const toolStarted = new Promise<void>((resolve) => {
    signalToolStarted = resolve;
  });
  const toolGate = new Promise<void>((resolve) => {
    releaseTool = resolve;
  });
  const lifecycle: string[] = [];
  const events: Array<{ status: string; call_index: number }> = [];
  const persistedEvents: Array<{ status: string; arguments: unknown; timestamp: string }> = [];
  const traceSnapshots: number[][] = [];
  const run = createAgentHarness({
    model: scriptedModel([
      { done: false, tool_calls: [{ name: 'inspect', arguments: { path: 'src' } }] },
      { done: true, final_answer: 'Inspected.' },
    ]),
    tools: [{
      name: 'inspect',
      description: 'Inspect a path.',
      async execute() {
        signalToolStarted();
        await toolGate;
        return { files: 1 };
      },
    }],
    on_tool_event: (event) => {
      events.push({ status: event.status, call_index: event.call_index });
      lifecycle.push(`tool:${event.status}`);
    },
    on_step: (step, trace) => {
      lifecycle.push(`step:${step.step_number}`);
      traceSnapshots.push(trace.steps.map(({ step_number }) => step_number));
      persistedEvents.push(...(step.tool_events ?? []).map(({ status, arguments: args, timestamp }) => ({
        status,
        arguments: args,
        timestamp,
      })));
    },
  }).run('Inspect the source folder.');

  await toolStarted;
  assert.deepEqual(events.map(({ status }) => status), ['pending', 'running']);
  assert.deepEqual(lifecycle, ['tool:pending', 'tool:running']);
  releaseTool();
  const result = await run;

  assert.deepEqual(events.map(({ status }) => status), ['pending', 'running', 'success']);
  assert.deepEqual(lifecycle, ['tool:pending', 'tool:running', 'tool:success', 'step:1', 'step:2']);
  assert.deepEqual(traceSnapshots, [[1], [1, 2]]);
  assert.deepEqual(persistedEvents.map(({ status }) => status), ['pending', 'running', 'success']);
  assert.deepEqual(persistedEvents[0].arguments, { path: 'src' });
  assert.equal(persistedEvents[1].arguments, null);
  assert.ok(persistedEvents.every(({ timestamp }) => Number.isFinite(Date.parse(timestamp))));
  assert.equal(result.success, true);
});

test('tool lifecycle reports failures and calls skipped after a tool failure', async () => {
  const events: Array<{ tool_name: string; status: string }> = [];
  const result = await createAgentHarness({
    model: scriptedModel([{
      done: false,
      tool_calls: [
        { name: 'first', arguments: {} },
        { name: 'second', arguments: {} },
      ],
    }]),
    tools: [
      {
        name: 'first',
        description: 'Fail intentionally.',
        async execute() {
          throw new Error('Tool failed.');
        },
      },
      {
        name: 'second',
        description: 'Should not run.',
        async execute() {
          return { unexpected: true };
        },
      },
    ],
    on_tool_event: ({ tool_name, status }) => events.push({ tool_name, status }),
  }).run('Run both tools.');

  assert.equal(result.stop_reason, 'tool_error');
  assert.deepEqual(events, [
    { tool_name: 'first', status: 'pending' },
    { tool_name: 'second', status: 'pending' },
    { tool_name: 'first', status: 'running' },
    { tool_name: 'first', status: 'failed' },
    { tool_name: 'second', status: 'not_executed' },
  ]);
});

test('folder inspection and file reads are model-invoked calls in the structured trace', async () => {
  const folderId = '00000000-0000-4000-8000-000000000101';
  const overviewId = '00000000-0000-4000-8000-000000000102';
  const sourceId = '00000000-0000-4000-8000-000000000103';
  let scans = 0;
  let reads = 0;
  const documentContext = await createDocumentAgentContext({
    library: {
      async listCached() {
        return {
          references: [{ id: folderId, kind: 'folder', name: 'project', fileCount: 1 }],
        };
      },
      async folderContext() {
        scans += 1;
        return [{
          folderId,
          name: 'project',
          fileCount: 1,
          inventory: ['F README.md'],
          omittedCount: 0,
          instructions: [],
        }];
      },
      async search() {
        return [{
          documentId: overviewId,
          name: 'README.md',
          page: null,
          excerpt: 'The project starts in app.ts.',
        }];
      },
      async readFolderFile() {
        reads += 1;
        return {
          documentId: sourceId,
          path: 'app.ts',
          offset: 0,
          nextOffset: null,
          totalLines: 1,
          text: 'export const app = true;',
          truncated: false,
        };
      },
    },
    session: { id: 'session-one', selectedDocumentIds: [folderId] },
    task: 'Inspect and read the project.',
    maxContextCharacters: 32_768,
  });
  const events: string[] = [];
  const result = await createAgentHarness({
    model: {
      async respond({ context }) {
        if (context.step_number === 1) {
          return {
            done: false,
            tool_calls: [
              { name: 'inspect_folder', arguments: { folderId } },
              { name: 'read_file', arguments: { folderId, path: 'app.ts' } },
            ],
          };
        }
        return { done: true, final_answer: 'The folder and file were inspected.' };
      },
    },
    tools: documentContext.tools,
    on_tool_event: ({ tool_name, status }) => events.push(`${tool_name}:${status}`),
  }).run('Inspect and read the project.', {
    supplemental_context: documentContext.supplemental_context,
  });

  assert.equal(result.success, true);
  assert.equal(scans, 1);
  assert.equal(reads, 1);
  assert.deepEqual(result.trace.steps[0]?.tool_calls?.map(({ name }) => name), [
    'inspect_folder',
    'read_file',
  ]);
  assert.deepEqual(result.trace.steps[0]?.observation?.map(({ status }) => status), [
    'success',
    'success',
  ]);
  assert.deepEqual(events, [
    'inspect_folder:pending',
    'read_file:pending',
    'inspect_folder:running',
    'inspect_folder:success',
    'read_file:running',
    'read_file:success',
  ]);
  assert.deepEqual(documentContext.resultData().contextUsage.map(({ method }) => method), [
    'folder-overview',
    'folder-read',
  ]);
});

test('allow-list rejection happens before any tool executes', async () => {
  let executed = false;
  const eventStatuses: string[] = [];
  const tool: AgentTool = {
    name: 'delete_data',
    description: 'Delete data.',
    async execute() {
      executed = true;
      return { deleted: true };
    },
  };
  const result = await createAgentHarness({
    model: scriptedModel([{
      done: false,
      tool_calls: [{ name: 'delete_data', arguments: {} }],
    }]),
    tools: [tool],
    allowed_tools: [],
    on_tool_event: ({ status }) => eventStatuses.push(status),
  }).run('Delete the data.');

  assert.equal(executed, false);
  assert.equal(result.success, false);
  assert.equal(result.stop_reason, 'guardrail_violation');
  assert.equal(result.trace.steps[0]?.status, 'rejected');
  assert.equal(result.trace.steps[0]?.guardrail_decisions[0]?.rule, 'tool_allow_list');
  assert.deepEqual(eventStatuses, ['pending', 'rejected']);
});

test('ask-tier tools stop for human input unless the permission handler allows execution', async () => {
  let executed = 0;
  const waitingEvents: string[] = [];
  const tool: AgentTool = {
    name: 'send_message',
    description: 'Send a message.',
    permission: 'ask',
    async execute() {
      executed += 1;
      return { sent: true };
    },
  };
  const response = {
    done: false,
    tool_calls: [{ name: 'send_message', arguments: { text: 'Hello' } }],
  };

  const waiting = await createAgentHarness({
    model: scriptedModel([response]),
    tools: [tool],
    on_tool_event: ({ status }) => waitingEvents.push(status),
  }).run('Send a message.');
  assert.equal(waiting.stop_reason, 'needs_human');
  assert.equal(waiting.trace.steps[0]?.status, 'needs_human');
  assert.equal(executed, 0);
  assert.deepEqual(waitingEvents, ['pending', 'needs_human']);

  const approved = await createAgentHarness({
    model: scriptedModel([response, { done: true, final_answer: 'Message sent.' }]),
    tools: [tool],
    request_permission: async () => 'allow',
  }).run('Send a message.');
  assert.equal(approved.success, true);
  assert.equal(executed, 1);
  assert.ok(approved.trace.steps[0]?.guardrail_decisions.some(({ decision }) => decision === 'allowed'));
});

test('required failed verification is traced and hard-stops the run', async () => {
  const result = await createAgentHarness({
    model: scriptedModel([{
      done: false,
      tool_calls: [{ name: 'write_config', arguments: { value: 'new' } }],
    }, { done: true, final_answer: 'Config updated.' }]),
    tools: [{
      name: 'write_config',
      description: 'Write config.',
      async execute() {
        return { written: true };
      },
      verify: () => ({ passed: false, details: 'The persisted value did not change.' }),
    }],
    require_verification: true,
  }).run('Update the config.');

  assert.equal(result.stop_reason, 'verification_failed');
  assert.equal(result.success, false);
  assert.equal(result.trace.steps[0]?.status, 'failed');
  assert.equal(result.trace.steps[0]?.verification[0]?.status, 'failed');
  assert.equal(result.metrics.steps_taken, 1);
});

test('required verification rejects tools without a deterministic verifier', async () => {
  const result = await createAgentHarness({
    model: scriptedModel([{
      done: false,
      tool_calls: [{ name: 'update_state', arguments: {} }],
    }]),
    tools: [{
      name: 'update_state',
      description: 'Update state.',
      async execute() {
        return { updated: true };
      },
    }],
    require_verification: true,
  }).run('Update state.');

  assert.equal(result.stop_reason, 'verification_failed');
  assert.match(result.trace.steps[0]?.verification[0]?.details ?? '', /No deterministic verifier/u);
});

test('max_steps is a hard bound and its stop decision is recorded', async () => {
  let calls = 0;
  const result = await createAgentHarness({
    model: scriptedModel([
      { done: false, tool_calls: [{ name: 'tick', arguments: {} }] },
      { done: false, tool_calls: [{ name: 'tick', arguments: {} }] },
      { done: true, final_answer: 'Should not run.' },
    ], () => calls++),
    tools: [{
      name: 'tick',
      description: 'Record a tick.',
      async execute() {
        return { ticked: true };
      },
    }],
    max_steps: 2,
  }).run('Keep ticking.');

  assert.equal(calls, 2);
  assert.equal(result.trace.steps.length, 2);
  assert.equal(result.stop_reason, 'max_steps');
  assert.ok(result.trace.steps[1]?.guardrail_decisions.some(({ rule }) => rule === 'max_steps'));
});

test('force-stop signals produce a structured stop record', async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await createAgentHarness({
    model: scriptedModel([{ done: true, final_answer: 'Should not run.' }]),
    signal: controller.signal,
  }).run('Stop immediately.');

  assert.equal(result.stop_reason, 'force_stop');
  assert.equal(result.trace.steps.length, 1);
  assert.equal(result.trace.steps[0]?.guardrail_decisions[0]?.rule, 'force_stop');
});

test('an in-flight model request cancelled by the caller stops as force_stop', async () => {
  const controller = new AbortController();
  const result = await createAgentHarness({
    model: {
      async respond(_input, { signal }) {
        controller.abort();
        assert.equal(signal, controller.signal);
        throw new DOMException('The operation was aborted.', 'AbortError');
      },
    },
    signal: controller.signal,
  }).run('Cancel during generation.');

  assert.equal(result.stop_reason, 'force_stop');
  assert.equal(result.trace.steps.length, 1);
  assert.equal(result.trace.steps[0]?.guardrail_decisions[0]?.rule, 'force_stop');
});

test('step progress is published before the model begins its response', async () => {
  const progress: Array<{ step_number: number; phase: string }> = [];
  let observedProgressBeforeResponse = false;
  const result = await createAgentHarness({
    model: {
      async respond() {
        observedProgressBeforeResponse = progress.length === 1;
        return { done: true, final_answer: 'Finished.' };
      },
    },
    on_progress(event) {
      progress.push({ step_number: event.step_number, phase: event.phase });
    },
  }).run('Answer this task.');

  assert.equal(result.success, true);
  assert.equal(observedProgressBeforeResponse, true);
  assert.deepEqual(progress, [{ step_number: 1, phase: 'thinking' }]);
});

test('cancelling a tool that does not honor its signal stops the harness promptly', async () => {
  const controller = new AbortController();
  let signalToolStarted;
  const toolStarted = new Promise<void>((resolve) => {
    signalToolStarted = resolve;
  });
  let modelCalls = 0;
  const resultPromise = createAgentHarness({
    model: scriptedModel([
      { done: false, tool_calls: [{ name: 'slow_read', arguments: {} }] },
      { done: true, final_answer: 'Should not run.' },
    ], () => modelCalls++),
    tools: [{
      name: 'slow_read',
      description: 'A read that never resolves.',
      async execute() {
        signalToolStarted();
        return new Promise(() => {});
      },
    }],
    signal: controller.signal,
  }).run('Read slowly.');

  await toolStarted;
  controller.abort();
  const result = await resultPromise;

  assert.equal(result.stop_reason, 'force_stop');
  assert.equal(result.success, false);
  assert.equal(modelCalls, 1);
  assert.equal(result.trace.steps[0]?.status, 'rejected');
  assert.equal(result.trace.steps[0]?.observation?.[0]?.status, 'not_executed');
  assert.equal(result.trace.steps[0]?.guardrail_decisions.at(-1)?.rule, 'force_stop');
});

test('verification and step-observer failures remain visible without duplicating trace entries', async () => {
  const verifierFailure = await createAgentHarness({
    model: scriptedModel([{
      done: false,
      tool_calls: [{ name: 'save_state', arguments: {} }],
    }]),
    tools: [{
      name: 'save_state',
      description: 'Save state.',
      async execute() {
        return { saved: true };
      },
      verify() {
        throw new Error('State backend is unavailable for verification.');
      },
    }],
    require_verification: true,
  }).run('Save the state.');

  assert.equal(verifierFailure.stop_reason, 'verification_failed');
  assert.equal(verifierFailure.trace.steps[0]?.observation?.[0]?.status, 'success');
  assert.match(verifierFailure.trace.steps[0]?.verification[0]?.details ?? '', /Verifier failed/u);

  const observerFailure = await createAgentHarness({
    model: scriptedModel([{ done: true, final_answer: 'Complete.' }]),
    on_step() {
      throw new Error('Trace sink is unavailable.');
    },
  }).run('Complete this task.');

  assert.equal(observerFailure.stop_reason, 'model_error');
  assert.equal(observerFailure.trace.steps.length, 1);
  assert.equal(observerFailure.trace.steps[0]?.status, 'failed');
  assert.match(observerFailure.trace.steps[0]?.error ?? '', /Trace sink is unavailable/u);
});

test('older steps are summarized and recent structured context is retained', async () => {
  const contexts: Array<{ summary: string; recent_steps: number[] }> = [];
  const responses = [
    ...Array.from({ length: 5 }, () => ({
      done: false,
      tool_calls: [{ name: 'tick', arguments: {} }],
    })),
    { done: true, final_answer: 'All five operations completed.' },
  ];
  const result = await createAgentHarness({
    model: {
      async respond({ context }) {
        contexts.push({
          summary: context.summary,
          recent_steps: context.recent_steps.map(({ step_number }) => step_number),
        });
        const response = responses.shift();
        if (!response) throw new Error('No scripted response remains.');
        return response;
      },
    },
    tools: [{
      name: 'tick',
      description: 'Record a tick.',
      async execute(_args, context) {
        return { completed_step: context.step_number };
      },
    }],
    recent_steps_to_keep: 2,
    max_steps: 6,
    max_context_characters: 2_000,
    summarize: (steps, previous) => [
      previous,
      ...steps.map((step) => `completed ${step.step_number}`),
    ].filter(Boolean).join('; '),
  }).run('Complete five operations and report the result.');

  assert.equal(result.success, true);
  assert.ok(contexts[5]?.summary.includes('completed 1'));
  assert.deepEqual(contexts[5]?.recent_steps, [4, 5]);
  assert.ok(result.trace.steps[3]?.context_compaction);
});

test('a large last observation is reduced to stay within the configured context budget', async () => {
  let nextTurnContext = '';
  const result = await createAgentHarness({
    model: {
      async respond({ context }) {
        if (context.step_number === 1) {
          return {
            done: false,
            tool_calls: [{ name: 'read_large_value', arguments: {} }],
          };
        }
        nextTurnContext = JSON.stringify(context);
        return { done: true, final_answer: 'The value was read.' };
      },
    },
    tools: [{
      name: 'read_large_value',
      description: 'Read a bounded large value.',
      async execute() {
        return 'x'.repeat(7_000);
      },
    }],
    max_context_characters: 1_024,
    max_observation_characters: 7_500,
  }).run('Read the value.');

  assert.equal(result.success, true);
  assert.ok(nextTurnContext.length <= 1_024);
  assert.match(result.trace.steps[1]?.context_compaction ?? '', /Reduced the latest/u);
});

test('bounded file-read observations remain available to the next model turn', async () => {
  let nextObservation = '';
  const result = await createAgentHarness({
    model: {
      async respond({ context }) {
        if (context.step_number === 1) {
          return {
            done: false,
            tool_calls: [{ name: 'read_file', arguments: {} }],
          };
        }
        nextObservation = JSON.stringify(context.recent_steps[0]?.observation);
        return { done: true, final_answer: 'The file was reviewed.' };
      },
    },
    tools: [{
      name: 'read_file',
      description: 'Read a bounded file excerpt.',
      async execute() {
        return { path: 'src/application.ts', excerpt: 'x'.repeat(3_500) };
      },
    }],
    max_context_characters: 12_000,
    max_observation_characters: 7_500,
  }).run('Review the file.');

  assert.equal(result.success, true);
  assert.ok(nextObservation.length > 3_500);
  assert.match(nextObservation, /application\.ts/u);
});

test('tool errors stop runs while rejected inputs can be corrected on a later step', async () => {
  const failedTool = await createAgentHarness({
    model: scriptedModel([{
      done: false,
      tool_calls: [{ name: 'read_state', arguments: {} }],
    }]),
    tools: [{
      name: 'read_state',
      description: 'Read state.',
      async execute() {
        throw new Error('Disk is unavailable.');
      },
    }],
  }).run('Read state.');
  assert.equal(failedTool.stop_reason, 'tool_error');
  assert.equal(failedTool.trace.steps[0]?.observation?.[0]?.status, 'failed');

  let rejectedInputContext = '';
  let executed = false;
  const rejectedInput = await createAgentHarness({
    model: {
      async respond({ context }) {
        if (context.step_number === 1) {
          return {
            done: false,
            tool_calls: [{ name: 'read_state', arguments: { documentId: 'doc-1', query: 'agent loop' } }],
          };
        }
        if (context.step_number === 2) {
          rejectedInputContext = JSON.stringify(context.recent_steps);
          return {
            done: false,
            tool_calls: [{ name: 'read_state', arguments: { path: 'safe.txt' } }],
          };
        }
        return { done: true, final_answer: 'The file was reviewed.' };
      },
    },
    tools: [{
      name: 'read_state',
      description: 'Read state.',
      validate_input: (args) => {
        if (!args || typeof args !== 'object' || Array.isArray(args)) return 'Arguments must be an object.';
        const unsupportedFields = Object.keys(args).filter((field) => field !== 'path');
        if (unsupportedFields.length > 0) {
          return `Arguments must be an object with only supported fields. Unsupported fields: ${unsupportedFields.join(', ')}.`;
        }
        return args.path === 'safe.txt' ? null : 'Path must stay inside the workspace.';
      },
      async execute(args) {
        executed = true;
        assert.deepEqual(args, { path: 'safe.txt' });
        return { path: 'safe.txt' };
      },
    }],
  }).run('Read state.');
  assert.equal(rejectedInput.stop_reason, 'task_complete');
  assert.equal(rejectedInput.success, true);
  assert.equal(rejectedInput.trace.steps[0]?.status, 'rejected');
  assert.equal(rejectedInput.trace.steps[0]?.observation?.[0]?.status, 'failed');
  assert.match(JSON.stringify(rejectedInput.trace.steps[0]?.tool_calls), /documentId/u);
  assert.equal(rejectedInput.trace.steps[1]?.status, 'success');
  assert.equal(executed, true);
  assert.match(rejectedInputContext, /Unsupported fields: documentId, query/u);
});
