import assert from 'node:assert/strict';
import test from 'node:test';
import {
  contextUsageForDocument,
  documentContextCounts,
  flatContextFileName,
  folderCanExpand,
  mergeRetrievedDocumentIds,
  usedFolderDocuments,
} from './folder-context.mjs';

test('document provenance is grouped by source document across assistant turns only', () => {
  const usage = { documentId: 'doc-a', method: 'folder-read', excerpt: 'source passage' };
  const messages = [
    { role: 'user', contextUsage: [usage] },
    { role: 'assistant', contextUsage: [usage] },
    { role: 'assistant', contextUsage: [{ ...usage, documentId: 'doc-b' }] },
    { role: 'assistant', contextUsage: [{ ...usage, method: 'folder-grep' }] },
    { role: 'assistant', sources: [{ documentId: 'doc-a', name: 'README.md', page: 2, excerpt: 'legacy cited passage' }] },
  ];

  assert.deepEqual(contextUsageForDocument(messages, 'doc-a'), [
    usage,
    { ...usage, method: 'folder-grep' },
    {
      documentId: 'doc-a',
      name: 'README.md',
      method: 'citation',
      page: 2,
      excerpt: 'legacy cited passage',
      truncated: false,
    },
  ]);
  assert.deepEqual(contextUsageForDocument(messages, 'doc-missing'), []);
});

test('folder child rows include only files admitted into conversation context', () => {
  const files = [
    { id: 'readme', name: 'README.md' },
    { id: 'main', name: 'src/main.ts' },
    { id: 'unused', name: 'src/unused.ts' },
  ];

  assert.deepEqual(
    usedFolderDocuments(files, new Set(['readme', 'main'])),
    files.slice(0, 2),
  );
  const unusedFiles = usedFolderDocuments(files, new Set());
  assert.deepEqual(unusedFiles, []);
  assert.equal(folderCanExpand(unusedFiles), false);
  assert.equal(folderCanExpand(files.slice(0, 1)), true);
});

test('flat folder rows show only the filename for slash-separated paths', () => {
  assert.equal(flatContextFileName('src/core/main.ts'), 'main.ts');
  assert.equal(flatContextFileName('src\\core\\main.ts'), 'main.ts');
});

test('document context count shows used attached files over all attached files', () => {
  const files = [
    { id: 'readme', referenceIds: ['folder-a'] },
    { id: 'main', referenceIds: ['folder-a'] },
    { id: 'standalone', referenceIds: ['file-b'] },
    { id: 'other-chat', referenceIds: ['other-chat-folder'] },
  ];

  assert.deepEqual(
    documentContextCounts(files, ['folder-a', 'file-b'], new Set(['readme', 'other-chat'])),
    { used: 1, total: 3 },
  );
  assert.deepEqual(documentContextCounts(files, ['folder-a'], new Set()), { used: 0, total: 2 });
});

test('newly retrieved folder files are merged into the conversation context set', () => {
  const files = [
    { id: 'readme', name: 'README.md' },
    { id: 'main', name: 'src/main.ts' },
  ];
  const session = { retrievedDocumentIds: ['readme'] };

  assert.equal(mergeRetrievedDocumentIds(session, ['main', 'readme']), true);
  assert.deepEqual(session.retrievedDocumentIds, ['readme', 'main']);
  assert.deepEqual(
    usedFolderDocuments(files, new Set(session.retrievedDocumentIds)),
    files,
  );
  assert.equal(mergeRetrievedDocumentIds(session, ['main']), false);
});
