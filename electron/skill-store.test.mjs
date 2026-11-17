import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  ASK_THE_BIBLE_SKILL,
  ASK_THEOLOGIAN_SKILL,
  createSkillStore,
  WEB_RESEARCH_SKILL,
  SKILL_BUILDER,
} from './skill-store.mjs';

const customSkill = {
  name: 'Prepare a study guide',
  description: 'Turns a topic into a concise study guide.',
  prompt: 'Use when the user asks to turn a topic into a study guide. Identify the topic, organize the material, and give the user a concise study guide.',
};

test('skill store includes protected built-in skills by default', async () => {
  const root = await mkdtemp(join(tmpdir(), 'livingwords-skills-'));
  const store = createSkillStore(join(root, 'skills.json'));

  try {
    const skills = await store.list();
    assert.equal(skills.length, 4);
    assert.equal(skills[0]?.id, SKILL_BUILDER.id);
    assert.equal(skills[0]?.source, 'builtin');
    assert.ok(skills[0]?.description);
    assert.equal(skills[1]?.id, WEB_RESEARCH_SKILL.id);
    assert.equal(skills[1]?.source, 'builtin');
    assert.ok(skills[1]?.description);
    assert.equal(skills[2]?.id, ASK_THE_BIBLE_SKILL.id);
    assert.equal(skills[2]?.source, 'builtin');
    assert.equal(skills[2]?.prompt, ASK_THE_BIBLE_SKILL.prompt);
    assert.equal(skills[3]?.id, ASK_THEOLOGIAN_SKILL.id);
    assert.equal(skills[3]?.source, 'builtin');
    assert.equal(skills[3]?.prompt, ASK_THEOLOGIAN_SKILL.prompt);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('unchanged custom Ask The Bible skill migrates to the built-in skill', async () => {
  const root = await mkdtemp(join(tmpdir(), 'livingwords-skills-'));
  const path = join(root, 'skills.json');
  const legacyCustomSkill = {
    ...ASK_THE_BIBLE_SKILL,
    id: 'custom-bc236a7d-6d1d-45f2-91eb-6586a635732f',
  };

  try {
    await writeFile(path, JSON.stringify({
      schema_version: 1,
      skills: [legacyCustomSkill],
    }));
    const store = createSkillStore(path);
    const listed = await store.list();
    assert.equal(listed.filter(({ name }) => name === 'Ask The Bible').length, 1);
    assert.equal(listed.find(({ id }) => id === ASK_THE_BIBLE_SKILL.id)?.source, 'builtin');
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), {
      schema_version: 1,
      skills: [],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('unchanged custom Ask a Theologian skill migrates to the built-in skill', async () => {
  const root = await mkdtemp(join(tmpdir(), 'livingwords-skills-'));
  const path = join(root, 'skills.json');
  const legacyCustomSkill = {
    ...ASK_THEOLOGIAN_SKILL,
    id: 'custom-bc236a7d-6d1d-45f2-91eb-6586a635732f',
  };
  const customizedSkill = {
    ...legacyCustomSkill,
    id: 'custom-theologian-edited',
    prompt: `${legacyCustomSkill.prompt}\n\nPrefer concise answers.`,
  };
  const customizedDescriptionSkill = {
    ...legacyCustomSkill,
    id: 'custom-theologian-description',
    description: 'A more concise Bible-only theological guide.',
  };

  try {
    await writeFile(path, JSON.stringify({
      schema_version: 1,
      skills: [legacyCustomSkill, customizedSkill, customizedDescriptionSkill],
    }));
    const store = createSkillStore(path);
    const listed = await store.list();
    assert.equal(listed.filter(({ name }) => name === 'Ask a Theologian').length, 3);
    assert.equal(listed.find(({ id }) => id === ASK_THEOLOGIAN_SKILL.id)?.source, 'builtin');
    assert.equal(listed.find(({ id }) => id === customizedSkill.id)?.source, 'custom');
    assert.equal(listed.find(({ id }) => id === customizedDescriptionSkill.id)?.source, 'custom');
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), {
      schema_version: 1,
      skills: [customizedSkill, customizedDescriptionSkill],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('customized legacy bundled skills migrate to regular user skills', async () => {
  const root = await mkdtemp(join(tmpdir(), 'livingwords-skills-'));
  const path = join(root, 'skills.json');
  const legacySkill = {
    id: 'web-research',
    name: 'Deep web research',
    starter: 'Use when the user explicitly asks for deep web research.',
    steps: ['Find several sources.', 'Compare their evidence.'],
    goal: 'Provide a carefully sourced answer.',
  };

  try {
    await writeFile(path, JSON.stringify({
      schema_version: 1,
      overrides: [legacySkill],
      custom: [],
    }));
    const store = createSkillStore(path);
    const listed = await store.list();
    assert.equal(listed.length, 5);
    const migrated = listed.find((skill) => skill.id === 'web-research');
    assert.equal(migrated?.name, 'Deep web research');
    assert.match(migrated?.description ?? '', /Use when the user explicitly asks for deep web research/u);
    assert.equal(migrated?.source, 'custom');
    assert.equal(migrated?.customized, false);

    await store.save({ ...legacySkill, name: 'My research skill' });
    const saved = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(saved.schema_version, 1);
    assert.equal(saved.skills[0].id, 'web-research');
    assert.equal(saved.skills[0].name, 'My research skill');
    assert.match(saved.skills[0].description, /Use when the user explicitly asks for deep web research/u);
    assert.match(saved.skills[0].prompt, /Use when the user explicitly asks for deep web research/u);
    assert.match(saved.skills[0].prompt, /Find several sources/u);
    assert.match(saved.skills[0].prompt, /Provide a carefully sourced answer/u);
    assert.equal('steps' in saved.skills[0], false);
    assert.equal('overrides' in saved, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('custom skills can be created, edited, and deleted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'livingwords-skills-'));
  const store = createSkillStore(join(root, 'skills.json'));

  try {
    const created = await store.save(customSkill);
    assert.match(created.id, /^custom-[0-9a-f-]{36}$/u);
    assert.equal(created.source, undefined);

    const listed = await store.list();
    const listedCustom = listed.find(({ id }) => id === created.id);
    assert.equal(listedCustom?.source, 'custom');

    const edited = await store.save({ ...created, name: 'Revised study guide' });
    assert.equal(edited.name, 'Revised study guide');
    assert.equal(edited.description, customSkill.description);
    await store.delete(created.id);
    assert.deepEqual((await store.list()).map(({ id }) => id), [
      SKILL_BUILDER.id,
      WEB_RESEARCH_SKILL.id,
      ASK_THE_BIBLE_SKILL.id,
      ASK_THEOLOGIAN_SKILL.id,
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('workflows.json migrates safely to skills.json without deleting the original', async () => {
  const root = await mkdtemp(join(tmpdir(), 'livingwords-skill-migration-'));
  const legacyPath = join(root, 'workflows.json');
  const skillPath = join(root, 'skills.json');
  const legacyData = {
    schema_version: 5,
    overrides: [],
    custom: [{
      id: 'custom-study-guide',
      name: 'Prepare a study guide',
      description: customSkill.description,
      prompt: customSkill.prompt,
    }],
  };
  const legacyContents = `${JSON.stringify(legacyData)}\n`;

  try {
    await writeFile(legacyPath, legacyContents);
    const skills = await createSkillStore(skillPath, { legacyFilePath: legacyPath }).list();
    assert.equal(skills.at(-1)?.id, 'custom-study-guide');
    assert.equal(skills.at(-1)?.name, customSkill.name);

    const migrated = JSON.parse(await readFile(skillPath, 'utf8'));
    assert.deepEqual(migrated, {
      schema_version: 1,
      skills: [{
        id: 'custom-study-guide',
        name: customSkill.name,
        description: customSkill.description,
        prompt: customSkill.prompt,
      }],
    });
    assert.equal(await readFile(legacyPath, 'utf8'), legacyContents);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('inline tool mentions persist and obsolete tool reference lists are discarded', async () => {
  const root = await mkdtemp(join(tmpdir(), 'livingwords-skills-'));
  const path = join(root, 'skills.json');
  const store = createSkillStore(path);

  try {
    const inlineSkill = {
      ...customSkill,
      prompt: 'Use when the user asks to inspect an attached project with @inspect_folder. Use @read_file to read relevant evidence and summarize it.',
    };
    const created = await store.save(inlineSkill);
    const renamedPrompt = 'Use when the user asks to inspect an attached project with @document_inspect_folder. Use @document_read_file to read relevant evidence and summarize it.';
    assert.equal(created.prompt, renamedPrompt);
    const listed = await createSkillStore(path).list();
    assert.equal(listed.find(({ id }) => id === created.id)?.prompt, renamedPrompt);

    const oldDefinition = { ...inlineSkill, id: 'existing-guide', toolReferences: ['search_web'] };
    await writeFile(path, JSON.stringify({
      schema_version: 2,
      overrides: [],
      custom: [oldDefinition],
      order: [SKILL_BUILDER.id, WEB_RESEARCH_SKILL.id, oldDefinition.id],
    }));
    const migrated = (await createSkillStore(path).list()).find(({ id }) => id === oldDefinition.id);
    assert.equal(migrated?.prompt, renamedPrompt);
    assert.equal('toolReferences' in migrated, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('skill definitions reject unsafe IDs, unsupported fields, empty instructions, and oversized content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'livingwords-skills-'));
  const store = createSkillStore(join(root, 'skills.json'));

  try {
    assert.throws(() => store.save({ ...customSkill, id: '../settings' }), /Skill ID/u);
    await assert.rejects(store.save({ ...customSkill, id: SKILL_BUILDER.id }), /no longer exists/u);
    await assert.rejects(store.save({ ...WEB_RESEARCH_SKILL }), /no longer exists/u);
    assert.throws(() => store.save({ ...customSkill, executable: 'run arbitrary code' }), /Unsupported skill field/u);
    assert.throws(() => store.save({ ...customSkill, prompt: '' }), /Skill prompt/u);
    assert.throws(() => store.save({ ...customSkill, prompt: null }), /must be a string/u);
    assert.throws(() => store.save({ ...customSkill, prompt: 'x'.repeat(12_001) }), /Skill prompt/u);
    assert.throws(() => store.save({ ...customSkill, description: '' }), /Skill description/u);
    assert.throws(() => store.save({ ...customSkill, description: 'x'.repeat(241) }), /Skill description/u);
    assert.throws(() => store.save({ ...customSkill, starter: 'legacy' }), /cannot be combined/u);
    assert.throws(() => store.save({ ...SKILL_BUILDER, source: 'builtin' }), /Unsupported skill field/u);
    assert.throws(() => store.delete('../invalid'), /Skill ID/u);
    await assert.rejects(store.delete('web-research'), /skill no longer exists/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('legacy skill order is ignored and removed on the next save', async () => {
  const root = await mkdtemp(join(tmpdir(), 'livingwords-skills-'));
  const path = join(root, 'skills.json');
  const custom = { ...customSkill, id: 'existing-guide' };

  try {
    await writeFile(path, JSON.stringify({
      schema_version: 2,
      overrides: [],
      custom: [custom],
      order: [custom.id, SKILL_BUILDER.id],
    }));
    const store = createSkillStore(path);
    const listed = await store.list();
    assert.deepEqual(listed.map(({ id }) => id), [
      SKILL_BUILDER.id,
      WEB_RESEARCH_SKILL.id,
      ASK_THE_BIBLE_SKILL.id,
      ASK_THEOLOGIAN_SKILL.id,
      custom.id,
    ]);
    await store.save({ ...custom, name: 'Updated guide' });
    const saved = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(saved.schema_version, 1);
    assert.equal(saved.skills[0].name, 'Updated guide');
    assert.equal('order' in saved, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('skill store reports malformed persisted data instead of silently replacing it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'livingwords-skills-'));
  const path = join(root, 'skills.json');

  try {
    await writeFile(path, '{');
    await assert.rejects(createSkillStore(path).list(), /not valid JSON/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
