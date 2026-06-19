/**
 * @deprecated DPO HAS MOVED TO PYTHON
 *
 * See training/dpo.py (proper reference-free DPO with full sequence logprobs).
 * The JS version was a toy implementation and is no longer maintained.
 *
 * DO NOT USE.
 */

import { PreferenceExample } from './types.js';
import { ModelConfig } from './config.js';

/** @deprecated */
export interface DPOOptions {
  beta?: number;
  learningRate?: number;
  maxIter?: number;
  batchSize?: number;
}

/** @deprecated */
export async function runDPO(
  _config: ModelConfig,
  _preferences: PreferenceExample[],
  _options: DPOOptions = {}
): Promise<any> {
  throw new Error('runDPO (JS) has been removed. Use training/dpo.py instead.');
}
