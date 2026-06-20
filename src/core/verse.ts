/**
 * Simple Bible verse resolver for improving prompts.
 * Uses the pretrain bible text to inject actual verse wording
 * when the user asks about a specific reference.
 *
 * This helps the small model produce better "explanation" style output
 * by giving it the actual text + a good starter.
 */

import { readFile } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

let bibleTextCache: string | null = null;

async function getBibleText(): Promise<string> {
  if (bibleTextCache) return bibleTextCache;

  // Try a few common locations relative to the running code
  const candidates = [
    'data/pretrain_bible.txt',
    '../data/pretrain_bible.txt',
    '../../data/pretrain_bible.txt',
  ];

  // Resolve relative to this file when running from src or dist
  const here = dirname(fileURLToPath(import.meta.url));
  const searchRoots = [process.cwd(), resolve(here, '..'), resolve(here, '../..')];

  for (const root of searchRoots) {
    for (const cand of candidates) {
      try {
        const full = resolve(root, cand);
        const txt = await readFile(full, 'utf8');
        bibleTextCache = txt;
        return txt;
      } catch {}
    }
  }

  // Fallback to a tiny known verse if file not found
  return 'John 3:16 For God so loved the world, that he gave his only begotten Son, that whoever believes in him should not perish, but have everlasting life.';
}

export interface VerseRef {
  book: string;
  chapter: number;
  verse: number;
}

export function parseVerseRef(input: string): VerseRef | null {
  // Matches common forms: John 3:16, 1 John 3:16, Psalm 23:1, Jn. 3.16, etc.
  const m = input.match(/([1-3]?\s*[A-Za-z]+)\.?\s*(\d+)[:.](\d+)/i);
  if (!m) return null;
  return {
    book: m[1].trim(),
    chapter: parseInt(m[2], 10),
    verse: parseInt(m[3], 10),
  };
}

function normalizeBook(b: string): string {
  return b.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export async function getVerseText(refStr: string): Promise<string | null> {
  const ref = parseVerseRef(refStr);
  if (!ref) return null;

  const text = await getBibleText();
  const lines = text.split('\n');

  const targetBook = normalizeBook(ref.book);

  for (const line of lines) {
    const m = line.match(/^([1-3]?\s*[A-Za-z]+)\s*(\d+):(\d+)\s+(.*)/);
    if (!m) continue;

    const book = normalizeBook(m[1]);
    const ch = parseInt(m[2], 10);
    const v = parseInt(m[3], 10);

    if (book === targetBook && ch === ref.chapter && v === ref.verse) {
      return `${m[1]} ${ch}:${v} ${m[4].trim()}`;
    }
  }

  return null;
}

export async function buildExplanationPrompt(userQuery: string): Promise<string> {
  // Detect if this looks like a request to explain a specific verse
  const ref = parseVerseRef(userQuery);
  if (ref) {
    const verseText = await getVerseText(userQuery);
    if (verseText) {
      // Strong in-domain starter that the model responds well to
      return `${verseText}\n\nThis verse teaches that `;
    }
    // Fallback if verse text not found
    return `${userQuery}. The meaning of this passage is that `;
  }

  // For general "tell me about X" theological questions, use the Trinity-style steering
  const q = userQuery.toLowerCase();
  if (q.includes('trinity') || q.includes('father') || q.includes('son') || q.includes('holy spirit') ||
      /\b(what|explain|about|doctrine|mean)\b/i.test(q)) {
    return `${userQuery}. The Father and the Son and the Holy Spirit `;
  }

  return userQuery;
}
