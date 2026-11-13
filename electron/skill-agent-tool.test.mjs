import assert from 'node:assert/strict';
import test from 'node:test';
import { createSkillSaveTool } from './skill-agent-tool.mjs';

const draft = {
  name: 'Plan a lesson',
  description: 'Creates a practical, audience-appropriate lesson plan.',
  prompt: 'Use when the user asks for help planning a lesson. Ask about the audience, draft the lesson outline, and produce a practical lesson plan.',
};

test('skill save tool validates a completed draft and saves it through the handler', async () => {
  const signal = new AbortController().signal;
  let savedSkill;
  const tool = createSkillSaveTool({
    async saveSkill(value) {
      savedSkill = value;
      return { saved: { id: 'custom-test', ...value.skill } };
    },
  });

  assert.equal(tool.name, 'skill_save');
  assert.equal(tool.permission, 'allow');
  assert.equal(tool.final_answer_on_success, 'Skill saved. You can review it in Skills.');
  assert.equal(tool.validate_input(draft), null);
  assert.deepEqual(await tool.execute(draft, { signal }), {
    saved: { id: 'custom-test', ...draft },
  });
  assert.deepEqual(savedSkill, { skill: draft, signal });
});

test('skill save tool does not save invalid drafts', async () => {
  let requestCount = 0;
  const tool = createSkillSaveTool({
    async saveSkill() {
      requestCount += 1;
    },
  });
  const invalid = { ...draft, prompt: '' };

  assert.match(tool.validate_input(invalid), /Skill prompt/u);
  assert.throws(() => tool.execute(invalid, { signal: new AbortController().signal }), /Skill prompt/u);
  assert.equal(requestCount, 0);
});

test('skill save tool accepts a complete skill description and prompt', () => {
  const tool = createSkillSaveTool({ async saveSkill() {} });
  assert.equal(tool.validate_input(draft), null);
  assert.match(tool.validate_input({ name: draft.name, prompt: draft.prompt }), /Skill description/u);
  assert.match(tool.validate_input({ ...draft, prompt: ' ' }), /Skill prompt/u);
});
