// TF.js imports removed - this file is now free of TensorFlow dependencies.

// Legacy TF Model interface removed.

// Legacy Layer interface removed.

// Legacy TF types removed.
// Legacy TF types removed.
// Legacy TF types removed.

// High-level config for LivingWordsLLM (user-facing, from config.ts)
export interface ModelConfig {
  vocabSize: number;
  nEmbd: number;
  nHead: number;
  nLayer: number;
  blockSize: number;
  dropout?: number;
}

export interface DatasetParams {
  textSource?: string;
  maskZero?: boolean;
  useSubword?: boolean;
  vocabSize?: number;
}

export interface DatasetGetBatchParams {
  split: 'train' | 'val';
  blockSize: number;
  batchSize: number;
}

export interface Dataset {
  vocabSize: number;
  dataSize: number;
  vocabulary: string[];
  text: string;
  getBatch?: (args: DatasetGetBatchParams) => { x: any; y: any };
  encode: (s: string) => number[];
  decode: (a: number[]) => string;
  dispose?: () => void;
}

// Legacy LivingWordsModel interface (TF-based) removed. The main public class is LivingWordsLLM.

export interface SFTExample {
  text: string;
}

export interface PreferenceExample {
  prompt: string;
  chosen: string;
  rejected: string;
}

export type PostTrainMode = 'pretrain' | 'sft' | 'dpo';
