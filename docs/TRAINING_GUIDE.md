# LivingWords LLM — Full Pre-Training and Post-Training Guide (SFT + DPO)

This guide provides a complete, reproducible step-by-step process for training the `theoSmall` model from scratch through pre-training on the Bible corpus, supervised fine-tuning (SFT), and Direct Preference Optimization (DPO). The goal is to produce a coherent, theologically aligned model that generates warm, scripture-flavored explanations, devotionals, and responses.

All training uses the Python/PyTorch pipeline in `training/`. The resulting `model.onnx` + `meta.json` artifacts are compatible with the TypeScript runtime (`npx lw chat`, `serve`, etc.).

**Target model**: `theoSmall` only (~990k parameters, 6 layers, 96 embd, 6 heads, block_size=256, ~1536 token vocab via pruned tiktoken cl100k_base).

**Hardware note**: Works well on CPU or Apple Silicon (MPS). Training a full pipeline takes minutes to a couple hours on a laptop.

## Prerequisites

1. Clone the repo and change into the repo root directory.

2. Python 3.10+ with pip.

3. (Recommended) Create and activate a virtual environment:

   ```bash
   cd training
   python -m venv .venv
   source .venv/bin/activate   # macOS/Linux
   # or .venv\Scripts\activate on Windows
   ```

4. Install dependencies:

   ```bash
   pip install -r requirements.txt
   ```

   - On Apple Silicon: plain `pip install torch` enables MPS automatically.
   - For explicit CPU: `pip install torch --index-url https://download.pytorch.org/whl/cpu`
   - CUDA users: follow https://pytorch.org/get-started/locally/

5. Verify tokenizer parity (important for runtime compatibility):

   The `common/tokenizer.py` + committed `kept_ids.json` ensure the small vocab matches the JS side exactly. No manual steps needed unless you change the pretrain corpus.

## Data Overview (Ready to Use)

Data now lives in a structured layout under `data/`:

- **Pre-training**: `../data/pretrain/pretrain_bible.txt` (concatenated public-domain translations: AKJV, ASV, DBT, ERV, KJV, WBT, WEB, YLT). ~36 MB of clean biblical text.
- **SFT**: `../data/stf/theological_triage_sft.jsonl` (~1,200 high-quality examples covering Tier 1–4 theology, with `prompt` + `completion` fields + metadata for triage categories). Also supports legacy `text` field.
- **DPO preferences**: `../data/dpo/dpo_prefs.jsonl` (prompt + chosen + rejected pairs focused on theological tone, accuracy, and pastoral sensitivity).

You can also supply your own `.jsonl` files following the schemas shown in the script docstrings.

## Step 1: Pre-Training (Build the Base Language Model)

Pre-training teaches the model next-token prediction on raw Bible text. This establishes fluency in scripture language, vocabulary, and style.

The script defaults produce a solid base model. Just point it at the Bible corpus:

```bash
cd training
python pretrain.py --data ../data/pretrain/pretrain_bible.txt
```

**Key flags** (only override if experimenting):
- `--max-iters`: default 5000 (3000–8000 is a good range)
- `--batch-size`: default 32
- `--lr`: default 6e-4
- `--eval-interval`: default 200
- `--save-interval`: default 1000
- `--seed`: default 1337
- `--device`: default auto

**What to expect**:
- Loss decreases steadily; samples at eval intervals will start producing coherent biblical-sounding text.
- Total time: ~30–90 minutes on laptop depending on hardware and iters.
- Final artifacts land in `../weights/latest/` (ready for immediate use or loading into SFT/DPO).

After this step you have a functional base model. Test it:

```bash
cd ..
npx lw chat --load weights/latest
# or
npx lw generate "In the beginning God created"
```

## Step 2: Supervised Fine-Tuning (SFT) — Align to Instruction Following & Theology

SFT teaches the model to respond to prompts with high-quality completions. Uses proper loss masking (only completion tokens contribute to loss).

The script defaults (plus loading the pre-trained weights) give good theological alignment:

```bash
cd training
python sft.py --data ../data/stf/theological_triage_sft.jsonl --load ../weights/latest
```

**Notes**:
- `--load` points to a directory containing `model.pt` or `model.safetensors` (weights/latest or any checkpoint-XXXXX/).
- The theological triage dataset is specifically curated for this project.
- If using custom data, ensure JSONL lines contain at minimum `prompt` + `completion`.
- Exports updated `model.onnx` etc. to `weights/latest/` at the end.

After SFT, test coherence:

```bash
npx lw chat --load weights/latest
# Try prompts like: "Explain the Trinity" or "What does it mean that God created the heavens and the earth?"
```

## Step 3: Direct Preference Optimization (DPO) — Preference Alignment

DPO further aligns the model by teaching it to prefer "chosen" (good theological/pastoral) responses over "rejected" ones.

Defaults are tuned for gentle preference alignment:

```bash
cd training
python dpo.py --data ../data/dpo/dpo_prefs.jsonl --load ../weights/latest
```

