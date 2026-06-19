# LivingWords LLM — PyTorch Training

**This is the new home for all training (pre-training and post-training).**

The model is a small decoder-only transformer (`theoSmall` config only):
- ~990k parameters
- `n_layer=6`, `n_embd=96`, `n_head=6`, `block_size=256`
- Small-vocab subword tokenization (~1536 tokens) via pruned `cl100k_base` (tiktoken)
- Primary data: public-domain Bible translations (see `../data/pretrain_bible.txt`)

**The legacy TensorFlow.js backend is no longer supported.** Runtime / inference / CLI chat & serve use TypeScript with ONNX Runtime (onnxruntime-node).

## Quick Start (Laptop / CPU)

```bash
# 1. Create a virtualenv (recommended)
python -m venv .venv
source .venv/bin/activate   # or .venv\Scripts\activate on Windows

# 2. Install deps (CPU-friendly)
pip install -r requirements.txt

# On macOS Apple Silicon the above will enable MPS automatically.
# For explicit CPU torch on other platforms:
# pip install torch --index-url https://download.pytorch.org/whl/cpu

# 3. Pre-train (theoSmall is the ONLY supported config)
python pretrain.py \
  --data ../data/pretrain_bible.txt \
  --max-iters 1500 \
  --batch-size 16 \
  --lr 0.0008 \
  --eval-interval 100 \
  --save-interval 400

# Artifacts are written to ../weights/ (legacy format for current CLI) + training/checkpoints/
```

## What You Get

- `../weights/latest/` (and `checkpoint-XXXXX/`) with:
  - `model.onnx` + `meta.json` + `config.json` — the primary artifacts for the TS runtime (`lw-llm chat`, `generate`, `serve`).
  - `kept_ids.json`
  - `model.safetensors` (or .pt fallback)

The training scripts now primarily emit the modern ONNX artifacts by default. The legacy `weights.json` format is not written by default (set `write_legacy_weights=True` only if you need it for other tools).

### Inference (TypeScript runtime)

`LivingWordsLLM.load(weightsDir)` loads the ONNX model:

```bash
npx lw-llm chat --load weights/latest
# or
npx lw-llm serve
```

`onnxruntime-node` is an **optionalDependency** (recommended for inference). 

After training, point the TS runtime at the directory containing `model.onnx` + `meta.json`:
```ts
const model = new LivingWordsLLM();
await model.load('weights/latest');
```

## Post-Training

```bash
# SFT (example — provide your own data)
python sft.py --data data/sft_sample.jsonl --max-iters 400

# DPO
python dpo.py --data data/prefs_sample.jsonl --max-iters 200
```

See the sample data files and the scripts for the exact JSONL schema. Real SFT uses proper loss masking (only completion tokens contribute to loss). DPO uses a clean reference-free formulation.

### Theological Triage Dataset

A large curated SFT dataset (~1200 examples) focused on Christian theological triage and Bible study Q&A was created for this project. It is located at:

```
data/theological_triage_sft.jsonl
```

The dataset covers:
- Tier 1 (Essentials / Non-negotiable) — gospel core doctrines with strong emphasis
- Tier 2 (Important / Denominational) — church practice and polity with multiple legitimate views
- Tier 3 (Disputable) — eschatology, spiritual gifts, gender roles, etc., with charitable presentation of differing orthodox positions
- Tier 4 (Preferences / Adiaphora) — minor matters

Each example includes:
- `prompt` — the question (objective, pastoral, or adversarial style)
- `completion` — a full, in-depth theological explanation
- Metadata fields (`tier`, `category`, `subtopic`, `style`, `id`)

The data was generated to train the model to:
- Explain theological triage itself
- Give balanced, pastorally sensitive answers on secondary/tertiary issues
- Maintain clear, confident orthodoxy on Tier 1 essentials
- Reference Scripture and systematic theology appropriately

This file can be used directly with:

```bash
python sft.py --data data/theological_triage_sft.jsonl --max-iters 400
```

## Configuration

Only `theoSmall` is supported. `pico` and `nano` have been dropped.

All scripts default to theoSmall. The tokenizer pruning is deterministic given the corpus, so a model trained here on `pretrain_bible.txt` produces token IDs compatible with the JS runtime tokenizer.

## Export Formats (for the JS runtime)

The scripts emit `model.onnx` + `meta.json` expected by `src/core/model.ts` `LivingWordsLLM.load()` / `setWeights()`.

Longer term we will prefer:
- `model.safetensors` (or `.pt`)
- `model.onnx`
- `config.json` + `tokenizer/kept_ids.json`

The export code lives in `common/export.py` (and is called by the training scripts).

## Reproducing Tokenizer IDs (Important for Compatibility)

The small vocab is built by:
1. Encode the full training corpus with tiktoken `cl100k_base`.
2. Count frequency of each original token id.
3. Keep the top `(vocab_size - 4)` most frequent.
4. Compact IDs start at 4 (0-3 reserved/special), unk = 1.

`common/tokenizer.py` replicates the JS logic **exactly**. A helper is provided to dump the kept original IDs once so both sides can share them.

## Tips

- Training this tiny model is fast even on CPU. 1500–3000 steps is a good starting range.
- Use `--max-iters` for quick experiments; full pretrain on the Bible corpus benefits from more steps + slightly lower LR.
- Modern artifacts are small (< 5 MB for .onnx). 
- For best "God-centered" behavior, curate high-quality SFT pairs (verse → warm explanation / paraphrase / devotional) and preference data (chosen vs. rejected on theological tone/accuracy).
- The hybrid retrieval + generation system (planned) is still the long-term guardrail for safety; the 500k model itself is stylistic.


Same as the project (MIT). The training code is intentionally minimal and educational (in the spirit of nanoGPT) while being practical for this use case.

Run with grace and peace.
