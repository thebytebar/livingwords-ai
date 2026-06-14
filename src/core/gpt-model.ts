/**
 * Full definition of a GPT Language Model for LivingWords LLM.
 * Ported/adapted from homemade-gpt-js (TensorFlow.js re-implementation of Karpathy's minGPT).
 * 
 * God-centered focus: This model is designed to be fine-tuned on biblical and theological texts
 * for alignment with Christian doctrine. Contributions welcome for theological safeguards.
 */

import * as tf from '@tensorflow/tfjs';
// Optional: use native backend for speed if @tensorflow/tfjs-node is installed
// @ts-ignore - optional, not listed in dependencies
import('@tensorflow/tfjs-node').catch(() => {});
import { Layer, Model, ModelParams } from './types.js';
import { countParams, dispose, withLayerHelpers, withModelHelpers } from './utils.js';

// GPT Language Model
export function GPT(params: ModelParams): Model {
  const { nLayer, nHead, nEmbd, vocabSize, blockSize, embdDropout = 0.1, residDropout = 0.1, attnDropout = 0.1 } = params

  let modelIsWarm = false

  const transformer = {
    wte: tf.layers.embedding({ name: 'wte', inputDim: vocabSize + 1, outputDim: nEmbd, embeddingsInitializer, maskZero: true }),
    wpe: tf.layers.embedding({ name: 'wpe', inputDim: blockSize, outputDim: nEmbd, embeddingsInitializer, inputShape: [blockSize] }),
    drop: tf.layers.dropout({ name: 'drop', rate: embdDropout }),
    add: tf.layers.add({ name: 'add' }),
    h: Array.from({ length: nLayer }, (_, i) => Block({ nEmbd, nHead, blockSize, attnDropout, residDropout, nLayer, name: `block${i + 1}` })),
    lnF: (tf.layers as any).layerNormalization({ name: 'lnF' }),
  }
  const lmHead = tf.layers.dense({ name: 'lmHead', units: vocabSize, useBias: false, kernelInitializer })

  const model: Model = {
    params,
    apply: (idx: tf.Tensor): tf.Tensor => tf.tidy(() => {
      const [B, T] = idx.shape
      if (T !== blockSize) throw new Error(`Sequence must be of size ${blockSize}, got ${T}`)

      const tokEmb = transformer.wte.apply(idx) as tf.Tensor
      const pos = tf.range(0, T, 1).reshape([1, T])
      const posBatched = pos.tile([B, 1])
      const posEmb = transformer.wpe.apply(posBatched) as tf.Tensor

      let x = transformer.add.apply([tokEmb, posEmb]) as tf.Tensor
      x = transformer.drop.apply(x) as tf.Tensor
      transformer.h.forEach((block) => {
        x = block.apply(x)
      })
      x = transformer.lnF.apply(x) as tf.Tensor

      const logits = lmHead.apply(x)
      return logits as tf.Tensor
    }),

    loss: (idx: any, targets: any) => tf.tidy(() => {
      const logits = model.apply(idx)
      const [B, T, C] = logits.shape
      const flattenLogits = logits.reshape([B * T, C])
      const flattenTargets = targets.reshape([B * T])
      const targetsOneHot = tf.oneHot(flattenTargets, vocabSize)
      const loss = tf.losses.softmaxCrossEntropy(targetsOneHot, flattenLogits)
      return loss
    }),

    generate: async (params: any, onGenerateChar?: (token: number) => void) => {
      const { maxNewTokens, temperature = 1.0, doSample = false, topK } = params
      let { idx } = params

      for (let i = 0; i < maxNewTokens; i++) {
        const idxNext = tf.tidy(() => {
          const T = idx.shape[1]!

          const idxShaped = tf.concat([
            idx.slice([0, Math.max(0, T - blockSize)], [-1, Math.min(T, blockSize)]),
            tf.zeros([idx.shape[0], Math.max(0, blockSize - T)], 'int32'),
          ], 1)

          const logits = model.apply(idxShaped)
          const pos = Math.min(T, blockSize) - 1
          let lastCharLogits = logits.slice([0, pos, 0], [-1, 1, -1]).squeeze([1])

          lastCharLogits = tf.div(lastCharLogits, tf.scalar(temperature))

          if (topK) {
            const { values } = lastCharLogits.topk(Math.min(topK, vocabSize))
            const smallestTopK = values.slice([0, values.shape[1]! - 1])
            lastCharLogits = lastCharLogits.where(lastCharLogits.greaterEqual(smallestTopK), tf.scalar(-Infinity))
          }

          const probs = tf.softmax(lastCharLogits) as tf.Tensor2D

          let idxNext: tf.Tensor
          if (doSample) {
            idxNext = tf.multinomial(probs, 1)
          } else {
            idxNext = probs.argMax(-1).expandDims(-1)
          }
          return idxNext
        })

        const idxPrev = idx
        idx = idx.concat(idxNext, 1)

        if (onGenerateChar) {
          const nextToken = ((await (idxNext as any).array()) as number[][])[0][0]
          onGenerateChar(nextToken)
        }

        dispose([idxNext, idxPrev])
        await tf.nextFrame()
      }
      return idx
    },

    optimizer: (params: { learningRate: number }) => tf.train.adam(params.learningRate),

    build: () => tf.tidy(() => {
      if (modelIsWarm) return
      model.apply(tf.zeros([1, blockSize]))
      modelIsWarm = true
    }),

    summary: () => tf.tidy(() => {
      model.build()
      const { wte, wpe, add, drop, lnF, h } = transformer
      const paramsCount = countParams([ wte, wpe, add, drop, lnF, ...h ])
      return { params: paramsCount }
    }),

    // sequenceLogProb for DPO support
    sequenceLogProb: async (tokens: number[]): Promise<number> => {
      if (!tokens || tokens.length < 2) return 0;

      return tf.tidy(() => {
        const context = tokens.slice(0, -1);
        const target = tokens[tokens.length - 1];

        let padded = context;
        if (padded.length > blockSize) padded = padded.slice(-blockSize);
        if (padded.length < blockSize) {
          padded = Array(blockSize - padded.length).fill(0).concat(padded);
        }

        const idx = tf.tensor([padded], [1, blockSize], 'int32');
        const logits = model.apply(idx) as tf.Tensor;
        const pos = blockSize - 1;
        const lastLogits = logits.slice([0, pos, 0], [-1, 1, -1]).squeeze([0, 1]);
        const logProbs = tf.logSoftmax(lastLogits);
        const logProb = logProbs.slice([target], [1]).dataSync()[0] as number;
        return logProb;
      });
    },
  }

  return withModelHelpers(model, [transformer.wte, transformer.wpe, transformer.add, transformer.drop, transformer.lnF, transformer.h, lmHead])
}

