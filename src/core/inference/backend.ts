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
  /** Nucleus sampling: keep the smallest set of tokens with cumulative probability >= topP (e.g. 0.9) */
  topP?: number;
  /** > 1.0 to penalize recently generated tokens (helps reduce loops and weird fragments) */
  repetitionPenalty?: number;
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
  const { maxNewTokens, temperature = 1.0, doSample = false, topK, topP, onToken, repetitionPenalty } = options;
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
        // Always feed the raw cropped context (variable length 1..blockSize).
        // The model uses absolute wpe starting at 0 for whatever is fed;
        // left-padding with 0s shifts positions and was never seen in training.
        // ONNX dynamic axes support this directly (no fixed block_size input required).
        toFeed = [context];
      }
    }

    // Forward
    const logitsBatch = await backend.forward(toFeed);
    const lastPos = logitsBatch[0].length - 1;
    let lastLogits = logitsBatch[0][lastPos];

    // Mask reserved ids 0-3. Under the small tiktoken subword scheme these map back
    // to orig id 0 (or unk) which decodes to "!" / "#" etc bytes. We never want "!"
    // characters injected into God-centered output. Force only real kept subwords (>=4).
    for (let i = 0; i < 4 && i < lastLogits.length; i++) {
      lastLogits[i] = -Infinity;
    }

    // Suppress Bible reference starters (e.g. "Psalm 35:17", "Genesis 1:1", "Matthew 3:") in the
    // early tokens of a generation. The base model was trained on raw Bible text full of these
    // headers, so it loves to start answers with random verse citations. Masking the colon and
    // common book-name starter tokens for the first few steps produces much saner continuations
    // for user questions like "Tell me about the trinity".
    const earlyStep = i < 10;
    if (earlyStep) {
      // Colon (needed for "N:N") + semicolon + first BPE piece of common book names + number starters.
      // The model loves emitting "6;9", "11;22" style references because of the training data.
      // We suppress them for the first several generated tokens on Q&A prompts.
      const refIds = [7, 16, 26, 31, 60, 66, 68, 74, 75, 76, 80, 81, 83, 85, 91, 93, 96, 98, 104, 111, 117, 125, 128, 131, 132, 133, 139, 144, 147, 148, 153, 156, 159, 169, 170, 172, 175, 180, 190, 193, 200, 202, 205, 212, 226, 234, 247, 255, 272, 345, 366, 391, 430, 446, 463];
      for (const id of refIds) {
        if (id < lastLogits.length) lastLogits[id] = -Infinity;
      }
    }

    // Simple repetition penalty over recent context (reduces loops and over-use of the same
    // weird fragments like single-letter "p" + "ir" that produce "pir?").
    const repPen = (typeof repetitionPenalty === 'number' && repetitionPenalty > 1.0) ? repetitionPenalty : 1.0;
    if (repPen > 1.0) {
      const recent = ids.slice(-24);
      const seen = new Set(recent);
      for (const t of seen) {
        if (t >= 0 && t < lastLogits.length) {
          lastLogits[t] = lastLogits[t] / repPen;
        }
      }
    }

    // Temperature / top-k / sampling
    if (temperature !== 1.0 && temperature > 0) {
      lastLogits = lastLogits.map((l) => l / temperature);
    }
    if (topK && topK > 0) {
      const k = Math.min(topK, vocab);
      const sorted = [...lastLogits].sort((a, b) => b - a);
      const threshold = sorted[k - 1];
      lastLogits = lastLogits.map((l) => (l >= threshold ? l : -Infinity));
    }
    let probs = softmax(lastLogits);

    // Nucleus (top-p) sampling for better coherence. Keeps only the most probable tokens
    // whose probs sum to at least topP. Greatly reduces weird tail samples on small models.
    if (topP && topP > 0 && topP < 1.0) {
      const sorted = probs
        .map((p, idx) => ({ p, idx }))
        .sort((a, b) => b.p - a.p);
      let cum = 0;
      let cut = 0;
      for (cut = 0; cut < sorted.length; cut++) {
        cum += sorted[cut].p;
        if (cum >= topP) break;
      }
      const nucleus = sorted.slice(0, cut + 1);
      const nsum = nucleus.reduce((s, x) => s + x.p, 0);
      const nucleusProbs = new Array(probs.length).fill(0);
      for (const { p, idx } of nucleus) nucleusProbs[idx] = p / nsum;
      probs = nucleusProbs;
    }

    const nextToken = doSample ? sampleFromProbs(probs) : argmax(lastLogits);

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
