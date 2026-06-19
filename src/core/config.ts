export interface ModelConfig {
  vocabSize: number;
  nEmbd: number;
  nHead: number;
  nLayer: number;
  blockSize: number;
  dropout?: number;
}

export const configs = {
  // The single supported configuration (theoSmall).
  // pico and nano have been removed (only theoSmall remains).
  theoSmall: {
    vocabSize: 1536,
    nEmbd: 96,
    nHead: 6,
    nLayer: 6,
    blockSize: 256,
    dropout: 0.1,
  } as ModelConfig,
};
