"""
Export utilities.

1. Legacy format (weights.json + meta.json) — compatible with the current
   TypeScript LivingWordsLLM.load() / setWeights() so that a model trained
   in PyTorch can be used immediately by the existing CLI, chat, serve etc.

2. Modern: safetensors + config + ONNX (preferred for the upcoming inference
   backend migration away from TensorFlow.js).

The legacy export must reproduce:
- Exact layer names used by the TF.js model (wte, wpe, lnF, blockN-lnM, blockN-attn-cAttn, ... , lmHead)
- Correct number of arrays per layer and their shapes (after transpose for Linear kernels)
- Float values truncated similarly to the old truncateFloats (8 decimals)

ONNX export uses torch.onnx.export with dynamic axes so the same model can be
used for variable-length contexts (up to block_size) during autoregressive generation.
"""

from __future__ import annotations
import json
import math
from pathlib import Path
from typing import Any, Dict, List

import torch

from .config import ModelConfig, config_to_dict
from .tokenizer import SmallTiktokenTokenizer


def _to_list(t: torch.Tensor, truncate: int = 8) -> List[Any]:
    """Convert tensor to nested python lists (pure torch, no numpy required) with float truncation."""
    if t.dim() == 0:
        val = float(t.item())
        return round(val, truncate) if not val.is_integer() else int(val)
    lst = t.detach().cpu().float().tolist()
    def rec(a):
        if isinstance(a, (list, tuple)):
            return [rec(x) for x in a]
        if isinstance(a, float):
            if not math.isfinite(a):
                return a
            return round(a, truncate) if not float(a).is_integer() else float(int(a))
        return a
    return rec(lst)


def _transpose_linear_weight(w: torch.Tensor) -> torch.Tensor:
    """PT Linear.weight is [out_features, in_features] -> TF kernel [in, out]."""
    return w.detach().cpu().float().t().contiguous()


def export_to_legacy_dict(model: torch.nn.Module, config: ModelConfig, kept_orig_ids: List[int]) -> Dict[str, Any]:
    """
    Build the exact dict structure expected by src/core/utils.ts (withModelHelpers + setWeights).
    The order of keys does not matter for the loader (it looks up by name), but we try to follow
    a logical traversal.
    """
    weights: Dict[str, List[Any]] = {}
    cfg = config
    n_layer = cfg.n_layer

    # Top level
    # wte: Embedding weight (vocab+1, n_embd) -> len 1
    w = model.wte.weight
    weights["wte"] = [_to_list(w)]

    # wpe
    w = model.wpe.weight
    weights["wpe"] = [_to_list(w)]

    # lnF
    ln = model.ln_f
    weights["lnF"] = [_to_list(ln.weight), _to_list(ln.bias)]

    # lmHead (no bias)
    head = model.lm_head.weight
    # [vocab, n_embd] in PT -> transpose to [n_embd, vocab] for the TF kernel shape 96x1536
    weights["lmHead"] = [_to_list(_transpose_linear_weight(head))]

    # Blocks
    for i in range(n_layer):
        blk = model.h[i]
        prefix = f"block{i+1}"

        # ln1
        ln1 = blk.ln1
        weights[f"{prefix}-ln1"] = [_to_list(ln1.weight), _to_list(ln1.bias)]

        # attn
        attn = blk.attn
        # cAttn: bias=False → only kernel
        cattn_w = _transpose_linear_weight(attn.c_attn.weight)  # 96 x 288
        weights[f"{prefix}-attn-cAttn"] = [_to_list(cattn_w)]

        cproj_w = _transpose_linear_weight(attn.c_proj.weight)
        cproj_b = attn.c_proj.bias
        weights[f"{prefix}-attn-cProj"] = [_to_list(cproj_w), _to_list(cproj_b)]

        # (attnDrop and residDrop have no weights — they are not emitted)

        # ln2
        ln2 = blk.ln2
        weights[f"{prefix}-ln2"] = [_to_list(ln2.weight), _to_list(ln2.bias)]

        # mlp
        mlp = blk.mlp
        cfc_w = _transpose_linear_weight(mlp.c_fc.weight)   # 96 x 384
        cfc_b = mlp.c_fc.bias
        weights[f"{prefix}-mlp-cFc"] = [_to_list(cfc_w), _to_list(cfc_b)]

        cproj2_w = _transpose_linear_weight(mlp.c_proj.weight)  # 384 x 96
        cproj2_b = mlp.c_proj.bias
        weights[f"{prefix}-mlp-cProj"] = [_to_list(cproj2_w), _to_list(cproj2_b)]

        # mlp drop has none

    # Emit the no-weight layers as empty lists so the legacy loader does not spam
    # "Cannot find weights for layer ..." on every load (add, drop, *Drop layers).
    for drop_name in ("add", "drop"):
        if drop_name not in weights:
            weights[drop_name] = []
    for i in range(n_layer):
        p = f"block{i+1}"
        for d in ("attn-attnDrop", "attn-residDrop", "mlp-drop"):
            k = f"{p}-{d}"
            if k not in weights:
                weights[k] = []

    return weights


