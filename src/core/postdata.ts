/**
 * Post-training data loaders for SFT and DPO.
 * Minimal extensions for the LivingWords tiny model.
 */

import * as fs from 'fs/promises';

export interface SFTExample {
  text: string; // formatted as "Q: ... A: ..." or raw completion text
}

export interface PreferenceExample {
  prompt: string;
  chosen: string;
  rejected: string;
}

export async function loadSFTData(path: string): Promise<SFTExample[]> {
  const content = await fs.readFile(path, 'utf8');
  if (path.endsWith('.jsonl')) {
    return content.trim().split('\n').map(line => JSON.parse(line));
  }
  // Fallback: treat whole file as one example
  return [{ text: content }];
}

export async function loadPreferenceData(path: string): Promise<PreferenceExample[]> {
  const content = await fs.readFile(path, 'utf8');
  return content.trim().split('\n').map(line => JSON.parse(line));
}