function Block(args: any): Layer {
  const { nEmbd, nHead, blockSize, residDropout, attnDropout, nLayer, name } = args

  const ln1 = (tf.layers as any).layerNormalization({ name: `${name}-ln1` })
  const attn = CausalSelfAttention({ name: `${name}-attn`, nEmbd, blockSize, nHead, residDropout, attnDropout, nLayer })
  const ln2 = (tf.layers as any).layerNormalization({ name: `${name}-ln2` })
  const mlp = FeedForward({ name: `${name}-mlp`, nEmbd, residDropout, nLayer })

  const block = {
    apply: (x: tf.Tensor): tf.Tensor => {
      x = x.add(attn.apply(ln1.apply(x) as tf.Tensor))
      x = x.add(mlp.apply(ln2.apply(x) as tf.Tensor))
      return x
    },
  }

  return withLayerHelpers(block, [ln1, attn, ln2, mlp])
}

function CausalSelfAttention(args: any): Layer {
  const { nHead, blockSize, nEmbd, attnDropout, residDropout, nLayer, name } = args

  if (nEmbd % nHead !== 0) throw new Error(`Cannot calculate head size: nEmbd % nHead !== 0`)
  const headSize = nEmbd / nHead

  const cAttn = tf.layers.dense({ name: `${name}-cAttn`, inputDim: nEmbd, units: nEmbd * 3, useBias: false, kernelInitializer })
  const cProj = tf.layers.dense({ name: `${name}-cProj`, inputDim: nEmbd, units: nEmbd, kernelInitializer: projectionKernelInitializer(nLayer), biasInitializer })

  const attnDrop = tf.layers.dropout({ name: `${name}-attnDrop`, rate: attnDropout })
  const residDrop = tf.layers.dropout({ name: `${name}-residDrop`, rate: residDropout })

  const bias = (tf as any).linalg.bandPart(tf.ones([blockSize, blockSize]), -1, 0).reshape([1, 1, blockSize, blockSize])

  const multiHeadAttention: Layer = {
    apply: (x: tf.Tensor): tf.Tensor => tf.tidy(() => {
      const [B, T, C] = x.shape

      const qkv = cAttn.apply(x) as tf.Tensor
      const q = qkv.slice([0, 0, 0], [-1, -1, C]).reshape([B, T, nHead, C / nHead]).transpose([0, 2, 1, 3])
      const k = qkv.slice([0, 0, C], [-1, -1, C]).reshape([B, T, nHead, C / nHead]).transpose([0, 2, 1, 3])
      const v = qkv.slice([0, 0, 2 * C], [-1, -1, C]).reshape([B, T, nHead, C / nHead]).transpose([0, 2, 1, 3])

      let att = tf.matMul(q, k.transpose([0, 1, 3, 2])).mul(tf.scalar(1 / Math.sqrt(headSize)))
      att = tf.where(bias.slice([0, 0, 0, 0], [1, 1, T, T]).equal(0), tf.scalar(-Infinity), att)
      att = tf.softmax(att)
      att = attnDrop.apply(att) as tf.Tensor
      let y = tf.matMul(att, v)
      y = y.transpose([0, 2, 1, 3]).reshape([B, T, C])

      y = cProj.apply(y) as tf.Tensor
      y = residDrop.apply(y) as tf.Tensor
      return y
    }),
  }

  return withLayerHelpers(multiHeadAttention, [cAttn, cProj, attnDrop, residDrop])
}

