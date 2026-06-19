/**
 * @deprecated Dataset creation for training has moved to Python.
 * This is a stub to avoid breaking any remaining (unlikely) references.
 */

import { Dataset, DatasetParams, DatasetGetBatchParams } from './types.js';
import { createSmallTiktokenTokenizer, Tokenizer } from './tokenizer.js';

export async function createDataset(args: DatasetParams): Promise<Dataset> {
  // Stub - no longer used for ONNX inference path.
  throw new Error('createDataset is deprecated (training moved to Python).');
}
