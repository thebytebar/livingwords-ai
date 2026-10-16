import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canCloseInfoTab,
  formatDuration,
  formatTraceTime,
  isAgentTrace,
  latestAgentTrace,
  mergeAgentTraces,
  traceActivityDescription,
  traceLiveDecisionActivity,
  traceRunStatus,
  traceStepActivities,
  traceStepTitle,
  traceToolEntries,
  traceToolStatusLabel,
  traceToolActivity,
  traceToolDescription,
  traceDurationMs,
  traceToolTitle,
  updateTraceTab,
  workflowSelectionActivity,
} from './agent-trace.mjs';

const first = { schema_version: 1, run_id: 'first', steps: [] };
const latest = { schema_version: 1, run_id: 'latest', steps: [] };

test('latest persisted assistant trace is selected and malformed traces are ignored', () => {
  assert.equal(isAgentTrace(first), true);
  assert.equal(isAgentTrace({ ...latest, steps: {} }), false);
  assert.equal(latestAgentTrace([
    { role: 'assistant', trace: first },
    { role: 'user', trace: latest },
    { role: 'assistant', trace: { schema_version: 2 } },
    { role: 'assistant', trace: latest },
  ]), latest);
  assert.equal(latestAgentTrace([{ role: 'user', trace: latest }]), null);
});

test('Activity is permanent and Files can close only when no files are attached', () => {
  assert.equal(canCloseInfoTab({ kind: 'trace' }), false);
  assert.equal(canCloseInfoTab({ kind: 'documents' }), true);
  assert.equal(canCloseInfoTab({ kind: 'documents' }, true), false);
  assert.equal(canCloseInfoTab({ kind: 'terminal' }), true);
});

test('a selected workflow is rendered as a completed Activity entry', () => {
  assert.deepEqual(workflowSelectionActivity('Build a workflow'), {
    title: 'Workflow selected: Build a workflow',
    completed: true,
  });
});

test('live trace snapshots retain earlier steps from the same run', () => {
  const firstStep = { step_number: 1, status: 'success' };
  const secondStep = { step_number: 2, status: 'success' };
  const partial = { ...first, steps: [firstStep] };
  const next = { ...first, steps: [secondStep] };
  const merged = mergeAgentTraces(partial, next);

  assert.deepEqual(merged.steps, [firstStep, secondStep]);
  assert.deepEqual(mergeAgentTraces(merged, { ...first, steps: [] }).steps, [firstStep, secondStep]);
  assert.equal(mergeAgentTraces(merged, latest).run_id, 'latest');
});

test('elapsed durations use concise, human-readable units', () => {
  assert.equal(formatDuration(0), '0 sec');
  assert.equal(formatDuration(12_000), '12 sec');
  assert.equal(formatDuration(743_000), '12 min 23 sec');
  assert.equal(formatDuration(5_520_000), '1 hr 32 min');
  assert.equal(formatDuration(-1), '0 sec');
});

test('response durations are derived from valid trace timestamps', () => {
  assert.equal(traceDurationMs({
    ...first,
    started_at: '2026-10-15T12:00:00.000Z',
    completed_at: '2026-10-15T12:00:04.250Z',
  }), 4_250);
  assert.equal(traceDurationMs({
    ...first,
    started_at: 'not-a-date',
    completed_at: '2026-10-15T12:00:04.250Z',
  }), null);
  assert.equal(traceDurationMs({
    ...first,
    started_at: '2026-10-15T12:00:04.250Z',
    completed_at: '2026-10-15T12:00:00.000Z',
  }), null);
});

test('trace timestamps are displayed as local clock times', () => {
  assert.match(formatTraceTime('2026-01-01T12:34:56.000Z'), /^\d{1,2}:\d{2}:\d{2}\s?(AM|PM)?$/iu);
  assert.equal(formatTraceTime('not-a-date'), '');
});

