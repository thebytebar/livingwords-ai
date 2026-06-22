#!/usr/bin/env node

import { program } from 'commander';
import { LivingWordsLLM } from '../core/model.js';
import { configs } from '../core/config.js';

program
  .name('lw')
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
  .description('Train the model (PyTorch)')
  .action(async () => {
    console.log(`
Training now lives in Python + PyTorch (theoSmall only).

  cd training && pip install -r requirements.txt
  python pretrain.py --max-iters 1500 --data ../data/pretrain/pretrain_bible.txt

See training/README.md. The resulting weights/ are directly usable by chat/serve/generate.
`);
    process.exit(0);
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
  .option('--dpo', 'Enable live DPO preference capture (A=approve/chosen, R=reject)')
  .action(async (options) => {
    const { startChat } = await import('./chat.js');
    await startChat(options.load, { dpo: !!options.dpo });
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
