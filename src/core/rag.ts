import { createHash } from 'node:crypto';
import { readFile, readdir, mkdir, stat, writeFile } from 'node:fs/promises';
import { basename, extname, relative, resolve } from 'node:path';

export interface Passage {
  id: string;
  source: string;
  chunk: number;
  text: string;
}

export interface RagIndex {
  version: 1;
  createdAt: string;
  passages: Passage[];
}

export interface RankedPassage {
  passage: Passage;
  score: number;
}

export interface SourceCitation {
  id: string;
  source: string;
  chunk: number;
}

export interface GroundedAnswer {
  answer: string;
  supported: boolean;
  grounded: boolean;
  sources: SourceCitation[];
}

const DEFAULT_CHUNK_SIZE = 1200;
const DEFAULT_OVERLAP = 180;
const DEFAULT_TOP_K = 4;
const MAX_TOP_K = 8;
const MIN_RETRIEVAL_SCORE = 0.15;
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'can',
  'do', 'for', 'from', 'how', 'i', 'in', 'is', 'it', 'of', 'on', 'or',
  'that', 'the', 'this', 'to', 'was', 'what', 'when', 'where', 'which',
  'who', 'why', 'with',
]);

function terms(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu)?.filter((term) => !STOP_WORDS.has(term)) ?? [];
}

export function chunkText(text: string, chunkSize = DEFAULT_CHUNK_SIZE, overlap = DEFAULT_OVERLAP): string[] {
  if (!Number.isInteger(chunkSize) || chunkSize < 1) throw new Error('chunkSize must be a positive integer');
  if (!Number.isInteger(overlap) || overlap < 0 || overlap >= chunkSize) {
    throw new Error('overlap must be a non-negative integer smaller than chunkSize');
  }

  const words = text.trim().split(/\s+/u).filter(Boolean);
  if (words.length === 0) return [];

  const chunks: string[] = [];
  let start = 0;
  while (start < words.length) {
    let end = start;
    let length = 0;
    while (end < words.length) {
      const nextLength = length + (end === start ? 0 : 1) + words[end]!.length;
      if (end > start && nextLength > chunkSize) break;
      length = nextLength;
      end += 1;
    }
    chunks.push(words.slice(start, end).join(' '));
    if (end === words.length) break;

    const targetStart = Math.max(start + 1, end - Math.ceil(overlap / 5));
    start = targetStart;
  }
  return chunks;
}

async function corpusFiles(inputPath: string): Promise<{ root: string; files: string[] }> {
  const root = resolve(inputPath);
  const inputStat = await stat(root);
  if (inputStat.isFile()) {
    if (!['.txt', '.md'].includes(extname(root).toLowerCase())) {
      throw new Error('Corpus files must have a .txt or .md extension');
    }
    return { root: resolve(root, '..'), files: [root] };
  }
  if (!inputStat.isDirectory()) throw new Error(`Corpus path is not a file or directory: ${inputPath}`);

  const files: string[] = [];
  async function visit(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && ['.txt', '.md'].includes(extname(entry.name).toLowerCase())) files.push(path);
    }
  }
  await visit(root);
  files.sort();
  return { root, files };
}

export async function buildIndex(
  inputPath: string,
  options: { chunkSize?: number; overlap?: number } = {},
): Promise<RagIndex> {
  const { root, files } = await corpusFiles(inputPath);
  const passages: Passage[] = [];
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    const source = relative(root, file) || basename(file);
    chunkText(text, options.chunkSize, options.overlap).forEach((chunk, index) => {
      const id = createHash('sha256').update(`${source}\0${index}\0${chunk}`).digest('hex').slice(0, 16);
      passages.push({ id, source, chunk: index + 1, text: chunk });
    });
  }
  if (passages.length === 0) throw new Error(`No non-empty .txt or .md documents found at ${inputPath}`);
  return { version: 1, createdAt: new Date().toISOString(), passages };
}

