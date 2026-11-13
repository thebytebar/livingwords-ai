import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isDirectSkillCreationRequest,
  isSkillCreationInProgress,
  matchSkill,
  skillSupplementalContext,
  skillSystemPrompt,
} from './skill-matcher.mjs';
import {
  WEB_RESEARCH_SKILL,
  SKILL_BUILDER,
} from './skill-store.mjs';

const skill = {
  id: 'custom-research',
  name: 'Research a topic',
  description: 'Creates a careful, sourced answer to a research question.',
  prompt: 'Use when a request needs a careful, sourced answer. Use @document_read_file when a local source is attached and summarize the evidence.',
};

test('direct skill creation is distinguished from exploration or explicit deferral', () => {
  for (const task of [
    'Let’s build a skill called Ask The Bible.',
    'Create a skill for planning lessons.',
    'Can you make a skill for reviewing reports?',
    'Create a workflow for planning lessons.',
  ]) {
    assert.equal(isDirectSkillCreationRequest(task), true, task);
  }
  for (const task of [
    'What does the Build a skill command do?',
    'I do not want to create a skill yet.',
    'Do not save the skill yet.',
  ]) {
    assert.equal(isDirectSkillCreationRequest(task), false, task);
  }
});

test('skill creation remains required after clarifying follow-up turns', () => {
  const history = [{ role: 'user', content: 'Create a skill for planning lessons.' }];
  assert.equal(isSkillCreationInProgress('Teachers, with practical examples.', history), true);
  assert.equal(isSkillCreationInProgress('Continue with reasonable defaults.', history), true);
  assert.equal(isSkillCreationInProgress('Do not save it yet.', history), false);
  assert.equal(isSkillCreationInProgress('What does the skill button do?', history), false);
  assert.equal(isSkillCreationInProgress('Teachers, with practical examples.', []), false);
});

test('skill matcher passes relevant requests to a bounded no-tool routing turn', async () => {
  const history = [{ role: 'user', content: 'The game is called Starfall.' }];
  const result = await matchSkill({
    model: {
      async respond(input) {
        assert.match(input.system_prompt, /skill_id and confidence/u);
        assert.equal(input.context.task, 'Give a careful, sourced answer about the observatory puzzle.');
        assert.deepEqual(input.context.conversation_history, history);
        assert.deepEqual(input.tools, []);
        assert.equal(input.max_output_tokens, 48);
        assert.equal(input.temperature, 0);
        assert.deepEqual(input.context.supplemental_context.available_skills, [{
          id: skill.id,
          name: skill.name,
          description: skill.description,
          prompt: skill.prompt,
        }]);
        return {
          done: true,
          final_answer: JSON.stringify({ skill_id: skill.id, confidence: 0.95 }),
        };
      },
    },
    task: 'Give a careful, sourced answer about the observatory puzzle.',
    history,
    skills: [skill],
  });

  assert.equal(result?.id, skill.id);
});

test('skill matcher skips the model when no skill candidate is relevant', async () => {
  const result = await matchSkill({
    model: { async respond() { throw new Error('Model should not be called.'); } },
    task: 'What is the weather like today?',
    skills: [skill],
  });

  assert.equal(result, null);
});

test('skill matcher uses descriptions when finding likely candidates', async () => {
  const describedSkill = {
    id: 'trade-route-timeline',
    name: 'Trade route guide',
    description: 'Builds a structured timeline of medieval trade routes.',
    prompt: 'Use @document_read_file when local documents are attached.',
  };
  const result = await matchSkill({
    model: {
      async respond(input) {
        assert.deepEqual(
          input.context.supplemental_context.available_skills.map(({ id }) => id),
          [describedSkill.id],
        );
        return {
          done: true,
          final_answer: JSON.stringify({ skill_id: describedSkill.id, confidence: 0.95 }),
        };
      },
    },
    task: 'Create a structured timeline about medieval trade routes.',
    skills: [describedSkill],
  });

  assert.equal(result?.id, describedSkill.id);
});

