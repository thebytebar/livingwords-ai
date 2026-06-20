/**
 * Tiktoken-based subword tokenizer with small vocabulary support.
 * Allows us to stay under ~500k total parameters.
 */

import * as tiktoken from 'tiktoken';

export interface Tokenizer {
  encode(text: string): number[];
  decode(ids: number[]): string;
  vocabSize: number;
}

let baseEncoding: tiktoken.Tiktoken | null = null;

function getBaseEncoding() {
  if (!baseEncoding) {
    baseEncoding = tiktoken.get_encoding('cl100k_base');
  }
  return baseEncoding;
}

/**
 * Creates a small-vocab tokenizer by taking the most common tokens
 * from tiktoken on the provided corpus.
 */
export function createSmallTiktokenTokenizer(
  corpus: string = '',
  targetVocabSize: number = 1536,
  fixedKeptOrigIds?: number[]
): Tokenizer {
  const enc = getBaseEncoding();

  const vocabMap = new Map<number, number>(); // original tiktoken id -> compact id
  let compactId = 4;

  let kept: number[];
  if (fixedKeptOrigIds && fixedKeptOrigIds.length > 0) {
    kept = fixedKeptOrigIds.slice(0, targetVocabSize - 4);
  } else if (corpus && corpus.length > 0) {
    const tokenFreq: Map<number, number> = new Map();
    const tokens = Array.from(enc.encode(corpus));
    for (const t of tokens) {
      tokenFreq.set(t, (tokenFreq.get(t) || 0) + 1);
    }
    const sorted = Array.from(tokenFreq.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, targetVocabSize - 4);
    kept = sorted.map(([id]) => id);
  } else {
    kept = [];
  }

  // Direct array reverse lookup (compactId -> original tiktoken id).
  // Far more reliable than a Map under ts-node / ESM caching.
  const origByCompact: number[] = [];
  for (const origId of kept) {
    vocabMap.set(origId, compactId);
    origByCompact[compactId] = origId;
    compactId++;
  }

  const unkId = 1;

  const tok: any = {
    encode: (text: string): number[] => {
      const rawTokens: number[] = Array.from(enc.encode(text));
      return rawTokens.map(t => vocabMap.get(t) ?? unkId);
    },
    decode: (ids: number[]): string => {
      // Map compact ids back to cl100k orig ids. Use replacement char for any
      // that would produce the "!" byte (reserved/UNK ids). This prevents the
      // confusing "!!Psalm" style garbage even if bad ids slip through.
      const pieces: string[] = [];
      for (const id of ids) {
        const orig = (id >= 4 && id < origByCompact.length) ? origByCompact[id] : 0;
        if (!orig) {
          pieces.push('\uFFFD'); // �
          continue;
        }
        const bytes = enc.decode([orig] as any);
        const s = (bytes instanceof Uint8Array) ? new TextDecoder().decode(bytes) : String(bytes);
        pieces.push(s);
      }
      return pieces.join('');
    },
    get vocabSize() {
      return targetVocabSize;
    },
  };

  if (!fixedKeptOrigIds && kept.length > 0) {
    tok._subwordKeptIds = kept;
  }

  return tok as Tokenizer;
}