export async function writeIndex(index: RagIndex, indexPath: string): Promise<void> {
  const destination = resolve(indexPath);
  await mkdir(resolve(destination, '..'), { recursive: true });
  await writeFile(destination, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
}

export async function readIndex(indexPath: string): Promise<RagIndex> {
  const resolvedPath = resolve(indexPath);
  let contents: string;
  try {
    contents = await readFile(resolvedPath, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      throw new Error(
        `RAG index not found at ${resolvedPath}. Add your own .txt or .md source files, then run ` +
        '`npx lw ingest <path-to-your-sources>` before starting chat. ' +
        'For a custom index path, pass the same `--index <path>` to both ingest and chat.',
        { cause: error },
      );
    }
    throw error;
  }
  const raw: unknown = JSON.parse(contents);
  if (
    !raw || typeof raw !== 'object' || !('version' in raw) || raw.version !== 1 ||
    !('passages' in raw) || !Array.isArray(raw.passages)
  ) {
    throw new Error(`Invalid or unsupported RAG index: ${indexPath}`);
  }
  const index = raw as RagIndex;
  if (!index.passages.every((p) =>
    p && typeof p.id === 'string' && typeof p.source === 'string' &&
    Number.isInteger(p.chunk) && typeof p.text === 'string'
  )) {
    throw new Error(`Malformed passage in RAG index: ${indexPath}`);
  }
  return index;
}

export async function readIndexIfPresent(indexPath: string): Promise<RagIndex | null> {
  try {
    return await readIndex(indexPath);
  } catch (error) {
    if (error instanceof Error && error.cause && typeof error.cause === 'object' &&
        'code' in error.cause && error.cause.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export function retrieve(query: string, passages: Passage[], topK = DEFAULT_TOP_K): RankedPassage[] {
  if (!Number.isInteger(topK) || topK < 1 || topK > MAX_TOP_K) {
    throw new Error(`topK must be an integer between 1 and ${MAX_TOP_K}`);
  }
  const queryTerms = terms(query);
  if (queryTerms.length === 0 || passages.length === 0) return [];

  const documentTerms = passages.map((passage) => terms(passage.text));
  const averageLength = documentTerms.reduce((sum, doc) => sum + doc.length, 0) / documentTerms.length || 1;
  const documentFrequency = new Map<string, number>();
  for (const doc of documentTerms) {
    for (const term of new Set(doc)) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  }

  const ranked = passages.map((passage, index) => {
    const doc = documentTerms[index]!;
    const frequencies = new Map<string, number>();
    for (const term of doc) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
    let score = 0;
    for (const term of new Set(queryTerms)) {
      const frequency = frequencies.get(term) ?? 0;
      if (!frequency) continue;
      const df = documentFrequency.get(term) ?? 0;
      const idf = Math.log(1 + (passages.length - df + 0.5) / (df + 0.5));
      score += idf * (frequency * 2.2) /
        (frequency + 1.2 * (0.25 + 0.75 * doc.length / averageLength));
    }
    return { passage, score };
  });

  return ranked
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.passage.source.localeCompare(b.passage.source) || a.passage.chunk - b.passage.chunk)
    .slice(0, topK);
}

export function applyCitations(answer: string, citations: SourceCitation[]): GroundedAnswer {
  const citationMap = new Map(citations.map((citation) => [citation.id, citation]));
  const citedIds = new Set<string>();
  const filtered = answer.replace(/\[(S\d+)\]/gu, (reference, id: string) => {
    if (!citationMap.has(id)) return '';
    citedIds.add(id);
    return reference;
  }).trim();

  if (filtered.length === 0) throw new Error('The local model returned an empty answer');
  if (citedIds.size > 0) {
    const citedSources = citations.filter((citation) => citedIds.has(citation.id));
    const sourceList = citedSources.map((citation) =>
      `[${citation.id}] ${citation.source}#${citation.chunk}`
    ).join('; ');
    return {
      answer: `${filtered}\n\nSources: ${sourceList}`,
      supported: true,
      grounded: true,
      sources: citedSources,
    };
  }

  const sourceList = citations.map((citation) => `[${citation.id}] ${citation.source}#${citation.chunk}`).join('; ');
  return {
    answer: `${filtered}\n\nSources consulted: ${sourceList}`,
    supported: true,
    grounded: true,
    sources: citations,
  };
}

export const UNSUPPORTED_ANSWER =
  "I couldn't find support for that in the indexed sources. Please add a relevant source or ask a narrower question.";
export const UNGROUNDED_NOTICE =
  'No source corpus is indexed. This is a general AI answer, not grounded in your documents.';
export const GENERAL_ANSWER_NOTICE =
  'General-purpose AI answer; this response was not grounded in indexed sources.';

export async function answerQuestion(
  question: string,
  index: RagIndex | null,
  options: {
    topK?: number;
    generate?: (systemPrompt: string, userPrompt: string, maxTokens: number) => Promise<string>;
    maxTokens?: number;
  } = {},
): Promise<GroundedAnswer> {
  if (!question.trim()) throw new Error('question is required');
  if (!options.generate) throw new Error('A local model generation function is required');
  if (!index) {
    const systemPrompt = [
      'You are a helpful general-purpose assistant.',
      'No source documents are provided. Answer using your general pretrained knowledge,',
      'do not invent citations or claim that an answer is supported by an indexed source,',
      'and acknowledge uncertainty when appropriate.',
    ].join(' ');
    const generated = await options.generate(systemPrompt, question, options.maxTokens ?? 384);
    if (!generated.trim()) throw new Error('The local model returned an empty answer');
    return {
      answer: `${UNGROUNDED_NOTICE}\n\n${generated.trim()}`,
      supported: false,
      grounded: false,
      sources: [],
    };
  }

  const passages = retrieve(question, index.passages, options.topK ?? DEFAULT_TOP_K);
  if (passages.length === 0 || passages[0]!.score < MIN_RETRIEVAL_SCORE) {
    return { answer: UNSUPPORTED_ANSWER, supported: false, grounded: false, sources: [] };
  }

  const citations = passages.map(({ passage }, index) => ({
    id: `S${index + 1}`,
    source: passage.source,
    chunk: passage.chunk,
  }));
  const evidence = passages.map(({ passage }, index) =>
    `[S${index + 1}] ${passage.source}#${passage.chunk}\n${passage.text}`
  ).join('\n\n');
  const systemPrompt = [
    'Answer the user using only the supplied source excerpts.',
    'Cite each source-supported factual statement with its exact identifier, such as [S1].',
    'Do not add outside facts, doctrinal claims, quotations, or interpretations not supported by the excerpts.',
    'If the excerpts do not establish an answer, say that the indexed sources do not provide enough support.',
    'Distinguish direct quotations from your own summary. Be concise and preserve uncertainty.',
  ].join(' ');
  const userPrompt = `Question:\n${question}\n\nSource excerpts:\n${evidence}`;
  const generated = await options.generate(systemPrompt, userPrompt, options.maxTokens ?? 384);
  return applyCitations(generated, citations);
}
