#!/usr/bin/env node

import { program } from 'commander';
import { LivingWordsLLM } from '../core/model.js';
import { configs } from '../core/config.js';
import { loadSFTData } from '../core/postdata.js';

program
  .name('lw-llm sft')
  .description('Supervised Fine-Tuning (SFT) on instruction or completion data')
  .option('-d, --data <path>', 'Path to SFT data (.jsonl or .txt)', 'data/sft.jsonl')
  .option('-e, --epochs <number>', 'Number of epochs', '2')
  .option('--max-iter <number>', 'Max training steps', '1000')
  .option('--batch-size <number>', 'Batch size', '8')
  .option('--lr, --learning-rate <number>', 'Learning rate', '0.0005')
  .option('--eval-interval <number>', 'Eval interval', '100')
  .action(async (options) => {
    console.log('🧠 Starting SFT (Supervised Fine-Tuning)...');
    const examples = await loadSFTData(options.data);
    console.log(`Loaded ${examples.length} SFT examples.`);

    // For minimal implementation, concatenate all text and train normally
    // In a full version we would format with special tokens and mask prompts
    const combined = examples.map(e => e.text).join('\n\n');

    const model = new LivingWordsLLM(configs.pico);
    await model.train(options.data, {
      epochs: parseInt(options.epochs, 10),
      maxIter: parseInt(options.maxIter, 10),
      batchSize: parseInt(options.batchSize, 10),
      learningRate: parseFloat(options.learningRate),
      evalInterval: parseInt(options.evalInterval, 10),
    });
    console.log('✅ SFT complete.');
  });

program.parse();
