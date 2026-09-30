#!/usr/bin/env node

import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { answerQuestion, readIndexIfPresent, UNGROUNDED_NOTICE } from '../core/rag.js';
import { generateLocalChatCompletion } from '../core/local-model.js';
import { ensureLocalModelServer, stopLocalModelServer } from '../core/model-server.js';

export async function startChat(indexPath = '.livingwords/index.json'): Promise<void> {
  const index = await readIndexIfPresent(indexPath);
  await ensureLocalModelServer();
  const rl = readline.createInterface({ input, output });
  console.log('\nLivingWords — local chat');
  if (index) {
    console.log(`Source grounding enabled (${index.passages.length} indexed passages).`);
  } else {
    console.log(UNGROUNDED_NOTICE);
  }
  console.log('Type "exit" or press Ctrl+C to leave.\n');
  try {
    while (true) {
      let question: string;
      try {
        question = (await rl.question('You: ')).trim();
      } catch {
        break;
      }
      if (!question) continue;
      if (['exit', 'quit', 'q', 'bye'].includes(question.toLowerCase())) break;
      const result = await answerQuestion(question, index, {
        generate: (system, user, maxTokens) => generateLocalChatCompletion(system, user, maxTokens),
      });
      console.log(`\nLivingWords: ${result.answer}\n`);
    }
  } finally {
    rl.close();
    await stopLocalModelServer();
  }
}
