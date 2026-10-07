import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDocumentDiff } from './document-diff.mjs';

test('document diff separates removed, added, and unchanged lines', () => {
  const diff = buildDocumentDiff('before\nold text\nafter', 'before\nnew text\nafter');
  assert.equal(diff.previewable, true);
  assert.equal(diff.unchanged, false);
  assert.deepEqual(diff.lines, [
    { type: 'context', text: 'before' },
    { type: 'removed', text: 'old text' },
    { type: 'added', text: 'new text' },
    { type: 'context', text: 'after' },
  ]);
});

test('document diff bounds very large changes and identifies no-op proposals', () => {
  const tooLarge = buildDocumentDiff('', `${'x\n'.repeat(20_001)}`);
  assert.equal(tooLarge.previewable, false);
  assert.deepEqual(tooLarge.lines, []);
  assert.deepEqual(buildDocumentDiff('unchanged', 'unchanged'), {
    lines: [{ type: 'context', text: 'No content changes.' }],
    previewable: true,
    unchanged: true,
  });
  assert.throws(() => buildDocumentDiff('text', null), /must be text/u);
});
