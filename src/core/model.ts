import * as tf from '@tensorflow/tfjs';
// Optional: use native backend for speed if user has explicitly installed @tensorflow/tfjs-node
// @ts-ignore - optional, not listed in dependencies
import('@tensorflow/tfjs-node').catch(() => {});
import { ModelConfig, configs } from './config.js';
import { GPT } from './gpt-model.js';
import { createDataset } from './dataset.js';
import type { TrainOptions } from './trainer.js';

interface Tokenizer {
  encode: (s: string) => number[];
  decode: (a: number[]) => string;
}

export class LivingWordsLLM {
  private config: ModelConfig;
  private gpt: any = null;
  private isBuilt: boolean = false;
  private tokenizer: Tokenizer | null = null;
  private vocabulary: string[] = [];
  private effectiveVocabSize: number = 0;

  constructor(config: ModelConfig = configs.theoSmall) {
    this.config = { ...config };
    console.log('🌟 LivingWordsLLM initialized with God-centered config:', this.config);
  }

  private async fetchText(path: string): Promise<string> {
    const fs = await import('fs/promises');
    try {
      return await fs.readFile(path, 'utf8');
    } catch {
      return 'In the beginning God created the heavens and the earth. ' +
             'Trust in the Lord with all your heart.';
    }
  }

  private async initTokenizer(dataPath: string = 'data/bible.txt'): Promise<void> {
    const text = await this.fetchText(dataPath);
    const useSubword = this.config.vocabSize > 256;
    const ds = await createDataset({
      textSource: text,
      maskZero: true,
      useSubword,
      vocabSize: this.config.vocabSize,
    });
    this.vocabulary = [...ds.vocabulary];
    this.tokenizer = {
      encode: ds.encode.bind(ds),
      decode: ds.decode.bind(ds),
    };
    this.effectiveVocabSize = ds.vocabSize;
    this.config = { ...this.config, vocabSize: ds.vocabSize };
    ds.dispose();
  }

  private async build(force: boolean = false): Promise<void> {
    if (this.isBuilt && !force) return;

    if (!this.tokenizer) {
      await this.initTokenizer();
    }

    const vs = this.effectiveVocabSize || this.config.vocabSize;
    this.gpt = GPT({
      nLayer: this.config.nLayer,
      nHead: this.config.nHead,
      nEmbd: this.config.nEmbd,
      vocabSize: vs,
      blockSize: this.config.blockSize,
      embdDropout: this.config.dropout,
      residDropout: this.config.dropout,
      attnDropout: this.config.dropout,
    });
    this.gpt.build?.();
    this.isBuilt = true;
    const pcount = this.gpt.summary ? this.gpt.summary().params : 'n/a';
    console.log(`✅ Model built. Params: ${pcount}, vocabSize: ${vs}, blockSize: ${this.config.blockSize}`);
  }

  private async getFsExtra(): Promise<any> {
    const mod = await import('fs-extra');
    return (mod as any).default || mod;
  }

  async save(weightsDir: string = 'weights'): Promise<void> {
    if (!this.gpt || typeof this.gpt.getWeights !== 'function') {
      console.log('No model weights to save yet.');
      return;
    }
    const fse = await this.getFsExtra();
    await fse.ensureDir(weightsDir);
    const weights = await this.gpt.getWeights();
    await fse.writeJson(`${weightsDir}/weights.json`, weights, { spaces: 0 });
    await fse.writeJson(`${weightsDir}/meta.json`, {
      vocabulary: this.vocabulary,
      vocabSize: this.effectiveVocabSize,
      blockSize: this.config.blockSize,
      nEmbd: this.config.nEmbd,
      nHead: this.config.nHead,
      nLayer: this.config.nLayer,
      useSubword: this.config.vocabSize > 256,
      savedAt: new Date().toISOString(),
    }, { spaces: 2 });
    console.log(`💾 Saved weights + vocab to ${weightsDir}/`);
  }

