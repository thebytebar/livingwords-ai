#!/usr/bin/env node

import { program } from 'commander';
import { LivingWordsLLM } from '../core/model.js';
import { configs } from '../core/config.js';

program
  .name('lw-llm train')
  .description('Train LivingWords LLM on a dataset')
  .option('-d, --data <path>', 'Path to training data', 'data/pretrain_bible.txt')
  .option('-m, --model <name>', 'Model config (pico | nano | theoSmall)', 'theoSmall')
  .option('-e, --epochs <number>', 'Number of epochs', '3')
  .option('--max-iter <number>', 'Total training steps', '1500')
  .option('--batch-size <number>', 'Batch size', '16')
  .option('--lr, --learning-rate <number>', 'Learning rate', '0.0008')
  .option('--eval-interval <number>', 'Eval interval', '100')
  .option('--save-interval <number>', 'Save interval', '400')
  .action(async (options) => {
    const modelConfig = (configs as any)[options.model] || configs.theoSmall;
    const model = new LivingWordsLLM(modelConfig);

    const trainOpts = {
      epochs: parseInt(options.epochs, 10),
      maxIter: parseInt(options.maxIter, 10),
      batchSize: parseInt(options.batchSize, 10),
      learningRate: parseFloat(options.learningRate),
      evalInterval: parseInt(options.evalInterval, 10),
      saveInterval: parseInt(options.saveInterval, 10),
    };

    await model.train(options.data, trainOpts);
    console.log('✅ Training session complete.');
  });

program.parse();