test('trace activity has plain-language titles, outcomes, and run statuses', () => {
  assert.equal(traceToolTitle({
    name: 'read_file',
    arguments: { path: 'src/app.ts' },
  }), 'Read project file');
  assert.equal(traceToolTitle({
    name: 'inspect_folder',
    result: { folder: 'Garden map' },
  }), 'Inspect attached folder');
  assert.equal(traceToolTitle({
    name: 'open_web_page',
    arguments: { url: 'https://example.com/guide' },
    result: { title: 'Example guide' },
  }), 'Open web page');
  assert.equal(traceToolStatusLabel('running'), 'Working…');
  assert.equal(traceToolStatusLabel('not_executed'), 'Skipped');
  assert.equal(traceToolDescription({
    name: 'read_file',
    status: 'success',
    result: { path: 'src/app.ts', startLine: 1, endLine: 18, truncated: true },
  }), 'Read src/app.ts. More of the file is available.');
  assert.equal(traceToolDescription({
    name: 'inspect_folder',
    status: 'success',
    result: { fileCount: 12, passages: [{}, {}] },
  }), 'Reviewed 12 files and found 2 useful passages.');
  assert.equal(traceToolDescription({
    name: 'inspect_folder',
    status: 'success',
    result: { fileCount: 1, passages: [{}] },
  }), 'Reviewed 1 file and found 1 useful passage.');
  assert.equal(traceStepTitle({
    status: 'success',
    tool_calls: [{ name: 'read_file', arguments: { path: 'src/app.ts' } }],
    observation: [{ name: 'read_file', status: 'success' }],
  }), 'Decision');
  assert.equal(traceRunStatus({ recording: true, liveToolStep: { calls: [] } }), 'Working with your information');
  assert.equal(traceRunStatus({
    recording: true,
    progress: { phase: 'thinking' },
  }), 'Considering the next step');
  assert.equal(traceRunStatus({
    recording: true,
    progress: { phase: 'using_tool', tool_name: 'read_file' },
  }), 'Reading your files');
  assert.equal(traceRunStatus({
    recording: false,
    trace: { ...latest, steps: [{ status: 'complete' }] },
  }), 'Finished');
});

test('Activity shows a plain-text Decision and descriptions for each action', () => {
  const activities = traceStepActivities({
    thought: 'I should search, then open the guide.',
    status: 'success',
    tool_calls: [
      { name: 'search_web', arguments: { query: 'best route in the game' } },
      { name: 'open_web_page', arguments: { url: 'https://www.example.com/guide' } },
      { name: 'read_web_page', arguments: {} },
    ],
    observation: [
      {
        name: 'search_web',
        status: 'success',
        result: { provider: 'duckduckgo', results: [{ title: 'A complete guide', url: 'https://example.com/guide' }] },
      },
      { name: 'open_web_page', status: 'success', result: { title: 'A complete guide', url: 'https://example.com/guide' } },
      { name: 'read_web_page', status: 'success', result: { title: 'A complete guide', links: [{}, {}] } },
    ],
  });

  assert.deepEqual(activities.map(({ title }) => title), [
    'Decision',
    'Search web',
    'Open web page',
    'Read web page',
  ]);
  assert.equal(activities.every((activity) => !('statusLabel' in activity)), true);
  assert.equal(activities[0].description, 'I should search, then open the guide.');
  assert.equal(activities[1].description, 'Searched for “best route in the game”.');
  assert.equal(activities[2].description, 'Opened “A complete guide” to check its information.');
  assert.equal(activities[3].description, 'Read “A complete guide”.');
  assert.equal(activities.every((activity) => !('details' in activity) && !('summary' in activity)), true);
  assert.equal(activities[0].completed, true);
});

test('web-page reads describe the page being read', () => {
  const inProgress = traceStepActivities({
    status: 'success',
    tool_calls: [{ name: 'read_web_page', arguments: {} }],
    observation: [{ name: 'read_web_page', status: 'running' }],
  })[1];
  assert.equal(inProgress.title, 'Reading web page...');
  assert.equal(inProgress.completed, false);
  assert.equal('description' in inProgress, false);

  const completed = traceStepActivities({
    status: 'success',
    tool_calls: [{ name: 'read_web_page', arguments: {} }],
    observation: [{
      name: 'read_web_page',
      status: 'success',
      result: {
        title: 'Research article',
        url: 'https://example.com/article',
        text: 'Page contents are omitted from the activity.',
        links: [{ title: 'Related page', url: 'https://example.com/related' }],
      },
    }],
  })[1];
  assert.equal(completed.title, 'Read web page');
  assert.equal(completed.completed, true);
  assert.equal(completed.description, 'Read “Research article”.');
});