function FeedForward(args: any): Layer {
  const { nEmbd, residDropout, nLayer, name } = args

  const cFc = tf.layers.dense({ name: `${name}-cFc`, inputShape: [nEmbd], units: 4 * nEmbd, activation: 'gelu_new', kernelInitializer, biasInitializer })
  const cProj = tf.layers.dense({ name: `${name}-cProj`, inputShape: [4 * nEmbd], units: nEmbd, kernelInitializer: projectionKernelInitializer(nLayer), biasInitializer })
  const drop = tf.layers.dropout({ name: `${name}-drop`, rate: residDropout })

  const ffwd: Layer = {
    apply: (x: tf.Tensor): tf.Tensor => tf.tidy(() => {
      const x1 = cFc.apply(x)
      const x2 = cProj.apply(x1)
      return drop.apply(x2) as tf.Tensor
    }),
  }

  return withLayerHelpers(ffwd, [cFc, cProj, drop])
}

const embeddingsInitializer = tf.initializers.randomNormal({ mean: 0.0, stddev: 0.02 })
const projectionKernelInitializer = (nLayer: number) => tf.initializers.randomNormal({ mean: 0.0, stddev: 0.02 / Math.sqrt(2 * nLayer) })
const kernelInitializer = tf.initializers.randomNormal({ mean: 0.0, stddev: 0.02 })
const biasInitializer = 'zeros'
