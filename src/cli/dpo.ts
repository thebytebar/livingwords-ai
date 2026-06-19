#!/usr/bin/env node

import { program } from 'commander';

program
  .name('lw-llm dpo')
  .description('Direct Preference Optimization (now in PyTorch)')
  .action(() => {
    console.log(`
❤️  DPO has moved to Python + PyTorch.

  cd training
  pip install -r requirements.txt
  python dpo.py --data data/prefs_sample.jsonl --max-iters 200 --beta 0.1

See training/dpo.py and training/README.md.
`);
    process.exit(0);
  });

program.parse();
