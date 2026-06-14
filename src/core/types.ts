import * as tf from '@tensorflow/tfjs';

export interface ModelParams {
  nLayer: number;
  nHead: number;
  nEmbd: number;
  vocabSize: number;
  blockSize: number;
  embdDropout?: number;
  residDropout?: number;
  attnDropout?: number;
}

// Runtime model shape returned by GPT()
export interface Model {
  params: ModelParams;
  apply: (idx: tf.Tensor) => tf.Tensor;
  loss: (idx: tf.Tensor, targets: tf.Tensor) => tf.Tensor;
  generate: (params: any, onGenerateChar?: (token: number) => void) => Promise<tf.Tensor>;
  optimizer: (params: { learningRate: number }) => any;
  build: () => void;
  summary: () => { params: number };
  dispose?: () => void;
  getWeights?: () => Promise<any>;
  setWeights?: (weights: any) => void;
  sequenceLogProb?: (tokens: number[]) => Promise<number>;
}

export interface Layer {
  apply: (x: tf.Tensor) => tf.Tensor;
  countParams?: () => number;
  dispose?: () => void;
  getChildren?: () => LayerChildren;
}

export type LayerLike = tf.layers.Layer | Layer | null | undefined;
export type LayerChildren = Array<LayerLike | LayerLike[]>;
export type NumericWeights = any;
export type Weights = Record<string, NumericWeights>;

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
  getBatch: (args: DatasetGetBatchParams) => { x: tf.Tensor; y: tf.Tensor };
  encode: (s: string) => number[];
  decode: (a: number[]) => string;
  dispose: () => void;
}

export interface LivingWordsModel {
  params: ModelConfig;
  apply: (x: tf.Tensor) => tf.Tensor;
  generate: (args: any, onGenerateChar?: (token: number) => void) => Promise<tf.Tensor>;
  loss: (x: tf.Tensor, y: tf.Tensor) => tf.Tensor;
  build: () => void;
  summary: () => { params: number };
}

export interface SFTExample {
  text: string;
}

export interface PreferenceExample {
  prompt: string;
  chosen: string;
  rejected: string;
}

export type PostTrainMode = 'pretrain' | 'sft' | 'dpo';
