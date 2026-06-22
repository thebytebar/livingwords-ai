#!/usr/bin/env node
/**
 * CLI Chatbot for LivingWords LLM
 * Interactive REPL for chatting with the model.
 */

import { LivingWordsLLM } from '../core/model.js';
import { configs } from '../core/config.js';
import * as readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import { appendFile, mkdir, open } from 'fs/promises';
import { dirname, resolve } from 'path';

export interface ChatOptions {
  dpo?: boolean;
}

export async function startChat(loadDir: string = 'weights', opts: ChatOptions = {}): Promise<void> {
  const model = new LivingWordsLLM(configs.theoSmall);
  await model.load(loadDir);

  const dpoMode = !!opts.dpo;

  console.log('\n🙏  LivingWords LLM — Interactive Chatbot');
  console.log('    Aligned with Christian theological doctrine.');
  if (dpoMode) {
    console.log('    *** LIVE DPO CAPTURE MODE ENABLED ***');
    console.log('    After each response: type A (approve=chosen) or R (reject=rejected).');
    console.log('    Pairs are appended live to data/dpo/dpo_prefs.jsonl');
  }
  console.log('    Type "exit", "quit", or Ctrl+C to leave.\n');

  const rl = readline.createInterface({ input, output });

  const dpoDataPath = resolve(process.cwd(), 'data/dpo/dpo_prefs.jsonl');

  // DPO live capture state (keyed by exact prompt text)
  const dpoPending = new Map<string, { chosen?: string; rejected?: string }>();
  let pairsWritten = 0;

  async function appendDpoPair(prompt: string, chosen: string, rejected: string): Promise<void> {
    await mkdir(dirname(dpoDataPath), { recursive: true });

    // Ensure we start on a new line (handles files that may not have trailing \n)
    let prefix = '';
    try {
      const fh = await open(dpoDataPath, 'r');
      const stat = await fh.stat();
      if (stat.size > 0) {
        const buf = Buffer.alloc(1);
        await fh.read(buf, 0, 1, stat.size - 1);
        if (buf[0] !== 10) prefix = '\n'; // 10 = '\n'
      }
      await fh.close();
    } catch {
      // file didn't exist or unreadable; appendFile will create it cleanly
    }

    const record = JSON.stringify({ prompt, chosen, rejected });
    await appendFile(dpoDataPath, prefix + record + '\n', 'utf8');

    pairsWritten += 1;
    console.log(`\n📝  DPO pair written (chosen vs rejected) → data/dpo/dpo_prefs.jsonl`);
    console.log(`    Total pairs captured this session: ${pairsWritten}`);
  }

  function recordDpo(prompt: string, response: string, isChosen: boolean): void {
    const entry = dpoPending.get(prompt) || {};
    if (isChosen) {
      entry.chosen = response;
    } else {
      entry.rejected = response;
    }
    dpoPending.set(prompt, entry);
  }

  async function tryWriteDpoPair(prompt: string): Promise<boolean> {
    const entry = dpoPending.get(prompt);
    if (entry?.chosen && entry?.rejected) {
      if (entry.chosen !== entry.rejected) {
        await appendDpoPair(prompt, entry.chosen, entry.rejected);
      }
      dpoPending.delete(prompt);
      return true;
    }
    return false;
  }

  async function handleDpoRating(prompt: string, response: string): Promise<void> {
    if (!response || !response.trim()) return;

    const raw = (await rl.question('[DPO] (A)pprove / (R)eject this response? (Enter=skip) ')).trim();
    const key = raw[0]?.toUpperCase();
    if (key !== 'A' && key !== 'R') return;

    const isChosen = key === 'A';
    recordDpo(prompt, response, isChosen);

    const wrote = await tryWriteDpoPair(prompt);
    if (wrote) return;

    const sideNeeded = isChosen ? 'a rejected (bad) response' : 'an approved (good) response';
    console.log(`   ✓ Marked ${isChosen ? 'APPROVED' : 'REJECTED'}. Need ${sideNeeded} for this prompt to save a pair.`);

    const again = (await rl.question('   Generate another response now (for the opposite side)? (y/N) ')).trim().toLowerCase();
    if (again === 'y' || again === 'yes') {
      console.log('   Generating alternate sample...\n');
      const alt = await model.generate(prompt, 55);
      console.log('LivingWords:', alt);
      console.log('');
      await handleDpoRating(prompt, alt);
    }
  }

  try {
    while (true) {
      let userInput = '';
      try {
        userInput = (await rl.question('You: ')).trim();
      } catch {
        break; // stdin closed or error
      }
      if (!userInput) continue;
      const lower = userInput.toLowerCase();
      if (['exit', 'quit', 'q', 'bye'].includes(lower)) {
        console.log('\nGrace and peace to you. Goodbye.\n');
        break;
      }

      const text = await model.generate(userInput, 55);
      console.log('LivingWords:', text);
      console.log('');

      if (dpoMode) {
        await handleDpoRating(userInput, text);
      }
    }
  } finally {
    if (dpoMode && pairsWritten > 0) {
      console.log(`\n📦 DPO capture finished — ${pairsWritten} pair(s) written to data/dpo/dpo_prefs.jsonl`);
      console.log('   You can train with them using:');
      console.log('   cd training && python dpo.py --data ../data/dpo/dpo_prefs.jsonl --max-iters 100\n');
    }
    rl.close();
  }
}

// Allow direct execution: node dist/cli/chat.js or ts-node-esm
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('chat.ts')) {
  const args = process.argv.slice(2);
  const load = args.find((a) => !a.startsWith('-')) || 'weights';
  const dpo = args.includes('--dpo') || args.includes('-d');
  startChat(load, { dpo }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
