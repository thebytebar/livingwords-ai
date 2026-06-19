/**
 * @deprecated TRAINING MOVED TO PYTHON
 *
 * All pre-training and post-training (SFT/DPO) now lives in the `training/` directory
 * using PyTorch. This file is a stub for backward-compat only.
 *
 * The LivingWordsLLM.train() method now throws with migration instructions.
 *
 * DO NOT USE OR IMPORT THIS FILE.
 */

export interface TrainOptions {
  /** @deprecated */
  epochs?: number;
  /** @deprecated */
  batchSize?: number;
  /** @deprecated */
  learningRate?: number;
  /** @deprecated */
  evalInterval?: number;
  /** @deprecated */
  saveInterval?: number;
  /** @deprecated */
  maxIter?: number;
  /** @deprecated */
  saveCheckpoint?: (model: any, step: number) => void | Promise<void>;
}

/** @deprecated */
export async function trainLivingWordsLLM(..._args: any[]): Promise<any> {
  throw new Error('trainLivingWordsLLM has been removed. Use the Python training/ scripts instead (see training/README.md).');
}
