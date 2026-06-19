#!/bin/bash
# Full Pre-training + SFT + DPO Pipeline for LivingWords LLM (theoSmall)
# Replicates the recommended commands from docs/TRAINING_GUIDE.md
# Usage: bash training/run_full_pipeline.sh   (from repo root)
# Or: npm run train:full

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "🚀 Starting full LivingWords LLM training pipeline..."
echo "Repo root: $REPO_ROOT"
echo "Training dir: $SCRIPT_DIR"

cd "$REPO_ROOT"

# Ensure venv exists and is activated (create if missing)
VENV_DIR="$SCRIPT_DIR/.venv"
if [ ! -d "$VENV_DIR" ]; then
  echo "📦 Creating Python virtualenv at $VENV_DIR..."
  python3 -m venv "$VENV_DIR"
fi

# Activate venv (works on macOS/Linux; adjust for Windows if needed)
# shellcheck disable=SC1091
source "$VENV_DIR/bin/activate"

echo "📦 Ensuring dependencies are installed..."
pip install -r "$SCRIPT_DIR/requirements.txt" --quiet

echo ""
echo "=== STEP 1: Pre-training (base model on Bible corpus) ==="
python "$SCRIPT_DIR/pretrain.py" \
  --data "$REPO_ROOT/data/pretrain_bible.txt" \
  --max-iters 5000 \
  --batch-size 32 \
  --lr 6e-4 \
  --eval-interval 200 \
  --save-interval 1000 \
  --seed 1337 \
  --device auto

echo ""
echo "=== STEP 2: SFT (theological triage alignment) ==="
python "$SCRIPT_DIR/sft.py" \
  --data "$REPO_ROOT/data/theological_triage_sft.jsonl" \
  --load "$REPO_ROOT/weights/latest" \
  --max-iters 800 \
  --batch-size 8 \
  --lr 3e-4 \
  --block-size 256 \
  --device auto

echo ""
echo "=== STEP 3: DPO (preference alignment) ==="
python "$SCRIPT_DIR/dpo.py" \
  --data "$REPO_ROOT/data/dpo_prefs.jsonl" \
  --load "$REPO_ROOT/weights/latest" \
  --max-iters 400 \
  --beta 0.1 \
  --lr 2e-4 \
  --batch-size 4 \
  --device auto

echo ""
echo "✅ Full pipeline complete!"
echo "Final model exported to: $REPO_ROOT/weights/latest/"
echo ""
echo "Test with:"
echo "  npx lw-llm chat --load weights/latest"
echo "  npx lw-llm generate \"Explain the Trinity\" --load weights/latest"
echo ""
echo "Run with grace and peace."