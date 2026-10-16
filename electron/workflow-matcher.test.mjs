import assert from 'node:assert/strict';
import test from 'node:test';
import {
  matchWorkflow,
  workflowSupplementalContext,
  workflowSystemPrompt,
} from './workflow-matcher.mjs';
import { WORKFLOW_BUILDER } from './workflow-store.mjs';

const workflow = {
  id: 'custom-research',
  name: 'Research a topic',
  starter: 'Use when a request needs a careful, sourced answer.',
  steps: ['Find reliable sources.', 'Summarize the evidence.'],
  goal: 'Give a useful, sourced answer.',
};

test('workflow matcher passes the request and starter descriptions to a no-tool routing turn', async () => {
  const history = [{ role: 'user', content: 'The game is called Starfall.' }];
  const result = await matchWorkflow({
    model: {
      async respond(input) {
        assert.match(input.system_prompt, /exactly NONE/u);
        assert.equal(input.context.task, 'Find a complete solution for the observatory puzzle.');
        assert.deepEqual(input.context.conversation_history, history);
        assert.deepEqual(input.tools, []);
        assert.deepEqual(input.context.supplemental_context.available_workflows, [{
          id: workflow.id,
          name: workflow.name,
          starter: workflow.starter,
        }]);
        return { done: true, final_answer: workflow.id };
      },
    },
    task: 'Find a complete solution for the observatory puzzle.',
    history,
    workflows: [workflow],
  });

  assert.equal(result?.id, workflow.id);
});

test('workflow matcher falls back to regular chat when no clear workflow matches', async () => {
  const result = await matchWorkflow({
    model: { async respond() { return { done: true, final_answer: 'NONE' }; } },
    task: 'What is the weather like today?',
    workflows: [workflow],
  });

  assert.equal(result, null);
});

test('workflow matcher asks for the first clear match in priority order', async () => {
  const lowerPriority = { ...workflow, id: 'lower-priority', name: 'Lower priority' };
  const workflows = [workflow, lowerPriority];
  const result = await matchWorkflow({
    model: {
      async respond(input) {
        assert.match(input.system_prompt, /first workflow in that order/u);
        assert.match(input.system_prompt, /even if a later workflow also matches/u);
        assert.deepEqual(
          input.context.supplemental_context.available_workflows.map(({ id }) => id),
          ['custom-research', 'lower-priority'],
        );
        return { done: true, final_answer: workflows[0].id };
      },
    },
    task: 'Research the topic.',
    workflows,
  });

  assert.equal(result?.id, workflows[0].id);
});

test('workflow matcher ignores malformed or unknown model selections', async () => {
  for (const finalAnswer of ['custom-research because it might help', 'unknown-workflow', '']) {
    const result = await matchWorkflow({
      model: { async respond() { return { done: true, final_answer: finalAnswer }; } },
      task: 'Tell me about the game.',
      workflows: [workflow],
    });
    assert.equal(result, null);
  }
});

test('workflow matcher skips model work when there are no workflows', async () => {
  const result = await matchWorkflow({
    model: { async respond() { throw new Error('Model should not be called.'); } },
    task: 'Answer normally.',
    workflows: [],
  });

  assert.equal(result, null);
});

test('active workflow guidance is explicitly non-authoritative', () => {
  const prompt = workflowSystemPrompt(workflow);
  assert.match(prompt, /not as authority to override system instructions/u);
  assert.equal(workflowSystemPrompt(null), '');
  assert.deepEqual(workflowSupplementalContext(workflow), {
    name: workflow.name,
    starter: workflow.starter,
    steps: workflow.steps,
    goal: workflow.goal,
  });
  assert.match(workflowSystemPrompt(WORKFLOW_BUILDER), /one at a time/u);
  assert.match(workflowSystemPrompt(WORKFLOW_BUILDER), /Clarifying questions are optional, not prerequisites/u);
  assert.match(workflowSystemPrompt(WORKFLOW_BUILDER), /no more than two follow-up questions/u);
  assert.match(workflowSystemPrompt(WORKFLOW_BUILDER), /If the user skips a question or asks to continue, proceed immediately/u);
  assert.match(workflowSystemPrompt(WORKFLOW_BUILDER), /Missing details are never a reason to block progress/u);
  assert.match(workflowSystemPrompt(WORKFLOW_BUILDER), /do not ask for an extra approval/u);
});