def save_legacy_checkpoint(
    model: torch.nn.Module,
    config: ModelConfig,
    tokenizer: SmallTiktokenTokenizer,
    out_dir: Path,
    *,
    truncate: int = 8,
) -> None:
    """Write weights.json + meta.json exactly as the TS side expects."""
    out_dir.mkdir(parents=True, exist_ok=True)

    legacy = export_to_legacy_dict(model, config, tokenizer.kept_orig_ids)

    # Write compact (the old code used spaces:0 for weights.json)
    with open(out_dir / "weights.json", "w", encoding="utf-8") as f:
        json.dump(legacy, f, separators=(",", ":"))  # no whitespace like the original

    meta = {
        "vocabulary": [],  # subword path does not use the char vocab
        "vocabSize": config.vocab_size,
        "blockSize": config.block_size,
        "nEmbd": config.n_embd,
        "nHead": config.n_head,
        "nLayer": config.n_layer,
        "useSubword": True,
        "subwordKeptIds": tokenizer.kept_orig_ids,
        "savedAt": __import__("datetime").datetime.utcnow().isoformat() + "Z",
    }
    with open(out_dir / "meta.json", "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)

    # Also drop a small config + kept for modern consumers
    with open(out_dir / "config.json", "w", encoding="utf-8") as f:
        json.dump(config_to_dict(config), f, indent=2)
    with open(out_dir / "kept_ids.json", "w", encoding="utf-8") as f:
        json.dump({"kept_orig_ids": tokenizer.kept_orig_ids}, f, indent=2)

    print(f"💾 Legacy checkpoint written to {out_dir} (weights.json + meta.json)")


def save_safetensors(model: torch.nn.Module, path: Path) -> None:
    """Modern single-file weights (recommended for future use)."""
    try:
        from safetensors.torch import save_file
    except ImportError:
        # Fallback to torch.save
        torch.save(model.state_dict(), path.with_suffix(".pt"))
        print(f"⚠️  safetensors not installed — saved PyTorch state_dict to {path.with_suffix('.pt')}")
        return
    save_file(model.state_dict(), str(path))
    print(f"💾 Saved safetensors to {path}")


def export_to_onnx(model: torch.nn.Module, config: ModelConfig, onnx_path: Path, use_cache: bool = False) -> bool:
    """
    Export the GPT model to ONNX for use with onnxruntime (Node, browser, etc.).

    Uses dynamic axes so generation can feed contexts of varying length (1..block_size).
    The exported model takes int64 input_ids [batch, seq] and produces logits [batch, seq, vocab].

    If use_cache=True, the model is traced with cache support (past_key_values).
    Callers (e.g. training scripts for inference-optimized export) should pass a model
    instance that was run with use_cache=True at least once for tracing.
    """
    try:
        import torch.onnx  # noqa: F401
    except Exception as e:
        print(f"⚠️  ONNX export skipped (torch.onnx not available): {e}")
        return False

    model.eval()
    orig_device = next(model.parameters()).device
    model_cpu = model.to("cpu")  # ONNX export must be done on CPU

    onnx_path.parent.mkdir(parents=True, exist_ok=True)

    dummy_input = torch.zeros(1, config.block_size, dtype=torch.long, device="cpu")

    input_names = ["input_ids"]
    output_names = ["logits"]
    dynamic_axes = {
        "input_ids": {0: "batch", 1: "sequence"},
        "logits": {0: "batch", 1: "sequence"},
    }

    # The model now always returns (logits, loss, presents_list) as a 3-tuple.
    # For cache-aware export we pass past tensors + register many output names; the list
    # elements become the present_* outputs.
    # For plain export we wrap so only "logits" is returned from the traced root callable.
    if use_cache:
        n_head = config.n_head
        head_size = config.n_embd // n_head
        past_len = 0  # start with empty past for initial export; dynamic allows growth
        example_past = []
        for layer_idx in range(config.n_layer):
            k_name = f"past_key_{layer_idx}"
            v_name = f"past_value_{layer_idx}"
            input_names.extend([k_name, v_name])
            dynamic_axes[k_name] = {0: "batch", 2: "past_sequence"}
            dynamic_axes[v_name] = {0: "batch", 2: "past_sequence"}
            k = torch.zeros(1, n_head, past_len, head_size, dtype=torch.float32)
            v = torch.zeros(1, n_head, past_len, head_size, dtype=torch.float32)
            example_past.append((k, v))

        dummy_args = (dummy_input, None, example_past, True)
        # Add output names for presents (the new past)
        for layer_idx in range(config.n_layer):
            output_names.extend([f"present_key_{layer_idx}", f"present_value_{layer_idx}"])
            pk_name = f"present_key_{layer_idx}"
            pv_name = f"present_value_{layer_idx}"
            dynamic_axes[pk_name] = {0: "batch", 2: "past_sequence"}
            dynamic_axes[pv_name] = {0: "batch", 2: "past_sequence"}

        to_export = model_cpu
    else:
        # Wrap so traced forward returns exactly one tensor -> matches output_names length.
        class _LogitsOnly(torch.nn.Module):
            def __init__(self, base: torch.nn.Module):
                super().__init__()
                self.base = base
            def forward(self, idx, targets=None, past_key_values=None, use_cache=False):
                logits, _loss, _pres = self.base(idx, targets, past_key_values, False)
                return logits
        to_export = _LogitsOnly(model_cpu)
        dummy_args = (dummy_input,)

    try:
        torch.onnx.export(
            to_export,
            dummy_args,
            str(onnx_path),
            input_names=input_names,
            output_names=output_names,
            dynamic_axes=dynamic_axes,
            opset_version=17,
            do_constant_folding=True,
            export_params=True,
        )
        print(f"💾 Exported ONNX model to {onnx_path} (use_cache={use_cache})")
        model.to(orig_device)
        return True
    except Exception as e:
        print(f"⚠️  ONNX export failed: {e}")
        model.to(orig_device)
        return False


# Convenience: export everything the training scripts usually want
def export_all(
    model: torch.nn.Module,
    config: ModelConfig,
    tokenizer: SmallTiktokenTokenizer,
    legacy_dir: Path,
    modern_dir: Path | None = None,
    *,
    also_onnx: bool = True,
    write_legacy_weights: bool = False,  # Default False: no need for TS runtime anymore
) -> None:
    if write_legacy_weights:
        save_legacy_checkpoint(model, config, tokenizer, legacy_dir)
    else:
        # Still write meta + onnx for the modern path
        legacy_dir.mkdir(parents=True, exist_ok=True)
        with open(legacy_dir / "meta.json", "w", encoding="utf-8") as f:
            json.dump({
                "vocabulary": [],
                "vocabSize": config.vocab_size,
                "blockSize": config.block_size,
                "nEmbd": config.n_embd,
                "nHead": config.n_head,
                "nLayer": config.n_layer,
                "useSubword": True,
                "subwordKeptIds": tokenizer.kept_orig_ids,
                "savedAt": __import__("datetime").datetime.utcnow().isoformat() + "Z",
            }, f, indent=2)
        with open(legacy_dir / "config.json", "w") as f:
            json.dump(config_to_dict(config), f, indent=2)

    if modern_dir is not None:
        modern_dir.mkdir(parents=True, exist_ok=True)
        save_safetensors(model, modern_dir / "model.safetensors")
        with open(modern_dir / "config.json", "w") as f:
            json.dump(config_to_dict(config), f, indent=2)

    if also_onnx:
        target = legacy_dir / "model.onnx"
        export_to_onnx(model, config, target, use_cache=True)  # cache-aware for efficient generation
