# LivingWords LLM

**Open-source God-centered LLM** aligned with Christian theological doctrine.

A lightweight decoder-only transformer designed to run entirely on normal laptops (no GPU required) using pure JavaScript and TensorFlow.js. The model is built to stay faithful to Scripture and produce warm, encouraging, biblically-aligned output for Christians and ministries.

## Core Vision

Create a small, God-centered, open-source LLM that:
- Runs comfortably on a standard laptop (e.g. MacBook Air M1/M2 with 8GB RAM)
- Uses only TensorFlow.js / JavaScript (CPU-only, no Python)
- Remains lightweight and educational
- Produces scripture-flavored explanations, devotional thoughts, and prayer language

## Key Constraints (Non-Negotiable)

- Runs on standard consumer laptops (CPU-only)
- Pure JavaScript / TensorFlow.js stack
- Model must stay lightweight (~500k parameters target)
- Training and inference must be feasible on modest hardware

## Target Architecture (v1)

- Decoder-only transformer (nanoGPT-style)
- ~500k parameters (`theoSmall` config)
- Small-vocab subword tokenization (~1536 tokens) using tiktoken with frequency pruning
- Context length: 256 tokens

## Data Strategy

**Pre-training**: Eight public-domain Bible translations combined into a single corpus (`data/pretrain_bible.txt`):

- AKJV – Authorized King James Version
- ASV – American Standard Version
- DBT – Darby Bible Translation
- ERV – English Revised Version
- KJV – King James Version
- WBT – Webster’s Bible Translation
- WEB – World English Bible
- YLT – Young’s Literal Translation

**Fine-tuning (Stage 2)**: High-quality verse + explanation pairs (target 8,000–12,000 examples) sourced from curated user Bible studies.

## Desired Behavior (Hybrid System)

The system is designed as a gated, reliable assistant:

1. User asks a Bible or life question
2. Vector/semantic search over the Bible corpus retrieves relevant verses
3. Those verses + the question are passed to the 500k model
4. The model generates a warm, simple, coherent explanation/paraphrase/devotional thought
5. Output includes: Actual Bible verses + model-generated explanation

**Graceful fallback**: If no relevant verses are found → “Sorry, I don’t have clear verses on that topic...”

**Primary strength**: Scripture paraphrase, devotional writing, prayer generation, and verse explanation — not a general knowledge chatbot.

## Success Criteria for v1

- Produces fluent, scripture-flavored explanations when given verses
- Training and inference run comfortably on a standard laptop
- Web UI + CLI + API all functional
- Theologically safe (no hallucinations on core doctrine thanks to search gate)

## Features

- Train small transformer models locally in Node.js (subword, CPU-friendly)
- CLI chatbot (`lw-llm chat`)
- Server/API mode (`lw-llm serve`) — REST API + served web chat UI
- Full training pipeline with checkpoints and automatic save/load
- `theoSmall` config targeting ~500k parameters with subword tokenization

## Quick Start

```bash
npm install livingwords-llm
```

### CLI Usage

```bash
# Train using the optimized theoSmall config
npx lw-llm train --data data/pretrain_bible.txt --model theoSmall --epochs 3

# Generate text
npx lw-llm generate "In the beginning God created"

# Interactive chatbot
npx lw-llm chat

# Start server + web chat UI
npx lw-llm serve --port 3000
```

## Documentation

- **[docs/USAGE.md](docs/USAGE.md)** — Comprehensive usage guide
- **[docs/CONCEPTS.md](docs/CONCEPTS.md)** — Educational deep dive into the architecture

## License

MIT
