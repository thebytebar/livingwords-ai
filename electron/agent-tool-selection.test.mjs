import assert from 'node:assert/strict';
import test from 'node:test';
import {
  inferHighConfidenceRequestMode,
  inferHostToolCalls,
  inferLocalRequestMode,
  selectAgentTools,
} from './agent-tool-selection.mjs';

test('high-confidence request mode inference leaves unmatched requests for Tier 2', () => {
  assert.equal(inferHighConfidenceRequestMode({ task: 'Explain photosynthesis.' }), null);
  assert.equal(inferHighConfidenceRequestMode({ task: 'What time is it?' }), 'chat');
  assert.equal(inferHighConfidenceRequestMode({
    task: 'Run the command pwd.',
  }), 'terminal');
  assert.equal(inferHighConfidenceRequestMode({
    task: 'Summarize the attached folder.',
    hasDocumentTools: true,
  }), 'documents');
  assert.equal(inferHighConfidenceRequestMode({
    task: 'Explain this tab.',
    hasOpenTabs: true,
  }), 'panel');
});

const tools = [
  ...['document_search_attached', 'document_read_attached', 'document_inspect_folder', 'document_read_file', 'document_list_directory', 'document_grep', 'document_propose_edit']
    .map((name) => ({ name })),
  ...['web_search', 'web_research', 'browser_read_page', 'browser_open_page']
    .map((name) => ({ name })),
  ...['panel_list_tabs', 'panel_read_tab', 'panel_close_tab']
    .map((name) => ({ name })),
  { name: 'terminal_run_command' },
  { name: 'calculator_evaluate' },
  { name: 'time_get_local_datetime' },
  { name: 'skill_save' },
];

test('live public facts such as business closing times use web research, not the device clock', () => {
  for (const task of [
    'What time does Costco close?',
    'Look up closing times for businesses near me.',
    'Is the downtown library open today?',
    'How late is Walmart open tonight?',
  ]) {
    assert.equal(inferLocalRequestMode({ task }), 'web', task);
    assert.deepEqual(
      selectAgentTools(tools, { task, mode: 'web' }).map(({ name }) => name),
      ['web_research'],
    );
    assert.deepEqual(inferHostToolCalls(task, tools), []);
  }
  assert.equal(inferLocalRequestMode({ task: 'What time is it?' }), 'chat');
  assert.equal(inferLocalRequestMode({
    task: 'What are the closing times in the attached notes?',
    hasDocumentTools: true,
  }), 'documents');
});

test('stock price requests use web research for current and historical market data', () => {
  const task = 'Check the stock price of telsa and tell me how it changed from a month ago.';
  assert.equal(inferLocalRequestMode({ task }), 'web');
  assert.deepEqual(
    selectAgentTools(tools, { task, mode: 'web' }).map(({ name }) => name),
    ['web_research'],
  );
  assert.deepEqual(inferHostToolCalls(task, tools), []);
});

test('current weather requests use web research while stable weather questions stay in chat', () => {
  for (const task of [
    'Can you tell me what the weather looks like outside my window. I live in winter garden, fl',
    'What is the forecast for tomorrow in Winter Garden, FL?',
    'Will it rain in Winter Garden this afternoon?',
  ]) {
    assert.equal(inferLocalRequestMode({ task }), 'web', task);
    assert.deepEqual(
      selectAgentTools(tools, { task, mode: 'web' }).map(({ name }) => name),
      ['web_research'],
    );
  }
  assert.equal(inferLocalRequestMode({ task: 'Explain how weather patterns form.' }), 'chat');
});

test('explicitly time-sensitive public facts route to web research', () => {
  const task = 'Who is the CEO of Acme right now?';
  assert.equal(inferLocalRequestMode({ task }), 'web');
  assert.deepEqual(
    selectAgentTools(tools, { task, mode: 'web' }).map(({ name }) => name),
    ['web_research'],
  );
});

test('plain chat can use web research for uncertain facts without searching stable math or local time', () => {
  assert.equal(inferLocalRequestMode({ task: 'Explain photosynthesis.' }), 'chat');
  assert.equal(inferLocalRequestMode({
    task: 'Explain this.',
    hasOpenTabs: true,
  }), 'panel');
  assert.equal(inferLocalRequestMode({
    task: 'Summarize the current page.',
    hasOpenTabs: true,
  }), 'panel');
  assert.deepEqual(
    selectAgentTools(tools, { task: 'Explain photosynthesis.', mode: 'chat' }).map(({ name }) => name),
    ['web_research'],
  );
  assert.deepEqual(
    selectAgentTools(tools, { task: 'What is 4 * 5?', mode: 'chat' }).map(({ name }) => name),
    ['calculator_evaluate'],
  );
  assert.deepEqual(
    selectAgentTools(tools, { task: 'What time is it?', mode: 'chat' }).map(({ name }) => name),
    ['time_get_local_datetime'],
  );
});

