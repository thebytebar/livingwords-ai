import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  answerQuestion,
  applyCitations,
  buildIndex,
  chunkText,
  readIndex,
  readIndexIfPresent,
  retrieve,
  UNGROUNDED_NOTICE,
  UNSUPPORTED_ANSWER,
  writeIndex,
  type Passage,
  type RagIndex,
} from './rag.js';

test('chunkText creates overlapping chunks and handles empty input', () => {
  const chunks = chunkText('alpha beta gamma delta epsilon zeta eta theta', 18, 5);
  assert.ok(chunks.length > 1);
  assert.ok(chunks[0]!.split(' ').some((word) => chunks[1]!.split(' ').includes(word)));
  assert.equal(chunkText(' \n\t ').length, 0);
  assert.throws(() => chunkText('text', 10, 10), /overlap/u);
});

test('ingestion indexes local text and markdown sources and round-trips the index', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'livingwords-rag-'));
  try {
    await mkdir(join(directory, 'notes'));
    await writeFile(join(directory, 'notes', 'hope.md'), '# Hope\n\nHope is described as patient endurance.', 'utf8');
    await writeFile(join(directory, 'other.txt'), 'Forgiveness is discussed in this source.', 'utf8');
    await writeFile(join(directory, 'ignored.html'), 'This is not indexed.', 'utf8');

    const index = await buildIndex(directory, { chunkSize: 64, overlap: 8 });
    assert.equal(index.passages.length, 2);
    assert.deepEqual(index.passages.map((passage) => passage.source), ['notes/hope.md', 'other.txt']);
    assert.equal(index.passages[0]!.chunk, 1);

    const destination = join(directory, '.livingwords', 'index.json');
    await writeIndex(index, destination);
    const restored = await readIndex(destination);
    assert.deepEqual(restored, index);
    assert.equal((await readFile(destination, 'utf8')).includes('Hope is described'), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('reading a missing index gives first-run ingestion instructions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'livingwords-missing-index-'));
  const missingIndex = join(directory, '.livingwords', 'index.json');
  try {
    await assert.rejects(
      readIndex(missingIndex),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /RAG index not found/u);
        assert.match(error.message, /npx lw ingest <path-to-your-sources>/u);
        assert.ok(error.message.includes('`--index <path>`'), 'custom index option includes a space before its value');
        assert.equal((error.cause as NodeJS.ErrnoException).code, 'ENOENT');
        return true;
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('optional index loading distinguishes an absent index from a populated index', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'livingwords-optional-index-'));
  const missingIndex = join(directory, '.livingwords', 'index.json');
  try {
    assert.equal(await readIndexIfPresent(missingIndex), null);
    const ungrounded = await answerQuestion('What is hope?', await readIndexIfPresent(missingIndex), {
      generate: async () => 'A general answer.',
    });
    assert.equal(ungrounded.grounded, false);
    assert.deepEqual(ungrounded.sources, []);

    const corpus = join(directory, 'sources');
    await mkdir(corpus);
    await writeFile(join(corpus, 'hope.txt'), 'Hope gives strength during hardship.', 'utf8');
    const index = await buildIndex(corpus);
    await writeIndex(index, missingIndex);
    const restored = await readIndexIfPresent(missingIndex);
    assert.deepEqual(restored, index);
    const grounded = await answerQuestion('What gives strength during hardship?', restored, {
      generate: async () => 'The indexed source says hope gives strength during hardship [S1].',
    });
    assert.equal(grounded.grounded, true);
    assert.equal(grounded.sources[0]?.source, 'hope.txt');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('BM25 retrieval ranks the passage sharing the query terms', () => {
  const passages: Passage[] = [
    { id: '1', source: 'hope.txt', chunk: 1, text: 'Hope and patient endurance during hardship.' },
    { id: '2', source: 'plants.txt', chunk: 1, text: 'The garden contains trees and flowers.' },
  ];
  const results = retrieve('patient endurance', passages);
  assert.equal(results[0]!.passage.source, 'hope.txt');
  assert.equal(results.length, 1);
  assert.ok(results[0]!.score > 0);
  assert.deepEqual(retrieve('unrelated astronomy', passages), []);
});

test('citation handling keeps only retrieved source IDs and supplies a source footer', () => {
  const citations = [
    { id: 'S1', source: 'notes/hope.md', chunk: 2 },
    { id: 'S2', source: 'other.txt', chunk: 1 },
  ];
  const withCitation = applyCitations('Hope requires patience [S1]. Fabricated source [S9].', citations);
  assert.equal(withCitation.answer, 'Hope requires patience [S1]. Fabricated source .\n\nSources: [S1] notes/hope.md#2');
  assert.deepEqual(withCitation.sources, [citations[0]]);

  const withoutCitation = applyCitations('The excerpts discuss hope.', citations);
  assert.match(withoutCitation.answer, /Sources consulted: \[S1\] notes\/hope\.md#2; \[S2\] other\.txt#1/u);
  assert.deepEqual(withoutCitation.sources, citations);
});

test('unsupported questions return an explicit uncertainty response without model generation', async () => {
  const index: RagIndex = {
    version: 1,
    createdAt: new Date(0).toISOString(),
    passages: [{ id: '1', source: 'hope.txt', chunk: 1, text: 'Hope gives strength in hardship.' }],
  };
  let called = false;
  const result = await answerQuestion('How do satellites orbit Mars?', index, {
    generate: async () => {
      called = true;
      return 'An answer';
    },
  });
  assert.equal(result.supported, false);
  assert.equal(result.grounded, false);
  assert.equal(result.answer, UNSUPPORTED_ANSWER);
  assert.deepEqual(result.sources, []);
  assert.equal(called, false);
});

test('grounded answer uses retrieved source labels and reports source metadata', async () => {
  const index: RagIndex = {
    version: 1,
    createdAt: new Date(0).toISOString(),
    passages: [{ id: '1', source: 'notes/hope.md', chunk: 2, text: 'Hope is described as patient endurance.' }],
  };
  const result = await answerQuestion('What is hope?', index, {
    generate: async (_system, user) => {
      assert.match(user, /\[S1\] notes\/hope\.md#2/u);
      return 'The source describes hope as patient endurance [S1].';
    },
  });
  assert.equal(result.supported, true);
  assert.equal(result.grounded, true);
  assert.equal(result.answer, 'The source describes hope as patient endurance [S1].\n\nSources: [S1] notes/hope.md#2');
  assert.deepEqual(result.sources, [{ id: 'S1', source: 'notes/hope.md', chunk: 2 }]);
});

test('no-index questions receive a transparent general answer without citations', async () => {
  let capturedSystemPrompt = '';
  let capturedUserPrompt = '';
  const result = await answerQuestion('How do rainbows form?', null, {
    generate: async (systemPrompt, userPrompt) => {
      capturedSystemPrompt = systemPrompt;
      capturedUserPrompt = userPrompt;
      return 'They form when light is refracted and reflected in water droplets.';
    },
  });
  assert.match(capturedSystemPrompt, /No source documents are provided/u);
  assert.match(capturedSystemPrompt, /do not invent citations/u);
  assert.equal(capturedUserPrompt, 'How do rainbows form?');
  assert.equal(result.answer, `${UNGROUNDED_NOTICE}\n\nThey form when light is refracted and reflected in water droplets.`);
  assert.equal(result.supported, false);
  assert.equal(result.grounded, false);
  assert.deepEqual(result.sources, []);
});