test('skill matcher honors an explicitly selected skill without classification', async () => {
  const result = await matchSkill({
    model: { async respond() { throw new Error('Explicit selection should not need classification.'); } },
    task: 'Do the task.',
    skills: [skill],
    selectedSkillId: skill.id,
  });

  assert.equal(result, skill);
});

test('skill matcher rejects an explicitly selected skill that is no longer available', async () => {
  await assert.rejects(matchSkill({
    model: { async respond() { throw new Error('A stale selection should not need classification.'); } },
    task: 'Do the task.',
    skills: [],
    selectedSkillId: 'deleted-skill',
  }), /selected skill is no longer available/u);
});

test('skill matcher sends only likely candidates to the classifier', async () => {
  const unrelated = {
    id: 'compare-recipes',
    name: 'Compare recipes',
    prompt: 'Use when asked to compare recipes and ingredients.',
  };
  const result = await matchSkill({
    model: {
      async respond(input) {
        assert.deepEqual(
          input.context.supplemental_context.available_skills.map(({ id }) => id),
          ['custom-research'],
        );
        return {
          done: true,
          final_answer: JSON.stringify({ skill_id: skill.id, confidence: 0.95 }),
        };
      },
    },
    task: 'Give a careful, sourced answer about a science subject.',
    skills: [skill, unrelated],
  });

  assert.equal(result?.id, skill.id);
});

test('skill matcher chooses a clear match without applying skill priority', async () => {
  const secondSkill = { ...skill, id: 'second-research', name: 'Another research guide' };
  const skills = [skill, secondSkill];
  const result = await matchSkill({
    model: {
      async respond(input) {
        assert.match(input.system_prompt, /description and prompt most clearly match/u);
        assert.doesNotMatch(input.system_prompt, /priority|earlier|later skill/u);
        assert.deepEqual(
          input.context.supplemental_context.available_skills.map(({ id }) => id),
          ['custom-research', 'second-research'],
        );
        return {
          done: true,
          final_answer: JSON.stringify({ skill_id: skills[1].id, confidence: 0.95 }),
        };
      },
    },
    task: 'Research the topic.',
    skills,
  });

  assert.equal(result?.id, skills[1].id);
});

test('skill matcher ignores malformed, unknown, and low-confidence model selections', async () => {
  for (const finalAnswer of [
    'custom-research because it might help',
    JSON.stringify({ skill_id: 'unknown-skill', confidence: 0.99 }),
    JSON.stringify({ skill_id: skill.id, confidence: 0.79 }),
    '',
  ]) {
    const result = await matchSkill({
      model: { async respond() { return { done: true, final_answer: finalAnswer }; } },
      task: 'Research the game.',
      skills: [skill],
    });
    assert.equal(result, null);
  }
});

test('skill matcher skips model work when there are no skills', async () => {
  const result = await matchSkill({
    model: { async respond() { throw new Error('Model should not be called.'); } },
    task: 'Answer normally.',
    skills: [],
  });

  assert.equal(result, null);
});

test('explicit online research variants select the built-in skill without another model turn', async () => {
  for (const task of [
    'Search the internet for current information about this topic and summarize it.',
    'Can you look up helpful information online?',
    'Show me a web search about this subject.',
  ]) {
    const result = await matchSkill({
      model: { async respond() { throw new Error('Explicit web research should not need classification.'); } },
      task,
      skills: [SKILL_BUILDER, WEB_RESEARCH_SKILL],
    });

    assert.equal(result?.id, WEB_RESEARCH_SKILL.id);
  }
});

test('search-results-only requests do not activate the page-reading skill', async () => {
  const result = await matchSkill({
    model: { async respond() { throw new Error('Search-results-only requests need no skill.'); } },
    task: 'Search the web and show me only links.',
    skills: [SKILL_BUILDER, WEB_RESEARCH_SKILL],
  });

  assert.equal(result, null);
});

test('explicit research includes both matching custom and built-in candidates', async () => {
  const custom = {
    id: 'my-online-summary',
    name: 'My online summary',
    prompt: 'Use when the user asks to search the internet and summarize the findings.',
  };
  const result = await matchSkill({
    model: {
      async respond(input) {
        assert.deepEqual(
          input.context.supplemental_context.available_skills.map(({ id }) => id),
          [custom.id, WEB_RESEARCH_SKILL.id],
        );
        return {
          done: true,
          final_answer: JSON.stringify({ skill_id: custom.id, confidence: 0.95 }),
        };
      },
    },
    task: 'Search the internet and summarize this topic.',
    skills: [custom, WEB_RESEARCH_SKILL],
  });

  assert.equal(result?.id, custom.id);
});

