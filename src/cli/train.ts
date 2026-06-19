#!/usr/bin/env node

import { program } from 'commander';

program
  .name('lw-llm train')
  .description('Train LivingWords LLM (now powered by PyTorch)')
  .action(() => {
    console.log(`
🙏  Training has moved to Python + PyTorch.

The old TensorFlow.js trainer has been removed.

To train (theoSmall is the only supported configuration):

  cd training
  pip install -r requirements.txt
  python pretrain.py --data ../data/pretrain_bible.txt --max-iters 1500

  # or for SFT / DPO
  python sft.py --data data/sft_sample.jsonl
  python dpo.py --data data/prefs_sample.jsonl

After training, the weights are exported to ../weights/ (and checkpoints/)
so the normal CLI still works:

  npx lw-llm chat
  npx lw-llm generate "In the beginning"

See training/README.md for full instructions and flags.
`);
    process.exit(0);
  });

program.parse();
