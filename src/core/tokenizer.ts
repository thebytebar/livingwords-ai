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
  corpus: string,
  targetVocabSize: number = 1536
): Tokenizer {
  const enc = getBaseEncoding();
  const tokenFreq: Map<number, number> = new Map();

  // Tokenize the entire corpus and count frequencies
  const tokens = Array.from(enc.encode(corpus));
  for (const t of tokens) {
    tokenFreq.set(t, (tokenFreq.get(t) || 0) + 1);
  }

  // Sort by frequency and keep the top N tokens
  const sorted = Array.from(tokenFreq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, targetVocabSize - 4); // reserve space for special tokens

  const vocabMap = new Map<number, number>(); // original tiktoken id -> compact id
  let compactId = 4;

  for (const [origId] of sorted) {
    vocabMap.set(origId, compactId++);
  }

  const reverseMap = new Map<number, number>(); // compact id -> original tiktoken id
  for (const [orig, compact] of vocabMap.entries()) {
    reverseMap.set(compact, orig);
  }

  const unkId = 1;

  return {
    encode: (text: string): number[] => {
      const rawTokens: number[] = Array.from(enc.encode(text));
      return rawTokens.map(t => vocabMap.get(t) ?? unkId);
    },
    decode: (ids: number[]): string => {
      const originalIds = ids.map(id => reverseMap.get(id) ?? 0);
      const bytes = enc.decode(new Uint32Array(originalIds));
      return new TextDecoder().decode(bytes);
    },
    get vocabSize() {
      return targetVocabSize;
    },
  };
}
