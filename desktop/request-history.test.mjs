import assert from 'node:assert/strict';
import test from 'node:test';
import { pendingSkillId, selectRequestHistory } from './request-history.mjs';

test('request history includes every non-cancelled conversation message', () => {
  const messages = [
    ...Array.from({ length: 12 }, (_, index) => [
      { role: 'user', content: `User message ${index + 1}.` },
      { role: 'assistant', content: `Assistant response ${index + 1}.` },
    ]).flat(),
    { role: 'user', content: 'Keep this current requirement.' },
    { role: 'assistant', content: 'Earlier response.', status: 'cancelled' },
  ];

  const history = selectRequestHistory(messages);
  const recentHistory = selectRequestHistory(messages, { recentOnly: true });

  assert.deepEqual(
    history,
    messages
      .filter(({ status }) => status !== 'cancelled')
      .map(({ role, content }) => ({ role, content })),
  );
  assert.equal(history.length, 25);
  assert.equal(recentHistory.length, 8);
  assert.equal(recentHistory.at(-1)?.content, 'Keep this current requirement.');
});

test('request history omits cancelled messages and preserves chronological order', () => {
  const history = selectRequestHistory([
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'cancelled', status: 'cancelled' },
    { role: 'assistant', content: 'last' },
  ]);

  assert.deepEqual(history, [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'last' },
  ]);
});

test('pending skill continues only when the latest assistant turn is waiting for input', () => {
  const skillSelection = { id: 'skill-builder', name: 'Build a skill' };
  assert.equal(pendingSkillId([
    { role: 'assistant', content: 'You may answer, skip, or say continue.', skillSelection },
  ], ['skill-builder']), 'skill-builder');
  assert.equal(pendingSkillId([
    { role: 'assistant', content: 'Which audience should this skill serve?', skillSelection },
  ], ['skill-builder']), 'skill-builder');
  assert.equal(pendingSkillId([
    { role: 'assistant', content: 'The skill was saved successfully.', skillSelection },
  ], ['skill-builder']), null);
});

test('pending skills continue from legacy workflow selection metadata', () => {
  assert.equal(pendingSkillId([
    {
      role: 'assistant',
      content: 'Which audience should this skill serve?',
      workflowSelection: { id: 'workflow-builder', name: 'Build a workflow' },
    },
  ], ['skill-builder']), 'skill-builder');
  assert.equal(pendingSkillId([
    {
      role: 'assistant',
      content: 'Would you like me to run this skill?',
      workflowSelection: {
        id: 'my-research',
        name: 'My research',
        requiresConfirmation: true,
      },
    },
  ], ['my-research'], 'Yes.'), 'my-research');
});

test('pending skill does not continue after cancellation or when stale', () => {
  const skillSelection = { id: 'skill-builder', name: 'Build a skill' };
  assert.equal(pendingSkillId([
    { role: 'assistant', content: 'Which audience should this serve?', skillSelection },
    { role: 'user', content: 'Teachers.' },
  ], ['skill-builder']), null);
  assert.equal(pendingSkillId([
    {
      role: 'assistant',
      content: 'Which audience should this serve?',
      status: 'interrupted',
      skillSelection,
    },
  ], ['skill-builder']), null);
  assert.equal(pendingSkillId([
    { role: 'assistant', content: 'Which audience should this serve?', skillSelection },
  ], ['other-skill']), null);
});

test('inferred skills continue only after an affirmative confirmation', () => {
  const pending = [{
    role: 'assistant',
    content: 'I found the “Research” skill. Would you like me to run it?',
    skillSelection: {
      id: 'research',
      name: 'Research',
      requiresConfirmation: true,
    },
  }];
  for (const answer of ['Yes.', 'Sure, go ahead.', 'Run it please.', 'Okay.', 'That works.']) {
    assert.equal(pendingSkillId(pending, ['research'], answer), 'research', answer);
  }
  for (const answer of ['No, thanks.', 'What does it do?', 'Maybe later.', "Yes, but don't run it yet."]) {
    assert.equal(pendingSkillId(pending, ['research'], answer), null, answer);
  }
});
