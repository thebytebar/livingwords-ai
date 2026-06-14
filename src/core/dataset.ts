/**
 * Dataset supporting both legacy char-level and tiktoken subword tokenization.
 */

import * as tf from '@tensorflow/tfjs';
import { Dataset, DatasetParams, DatasetGetBatchParams } from './types.js';
import { createSmallTiktokenTokenizer, Tokenizer } from './tokenizer.js';

export async function createDataset(args: DatasetParams): Promise<Dataset> {
  const textSource: string = args.textSource || '';
  const maskZero = args.maskZero ?? true;
  const useSubword = (args as any).useSubword ?? false;
  const targetVocab = (args as any).vocabSize ?? 1536;

  let tokenizer: Tokenizer;
  let vocabSizeActual: number;

  if (useSubword) {
    tokenizer = createSmallTiktokenTokenizer(textSource, targetVocab);
    vocabSizeActual = tokenizer.vocabSize;
  } else {
    // Legacy character-level
    const chars = Array.from(new Set(textSource)).sort();
    const indexShift = maskZero ? 1 : 0;
    const stoi: Record<string, number> = {};
    const itos: Record<number, string> = {};

    chars.forEach((ch, i) => {
      const id = i + indexShift;
      (stoi as any)[ch] = id;
      (itos as any)[id] = ch;
    });

    tokenizer = {
      encode: (s: string) => s.split('').map(c => (stoi as any)[c] || 0),
      decode: (a: number[]) => a.map(i => (itos as any)[i] || '').join(''),
      vocabSize: chars.length + indexShift,
    };
    vocabSizeActual = tokenizer.vocabSize;
  }

  const encoded = tokenizer.encode(textSource);
  const textSize = encoded.length;
  const data = tf.tensor(encoded, [textSize], 'int32');
  const n = Math.floor(0.9 * textSize);
  const trainData = data.slice(0, n);
  const valData = data.slice(n);

  const getBatch = (args: DatasetGetBatchParams) => tf.tidy(() => {
    const { split, blockSize, batchSize } = args;
    const dataSplit = split === 'train' ? trainData : valData;
    const maxval = dataSplit.shape[0] - blockSize;
    const ix = tf.randomUniform([batchSize], 0, maxval, 'int32');
    const ranges = tf.range(0, blockSize, 1, 'int32').expandDims(0);
    const indices = ix.expandDims(1).add(ranges);
    const x = tf.gather(dataSplit, indices as any);
    const y = tf.gather(dataSplit, indices.add(tf.scalar(1, 'int32')) as any);
    return { x, y };
  });

  return {
    vocabSize: vocabSizeActual,
    dataSize: textSize,
    vocabulary: [],
    text: textSource,
    getBatch,
    encode: tokenizer.encode.bind(tokenizer),
    decode: tokenizer.decode.bind(tokenizer),
    dispose: () => data.dispose(),
  };
}