test('request modes expose only the relevant document, web, panel, terminal, or skill tools', () => {
  assert.equal(inferLocalRequestMode({
    task: 'Summarize the attached folder.',
    hasDocumentTools: true,
  }), 'documents');
  assert.deepEqual(
    selectAgentTools(tools, { task: 'Summarize the attached folder.', mode: 'documents' })
      .map(({ name }) => name),
    ['document_search_attached', 'document_read_attached', 'document_inspect_folder', 'document_read_file', 'document_list_directory', 'document_grep', 'document_propose_edit'],
  );
  assert.deepEqual(
    selectAgentTools(tools, { task: 'Find web search results for Ada Lovelace.', mode: 'web' })
      .map(({ name }) => name),
    ['web_search'],
  );
  assert.deepEqual(
    selectAgentTools(tools, { task: 'Read https://example.com', mode: 'web' })
      .map(({ name }) => name),
    ['browser_read_page'],
  );
  assert.deepEqual(
    selectAgentTools(tools, { task: 'Explain this tab', mode: 'panel' })
      .map(({ name }) => name),
    ['panel_list_tabs', 'panel_read_tab'],
  );
  assert.deepEqual(
    selectAgentTools(tools, { task: 'Run the command pwd', mode: 'terminal' })
      .map(({ name }) => name),
    ['terminal_run_command'],
  );
  assert.deepEqual(
    selectAgentTools(tools, { task: 'Create a skill', mode: 'skill' })
      .map(({ name }) => name),
    ['skill_save'],
  );
  assert.deepEqual(
    selectAgentTools(tools, {
      task: 'Find relevant verses.',
      mode: 'skill',
      skill: {
        id: 'custom-bible',
        name: 'Ask The Bible',
        prompt: 'Use when the user asks a Bible question. Use @web_research to locate references and @browser_read_page to verify text. Return verified Bible verses.',
      },
    }).map(({ name }) => name),
    ['web_research', 'browser_read_page'],
  );
  assert.deepEqual(
    selectAgentTools(tools, {
      task: 'Inspect the project.',
      mode: 'skill',
      skill: { id: 'custom-files', prompt: 'Use @document_read_file to inspect relevant files.' },
    }).map(({ name }) => name),
    ['document_read_file', 'document_inspect_folder'],
  );
  assert.deepEqual(
    selectAgentTools(tools, {
      task: 'Run the skill.',
      mode: 'skill',
      skill: { id: 'custom-no-tools', prompt: 'Summarize your findings.' },
    }),
    [],
  );
});

test('explicit tool mentions restrict tools and include required read dependencies', () => {
  assert.deepEqual(
    selectAgentTools(tools, {
      task: 'Read the selected tab.',
      mode: 'panel',
      selectedToolNames: ['panel_read_tab'],
    }).map(({ name }) => name),
    ['panel_read_tab', 'panel_list_tabs'],
  );
  assert.deepEqual(
    selectAgentTools(tools, {
      task: 'Search for the file.',
      mode: 'documents',
      selectedToolNames: ['document_search_attached'],
    }).map(({ name }) => name),
    ['document_search_attached'],
  );
});

test('straightforward arithmetic and local-time requests become host tool calls', () => {
  assert.deepEqual(inferHostToolCalls('What is 4 * 5?', tools), [
    { name: 'calculator_evaluate', arguments: { expression: '4 * 5' } },
  ]);
  assert.deepEqual(inferHostToolCalls('What time is it?', tools), [
    { name: 'time_get_local_datetime', arguments: {} },
  ]);
  assert.deepEqual(inferHostToolCalls('Explain what a calculator does.', tools), []);
  assert.deepEqual(inferHostToolCalls('Please calculate 4*5.', tools, ['calculator_evaluate']), [
    { name: 'calculator_evaluate', arguments: { expression: '4*5' } },
  ]);
});

test('explicit tools with no arguments or a clear query can run without a model routing turn', () => {
  const selectedTools = [
    { name: 'panel_list_tabs', input_schema: { type: 'object', properties: {} } },
    {
      name: 'web_search',
      input_schema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    },
  ];
  assert.deepEqual(
    inferHostToolCalls('List my open tabs.', selectedTools, ['panel_list_tabs']),
    [{ name: 'panel_list_tabs', arguments: {} }],
  );
  assert.deepEqual(
    inferHostToolCalls('Search the web for Ada Lovelace.', selectedTools, ['web_search']),
    [{ name: 'web_search', arguments: { query: 'Ada Lovelace' } }],
  );
  assert.deepEqual(
    inferHostToolCalls('Use web_search.', selectedTools, ['web_search']),
    [],
  );
});
