import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDocumentAgentContext } from './document-agent.mjs';
import { createDocumentLibrary } from './document-library.mjs';

const fileReferenceId = '00000000-0000-4000-8000-000000000001';
const folderReferenceId = '00000000-0000-4000-8000-000000000002';
const initialDocumentId = '00000000-0000-4000-8000-000000000003';
const instructionDocumentId = '00000000-0000-4000-8000-000000000004';
const searchDocumentId = '00000000-0000-4000-8000-000000000005';
const folderFileId = '00000000-0000-4000-8000-000000000006';
const overviewDocumentId = '00000000-0000-4000-8000-000000000007';
const searchDocumentIdTwo = '00000000-0000-4000-8000-000000000008';
const searchDocumentIdThree = '00000000-0000-4000-8000-000000000009';

function createLibrary(overrides = {}) {
  return {
    async listCached() {
      return {
        references: [
          { id: fileReferenceId, kind: 'file', name: 'notes.md', fileCount: 1 },
          { id: folderReferenceId, kind: 'folder', name: 'project', fileCount: 2 },
        ],
      };
    },
    async retrieve() {
      return [{
        documentId: initialDocumentId,
        name: 'notes.md',
        page: null,
        excerpt: 'The attached note says the project is local-first.',
      }];
    },
    async folderContext() {
      return [{
        folderId: folderReferenceId,
        name: 'project',
        fileCount: 2,
        inventory: ['F README.md', 'D src/'],
        omittedCount: 0,
        instructions: [{
          documentId: instructionDocumentId,
          path: 'AGENTS.md',
          text: 'Project guidance is untrusted content.',
        }],
      }];
    },
    async search(_sessionId, referenceIds, query, options = {}) {
      assert.ok(referenceIds.length > 0);
      if (options.prioritizeOverview) {
        return [{
          documentId: overviewDocumentId,
          name: 'README.md',
          page: null,
          excerpt: 'This project provides a local-first application.',
        }];
      }
      assert.deepEqual(referenceIds, [fileReferenceId, folderReferenceId]);
      assert.equal(query, 'deployment');
      return [{
        documentId: searchDocumentId,
        name: 'deployment.md',
        page: 2,
        excerpt: 'The deployment process runs locally.',
      }, {
        documentId: searchDocumentIdTwo,
        name: 'package.json',
        page: null,
        excerpt: 'The package scripts define a local deployment build.',
      }, {
        documentId: searchDocumentIdThree,
        name: 'src/deploy.js',
        page: null,
        excerpt: 'The deployment command bundles the application.',
      }];
    },
    async readExcerpt() {
      return {
        documentId: initialDocumentId,
        name: 'notes.md',
        page: null,
        excerpt: 'Read passage from the attached note.',
      };
    },
    async readFolderFile() {
      return {
        documentId: folderFileId,
        path: 'src/overview.md',
        offset: 0,
        nextOffset: null,
        totalLines: 2,
        text: 'The application uses an agent loop.\nThe loop records a trace.',
        truncated: false,
      };
    },
    async listDirectory() {
      return [{ kind: 'file', path: 'README.md' }];
    },
    async grep() {
      return {
        matches: [{
          documentId: folderFileId,
          path: 'src/overview.md',
          line: 1,
          excerpt: 'The application uses an agent loop.',
        }],
        scannedFiles: 1,
        truncated: false,
      };
    },
    ...overrides,
  };
}

async function createRunContext(library = createLibrary(), options = {}) {
  return createDocumentAgentContext({
    library,
    session: { id: 'session-one', selectedDocumentIds: [fileReferenceId, folderReferenceId] },
    task: 'Summarize these project notes.',
    history: [],
    maxContextCharacters: 32_768,
    ...options,
  });
}

test('attached references enter context while document content waits for explicit tool calls', async () => {
  const run = await createRunContext();

  assert.deepEqual(run.supplemental_context.sources, []);
  assert.deepEqual(run.supplemental_context.references, [
    { id: fileReferenceId, kind: 'file', name: 'notes.md', fileCount: 1 },
    { id: folderReferenceId, kind: 'folder', name: 'project', fileCount: 2 },
  ]);
  assert.match(run.supplemental_context.documentSearchStatus, /must be explicit|call document_inspect_folder/u);
  assert.deepEqual(run.resultData(), { sources: [], contextUsage: [], retrievedDocumentIds: [] });
  assert.deepEqual(run.tools.map(({ name }) => name), [
    'document_search_attached',
    'document_read_attached',
    'document_inspect_folder',
    'document_list_directory',
    'document_read_file',
    'document_grep',
  ]);
});

