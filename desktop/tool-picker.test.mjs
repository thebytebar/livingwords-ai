import assert from 'node:assert/strict';
import test from 'node:test';
import {
  activeSkillCommand,
  activeToolMention,
  filterToolCatalog,
  filterSkillCatalog,
  standaloneActionPrompt,
} from './tool-picker.mjs';

test('activeToolMention finds an @ query at the cursor and includes the rest of its name', () => {
  assert.deepEqual(activeToolMention('Use @web_search now', 11), {
    start: 4,
    end: 15,
    query: 'web_search',
  });
  assert.deepEqual(activeToolMention('@calc', 3), {
    start: 0,
    end: 5,
    query: 'calc',
  });
});

test('activeToolMention ignores email addresses, non-token text, and selected text', () => {
  assert.equal(activeToolMention('name@example.com', 8), null);
  assert.equal(activeToolMention('say @hello!', 11), null);
  assert.equal(activeToolMention('@calculator_evaluate', 4, 5), null);
});

test('activeSkillCommand finds slash commands and ignores URLs and selected text', () => {
  assert.deepEqual(activeSkillCommand('Please /research-topic now', 17), {
    start: 7,
    end: 26,
    query: 'research-topic now',
  });
  assert.deepEqual(activeSkillCommand('/', 1), {
    start: 0,
    end: 1,
    query: '',
  });
  assert.equal(activeSkillCommand('https://example.com', 7), null);
  assert.equal(activeSkillCommand('/research', 3, 4), null);
});

test('activeSkillCommand continues matching a skill query across spaces', () => {
  assert.deepEqual(activeSkillCommand('/Research a topic', 17), {
    start: 0,
    end: 17,
    query: 'Research a topic',
  });
  assert.deepEqual(activeSkillCommand('/Research ', 10), {
    start: 0,
    end: 10,
    query: 'Research ',
  });
});

test('filterToolCatalog matches tool names, summaries, and availability', () => {
  const tools = [
    { name: 'document_read_file', summary: 'Read a file', availability: 'Requires an attached folder.' },
    { name: 'calculator_evaluate', summary: 'Math', availability: 'Always available.' },
  ];
  assert.deepEqual(filterToolCatalog(tools, 'READ'), [tools[0]]);
  assert.deepEqual(filterToolCatalog(tools, 'attached folder'), [tools[0]]);
  assert.deepEqual(filterToolCatalog(tools, ''), tools);
});

test('filterSkillCatalog matches skill names, descriptions, prompts, and source', () => {
  const skills = [
    { name: 'Research a topic', description: 'Collect evidence.', prompt: 'Find credible sources.', source: 'custom' },
    { name: 'Web research', description: 'Find current information.', prompt: 'Search the public web.', source: 'builtin' },
  ];
  assert.deepEqual(filterSkillCatalog(skills, 'research'), skills);
  assert.deepEqual(filterSkillCatalog(skills, 'evidence'), [skills[0]]);
  assert.deepEqual(filterSkillCatalog(skills, 'credible'), [skills[0]]);
  assert.deepEqual(filterSkillCatalog(skills, 'built-in'), [skills[1]]);
  assert.deepEqual(filterSkillCatalog(skills, ''), skills);
});

test('standalone skill and tool actions use recent conversation context', () => {
  assert.match(standaloneActionPrompt('Research', []), /Run the “Research” skill/u);
  assert.match(standaloneActionPrompt('', ['web_search']), /Call the selected tool\b.*@web_search/u);
  assert.match(
    standaloneActionPrompt('Research', ['web_search', 'document_read_file']),
    /Run the “Research” skill.*@web_search, @document_read_file/u,
  );
  assert.match(standaloneActionPrompt('', []), /most recent user request/u);
});
