import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createConversationStore } from './conversation-store.mjs';

test('local conversation store creates, persists, and updates conversations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'livingwords-conversations-'));
  const filePath = join(directory, 'app-data', 'conversations.json');
  const store = createConversationStore(filePath);

  try {
    assert.deepEqual(await store.list(), []);
    const created = await store.create();
    assert.equal(created.title, 'New conversation');
    assert.deepEqual(created.messages, []);

    const updated = {
      ...created,
      title: 'A saved conversation',
      updatedAt: new Date(Date.now() + 1_000).toISOString(),
      messages: [
        { role: 'user', content: 'What is hope?' },
        {
          role: 'assistant',
          content: 'Hope is a confident expectation.',
        },
      ],
    };
    await store.save(updated);

    const restored = await createConversationStore(filePath).list();
    assert.deepEqual(restored, [updated]);
    assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8')), [updated]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('local conversation store reports corrupt persisted data instead of discarding it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'livingwords-conversations-corrupt-'));
  const filePath = join(directory, 'conversations.json');
  await writeFile(filePath, '{invalid json');

  try {
    await assert.rejects(createConversationStore(filePath).list(), /not valid JSON/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('local conversation store retains old chat text and drops retired message metadata', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'livingwords-conversations-legacy-'));
  const filePath = join(directory, 'conversations.json');
  const store = createConversationStore(filePath);

  try {
    const session = await store.create();
    const legacy = {
      ...session,
      messages: [
        { role: 'user', content: 'What is hope?' },
        {
          role: 'assistant',
          content: 'Hope gives strength.',
          grounded: true,
          sources: [{ id: 'S1', source: 'notes.md', chunk: 1 }],
        },
        { role: 'assistant', content: 'This response was cancelled.', status: 'cancelled' },
      ],
    };
    await writeFile(filePath, JSON.stringify([legacy]));

    const [restored] = await store.list();
    assert.ok(restored);
    assert.deepEqual(restored?.messages, [
      { role: 'user', content: 'What is hope?' },
      { role: 'assistant', content: 'Hope gives strength.' },
      { role: 'assistant', content: 'This response was cancelled.', status: 'cancelled' },
    ]);
    await store.save(restored);
    const saved = JSON.parse(await readFile(filePath, 'utf8'));
    assert.equal('grounded' in saved[0].messages[1], false);
    assert.equal('sources' in saved[0].messages[1], false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('local conversation store preserves incomplete response status', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'livingwords-conversations-incomplete-'));
  const filePath = join(directory, 'conversations.json');
  const store = createConversationStore(filePath);

  try {
    const session = await store.create();
    await store.save({
      ...session,
      messages: [
        { role: 'assistant', content: 'This reply reached the output limit.', status: 'truncated' },
        { role: 'assistant', content: 'This reply was interrupted.', status: 'interrupted' },
      ],
    });

    const [restored] = await createConversationStore(filePath).list();
    assert.deepEqual(restored?.messages, [
      { role: 'assistant', content: 'This reply reached the output limit.', status: 'truncated' },
      { role: 'assistant', content: 'This reply was interrupted.', status: 'interrupted' },
    ]);
    await assert.rejects(
      store.save({ ...session, messages: [{ role: 'assistant', content: 'Invalid', status: 'unknown' }] }),
      /invalid message/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('local conversation store validates writes and requires an existing conversation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'livingwords-conversations-invalid-'));
  const store = createConversationStore(join(directory, 'conversations.json'));

  try {
    await assert.rejects(store.save({ id: 'missing' }), /data is invalid/u);
    const created = await store.create();
    await assert.rejects(store.save({ ...created, id: 'unknown' }), /does not exist/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('local conversation store deletes a conversation and preserves the remaining sessions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'livingwords-conversations-delete-'));
  const filePath = join(directory, 'conversations.json');
  const store = createConversationStore(filePath);

  try {
    const deleted = await store.create();
    const retained = await store.create();
    await store.delete(deleted.id);

    assert.deepEqual(await store.list(), [retained]);
    await assert.rejects(store.delete(deleted.id), /does not exist/u);
    await assert.rejects(store.delete(''), /ID is invalid/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('local conversation store appends and persists a cancelled assistant turn', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'livingwords-conversations-cancelled-'));
  const filePath = join(directory, 'conversations.json');
  const store = createConversationStore(filePath);

  try {
    const session = await store.create();
    const cancelled = await store.appendMessage(session.id, {
      role: 'assistant',
      content: 'This response was cancelled.',
      status: 'cancelled',
    });

    assert.deepEqual(cancelled.messages, [{
      role: 'assistant',
      content: 'This response was cancelled.',
      status: 'cancelled',
    }]);
    assert.deepEqual(await createConversationStore(filePath).list(), [cancelled]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
