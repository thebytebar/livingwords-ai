# LivingWords LLM

**Open-source God-centered LLM** aligned with Christian theological doctrine.

A lightweight decoder-only transformer (theoSmall config) designed to run on normal laptops. Training is performed with Python + PyTorch. Inference uses TypeScript with ONNX Runtime (onnxruntime-node, optional dep) as the only supported engine. The model is built to stay faithful to Scripture and produce warm, encouraging, biblically-aligned output for Christians and ministries.

## Core Vision

Create a small, God-centered, open-source LLM that:
- Runs comfortably on a standard laptop (e.g. MacBook Air M1/M2 with 8GB RAM)
- Training uses Python + PyTorch; runtime is TypeScript with ONNX Runtime (onnxruntime-node, optional)
- Remains lightweight and educational
- Produces scripture-flavored explanations, devotional thoughts, and prayer language

## Key Constraints (Non-Negotiable)

- Runs on standard consumer laptops (CPU-only)
- Training: Python + PyTorch; Inference: TypeScript + ONNX Runtime
- Model must stay lightweight (~500k parameters target)
- Training and inference must be feasible on modest hardware

## Target Architecture (v1)

- Decoder-only transformer (nanoGPT-style)
- ~990k parameters (`theoSmall` config) (actual count from the implementation)
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
- CLI chatbot (`lw chat`)
- Server/API mode (`lw serve`) — REST API + served web chat UI
- Full training pipeline with checkpoints and automatic save/load
- `theoSmall` config targeting ~990k parameters with subword tokenization

## Quick Start

```bash
npm install livingwords-llm
```

### CLI Usage (runtime)

```bash
# Generate text (uses the bundled default model, or --load for custom)
npx lw generate "In the beginning God created"

# Interactive chatbot
npx lw chat

# Start server + web chat UI
npx lw serve --port 3000
```

### Training (PyTorch)

Training (pretrain + SFT + DPO) has moved to Python/PyTorch. `theoSmall` is the only supported configuration.

```bash
cd training
pip install -r requirements.txt
python pretrain.py --data ../data/pretrain_bible.txt --max-iters 1500
# or
python sft.py --data data/sft_sample.jsonl
python dpo.py --data data/prefs_sample.jsonl
```

Weights are automatically exported in the format expected by the TypeScript runtime (both legacy `weights.json` and modern `model.onnx`), so `lw chat` etc. continue to work unchanged.

The runtime uses the ONNX backend (via `onnxruntime-node`, optional dep) when a `model.onnx` + `meta.json` is present (loaded via `.load()`). This is the currently supported inference path.

TensorFlow.js is no longer supported. Old `weights.json` checkpoints are not loadable. Use the Python training tools in `training/` to produce `model.onnx` artifacts.

See [training/README.md](training/README.md) for full details.

## Documentation

- **[docs/USAGE.md](docs/USAGE.md)** — Comprehensive usage guide
- **[docs/CONCEPTS.md](docs/CONCEPTS.md)** — Educational deep dive into the architecture

## License

MIT
