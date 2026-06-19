#!/usr/bin/env node

import { program } from 'commander';

program
  .name('lw-llm sft')
  .description('Supervised Fine-Tuning (now in PyTorch)')
  .action(() => {
    console.log(`
🧠  SFT has moved to Python + PyTorch.

  cd training
  pip install -r requirements.txt
  python sft.py --data data/sft_sample.jsonl --max-iters 400

See training/README.md and training/sft.py for details and data format.
After training, normal "lw-llm chat" etc. will use the new weights.
`);
    process.exit(0);
  });

program.parse();