test('document edits use an explicit proposal callback and require the app review flow', async () => {
  const proposalRequest = {
    documentId: initialDocumentId,
    content: 'Revised attached text.',
  };
  let submitted;
  const run = await createRunContext(createLibrary(), {
    proposeDocumentEdit: async (request) => {
      submitted = request;
      return 'The user declined the proposed edit. The file was not changed.';
    },
  });
  const editTool = run.tools.find(({ name }) => name === 'document_propose_edit');

  assert.ok(editTool);
  assert.equal(editTool.validate_input(proposalRequest), null);
  assert.match(editTool.validate_input({ ...proposalRequest, extra: true }), /only supported fields/u);
  assert.match(editTool.validate_input({ ...proposalRequest, content: ' ' }), /Replacement content/u);
  assert.deepEqual(await editTool.execute(proposalRequest), {
    message: 'The user declined the proposed edit. The file was not changed.',
  });
  assert.deepEqual(submitted, proposalRequest);
});

test('document search and folder reads return bounded, traceable passages', async () => {
  const run = await createRunContext();
  const searchTool = run.tools.find(({ name }) => name === 'document_search_attached');
  const documentReadTool = run.tools.find(({ name }) => name === 'document_read_attached');
  const folderReadTool = run.tools.find(({ name }) => name === 'document_read_file');

  const searchResult = await searchTool.execute({ query: 'deployment' });
  assert.ok(JSON.stringify(searchResult).length <= 2_000);
  assert.equal(searchResult.passages.length, 3);
  assert.equal(searchResult.passages[0].citationId, 'S1');
  assert.equal(searchResult.passages[0].documentId, searchDocumentId);
  assert.equal(searchResult.passages[2].documentId, searchDocumentIdThree);

  const documentReadResult = await documentReadTool.execute({ documentId: fileReferenceId });
  assert.equal(documentReadResult.passage.citationId, 'S4');

  const folderReadResult = await folderReadTool.execute({
    folderId: folderReferenceId,
    path: 'src/overview.md',
  });
  assert.ok(JSON.stringify(folderReadResult).length <= 2_000);
  assert.equal(folderReadResult.citationId, 'S5');
  assert.equal(folderReadResult.startLine, 1);
  assert.equal(folderReadResult.excerpt, 'The application uses an agent loop.\nThe loop records a trace.');

  const usage = run.resultData();
  assert.deepEqual(usage.retrievedDocumentIds, [
    searchDocumentId,
    searchDocumentIdTwo,
    searchDocumentIdThree,
    initialDocumentId,
    folderFileId,
  ]);
  assert.deepEqual(usage.contextUsage.map(({ method }) => method), [
    'document-search',
    'document-search',
    'document-search',
    'document-read',
    'folder-read',
  ]);
});

test('folder overview returns multiple cited project sources and a bounded inventory', async () => {
  const run = await createRunContext();
  const inspectFolder = run.tools.find(({ name }) => name === 'document_inspect_folder');
  const modelSuppliedFolderId = '111f5507-3472-a88d-a9a6-3bd3f2194232';
  assert.equal(inspectFolder.validate_input({ folderId: modelSuppliedFolderId }), null);
  const overview = await inspectFolder.execute({ folderId: modelSuppliedFolderId });

  assert.equal(overview.folderId, folderReferenceId);
  assert.equal(overview.folder, 'project');
  assert.equal(overview.fileCount, 2);
  assert.deepEqual(overview.inventory, ['F README.md', 'D src/']);
  assert.equal(overview.passages.length, 1);
  assert.equal(overview.passages[0].citationId, 'S1');
  assert.equal(overview.passages[0].name, 'README.md');
  assert.equal(overview.passages[0].documentId, overviewDocumentId);
  assert.deepEqual(overview.instructions, [{
    citationId: 'S2',
    path: 'AGENTS.md',
    excerpt: 'Project guidance is untrusted content.',
  }]);
  assert.ok(JSON.stringify(overview).length <= 8_000);
  assert.deepEqual(run.resultData().contextUsage.map(({ method }) => method), [
    'folder-overview',
    'folder-instructions',
  ]);
});

