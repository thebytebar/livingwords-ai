import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createDocumentLibrary,
  sanitizeCitedAnswer,
} from './document-library.mjs';

test('file references index locally, include direct-file content, and never copy or delete originals', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'livingwords-reference-'));
  const sourcePath = join(directory, 'notes.md');
  const libraryPath = join(directory, 'library');
  const sourceText = '# Notes\n\nThe patient garden grows through careful practice and steady attention.';
  await writeFile(sourcePath, sourceText);
  const library = createDocumentLibrary(libraryPath);

  try {
    const result = await library.addFiles([sourcePath], 'conversation-one');
    const [reference] = result.added;
    assert.equal(reference.kind, 'file');
    assert.equal(result.documentCount, 1);
    const listing = await library.list('conversation-one');
    assert.deepEqual(listing.references.map(({ id, kind, name, fileCount }) =>
      ({ id, kind, name, fileCount })), [
      { id: reference.id, kind: 'file', name: 'notes.md', fileCount: 1 },
    ]);
    assert.equal(Object.hasOwn(listing.references[0], 'path'), false);
    assert.equal(await readFile(sourcePath, 'utf8'), sourceText);
    await assert.rejects(stat(join(libraryPath, 'documents')), { code: 'ENOENT' });

    const [source] = await library.retrieve('conversation-one', [reference.id], 'unrelated words');
    assert.match(source.documentId, /^[0-9a-f-]{36}$/u);
    assert.equal(source.name, 'notes.md');
    assert.equal(source.page, null);
    assert.equal(source.excerpt, sourceText);
    assert.deepEqual(await library.list('conversation-two'), {
      references: [],
      files: [],
      documentCount: 0,
      indexedCount: 0,
      unindexedCount: 0,
      overflowCount: 0,
      errors: [],
    });
    await assert.rejects(
      library.retrieve('conversation-two', [reference.id], 'garden'),
      /no longer available to this conversation/u,
    );

    await library.remove(reference.id, 'conversation-one');
    assert.equal((await library.list('conversation-one')).documentCount, 0);
    assert.equal(await readFile(sourcePath, 'utf8'), sourceText);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('folder references recurse, skip hidden entries and symlinks, and deduplicate overlapping files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'livingwords-folder-'));
  const folderPath = join(directory, 'notes');
  const nestedPath = join(folderPath, 'nested');
  const outsidePath = join(directory, 'outside.txt');
  const directPath = join(folderPath, 'direct.txt');
  await mkdir(nestedPath, { recursive: true });
  await mkdir(join(folderPath, '.hidden'));
  await writeFile(directPath, 'Direct file about old growth forests.');
  await writeFile(join(nestedPath, 'field.md'), 'A field guide to native plants.');
  await writeFile(join(folderPath, '.hidden.txt'), 'Hidden text must not be indexed.');
  await writeFile(join(folderPath, '.hidden', 'private.txt'), 'Hidden directory text must not be indexed.');
  await writeFile(outsidePath, 'Outside files are not part of this folder.');
  try {
    await symlink(outsidePath, join(folderPath, 'linked.txt'));
    await symlink(nestedPath, join(folderPath, 'linked-folder'));
  } catch {
    // Some platforms do not allow symlink creation in temporary test directories.
  }
  const library = createDocumentLibrary(join(directory, 'library'));

  try {
    const [direct] = (await library.addFiles([directPath], 'conversation-one')).added;
    const folderResult = await library.addFolder(folderPath, 'conversation-one');
    const folder = folderResult.added[0];
    assert.equal(folder.kind, 'folder');
    assert.equal(folderResult.documentCount, 2);
    const listing = await library.list('conversation-one');
    assert.equal(listing.documentCount, 2);
    assert.equal(listing.references.find((item) => item.id === folder.id).fileCount, 2);
    assert.deepEqual(listing.files.map((file) => file.name), ['direct.txt', join('nested', 'field.md')]);
    assert.equal(listing.files.every((file) => !Object.hasOwn(file, 'path')), true);
    assert.equal(listing.references.find((item) => item.id === direct.id).fileCount, 1);

    const sources = await library.retrieve('conversation-one', [folder.id], 'native plant field guide');
    assert.equal(sources.length, 1);
    assert.equal(sources[0].name, join('nested', 'field.md'));
    assert.match(sources[0].excerpt, /native plants/u);
    assert.deepEqual(await library.retrieve('conversation-one', [folder.id], 'unmatched query terms'), []);

    await library.remove(folder.id, 'conversation-one');
    const remaining = await library.list('conversation-one');
    assert.equal(remaining.documentCount, 1);
    assert.equal(remaining.references.length, 1);
    assert.equal(await readFile(directPath, 'utf8'), 'Direct file about old growth forests.');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('code text files can be viewed and edited only while attached to the conversation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'livingwords-code-file-'));
  const sourcePath = join(directory, 'example.js');
  const jsonPath = join(directory, 'package.json');
  const sourceText = 'export const answer = 42;\n';
  await writeFile(sourcePath, sourceText);
  await writeFile(jsonPath, '{"name":"example"}\n');
  const library = createDocumentLibrary(join(directory, 'library'));

  try {
    const [reference] = (await library.addFiles([sourcePath, jsonPath], 'conversation-one')).added;
    const listing = await library.list('conversation-one');
    const file = listing.files.find((entry) => entry.name === 'example.js');
    assert.equal(file.extension, '.js');
    assert.equal(listing.files.find((entry) => entry.name === 'package.json').extension, '.json');
    assert.deepEqual(await library.readContent('conversation-one', file.id), {
      id: file.id,
      name: 'example.js',
      extension: '.js',
      text: sourceText,
    });
    await assert.rejects(library.readContent('conversation-two', file.id), /not attached to this conversation/u);
    const proposal = await library.prepareEdit('conversation-one', file.id, 'export const answer = 43;\n');
    await library.applyEdit(proposal.proposalId, 'conversation-one');
    assert.equal(await readFile(sourcePath, 'utf8'), 'export const answer = 43;\n');
    assert.equal((await library.list('conversation-one')).references[0].id, reference.id);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('folder inventories discover added files and refresh changed text', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'livingwords-refresh-'));
  const folderPath = join(directory, 'folder');
  const sourcePath = join(folderPath, 'first.txt');
  await mkdir(folderPath);
  await writeFile(sourcePath, 'Initial folder contents for indexing.');
  const library = createDocumentLibrary(join(directory, 'library'));

  try {
    const [folder] = (await library.addFolder(folderPath, 'conversation-one')).added;
    assert.equal((await library.list('conversation-one')).documentCount, 1);
    await writeFile(sourcePath, 'Revised text with a unique hummingbird keyword.');
    const later = new Date(Date.now() + 3_000);
    await utimes(sourcePath, later, later);
    await writeFile(join(folderPath, 'second.md'), 'New file about alpine water cycles.');

    const listing = await library.list('conversation-one');
    assert.equal(listing.documentCount, 2);
    assert.equal(listing.references.find((item) => item.id === folder.id).fileCount, 2);
    const revised = await library.retrieve('conversation-one', [folder.id], 'hummingbird');
    assert.match(revised[0].excerpt, /unique hummingbird keyword/u);
    const added = await library.retrieve('conversation-one', [folder.id], 'alpine water cycles');
    assert.match(added[0].excerpt, /alpine water cycles/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a problem with another folder entry does not prevent viewing a valid attached file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'livingwords-read-valid-file-'));
  const folderPath = join(directory, 'project');
  const docsDirectory = join(folderPath, 'docs');
  const documentPath = join(docsDirectory, 'DESKTOP.md');
  await mkdir(docsDirectory, { recursive: true });
  await writeFile(documentPath, '# Desktop guide\n\nThe document viewer should open this file.');
  await writeFile(join(folderPath, 'empty.txt'), '');
  const library = createDocumentLibrary(join(directory, 'library'));

  try {
    const [folder] = (await library.addFolder(folderPath, 'conversation-one')).added;
    const listing = await library.list('conversation-one');
    const file = listing.files.find((entry) => entry.name === join('docs', 'DESKTOP.md'));
    assert.ok(file);

    const content = await library.readContent('conversation-one', file.id);
    assert.equal(content.name, join('docs', 'DESKTOP.md'));
    assert.match(content.text, /document viewer should open this file/u);
    assert.equal(listing.references[0].id, folder.id);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('indexing terms inherited from Object.prototype does not break folder attachment', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'livingwords-prototype-terms-'));
  const sourcePath = join(directory, 'constructor.txt');
  await writeFile(sourcePath, 'The constructor initializes the model state.');
  const library = createDocumentLibrary(join(directory, 'library'));

  try {
    const [reference] = (await library.addFiles([sourcePath], 'conversation-one')).added;
    const results = await library.search('conversation-one', [reference.id], 'constructor initializes');
    assert.equal(results.length, 1);
    assert.match(results[0].excerpt, /constructor initializes/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('cached folder references reconnect before unavailable paths are refreshed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'livingwords-cached-list-'));
  const folderPath = join(directory, 'folder');
  const movedFolderPath = join(directory, 'folder-temporarily-unavailable');
  await mkdir(folderPath);
  await writeFile(join(folderPath, 'cached.txt'), 'Previously indexed content.');
  const library = createDocumentLibrary(join(directory, 'library'));

  try {
    const [folder] = (await library.addFolder(folderPath, 'conversation-one')).added;
    await rename(folderPath, movedFolderPath);
    const cached = await library.listCached('conversation-one');
    assert.equal(cached.references[0].id, folder.id);
    assert.equal(cached.references[0].fileCount, 1);
    assert.equal(cached.documentCount, 1);
    assert.equal(cached.files[0].name, 'cached.txt');

    await rename(movedFolderPath, folderPath);
    assert.equal((await library.list('conversation-one')).documentCount, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('folder references index more than 100 supported files without an inventory cap', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'livingwords-large-folder-'));
  const folderPath = join(directory, 'many');
  await mkdir(folderPath);
  const documentCount = 125;
  for (let index = 0; index < documentCount; index += 1) {
    await writeFile(join(folderPath, `note-${String(index).padStart(3, '0')}.txt`), `Document number ${index}.`);
  }
  const library = createDocumentLibrary(join(directory, 'library'));

  try {
    const result = await library.addFolder(folderPath, 'conversation-one');
    assert.equal(result.documentCount, documentCount);
    const listing = await library.list('conversation-one');
    assert.equal(listing.documentCount, documentCount);
    assert.equal(listing.indexedCount, documentCount);
    assert.equal(listing.references[0].fileCount, documentCount);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('saved metadata validation accepts inventories with more than 10,000 files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'livingwords-large-metadata-'));
  const libraryPath = join(directory, 'library');
  const sessionId = 'large-inventory';
  const referenceId = '00000000-0000-4000-8000-000000000001';
  const files = Array.from({ length: 10_001 }, (_, index) => ({
    id: `${index.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`,
    sessionId,
    path: join(directory, `file-${index}.txt`),
    name: `file-${index}.txt`,
    extension: '.txt',
    size: 1,
    mtimeMs: 0,
    sha256: '',
    chunkCount: 0,
    indexed: false,
    ignored: false,
    referenceIds: [referenceId],
  }));
  await mkdir(libraryPath);
  await writeFile(join(libraryPath, 'library.json'), `${JSON.stringify({
    version: 2,
    references: [{
      id: referenceId,
      sessionId,
      kind: 'folder',
      name: 'large-inventory',
      path: directory,
      addedAt: new Date().toISOString(),
    }],
    files,
  })}\n`);
  const library = createDocumentLibrary(libraryPath);

  try {
    const listing = await library.listCached(sessionId);
    assert.equal(listing.documentCount, 10_001);
    assert.equal(listing.unindexedCount, 10_001);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('folder search skips ignored paths by default and searches them only on demand', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'livingwords-ignored-search-'));
  const folderPath = join(directory, 'repository');
  await mkdir(join(folderPath, 'node_modules', 'vendor'), { recursive: true });
  await writeFile(join(folderPath, '.gitignore'), 'private.txt\n');
  await writeFile(join(folderPath, 'private.txt'), 'A classified banana is inside this ignored file.');
  await writeFile(join(folderPath, 'node_modules', 'vendor', 'generated.js'), 'Generated widget processing lifecycle.');
  await writeFile(join(folderPath, 'app.js'), 'The application entry point.');
  const library = createDocumentLibrary(join(directory, 'library'));

  try {
    const [folder] = (await library.addFolder(folderPath, 'conversation-one')).added;
    const listing = await library.list('conversation-one');
    assert.deepEqual(listing.files.map(({ name }) => name), ['app.js']);

    assert.deepEqual(await library.search('conversation-one', [folder.id], 'classified banana'), []);
    const ignoredResults = await library.search(
      'conversation-one',
      [folder.id],
      'classified banana',
      { includeIgnored: true },
    );
    assert.equal(ignoredResults[0].name, 'private.txt');
    assert.match(ignoredResults[0].excerpt, /classified banana/u);
    const generatedResults = await library.search(
      'conversation-one',
      [folder.id],
      'generated widget processing',
      { includeIgnored: true },
    );
    assert.equal(generatedResults[0].name, join('node_modules', 'vendor', 'generated.js'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('project overview search prioritizes README and manifest files for broad folder questions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'livingwords-project-overview-'));
  const folderPath = join(directory, 'project');
  await mkdir(join(folderPath, 'src'), { recursive: true });
  await writeFile(join(folderPath, 'README.md'), 'Orchid Atlas helps communities map local gardens and share native plant knowledge.');
  await writeFile(join(folderPath, 'package.json'), '{"name":"orchid-atlas","description":"A local garden mapping application"}');
  await writeFile(join(folderPath, 'src', 'renderer.js'), 'const look = true;');
  const library = createDocumentLibrary(join(directory, 'library'));

  try {
    const [folder] = (await library.addFolder(folderPath, 'conversation-one')).added;
    const sources = await library.search(
      'conversation-one',
      [folder.id],
      'take a look at this project and tell me what it is about README purpose overview architecture application functionality',
      { prioritizeOverview: true },
    );
    assert.equal(sources[0].name, 'README.md');
    assert.match(sources[0].excerpt, /Orchid Atlas helps communities map local gardens/u);
    assert.equal(sources[1].name, 'package.json');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('folder context provides a bounded inventory and deduplicated in-root instructions without file dumps', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'livingwords-folder-context-'));
  const folderPath = join(directory, 'repository');
  await mkdir(join(folderPath, 'src', 'nested', 'deeper'), { recursive: true });
  await mkdir(join(folderPath, '.github'), { recursive: true });
  await writeFile(join(folderPath, 'README.md'), 'Inventory should list this path, not dump this README body.');
  await writeFile(join(folderPath, 'AGENTS.md'), 'Use the project conventions when they do not conflict with system instructions.');
  await writeFile(join(folderPath, 'src', 'CLAUDE.md'), 'Use the project conventions when they do not conflict with system instructions.');
  await writeFile(join(folderPath, '.github', 'copilot-instructions.md'), 'Keep pull requests focused and explain important tradeoffs.');
  await writeFile(join(folderPath, 'src', 'main.js'), 'PRIVATE_SOURCE_BODY_SENTINEL');
  await writeFile(join(folderPath, 'src', 'nested', 'deeper', 'too-deep.txt'), 'Depth-limited content.');
  await writeFile(join(folderPath, 'credentials.json'), '{"password":"do not read"}');
  await writeFile(join(folderPath, '.env'), 'SECRET_SENTINEL');
  for (let index = 0; index < 205; index += 1) {
    await writeFile(join(folderPath, `file-${String(index).padStart(3, '0')}.txt`), `Document ${index}.`);
  }
  const library = createDocumentLibrary(join(directory, 'library'));

  try {
    const [folder] = (await library.addFolder(folderPath, 'conversation-one')).added;
    const [context] = await library.folderContext('conversation-one', [folder.id]);
    assert.equal(context.folderId, folder.id);
    assert.equal(context.fileCount, 211);
    assert.ok(context.inventory.length <= 200);
    assert.ok(context.omittedCount > 0);
    assert.ok(context.inventory.some((entry) => entry === 'F README.md'));
    assert.ok(context.inventory.some((entry) => entry === 'F src/main.js'));
    assert.equal(context.inventory.some((entry) => entry.includes('too-deep.txt')), false);
    assert.equal(context.inventory.some((entry) => entry.includes('credentials.json')), false);
    assert.equal(context.inventory.some((entry) => entry.includes('.env')), false);
    assert.equal(context.inventory.join('\n').includes('PRIVATE_SOURCE_BODY_SENTINEL'), false);
    assert.deepEqual(context.instructions.map(({ path }) => path), [
      '.github/copilot-instructions.md',
      'src/CLAUDE.md',
    ]);
    assert.match(context.instructions[1].text, /project conventions/u);
    assert.equal(Object.hasOwn(context, 'path'), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('folder tools list, page, and grep only safe attached files within hard bounds', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'livingwords-folder-tools-'));
  const folderPath = join(directory, 'repository');
  const docsPath = join(folderPath, 'docs');
  await mkdir(join(docsPath, 'nested'), { recursive: true });
  await writeFile(join(folderPath, '.gitignore'), 'private.txt\n');
  await writeFile(join(folderPath, 'private.txt'), 'ignored needle99 value');
  await writeFile(join(folderPath, 'visible.txt'), 'top-level file');
  await writeFile(join(docsPath, 'guide.txt'), Array.from(
    { length: 2_505 },
    (_, index) => `line${String(index + 1).padStart(4, '0')} needle${index + 1} ${'context '.repeat(4)}`,
  ).join('\n'));
  await writeFile(join(docsPath, 'nested', 'detail.md'), 'Nested architecture note.');
  const library = createDocumentLibrary(join(directory, 'library'));

  try {
    const [folder] = (await library.addFolder(folderPath, 'conversation-one')).added;
    const listing = await library.listDirectory('conversation-one', folder.id, '', 1);
    assert.deepEqual(listing.map(({ kind, path }) => `${kind}:${path}`), [
      'directory:docs',
      'file:visible.txt',
    ]);
    const firstPage = await library.readFolderFile('conversation-one', folder.id, 'docs/guide.txt', 0, 2);
    assert.equal(firstPage.totalLines, 2_505);
    assert.equal(firstPage.nextOffset, 2);
    assert.match(firstPage.text, /line0001 needle1/u);
    assert.match(firstPage.text, /line0002 needle2/u);
    assert.equal(firstPage.truncated, true);
    assert.match(firstPage.text, /\[\.\.\. truncated; use offset\/limit to continue \.\.\.\]/u);
    const nextPage = await library.readFolderFile('conversation-one', folder.id, 'docs/guide.txt', firstPage.nextOffset, 1);
    assert.match(nextPage.text, /line0003 needle3/u);
    const byteBoundedPage = await library.readFolderFile('conversation-one', folder.id, 'docs/guide.txt', 0, 2_000);
    assert.ok(Buffer.byteLength(byteBoundedPage.text, 'utf8') <= 50 * 1024 + 80);
    assert.ok(byteBoundedPage.nextOffset > 0 && byteBoundedPage.nextOffset < 2_000);
    const matches = await library.grep('conversation-one', folder.id, 'needle\\d+', 'docs', '*.txt');
    assert.equal(matches.matches.length, 50);
    assert.equal(matches.matches[0].path, 'docs/guide.txt');
    assert.equal(matches.truncated, true);
    assert.ok(matches.matches.every((match) => match.excerpt.length <= 1_100));
    await assert.rejects(
      library.grep('conversation-one', folder.id, '(needle+)+'),
      /Grep pattern or limits are invalid/u,
    );
    await assert.rejects(
      library.grep('conversation-one', folder.id, 'needle\\w+\\s+value'),
      /Grep pattern or limits are invalid/u,
    );
    await assert.rejects(
      library.readFolderFile('conversation-one', folder.id, '../private.txt'),
      /traversal/u,
    );
    await assert.rejects(
      library.readFolderFile('conversation-one', folder.id, 'private.txt'),
      /ignored or is not/u,
    );
    const explicitIgnoredRead = await library.readFolderFile(
      'conversation-one',
      folder.id,
      'private.txt',
      0,
      2,
      true,
    );
    assert.match(explicitIgnoredRead.text, /ignored needle99 value/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('cache budget evicts inactive conversation indexes and rebuilds them on demand', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'livingwords-cache-budget-'));
  const firstFolder = join(directory, 'first');
  const secondFolder = join(directory, 'second');
  await mkdir(firstFolder);
  await mkdir(secondFolder);
  await writeFile(join(firstFolder, 'first.txt'), `${'orchid taxonomy blossom habitat '.repeat(60)}\n`);
  await writeFile(join(secondFolder, 'second.txt'), `${'granite mineral strata geology '.repeat(60)}\n`);
  const library = createDocumentLibrary(join(directory, 'library'), { cacheBudgetBytes: 10_000 });

  try {
    const [firstReference] = (await library.addFolder(firstFolder, 'conversation-one')).added;
    assert.equal((await library.listCached('conversation-one')).indexedCount, 1);

    await library.addFolder(secondFolder, 'conversation-two');
    assert.equal((await library.listCached('conversation-one')).indexedCount, 0);
    assert.equal((await library.listCached('conversation-two')).indexedCount, 1);

    const results = await library.search('conversation-one', [firstReference.id], 'orchid habitat');
    assert.match(results[0].excerpt, /orchid taxonomy/u);
    assert.equal((await library.listCached('conversation-one')).indexedCount, 1);
    assert.equal((await library.listCached('conversation-two')).indexedCount, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('text edits require a review token, update only after apply, and reject stale proposals', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'livingwords-edit-'));
  const sourcePath = join(directory, 'notes.txt');
  await writeFile(sourcePath, 'Original words in this local file.');
  const library = createDocumentLibrary(join(directory, 'library'));

  try {
    const [reference] = (await library.addFiles([sourcePath], 'conversation-one')).added;
    const [file] = await library.retrieve('conversation-one', [reference.id], 'anything');
    const proposal = await library.prepareEdit('conversation-one', file.documentId, 'Updated words in this local file.');
    assert.equal(await readFile(sourcePath, 'utf8'), 'Original words in this local file.');
    assert.equal(proposal.name, 'notes.txt');
    const applied = await library.applyEdit(proposal.proposalId, 'conversation-one');
    assert.equal(applied.name, 'notes.txt');
    assert.equal(await readFile(sourcePath, 'utf8'), 'Updated words in this local file.');

    const [updated] = await library.retrieve('conversation-one', [reference.id], 'anything');
    const stale = await library.prepareEdit('conversation-one', updated.documentId, 'A stale proposed version.');
    await writeFile(sourcePath, 'A newer user edit that must be preserved.');
    const later = new Date(Date.now() + 3_000);
    await utimes(sourcePath, later, later);
    await assert.rejects(
      library.applyEdit(stale.proposalId, 'conversation-one'),
      /file changed after this diff was prepared/u,
    );
    assert.equal(await readFile(sourcePath, 'utf8'), 'A newer user edit that must be preserved.');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('PDF references retain page provenance and cannot be edited in place', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'livingwords-pdf-'));
  const pdfPath = join(directory, 'book.pdf');
  await writeFile(pdfPath, 'pdf test bytes');
  const library = createDocumentLibrary(join(directory, 'library'), {
    extractPdf: async () => [{ page: 7, text: 'A searchable sentence from page seven.' }],
  });

  try {
    const [reference] = (await library.addFiles([pdfPath], 'conversation-one')).added;
    const [source] = await library.retrieve('conversation-one', [reference.id], 'page seven searchable');
    assert.equal(source.page, 7);
    await assert.rejects(
      library.prepareEdit('conversation-one', source.documentId, 'A changed PDF'),
      /PDFs are read-only/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('unsupported, invalid UTF-8, and scanned PDF references report their limits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'livingwords-validation-'));
  const invalidTextPath = join(directory, 'bad.txt');
  const unsupportedPath = join(directory, 'image.png');
  const pdfPath = join(directory, 'scan.pdf');
  await writeFile(invalidTextPath, Buffer.from([0xff, 0xfe]));
  await writeFile(unsupportedPath, 'not a supported type');
  await writeFile(pdfPath, 'pdf test bytes');
  const library = createDocumentLibrary(join(directory, 'library'), { extractPdf: async () => [] });

  try {
    const result = await library.addFiles([invalidTextPath, unsupportedPath, pdfPath], 'conversation-one');
    assert.equal(result.errors.length, 3);
    assert.match(result.errors.find((item) => item.name === 'bad.txt').error, /valid UTF-8/u);
    assert.match(result.errors.find((item) => item.name === 'image.png').error, /supported text file/u);
    assert.match(result.errors.find((item) => item.name === 'scan.pdf').error, /no selectable text.*OCR are not supported yet/u);
    assert.equal(result.documentCount, 0);
    assert.deepEqual(await library.list('conversation-one').then(({ references }) => references.length), 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('legacy app-managed copies are removed while conversation messages are preserved', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'livingwords-migration-'));
  const sourcePath = join(directory, 'legacy.md');
  const libraryPath = join(directory, 'library');
  await writeFile(sourcePath, 'Legacy source text.');
  const library = createDocumentLibrary(libraryPath);

  try {
    const [reference] = (await library.addFiles([sourcePath], 'legacy-session')).added;
    const addedAt = new Date().toISOString();
    await mkdir(join(libraryPath, 'documents', reference.id), { recursive: true });
    await writeFile(join(libraryPath, 'documents', reference.id, 'original.md'), 'Managed legacy copy.');
    await writeFile(join(libraryPath, 'documents', reference.id, 'chunks.json'), '[]');
    await writeFile(join(libraryPath, 'library.json'), `${JSON.stringify([{
      id: reference.id,
      name: 'legacy.md',
      extension: '.md',
      size: 19,
      chunkCount: 1,
      addedAt,
      sha256: 'a'.repeat(64),
    }])}\n`);
    const session = {
      id: 'legacy-session',
      selectedDocumentIds: [reference.id],
      messages: [{ role: 'assistant', content: 'Past answer [S1].' }],
    };

    const migration = await library.migrateLegacyOwnership([session]);
    assert.deepEqual(migration.changedSessionIds, ['legacy-session']);
    assert.deepEqual(migration.sessions[0].selectedDocumentIds, []);
    assert.deepEqual(migration.sessions[0].messages, session.messages);
    assert.equal((await library.list('legacy-session')).references.length, 0);
    await assert.rejects(stat(join(libraryPath, 'documents')), { code: 'ENOENT' });
    assert.equal(await readFile(sourcePath, 'utf8'), 'Legacy source text.');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('application restart preserves current references and their indexed files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'livingwords-restart-'));
  const sourcePath = join(directory, 'reference.json');
  const libraryPath = join(directory, 'library');
  await writeFile(sourcePath, '{"connection":"persistent"}\n');

  try {
    const firstLibrary = createDocumentLibrary(libraryPath);
    const [reference] = (await firstLibrary.addFiles([sourcePath], 'persisted-session')).added;
    const session = { id: 'persisted-session', selectedDocumentIds: [reference.id] };
    await firstLibrary.migrateLegacyOwnership([session]);

    const restartedLibrary = createDocumentLibrary(libraryPath);
    const startup = await restartedLibrary.migrateLegacyOwnership([session]);
    assert.deepEqual(startup.changedSessionIds, []);
    const listing = await restartedLibrary.list('persisted-session');
    assert.equal(listing.references[0].id, reference.id);
    assert.equal(listing.documentCount, 1);
    assert.equal((await restartedLibrary.readContent('persisted-session', listing.files[0].id)).text,
      '{"connection":"persistent"}\n');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('conversation deletion removes references and indexes but never originals, and rolls back on failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'livingwords-session-delete-'));
  const sourcePath = join(directory, 'source.txt');
  const libraryPath = join(directory, 'library');
  await writeFile(sourcePath, 'Conversation-specific content.');
  const library = createDocumentLibrary(libraryPath);

  try {
    await library.addFiles([sourcePath], 'conversation-one');
    await assert.rejects(
      library.removeSession('conversation-one', async () => {
        throw new Error('Conversation store is unavailable.');
      }),
      /Conversation store is unavailable/u,
    );
    assert.equal((await library.list('conversation-one')).documentCount, 1);
    assert.equal(await readFile(sourcePath, 'utf8'), 'Conversation-specific content.');

    await library.removeSession('conversation-one', async () => {});
    assert.equal((await library.list('conversation-one')).references.length, 0);
    assert.equal(await readFile(sourcePath, 'utf8'), 'Conversation-specific content.');
    assert.deepEqual(await readdir(join(libraryPath, 'cache')), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('invented citations are discarded from grounded answers', () => {
  const result = sanitizeCitedAnswer('Supported [S1]; invented [S2].', [{
    citationId: 'S1',
    documentId: '00000000-0000-4000-8000-000000000001',
    name: 'notes.md',
    page: null,
    excerpt: 'Supported passage.',
  }]);
  assert.equal(result.answer, 'Supported [S1]; invented.');
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].citationId, 'S1');
});
