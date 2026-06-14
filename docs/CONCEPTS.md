# Educational Guide: Core Concepts in LivingWords LLM

This document explains the fundamental ideas behind how this LLM works. It is written for developers who want to understand the "why" and "how" of building a small language model from scratch.

LivingWords LLM is a **small decoder-only transformer** (~500k parameters in the `theoSmall` config) implemented in TypeScript using TensorFlow.js. It is designed to run on normal laptops with no GPU and stay faithful to Scripture. The model uses **small-vocab subword tokenization** (~2048 tokens) for better coherence while remaining lightweight.

---

## Project Alignment

**Core Vision**: A God-centered, open-source LLM that produces warm, encouraging, biblically-aligned output for Christians and ministries.

**Primary Strength**: Scripture paraphrase, devotional writing, prayer generation, and verse explanation.

**Hybrid System**: The model is designed to work together with verse retrieval (vector/semantic search over KJV + ASV + WEB) to ensure theological safety.

---

## Table of Contents

1. [What is a Language Model?](#what-is-a-language-model)
2. [Tokenization: Turning Text into Numbers](#tokenization-turning-text-into-numbers)
3. [Embeddings: Giving Tokens Meaning and Position](#embeddings-giving-tokens-meaning-and-position)
4. [The Transformer Architecture](#the-transformer-architecture)
5. [Self-Attention: The Heart of the Model](#self-attention-the-heart-of-the-model)
6. [The Full Transformer Block](#the-full-transformer-block)
7. [Training: Next-Token Prediction](#training-next-token-prediction)
8. [Loss Function: Measuring How "Surprised" the Model Is](#loss-function-measuring-how-surprised-the-model-is)
9. [Generation: Making the Model Talk](#generation-making-the-model-talk)
10. [Why So Small? (theoSmall config)](#why-so-small-theosmall-config)
11. [Putting It All Together](#putting-it-all-together)
12. [Further Reading](#further-reading)

---

## What is a Language Model?

At its core, a language model is a system that learns to predict the **next piece of text** given some previous text.

You give it:

> "In the beginning God created the"

It tries to predict what comes next (e.g., "heavens").

LivingWords LLM does exactly this, but at a deliberately small scale (~500k parameters) so it can run on ordinary laptops while still learning the style and tone of Scripture.

---

## Tokenization: Turning Text into Numbers

Computers don't understand letters. They need numbers.

### Small-Vocab Subword Tokenization (v1)

LivingWords LLM v1 uses a **compact subword vocabulary** of approximately 2048 tokens. It leverages tiktoken (`cl100k_base`) to generate high-quality subword splits, then keeps only the most frequent tokens from the training corpus.

This approach gives better coherence than pure character-level tokenization while keeping the vocabulary small enough to stay within the ~500k parameter budget.

**Benefits of this approach**:
- Much better at learning real words and theological terms than character-level
- Still lightweight enough for laptop training
- No need for the full 100k+ tiktoken vocabulary

---

## Embeddings, Transformer Architecture, Self-Attention, etc.

(The rest of the technical explanation remains largely the same as the original file, focused on the decoder-only transformer design.)

---

## Why So Small? (theoSmall config)

The `theoSmall` configuration targets approximately **500,000 parameters**:

- `nEmbd`: 128
- `nHead`: 8
- `nLayer`: 6
- `blockSize`: 256
- `vocabSize`: ~2048 (small custom subword vocab built on top of tiktoken)

This size was chosen so that:
- Training completes in reasonable time on a laptop
- Inference is fast enough for interactive use
- The model remains educational and understandable

---

## Putting It All Together

LivingWords LLM combines:
- A small decoder-only transformer
- Small-vocab subword tokenization (~2048 tokens)
- Training exclusively on public-domain Bible text
- A planned hybrid retrieval + generation system for theological safety

The result is a model that can generate warm, scripture-flavored explanations while remaining runnable on normal consumer hardware.

---

## Further Reading

- [README.md](../README.md)
- [docs/USAGE.md](USAGE.md)