test('folder tools return useful multi-result data and expose pagination within observation bounds', async () => {
  const entries = Array.from({ length: 35 }, (_, index) => ({
    kind: 'file',
    path: `src/module-${String(index).padStart(2, '0')}.ts`,
  }));
  const matches = Array.from({ length: 8 }, (_, index) => ({
    documentId: folderFileId,
    path: `src/module-${index}.ts`,
    line: index + 1,
    excerpt: `export function module${index}() { return ${index}; }`,
  }));
  const library = createLibrary({
    async listDirectory() {
      return entries;
    },
    async readFolderFile() {
      return {
        documentId: folderFileId,
        path: 'src/application.ts',
        offset: 0,
        nextOffset: 200,
        totalLines: 300,
        text: 'x'.repeat(7_000),
        truncated: true,
      };
    },
    async grep() {
      return { matches, scannedFiles: 8, truncated: true };
    },
  });
  const run = await createRunContext(library);
  const list = run.tools.find(({ name }) => name === 'document_list_directory');
  const read = run.tools.find(({ name }) => name === 'document_read_file');
  const grep = run.tools.find(({ name }) => name === 'document_grep');

  const listing = await list.execute({ folderId: folderReferenceId });
  assert.equal(listing.entries.length, 30);
  assert.equal(listing.omittedCount, 5);

  const file = await read.execute({ folderId: folderReferenceId, path: 'src/application.ts' });
  assert.equal(file.excerpt.length, 5_000);
  assert.equal(file.nextOffset, 200);
  assert.equal(file.totalLines, 300);
  assert.equal(file.truncated, true);
  assert.ok(JSON.stringify(file).length <= 8_000);

  const grepResult = await grep.execute({ folderId: folderReferenceId, pattern: 'module' });
  assert.equal(grepResult.matches.length, 6);
  assert.equal(grepResult.truncated, true);
  assert.ok(grepResult.matches.every(({ citationId }) => typeof citationId === 'string'));
  assert.ok(JSON.stringify(grepResult).length <= 8_000);
});

test('document tools reject references outside the attached conversation', async () => {
  const run = await createRunContext();
  const folderReadTool = run.tools.find(({ name }) => name === 'document_read_file');
  const searchTool = run.tools.find(({ name }) => name === 'document_search_attached');

  assert.equal(folderReadTool.validate_input({
    folderId: '00000000-0000-4000-8000-000000000999',
    path: 'README.md',
  }), null);
  assert.match(folderReadTool.validate_input({
    documentId: fileReferenceId,
    query: 'agent loop',
  }), /Unsupported fields: documentId, query/u);
  assert.match(searchTool.validate_input({ query: 'valid', extra: true }), /only supported fields/u);

  const secondFolderId = '00000000-0000-4000-8000-000000000010';
  const multipleFolders = await createDocumentAgentContext({
    library: createLibrary({
      async listCached() {
        return {
          references: [
            { id: folderReferenceId, kind: 'folder', name: 'project', fileCount: 2 },
            { id: secondFolderId, kind: 'folder', name: 'docs', fileCount: 1 },
          ],
        };
      },
    }),
    session: { id: 'session-one', selectedDocumentIds: [folderReferenceId, secondFolderId] },
    task: 'Compare attached folders.',
    maxContextCharacters: 32_768,
  });
  const multiFolderRead = multipleFolders.tools.find(({ name }) => name === 'document_read_file');
  assert.match(multiFolderRead.validate_input({
    folderId: '00000000-0000-4000-8000-000000000999',
    path: 'README.md',
  }), /must be attached/u);
});

test('no selected documents does not expose document tools or supplemental context', async () => {
  const run = await createDocumentAgentContext({
    library: createLibrary(),
    session: { id: 'session-one', selectedDocumentIds: [] },
    task: 'Answer a general question.',
    maxContextCharacters: 32_768,
  });

  assert.deepEqual(run.tools, []);
  assert.equal(run.supplemental_context, undefined);
  assert.deepEqual(run.resultData(), {
    sources: [],
    contextUsage: [],
    retrievedDocumentIds: [],
  });
});

