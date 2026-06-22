"""
Tiktoken-based small-vocab subword tokenizer with EXACT parity to the
TypeScript implementation in src/core/tokenizer.ts.

This is critical: the compact token IDs produced here must be identical
to those used when the JS runtime loads meta.json + subwordKeptIds,
otherwise the trained weights will be meaningless.

Logic (mirrors createSmallTiktokenTokenizer):
- Base: cl100k_base
- Reserve 0..3; compact IDs start at 4
- unk = 1
- If fixed_kept_orig_ids provided: use them (first N)
- Else: encode corpus, count freq, take top (target_vocab_size - 4) by frequency (stable desc)
- encode(text) -> list of compact ids (unk -> 1 for unseen)
- decode(ids) -> text via reverse map back to original tiktoken ids then tiktoken decode
- Also exposes .vocab_size and (for export) the list of kept *original* tiktoken ids
"""

from __future__ import annotations
import json
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import tiktoken


# Must stay in sync with JS
RESERVED = 4          # compact IDs 0-3 reserved/special (we start assigning at 4)
UNK_ID = 1
PAD_ID = 0            # conventional; not heavily used in this model


class SmallTiktokenTokenizer:
    def __init__(
        self,
        target_vocab_size: int = 1536,
        kept_orig_ids: Optional[List[int]] = None,
        corpus: str = "",
    ):
        self.target_vocab_size = target_vocab_size
        self.enc = tiktoken.get_encoding("cl100k_base")

        if kept_orig_ids is not None and len(kept_orig_ids) > 0:
            kept = kept_orig_ids[: target_vocab_size - RESERVED]
            self._kept_orig = kept
            self._from_corpus = False
        elif corpus:
            kept = self._select_top_tokens(corpus, target_vocab_size - RESERVED)
            self._kept_orig = kept
            self._from_corpus = True
        else:
            self._kept_orig = []
            self._from_corpus = False

        # orig tiktoken id -> compact id
        self._vocab_map: Dict[int, int] = {}
        compact = RESERVED
        for orig in self._kept_orig:
            self._vocab_map[orig] = compact
            compact += 1

        # compact id -> orig tiktoken id (for decode)
        self._reverse_map: Dict[int, int] = {c: o for o, c in self._vocab_map.items()}

        self.vocab_size = target_vocab_size  # always report the target (includes reserved + unk space)

    def _select_top_tokens(self, corpus: str, k: int) -> List[int]:
        if k <= 0:
            return []
        tokens = self.enc.encode(corpus)
        freq: Dict[int, int] = {}
        for t in tokens:
            freq[t] = freq.get(t, 0) + 1
        # Sort by frequency desc, then by token id asc for deterministic tie-break (matches common practice)
        sorted_tokens = sorted(freq.items(), key=lambda x: (-x[1], x[0]))
        return [tok for tok, _cnt in sorted_tokens[:k]]

    @property
    def kept_orig_ids(self) -> List[int]:
        """The original cl100k_base ids that were kept, in the order that defines compact IDs 4,5,..."""
        return list(self._kept_orig)

    def encode(self, text: str) -> List[int]:
        if not text:
            return []
        raw = self.enc.encode(text)
        return [self._vocab_map.get(t, UNK_ID) for t in raw]

    def decode(self, ids: List[int]) -> str:
        if not ids:
            return ""
        pieces: List[str] = []
        for i in ids:
            orig = self._reverse_map.get(i)
            if orig is None:
                pieces.append("\uFFFD")  # replacement to avoid "!" spam from fallback-0 (see JS parity)
                continue
            try:
                b = self.enc.decode([orig])  # type: ignore[arg-type]
                s = b.decode("utf-8", errors="replace") if isinstance(b, (bytes, bytearray)) else str(b)
                pieces.append(s)
            except Exception:
                pieces.append("\uFFFD")
        return "".join(pieces)

    def __repr__(self) -> str:
        return (
            f"SmallTiktokenTokenizer(target={self.target_vocab_size}, "
            f"kept={len(self._kept_orig)}, from_corpus={self._from_corpus})"
        )


def create_small_tiktoken_tokenizer(
    corpus: str = "",
    target_vocab_size: int = 1536,
    fixed_kept_orig_ids: Optional[List[int]] = None,
) -> SmallTiktokenTokenizer:
    """
    Create a tokenizer with identical behavior and token mapping to the JS version.
    Preferred usage in training: pass fixed_kept_orig_ids loaded from training/data/kept_ids.json
    so we never depend on re-scanning a huge corpus.
    """
    if fixed_kept_orig_ids is None:
        # Try to load the committed canonical kept list (guarantees parity with JS runtime).
        # We load json even if corpus is passed: fixed list takes precedence for exact parity.
        candidate = Path(__file__).resolve().parents[2] / "training" / "data" / "kept_ids.json"
        if candidate.exists():
            try:
                fixed_kept_orig_ids = load_kept_ids(candidate)
            except Exception:
                pass
        if fixed_kept_orig_ids is None or len(fixed_kept_orig_ids) == 0:
            # Fallback: derive from the standard pretrain corpus so default creation always works
            root = Path(__file__).resolve().parents[2]
            for rel in [
                "data/pretrain/pretrain_bible.txt",
                "training/data/pretrain/pretrain_bible.txt",
            ]:
                p = root / rel
                try:
                    if p.exists():
                        c = p.read_text(encoding="utf-8")
                        if len(c) > 1000:
                            corpus = c
                            break
                except Exception:
                    pass
    return SmallTiktokenTokenizer(
        target_vocab_size=target_vocab_size,
        kept_orig_ids=fixed_kept_orig_ids,
        corpus=corpus,
    )


def save_kept_ids(path: Path, kept: List[int]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"kept_orig_ids": kept, "note": "Original cl100k_base ids kept for compact vocab 4.."}, f, indent=2)


def load_kept_ids(path: Path) -> List[int]:
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    return data.get("kept_orig_ids", [])


# ------------------------------------------------------------------
# Convenience / verification entrypoint.
# The committed training/data/kept_ids.json (captured from the JS tokenizer run on the same corpus)
# guarantees identical token mappings. create_small_tiktoken_tokenizer() auto-loads it when available.
# ------------------------------------------------------------------
if __name__ == "__main__":
    root = Path(__file__).resolve().parents[2]
    tok = create_small_tiktoken_tokenizer(target_vocab_size=1536)  # auto-loads committed kept_ids.json

    print("Built tokenizer (auto-loaded committed kept list):", tok)
    print("Kept count:", len(tok.kept_orig_ids))
    print("First 8 kept orig ids:", tok.kept_orig_ids[:8])

    sample = "In the beginning God created the heavens and the earth. Trust in the Lord with all your heart."
    ids = tok.encode(sample)
    back = tok.decode(ids)
    print("Encode length:", len(ids))
    print("Roundtrip starts correctly:", back.startswith("In the beginning God created the heavens and the earth"))

    # Demonstrate loading the js capture explicitly (should be identical)
    js_path = root / "training" / "data" / "js_kept_ids.json"
    if js_path.exists():
        forced = load_kept_ids(js_path)
        tok2 = create_small_tiktoken_tokenizer(fixed_kept_orig_ids=forced)
        print("Forced-from-js kept count:", len(tok2.kept_orig_ids), "| identical to auto?", tok.kept_orig_ids == tok2.kept_orig_ids)
