/**
 * ONNX Runtime backend for LivingWords LLM inference.
 *
 * This is the recommended path after moving training to PyTorch.
 * The model is exported via torch.onnx.export (see training/common/export.py).
 *
 * Advantages:
 *   - Decouples training (PyTorch) from serving
 *   - High-performance CPU kernels (and WebGPU/WASM options in browser)
 *   - Small binary + model size for this ~500k-param network
 *   - Future-proof if the model grows
 *
 * The backend only implements `forward`. The autoregressive generate loop
 * (temperature, top-k, sampling, context management) is provided by the
 * shared runGenerationLoop in backend.ts.
 */

import * as ort from 'onnxruntime-node';
import { InferenceBackend } from './backend.js';

export interface OnnxBackendOptions {
  /** Path to the .onnx file produced by the Python training export. */
  modelPath: string;
  blockSize: number;
  vocabSize: number;
}

export class OnnxBackend implements InferenceBackend {
  readonly blockSize: number;
  readonly vocabSize: number;

  private session: ort.InferenceSession | null = null;
  private inputName: string = 'input_ids';
  private outputName: string = 'logits';
  private disposed = false;

  // KV cache state for incremental generation (when the .onnx was exported with use_cache=True)
  private pastKeyValues: ort.Tensor[] = [];  // flat list of past_key_0, past_value_0, ...
  hasCacheInputs = false;

  /** Reset KV cache (call when context would exceed block_size) */
  resetCache(): void {
    this.pastKeyValues = [];
  }

  constructor(private readonly opts: OnnxBackendOptions) {
    this.blockSize = opts.blockSize;
    this.vocabSize = opts.vocabSize;
  }

  async initialize(): Promise<void> {
    if (this.session) return;

    try {
      this.session = await ort.InferenceSession.create(this.opts.modelPath, {
        // Graph optimization level can be left default (all)
      });

      // Use the actual input/output names from the model (defensive)
      if (this.session.inputNames.length > 0) {
        this.inputName = this.session.inputNames[0];
      }
      if (this.session.outputNames.length > 0) {
        this.outputName = this.session.outputNames[0];
      }

      // Detect if this is a cache-aware export (has past_key_0 etc.)
      this.hasCacheInputs = this.session.inputNames.some((name: string) => name.startsWith('past_key_'));
      if (this.hasCacheInputs) {
        console.log('OnnxBackend: detected cache-aware model, will use incremental KV cache for generation.');
      }
    } catch (err) {
      console.error('Failed to load ONNX model:', err);
      throw err;
    }
  }

  async forward(inputIds: number[][]): Promise<number[][][]> {
    if (this.disposed) throw new Error('OnnxBackend has been disposed');
    if (!this.session) {
      await this.initialize();
    }
    const session = this.session!;

    const batchSize = inputIds.length;
    if (batchSize === 0) return [];

    // Flatten and convert to int64 (BigInt64Array) — ONNX typically expects int64 for indices
    const flat = inputIds.flat();
    const seqLen = inputIds[0].length;
    const tensorData = new BigInt64Array(flat.map((n) => BigInt(n)));

    const inputTensor = new ort.Tensor('int64', tensorData, [batchSize, seqLen]);

    const feeds: Record<string, ort.Tensor> = {};
    feeds[this.inputName] = inputTensor;

    if (this.hasCacheInputs) {
      // For cache-aware model, feed the current past (or zero if first) for the input.
      // When the generation loop passes delta (1 token after initial), this enables true incremental KV cache.
      const n_head = 6;
      const headSize = 16;
      const nLayer = 6;
      for (let i = 0; i < nLayer; i++) {
        const kName = `past_key_${i}`;
        const vName = `past_value_${i}`;
        let pastK: ort.Tensor;
        let pastV: ort.Tensor;
        if (this.pastKeyValues.length > 0) {
          pastK = this.pastKeyValues[i * 2];
          pastV = this.pastKeyValues[i * 2 + 1];
        } else {
          pastK = new ort.Tensor('float32', new Float32Array(batchSize * n_head * 0 * headSize), [batchSize, n_head, 0, headSize]);
          pastV = new ort.Tensor('float32', new Float32Array(batchSize * n_head * 0 * headSize), [batchSize, n_head, 0, headSize]);
        }
        feeds[kName] = pastK;
        feeds[vName] = pastV;
      }
    }

    const results = await session.run(feeds);
    const outputTensor = results[this.outputName];

    if (!outputTensor) {
      throw new Error(`ONNX output "${this.outputName}" not found. Available: ${Object.keys(results)}`);
    }

    const data = outputTensor.data as Float32Array;
    const [b, t, v] = outputTensor.dims as number[];

    const out: number[][][] = [];
    for (let bi = 0; bi < b; bi++) {
      const rows: number[][] = [];
      for (let ti = 0; ti < t; ti++) {
        const row: number[] = [];
        const base = (bi * t + ti) * v;
        for (let vi = 0; vi < v; vi++) {
          row.push(data[base + vi]);
        }
        rows.push(row);
      }
      out.push(rows);
    }

    // If cache-aware, extract the presents and store for potential incremental use in future generations
    if (this.hasCacheInputs) {
      this.pastKeyValues = [];
      for (let i = 0; i < 6; i++) {  // n_layer for theoSmall
        const pk = results[`present_key_${i}`];
        const pv = results[`present_value_${i}`];
        if (pk && pv) {
          this.pastKeyValues.push(pk, pv);
        }
      }
    }

    return out;
  }

  dispose(): void {
    if (this.session) {
      // onnxruntime-node sessions should be released
      try {
        // The API is async in some versions, but sync release is usually fine for shutdown
        (this.session as any).release?.();
      } catch {}
      this.session = null;
    }
    this.disposed = true;
  }
}

/**
 * Factory helper used by LivingWordsLLM.
 */
export async function createOnnxBackend(
  modelPath: string,
  blockSize: number,
  vocabSize: number,
): Promise<OnnxBackend> {
  const backend = new OnnxBackend({ modelPath, blockSize, vocabSize });
  await backend.initialize();
  return backend;
}
