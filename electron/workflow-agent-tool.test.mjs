import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkflowSaveTool } from './workflow-agent-tool.mjs';

const draft = {
  name: 'Plan a lesson',
  starter: 'Use when the user asks for help planning a lesson.',
  steps: ['Ask about the audience.', 'Draft the lesson outline.'],
  goal: 'Produce a practical lesson plan.',
};

test('workflow save tool validates a completed draft and saves it through the handler', async () => {
  const signal = new AbortController().signal;
  let savedWorkflow;
  const tool = createWorkflowSaveTool({
    async saveWorkflow(value) {
      savedWorkflow = value;
      return { saved: { id: 'custom-test', ...value.workflow } };
    },
  });

  assert.equal(tool.name, 'save_workflow');
  assert.equal(tool.permission, 'allow');
  assert.equal(tool.validate_input(draft), null);
  assert.deepEqual(await tool.execute(draft, { signal }), {
    saved: { id: 'custom-test', ...draft },
  });
  assert.deepEqual(savedWorkflow, { workflow: draft, signal });
});

test('workflow save tool does not save invalid drafts', async () => {
  let requestCount = 0;
  const tool = createWorkflowSaveTool({
    async saveWorkflow() {
      requestCount += 1;
    },
  });
  const invalid = { ...draft, steps: [] };

  assert.match(tool.validate_input(invalid), /1–12 steps/u);
  assert.throws(() => tool.execute(invalid, { signal: new AbortController().signal }), /1–12 steps/u);
  assert.equal(requestCount, 0);
});
