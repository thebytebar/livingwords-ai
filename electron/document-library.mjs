import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, extname, join, relative, sep } from 'node:path';
import { extractPdfPages } from './pdf-text.mjs';
import ignore from 'ignore';

const LIBRARY_VERSION = 2;
const MAX_LIBRARY_ENTRY_COUNT = 100_000;
const MAX_REFERENCES_PER_SESSION = 100;
const MAX_IMPORT_COUNT = 20;
export const MAX_DOCUMENT_CONTEXT_CHARS = 12_000;
const MAX_FILE_SIZE = 20 * 1024 * 1024;
export const MAX_DOCUMENT_CACHE_BYTES = 250 * 1024 * 1024;
const MAX_SEARCH_RESULTS = 5;
const MAX_TOOL_RESULT_CHARS = 4_000;
const MAX_IGNORED_SEARCH_FILES = 500;
const MAX_IGNORED_SEARCH_BYTES = 50 * 1024 * 1024;
const MAX_FOLDER_INVENTORY_DEPTH = 3;
const MAX_FOLDER_INVENTORY_ENTRIES = 200;
const MAX_FOLDER_INSTRUCTION_FILES = 8;
const MAX_FOLDER_INSTRUCTION_FILE_BYTES = 64 * 1024;
const MAX_FOLDER_INSTRUCTION_CHARS = 8_000;
const MAX_FOLDER_READ_BYTES = 50 * 1024;
const MAX_FOLDER_READ_LINES = 2_000;
const MAX_GREP_PATTERN_LENGTH = 256;
const MAX_GREP_FILES = 100;
const MAX_GREP_TOTAL_BYTES = 5 * 1024 * 1024;
const MAX_GREP_MATCHES = 50;
const MAX_GREP_RESULT_CHARS = 8_000;
const SEARCH_INDEX_VERSION = 1;
const MAX_EXTRACTED_LENGTH = 1_500_000;
const MAX_DOCUMENT_CHUNKS = 2_000;
const MAX_CHUNK_LENGTH = 1_600;
const CHUNK_OVERLAP = 160;
const TEXT_EXTENSIONS = new Set([
  '.asm', '.bat', '.bib', '.c', '.cc', '.cfg', '.cjs', '.clj', '.cmake', '.conf', '.cpp', '.cs',
  '.css', '.csv', '.cxx', '.dart', '.diff', '.dockerfile', '.env', '.erl', '.ex', '.exs', '.fish',
  '.fs', '.fsi', '.fsx', '.go', '.graphql', '.h', '.hpp', '.hrl', '.hs', '.htm', '.html', '.ini',
  '.java', '.jl', '.js', '.json', '.jsonc', '.jsx', '.kt', '.kts', '.less', '.log', '.lua', '.m',
  '.make', '.md', '.markdown', '.mjs', '.mm', '.php', '.pl', '.properties', '.proto', '.ps1', '.py',
  '.r', '.rb', '.rst', '.rs', '.sass', '.scala', '.scss', '.sh', '.sql', '.srt', '.swift', '.svg',
  '.tex', '.text', '.toml', '.ts', '.tsx', '.tsv', '.txt', '.vue', '.xml', '.yaml', '.yml', '.zsh',
]);
export const SUPPORTED_DOCUMENT_EXTENSIONS = Object.freeze([
  ...[...TEXT_EXTENSIONS].map((extension) => extension.slice(1)),
  'pdf',
]);
const SUPPORTED_EXTENSIONS = new Set([...TEXT_EXTENSIONS, '.pdf']);
const EDITABLE_EXTENSIONS = TEXT_EXTENSIONS;
const SEARCH_STOP_WORDS = new Set([
  'a', 'about', 'after', 'all', 'also', 'am', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'because',
  'been', 'before', 'being', 'between', 'both', 'but', 'by', 'can', 'could', 'did', 'do', 'does',
  'doing', 'for', 'from', 'had', 'has', 'have', 'he', 'her', 'here', 'him', 'his', 'how', 'i', 'if',
  'in', 'into', 'is', 'it', 'its', 'just', 'me', 'more', 'most', 'my', 'no', 'not', 'of', 'on', 'or',
  'our', 'out', 'please', 'said', 'she', 'should', 'so', 'some', 'such', 'than', 'that', 'the', 'their',
  'them', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'to', 'too', 'under', 'up',
  'was', 'we', 'were', 'what', 'when', 'where', 'which', 'who', 'why', 'will', 'with', 'would', 'you',
  'your',
]);
const GENERATED_PATHS = [
  'bower_components/',
  'coverage/',
  'node_modules/',
  'dist/',
  'build/',
  'Pods/',
  'target/',
  'vendor/',
  'venv/',
  '__pycache__/',
  '.next/',
  '.parcel-cache/',
  'out/',
];
const PROJECT_INSTRUCTION_FILES = new Set([
  'agents.md',
  'claude.md',
  'gemini.md',
  'codex.md',
  'copilot.md',
  'copilot-instructions.md',
  'copilot_instructions.md',
]);
const SENSITIVE_FILE_NAME = /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|credentials?(?:[._-].*)?|secrets?(?:[._-].*)?|service[-_]?account(?:[._-].*)?|id_(?:rsa|dsa|ed25519)|.*\.(?:pem|key|p12|pfx))$/iu;

function isSensitiveFile(path) {
  return SENSITIVE_FILE_NAME.test(basename(path));
}

function isSafeFolderPattern(pattern) {
  if (/\\[1-9]|\)[+*?{]/u.test(pattern)) return false;
  let inCharacterClass = false;
  let quantifiers = 0;
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '\\') {
      const escaped = pattern[index + 1];
      if ((escaped === 'p' || escaped === 'P' || escaped === 'u')
        && pattern[index + 2] === '{') {
        const end = pattern.indexOf('}', index + 3);
        if (end === -1) return false;
        index = end;
      } else {
        index += 1;
      }
      continue;
    }
    if (character === '[') {
      inCharacterClass = true;
      continue;
    }
    if (character === ']' && inCharacterClass) {
      inCharacterClass = false;
      continue;
    }
    if (inCharacterClass) continue;
    if (character === '?' && pattern[index - 1] === '(') continue;
    if (character === '*' || character === '+' || character === '?') {
      quantifiers += 1;
      continue;
    }
    if (character === '{') {
      const end = pattern.indexOf('}', index + 1);
      if (end === -1) continue;
      const range = pattern.slice(index + 1, end);
      if (!/^\d+(?:,\d*)?$/u.test(range)) continue;
      quantifiers += 1;
      index = end;
    }
  }
  return quantifiers <= 1;
}

function folderFilePriority(path) {
  const name = basename(path).toLocaleLowerCase();
  if (/^readme(?:\.[^.]*)?$/u.test(name)) return 0;
  if (PROJECT_INSTRUCTION_FILES.has(name)) return 1;
  if (/^(?:package\.json|pyproject\.toml|cargo\.toml|go\.mod|composer\.json|pom\.xml|makefile)$/u.test(name)) return 2;
  if (/^(?:index|main)\.(?:cjs|js|mjs|ts|tsx|py|go|rs)$/u.test(name)) return 3;
  return 10;
}

function normalizeFolderRelativePath(path, allowRoot = false) {
  if (typeof path !== 'string' || path.length > 1_024 || path.includes('\0')) {
    throw new Error('Folder path is invalid.');
  }
  const normalized = path.replaceAll('\\', '/');
  if (normalized.startsWith('/') || /^[a-z]:/iu.test(normalized)) {
    throw new Error('Folder path must be relative to the selected folder.');
  }
  const segments = normalized.split('/').filter(Boolean);
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error('Folder path cannot contain traversal segments.');
  }
  if (!allowRoot && segments.length === 0) throw new Error('A relative file path is required.');
  return segments;
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeText(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('The document contains no readable text.');
  }
  if (value.includes('\0')) throw new Error('The document is not a supported text file.');
  const normalized = value.replaceAll('\r\n', '\n').replaceAll('\r', '\n').trim();
  if (normalized.length > MAX_EXTRACTED_LENGTH) {
    throw new Error(`Extracted text exceeds the ${MAX_EXTRACTED_LENGTH.toLocaleString()} character limit.`);
  }
  return normalized;
}

function splitText(text) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + MAX_CHUNK_LENGTH, text.length);
    if (end < text.length) {
      const boundary = Math.max(text.lastIndexOf('\n', end), text.lastIndexOf(' ', end));
      if (boundary > start + Math.floor(MAX_CHUNK_LENGTH * 0.6)) end = boundary;
    }
    const chunk = text.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= text.length) break;
    start = Math.max(start + 1, end - CHUNK_OVERLAP);
  }
  return chunks;
}

function createChunks(pages) {
  let extractedLength = 0;
  let chunkIndex = 0;
  const chunks = [];
  const fullText = [];
  const normalizedPages = [];
  for (const { page, text } of pages) {
    const normalized = normalizeText(text);
    extractedLength += normalized.length;
    if (extractedLength > MAX_EXTRACTED_LENGTH) {
      throw new Error(`Extracted text exceeds the ${MAX_EXTRACTED_LENGTH.toLocaleString()} character limit.`);
    }
    normalizedPages.push({ page, text: normalized });
    fullText.push(page === null ? normalized : `[Page ${page}]\n${normalized}`);
    for (const chunk of splitText(normalized)) {
      chunks.push({ index: chunkIndex++, page, text: chunk });
      if (chunks.length > MAX_DOCUMENT_CHUNKS) {
        throw new Error(`The document exceeds the ${MAX_DOCUMENT_CHUNKS.toLocaleString()} passage limit.`);
      }
    }
  }
  return { chunks, fullText: fullText.join('\n\n'), pages: normalizedPages };
}

function tokenize(value) {
  return (value.toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])
    .filter((term) => !SEARCH_STOP_WORDS.has(term));
}

function rankChunks(chunks, query) {
  const queryTerms = new Set(tokenize(query));
  if (queryTerms.size === 0) return [];
  const tokenized = chunks.map(({ chunk }) => tokenize(chunk.text));
  const documentFrequency = new Map();
  for (const terms of tokenized) {
    for (const term of new Set(terms)) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }
  const averageLength = tokenized.reduce((sum, terms) => sum + terms.length, 0) / Math.max(tokenized.length, 1);
  return chunks.map((entry, index) => {
    const terms = tokenized[index];
    let score = 0;
    for (const term of queryTerms) {
      const count = terms.filter((item) => item === term).length;
      if (!count) continue;
      const frequency = documentFrequency.get(term) ?? 0;
      const inverseFrequency = Math.log(1 + (chunks.length - frequency + 0.5) / (frequency + 0.5));
      const normalizedFrequency = count * 2.2
        / (count + 1.2 * (0.25 + 0.75 * terms.length / Math.max(averageLength, 1)));
      score += inverseFrequency * normalizedFrequency;
    }
    return { ...entry, score };
  }).filter(({ score }) => score > 0).sort((left, right) => right.score - left.score);
}

