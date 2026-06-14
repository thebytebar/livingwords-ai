export interface ModelConfig {
  vocabSize: number;
  nEmbd: number;
  nHead: number;
  nLayer: number;
  blockSize: number;
  dropout?: number;
}

export const configs = {
  pico: {
    vocabSize: 256,
    nEmbd: 64,
    nHead: 4,
    nLayer: 3,
    blockSize: 128,
    dropout: 0.1,
  } as ModelConfig,
  nano: {
    vocabSize: 256,
    nEmbd: 128,
    nHead: 6,
    nLayer: 6,
    blockSize: 256,
    dropout: 0.1,
  } as ModelConfig,
  // Optimized theoSmall config targeting ~500k parameters
  // with small-vocab subword tokenization
  theoSmall: {
    vocabSize: 1536,
    nEmbd: 96,
    nHead: 6,
    nLayer: 6,
    blockSize: 256,
    dropout: 0.1,
  } as ModelConfig,
};
