#!/usr/bin/env node
/**
 * CLI Chatbot for LivingWords LLM
 * Interactive REPL for chatting with the model.
 */

import { LivingWordsLLM } from '../core/model.js';
import { configs } from '../core/config.js';
import * as readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';

export async function startChat(loadDir: string = 'weights'): Promise<void> {
  const model = new LivingWordsLLM(configs.pico);
  await model.load(loadDir);

  console.log('\n🙏  LivingWords LLM — Interactive Chatbot');
  console.log('    Aligned with Christian theological doctrine.');
  console.log('    Type "exit", "quit", or Ctrl+C to leave.\n');

  const rl = readline.createInterface({ input, output });

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

      // Each turn uses the user message as the prompt for a faithful continuation.
      const reply = await model.generate(userInput, 96);
      let continuation = reply.startsWith(userInput)
        ? reply.slice(userInput.length)
        : reply;

      // Clean leading punctuation/spaces for nicer display
      continuation = continuation.replace(/^[\s,.;:'"!?]+/, '').trim();

      // Fallback to full reply for subword tokenizers (where exact string prefix may not match due to UNKs)
      // or when only new tokens after clean are empty.
      const toShow = continuation || reply || '[...]';
      console.log('LivingWords:', toShow);
      console.log('');
    }
  } finally {
    rl.close();
  }
}

// Allow direct execution: node dist/cli/chat.js or ts-node-esm
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('chat.ts')) {
  const load = process.argv[2] || 'weights';
  startChat(load).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