test('tool cards use waiting titles until complete, then include activity descriptions', () => {
  const pending = traceToolActivity({ name: 'open_web_page', status: 'pending' });
  assert.equal(pending.title, 'Waiting to open the web page...');
  assert.equal(pending.completed, false);
  assert.equal('description' in pending, false);

  const loading = traceToolActivity({ name: 'open_web_page', status: 'running' });
  assert.equal(loading.title, 'Opening web page...');
  assert.equal(loading.completed, false);

  const approval = traceToolActivity({ name: 'run_terminal_command', status: 'needs_human' });
  assert.equal(approval.title, 'Waiting for approval...');
  assert.equal(approval.completed, false);

  const complete = traceToolActivity({
    name: 'open_web_page',
    status: 'success',
    result: { title: 'Reference guide' },
  });
  assert.equal(complete.title, 'Open web page');
  assert.equal(complete.description, 'Opened “Reference guide” to check its information.');
  assert.equal(complete.completed, true);
});

test('live activity is Thinking without text until a decision is available', () => {
  assert.deepEqual(traceLiveDecisionActivity({ phase: 'thinking' }), {
    title: 'Thinking...',
    completed: false,
  });
  assert.deepEqual(traceLiveDecisionActivity({
    phase: 'using_tool',
    tool_name: 'read_file',
  }), {
    title: 'Decision',
    description: 'The assistant decided to use read project file.',
    completed: true,
  });
  assert.deepEqual(traceLiveDecisionActivity({ phase: 'thinking' }, [{
    name: 'search_web',
    arguments: { query: 'local weather forecast' },
  }]), {
    title: 'Decision',
    description: 'The assistant decided to search the web for “local weather forecast”.',
    completed: true,
  });
});

test('persisted tool lifecycle enriches one activity and supplies its duration', () => {
  const activities = traceStepActivities({
    status: 'success',
    tool_calls: [{ name: 'read_file', arguments: { path: 'src/app.ts' } }],
    observation: [{ name: 'read_file', status: 'success', result: { excerpt: 'source' } }],
    tool_events: [
      {
        step_number: 1,
        call_index: 0,
        tool_name: 'read_file',
        timestamp: '2026-01-01T12:34:55.000Z',
        arguments: { path: 'src/app.ts' },
        status: 'pending',
      },
      {
        step_number: 1,
        call_index: 0,
        tool_name: 'read_file',
        timestamp: '2026-01-01T12:34:56.000Z',
        arguments: null,
        status: 'running',
      },
      {
        step_number: 1,
        call_index: 0,
        tool_name: 'read_file',
        timestamp: '2026-01-01T12:35:01.000Z',
        arguments: null,
        status: 'success',
      },
    ],
  });

  assert.deepEqual(activities.slice(1).map(({ title, description }) => ({ title, description })), [
    {
      title: 'Read project file',
      description: 'Read src/app.ts.',
    },
  ]);
  assert.equal(activities[1].durationMs, 5_000);
});

test('Decision and tool cards expose only plain-text descriptions', () => {
  const step = {
    step_number: 2,
    timestamp: '2026-01-01T12:34:56.000Z',
    status: 'complete',
    latency_ms: 1_250,
    thought: 'Compare the sources before answering.',
    token_usage: { input_tokens: 20, output_tokens: 8, total_tokens: 28 },
    tool_calls: [],
    observation: [],
    guardrail_decisions: [{ rule: 'tool_permission', decision: 'allowed', details: 'Allowed by policy.' }],
    verification: [{ status: 'passed', details: 'The result is valid.', phase: 'run' }],
    final_answer: 'Finished.',
    context_compaction: null,
    error: null,
  };
  const entry = {
    name: 'read_file',
    call_index: 0,
    arguments: { path: 'src/app.ts' },
    status: 'success',
    result: { excerpt: 'source' },
  };
  assert.equal(traceActivityDescription(step), 'Compare the sources before answering.');
  assert.equal(traceToolDescription(entry), 'Read src/app.ts.');
  assert.equal(JSON.stringify(traceActivityDescription(step)).includes('Reasoning'), false);
  assert.equal(JSON.stringify(traceToolDescription({ ...entry, error: 'Do not display.' })).includes('Do not display'), false);
});

test('Activity hides internal checks and context updates', () => {
  const activities = traceStepActivities({
    status: 'complete',
    tool_calls: [{ name: 'run_terminal_command', arguments: { command: 'npm test' } }],
    observation: [{ name: 'run_terminal_command', status: 'success', result: { exitCode: 0 } }],
    guardrail_decisions: [{
      rule: 'tool_permission',
      decision: 'allowed',
      details: 'Human approved this tool call.',
      tool_name: 'run_terminal_command',
    }],
    verification: [{
      status: 'passed',
      details: 'Tests passed.',
      phase: 'tool',
      tool_name: 'run_terminal_command',
    }],
    context_compaction: 'Old context was summarized.',
    final_answer: null,
    error: null,
  });

  assert.deepEqual(activities.map(({ title, description }) => ({
    title,
    description,
  })), [
    {
      title: 'Decision',
      description: 'The assistant decided to run approved terminal command.',
    },
    {
      title: 'Run approved terminal command',
      description: 'The approved command finished.',
    },
  ]);
  assert.equal(activities.every((activity) => !('details' in activity) && !('summary' in activity)), true);
  assert.equal(activities.every((activity) => !('statusLabel' in activity)), true);
  assert.equal(JSON.stringify(activities).includes('Permission check'), false);
  assert.equal(JSON.stringify(activities).includes('verification'), false);
  assert.equal(JSON.stringify(activities).includes('Old context'), false);
});

