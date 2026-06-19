import { ModelConfig, configs } from './config.js';
import { createSmallTiktokenTokenizer } from './tokenizer.js';

import { InferenceBackend, runGenerationLoop, GenerateOptions } from './inference/backend.js';

// Lazy for ONNX (onnxruntime-node is optional dep)
let createOnnxBackend: any = null;
async function getCreateOnnxBackend() {
  if (!createOnnxBackend) {
    const mod = await import('./inference/onnx-backend.js');
    createOnnxBackend = mod.createOnnxBackend;
  }
  return createOnnxBackend;
}

interface Tokenizer {
  encode: (s: string) => number[];
  decode: (a: number[]) => string;
}

export class LivingWordsLLM {
  private config: ModelConfig;
  private backend: InferenceBackend | null = null;  // ONNX backend (the only supported path)
  private isBuilt: boolean = false;
  private tokenizer: Tokenizer | null = null;
  private vocabulary: string[] = [];
  private effectiveVocabSize: number = 0;
  private subwordKeptIds: number[] | null = null;

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

    // In the ONNX-only world we prefer loading from meta.json (which carries subwordKeptIds).
    // This path is for fresh "unloaded" use (rare). We support subword via tiktoken only (no TF dataset needed).
    if (useSubword) {
      const swTok = createSmallTiktokenTokenizer(text, this.config.vocabSize);
      this.tokenizer = {
        encode: swTok.encode.bind(swTok),
        decode: swTok.decode.bind(swTok),
      };
      this.subwordKeptIds = (swTok as any)._subwordKeptIds || null;
      this.effectiveVocabSize = swTok.vocabSize;
      this.vocabulary = [];
      this.config = { ...this.config, vocabSize: this.effectiveVocabSize };
      return;
    }