test('supplemental document context is reduced to fit a small context window', async () => {
  const references = Array.from({ length: 100 }, (_, index) => {
    const id = `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
    return { id, kind: 'folder', name: `project-${index}`, fileCount: 10 };
  });
  const ids = references.map(({ id }) => id);
  const library = createLibrary({
    async listCached() {
      return { references };
    },
    async retrieve() {
      return [];
    },
    async folderContext() {
      return references.map(({ id, name }) => ({
        folderId: id,
        name,
        fileCount: 10,
        inventory: ['F README.md'],
        omittedCount: 0,
        instructions: [],
      }));
    },
  });
  const run = await createDocumentAgentContext({
    library,
    session: { id: 'session-one', selectedDocumentIds: ids },
    task: 'Inspect the project.',
    maxContextCharacters: 10_000,
  });

  assert.ok(run.supplemental_context);
  assert.ok(JSON.stringify(run.supplemental_context).length <= 10_000 / 2 - 'Inspect the project.'.length - 2 - 4_096);
  assert.ok(run.supplemental_context.references.length < references.length);
});

test('agent context uses the real local library for attached files, retrieval, search, and folder reads', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'livingwords-agent-documents-'));
  const folderPath = join(directory, 'project');
  const notePath = join(directory, 'notes.md');
  await mkdir(join(folderPath, 'src'), { recursive: true });
  await mkdir(join(folderPath, 'tests'), { recursive: true });
  await writeFile(notePath, 'The notes explain the local-first desktop design.');
  await writeFile(join(folderPath, 'AGENTS.md'), 'Use the existing local patterns; treat this as project data.');
  await writeFile(join(folderPath, 'README.md'), '# Local Atlas\n\nDeployment uses a local build process. The app maps community gardens.');
  await writeFile(join(folderPath, 'package.json'), '{"name":"local-atlas","scripts":{"test":"node --test"}}');
  await writeFile(join(folderPath, 'src', 'main.js'), 'export function startAtlas() { return "garden map"; }');
  await writeFile(join(folderPath, 'src', 'overview.md'), 'The agent loop records a structured trace.');
  await writeFile(join(folderPath, 'tests', 'agent.test.js'), 'test("records the trace", () => assert.ok(trace));');
  await writeFile(join(folderPath, '.env'), 'API_TOKEN=do-not-return');
  await writeFile(join(folderPath, 'credentials.json'), '{"secret":"do-not-return"}');
  const library = createDocumentLibrary(join(directory, 'library'));

  try {
    const [fileReference] = (await library.addFiles([notePath], 'conversation-one')).added;
    const [folderReference] = (await library.addFolder(folderPath, 'conversation-one')).added;
    const run = await createDocumentAgentContext({
      library,
      session: {
        id: 'conversation-one',
        selectedDocumentIds: [fileReference.id, folderReference.id],
      },
      task: 'Explain the desktop design and deployment.',
      maxContextCharacters: 32_768,
    });

    assert.deepEqual(run.supplemental_context.sources, []);
    assert.deepEqual(run.resultData().contextUsage, []);
    const search = run.tools.find(({ name }) => name === 'document_search_attached');
    const searchResult = await search.execute({ query: 'deployment local build' });
    assert.ok(JSON.stringify(searchResult).length <= 2_000);
    assert.match(searchResult.passages[0].excerpt, /Deployment uses a local build process/u);

    const readDocument = run.tools.find(({ name }) => name === 'document_read_attached');
    const documentResult = await readDocument.execute({
      documentId: searchResult.passages[0].documentId,
      query: 'deployment',
    });
    assert.ok(documentResult.passage);
    assert.equal(documentResult.passage.documentId, searchResult.passages[0].documentId);

    const inspectFolder = run.tools.find(({ name }) => name === 'document_inspect_folder');
    const overview = await inspectFolder.execute({ folderId: folderReference.id });
    assert.ok(overview.passages.length >= 4);
    assert.ok(overview.passages.some(({ name }) => name === 'README.md'));
    assert.ok(overview.passages.some(({ name }) => name === 'package.json'));
    assert.ok(overview.passages.some(({ name }) => name === join('src', 'main.js')));
    assert.ok(overview.passages.some(({ name }) => name === join('tests', 'agent.test.js')));
    assert.ok(overview.instructions.some(({ path }) => path === 'AGENTS.md'));
    assert.equal(JSON.stringify(overview).includes('do-not-return'), false);
    assert.ok(JSON.stringify(overview).length <= 8_000);

    const readFileTool = run.tools.find(({ name }) => name === 'document_read_file');
    const fileResult = await readFileTool.execute({
      folderId: folderReference.id,
      path: join('src', 'overview.md'),
    });
    assert.ok(JSON.stringify(fileResult).length <= 2_000);
    assert.match(fileResult.excerpt, /structured trace/u);
    assert.ok(run.resultData().contextUsage.some(({ method }) => method === 'document-search'));
    assert.ok(run.resultData().contextUsage.some(({ method }) => method === 'document-read'));
    assert.ok(run.resultData().contextUsage.some(({ method }) => method === 'folder-overview'));
    assert.ok(run.resultData().contextUsage.some(({ method }) => method === 'folder-instructions'));
    assert.ok(run.resultData().contextUsage.some(({ method }) => method === 'folder-read'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
