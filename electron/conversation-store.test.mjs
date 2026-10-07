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
    assert.deepEqual(created.selectedDocumentIds, []);
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

test('local conversation store persists selected documents and verified citation excerpts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'livingwords-conversations-sources-'));
  const filePath = join(directory, 'conversations.json');
  const store = createConversationStore(filePath);
  const documentId = '00000000-0000-4000-8000-000000000001';

  try {
    const session = await store.create();
    const updated = {
      ...session,
      selectedDocumentIds: [documentId],
      messages: [{
        role: 'assistant',
        content: 'A grounded answer [S1].',
        sources: [{
          citationId: 'S1',
          documentId,
          name: 'notes.md',
          page: null,
          excerpt: 'The supporting source passage.',
        }],
      }],
    };
    await store.save(updated);
    const other = await store.create();
    await store.save({ ...other, selectedDocumentIds: [documentId] });
    assert.deepEqual(await createConversationStore(filePath).get(session.id), updated);

    await store.removeDocumentSelection(documentId, session.id);
    const restored = await createConversationStore(filePath).get(session.id);
    assert.deepEqual(restored.selectedDocumentIds, []);
    assert.deepEqual(restored.messages[0].sources, updated.messages[0].sources);
    assert.deepEqual((await createConversationStore(filePath).get(other.id)).selectedDocumentIds, [documentId]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('local conversation store persists retrieved folder files and prunes them when detached', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'livingwords-conversations-retrieved-'));
  const store = createConversationStore(join(directory, 'conversations.json'));
  const referenceId = '00000000-0000-4000-8000-000000000001';
  const fileId = '00000000-0000-4000-8000-000000000002';
  const otherFileId = '00000000-0000-4000-8000-000000000003';

  try {
    const session = await store.create();
    await store.save({
      ...session,
      selectedDocumentIds: [referenceId],
      retrievedDocumentIds: [fileId, otherFileId],
      messages: [{
        role: 'assistant',
        content: 'I inspected two files.',
        contextUsage: [{
          documentId: fileId,
          name: 'README.md',
          method: 'folder-read',
          page: null,
          startLine: 1,
          endLine: 4,
          excerpt: 'Project overview.',
          truncated: false,
        }, {
          documentId: otherFileId,
          name: 'src/main.ts',
          method: 'folder-grep',
          page: null,
          startLine: 8,
          endLine: 8,
          excerpt: 'startApplication();',
          truncated: false,
        }],
      }],
    });
    const restoredBeforeRemoval = await createConversationStore(join(directory, 'conversations.json')).get(session.id);
    assert.deepEqual(restoredBeforeRemoval.retrievedDocumentIds, [fileId, otherFileId]);
    assert.deepEqual(restoredBeforeRemoval.messages[0].contextUsage.map(({ documentId }) => documentId), [fileId, otherFileId]);

    await store.removeDocumentSelection(referenceId, session.id, [otherFileId]);
    const restored = await store.get(session.id);
    assert.deepEqual(restored.selectedDocumentIds, []);
    assert.deepEqual(restored.retrievedDocumentIds, [otherFileId]);
    assert.deepEqual(restored.messages[0].contextUsage.map(({ documentId }) => documentId), [otherFileId]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('removing a document removes its citation links while preserving citations to retained files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'livingwords-conversations-remove-citations-'));
  const store = createConversationStore(join(directory, 'conversations.json'));
  const folderId = '00000000-0000-4000-8000-000000000010';
  const removedFileId = '00000000-0000-4000-8000-000000000011';
  const retainedFileId = '00000000-0000-4000-8000-000000000012';

  try {
    const session = await store.create();
    await store.save({
      ...session,
      selectedDocumentIds: [folderId],
      retrievedDocumentIds: [removedFileId, retainedFileId],
      messages: [{
        role: 'assistant',
        content: 'A finding [S1], and another [S2].',
        sources: [
          {
            citationId: 'S1',
            documentId: removedFileId,
            name: 'removed.md',
            page: null,
            excerpt: 'No longer attached.',
          },
          {
            citationId: 'S2',
            documentId: retainedFileId,
            name: 'retained.md',
            page: null,
            excerpt: 'Still attached.',
          },
        ],
        contextUsage: [
          {
            documentId: removedFileId,
            name: 'removed.md',
            method: 'document-search',
            page: 2,
            excerpt: 'No longer attached.',
            truncated: false,
          },
          {
            documentId: retainedFileId,
            name: 'retained.md',
            method: 'document-read',
            page: null,
            excerpt: 'Still attached.',
            truncated: false,
          },
        ],
      }],
    });

    await store.removeDocumentSelection(folderId, session.id, [retainedFileId]);
    const restored = await store.get(session.id);
    assert.deepEqual(restored.retrievedDocumentIds, [retainedFileId]);
    assert.equal(restored.messages[0].content, 'A finding, and another [S2].');
    assert.deepEqual(restored.messages[0].sources.map(({ citationId }) => citationId), ['S2']);
    assert.deepEqual(restored.messages[0].contextUsage.map(({ documentId }) => documentId), [retainedFileId]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('local conversation store allows 100 references and full-text citation sources but enforces their bounds', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'livingwords-conversations-document-bounds-'));
  const store = createConversationStore(join(directory, 'conversations.json'));
  const selectedDocumentIds = Array.from({ length: 100 }, (_, index) =>
    `${String(index).padStart(8, '0')}-0000-4000-8000-000000000000`);

  try {
    const session = await store.create();
    await store.save({ ...session, selectedDocumentIds });
    await assert.rejects(
      store.save({ ...session, selectedDocumentIds: [...selectedDocumentIds, '00000100-0000-4000-8000-000000000000'] }),
      /invalid selected documents/u,
    );
    await store.save({
      ...session,
      messages: [{
        role: 'assistant',
        content: 'A direct file was reviewed.',
        contextUsage: [{
          documentId: selectedDocumentIds[0],
          name: 'long-note.md',
          method: 'document-read',
          page: null,
          excerpt: 'x'.repeat(1_600),
          truncated: true,
        }],
        sources: [{
          citationId: 'S1',
          documentId: selectedDocumentIds[0],
          name: 'long-note.md',
          page: null,
          excerpt: 'x'.repeat(12_000),
        }],
      }],
    });
    await assert.rejects(
      store.save({
        ...session,
        messages: [{
          role: 'assistant',
          content: 'Invalid source.',
          sources: [{
            citationId: 'S1',
            documentId: selectedDocumentIds[0],
            name: 'long-note.md',
            page: null,
            excerpt: 'x'.repeat(12_001),
          }],
        }],
      }),
      /invalid document citation/u,
    );
    await assert.rejects(
      store.save({
        ...session,
        messages: [{
          role: 'assistant',
          content: 'Invalid provenance.',
          contextUsage: [{
            documentId: selectedDocumentIds[0],
            name: 'long-note.md',
            method: 'document-read',
            page: null,
            excerpt: 'x'.repeat(1_601),
            truncated: true,
          }],
        }],
      }),
      /invalid document context provenance/u,
    );
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
          unrelatedMetadata: { ignored: true },
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
    assert.equal('unrelatedMetadata' in saved[0].messages[1], false);
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