test('Activity does not report assistant or tool errors', () => {
  const activities = traceStepActivities({
    status: 'failed',
    error: 'Assistant internal failure detail.',
    thought: '',
    tool_calls: [{ name: 'read_file', arguments: { path: 'notes.txt' } }],
    observation: [{
      name: 'read_file',
      status: 'failed',
      error: 'The file contents could not be read.',
    }],
  });

  assert.equal(activities.some(({ title }) => title.includes('error')), false);
  assert.equal(JSON.stringify(activities).includes('internal failure'), false);
  assert.equal(JSON.stringify(activities).includes('could not be read'), false);
  assert.equal(JSON.stringify(activities).includes('could not continue'), false);
  assert.equal(activities[1].description, 'This action could not be completed.');
});

test('final assistant response is not duplicated as an activity record', () => {
  const activities = traceStepActivities({
    status: 'complete',
    final_answer: 'The task is finished.',
    token_usage: { total_tokens: 42 },
    latency_ms: 500,
  });
  assert.deepEqual(activities.map(({ title, description }) => ({ title, description })), [
    {
      title: 'Decision',
      description: 'The assistant considered the request and prepared a response.',
    },
  ]);
  assert.equal(activities.some(({ title }) => title === 'Assistant response'), false);
});

test('live trace updates replace displayed steps and end the recording state', () => {
  const tab = { kind: 'trace', trace: first, recording: false };
  assert.equal(updateTraceTab(tab, { recording: true }), true);
  assert.equal(tab.trace, first);
  assert.equal(tab.recording, true);
  assert.equal(updateTraceTab(tab, { trace: latest, recording: true }), true);
  assert.equal(tab.trace, latest);
  assert.equal(updateTraceTab(tab, { recording: false }), true);
  assert.equal(tab.recording, false);
  assert.equal(updateTraceTab({ kind: 'documents' }, { trace: latest }), false);
});

test('live progress updates are separate from persisted steps and clear when a step is recorded', () => {
  const tab = { kind: 'trace', trace: null, recording: true };
  const progress = {
    step_number: 2,
    started_at: '2026-01-01T00:00:00.000Z',
    phase: 'thinking',
  };
  updateTraceTab(tab, { progress });
  assert.deepEqual(tab.progress, progress);
  assert.equal(tab.trace, null);
  updateTraceTab(tab, {
    trace: { ...latest, steps: [{ step_number: 1, status: 'success' }] },
    recording: true,
  });
  assert.deepEqual(tab.trace.steps, [{ step_number: 1, status: 'success' }]);
  assert.deepEqual(tab.progress, progress);
  updateTraceTab(tab, {
    trace: { ...latest, steps: [{ step_number: 1, status: 'success' }, { step_number: 2, status: 'complete' }] },
    recording: true,
  });
  assert.equal(tab.progress, null);
  updateTraceTab(tab, {
    progress: { ...progress, step_number: 3, phase: 'preparing' },
  });
  assert.equal(tab.progress.step_number, 3);
  updateTraceTab(tab, { recording: false, completedAt: '2026-01-01T00:00:05.000Z' });
  assert.equal(tab.progress, null);
  assert.equal(tab.recordingCompletedAt, '2026-01-01T00:00:05.000Z');
});

