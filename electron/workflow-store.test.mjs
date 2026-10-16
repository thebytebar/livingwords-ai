import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createWorkflowStore, WORKFLOW_BUILDER } from './workflow-store.mjs';

const customWorkflow = {
  name: 'Prepare a study guide',
  starter: 'Use when the user asks to turn a topic into a study guide.',
  steps: ['Identify the topic.', 'Organize the material.'],
  goal: 'Give the user a concise, organized study guide.',
};

test('workflow store includes the protected built-in workflow by default', async () => {
  const root = await mkdtemp(join(tmpdir(), 'livingwords-workflows-'));
  const store = createWorkflowStore(join(root, 'workflows.json'));

  try {
    const workflows = await store.list();
    assert.equal(workflows.length, 1);
    assert.equal(workflows[0]?.id, WORKFLOW_BUILDER.id);
    assert.equal(workflows[0]?.source, 'builtin');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('customized legacy bundled workflows migrate to regular user workflows', async () => {
  const root = await mkdtemp(join(tmpdir(), 'livingwords-workflows-'));
  const path = join(root, 'workflows.json');
  const legacyWorkflow = {
    id: 'web-research',
    name: 'Deep web research',
    starter: 'Use when the user explicitly asks for deep web research.',
    steps: ['Find several sources.', 'Compare their evidence.'],
    goal: 'Provide a carefully sourced answer.',
  };

  try {
    await writeFile(path, JSON.stringify({
      schema_version: 1,
      overrides: [legacyWorkflow],
      custom: [],
    }));
    const store = createWorkflowStore(path);
    const listed = await store.list();
    assert.equal(listed.length, 2);
    const migrated = listed.find((workflow) => workflow.id === 'web-research');
    assert.equal(migrated?.name, 'Deep web research');
    assert.equal(migrated?.source, 'custom');
    assert.equal(migrated?.customized, false);

    await store.save({ ...legacyWorkflow, name: 'My research workflow' });
    const saved = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(saved.schema_version, 2);
    assert.deepEqual(saved.overrides, []);
    assert.equal(saved.custom[0].id, 'web-research');
    assert.equal(saved.custom[0].name, 'My research workflow');
    assert.deepEqual(saved.order, [WORKFLOW_BUILDER.id, 'web-research']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('custom workflows can be created, edited, and deleted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'livingwords-workflows-'));
  const store = createWorkflowStore(join(root, 'workflows.json'));

  try {
    const created = await store.save(customWorkflow);
    assert.match(created.id, /^custom-[0-9a-f-]{36}$/u);
    assert.equal(created.source, undefined);

    const listed = await store.list();
    assert.equal(listed[1]?.id, created.id);
    assert.equal(listed[1]?.source, 'custom');

    const edited = await store.save({ ...created, name: 'Revised study guide' });
    assert.equal(edited.name, 'Revised study guide');
    await store.delete(created.id);
    assert.deepEqual((await store.list()).map(({ id }) => id), [WORKFLOW_BUILDER.id]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('workflow definitions reject unsafe IDs, unsupported fields, empty instructions, and oversized content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'livingwords-workflows-'));
  const store = createWorkflowStore(join(root, 'workflows.json'));

  try {
    assert.throws(() => store.save({ ...customWorkflow, id: '../settings' }), /Workflow ID/u);
    await assert.rejects(store.save({ ...customWorkflow, id: WORKFLOW_BUILDER.id }), /no longer exists/u);
    assert.throws(() => store.save({ ...customWorkflow, executable: 'run arbitrary code' }), /Unsupported workflow field/u);
    assert.throws(() => store.save({ ...customWorkflow, steps: [] }), /1–12 steps/u);
    assert.throws(() => store.save({ ...customWorkflow, goal: ' '.repeat(2_001) }), /Workflow goal/u);
    assert.throws(() => store.save({ ...WORKFLOW_BUILDER, source: 'builtin' }), /Unsupported workflow field/u);
    assert.throws(() => store.delete('../invalid'), /Workflow ID/u);
    await assert.rejects(store.delete('web-research'), /workflow no longer exists/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('workflow priority is validated and persists across store instances', async () => {
  const root = await mkdtemp(join(tmpdir(), 'livingwords-workflows-'));
  const path = join(root, 'workflows.json');
  const store = createWorkflowStore(path);

  try {
    const first = await store.save(customWorkflow);
    const second = await store.save({
      ...customWorkflow,
      name: 'Summarize a document',
      starter: 'Use when the user asks for a document summary.',
    });
    await store.reorder([second.id, WORKFLOW_BUILDER.id, first.id]);

    assert.deepEqual((await createWorkflowStore(path).list()).map(({ id }) => id), [
      second.id,
      WORKFLOW_BUILDER.id,
      first.id,
    ]);
    await assert.rejects(store.reorder([second.id, first.id]), /include every available workflow exactly once/u);
    await assert.rejects(store.reorder([second.id, second.id, first.id]), /include every available workflow exactly once/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('workflow store reports malformed persisted data instead of silently replacing it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'livingwords-workflows-'));
  const path = join(root, 'workflows.json');

  try {
    await writeFile(path, '{');
    await assert.rejects(createWorkflowStore(path).list(), /not valid JSON/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
