#!/usr/bin/env python3
"""
Supervised Fine-Tuning (SFT) for LivingWords.

Key improvement: real loss masking.
Only the completion / "answer" portion contributes to the loss.
Prompt (instruction / verse) tokens are masked with -100.

Recommended data formats (in .jsonl):
  {"prompt": "Verse: In the beginning God created the heavens and the earth.", "completion": " God is the creator of all things. He spoke the universe into being."}
  or the legacy combined:
  {"text": "Verse: ... \nExplanation: ..."}

The script will try to split on common markers if only "text" is provided.
"""

from __future__ import annotations
import argparse
import json
import time
from pathlib import Path
import torch

import sys
sys.path.insert(0, str(Path(__file__).parent))

from common.config import get_config
from common.tokenizer import create_small_tiktoken_tokenizer
from common.model import GPT
from common.dataset import load_sft_examples
from common.export import export_all


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--data", type=str, default="data/sft_sample.jsonl")
    p.add_argument("--max-iters", type=int, default=500)
    p.add_argument("--batch-size", type=int, default=4)
    p.add_argument("--lr", type=float, default=5e-4)
    p.add_argument("--block-size", type=int, default=256)
    p.add_argument("--device", default="auto")
    p.add_argument("--load", type=str, default=None, help="Directory containing model.pt (or model.safetensors) from pre-training")
    return p.parse_args()


def get_device(n): 
    if n == "auto":
        if torch.cuda.is_available(): return torch.device("cuda")
        if hasattr(torch.backends, "mps") and torch.backends.mps.is_available(): return torch.device("mps")
        return torch.device("cpu")
    return torch.device(n)


def main():
    args = parse_args()
    device = get_device(args.device)
    cfg = get_config("theoSmall")
    tok = create_small_tiktoken_tokenizer(target_vocab_size=cfg.vocab_size)

    examples = load_sft_examples(args.data)
    print(f"Loaded {len(examples)} SFT examples.")

    # Build list of (input_tokens, labels) where labels has -100 for prompt portion.
    training_pairs = []
    for ex in examples:
        text = ex.text or ""
        if hasattr(ex, "prompt") and hasattr(ex, "completion") and ex.prompt and ex.completion:
            prompt = ex.prompt
            completion = ex.completion
        else:
            # Heuristic split for legacy "text" format
            lower = text.lower()
            for marker in ["\nexplanation:", "\nanswer:", "explanation:", "answer:"]:
                if marker in lower:
                    idx = lower.find(marker)
                    prompt = text[:idx + len(marker)]
                    completion = text[idx + len(marker):]
                    break
            else:
                # Fallback: last sentence-ish as completion
                parts = text.rsplit(". ", 1)
                if len(parts) > 1:
                    prompt = parts[0] + ". "
                    completion = parts[1]
                else:
                    prompt = ""
                    completion = text

        p_ids = tok.encode(prompt)
        c_ids = tok.encode(completion)
        if not c_ids:
            continue
        full = p_ids + c_ids
        labels = [-100] * len(p_ids) + c_ids
        # Truncate or pad to block_size (left pad with 0 for positions, but labels stay -100 for pads if any)
        if len(full) > cfg.block_size:
            full = full[-cfg.block_size:]
            labels = labels[-cfg.block_size:]
        else:
            pad_len = cfg.block_size - len(full)
            full = [0] * pad_len + full
            labels = [-100] * pad_len + labels
        training_pairs.append((full, labels))

    if not training_pairs:
        print("No usable SFT pairs after processing. Using fallback synthetic.")
        # small fallback
        p = tok.encode("Verse: In the beginning God created the heavens and the earth.\n")
        c = tok.encode("God made all things by His word.")
        full = (p + c)[:cfg.block_size]
        labels = ([-100] * len(p) + c)[:cfg.block_size]
        training_pairs = [(full, labels)]

    model = GPT(cfg).to(device)

    if args.load:
        ckpt = Path(args.load)
        pt_path = ckpt / "model.pt"
        safetensors_path = ckpt / "model.safetensors"
        if pt_path.exists():
            model.load_state_dict(torch.load(pt_path, map_location=device))
            print(f"Loaded pre-trained weights from {pt_path}")
        elif safetensors_path.exists():
            try:
                from safetensors.torch import load_file
                model.load_state_dict(load_file(str(safetensors_path)))
                print(f"Loaded pre-trained weights from {safetensors_path}")
            except ImportError:
                print("safetensors not installed; skipping load")
        else:
            print(f"No model.pt or model.safetensors found in {ckpt}")

    opt = model.configure_optimizers(lr=args.lr)

    root = Path(__file__).resolve().parents[1]
    latest = root / "weights" / "latest"

    for step in range(1, args.max_iters + 1):
        model.train()
        # Sample a batch of examples
        batch_x = []
        batch_y = []
        for _ in range(args.batch_size):
            full, labels = training_pairs[torch.randint(0, len(training_pairs), (1,)).item()]
            batch_x.append(full)
            batch_y.append(labels)
        x = torch.tensor(batch_x, dtype=torch.long, device=device)
        y = torch.tensor(batch_y, dtype=torch.long, device=device)

        opt.zero_grad(set_to_none=True)
        logits, loss, _ = model(x, y)
        loss.backward()
        opt.step()

        if step % 50 == 0 or step == 1:
            print(f"SFT step {step}/{args.max_iters} | loss {loss.item():.4f}")

    print("✅ SFT complete (with loss masking on completions).")
    export_all(model, cfg, tok, legacy_dir=latest, write_legacy_weights=False)
    print("Exported to weights/latest (usable with lw chat)")


if __name__ == "__main__":
    main()