function createSearchIndex() {
  return {
    version: SEARCH_INDEX_VERSION,
    chunkCount: 0,
    totalTerms: 0,
    postings: {},
  };
}

function removeFileFromSearchIndex(index, fileId) {
  const removedChunks = new Map();
  for (const [term, postings] of Object.entries(index.postings)) {
    for (const posting of postings) {
      if (posting[0] === fileId) removedChunks.set(posting[1], posting[3]);
    }
    const retained = postings.filter((posting) => posting[0] !== fileId);
    if (retained.length === 0) delete index.postings[term];
    else if (retained.length !== postings.length) index.postings[term] = retained;
  }
  index.chunkCount -= removedChunks.size;
  index.totalTerms -= [...removedChunks.values()].reduce((total, length) => total + length, 0);
}

function addFileToSearchIndex(index, fileId, chunks) {
  for (const chunk of chunks) {
    const counts = new Map();
    const terms = tokenize(chunk.text);
    for (const term of terms) counts.set(term, (counts.get(term) ?? 0) + 1);
    for (const [term, count] of counts) {
      let postings = Object.hasOwn(index.postings, term) ? index.postings[term] : undefined;
      if (postings === undefined) {
        postings = [];
        index.postings[term] = postings;
      }
      if (!Array.isArray(postings)) {
        throw new Error('The local document search index contains invalid term postings.');
      }
      postings.push([fileId, chunk.index, count, terms.length]);
    }
    index.chunkCount += 1;
    index.totalTerms += terms.length;
  }
}

function rankIndexedChunks(index, query, maximumResults) {
  const queryTerms = new Set(tokenize(query));
  if (queryTerms.size === 0) return [];
  const candidates = new Map();
  const averageLength = index.totalTerms / Math.max(index.chunkCount, 1);
  for (const term of queryTerms) {
    const postings = Object.hasOwn(index.postings, term) ? index.postings[term] : [];
    if (!Array.isArray(postings)) {
      throw new Error('The local document search index contains invalid term postings.');
    }
    const inverseFrequency = Math.log(1 + (index.chunkCount - postings.length + 0.5) / (postings.length + 0.5));
    for (const posting of postings) {
      if (!Array.isArray(posting) || posting.length !== 4
        || typeof posting[0] !== 'string' || !Number.isSafeInteger(posting[1])
        || !Number.isSafeInteger(posting[2]) || !Number.isSafeInteger(posting[3])) {
        throw new Error('The local document search index contains an invalid posting.');
      }
      const [fileId, chunkIndex, count, length] = posting;
      const key = `${fileId}:${chunkIndex}`;
      const previous = candidates.get(key) ?? { fileId, chunkIndex, score: 0 };
      previous.score += inverseFrequency * count * 2.2
        / (count + 1.2 * (0.25 + 0.75 * length / Math.max(averageLength, 1)));
      candidates.set(key, previous);
    }
  }
  return [...candidates.values()]
    .sort((left, right) => right.score - left.score)
    .slice(0, maximumResults);
}

function projectOverviewPriority(file) {
  const normalized = file.name.replaceAll('\\', '/').toLocaleLowerCase();
  if (/^readme(?:\.[^/]*)?$/u.test(normalized)) return 0;
  if (/^(?:package\.json|pyproject\.toml|cargo\.toml|go\.mod|composer\.json|pom\.xml)$/u.test(normalized)) return 1;
  if (/^(?:src\/)?(?:index|main)\.(?:cjs|js|mjs|ts|tsx|py|go|rs)$/u.test(normalized)) return 2;
  if (/^(?:docs\/)?(?:overview|architecture|introduction|about)\.(?:md|markdown|txt)$/u.test(normalized)) return 3;
  return Number.MAX_SAFE_INTEGER;
}

function validateSearchIndex(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.version !== SEARCH_INDEX_VERSION
    || !Number.isSafeInteger(value.chunkCount) || value.chunkCount < 0
    || !Number.isSafeInteger(value.totalTerms) || value.totalTerms < 0
    || !value.postings || typeof value.postings !== 'object' || Array.isArray(value.postings)) {
    throw new Error('The local document search index is invalid.');
  }
  return value;
}

function validateId(id) {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/u.test(id)) {
    throw new Error('Document ID is invalid.');
  }
  return id;
}

function validateSessionId(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 128) {
    throw new Error('Conversation ID is invalid.');
  }
  return sessionId;
}

function isWithin(root, target) {
  const path = relative(root, target);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !path.startsWith(sep));
}

function validateMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.version !== LIBRARY_VERSION || !Array.isArray(value.references) || !Array.isArray(value.files)
    || value.references.length + value.files.length > MAX_LIBRARY_ENTRY_COUNT) {
    throw new Error('The saved document library is invalid.');
  }
  const referenceIds = new Set();
  const references = value.references.map((reference) => {
    if (!reference || typeof reference !== 'object' || Array.isArray(reference)
      || typeof reference.id !== 'string' || !/^[0-9a-f-]{36}$/u.test(reference.id)
      || typeof reference.sessionId !== 'string' || !reference.sessionId || reference.sessionId.length > 128
      || !['file', 'folder'].includes(reference.kind)
      || typeof reference.name !== 'string' || !reference.name || reference.name.length > 255
      || typeof reference.path !== 'string' || !reference.path || reference.path.includes('\0')
      || typeof reference.addedAt !== 'string' || !Number.isFinite(Date.parse(reference.addedAt))) {
      throw new Error('The saved document library contains an invalid reference.');
    }
    if (referenceIds.has(reference.id)) throw new Error('The saved document library contains duplicate IDs.');
    referenceIds.add(reference.id);
    return {
      id: reference.id,
      sessionId: reference.sessionId,
      kind: reference.kind,
      name: reference.name,
      path: reference.path,
      addedAt: reference.addedAt,
    };
  });
  const fileIds = new Set();
  const files = value.files.map((file) => {
    const indexed = file?.indexed !== false;
    if (!file || typeof file !== 'object' || Array.isArray(file)
      || typeof file.id !== 'string' || !/^[0-9a-f-]{36}$/u.test(file.id)
      || typeof file.sessionId !== 'string' || !file.sessionId || file.sessionId.length > 128
      || typeof file.path !== 'string' || !file.path || file.path.includes('\0')
      || typeof file.name !== 'string' || !file.name || file.name.length > 1_024
      || typeof file.extension !== 'string' || !SUPPORTED_EXTENSIONS.has(file.extension)
      || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > MAX_FILE_SIZE
      || !Number.isFinite(file.mtimeMs) || file.mtimeMs < 0
      || typeof file.sha256 !== 'string'
      || (indexed ? !/^[0-9a-f]{64}$/u.test(file.sha256) : file.sha256 !== '')
      || !Number.isSafeInteger(file.chunkCount) || file.chunkCount < (indexed ? 1 : 0)
      || typeof file.indexed !== 'undefined' && typeof file.indexed !== 'boolean'
      || typeof file.ignored !== 'undefined' && typeof file.ignored !== 'boolean'
      || !Array.isArray(file.referenceIds)
      || file.referenceIds.some((id) => typeof id !== 'string' || !referenceIds.has(id))) {
      throw new Error('The saved document library contains an invalid indexed file.');
    }
    if (fileIds.has(file.id)) throw new Error('The saved document library contains duplicate file IDs.');
    fileIds.add(file.id);
    return {
      id: file.id,
      sessionId: file.sessionId,
      path: file.path,
      name: file.name,
      extension: file.extension,
      size: file.size,
      mtimeMs: file.mtimeMs,
      sha256: file.sha256,
      chunkCount: file.chunkCount,
      indexed,
      ignored: file.ignored === true,
      referenceIds: [...new Set(file.referenceIds)],
    };
  });
  return { version: LIBRARY_VERSION, references, files };
}

export function sanitizeCitedAnswer(answer, sources) {
  const sourceMap = new Map(sources.map((source) => [source.citationId, source]));
  const citedIds = [];
  const sanitized = answer.replace(/\[S(\d{1,3})\]/gu, (marker, number) => {
    const citationId = `S${number}`;
    if (!sourceMap.has(citationId)) return '';
    if (!citedIds.includes(citationId)) citedIds.push(citationId);
    return marker;
  });
  return {
    answer: sanitized.replace(/[ \t]{2,}/gu, ' ').replace(/ +([,.;!?])/gu, '$1'),
    sources: citedIds.map((citationId) => {
      const { citationId: _citationId, ...source } = sourceMap.get(citationId);
      return { ...source, citationId };
    }),
  };
}

