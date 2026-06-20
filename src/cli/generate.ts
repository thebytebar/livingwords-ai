#!/usr/bin/env node

import { program } from 'commander';
import { LivingWordsLLM } from '../core/model.js';
import { configs } from '../core/config.js';
import { buildExplanationPrompt } from '../core/verse.js';

program
  .name('lw generate')
  .description('Generate text using LivingWords LLM')
  .argument('<prompt>', 'The prompt to generate from')
  .option('-m, --max-tokens <number>', 'Maximum tokens to generate', '100')
  .action(async (prompt, options) => {
    const model = new LivingWordsLLM(configs.theoSmall);
    await model.load(undefined, { silent: true });

    // Use smart prompting for verse explanations and theological questions
    const smartPrompt = await buildExplanationPrompt(prompt);
    const result = await model.generate(smartPrompt, parseInt(options.maxTokens));
    console.log('\n' + result);
  });

program.parse();
