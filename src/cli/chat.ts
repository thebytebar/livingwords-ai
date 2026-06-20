#!/usr/bin/env node
/**
 * CLI Chatbot for LivingWords LLM
 * Interactive REPL for chatting with the model.
 */

import { LivingWordsLLM } from '../core/model.js';
import { configs } from '../core/config.js';
import { buildExplanationPrompt } from '../core/verse.js';
import * as readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';

export async function startChat(loadDir: string = 'weights'): Promise<void> {
  const model = new LivingWordsLLM(configs.theoSmall);
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

      // Build a smart prompt.
      // - If the user mentions a specific verse (John 3:16, Psalm 23, etc.) we look up the
      //   actual text from the Bible corpus and seed with "Verse text\n\nThis verse teaches that "
      //   so the model produces an explanation instead of random continuation.
      // - Otherwise fall back to the theological steering phrase.
      const modelPrompt = await buildExplanationPrompt(userInput);

      let continuation = (await model.generate(modelPrompt, 55)).replace(/^[\s,.;:'"!?]+/, '').trim();
      // Extra safety strip for any remaining common starters.
      continuation = continuation.replace(/^(?:and |of |for |the |that |which |unto )+/i, '').trim();
      const toShow = continuation || '[...]';
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
