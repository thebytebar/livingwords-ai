#!/usr/bin/env node

import { program } from 'commander';
import {
  answerQuestion,
  buildIndex,
  GENERAL_ANSWER_NOTICE,
  readIndexIfPresent,
  writeIndex,
} from '../core/rag.js';
import { generateLocalChatCompletion, gemma4DefaultModel } from '../core/local-model.js';
import { ensureLocalModelServer } from '../core/model-server.js';

const defaultIndex = '.livingwords/index.json';

program
  .name('lw')
  .description('Local Gemma 4 assistant with source-grounded RAG')
  .version('0.2.0');

program
  .command('ingest')
  .description('Chunk and index your local .txt and .md source documents')
  .argument('<path>', 'A document or directory of documents; no corpus is bundled')
  .option('-i, --index <path>', 'Output index path', defaultIndex)
  .option('--chunk-size <number>', 'Approximate maximum characters per chunk', '1200')
  .option('--overlap <number>', 'Approximate overlapping characters between chunks', '180')
  .action(async (path: string, options) => {
    const index = await buildIndex(path, {
      chunkSize: parseInt(options.chunkSize, 10),
      overlap: parseInt(options.overlap, 10),
    });
    await writeIndex(index, options.index);
    console.log(`Indexed ${index.passages.length} passages from ${path} → ${options.index}`);
  });

program
  .command('ask')
  .description('Answer from indexed sources, or use general knowledge when no index exists')
  .argument('<question>', 'Question to answer')
  .option('-i, --index <path>', 'RAG index path', defaultIndex)
  .option('-k, --top-k <number>', 'Evidence passages to include (1-8)', '4')
  .option('-m, --max-tokens <number>', 'Maximum answer tokens (8 GB profile caps at 512)', '384')
  .action(async (question: string, options) => {
    const index = await readIndexIfPresent(options.index);
    await ensureLocalModelServer();
    const result = await answerQuestion(question, index, {
      topK: parseInt(options.topK, 10),
      maxTokens: parseInt(options.maxTokens, 10),
      generate: (system, user, maxTokens) => generateLocalChatCompletion(system, user, maxTokens),
    });
    console.log(result.answer);
  });

program
  .command('generate')
  .description(`Generate a general-purpose response with local ${gemma4DefaultModel}`)
  .argument('<prompt>', 'Prompt to send to the local model')
  .option('-m, --max-tokens <number>', 'Maximum response tokens (8 GB profile caps at 512)', '256')
  .action(async (prompt: string, options) => {
    const text = await generateLocalChatCompletion(
      'You are a helpful general-purpose assistant. Answer accurately and acknowledge uncertainty.',
      prompt,
      parseInt(options.maxTokens, 10),
    );
    console.log(`${GENERAL_ANSWER_NOTICE}\n\n${text}`);
  });

program
  .command('chat')
  .description('Start local chat; answers are source-grounded when an index exists')
  .option('-i, --index <path>', 'RAG index path', defaultIndex)
  .action(async (options) => {
    const { startChat } = await import('./chat.js');
    await startChat(options.index);
  });

program
  .command('serve')
  .description('Start the local HTTP API and web chat; source grounding is optional')
  .option('-p, --port <number>', 'Port to listen on', '3000')
  .option('-i, --index <path>', 'RAG index path', defaultIndex)
  .action(async (options) => {
    const { startServer } = await import('./serve.js');
    await startServer(parseInt(options.port, 10), options.index);
  });

program.parseAsync().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
