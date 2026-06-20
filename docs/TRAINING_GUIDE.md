# LivingWords LLM — Full Pre-Training and Post-Training Guide (SFT + DPO)

This guide provides a complete, reproducible step-by-step process for training the `theoSmall` model from scratch through pre-training on the Bible corpus, supervised fine-tuning (SFT), and Direct Preference Optimization (DPO). The goal is to produce a coherent, theologically aligned model that generates warm, scripture-flavored explanations, devotionals, and responses.

All training uses the Python/PyTorch pipeline in `training/`. The resulting `model.onnx` + `meta.json` artifacts are compatible with the TypeScript runtime (`npx lw chat`, `serve`, etc.).

**Target model**: `theoSmall` only (~990k parameters, 6 layers, 96 embd, 6 heads, block_size=256, ~1536 token vocab via pruned tiktoken cl100k_base).

**Hardware note**: Works well on CPU or Apple Silicon (MPS). Training a full pipeline takes minutes to a couple hours on a laptop.

## Prerequisites

1. Clone or be in the repo root: `/Users/joshuajohnson/Projects/livingwords-llm` (or your equivalent).

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

- **Pre-training**: `../data/pretrain_bible.txt` (concatenated public-domain translations: AKJV, ASV, DBT, ERV, KJV, WBT, WEB, YLT). ~36 MB of clean biblical text.
- **SFT**: `../data/theological_triage_sft.jsonl` (~1,200 high-quality examples covering Tier 1–4 theology, with `prompt` + `completion` fields + metadata for triage categories). Also supports legacy `text` field.
- **DPO preferences**: `../data/dpo_prefs.jsonl` (prompt + chosen + rejected pairs focused on theological tone, accuracy, and pastoral sensitivity).

You can also supply your own `.jsonl` files following the schemas shown in the script docstrings.

## Step 1: Pre-Training (Build the Base Language Model)

Pre-training teaches the model next-token prediction on raw Bible text. This establishes fluency in scripture language, vocabulary, and style.

**Recommended command for a coherent base model** (higher steps + tuned LR for better convergence than the quick-start example):

```bash
cd /Users/joshuajohnson/Projects/livingwords-llm/training
python pretrain.py \
  --data ../data/pretrain_bible.txt \
  --max-iters 5000 \
  --batch-size 32 \
  --lr 6e-4 \
  --eval-interval 200 \
  --save-interval 1000 \
  --seed 1337 \
  --device auto
```

**Key flags explained**:
- `--max-iters`: 3000–8000 recommended for solid base on this corpus size. 1500 is a quick smoke test.
- `--batch-size`: 16–64 (higher if memory allows; tiny model so even 32 is fast).
- `--lr`: 5e-4 to 8e-4 works well. Start at 6e-4.
- `--save-interval`: Checkpoints written to `training/checkpoints/checkpoint-XXXXX/` and always updated `weights/latest/`.
- Exports `model.onnx`, `meta.json`, `config.json`, `model.safetensors` (modern preferred), `kept_ids.json`.

**What to expect**:
- Loss decreases steadily; samples at eval intervals will start producing coherent biblical-sounding text.
- Total time: ~30–90 minutes on laptop depending on hardware and iters.
- Final artifacts land in `../weights/latest/` (ready for immediate use or loading into SFT/DPO).

**Optional**: Run with lower iters first for a baseline, then continue? (Pretrain does not support `--load`; restart with higher `--max-iters` if needed.)

After this step you have a functional base model. Test it:

```bash
cd ..
npx lw chat --load weights/latest
# or
npx lw generate "In the beginning God created"
```

## Step 2: Supervised Fine-Tuning (SFT) — Align to Instruction Following & Theology

SFT teaches the model to respond to prompts with high-quality completions. Uses proper loss masking (only completion tokens contribute to loss).

**Recommended command** (load the pre-trained checkpoint, use the full theological dataset, moderate iters to avoid overfitting the small model):

```bash
cd /Users/joshuajohnson/Projects/livingwords-llm/training
python sft.py \
  --data ../data/theological_triage_sft.jsonl \
  --load ../weights/latest \
  --max-iters 800 \
  --batch-size 8 \
  --lr 3e-4 \
  --block-size 256 \
  --device auto
```

**Notes**:
- `--load` points to a directory containing `model.pt` or `model.safetensors` (weights/latest or any checkpoint-XXXXX/).
- The theological triage dataset is specifically curated for this project (Tier 1 essentials emphasized, balanced Tier 2/3/4 responses, scripture references, pastoral tone).
- If using custom data, ensure JSONL lines contain at minimum `prompt` + `completion` (or legacy `text` with markers like "Explanation:").
- Loss masking ensures the model learns to generate the answer, not just repeat the prompt.
- Exports updated `model.onnx` etc. to `weights/latest/` at the end.

**Iterative tip for better coherency**: Run 2–3 rounds of SFT, each time loading the previous output. Or mix in additional curated verse→explanation pairs.

After SFT, test coherence:

```bash
npx lw chat --load weights/latest
# Try prompts like: "Explain the Trinity" or "What does it mean that God created the heavens and the earth?"
```

## Step 3: Direct Preference Optimization (DPO) — Preference Alignment

