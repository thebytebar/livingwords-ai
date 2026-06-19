# LivingWords LLM — Complete Usage Guide

This guide covers everything you need to train the model on new data, use the CLI tools, run the HTTP server/API, and use the web chat interface.

> **Important Context**: LivingWords LLM is a small decoder-only transformer targeting ~500k parameters (`theoSmall` config). It uses small-vocab subword tokenization (~1536 tokens) built on top of tiktoken. The model is designed to run on standard laptops with no GPU. Training is performed with Python + PyTorch; inference uses ONNX Runtime (onnxruntime-node) by default. The "God-centered" alignment comes from curated biblical training data and a hybrid retrieval + generation system.

## Project Goals

**Core Vision**: A small, God-centered, open-source LLM that runs on normal laptops. Training uses Python + PyTorch; inference uses ONNX Runtime. The model must remain faithful to Scripture and produce warm, encouraging, biblically-aligned output.

**Primary Use Case**: Scripture paraphrase, devotional writing, prayer generation, and verse explanation — not a general knowledge chatbot.

**Hybrid Architecture**: User question → Semantic search over Bible → Relevant verses + question → Model generates warm explanation.

## Table of Contents

- [Preparing Training Data](#preparing-training-data)
- [Training the Model](#training-the-model)
- [Training CLI Flags Explained](#training-cli-flags-explained)
- [Understanding Training Progress](#understanding-training-progress)
- [Checkpoints and Model Persistence](#checkpoints-and-model-persistence)
- [Using the CLI](#using-the-cli)
- [Running the Server & API](#running-the-server--api)
- [The Web Chat Interface](#the-web-chat-interface)
- [Loading Specific Models & Checkpoints](#loading-specific-models--checkpoints)
- [Tips for Better Results](#tips-for-better-results)
- [Limitations](#limitations)

---

## Preparing Training Data

**Pre-training data** uses the following eight public-domain Bible translations combined into `data/pretrain_bible.txt`:

- AKJV – Authorized King James Version
- ASV – American Standard Version
- DBT – Darby Bible Translation
- ERV – English Revised Version
- KJV – King James Version
- WBT – Webster’s Bible Translation
- WEB – World English Bible
- YLT – Young’s Literal Translation

**Fine-tuning data** (planned): 8,000–12,000 high-quality verse + explanation pairs sourced from curated Bible studies.

The model uses **small-vocab subword tokenization** (~1536 tokens).

### Requirements

- Plain text files (`.txt`)
- UTF-8 encoding
- For best results, use clean, well-formatted biblical text

## Training the Model

Training is performed with the Python scripts in the `training/` directory (PyTorch).

```bash
cd training
pip install -r requirements.txt
python pretrain.py --data ../data/pretrain_bible.txt --max-iters 1500
```

After training, the TS/CLI tools can load the resulting `model.onnx` + `meta.json`.
```bash
npx lw-llm chat --load weights/latest
```
A default pre-trained model is included in the package, so plain `npx lw-llm chat` works without training.

## Training CLI Flags Explained

| Flag                | Default   | Description                                      | Recommended |
|---------------------|-----------|--------------------------------------------------|-------------|
| `--data`            | bible.txt | Path to training text                            | pretrain_bible.txt |
| `--model`           | theoSmall | Model config (theoSmall only)                    | theoSmall   |
| `--epochs`          | 2         | Number of full passes                            | 3–6         |
| `--max-iter`        | 1200      | Total training steps                             | 1500–3000   |
| `--batch-size`      | 16        | Examples per step                                | 16–32       |
| `--learning-rate`   | 0.0008    | Adam learning rate                               | 0.0005–0.001|
| `--eval-interval`   | 100       | Steps between printing loss + samples            | 50–200      |
| `--save-interval`   | 400       | Save checkpoint every N steps                    | 300–600     |

## Understanding Training Progress

During training you will see a progress indicator (`⏳ Training step X/1200...`) along with loss and sample generations at evaluation intervals.

## Checkpoints and Model Persistence

Checkpoints are automatically saved to:
- `weights/checkpoint-XXXXX/`
- `weights/latest/` (always points to most recent)

The final trained model is saved to `weights/`.

## Using the CLI

```bash
# Generate
npx lw-llm generate "What does the Bible say about grace?"

# Chat
npx lw-llm chat

# Serve web UI + API
npx lw-llm serve --port 3000
```

## Running the Server & API

The server provides:
- `POST /api/generate` — Main generation endpoint
- Web chat interface at `/`

## The Web Chat Interface

A single-file web UI that works in any modern browser.

## Loading Specific Models & Checkpoints

```bash
npx lw-llm chat --load weights/latest
```

## Tips for Better Results

- Use the combined `pretrain_bible.txt` for pre-training
- Keep training data clean and theologically sound
- Use the hybrid retrieval system (vector search over Bible) for production use

## Limitations

- ~500k parameters (intentionally small)
- Primary strength is Scripture paraphrase and devotional writing
- Not a general knowledge model
- Subword vocabulary is limited to the most frequent tokens from the training corpus

---

**Full source**: [README.md](../README.md)