  async load(weightsDir: string = 'weights', opts: { silent?: boolean } = {}): Promise<boolean> {
    const fse = await this.getFsExtra();
    const wFile = `${weightsDir}/weights.json`;
    const mFile = `${weightsDir}/meta.json`;
    if (!(await fse.pathExists(wFile)) || !(await fse.pathExists(mFile))) {
      if (!opts.silent) {
        console.log('ℹ️  No saved weights found at', weightsDir, '(will initialize from data on first use)');
      }
      return false;
    }
    const meta = await fse.readJson(mFile);
    const weights = await fse.readJson(wFile);

    const vocab: string[] = meta.vocabulary || [];
    const stoi: Record<string, number> = {};
    const itos: Record<number, string> = {};
    const indexShift = 1;
    vocab.forEach((ch, i) => {
      const id = i + indexShift;
      stoi[ch] = id;
      itos[id] = ch;
    });
    this.vocabulary = vocab;
    this.tokenizer = {
      encode: (s: string) => s.split('').map((c) => stoi[c] || 0),
      decode: (a: number[]) => a.map((i) => itos[i] || '').join(''),
    };
    this.effectiveVocabSize = meta.vocabSize || vocab.length;

    this.config = {
      ...this.config,
      vocabSize: this.effectiveVocabSize,
      blockSize: meta.blockSize || this.config.blockSize,
      nEmbd: meta.nEmbd || this.config.nEmbd,
      nHead: meta.nHead || this.config.nHead,
      nLayer: meta.nLayer || this.config.nLayer,
    };

    await this.build(true);
    if (this.gpt && typeof this.gpt.setWeights === 'function') {
      this.gpt.setWeights(weights);
    }
    console.log('✅ Loaded model weights and tokenizer from disk.');
    return true;
  }

  async train(dataPath: string, epochsOrOptions: number | TrainOptions = 1): Promise<void> {
    const options: TrainOptions = typeof epochsOrOptions === 'number'
      ? { epochs: epochsOrOptions }
      : { ...epochsOrOptions };

    const epochs = options.epochs ?? 1;

    const text = await this.fetchText(dataPath);
    const useSubword = this.config.vocabSize > 256;
    const ds = await createDataset({
      textSource: text,
      maskZero: true,
      useSubword,
      vocabSize: this.config.vocabSize,
    });
    this.vocabulary = [...ds.vocabulary];
    this.tokenizer = { encode: ds.encode.bind(ds), decode: ds.decode.bind(ds) };
    this.effectiveVocabSize = ds.vocabSize;
    this.config = { ...this.config, vocabSize: ds.vocabSize };

    console.log(`🙏 Training LivingWordsLLM on ${dataPath} for ${epochs} epochs...`);

    const { trainLivingWordsLLM } = await import('./trainer.js');

    const saveCheckpoint = async (ckptModel: any, step: number) => {
      this.gpt = ckptModel;
      const padded = String(step).padStart(5, '0');
      const ckptDir = `weights/checkpoint-${padded}`;
      await this.save(ckptDir);
      await this.save('weights/latest');
    };

    const trainedModel = await trainLivingWordsLLM(this.config, dataPath, {
      epochs,
      maxIter: options.maxIter ?? 800,
      batchSize: options.batchSize,
      learningRate: options.learningRate,
      evalInterval: options.evalInterval,
      saveInterval: options.saveInterval ?? 500,
      saveCheckpoint,
    });

    this.gpt = trainedModel;
    this.isBuilt = true;
    ds.dispose();

    console.log('📖 Training aligned with biblical doctrine. Ready for faithful generation.');
    await this.save();
    await this.save('weights/latest');
  }

  async generate(prompt: string, maxTokens: number = 100): Promise<string> {
    await this.build();
    if (!this.gpt || !this.tokenizer) {
      return prompt + '\n\n[Model not ready for generation]';
    }
    console.log(`🤖 Generating God-centered continuation for: "${prompt}"`);

    try {
      const seedTokens = this.tokenizer.encode(prompt);
      const bs = this.config.blockSize;
      const ctx = seedTokens.slice(-bs);
      const idx = tf.tensor([ctx], [1, ctx.length], 'int32');

      const outIdx = await this.gpt.generate({
        idx,
        maxNewTokens: maxTokens,
        temperature: 0.75,
        doSample: true,
      });

      const arr = (await (outIdx as any).array()) as number[][];
      const generated = this.tokenizer.decode(arr[0] || []);
      tf.dispose([idx, outIdx]);
      return generated;
    } catch (err) {
      console.error('Generation error:', err);
      return prompt + ' [...]';
    }
  }
}