test('live tool events upsert by call index and clear on the recorded step or request completion', () => {
  const tab = { kind: 'trace', trace: null, recording: true };
  const event = {
    step_number: 1,
    call_index: 1,
    tool_name: 'read_file',
    timestamp: '2026-01-01T00:00:00.000Z',
    arguments: { path: 'src/app.ts' },
    status: 'running',
  };
  updateTraceTab(tab, { toolEvent: event });
  updateTraceTab(tab, {
    toolEvent: {
      ...event,
      call_index: 0,
      tool_name: 'inspect_folder',
      timestamp: '2026-01-01T00:00:01.000Z',
      arguments: { path: 'src' },
      status: 'success',
      result: { files: 2 },
    },
  });
  updateTraceTab(tab, {
    toolEvent: { ...event, timestamp: '2026-01-01T00:00:02.000Z', status: 'success', result: { content: 'source' } },
  });

  assert.deepEqual(tab.liveToolStep, {
    step_number: 1,
    calls: [
      {
        call_index: 0,
        name: 'inspect_folder',
        arguments: { path: 'src' },
        status: 'success',
        result: { files: 2 },
      },
      {
        call_index: 1,
        name: 'read_file',
        arguments: { path: 'src/app.ts' },
        status: 'success',
        result: { content: 'source' },
      },
    ],
    events: [
      { ...event, status: 'running' },
      {
        step_number: 1,
        call_index: 0,
        tool_name: 'inspect_folder',
        timestamp: '2026-01-01T00:00:01.000Z',
        arguments: { path: 'src' },
        status: 'success',
        result: { files: 2 },
      },
      { ...event, timestamp: '2026-01-01T00:00:02.000Z', status: 'success', result: { content: 'source' } },
    ],
  });

  updateTraceTab(tab, {
    trace: { ...latest, steps: [{ step_number: 1 }] },
    recording: true,
  });
  assert.equal(tab.liveToolStep, null);
  updateTraceTab(tab, { toolEvent: event });
  updateTraceTab(tab, { recording: false });
  assert.equal(tab.liveToolStep, null);
});

test('tool calls pair with ordered observations and retain arguments and outcomes', () => {
  const entries = traceToolEntries({
    status: 'failed',
    tool_calls: [
      { name: 'read_file', arguments: { path: 'src/app.ts' } },
      { name: 'grep', arguments: { pattern: 'TODO' } },
    ],
    observation: [
      { name: 'read_file', status: 'success', result: { excerpt: 'source' } },
      { name: 'grep', status: 'failed', error: 'Pattern rejected.' },
    ],
  });

  assert.deepEqual(entries, [
    {
      name: 'read_file',
      arguments: { path: 'src/app.ts' },
      call_index: 0,
      status: 'success',
      result: { excerpt: 'source' },
    },
    {
      name: 'grep',
      arguments: { pattern: 'TODO' },
      call_index: 1,
      status: 'failed',
      error: 'Pattern rejected.',
    },
  ]);
});

test('duplicate tool names pair with their own observations in order', () => {
  const entries = traceToolEntries({
    status: 'success',
    tool_calls: [
      { name: 'read_file', arguments: { path: 'a.ts' } },
      { name: 'read_file', arguments: { path: 'b.ts' } },
    ],
    observation: [
      { name: 'read_file', status: 'success', result: { path: 'a.ts' } },
      { name: 'read_file', status: 'not_executed', error: 'Stopped before reading.' },
    ],
  });

  assert.deepEqual(entries.map(({ arguments: args, status, result, error }) => ({
    path: args.path,
    status,
    result,
    error,
  })), [
    { path: 'a.ts', status: 'success', result: { path: 'a.ts' }, error: undefined },
    { path: 'b.ts', status: 'not_executed', result: undefined, error: 'Stopped before reading.' },
  ]);
});

test('calls without observations reflect rejected, approval, or not-executed states', () => {
  assert.deepEqual(traceToolEntries({
    status: 'rejected',
    tool_calls: [{ name: 'search', arguments: { query: 'private' } }],
    observation: null,
  }), [{
    name: 'search',
    arguments: { query: 'private' },
    call_index: 0,
    status: 'rejected',
  }]);
  assert.equal(traceToolEntries({
    status: 'needs_human',
    tool_calls: [{ name: 'request_access', arguments: {} }],
  })[0].status, 'needs_human');
  assert.equal(traceToolEntries({
    status: 'success',
    tool_calls: [{ name: 'read_file', arguments: {} }],
  })[0].status, 'not_executed');
});

test('unmatched observations remain visible instead of being paired with the wrong call', () => {
  const entries = traceToolEntries({
    status: 'failed',
    tool_calls: [{ name: 'read_file', arguments: {} }],
    observation: [
      { name: 'grep', status: 'success', result: { matches: 1 } },
    ],
  });

  assert.deepEqual(entries, [
    { name: 'read_file', arguments: {}, call_index: 0, status: 'not_executed' },
    { name: 'grep', arguments: null, status: 'success', result: { matches: 1 }, unmatched: true },
  ]);
});
