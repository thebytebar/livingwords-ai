/**
 * Pluggable inference backend abstraction.
 *
 * Goal: Allow the same high-level LivingWordsLLM / generate / chat / serve code
 * to work with different underlying runtimes:
 *   - Primary: ONNX Runtime (via onnxruntime-node) — trained in PyTorch
 *   - Legacy TF.js path removed
 *
 * A backend only needs to provide:
 *   - Model dimensions (blockSize, vocabSize)
 *   - A forward pass that turns token ids -> logits
 *
 * All autoregressive logic (cropping to context, temperature, top-k, sampling,
 * token appending) lives above the backend so behavior stays identical.
 */

export interface InferenceBackend {
  readonly blockSize: number;
  readonly vocabSize: number;

  /**
   * Run a forward pass.
   *
   * @param inputIds  Batched token ids with shape [batch, seqLen].
   *                  seqLen must be <= blockSize. Values are compact token ids (0..vocab-1).
   * @returns logits  Shape [batch, seqLen, vocabSize] as nested number arrays.
   *
   * The caller is responsible for any necessary padding/cropping to blockSize
   * (see generate loop). Most usage is batch size 1.
   */
  forward(inputIds: number[][]): Promise<number[][][]>;

  /** Release any native resources (important for ONNX sessions). */
  dispose(): void;

  /** For OnnxBackend with cache-aware export */
  hasCacheInputs?: boolean;
  resetCache?: () => void;
}

/**
 * Options for text generation (used by the common generate loop).
 */
export interface GenerateOptions {
  maxNewTokens: number;
  temperature?: number; // default 1.0
  doSample?: boolean;   // default false (greedy)
  topK?: number;
  /** Optional callback for streaming tokens (receives the raw compact token id) */
  onToken?: (tokenId: number) => void;
}

/**
 * Helper that performs the autoregressive generation loop using *any* backend.
 * This replaces the old TF-specific loop so ONNX (and future backends) behave identically.
 */
export async function runGenerationLoop(
  backend: InferenceBackend,
  initialIds: number[],
  options: GenerateOptions,
): Promise<number[]> {
  const { maxNewTokens, temperature = 1.0, doSample = false, topK, onToken } = options;
  let ids = initialIds.slice(); // working context (grows)

  const bs = backend.blockSize;
  const vocab = backend.vocabSize;

  let isFirst = true;
  let cacheLen = 0;  // current length of KV cache (past) to avoid wpe position OOB on absolute embeddings

  for (let i = 0; i < maxNewTokens; i++) {
    let toFeed: number[][];
    const canDelta = false; // incremental delta disabled for now (exported cache models have mask shape issues with variable past_len in ONNX)

    if (canDelta) {
      // safe incremental delta (past_len + 1 <= block_size guaranteed by check)
      const newToken = ids[ids.length - 1];
      toFeed = [[newToken]];
    } else {
      // full window (or first, or after reset). Crop to <= blockSize
      let context = ids;
      if (context.length > bs) context = context.slice(-bs);

      if (backend.hasCacheInputs) {
        backend.resetCache?.();
        cacheLen = 0;
        toFeed = [context];
      } else {
        const padded: number[] = context.length < bs
          ? Array(bs - context.length).fill(0).concat(context)
          : context;
        toFeed = [padded];
      }
    }

    // Forward
    const logitsBatch = await backend.forward(toFeed);
    const lastPos = logitsBatch[0].length - 1;
    let lastLogits = logitsBatch[0][lastPos];

    // Temperature / top-k / sampling (unchanged)
    if (temperature !== 1.0 && temperature > 0) {
      lastLogits = lastLogits.map((l) => l / temperature);
    }
    if (topK && topK > 0) {
      const k = Math.min(topK, vocab);
      const sorted = [...lastLogits].sort((a, b) => b - a);
      const threshold = sorted[k - 1];
      lastLogits = lastLogits.map((l) => (l >= threshold ? l : -Infinity));
    }
    const probs = softmax(lastLogits);
    const nextToken = doSample ? sampleFromProbs(probs) : argmax(probs);

    ids.push(nextToken);
    if (onToken) onToken(nextToken);

    if (backend.hasCacheInputs) {
      cacheLen += toFeed[0].length;  // after forward, cache now covers previous + what we just fed
    }
    isFirst = false;
  }

  return ids;
}

// ------------------------------
// Small pure-JS numeric helpers (no TF dependency)
// ------------------------------

function softmax(logits: number[]): number[] {
  let max = -Infinity;
  for (const v of logits) if (v > max) max = v;
  let sum = 0;
  const exps = logits.map((v) => {
    const e = Math.exp(v - max);
    sum += e;
    return e;
  });
  return exps.map((e) => e / sum);
}

function argmax(arr: number[]): number {
  let best = 0;
  let bestVal = -Infinity;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] > bestVal) {
      bestVal = arr[i];
      best = i;
    }
  }
  return best;
}

function sampleFromProbs(probs: number[]): number {
  // Simple categorical sample via cumulative sum + random
  let r = Math.random();
  let cum = 0;
  for (let i = 0; i < probs.length; i++) {
    cum += probs[i];
    if (r <= cum) return i;
  }
  return probs.length - 1;
}