    // Legacy char-level (kept for completeness, no TF tensor creation here)
    const chars = Array.from(new Set(text)).sort();
    const indexShift = 1;
    const stoi: Record<string, number> = {};
    const itos: Record<number, string> = {};
    chars.forEach((ch, i) => {
      const id = i + indexShift;
      stoi[ch] = id;
      itos[id] = ch;
    });
    this.tokenizer = {
      encode: (s: string) => s.split('').map((c) => stoi[c] || 0),
      decode: (a: number[]) => a.map((i) => itos[i] || '').join(''),
    };
    this.vocabulary = chars;
    this.subwordKeptIds = null;
    this.effectiveVocabSize = chars.length + indexShift;
    this.config = { ...this.config, vocabSize: this.effectiveVocabSize };
  }

  private async build(force: boolean = false): Promise<void> {
    if (this.isBuilt && !force) return;

    if (!this.tokenizer) {
      await this.initTokenizer();
    }

    // For the ONNX-only world, "build" just ensures tokenizer is ready.
    // The actual model is loaded via .load() which sets up the OnnxBackend.
    // Fresh generate() without prior .load() with a .onnx will fail gracefully below.
    this.isBuilt = true;
    console.log(`✅ Model prepared (tokenizer ready). Use .load(dir-with-model.onnx) for inference.`);
  }

  private async getFsExtra(): Promise<any> {
    const mod = await import('fs-extra');
    return (mod as any).default || mod;
  }

  private async resolveBundledWeightsDir(): Promise<string | null> {
    try {
      const { fileURLToPath } = await import('url');
      const { dirname, resolve, join } = await import('path');
      const currentFile = fileURLToPath(import.meta.url);
      let dir = dirname(currentFile);

      // Ascend a few levels: dist/core -> dist -> packageRoot, or src/core -> src -> packageRoot
      for (let i = 0; i < 6; i++) {
        const candidate = join(dir, 'weights');
        // If package.json identifies this as our package, use it
        try {
          const fsmod = await import('fs/promises');
          const pkgPath = join(dir, 'package.json');
          const pkgRaw = await fsmod.readFile(pkgPath, 'utf8');
          const pkg = JSON.parse(pkgRaw);
          if (pkg && pkg.name === 'livingwords-llm') {
            return candidate;
          }
        } catch {}

        // Or if the weights dir here actually contains the model file
        try {
          const fsmod = await import('fs/promises');
          await fsmod.access(join(candidate, 'model.onnx'));
          return candidate;
        } catch {}

        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    } catch {
      // ignore resolution errors, fall through
    }
    return null;
  }

  async save(weightsDir: string = 'weights'): Promise<void> {
    // In the modern ONNX world, models are exported from the Python training scripts.
    // This method is deprecated and kept only for API compatibility.
    console.warn('⚠️  .save() is deprecated. Models are now trained and exported from the Python training/ directory (which produces model.onnx + meta.json).');
    // Optionally still write meta for legacy tools, but no weights.
    const fse = await this.getFsExtra();
    await fse.ensureDir(weightsDir);
    await fse.writeJson(`${weightsDir}/meta.json`, {
      vocabulary: this.vocabulary,
      vocabSize: this.effectiveVocabSize,
      blockSize: this.config.blockSize,
      nEmbd: this.config.nEmbd,
      nHead: this.config.nHead,
      nLayer: this.config.nLayer,
      useSubword: true,
      subwordKeptIds: this.subwordKeptIds || undefined,
      savedAt: new Date().toISOString(),
      note: 'ONNX models are exported from Python training. This meta is for reference only.'
    }, { spaces: 2 });
    console.log(`ℹ️  Wrote meta.json to ${weightsDir}/ (no weights.json - use Python export for full model).`);
  }

  async load(weightsDir: string = 'weights', opts: { silent?: boolean } = {}): Promise<boolean> {
    const fse = await this.getFsExtra();
    let targetDir = weightsDir;
    let mFile = `${targetDir}/meta.json`;
    let onnxFile = `${targetDir}/model.onnx`;

    let hasMeta = await fse.pathExists(mFile);
    let hasOnnx = await fse.pathExists(onnxFile);

    // Fallback: if the requested dir (commonly 'weights' from cwd) has no model,
    // try the one bundled inside the installed npm package. This makes
    // `npx lw-llm chat` etc work out of the box.
    if (!hasMeta || !hasOnnx) {
      const bundled = await this.resolveBundledWeightsDir();
      if (bundled && bundled !== targetDir) {
        const m2 = `${bundled}/meta.json`;
        const o2 = `${bundled}/model.onnx`;
        const hasMeta2 = await fse.pathExists(m2);
        const hasOnnx2 = await fse.pathExists(o2);
        if (hasMeta2 && hasOnnx2) {
          targetDir = bundled;
          mFile = m2;
          onnxFile = o2;
          hasMeta = true;
          hasOnnx = true;
        }
      }
    }

    if (!hasMeta || !hasOnnx) {
      if (!opts.silent) {
        console.log('ℹ️  No model.onnx + meta.json found at', weightsDir, '(expected after Python training).');
        console.log('    Run training (see training/README.md) or use --load <dir-with-model.onnx+meta.json>');
      }
      return false;
    }

    const meta = await fse.readJson(mFile);

    const vocab: string[] = meta.vocabulary || [];
    const useSubword = !!meta.useSubword;
    const subwordKeptIds: number[] | undefined = Array.isArray(meta.subwordKeptIds) ? meta.subwordKeptIds : undefined;

    if (useSubword) {
      let swTok: any;
      if (subwordKeptIds && subwordKeptIds.length > 0) {
        swTok = createSmallTiktokenTokenizer('', meta.vocabSize || 1536, subwordKeptIds);
      } else {
        // Re-derive if no kept ids (rare for new exports)
        let corpus = '';
        const candidates = ['data/pretrain_bible.txt', 'data/bibles/kjv.txt', 'data/bibles/web.txt'];
        for (const p of candidates) {
          try {
            const fsmod = await import('fs/promises');
            corpus = await fsmod.readFile(p, 'utf8');
            if (corpus.length > 2000) break;
          } catch {}
        }
        if (!corpus || corpus.length < 2000) {
          corpus = await this.fetchText('data/pretrain_bible.txt');
        }
        swTok = createSmallTiktokenTokenizer(corpus, meta.vocabSize || 1536);
      }
      this.tokenizer = {
        encode: swTok.encode.bind(swTok),
        decode: swTok.decode.bind(swTok),
      };
      this.subwordKeptIds = (swTok as any)._subwordKeptIds || subwordKeptIds || null;
    } else {
      // Char-level fallback (rare)
      const stoi: Record<string, number> = {};
      const itos: Record<number, string> = {};
      const indexShift = 1;
      vocab.forEach((ch, i) => {
        const id = i + indexShift;
        stoi[ch] = id;
        itos[id] = ch;
      });
      this.tokenizer = {
        encode: (s: string) => s.split('').map((c) => stoi[c] || 0),
        decode: (a: number[]) => a.map((i) => itos[i] || '').join(''),
      };
      this.subwordKeptIds = null;
    }

    this.vocabulary = vocab;
    this.effectiveVocabSize = meta.vocabSize || vocab.length;

    this.config = {
      ...this.config,
      vocabSize: this.effectiveVocabSize,
      blockSize: meta.blockSize || this.config.blockSize,
      nEmbd: meta.nEmbd || this.config.nEmbd,
      nHead: meta.nHead || this.config.nHead,
      nLayer: meta.nLayer || this.config.nLayer,
    };

    // ONNX is now the only supported inference path
    this.backend?.dispose();
    const createOnnx = await getCreateOnnxBackend();
    this.backend = await createOnnx(onnxFile, this.config.blockSize, this.effectiveVocabSize);
    this.isBuilt = true;

    console.log('✅ Loaded model (ONNX backend) + tokenizer from disk.');
    return true;
  }

  async train(dataPath: string, _epochsOrOptions: any = 1): Promise<void> {
    // Training has been fully moved to Python + PyTorch (see training/ directory).
    // This method is kept only for API compatibility and now always throws.
    throw new Error(
      'Training has moved to Python/PyTorch.\n\n' +
      'Use the scripts in the training/ directory:\n' +
      '  cd training\n' +
      '  pip install -r requirements.txt\n' +
      '  python pretrain.py --data ../data/pretrain_bible.txt --max-iters 1500\n\n' +
      'SFT and DPO are also available (python sft.py / dpo.py).\n' +
      'See training/README.md for details. The resulting weights/ are compatible with this class.'
    );
  }

  async generate(prompt: string, maxTokens: number = 100): Promise<string> {
    if (!this.backend) {
      if (!this.tokenizer) {
        await this.build();
      }
      return prompt + '\n\n[No model loaded. Use --load <dir> or ensure model.onnx + meta.json are present (bundled default or after training).]';
    }

    console.log(`🤖 Generating God-centered continuation for: "${prompt}" (via ${this.backend.constructor.name})`);
    try {
      const seedTokens = this.tokenizer!.encode(prompt);
      const genOpts: GenerateOptions = {
        maxNewTokens: maxTokens,
        temperature: 0.75,
        doSample: true,
      };
      const outTokens = await runGenerationLoop(this.backend, seedTokens, genOpts);
      return this.tokenizer!.decode(outTokens);
    } catch (err) {
      console.error('Generation error:', err);
      return prompt + ' [...]';
    }
  }
}
