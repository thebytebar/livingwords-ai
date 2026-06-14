#!/usr/bin/env node

import { program } from 'commander';
import { loadPreferenceData } from '../core/postdata.js';
import { runDPO } from '../core/dpo.js';
import { configs } from '../core/config.js';

program
  .name('lw-llm dpo')
  .description('Direct Preference Optimization (DPO) training')
  .option('-d, --data <path>', 'Path to preference data (.jsonl)', 'data/preferences.jsonl')
  .option('-e, --epochs <number>', 'Number of epochs', '1')
  .option('--beta <number>', 'DPO beta parameter', '0.1')
  .option('--max-iter <number>', 'Max DPO steps', '200')
  .action(async (options) => {
    const prefs = await loadPreferenceData(options.data);
    if (prefs.length === 0) {
      console.log('No preference data found. Create data/preferences.jsonl with {prompt, chosen, rejected} lines.');
      return;
    }

    await runDPO(configs.pico, prefs, {
      beta: parseFloat(options.beta),
      maxIter: parseInt(options.maxIter, 10),
    });
  });

program.parse();