export function createDocumentLibrary(rootDirectory, {
  extractPdf = extractPdfPages,
  cacheBudgetBytes = MAX_DOCUMENT_CACHE_BYTES,
} = {}) {
  if (!Number.isSafeInteger(cacheBudgetBytes) || cacheBudgetBytes < 1
    || cacheBudgetBytes > MAX_DOCUMENT_CACHE_BYTES) {
    throw new Error('The local document cache budget is invalid.');
  }
  const indexPath = join(rootDirectory, 'library.json');
  const legacyDocumentsDirectory = join(rootDirectory, 'documents');
  const cacheDirectory = join(rootDirectory, 'cache');
  let mutationQueue = Promise.resolve();
  let metadataCache = null;
  const editProposals = new Map();

  function serializeMutation(operation) {
    const result = mutationQueue.then(operation);
    mutationQueue = result.catch(() => {});
    return result;
  }

  async function readIndex() {
    if (metadataCache) return metadataCache;
    let content;
    try {
      content = await readFile(indexPath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') {
        metadataCache = { version: LIBRARY_VERSION, references: [], files: [] };
        return metadataCache;
      }
      throw new Error(`Could not read the local document library: ${error.message}`, { cause: error });
    }
    let value;
    try {
      value = JSON.parse(content);
    } catch (error) {
      throw new Error('The saved document library is not valid JSON.', { cause: error });
    }
    metadataCache = validateMetadata(value);
    return metadataCache;
  }

  async function writeIndex(value) {
    const validated = validateMetadata(value);
    await mkdir(rootDirectory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${indexPath}.${randomUUID()}.tmp`;
    let writeError;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(validated)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporaryPath, indexPath);
    } catch (error) {
      writeError = error;
    }
    try {
      await rm(temporaryPath, { force: true });
    } catch (error) {
      throw new Error(`Could not clean up the local document library's temporary index: ${error.message}`, {
        cause: writeError ?? error,
      });
    }
    if (writeError) {
      throw new Error(`Could not save the local document library: ${writeError.message}`, { cause: writeError });
    }
    metadataCache = validated;
  }

  async function extractDocument(extension, data) {
    let pages;
    if (extension === '.pdf') {
      pages = await extractPdf(data);
      if (!Array.isArray(pages) || pages.length === 0) {
        throw new Error('This PDF has no selectable text. Scanned PDFs and OCR are not supported yet.');
      }
    } else {
      let text;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(data);
      } catch (error) {
        throw new Error('The document must contain valid UTF-8 text.', { cause: error });
      }
      pages = [{ page: null, text }];
    }
    const extracted = createChunks(pages);
    if (extracted.chunks.length === 0) {
      throw new Error('This document has no selectable text. Scanned PDFs and OCR are not supported yet.');
    }
    return extracted;
  }

  function cachePath(sessionId, fileId) {
    return join(cacheDirectory, hash(sessionId), `${fileId}.json`);
  }

  function searchIndexPath(sessionId) {
    return join(cacheDirectory, hash(sessionId), 'search-index.json');
  }

  async function directorySize(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return 0;
      throw new Error(`Could not measure local document cache storage: ${error.message}`, { cause: error });
    }
    let total = 0;
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error('The local document cache contains a symbolic link.');
      if (info.isDirectory()) total += await directorySize(path);
      else if (info.isFile()) total += info.size;
    }
    return total;
  }

  async function measureCacheUsage(metadata) {
    let entries;
    try {
      entries = await readdir(cacheDirectory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return { totalBytes: 0, sessions: new Map() };
      throw new Error(`Could not inspect local document cache storage: ${error.message}`, { cause: error });
    }
    const sessions = new Map();
    let totalBytes = 0;
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.deleting-')) continue;
      const directory = join(cacheDirectory, entry.name);
      const info = await lstat(directory);
      if (info.isSymbolicLink()) throw new Error('The local document cache contains a symbolic link.');
      const bytes = await directorySize(directory);
      const sessionId = metadata.references.find((reference) => hash(reference.sessionId) === entry.name)?.sessionId;
      sessions.set(entry.name, { bytes, lastUsed: info.mtimeMs, sessionId });
      totalBytes += bytes;
    }
    return { totalBytes, sessions };
  }

  async function ensureCacheSpace(sessionId, additionalBytes, metadata, usage) {
    if (additionalBytes <= 0 || usage.totalBytes + additionalBytes <= cacheBudgetBytes) return true;
    const currentDirectory = hash(sessionId);
    const candidates = [...usage.sessions.entries()]
      .filter(([directory]) => directory !== currentDirectory)
      .sort((left, right) => left[1].lastUsed - right[1].lastUsed);
    for (const [directory, entry] of candidates) {
      await rm(join(cacheDirectory, directory), { recursive: true, force: true });
      usage.sessions.delete(directory);
      usage.totalBytes -= entry.bytes;
      if (entry.sessionId) {
        metadata.files = metadata.files.map((file) => file.sessionId === entry.sessionId
          ? { ...file, indexed: false, sha256: '', chunkCount: 0 }
          : file);
      }
      if (usage.totalBytes + additionalBytes <= cacheBudgetBytes) return true;
    }
    return false;
  }

  async function writeCacheFile(sessionId, destination, content, metadata, usage, description) {
    const serialized = `${JSON.stringify(content)}\n`;
    const size = Buffer.byteLength(serialized, 'utf8');
    let previousSize = 0;
    try {
      previousSize = (await lstat(destination)).size;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (!await ensureCacheSpace(sessionId, size - previousSize, metadata, usage)) {
      throw new Error(`The ${Math.floor(cacheBudgetBytes / 1024 / 1024)} MB local document index limit was reached while indexing "${description}". Remove or replace older document references to make room.`);
    }
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    const temporaryPath = `${destination}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await rename(temporaryPath, destination);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw new Error(`Could not save the local index for "${description}": ${error.message}`, { cause: error });
    }
    usage.totalBytes += size - previousSize;
    const directory = hash(sessionId);
    const entry = usage.sessions.get(directory) ?? { bytes: 0, lastUsed: Date.now(), sessionId };
    entry.bytes += size - previousSize;
    entry.lastUsed = Date.now();
    entry.sessionId = sessionId;
    usage.sessions.set(directory, entry);
    await utimes(dirname(destination), new Date(), new Date()).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    });
    return size;
  }

  async function writeCache(sessionId, file, extracted, metadata, usage) {
    const cacheUsage = usage ?? await measureCacheUsage(metadata ?? await readIndex());
    const libraryMetadata = metadata ?? await readIndex();
    return writeCacheFile(
      sessionId,
      cachePath(sessionId, file.id),
      extracted,
      libraryMetadata,
      cacheUsage,
      file.name,
    );
  }

  async function readSearchIndex(sessionId) {
    try {
      return validateSearchIndex(JSON.parse(await readFile(searchIndexPath(sessionId), 'utf8')));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw new Error(`Could not read the local document search index: ${error.message}`, { cause: error });
    }
  }

  async function writeSearchIndex(sessionId, index, metadata, usage) {
    return writeCacheFile(
      sessionId,
      searchIndexPath(sessionId),
      index,
      metadata,
      usage,
      'the document search index',
    );
  }

  async function touchSessionCache(sessionId) {
    const directory = join(cacheDirectory, hash(sessionId));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await utimes(directory, new Date(), new Date());
  }

  async function removeCacheFile(sessionId, fileId, usage) {
    const path = cachePath(sessionId, fileId);
    let size = 0;
    try {
      size = (await lstat(path)).size;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await rm(path, { force: true });
    if (usage && size > 0) {
      usage.totalBytes = Math.max(0, usage.totalBytes - size);
      const entry = usage.sessions.get(hash(sessionId));
      if (entry) entry.bytes = Math.max(0, entry.bytes - size);
    }
  }

  async function readCache(sessionId, file) {
    let parsed;
    try {
      parsed = JSON.parse(await readFile(cachePath(sessionId, file.id), 'utf8'));
    } catch (error) {
      throw new Error(`Could not read indexed text for "${file.name}": ${error.message}`, { cause: error });
    }
    if (!parsed || typeof parsed !== 'object'
      || typeof parsed.fullText !== 'string' || parsed.fullText.length > MAX_EXTRACTED_LENGTH + 50_000
      || !Array.isArray(parsed.pages)
      || parsed.pages.length > MAX_DOCUMENT_CHUNKS
      || parsed.pages.reduce((total, page) => total + (typeof page?.text === 'string' ? page.text.length : 0), 0)
        > MAX_EXTRACTED_LENGTH
      || parsed.pages.some((page) => !page || typeof page.text !== 'string' || !page.text
        || (page.page !== null && (!Number.isSafeInteger(page.page) || page.page < 1)))
      || !Array.isArray(parsed.chunks) || parsed.chunks.length !== file.chunkCount
      || parsed.chunks.some((chunk, index) => !chunk || chunk.index !== index
        || (chunk.page !== null && (!Number.isSafeInteger(chunk.page) || chunk.page < 1))
        || typeof chunk.text !== 'string' || !chunk.text || chunk.text.length > MAX_CHUNK_LENGTH)) {
      throw new Error(`The indexed text for "${file.name}" is invalid.`);
    }
    return parsed;
  }

  async function canonicalPickerPath(sourcePath, expectedKind) {
    if (typeof sourcePath !== 'string' || !sourcePath || sourcePath.includes('\0')) {
      throw new Error('The selected path is invalid.');
    }
    const initial = await lstat(sourcePath);
    if (initial.isSymbolicLink()) throw new Error('Symbolic links cannot be attached.');
    if ((expectedKind === 'file' && !initial.isFile()) || (expectedKind === 'folder' && !initial.isDirectory())) {
      throw new Error(expectedKind === 'file' ? 'The selected path is not a file.' : 'The selected path is not a folder.');
    }
    return realpath(sourcePath);
  }

  async function scanFolder(reference, errors, { includeIgnored = false } = {}) {
    const rootStat = await lstat(reference.path);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw new Error('The referenced folder is unavailable or is a symbolic link.');
    }
    const root = await realpath(reference.path);
    const found = [];
    const isIgnored = (path, isDirectory, rules) => rules.some(({ matcher, base }) => {
      const localPath = relative(base, path).split(sep).join('/');
      if (!localPath || localPath.startsWith('../')) return false;
      return matcher.ignores(isDirectory ? `${localPath}/` : localPath);
    });
    async function visit(directory, inheritedRules) {
      let rules = inheritedRules;
      let ignoreText = '';
      try {
        ignoreText = await readFile(join(directory, '.gitignore'), 'utf8');
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          errors.push({ referenceId: reference.id, name: '.gitignore', error: error.message });
        }
      }
      if (directory === root) {
        const matcher = ignore().add(GENERATED_PATHS);
        if (ignoreText) matcher.add(ignoreText);
        rules = [{ matcher, base: root }];
      } else if (ignoreText) {
        rules = [...inheritedRules, { matcher: ignore().add(ignoreText), base: directory }];
      }
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        errors.push({ referenceId: reference.id, name: reference.name, error: error.message });
        return;
      }
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        const entryPath = join(directory, entry.name);
        const relativePath = relative(root, entryPath).split(sep).join('/');
        const allowedHiddenInstruction = relativePath === '.github' && entry.isDirectory()
          || relativePath === '.github/copilot-instructions.md';
        if (entry.name.startsWith('.') && !allowedHiddenInstruction
          || entry.isSymbolicLink() || entry.name === '.gitignore') continue;
        if (!entry.isDirectory() && isSensitiveFile(entryPath)) continue;
        const ignored = isIgnored(entryPath, entry.isDirectory(), rules);
        if (ignored && !includeIgnored) continue;
        if (entry.isDirectory()) {
          await visit(entryPath, rules);
          continue;
        }
        if (!entry.isFile() || !SUPPORTED_EXTENSIONS.has(extname(entry.name).toLocaleLowerCase())) continue;
        try {
          const resolved = await realpath(entryPath);
          const info = await lstat(entryPath);
          if (info.isSymbolicLink() || !info.isFile() || !isWithin(root, resolved)) continue;
          found.push({
            path: resolved,
            referenceId: reference.id,
            displayName: relative(root, resolved),
            ignored,
          });
        } catch (error) {
          errors.push({ referenceId: reference.id, name: entry.name, error: error.message });
        }
      }
    }
    await visit(root, []);
    return found;
  }

  async function scanFile(reference) {
    const info = await lstat(reference.path);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error('The referenced file is unavailable or is a symbolic link.');
    }
    const resolved = await realpath(reference.path);
    if (!SUPPORTED_EXTENSIONS.has(extname(resolved).toLocaleLowerCase())) {
      throw new Error('Choose a supported text file or text-based PDF file.');
    }
    return [{ path: resolved, referenceId: reference.id, displayName: basename(resolved), ignored: false }];
  }

  async function syncSession(sessionId, { indexMissing = true, includeIgnored = false } = {}) {
    validateSessionId(sessionId);
    const metadata = await readIndex();
    const references = metadata.references.filter((reference) => reference.sessionId === sessionId);
    if (references.length > MAX_REFERENCES_PER_SESSION) {
      throw new Error(`A conversation can contain at most ${MAX_REFERENCES_PER_SESSION} file or folder references.`);
    }
    const errors = [];
    const discovered = new Map();
    for (const reference of references) {
      try {
        const paths = reference.kind === 'file'
          ? await scanFile(reference)
          : await scanFolder(reference, errors, { includeIgnored });
        for (const item of paths) {
          const existing = discovered.get(item.path);
          if (existing) {
            existing.referenceIds.add(item.referenceId);
            if (item.displayName.includes(sep)) existing.displayName = item.displayName;
            existing.ignored = existing.ignored && item.ignored === true;
          } else {
            discovered.set(item.path, {
              path: item.path,
              referenceIds: new Set([item.referenceId]),
              displayName: item.displayName,
              ignored: item.ignored === true,
            });
          }
        }
      } catch (error) {
        errors.push({
          referenceId: reference.id,
          name: reference.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const ordered = [...discovered.values()].sort((left, right) => left.path.localeCompare(right.path));
    const oldFiles = metadata.files.filter((file) => file.sessionId === sessionId);
    const oldByPath = new Map(oldFiles.map((file) => [file.path, file]));
    const files = [];
    const indexedUpdates = new Map();
    const successfulPaths = new Set();
    const cacheUsage = await measureCacheUsage(metadata);

    for (const item of ordered) {
      const current = oldByPath.get(item.path);
      let file = current;
      try {
        const info = await lstat(item.path);
        if (info.isSymbolicLink() || !info.isFile()) throw new Error('The referenced file is no longer a regular file.');
        if (info.size < 1 || info.size > MAX_FILE_SIZE) {
          throw new Error(`File size must be between 1 byte and ${MAX_FILE_SIZE / 1024 / 1024} MB.`);
        }
        const extension = extname(item.path).toLocaleLowerCase();
        const changed = !current || current.size !== info.size || current.mtimeMs !== info.mtimeMs
          || current.ignored !== item.ignored;
        file ??= {
          id: randomUUID(),
          sessionId,
          path: item.path,
          name: item.displayName.slice(0, 1_024),
          extension,
          size: info.size,
          mtimeMs: info.mtimeMs,
          sha256: '',
          chunkCount: 0,
          indexed: false,
          ignored: item.ignored,
          referenceIds: [],
        };
        let cacheExists = false;
        if (!changed && current?.indexed) {
          try {
            const cachedIndex = await lstat(cachePath(sessionId, current.id));
            if (cachedIndex.isSymbolicLink() || !cachedIndex.isFile()) {
              throw new Error('The local document index is not a regular file.');
            }
            cacheExists = true;
          } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
          }
        }
        const shouldIndex = !item.ignored && indexMissing
          && (changed || !current?.indexed || !cacheExists);
        if (shouldIndex) {
          const data = await readFile(item.path);
          if (data.length !== info.size) throw new Error('The file changed while it was being indexed. Try again.');
          const extracted = await extractDocument(extension, data);
          file = {
            ...file,
            name: item.displayName.slice(0, 1_024),
            extension,
            size: info.size,
            mtimeMs: info.mtimeMs,
            sha256: hash(data),
            chunkCount: extracted.chunks.length,
            indexed: true,
            ignored: false,
            referenceIds: [...item.referenceIds],
          };
          await writeCache(sessionId, file, extracted, metadata, cacheUsage);
          indexedUpdates.set(file.id, extracted);
        } else if (!changed && current?.indexed && cacheExists && !item.ignored) {
          file = {
            ...current,
            name: item.displayName.slice(0, 1_024),
            referenceIds: [...item.referenceIds],
          };
        } else {
          if (current?.indexed) await removeCacheFile(sessionId, current.id, cacheUsage);
          file = {
            ...file,
            name: item.displayName.slice(0, 1_024),
            extension,
            size: info.size,
            mtimeMs: info.mtimeMs,
            indexed: false,
            ignored: item.ignored,
            sha256: '',
            chunkCount: 0,
            referenceIds: [...item.referenceIds],
          };
        }
        files.push(file);
        successfulPaths.add(item.path);
      } catch (error) {
        const couldNotFitInCache = error instanceof Error
          && error.message.includes('local document index limit was reached');
        if (file && (current?.indexed === false || couldNotFitInCache)) {
          if (current?.indexed) await removeCacheFile(sessionId, current.id, cacheUsage);
          file = {
            ...file,
            indexed: false,
            ignored: item.ignored,
            sha256: '',
            chunkCount: 0,
            referenceIds: [...item.referenceIds],
          };
          files.push(file);
          successfulPaths.add(item.path);
        } else if (current?.indexed) {
          await removeCacheFile(sessionId, current.id, cacheUsage);
        }
        errors.push({
          name: basename(item.path),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (!includeIgnored) {
      const referenceIds = new Set(references.map((reference) => reference.id));
      for (const oldFile of oldFiles) {
        if (!oldFile.ignored || successfulPaths.has(oldFile.path)) continue;
        const retainedReferenceIds = oldFile.referenceIds.filter((id) => referenceIds.has(id));
        if (retainedReferenceIds.length === 0) continue;
        try {
          const info = await lstat(oldFile.path);
          if (info.isSymbolicLink() || !info.isFile()
            || await realpath(oldFile.path) !== oldFile.path) continue;
          files.push({ ...oldFile, referenceIds: retainedReferenceIds });
          successfulPaths.add(oldFile.path);
        } catch (error) {
          if (error?.code !== 'ENOENT') {
            errors.push({ name: oldFile.name, error: error.message });
          }
        }
      }
      files.sort((left, right) => left.path.localeCompare(right.path));
    }

    const indexedIds = new Set(files.filter((file) => file.indexed).map((file) => file.id));
    let searchIndex = await readSearchIndex(sessionId);
    let searchIndexChanged = false;
    if (indexedIds.size === 0) {
      if (searchIndex) {
        await rm(searchIndexPath(sessionId), { force: true });
      }
      const sessionDirectory = join(cacheDirectory, hash(sessionId));
      await rm(sessionDirectory, { recursive: true, force: true });
      const usage = cacheUsage.sessions.get(hash(sessionId));
      if (usage) {
        cacheUsage.totalBytes = Math.max(0, cacheUsage.totalBytes - usage.bytes);
        cacheUsage.sessions.delete(hash(sessionId));
      }
      searchIndex = null;
    } else if (!searchIndex) {
      searchIndex = createSearchIndex();
      searchIndexChanged = true;
      for (const file of files) {
        if (!file.indexed) continue;
        const extracted = indexedUpdates.get(file.id) ?? await readCache(sessionId, file);
        addFileToSearchIndex(searchIndex, file.id, extracted.chunks);
      }
    } else {
      for (const oldFile of oldFiles) {
        if (!indexedIds.has(oldFile.id) || indexedUpdates.has(oldFile.id)) {
          removeFileFromSearchIndex(searchIndex, oldFile.id);
          searchIndexChanged = true;
        }
      }
      for (const [fileId, extracted] of indexedUpdates) {
        addFileToSearchIndex(searchIndex, fileId, extracted.chunks);
        searchIndexChanged = true;
      }
    }
    if (searchIndexChanged) await writeSearchIndex(sessionId, searchIndex, metadata, cacheUsage);

    const updated = {
      ...metadata,
      files: [...metadata.files.filter((file) => file.sessionId !== sessionId), ...files],
    };
    await writeIndex(updated);
    for (const file of oldFiles) {
      if (successfulPaths.has(file.path)) continue;
      await removeCacheFile(sessionId, file.id, cacheUsage);
      for (const [proposalId, proposal] of editProposals) {
        if (proposal.sessionId === sessionId && proposal.fileId === file.id) editProposals.delete(proposalId);
      }
    }
    const counts = new Map(references.map((reference) => [reference.id, 0]));
    for (const file of files) {
      for (const referenceId of file.referenceIds) counts.set(referenceId, (counts.get(referenceId) ?? 0) + 1);
    }
    return {
      references: references.map((reference) => ({
        id: reference.id,
        kind: reference.kind,
        name: reference.name,
        addedAt: reference.addedAt,
        fileCount: counts.get(reference.id) ?? 0,
      })),
      files,
      documentCount: files.length,
      unindexedCount: files.filter((file) => !file.indexed && !file.ignored).length,
      overflowCount: 0,
      errors,
    };
  }

  async function safeFolderTarget(reference, segments, expectedKind) {
    const rootInfo = await lstat(reference.path);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
      throw new Error('The referenced folder is unavailable or is a symbolic link.');
    }
    const root = await realpath(reference.path);
    let target = root;
    for (const [index, segment] of segments.entries()) {
      target = join(target, segment);
      const info = await lstat(target);
      if (info.isSymbolicLink()) throw new Error('Symbolic links cannot be read through folder tools.');
      if (index < segments.length - 1 && !info.isDirectory()) {
        throw new Error('A folder path segment is not a directory.');
      }
    }
    const info = await lstat(target);
    const resolved = await realpath(target);
    if (!isWithin(root, resolved)) throw new Error('Folder tools cannot access paths outside the selected folder.');
    if ((expectedKind === 'directory' && !info.isDirectory())
      || (expectedKind === 'file' && !info.isFile())) {
      throw new Error(expectedKind === 'directory' ? 'The selected path is not a directory.' : 'The selected path is not a file.');
    }
    return { root, path: resolved, info };
  }

  async function selectedFolderReferences(sessionId, referenceIds, { indexMissing = false, includeIgnored = false } = {}) {
    validateSessionId(sessionId);
    if (!Array.isArray(referenceIds) || referenceIds.length === 0
      || referenceIds.length > MAX_REFERENCES_PER_SESSION
      || referenceIds.some((id) => typeof id !== 'string')) {
      throw new Error('At least one attached folder reference is required.');
    }
    const ids = [...new Set(referenceIds)];
    for (const id of ids) validateId(id);
    const metadata = await readIndex();
    const references = metadata.references.filter((reference) =>
      reference.sessionId === sessionId && ids.includes(reference.id) && reference.kind === 'folder');
    if (references.length !== ids.length) {
      throw new Error('A folder reference is no longer attached to this conversation.');
    }
    const synced = await syncSession(sessionId, { indexMissing, includeIgnored });
    return { references, files: synced.files };
  }

  function folderInventory(reference, files) {
    const scopedFiles = files.filter((file) =>
      file.referenceIds.includes(reference.id) && !file.ignored && !isSensitiveFile(file.path));
    const rankedFiles = scopedFiles.map((file) => {
      const path = relative(reference.path, file.path).split(sep).join('/');
      const depth = path.split('/').length;
      return { path, depth, priority: folderFilePriority(path) };
    }).filter((file) => file.depth <= MAX_FOLDER_INVENTORY_DEPTH)
      .sort((left, right) => left.priority - right.priority || left.path.localeCompare(right.path));

    const candidates = new Map();
    for (const file of rankedFiles.slice(0, MAX_FOLDER_INVENTORY_ENTRIES)) {
      const segments = file.path.split('/');
      for (let length = 1; length < segments.length && length <= MAX_FOLDER_INVENTORY_DEPTH; length += 1) {
        const path = segments.slice(0, length).join('/');
        const previous = candidates.get(`directory:${path}`);
        const priority = Math.min(previous?.priority ?? Number.MAX_SAFE_INTEGER, file.priority);
        candidates.set(`directory:${path}`, { kind: 'directory', path, priority });
      }
      if (file.depth <= MAX_FOLDER_INVENTORY_DEPTH) {
        candidates.set(`file:${file.path}`, { kind: 'file', path: file.path, priority: file.priority });
      }
    }
    const entries = [...candidates.values()]
      .sort((left, right) => left.priority - right.priority
        || left.path.localeCompare(right.path)
        || left.kind.localeCompare(right.kind))
      .slice(0, MAX_FOLDER_INVENTORY_ENTRIES)
      .map(({ kind, path }) => `${kind === 'directory' ? 'D' : 'F'} ${path}${kind === 'directory' ? '/' : ''}`);
    return {
      entries,
      omittedCount: Math.max(0, scopedFiles.length - rankedFiles.slice(0, MAX_FOLDER_INVENTORY_ENTRIES).length)
        + Math.max(0, candidates.size - entries.length),
    };
  }

  async function readFolderInstructions(reference, files) {
    const candidates = files
      .filter((file) => file.referenceIds.includes(reference.id) && !file.ignored && !isSensitiveFile(file.path))
      .map((file) => ({
        file,
        path: relative(reference.path, file.path).split(sep).join('/'),
      }))
      .filter(({ path }) => {
        const name = basename(path).toLocaleLowerCase();
        return PROJECT_INSTRUCTION_FILES.has(name) || path.toLocaleLowerCase() === '.github/copilot-instructions.md';
      })
      .sort((left, right) => right.path.split('/').length - left.path.split('/').length
        || left.path.localeCompare(right.path))
      .slice(0, MAX_FOLDER_INSTRUCTION_FILES);
    const seenHashes = new Set();
    const instructions = [];
    let totalCharacters = 0;
    for (const { file, path } of candidates) {
      if (totalCharacters >= MAX_FOLDER_INSTRUCTION_CHARS) break;
      const segments = normalizeFolderRelativePath(path);
      const target = await safeFolderTarget(reference, segments, 'file');
      if (target.info.size > MAX_FOLDER_INSTRUCTION_FILE_BYTES) continue;
      const bytes = await readFile(target.path);
      if (bytes.length !== target.info.size) throw new Error(`"${path}" changed while project instructions were being read.`);
      let text;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim();
      } catch (error) {
        throw new Error(`Project instructions in "${path}" are not valid UTF-8 text.`, { cause: error });
      }
      if (!text || text.includes('\0')) continue;
      const digest = hash(text);
      if (seenHashes.has(digest)) continue;
      seenHashes.add(digest);
      const excerpt = text.slice(0, MAX_FOLDER_INSTRUCTION_CHARS - totalCharacters);
      instructions.push({ documentId: file.id, path, text: excerpt });
      totalCharacters += excerpt.length;
    }
    return instructions;
  }

  async function buildFolderContext(sessionId, referenceIds) {
    const { references, files } = await selectedFolderReferences(sessionId, referenceIds, { indexMissing: false });
    return Promise.all(references.map(async (reference) => {
      const inventory = folderInventory(reference, files);
      const instructions = await readFolderInstructions(reference, files);
      return {
        folderId: reference.id,
        name: reference.name,
        fileCount: files.filter((file) => file.referenceIds.includes(reference.id)).length,
        inventory: inventory.entries,
        omittedCount: inventory.omittedCount,
        instructions,
      };
    }));
  }

  async function listFolderDirectory(sessionId, folderId, path = '', depth = 2, includeIgnored = false) {
    if (!Number.isSafeInteger(depth) || depth < 0 || depth > MAX_FOLDER_INVENTORY_DEPTH
      || typeof includeIgnored !== 'boolean') {
      throw new Error('Directory listing limits are invalid.');
    }
    const segments = normalizeFolderRelativePath(path, true);
    const { references, files } = await selectedFolderReferences(sessionId, [folderId], { includeIgnored });
    const reference = references[0];
    const target = await safeFolderTarget(reference, segments, 'directory');
    const relativeDirectory = relative(target.root, target.path).split(sep).join('/');
    const prefix = relativeDirectory ? `${relativeDirectory}/` : '';
    const candidates = new Map();
    for (const file of files) {
      if (!file.referenceIds.includes(folderId) || (!includeIgnored && file.ignored)
        || isSensitiveFile(file.path)) continue;
      const filePath = relative(target.root, file.path).split(sep).join('/');
      if (!filePath.startsWith(prefix)) continue;
      const childPath = filePath.slice(prefix.length);
      const parts = childPath.split('/');
      for (let index = 0; index < Math.min(parts.length, depth); index += 1) {
        const entryPath = parts.slice(0, index + 1).join('/');
        const isDirectory = index < parts.length - 1;
        if (isDirectory || parts.length <= depth) {
          candidates.set(`${isDirectory ? 'directory' : 'file'}:${entryPath}`, {
            kind: isDirectory ? 'directory' : 'file',
            path: entryPath,
          });
        }
      }
    }
    return [...candidates.values()]
      .sort((left, right) => (left.kind === right.kind ? 0 : left.kind === 'directory' ? -1 : 1)
        || left.path.localeCompare(right.path))
      .slice(0, MAX_FOLDER_INVENTORY_ENTRIES);
  }

  async function readFolderFile(sessionId, folderId, path, offset = 0, limit = 200, includeIgnored = false) {
    if (!Number.isSafeInteger(offset) || offset < 0
      || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_FOLDER_READ_LINES
      || typeof includeIgnored !== 'boolean') {
      throw new Error('File read limits are invalid.');
    }
    const segments = normalizeFolderRelativePath(path);
    const { references, files } = await selectedFolderReferences(sessionId, [folderId], { includeIgnored });
    const reference = references[0];
    const target = await safeFolderTarget(reference, segments, 'file');
    if (!SUPPORTED_EXTENSIONS.has(extname(target.path).toLocaleLowerCase()) || isSensitiveFile(target.path)) {
      throw new Error('Folder tools can read only supported, non-sensitive text documents.');
    }
    const relativePath = relative(target.root, target.path).split(sep).join('/');
    const file = files.find((entry) => entry.referenceIds.includes(folderId)
      && relative(target.root, entry.path).split(sep).join('/') === relativePath
      && (includeIgnored || !entry.ignored));
    if (!file) throw new Error('That path is ignored or is not an indexed supported document in this folder.');
    const bytes = await readFile(target.path);
    if (bytes.length !== target.info.size) throw new Error('The file changed while it was being read. Try again.');
    const extracted = await extractDocument(file.extension, bytes);
    const text = extracted.pages.map(({ page, text: pageText }) =>
      page === null ? pageText : `[Page ${page}]\n${pageText}`).join('\n\n');
    const lines = text.split('\n');
    if (offset >= lines.length) {
      return { documentId: file.id, path: relativePath, offset, nextOffset: null, totalLines: lines.length, text: '', truncated: false };
    }
    const end = Math.min(lines.length, offset + limit, offset + MAX_FOLDER_READ_LINES);
    const selected = [];
    let byteCount = 0;
    let nextOffset = null;
    for (let index = offset; index < end; index += 1) {
      const line = lines[index];
      const size = Buffer.byteLength(line, 'utf8') + (selected.length > 0 ? 1 : 0);
      if (byteCount + size > MAX_FOLDER_READ_BYTES) {
        nextOffset = index;
        break;
      }
      selected.push(line);
      byteCount += size;
    }
    if (nextOffset === null && end < lines.length) nextOffset = end;
    const truncated = nextOffset !== null;
    return {
      documentId: file.id,
      path: relativePath,
      offset,
      nextOffset,
      totalLines: lines.length,
      text: `${selected.join('\n')}${truncated ? '\n[... truncated; use offset/limit to continue ...]' : ''}`,
      truncated,
    };
  }

  async function grepFolder(sessionId, folderId, pattern, path = '', glob = '', includeIgnored = false) {
    if (typeof pattern !== 'string' || !pattern.trim() || pattern.length > MAX_GREP_PATTERN_LENGTH
      || !isSafeFolderPattern(pattern)
      || typeof glob !== 'string' || glob.length > MAX_GREP_PATTERN_LENGTH
      || typeof includeIgnored !== 'boolean') {
      throw new Error('Grep pattern or limits are invalid.');
    }
    let matcher;
    try {
      matcher = new RegExp(pattern, 'iu');
    } catch (error) {
      throw new Error(`Grep pattern is not a valid regular expression: ${error.message}`, { cause: error });
    }
    const segments = normalizeFolderRelativePath(path, true);
    const { references, files } = await selectedFolderReferences(sessionId, [folderId], { includeIgnored });
    const reference = references[0];
    const target = await safeFolderTarget(reference, segments, 'directory');
    const relativeDirectory = relative(target.root, target.path).split(sep).join('/');
    const prefix = relativeDirectory ? `${relativeDirectory}/` : '';
    let globMatcher = null;
    if (glob) {
      const escaped = glob.replace(/[.+^${}()|[\]\\]/gu, '\\$&')
        .replaceAll('**', '\u0000')
        .replaceAll('*', '[^/]*')
        .replaceAll('?', '[^/]')
        .replaceAll('\u0000', '.*');
      globMatcher = new RegExp(`^${escaped}$`, 'iu');
    }
    const candidates = files.filter((file) => file.referenceIds.includes(folderId)
      && (includeIgnored || !file.ignored) && !isSensitiveFile(file.path))
      .map((file) => ({
        file,
        path: relative(target.root, file.path).split(sep).join('/'),
      }))
      .filter(({ path: filePath }) => filePath.startsWith(prefix)
        && (!globMatcher || globMatcher.test(filePath.slice(prefix.length))))
      .sort((left, right) => left.path.localeCompare(right.path));
    const matches = [];
    let bytesRead = 0;
    let resultCharacters = 0;
    let scannedFiles = 0;
    for (const candidate of candidates) {
      if (scannedFiles >= MAX_GREP_FILES || bytesRead >= MAX_GREP_TOTAL_BYTES
        || matches.length >= MAX_GREP_MATCHES || resultCharacters >= MAX_GREP_RESULT_CHARS) break;
      if (candidate.file.size > 1_000_000 || bytesRead + candidate.file.size > MAX_GREP_TOTAL_BYTES) continue;
      const targetFile = await safeFolderTarget(reference, candidate.path.split('/'), 'file');
      const bytes = await readFile(targetFile.path);
      if (bytes.length !== targetFile.info.size) continue;
      scannedFiles += 1;
      bytesRead += bytes.length;
      const extracted = await extractDocument(candidate.file.extension, bytes);
      const text = extracted.pages.map(({ page, text: pageText }) =>
        page === null ? pageText : `[Page ${page}]\n${pageText}`).join('\n\n');
      const lines = text.split('\n');
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index].slice(0, 800);
        if (!matcher.test(line)) continue;
        const before = index > 0 ? `${lines[index - 1].slice(0, 100)}\n` : '';
        const after = index + 1 < lines.length ? `\n${lines[index + 1].slice(0, 100)}` : '';
        const excerpt = `${before}${line}${after}`;
        if (resultCharacters + excerpt.length > MAX_GREP_RESULT_CHARS) break;
        matches.push({
          documentId: candidate.file.id,
          path: candidate.path,
          line: index + 1,
          excerpt,
        });
        resultCharacters += excerpt.length;
        if (matches.length >= MAX_GREP_MATCHES) break;
      }
    }
    return {
      matches,
      scannedFiles,
      truncated: candidates.length > scannedFiles || matches.length >= MAX_GREP_MATCHES
        || resultCharacters >= MAX_GREP_RESULT_CHARS || bytesRead >= MAX_GREP_TOTAL_BYTES,
    };
  }

  async function addReferences(paths, sessionId, kind) {
    validateSessionId(sessionId);
    if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAX_IMPORT_COUNT) {
      throw new Error(`Select between 1 and ${MAX_IMPORT_COUNT} ${kind === 'file' ? 'files' : 'folders'}.`);
    }
    const metadata = await readIndex();
    const current = metadata.references.filter((reference) => reference.sessionId === sessionId);
    const created = [];
    const added = [];
    const errors = [];
    for (const sourcePath of paths) {
      try {
        const canonicalPath = await canonicalPickerPath(sourcePath, kind);
        const duplicate = current.find((reference) => reference.path === canonicalPath);
        if (duplicate) {
          added.push({ id: duplicate.id, kind: duplicate.kind, name: duplicate.name, duplicate: true });
          continue;
        }
        if (current.length >= MAX_REFERENCES_PER_SESSION) {
          throw new Error(`A conversation can contain at most ${MAX_REFERENCES_PER_SESSION} file or folder references.`);
        }
        const reference = {
          id: randomUUID(),
          sessionId,
          kind,
          name: basename(canonicalPath).slice(0, 255) || canonicalPath,
          path: canonicalPath,
          addedAt: new Date().toISOString(),
        };
        current.push(reference);
        created.push(reference);
        added.push({ id: reference.id, kind, name: reference.name, duplicate: false });
      } catch (error) {
        errors.push({
          name: typeof sourcePath === 'string' ? basename(sourcePath) : 'Selected path',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    await writeIndex({ ...metadata, references: [...metadata.references, ...created] });
    const result = await syncSession(sessionId);
    return {
      added,
      errors: [...errors, ...result.errors],
      references: result.references,
      documentCount: result.documentCount,
      overflowCount: result.overflowCount,
    };
  }

  function publicList(result) {
    return {
      references: result.references,
      files: result.files.map((file) => ({
        id: file.id,
        name: file.name,
        extension: file.extension,
        referenceIds: file.referenceIds,
        indexed: file.indexed,
        ignored: file.ignored,
      })),
      documentCount: result.documentCount,
      indexedCount: result.files.filter((file) => file.indexed).length,
      unindexedCount: result.unindexedCount ?? result.files.filter((file) => !file.indexed && !file.ignored).length,
      overflowCount: result.overflowCount,
      errors: result.errors,
    };
  }

  return Object.freeze({
    folderContext(sessionId, referenceIds) {
      return serializeMutation(() => buildFolderContext(sessionId, referenceIds));
    },
    listDirectory(sessionId, folderId, path, depth, includeIgnored = false) {
      return serializeMutation(() =>
        listFolderDirectory(sessionId, folderId, path, depth, includeIgnored));
    },
    readFolderFile(sessionId, folderId, path, offset = 0, limit = 200, includeIgnored = false) {
      return serializeMutation(() =>
        readFolderFile(sessionId, folderId, path, offset, limit, includeIgnored));
    },
    grep(sessionId, folderId, pattern, path = '', glob = '', includeIgnored = false) {
      return serializeMutation(() =>
        grepFolder(sessionId, folderId, pattern, path, glob, includeIgnored));
    },
    listCached(sessionId) {
      return serializeMutation(async () => {
        validateSessionId(sessionId);
        const metadata = await readIndex();
        const references = metadata.references.filter((reference) => reference.sessionId === sessionId);
        const files = metadata.files.filter((file) => file.sessionId === sessionId);
        const counts = new Map(references.map((reference) => [reference.id, 0]));
        for (const file of files) {
          for (const referenceId of file.referenceIds) {
            counts.set(referenceId, (counts.get(referenceId) ?? 0) + 1);
          }
        }
        return publicList({
          references: references.map((reference) => ({
            id: reference.id,
            kind: reference.kind,
            name: reference.name,
            addedAt: reference.addedAt,
            fileCount: counts.get(reference.id) ?? 0,
          })),
          files,
          documentCount: files.length,
          indexedCount: files.filter((file) => file.indexed).length,
          unindexedCount: files.filter((file) => !file.indexed && !file.ignored).length,
          overflowCount: 0,
          errors: [],
        });
      });
    },
    list(sessionId) {
      return serializeMutation(async () => publicList(await syncSession(sessionId, { indexMissing: false })));
    },
    readContent(sessionId, fileId) {
      return serializeMutation(async () => {
        validateSessionId(sessionId);
        validateId(fileId);
        const metadata = await readIndex();
        const file = metadata.files.find((entry) => entry.id === fileId && entry.sessionId === sessionId);
        if (!file) throw new Error('That file is not attached to this conversation.');
        const references = metadata.references.filter((reference) =>
          reference.sessionId === sessionId && file.referenceIds.includes(reference.id));
        if (references.length === 0) throw new Error('That file is not attached to this conversation.');
        const info = await lstat(file.path);
        if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_FILE_SIZE
          || await realpath(file.path) !== file.path) {
          throw new Error('The attached file is no longer safe to view.');
        }
        let isAuthorizedPath = false;
        for (const reference of references) {
          let referenceInfo;
          try {
            referenceInfo = await lstat(reference.path);
          } catch (error) {
            if (error?.code === 'ENOENT') continue;
            throw error;
          }
          if (referenceInfo.isSymbolicLink()) continue;
          let referencePath;
          try {
            referencePath = await realpath(reference.path);
          } catch (error) {
            if (error?.code === 'ENOENT') continue;
            throw error;
          }
          if (referencePath !== reference.path) continue;
          if (reference.kind === 'file') {
            if (referenceInfo.isFile() && referencePath === file.path) isAuthorizedPath = true;
          } else if (referenceInfo.isDirectory() && isWithin(referencePath, file.path)) {
            isAuthorizedPath = true;
          }
          if (isAuthorizedPath) break;
        }
        if (!isAuthorizedPath) throw new Error('The attached file is no longer inside its referenced path.');
        let text;
        if (file.extension === '.pdf') {
          if (file.indexed && file.size === info.size && file.mtimeMs === info.mtimeMs) {
            text = (await readCache(sessionId, file)).fullText;
          } else {
            const data = await readFile(file.path);
            if (data.length !== info.size) throw new Error('The file changed while it was being opened. Try again.');
            const extracted = await extractDocument(file.extension, data);
            text = extracted.fullText;
          }
        } else {
          const data = await readFile(file.path);
          if (data.length !== info.size) throw new Error('The file changed while it was being opened. Try again.');
          try {
            text = new TextDecoder('utf-8', { fatal: true }).decode(data);
          } catch (error) {
            throw new Error('The attached file no longer contains valid UTF-8 text.', { cause: error });
          }
        }
        await touchSessionCache(sessionId).catch((error) => {
          if (error?.code !== 'ENOENT') throw error;
        });
        return {
          id: file.id,
          name: file.name,
          extension: file.extension,
          text,
        };
      });
    },
    addFiles(filePaths, sessionId) {
      return serializeMutation(() => addReferences(filePaths, sessionId, 'file'));
    },
    addFolder(folderPath, sessionId) {
      return serializeMutation(() => addReferences([folderPath], sessionId, 'folder'));
    },
    remove(id, sessionId, removeSelection = async () => {}) {
      return serializeMutation(async () => {
        validateId(id);
        validateSessionId(sessionId);
        if (typeof removeSelection !== 'function') throw new Error('Document removal operation is invalid.');
        const existing = await readIndex();
        const reference = existing.references.find((entry) => entry.id === id);
        if (!reference || reference.sessionId !== sessionId) {
          throw new Error('Cannot remove a reference that is not in this conversation.');
        }
        const updated = {
          ...existing,
          references: existing.references.filter((entry) => entry.id !== id),
          files: existing.files.map((file) => ({
            ...file,
            referenceIds: file.referenceIds.filter((referenceId) => referenceId !== id),
          })).filter((file) => file.referenceIds.length > 0),
        };
        await writeIndex(updated);
        try {
          for (const [proposalId, proposal] of editProposals) {
            if (proposal.sessionId === sessionId && proposal.referenceIds.includes(id)) editProposals.delete(proposalId);
          }
          const refreshed = await syncSession(sessionId, { indexMissing: false, includeIgnored: true });
          await removeSelection(refreshed.files.map((file) => file.id));
          const retainedFileIds = new Set(refreshed.files.map((file) => file.id));
          for (const file of existing.files) {
            if (!retainedFileIds.has(file.id)) await rm(cachePath(sessionId, file.id), { force: true });
          }
        } catch (error) {
          await writeIndex(existing);
          throw error;
        }
      });
    },
    migrateLegacyOwnership(sessions) {
      return serializeMutation(async () => {
        if (!Array.isArray(sessions)) throw new Error('Conversation data is invalid.');
        const existingRaw = await readFile(indexPath, 'utf8').catch((error) => {
          if (error?.code === 'ENOENT') return null;
          throw new Error(`Could not read the local document library: ${error.message}`, { cause: error });
        });
        let isLegacy = false;
        if (existingRaw !== null) {
          let parsed;
          try {
            parsed = JSON.parse(existingRaw);
          } catch (error) {
            throw new Error('The saved document library is not valid JSON.', { cause: error });
          }
          if (Array.isArray(parsed)) isLegacy = true;
          else validateMetadata(parsed);
        }
        const migratedSessions = sessions.map((session) => {
          if (!session || typeof session.id !== 'string' || !session.id || session.id.length > 128
            || !Array.isArray(session.selectedDocumentIds)) {
            throw new Error('Conversation data is invalid.');
          }
          return {
            ...session,
            selectedDocumentIds: isLegacy ? [] : [...session.selectedDocumentIds],
          };
        });
        if (isLegacy) {
          await rm(legacyDocumentsDirectory, { recursive: true, force: true });
          await rm(cacheDirectory, { recursive: true, force: true });
        }
        if (isLegacy || existingRaw === null) {
          await writeIndex({ version: LIBRARY_VERSION, references: [], files: [] });
        }
        const changedSessionIds = isLegacy
          ? migratedSessions.filter((session, index) =>
            JSON.stringify(session.selectedDocumentIds) !== JSON.stringify(sessions[index].selectedDocumentIds))
            .map((session) => session.id)
          : [];
        return { sessions: migratedSessions, changedSessionIds };
      });
    },
    removeSession(sessionId, removeConversation) {
      return serializeMutation(async () => {
        validateSessionId(sessionId);
        if (typeof removeConversation !== 'function') {
          throw new Error('Conversation removal operation is invalid.');
        }
        const existing = await readIndex();
        const ownedReferences = existing.references.filter((reference) => reference.sessionId === sessionId);
        const ownedFiles = existing.files.filter((file) => file.sessionId === sessionId);
        const cache = join(cacheDirectory, hash(sessionId));
        const tombstone = join(cacheDirectory, `.deleting-${randomUUID()}`);
        let moved = false;
        try {
          await rename(cache, tombstone);
          moved = true;
        } catch (error) {
          if (error?.code !== 'ENOENT') throw new Error(`Could not prepare local indexes for deletion: ${error.message}`, { cause: error });
        }
        try {
          if (ownedReferences.length || ownedFiles.length) {
            await writeIndex({
              ...existing,
              references: existing.references.filter((reference) => reference.sessionId !== sessionId),
              files: existing.files.filter((file) => file.sessionId !== sessionId),
            });
          }
          await removeConversation();
        } catch (error) {
          try {
            if (ownedReferences.length || ownedFiles.length) await writeIndex(existing);
            if (moved) await rename(tombstone, cache);
          } catch (restoreError) {
            throw new Error(`Could not restore conversation indexes after deletion failed: ${restoreError.message}`, {
              cause: error,
            });
          }
          throw error;
        }
        if (moved) {
          try {
            await rm(tombstone, { recursive: true, force: true });
          } catch (error) {
            throw new Error(`Conversation was deleted, but its local indexes could not be fully removed: ${error.message}`, {
              cause: error,
            });
          }
        }
        for (const [proposalId, proposal] of editProposals) {
          if (proposal.sessionId === sessionId) editProposals.delete(proposalId);
        }
      });
    },
    search(sessionId, referenceIds, query, {
      includeIgnored = false,
      maxCharacters = MAX_TOOL_RESULT_CHARS,
      maxResults = MAX_SEARCH_RESULTS,
      prioritizeOverview = false,
    } = {}) {
      return serializeMutation(async () => {
        validateSessionId(sessionId);
        if (!Array.isArray(referenceIds) || referenceIds.length > MAX_REFERENCES_PER_SESSION
          || referenceIds.some((id) => typeof id !== 'string')) {
          throw new Error(`A conversation can attach no more than ${MAX_REFERENCES_PER_SESSION} references.`);
        }
        const ids = [...new Set(referenceIds)];
        for (const id of ids) validateId(id);
        if (ids.length === 0) return [];
        if (typeof query !== 'string' || !query.trim() || query.length > 2_000
          || typeof includeIgnored !== 'boolean' || typeof prioritizeOverview !== 'boolean'
          || !Number.isSafeInteger(maxCharacters) || maxCharacters < 1 || maxCharacters > 8_000
          || !Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > MAX_SEARCH_RESULTS) {
          throw new Error('Document search request is invalid.');
        }
        const refreshed = await syncSession(sessionId, { indexMissing: true, includeIgnored });
        if (ids.some((id) => !refreshed.references.some((reference) => reference.id === id))) {
          throw new Error('A selected document reference is no longer available to this conversation.');
        }
        const files = refreshed.files.filter((file) =>
          file.referenceIds.some((id) => ids.includes(id)));
        const filesById = new Map(files.map((file) => [file.id, file]));
        const results = [];
        const seen = new Set();
        let characters = 0;
        const addResult = (file, page, excerpt, score = 0) => {
          if (!excerpt || results.length >= maxResults || characters >= maxCharacters) return;
          const key = `${file.id}:${page ?? 'text'}:${excerpt.slice(0, 80)}`;
          if (seen.has(key)) return;
          const text = excerpt.slice(0, maxCharacters - characters);
          if (!text) return;
          seen.add(key);
          results.push({
            source: { documentId: file.id, name: file.name, page, excerpt: text },
            score,
          });
          characters += text.length;
        };

        const searchIndex = await readSearchIndex(sessionId);
        if (prioritizeOverview && searchIndex) {
          const overviewFiles = files
            .filter((file) => file.indexed && !file.ignored && projectOverviewPriority(file) < Number.MAX_SAFE_INTEGER)
            .sort((left, right) => projectOverviewPriority(left) - projectOverviewPriority(right)
              || left.name.localeCompare(right.name));
          const loadedCaches = new Map();
          for (const file of overviewFiles) {
            let indexed = loadedCaches.get(file.id);
            if (!indexed) {
              indexed = await readCache(sessionId, file);
              loadedCaches.set(file.id, indexed);
            }
            const chunk = indexed.chunks[0];
            if (chunk) addResult(file, chunk.page, chunk.text);
          }
        }
        if (searchIndex) {
          const candidates = rankIndexedChunks(searchIndex, query, Math.min(maxResults * 4, 20));
          const loadedCaches = new Map();
          for (const candidate of candidates) {
            const file = filesById.get(candidate.fileId);
            if (!file?.indexed || file.ignored) continue;
            let indexed = loadedCaches.get(file.id);
            if (!indexed) {
              indexed = await readCache(sessionId, file);
              loadedCaches.set(file.id, indexed);
            }
            const chunk = indexed.chunks[candidate.chunkIndex];
            if (!chunk) throw new Error('The local document search index references a missing passage.');
            addResult(file, chunk.page, chunk.text, candidate.score);
          }
        }

        const ephemeralFiles = files.filter((file) => !file.indexed && (includeIgnored || !file.ignored));
        let examinedFiles = 0;
        let examinedBytes = 0;
        const ephemeralMatches = [];
        for (const file of ephemeralFiles) {
          if (examinedFiles >= MAX_IGNORED_SEARCH_FILES || examinedBytes >= MAX_IGNORED_SEARCH_BYTES) break;
          const info = await lstat(file.path);
          if (info.isSymbolicLink() || !info.isFile() || info.size < 1 || info.size > MAX_FILE_SIZE) continue;
          if (examinedBytes + info.size > MAX_IGNORED_SEARCH_BYTES) continue;
          examinedFiles += 1;
          examinedBytes += info.size;
          const bytes = await readFile(file.path);
          if (bytes.length !== info.size) continue;
          const extracted = await extractDocument(file.extension, bytes);
          ephemeralMatches.push(...rankChunks(
            extracted.chunks.map((chunk) => ({ file, chunk })),
            query,
          ));
        }
        for (const match of ephemeralMatches) addResult(match.file, match.chunk.page, match.chunk.text, match.score);
        await touchSessionCache(sessionId);
        return results.map(({ source }) => source);
      });
    },
    readExcerpt(sessionId, referenceIds, fileId, query = '') {
      return serializeMutation(async () => {
        validateSessionId(sessionId);
        validateId(fileId);
        if (!Array.isArray(referenceIds) || referenceIds.length > MAX_REFERENCES_PER_SESSION
          || referenceIds.some((id) => typeof id !== 'string')) {
          throw new Error(`A conversation can attach no more than ${MAX_REFERENCES_PER_SESSION} references.`);
        }
        const ids = [...new Set(referenceIds)];
        for (const id of ids) validateId(id);
        if (typeof query !== 'string' || query.length > 2_000) {
          throw new Error('Document read query is invalid.');
        }
        const refreshed = await syncSession(sessionId, { indexMissing: false, includeIgnored: true });
        const file = refreshed.files.find((entry) =>
          entry.id === fileId && entry.referenceIds.some((id) => ids.includes(id)));
        if (!file) throw new Error('That file is not attached to this conversation.');
        const info = await lstat(file.path);
        if (info.isSymbolicLink() || !info.isFile() || info.size < 1 || info.size > MAX_FILE_SIZE
          || await realpath(file.path) !== file.path) {
          throw new Error('The attached file is no longer safe to read.');
        }
        const bytes = await readFile(file.path);
        if (bytes.length !== info.size) throw new Error('The file changed while it was being read. Try again.');
        const extracted = await extractDocument(file.extension, bytes);
        const ranked = query.trim()
          ? rankChunks(extracted.chunks.map((chunk) => ({ file, chunk })), query)
          : extracted.chunks.map((chunk) => ({ file, chunk, score: 0 }));
        if (ranked.length === 0) return null;
        let excerpt = '';
        let page = null;
        for (const match of ranked) {
          const next = match.chunk.text.slice(0, MAX_TOOL_RESULT_CHARS - excerpt.length);
          if (next) {
            if (excerpt && match.chunk.page !== page) break;
            excerpt += `${excerpt ? '\n\n' : ''}${next}`;
            page = match.chunk.page;
          }
          if (excerpt.length >= MAX_TOOL_RESULT_CHARS) break;
        }
        await touchSessionCache(sessionId);
        return { documentId: file.id, name: file.name, page, excerpt };
      });
    },
    retrieve(sessionId, referenceIds, query, {
      maxCharacters = MAX_DOCUMENT_CONTEXT_CHARS,
      maxChunks = MAX_SEARCH_RESULTS,
    } = {}) {
      return serializeMutation(async () => {
        validateSessionId(sessionId);
        if (!Array.isArray(referenceIds) || referenceIds.length > MAX_REFERENCES_PER_SESSION
          || referenceIds.some((id) => typeof id !== 'string')) {
          throw new Error(`A conversation can attach no more than ${MAX_REFERENCES_PER_SESSION} references.`);
        }
        const ids = [...new Set(referenceIds)];
        for (const id of ids) validateId(id);
        if (typeof query !== 'string' || query.length > 12_000) {
          throw new Error('Document search query is invalid.');
        }
        if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 1 || maxCharacters > 24_000
          || !Number.isSafeInteger(maxChunks) || maxChunks < 1 || maxChunks > 100) {
          throw new Error('Document retrieval limits are invalid.');
        }
        if (ids.length === 0) return [];
        const refreshed = await syncSession(sessionId, { indexMissing: true });
        if (refreshed.errors.length > 0) {
          const firstError = refreshed.errors[0];
          throw new Error(`Could not refresh attached documents: ${firstError.name}: ${firstError.error}`);
        }
        if (ids.some((id) => !refreshed.references.some((reference) => reference.id === id))) {
          throw new Error('A selected document reference is no longer available to this conversation.');
        }
        const metadata = await readIndex();
        const files = metadata.files.filter((file) =>
          file.sessionId === sessionId && file.referenceIds.some((id) => ids.includes(id)));
        const directPaths = new Set(metadata.references
          .filter((reference) => reference.sessionId === sessionId && referenceIds.includes(reference.id)
            && reference.kind === 'file')
          .map((reference) => reference.path));

        const sources = [];
        let characters = 0;
        const addSource = (file, page, excerpt) => {
          if (!excerpt || sources.length >= maxChunks || characters >= maxCharacters) return;
          const text = excerpt.slice(0, maxCharacters - characters);
          if (!text) return;
          sources.push({
            citationId: `S${sources.length + 1}`,
            documentId: file.id,
            name: file.name,
            page,
            excerpt: text,
          });
          characters += text.length;
        };
        const directCandidates = files.filter((file) => directPaths.has(file.path) && file.indexed);
        for (const file of directCandidates) {
          const indexed = await readCache(sessionId, file);
          const pageTextLength = indexed.pages.reduce((sum, page) => sum + page.text.length, 0);
          if (pageTextLength <= maxCharacters - characters
            && sources.length + indexed.pages.length <= maxChunks) {
            for (const page of indexed.pages) addSource(file, page.page, page.text);
          }
        }
        const searchIndex = await readSearchIndex(sessionId);
        const filesById = new Map(files.map((file) => [file.id, file]));
        const candidates = searchIndex ? rankIndexedChunks(searchIndex, query, maxChunks * 4) : [];
        const caches = new Map();
        for (const candidate of candidates) {
          const file = filesById.get(candidate.fileId);
          if (!file?.indexed || file.ignored || directPaths.has(file.path)) continue;
          let indexed = caches.get(file.id);
          if (!indexed) {
            indexed = await readCache(sessionId, file);
            caches.set(file.id, indexed);
          }
          const chunk = indexed.chunks[candidate.chunkIndex];
          if (!chunk) throw new Error('The local document search index references a missing passage.');
          addSource(file, chunk.page, chunk.text);
          if (sources.length >= maxChunks || characters >= maxCharacters) break;
        }
        return sources;
      });
    },
    prepareEdit(sessionId, fileId, newContent) {
      return serializeMutation(async () => {
        validateSessionId(sessionId);
        validateId(fileId);
        if (typeof newContent !== 'string' || !newContent.trim()
          || Buffer.byteLength(newContent, 'utf8') > MAX_FILE_SIZE) {
          throw new Error(`Proposed file content must be non-empty and no larger than ${MAX_FILE_SIZE / 1024 / 1024} MB.`);
        }
        const refreshed = await syncSession(sessionId, { indexMissing: false, includeIgnored: true });
        const file = refreshed.files.find((entry) => entry.id === fileId);
        if (!file) throw new Error('That file is not attached to this conversation.');
        if (!EDITABLE_EXTENSIONS.has(file.extension)) {
          throw new Error('Only supported text files can be edited in place. PDFs are read-only.');
        }
        const newBytes = Buffer.from(newContent, 'utf8');
        const extracted = await extractDocument(file.extension, newBytes);
        const info = await lstat(file.path);
        if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_FILE_SIZE) {
          throw new Error('The attached file is no longer safe to edit.');
        }
        const actualPath = await realpath(file.path);
        if (actualPath !== file.path) throw new Error('The attached file path changed. Reattach it before editing.');
        const oldBytes = await readFile(file.path);
        const oldContent = new TextDecoder('utf-8', { fatal: true }).decode(oldBytes);
        const proposalId = randomUUID();
        const proposal = {
          id: proposalId,
          sessionId,
          fileId,
          name: file.name,
          oldContent,
          newContent,
          expectedHash: hash(oldBytes),
          expectedMtimeMs: info.mtimeMs,
          expectedSize: info.size,
          referenceIds: [...file.referenceIds],
          newSize: newBytes.length,
          newSha256: hash(newBytes),
          newChunkCount: extracted.chunks.length,
        };
        editProposals.set(proposalId, proposal);
        return {
          proposalId,
          documentId: file.id,
          name: file.name,
          oldContent,
          newContent,
        };
      });
    },
    applyEdit(proposalId, sessionId) {
      return serializeMutation(async () => {
        validateSessionId(sessionId);
        const proposal = editProposals.get(proposalId);
        if (!proposal || proposal.sessionId !== sessionId) {
          throw new Error('This document edit proposal is no longer available.');
        }
        editProposals.delete(proposalId);
        const metadata = await readIndex();
        const file = metadata.files.find((entry) => entry.id === proposal.fileId && entry.sessionId === sessionId);
        if (!file || !proposal.referenceIds.some((id) => metadata.references.some((reference) =>
          reference.id === id && reference.sessionId === sessionId))) {
          throw new Error('This file is no longer attached to the conversation.');
        }
        const info = await lstat(file.path);
        if (info.isSymbolicLink() || !info.isFile()) throw new Error('The attached file is no longer a regular file.');
        const currentPath = await realpath(file.path);
        if (currentPath !== file.path) throw new Error('The attached file path changed; the edit was not applied.');
        const oldBytes = await readFile(file.path);
        if (info.size !== proposal.expectedSize || info.mtimeMs !== proposal.expectedMtimeMs
          || hash(oldBytes) !== proposal.expectedHash) {
          throw new Error('The file changed after this diff was prepared. Review a new diff before applying edits.');
        }
        const temporaryPath = join(dirname(file.path), `.${basename(file.path)}.${randomUUID()}.livingwords.tmp`);
        try {
          await writeFile(temporaryPath, proposal.newContent, {
            encoding: 'utf8',
            mode: info.mode & 0o777,
            flag: 'wx',
          });
          await rename(temporaryPath, file.path);
        } catch (error) {
          await rm(temporaryPath, { force: true });
          throw new Error(`Could not apply the approved edit to "${file.name}": ${error.message}`, { cause: error });
        }
        const updatedInfo = await stat(file.path);
        const nextFile = {
          ...file,
          size: proposal.newSize,
          mtimeMs: updatedInfo.mtimeMs,
          sha256: proposal.newSha256,
          chunkCount: proposal.newChunkCount,
          indexed: true,
        };
        const extracted = await extractDocument(file.extension, Buffer.from(proposal.newContent, 'utf8'));
        const cacheUsage = await measureCacheUsage(metadata);
        await writeCache(sessionId, nextFile, extracted, metadata, cacheUsage);
        const searchIndex = await readSearchIndex(sessionId) ?? createSearchIndex();
        removeFileFromSearchIndex(searchIndex, file.id);
        addFileToSearchIndex(searchIndex, file.id, extracted.chunks);
        await writeSearchIndex(sessionId, searchIndex, metadata, cacheUsage);
        await writeIndex({
          ...metadata,
          files: metadata.files.map((entry) => entry.id === file.id ? nextFile : entry),
        });
        await touchSessionCache(sessionId);
        return { name: file.name };
      });
    },
    discardEdit(proposalId, sessionId) {
      const proposal = editProposals.get(proposalId);
      if (!proposal || proposal.sessionId !== sessionId) return false;
      editProposals.delete(proposalId);
      return true;
    },
  });
}
