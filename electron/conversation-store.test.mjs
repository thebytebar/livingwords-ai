import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createConversationStore } from './conversation-store.mjs';

function exampleTrace() {
  const timestamp = new Date().toISOString();
  return {
    schema_version: 1,
    run_id: 'test-run',
    task: 'Explain hope.',
    started_at: timestamp,
    completed_at: timestamp,
    steps: [{
      step_number: 1,
      timestamp,
      thought: 'Answer from the available context.',
      tool_calls: null,
      observation: null,
      error: null,
      status: 'complete',
      token_usage: { input_tokens: 10, output_tokens: 6, total_tokens: 16 },
      latency_ms: 125,
      guardrail_decisions: [],
      verification: [],
      final_answer: 'Hope is a confident expectation.',
      context_compaction: null,
    }],
  };
}

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

test('local conversation store persists validated bounded traces with assistant responses', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'livingwords-conversations-traces-'));
  const filePath = join(directory, 'conversations.json');
  const store = createConversationStore(filePath);

  try {
    const session = await store.create();
    const trace = exampleTrace();
    const updated = {
      ...session,
      messages: [{
        role: 'assistant',
        content: 'Hope is a confident expectation.',
        generationDurationMs: 4_250,
        trace,
      }],
    };
    await store.save(updated);
    assert.deepEqual(await createConversationStore(filePath).get(session.id), updated);
    assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8'))[0].messages[0].trace, trace);
    assert.equal(JSON.parse(await readFile(filePath, 'utf8'))[0].messages[0].generationDurationMs, 4_250);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('local conversation store persists tool lifecycle records in chronological order', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'livingwords-conversations-tool-events-'));
  const filePath = join(directory, 'conversations.json');
  const store = createConversationStore(filePath);

  try {
    const session = await store.create();
    const timestamp = new Date().toISOString();
    const trace = {
      ...exampleTrace(),
      steps: [{
        ...exampleTrace().steps[0],
        tool_events: [
          {
            step_number: 1,
            call_index: 0,
            tool_name: 'read_file',
            timestamp,
            arguments: { path: 'src/app.ts' },
            status: 'pending',
          },
          {
            step_number: 1,
            call_index: 0,
            tool_name: 'read_file',
            timestamp,
            arguments: null,
            status: 'running',
          },
          {
            step_number: 1,
            call_index: 0,
            tool_name: 'read_file',
            timestamp,
            arguments: null,
            status: 'success',
          },
        ],
      }],
    };
    const updated = {
      ...session,
      messages: [{ role: 'assistant', content: 'I read the file.', trace }],
    };

    await store.save(updated);
    const restored = await createConversationStore(filePath).get(session.id);
    assert.deepEqual(restored.messages[0].trace.steps[0].tool_events, trace.steps[0].tool_events);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('local conversation store rejects invalid or oversized traces without breaking existing messages', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'livingwords-conversations-invalid-traces-'));
  const store = createConversationStore(join(directory, 'conversations.json'));

  try {
    const session = await store.create();
    await assert.rejects(
      store.save({
        ...session,
        messages: [{ role: 'assistant', content: 'Nope.', trace: { ...exampleTrace(), schema_version: 2 } }],
      }),
      /invalid agent trace/u,
    );
    await assert.rejects(
      store.save({
        ...session,
        messages: [{
          role: 'assistant',
          content: 'Nope.',
          trace: {
            ...exampleTrace(),
            steps: [{
              ...exampleTrace().steps[0],
              tool_events: [{
                step_number: 1,
                call_index: -1,
                tool_name: 'read_file',
                timestamp: new Date().toISOString(),
                arguments: null,
                status: 'running',
              }],
            }],
          },
        }],
      }),
      /invalid tool event/u,
    );
    await assert.rejects(
      store.save({
        ...session,
        messages: [{
          role: 'assistant',
          content: 'Nope.',
          trace: {
            ...exampleTrace(),
            steps: Array.from({ length: 21 }, (_, index) => ({
              ...exampleTrace().steps[0],
              step_number: index + 1,
            })),
          },
        }],
      }),
      /invalid agent trace/u,
    );
    await assert.rejects(
      store.save({
        ...session,
        messages: [{
          role: 'assistant',
          content: 'Too large.',
          trace: {
            ...exampleTrace(),
            steps: Array.from({ length: 20 }, (_, index) => ({
              ...exampleTrace().steps[0],
              step_number: index + 1,
              thought: 'x'.repeat(12_000),
              final_answer: 'y'.repeat(24_000),
              tool_calls: Array.from({ length: 3 }, () => ({
                name: 'read_file',
                arguments: { path: 'src/example.ts' },
              })),
              observation: Array.from({ length: 3 }, () => ({
                name: 'read_file',
                status: 'success',
                result: { excerpt: 'z'.repeat(8_000) },
              })),
            })),
          },
        }],
      }),
      /exceeds the local storage limit/u,
    );
    assert.deepEqual((await store.get(session.id)).messages, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('local conversation store persists traces containing repeated file-read results', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'livingwords-conversations-read-traces-'));
  const filePath = join(directory, 'conversations.json');
  const store = createConversationStore(filePath);

  try {
    const session = await store.create();
    const trace = {
      ...exampleTrace(),
      steps: Array.from({ length: 20 }, (_, stepIndex) => ({
        ...exampleTrace().steps[0],
        step_number: stepIndex + 1,
        thought: `Reviewing files for step ${stepIndex + 1}.`,
        tool_calls: Array.from({ length: 3 }, (_, callIndex) => ({
          name: 'read_file',
          arguments: { path: `src/example-${stepIndex}-${callIndex}.ts` },
        })),
        observation: Array.from({ length: 3 }, (_, callIndex) => ({
          name: 'read_file',
          status: 'success',
          result: { excerpt: 'x'.repeat(5_000) },
        })),
        final_answer: null,
      })),
    };

    await store.save({
      ...session,
      messages: [{ role: 'assistant', content: 'Reviewed the project files.', trace }],
    });

    const restored = await createConversationStore(filePath).get(session.id);
    assert.equal(restored.messages[0].trace.steps.length, 20);
    assert.equal(restored.messages[0].trace.steps[0].observation[0].result.excerpt.length, 5_000);
    assert.equal(restored.messages[0].trace.steps[19].observation[2].result.excerpt.length, 5_000);
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
          documentId: fileId,
          name: 'README.md',
          method: 'folder-overview',
          page: null,
          excerpt: 'An automatically selected project overview passage.',
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
    assert.deepEqual(restoredBeforeRemoval.messages[0].contextUsage.map(({ method }) => method), [
      'folder-read',
      'folder-overview',
      'folder-grep',
    ]);
    assert.deepEqual(restoredBeforeRemoval.messages[0].contextUsage.map(({ documentId }) => documentId), [
      fileId,
      fileId,
      otherFileId,
    ]);

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
    await assert.rejects(
      store.save({
        ...created,
        messages: [{
          role: 'assistant',
          content: 'Invalid duration.',
          generationDurationMs: -1,
        }],
      }),
      /generation duration/u,
    );
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