DPO further aligns the model by teaching it to prefer "chosen" (good theological/pastoral) responses over "rejected" ones. Reference-free formulation suitable for this tiny model.

**Recommended command**:

```bash
cd /Users/joshuajohnson/Projects/livingwords-llm/training
python dpo.py \
  --data ../data/dpo_prefs.jsonl \
  --load ../weights/latest \
  --max-iters 400 \
  --beta 0.1 \
  --lr 2e-4 \
  --batch-size 4 \
  --device auto
```

**Key flags**:
- `--beta`: 0.1 is the default; controls how strongly preferences are enforced (0.05–0.2 range).
- Lower LR than SFT to make gentle updates.
- Each step processes preference pairs; loss drives the policy to increase likelihood of chosen relative to rejected.

**For stronger alignment**: Curate or expand `dpo_prefs.jsonl` with more pairs emphasizing orthodoxy, warmth, scripture use, and avoidance of common failure modes (e.g., legalism, modernism, harshness). Run multiple DPO rounds if needed.

Final export again updates `weights/latest/`.

## Full End-to-End Pipeline (One-Shot Reproduction)

Run these commands in sequence (adjust paths if not in repo root):

```bash
# 1. Setup (once)
cd training
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# 2. Pre-train (coherent base)
python pretrain.py --data ../data/pretrain_bible.txt --max-iters 5000 --batch-size 32 --lr 6e-4 --eval-interval 200 --save-interval 1000 --seed 1337 --device auto

# 3. SFT (theological alignment)
python sft.py --data ../data/theological_triage_sft.jsonl --load ../weights/latest --max-iters 800 --batch-size 8 --lr 3e-4 --device auto

# 4. DPO (preference tuning)
python dpo.py --data ../data/dpo_prefs.jsonl --load ../weights/latest --max-iters 400 --beta 0.1 --lr 2e-4 --batch-size 4 --device auto

# 5. Verify
cd ..
npx lw chat --load weights/latest
```

**Expected outcome**: A model that produces fluent, biblically grounded, pastorally sensitive responses with good coherence within the 256-token context.

## Optimization Tips for Maximum Coherency

- **Data quality > quantity**: The provided theological SFT + DPO datasets are the key to "God-centered" behavior. Add more high-quality pairs focused on your target use cases.
- **Staged training**: Pretrain long enough for fluency → SFT for instruction following → DPO for tone/accuracy preferences. Avoid skipping stages.
- **Hyperparameter tuning**:
  - Pretrain: Higher iters + moderate LR.
  - SFT: Lower LR, loss-masking critical.
  - DPO: Small beta, very low LR, fewer iters.
- **Evaluation loop**: After each stage, run `npx lw chat` and manually score samples on coherence, theological accuracy, warmth, and scripture fidelity. Regenerate with different seeds/temperatures (runtime default ~0.7).
- **Checkpointing**: Use intermediate checkpoints if a stage overfits (rare on tiny model + good data).
- **Tokenizer & export**: Always let the scripts handle export. Never manually edit `kept_ids.json` unless regenerating the vocab.
- **Hybrid guardrails** (future): Pair the model with verse retrieval for safety on factual claims.
- **Monitoring**: Watch eval samples during pretrain and loss curves. If samples become repetitive, lower LR or add more diverse SFT data.
- **Reproducibility**: The `--seed 1337` + deterministic tokenizer pruning + fixed data files make runs highly reproducible.

## Inference After Training

The TS runtime automatically prefers `model.onnx` + `meta.json` when present:

```bash
npx lw chat --load weights/latest
npx lw generate "The Lord is my shepherd" --load weights/latest
npx lw serve --port 3000
```

See `docs/USAGE.md` and `training/README.md` for more runtime details.

## Troubleshooting

- **Out of memory / slow**: Reduce `--batch-size`.
- **Poor samples after SFT/DPO**: The base pretrain may need more iters, or SFT data needs review. Re-run from a fresh pretrain checkpoint.
- **Tokenizer mismatch**: Ensure you used the committed tokenizer logic; never change vocab_size without regenerating kept_ids.
- **No MPS acceleration**: Confirm `torch.backends.mps.is_available()`.
- **Export issues**: The `common/export.py` handles ONNX + safetensors; install `onnx` and `safetensors` if missing.

## Next Steps & Customization

- Expand `theological_triage_sft.jsonl` or create domain-specific SFT sets (e.g., prayer, counseling, apologetics).
- Generate more DPO pairs targeting observed failure modes.
- For very long contexts in future: increase `block_size` (requires full re-training and tokenizer updates).
- Contribute improvements back to the project under the MIT license.

Run with grace and peace. This pipeline has been designed to produce a small but coherent, theologically reliable model suitable for Bible study tools and ministry applications.

**References**:
- `training/pretrain.py`, `sft.py`, `dpo.py`
- `training/common/*.py`
- `training/README.md` (quick start)
- `data/theological_triage_sft.jsonl` and `dpo_prefs.jsonl` (schemas and examples)
- `docs/USAGE.md` and `docs/CONCEPTS.md`

---

*Document added to support full replication of coherent model training. Update this guide as the pipeline or recommended hyperparameters evolve.*