/**
 * Full Training Loop for LivingWords LLM
 * God-centered: Trains on biblical/theological data with alignment in mind.
 * Inspired by homemade-gpt-js and Karpathy's nanoGPT.
 */

import * as tf from './tf.js';
import { createDataset } from './dataset.js';
import { GPT } from './gpt-model.js';
import { ModelConfig } from './config.js';

export interface TrainOptions {
  epochs?: number;
  batchSize?: number;
  learningRate?: number;
  evalInterval?: number;
  saveInterval?: number;
  maxIter?: number;
  /** Optional callback invoked when a checkpoint should be saved (e.g. every saveInterval steps) */
  saveCheckpoint?: (model: any, step: number) => void | Promise<void>;
}

// Helper to format elapsed time
function formatElapsedTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

export async function trainLivingWordsLLM(
  config: ModelConfig,
  dataPath: string = 'data/pretrain_bible.txt',
  options: TrainOptions = {}
): Promise<any> {
  const {
    epochs = 1,
    batchSize = 16,
    learningRate = 1e-3,
    evalInterval = 100,
    saveInterval = 500,
    maxIter = 1000,
    saveCheckpoint
  } = options;

  console.log(`🙏 Starting God-centered training for LivingWords LLM on ${dataPath}`);
  console.log(`Config: ${config.nLayer} layers, ${config.nEmbd} embd, blockSize=${config.blockSize}`);

  const startTime = Date.now();

  // Create dataset
  const text = await fetchText(dataPath);
  const dataset = await createDataset({ textSource: text, maskZero: true, useSubword: config.vocabSize > 256, vocabSize: config.vocabSize });

  // Build model
  const model = GPT({
    nLayer: config.nLayer,
    nHead: config.nHead,
    nEmbd: config.nEmbd,
    vocabSize: dataset.vocabSize,
    blockSize: config.blockSize,
  });

  model.build?.();

  console.log(`✅ Model built with ~${model.summary ? model.summary().params : 'N/A'} parameters.`);

  // Optimizer
  const optimizer = tf.train.adam(learningRate);

  // Training loop
  let iter = 0;
  for (let epoch = 0; epoch < epochs; epoch++) {
    console.log(`\n📖 Epoch ${epoch + 1}/${epochs}`);

    for (let step = 0; step < maxIter; step++) {
      iter++;

      const { x, y } = dataset.getBatch({ split: 'train', blockSize: config.blockSize, batchSize });

      // Single loss computation per step (compute once, reuse)
      const lossTensor = tf.tidy(() => model.loss(x, y));
      const lossData = await lossTensor.data();
      const lossValue: number = (lossData as Float32Array | number[])[0] ?? 0;

      // Backward pass via minimize (re-uses same loss fn but we already have value)
      optimizer.minimize(() => model.loss(x, y) as any);

      lossTensor.dispose();
      x.dispose();
      y.dispose();

      // Training progress indicator with elapsed time
      if (iter % 10 === 0 && iter % evalInterval !== 0) {
        const elapsed = formatElapsedTime(Date.now() - startTime);
        process.stdout.write(`\r⏳ Training step ${iter}/${maxIter} | Elapsed: ${elapsed}`);
      }

      if (iter % evalInterval === 0) {
        if (iter % 10 === 0) process.stdout.write('\n');
        const elapsed = formatElapsedTime(Date.now() - startTime);
        console.log(`Step ${iter} | Loss: ${lossValue.toFixed(4)} | Elapsed: ${elapsed}`);

        // Real sample generation using current model + dataset tokenizer
        try {
          const samplePrompt = 'In the beginning';
          const seed = dataset.encode(samplePrompt).slice(-config.blockSize);
          const seedT = tf.tensor([seed], [1, seed.length], 'int32');
          const out = await model.generate({ idx: seedT, maxNewTokens: 48, temperature: 0.7, doSample: true });
          const arr = (await (out as any).array()) as number[][];
          const text = dataset.decode(arr[0] || []);
          console.log('Sample:', text.replace(/\n/g, ' ').slice(0, 160) + (text.length > 160 ? '...' : ''));
          seedT.dispose();
          if (out && typeof (out as any).dispose === 'function') (out as any).dispose();
        } catch (e) {
          console.log('Sample gen skipped this step.');
        }
      }

      if (iter % saveInterval === 0) {
        console.log(`💾 Saving checkpoint at step ${iter}...`);
        if (saveCheckpoint) {
          const maybePromise = saveCheckpoint(model, iter);
          if (maybePromise && typeof (maybePromise as any).then === 'function') {
            await maybePromise;
          }
        }
      }
    }
  }

  const totalElapsed = formatElapsedTime(Date.now() - startTime);
  console.log(`✅ Training complete. Total time: ${totalElapsed}`);
  return model;
}

// Simple file read helper (Node.js)
async function fetchText(path: string): Promise<string> {
  const fs = await import('fs/promises');
  try {
    return await fs.readFile(path, 'utf8');
  } catch {
    return "In the beginning God created the heavens and the earth. " +
           "The Bible is the inspired Word of God. Let everything that has breath praise the Lord.";
  }
}