**Key flags** (only override if needed):
- `--beta`: default 0.15 (controls preference strength)
- `--lr`: default 2e-4
- `--max-iters`: default 400

Final export again updates `weights/latest/`.

## Full End-to-End Pipeline (One-Shot Reproduction)

Run these minimal commands in sequence:

```bash
# 1. Setup (once)
cd training
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# 2. Pre-train (uses script defaults)
python pretrain.py --data ../data/pretrain/pretrain_bible.txt

# 3. SFT (theological alignment)
python sft.py --data ../data/stf/theological_triage_sft.jsonl --load ../weights/latest

# 4. DPO (preference tuning)
python dpo.py --data ../data/dpo/dpo_prefs.jsonl --load ../weights/latest

# 5. Verify
cd ..
npx lw chat --load weights/latest
```

**Expected outcome**: A model that produces fluent, biblically grounded, pastorally sensitive responses with good coherence within the 256-token context.

## Command-Line Options Reference

### pretrain.py

| Flag                  | Type    | Default   | Description |
|-----------------------|---------|-----------|-------------|
| `--data`              | str     | required  | Path to the pre-training text corpus (e.g. `../data/pretrain/pretrain_bible.txt`). |
| `--max-iters`         | int     | 5000      | Total number of optimization steps. |
| `--batch-size`        | int     | 32        | Number of sequences per training step. |
| `--lr`, `--learning-rate` | float | 6e-4    | Learning rate for the optimizer. |
| `--eval-interval`     | int     | 200       | Print loss and generate a sample every N steps. |
| `--save-interval`     | int     | 1000      | Export full checkpoint (ONNX + meta) every N steps. |
| `--block-size`        | int     | None      | Override context length (rarely needed; uses config default of 256). |
| `--seed`              | int     | 1337      | Random seed for reproducibility. |
| `--device`            | str     | auto      | `cpu`, `cuda`, `mps`, or `auto` (detects best available). |

### sft.py

| Flag             | Type    | Default   | Description |
|------------------|---------|-----------|-------------|
| `--data`         | str     | required  | Path to SFT JSONL file (e.g. `../data/stf/theological_triage_sft.jsonl`). |
| `--max-iters`    | int     | 1500      | Total training steps. |
| `--batch-size`   | int     | 8         | Number of examples per step. |
| `--lr`           | float   | 3e-4      | Learning rate. |
| `--block-size`   | int     | 256       | Context length (must match model). |
| `--device`       | str     | auto      | Device to train on. |
| `--load`         | str     | None      | Directory containing a pre-trained checkpoint (`model.pt` or `model.safetensors`) to continue from. |

### dpo.py

| Flag             | Type    | Default   | Description |
|------------------|---------|-----------|-------------|
| `--data`         | str     | required  | Path to DPO preference JSONL (prompt + chosen + rejected). |
| `--max-iters`    | int     | 400       | Total DPO optimization steps. |
| `--beta`         | float   | 0.15      | DPO beta hyperparameter controlling preference strength (0.05–0.2 typical). |
| `--lr`           | float   | 2e-4      | Learning rate (kept low for gentle updates). |
| `--batch-size`   | int     | 4         | Number of preference pairs per step. |
| `--device`       | str     | auto      | Device to train on. |
| `--load`         | str     | None      | Directory containing the SFT checkpoint to start from. |

## Optimization Tips for Maximum Coherency

- **Data quality > quantity**: The provided theological SFT + DPO datasets are the key to "God-centered" behavior.
- **Staged training**: Pretrain → SFT → DPO. Avoid skipping stages.
- **Evaluation loop**: After each stage, run `npx lw chat` and score samples on coherence, theological accuracy, warmth, and scripture fidelity.
- **Reproducibility**: The `--seed 1337` default + fixed data files make runs highly reproducible.

## Inference After Training

```bash
npx lw chat --load weights/latest
npx lw generate "The Lord is my shepherd" --load weights/latest
npx lw serve --port 3000
```

See `docs/USAGE.md` and `training/README.md` for more runtime details.

## Troubleshooting

- **Out of memory / slow**: Reduce `--batch-size`.
- **Poor samples after SFT/DPO**: The base pretrain may need more iters, or SFT data needs review.
- **Tokenizer mismatch**: Ensure you used the committed tokenizer logic.
- **No MPS acceleration**: Confirm `torch.backends.mps.is_available()`.

## Next Steps & Customization

- Expand `theological_triage_sft.jsonl` or create domain-specific SFT sets.
- Generate more DPO pairs targeting observed failure modes.
- Contribute improvements back to the project under the MIT license.

Run with grace and peace. This pipeline has been designed to produce a small but coherent, theologically reliable model suitable for Bible study tools and ministry applications.

**References**:
- `training/pretrain.py`, `sft.py`, `dpo.py`
- `training/common/*.py`
- `training/README.md` (quick start)
- `data/pretrain/`, `data/stf/`, `data/dpo/`
- `docs/USAGE.md` and `docs/CONCEPTS.md`

---

*Document added to support full replication of coherent model training. Update this guide as the pipeline or recommended hyperparameters evolve.*