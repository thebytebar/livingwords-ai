#!/usr/bin/env python3
"""
Pre-training script for LivingWords LLM (theoSmall only).

Replaces the old TF.js training loop.

Example:
  python pretrain.py --data ../data/pretrain_bible.txt --max-iters 1500 --batch-size 16 --lr 0.0008
"""

from __future__ import annotations
import argparse
import time
from pathlib import Path
import torch

# Make sure we can import sibling common/
import sys
sys.path.insert(0, str(Path(__file__).parent))

from common.config import get_config, DEFAULT_CONFIG, ModelConfig
from common.tokenizer import create_small_tiktoken_tokenizer
from common.dataset import build_pretrain_dataset
from common.model import GPT
from common.export import export_all


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Pre-train LivingWords theoSmall in PyTorch")
    p.add_argument("--data", type=str, default=str(Path(__file__).parent.parent / "data" / "pretrain_bible.txt"), help="Path to training text")
    p.add_argument("--max-iters", type=int, default=1500, help="Total optimization steps")
    p.add_argument("--batch-size", type=int, default=16)
    p.add_argument("--lr", "--learning-rate", dest="lr", type=float, default=0.0008)
    p.add_argument("--eval-interval", type=int, default=100, help="Print loss + sample every N steps")
    p.add_argument("--save-interval", type=int, default=400, help="Export checkpoint every N steps")
    p.add_argument("--block-size", type=int, default=None, help="Override (rare)")
    p.add_argument("--seed", type=int, default=1337)
    p.add_argument("--device", type=str, default="auto", help="cpu | cuda | mps | auto")
    return p.parse_args()


def get_device(name: str) -> torch.device:
    if name == "auto":
        if torch.cuda.is_available():
            return torch.device("cuda")
        if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            return torch.device("mps")
        return torch.device("cpu")
    return torch.device(name)


def main():
    args = parse_args()
    torch.manual_seed(args.seed)

    device = get_device(args.device)
    print(f"🚀 Pre-training LivingWords (theoSmall) on {device}")

    cfg: ModelConfig = get_config("theoSmall")
    if args.block_size:
        cfg = ModelConfig(**{**cfg.__dict__, "block_size": args.block_size})

    # Tokenizer (will auto-load the committed kept_ids.json for perfect parity with JS)
    tokenizer = create_small_tiktoken_tokenizer(target_vocab_size=cfg.vocab_size)

    # Data
    data_path = Path(args.data)
    if not data_path.exists():
        print(f"Data not found at {data_path}, using tiny synthetic Bible text for smoke test.")
        text = ("In the beginning God created the heavens and the earth. " * 50 +
                "The Lord is my shepherd; I shall not want. " * 30)
    else:
        text = data_path.read_text(encoding="utf-8")

    ds = build_pretrain_dataset(text, tokenizer, block_size=cfg.block_size)

    # Model
    model = GPT(cfg).to(device)
    optimizer = model.configure_optimizers(lr=args.lr, weight_decay=0.0)

    # Dirs
    root = Path(__file__).resolve().parents[1]  # project root (training/..)
    weights_dir = root / "weights"
    ckpt_dir = Path(__file__).parent / "checkpoints"
    latest_dir = weights_dir / "latest"

    start = time.time()
    for step in range(1, args.max_iters + 1):
        model.train()
        batch = ds.get_batch(args.batch_size, split="train")
        x = batch.x.to(device)
        y = batch.y.to(device)

        optimizer.zero_grad(set_to_none=True)
        logits, loss, _ = model(x, y)
        loss.backward()
        optimizer.step()

        if step % 10 == 0:
            elapsed = time.time() - start
            print(f"\r⏳ step {step}/{args.max_iters} | loss {loss.item():.4f} | {elapsed:.1f}s", end="", flush=True)

        if step % args.eval_interval == 0 or step == 1:
            print()  # newline after the \r
            print(f"Step {step} | loss: {loss.item():.4f}")

            # Sample generation (use the tokenizer for prompt <-> ids)
            model.eval()
            with torch.no_grad():
                prompt = "In the beginning"
                seed = tokenizer.encode(prompt)
                # Pad or crop to block like the old code did internally
                if len(seed) > cfg.block_size:
                    seed = seed[-cfg.block_size:]
                elif len(seed) < cfg.block_size:
                    seed = [0] * (cfg.block_size - len(seed)) + seed
                idx = torch.tensor([seed], dtype=torch.long, device=device)
                out = model.generate(idx, max_new_tokens=48, temperature=0.7, do_sample=True)
                generated = tokenizer.decode(out[0].tolist())
                # Show a clean slice (old behavior)
                display = generated.replace("\n", " ")[:160]
                if len(generated) > 160:
                    display += "..."
                print("Sample:", display)

        if step % args.save_interval == 0:
            print(f"\n💾 Saving checkpoint at step {step}...")
            ckpt_path = ckpt_dir / f"checkpoint-{step:05d}"
            ckpt_path.mkdir(parents=True, exist_ok=True)
            torch.save(model.state_dict(), ckpt_path / "model.pt")
            export_all(model, cfg, tokenizer, legacy_dir=ckpt_path, write_legacy_weights=False)
            # Also update latest (for convenience with existing CLI)
            export_all(model, cfg, tokenizer, legacy_dir=latest_dir, write_legacy_weights=False)

    total = time.time() - start
    print(f"\n✅ Pre-training complete. Total time: {total:.1f}s")

    # Final export to ../weights/ and latest (no legacy weights by default)
    export_all(model, cfg, tokenizer, legacy_dir=latest_dir, write_legacy_weights=False)
    export_all(model, cfg, tokenizer, legacy_dir=weights_dir, write_legacy_weights=False)

    print("Done. You can now run: npx lw chat   (or point --load at one of the checkpoint dirs)")


if __name__ == "__main__":
    main()