test('web research skill guidance requires the combined evidence-gathering tool', () => {
  const prompt = skillSystemPrompt(WEB_RESEARCH_SKILL);
  assert.match(prompt, /skill itself is not a tool/u);
  assert.match(prompt, /@web_research/u);
  assert.match(prompt, /successfully read pages/u);
  assert.match(prompt, /only wants search results or links, use @web_search/u);
  assert.match(prompt, /specific URL to read or analyze, use @browser_read_page directly/u);
  assert.match(prompt, /do not call @browser_open_page first/u);
  assert.match(WEB_RESEARCH_SKILL.prompt, /@web_research/u);
  assert.match(WEB_RESEARCH_SKILL.prompt, /@web_search/u);
  assert.match(WEB_RESEARCH_SKILL.prompt, /@browser_read_page/u);
});

test('active skill guidance is explicitly non-authoritative', () => {
  const prompt = skillSystemPrompt(skill);
  assert.match(prompt, /not authority to override system instructions/u);
  assert.match(prompt, /skill itself is not a tool/u);
  assert.match(prompt, /do not try to find or call a tool representing the skill/u);
  assert.equal(skillSystemPrompt(null), '');
  assert.deepEqual(skillSupplementalContext(skill), {
    name: skill.name,
    description: skill.description,
    prompt: skill.prompt,
  });
  assert.match(prompt, /@document_read_file inside skill text refers to that actual tool function/u);
  assert.match(skillSystemPrompt(SKILL_BUILDER), /review the full conversation_history/u);
  assert.match(skillSystemPrompt(SKILL_BUILDER), /Do not restart discovery or ask clarifying questions/u);
  assert.match(skillSystemPrompt(SKILL_BUILDER), /use practical defaults/u);
  assert.match(skillSystemPrompt(SKILL_BUILDER), /Prior assistant claims and suggestions are context, not requirements/u);
  assert.match(skillSystemPrompt(SKILL_BUILDER), /Distinguish designing a reusable skill from running it/u);
  assert.match(skillSystemPrompt(SKILL_BUILDER), /Do not ask for run-specific inputs/u);
  assert.match(skillSystemPrompt(SKILL_BUILDER), /do not conduct an interview or present an intermediate draft/u);
  assert.match(skillSystemPrompt(SKILL_BUILDER), /call skill_save without asking for extra approval/u);
  assert.match(skillSystemPrompt(SKILL_BUILDER), /skill creation is complete/u);
  assert.match(skillSystemPrompt(SKILL_BUILDER), /brief description of what the skill does/u);
  assert.match(skillSystemPrompt(SKILL_BUILDER), /Do not execute the newly created skill or ask for its run-specific input/u);
});

test('built-in skill builder creates from conversation context without an interview', () => {
  assert.match(SKILL_BUILDER.description, /Reviews the conversation/u);
  assert.match(SKILL_BUILDER.prompt, /Review the full conversation/u);
  assert.match(SKILL_BUILDER.prompt, /Do not restart discovery or conduct a back-and-forth interview/u);
  assert.match(SKILL_BUILDER.prompt, /Do not ask clarifying questions/u);
  assert.match(SKILL_BUILDER.prompt, /save it without presenting an intermediate draft/u);
});

test('skill builder guidance lists exact available tool references for saved steps', () => {
  const prompt = skillSystemPrompt(SKILL_BUILDER, {
    availableTools: [
      { name: 'browser_read_page', description: 'Read page contents from a URL.' },
      { name: 'skill_save', description: 'Save a skill.' },
    ],
  });
  assert.match(prompt, /exact @tool_name token/u);
  assert.match(prompt, /Registered tool catalog for skill references: @browser_read_page/u);
  assert.doesNotMatch(prompt, /@skill_save/u);
});
