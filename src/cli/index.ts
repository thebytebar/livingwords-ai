#!/usr/bin/env node

import { program } from 'commander';
import { LivingWordsLLM } from '../core/model.js';
import { configs } from '../core/config.js';

program
  .name('lw-llm')
  .description('God-centered LLM CLI for training and generation')
  .version('0.1.0');

program
  .command('generate')
  .description('Generate text from a prompt')
  .argument('<prompt>', 'Input prompt')
  .option('-m, --max-tokens <number>', 'Max tokens to generate', '100')
  .action(async (prompt, options) => {
    const model = new LivingWordsLLM(configs.theoSmall);
    await model.load(undefined, { silent: true });
    const result = await model.generate(prompt, parseInt(options.maxTokens));
    console.log('\n' + result);
  });

program
  .command('train')
  .description('Train the model on a dataset')
  .option('-d, --data <path>', 'Path to training data', 'data/pretrain_bible.txt')
  .option('-m, --model <name>', 'Model config (pico | nano | theoSmall)', 'theoSmall')
  .option('-e, --epochs <number>', 'Number of epochs', '3')
  .option('--max-iter <number>', 'Maximum training steps', '1500')
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

program
  .command('sft')
  .description('Supervised Fine-Tuning')
  .action(async () => {
    await import('./sft.js');
  });

program
  .command('dpo')
  .description('Direct Preference Optimization')
  .action(async () => {
    await import('./dpo.js');
  });

program
  .command('chat')
  .description('Interactive CLI chatbot')
  .option('-l, --load <dir>', 'Directory with saved weights/meta', 'weights')
  .action(async (options) => {
    const { startChat } = await import('./chat.js');
    await startChat(options.load);
  });

program
  .command('serve')
  .description('Start HTTP server with API and web chat UI')
  .option('-p, --port <number>', 'Port to listen on', '3000')
  .option('-l, --load <dir>', 'Directory with saved weights/meta', 'weights')
  .action(async (options) => {
    const { startServer } = await import('./serve.js');
    await startServer(parseInt(options.port), options.load);
  });

program.parse();
