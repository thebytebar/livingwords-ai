"""
Simple dataset utilities for pre-training (next-token) and SFT.

Matches the random-crop batching style from the original TF.js dataset.
"""

from __future__ import annotations
from dataclasses import dataclass
from typing import List, Tuple

import torch

from .tokenizer import SmallTiktokenTokenizer, create_small_tiktoken_tokenizer


@dataclass
class Batch:
    x: torch.Tensor  # (B, T) int64
    y: torch.Tensor  # (B, T) int64


class TextDataset:
    """
    Holds encoded data + provides random contiguous blocks for LM training.
    90/10 train/val split (character-ish, but on token level).
    """

    def __init__(self, tokens: List[int], block_size: int, train_split: float = 0.9):
        self.tokens = torch.tensor(tokens, dtype=torch.long)
        self.block_size = block_size
        n = int(train_split * len(self.tokens))
        self.train_data = self.tokens[:n]
        self.val_data = self.tokens[n:]

    @property
    def size(self) -> int:
        return len(self.tokens)

    def get_batch(self, batch_size: int, split: str = "train") -> Batch:
        data = self.train_data if split == "train" else self.val_data
        max_start = len(data) - self.block_size - 1
        if max_start <= 0:
            # Very small corpus edge case: repeat pad
            max_start = max(0, len(data) - 1)
        ix = torch.randint(0, max(1, max_start), (batch_size,))
        x = torch.stack([data[i : i + self.block_size] for i in ix])
        y = torch.stack([data[i + 1 : i + 1 + self.block_size] for i in ix])
        return Batch(x=x, y=y)


def build_pretrain_dataset(
    text: str,
    tokenizer: SmallTiktokenTokenizer,
    block_size: int,
) -> TextDataset:
    # Normalize text: strip BOM and normalize line endings for clean tokenization
    text = text.lstrip("\ufeff").replace("\r\n", "\n").replace("\r", "\n")
    tokens = tokenizer.encode(text)
    # Guard: ensure we have enough tokens
    if len(tokens) < block_size + 2:
        # Duplicate to make it usable for tiny tests
        tokens = (tokens * ((block_size + 2) // max(1, len(tokens)) + 1))[: block_size + 100]
    return TextDataset(tokens, block_size=block_size)


# ------------------------------------------------------------------
# SFT helpers (used by sft.py). For now minimal; proper masking added in SFT script.
# ------------------------------------------------------------------
@dataclass
class SFTExample:
    text: str = ""
    prompt: str = ""
    completion: str = ""  # when present, enables proper loss masking in sft.py


def load_sft_examples(path: str) -> List[SFTExample]:
    import json
    from pathlib import Path

    def _load_jsonl_objects(txt: str):
        dec = json.JSONDecoder()
        objs = []
        for raw in txt.strip().splitlines():
            line = raw.strip()
            if not line:
                continue
            pos = 0
            while pos < len(line):
                while pos < len(line) and line[pos].isspace():
                    pos += 1
                if pos >= len(line):
                    break
                try:
                    obj, consumed = dec.raw_decode(line, pos)
                    objs.append(obj)
                    pos += consumed
                except json.JSONDecodeError:
                    break
        return objs

    p = Path(path)
    if not p.exists():
        # Fallback tiny synthetic for smoke tests
        return [
            SFTExample(text="Verse: In the beginning God created the heavens and the earth.\nExplanation: God is the creator of all things."),
            SFTExample(text="Verse: The Lord is my shepherd.\nExplanation: The Lord cares for and protects His people."),
        ]
    if str(p).endswith(".jsonl"):
        out = []
        for obj in _load_jsonl_objects(p.read_text(encoding="utf-8")):
            prompt = obj.get("prompt", "")
            completion = obj.get("completion", "")
            text = obj.get("text") or (prompt + " " + completion if prompt or completion else "")
            out.append(SFTExample(text=text, prompt=prompt, completion=completion))
        return out
    # plain text: one big example
    return [SFTExample(text=p.read_text(encoding="utf-8"))]
