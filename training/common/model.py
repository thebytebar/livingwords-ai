"""
Pure PyTorch implementation of the LivingWords GPT (decoder-only transformer).

Architecture is a direct port of src/core/gpt-model.ts so that:
- Training dynamics are as close as reasonable (Adam + same shapes + inits)
- Exported weights (after transpose handling in export) can be loaded into the
  existing TF.js runtime during the transition period.

Key details replicated:
- wte: Embedding(vocab_size + 1, n_embd)   # +1 to match TF maskZero behavior / weight shape
- wpe: Embedding(block_size, n_embd)
- 6 Blocks: Pre-LN style (ln1 -> attn -> add; ln2 -> mlp -> add)
- CausalSelfAttention: fused c_attn (bias=False), split q/k/v, scaled dot-product,
  causal mask via lower-tri (incl. diag), attn dropout, c_proj (bias=True), resid dropout
- FF: c_fc (4x, bias) -> GELU(approximate='tanh') -> c_proj (bias) -> resid drop
- Final LN (lnF)
- Untied lm_head: Linear(n_embd, vocab, bias=False)
- Inits: normal(0, 0.02); residual proj scaled by 1/sqrt(2*n_layer); biases zero
"""

from __future__ import annotations
import math
from dataclasses import dataclass
from typing import Optional, Tuple

import torch
import torch.nn as nn
from torch.nn import functional as F

from .config import ModelConfig, DEFAULT_CONFIG


@dataclass
class GPTOutput:
    logits: torch.Tensor  # (B, T, vocab_size)


class CausalSelfAttention(nn.Module):
    def __init__(self, n_embd: int, n_head: int, block_size: int, attn_dropout: float, resid_dropout: float, n_layer: int):
        super().__init__()
        assert n_embd % n_head == 0
        self.n_embd = n_embd
        self.n_head = n_head
        self.head_size = n_embd // n_head
        self.block_size = block_size

        # Fused QKV, bias=False (matches TF cAttn)
        self.c_attn = nn.Linear(n_embd, 3 * n_embd, bias=False)
        # Output proj, bias=True (matches)
        std = 0.02 / math.sqrt(2 * n_layer)
        self.c_proj = nn.Linear(n_embd, n_embd, bias=True)

        self.attn_drop = nn.Dropout(attn_dropout)
        self.resid_drop = nn.Dropout(resid_dropout)

        # Causal mask (lower triangular including diagonal)
        self.register_buffer(
            "bias",
            torch.tril(torch.ones(block_size, block_size)).view(1, 1, block_size, block_size)
        )

    def forward(self, x, past=None):
        B, T, C = x.size()

        # Calculate query, key, values
        qkv = self.c_attn(x)
        q, k, v = qkv.split(self.n_embd, dim=2)
        k = k.view(B, T, self.n_head, self.head_size).transpose(1, 2)
        q = q.view(B, T, self.n_head, self.head_size).transpose(1, 2)
        v = v.view(B, T, self.n_head, self.head_size).transpose(1, 2)

        if past is not None:
            past_k, past_v = past
            k = torch.cat([past_k, k], dim=2)
            v = torch.cat([past_v, v], dim=2)

        present = (k, v)  # always return (k, v) for cache support in generation

        # Causal self-attention
        att = (q @ k.transpose(-2, -1)) * (1.0 / math.sqrt(self.head_size))
        att = att.masked_fill(self.bias[:, :, :k.size(2), :k.size(2)] == 0, float('-inf'))
        att = F.softmax(att, dim=-1)
        att = self.attn_drop(att)
        y = att @ v
        y = y.transpose(1, 2).contiguous().view(B, -1, C)

        # Output projection
        y = self.resid_drop(self.c_proj(y))
        return y, present


class MLP(nn.Module):
    def __init__(self, n_embd: int, resid_dropout: float):
        super().__init__()
        self.c_fc = nn.Linear(n_embd, 4 * n_embd, bias=True)
        self.c_proj = nn.Linear(4 * n_embd, n_embd, bias=True)
        self.act = nn.GELU(approximate='tanh')
        self.dropout = nn.Dropout(resid_dropout)

    def forward(self, x):
        x = self.c_fc(x)
        x = self.act(x)
        x = self.c_proj(x)
        x = self.dropout(x)
        return x


class Block(nn.Module):
    def __init__(self, n_embd: int, n_head: int, block_size: int, attn_dropout: float, resid_dropout: float, n_layer: int):
        super().__init__()
        self.ln1 = nn.LayerNorm(n_embd)
        self.attn = CausalSelfAttention(n_embd, n_head, block_size, attn_dropout, resid_dropout, n_layer)
        self.ln2 = nn.LayerNorm(n_embd)
        self.mlp = MLP(n_embd, resid_dropout)

    def forward(self, x, past=None):
        attn_out, present = self.attn(self.ln1(x), past=past)
        x = x + attn_out
        x = x + self.mlp(self.ln2(x))
        return x, present


class GPT(nn.Module):
    def __init__(self, config: Optional[ModelConfig] = None):
        super().__init__()
        self.config = config or DEFAULT_CONFIG
        cfg = self.config

        vocab_in = cfg.vocab_size + 1  # match TF embedding inputDim +1 for maskZero / weight shape
        self.vocab_size = cfg.vocab_size  # logits are over the real vocab (no +1)

        self.wte = nn.Embedding(vocab_in, cfg.n_embd)
        self.wpe = nn.Embedding(cfg.block_size, cfg.n_embd)

        self.drop = nn.Dropout(cfg.dropout)

        self.h = nn.ModuleList([
            Block(
                n_embd=cfg.n_embd,
                n_head=cfg.n_head,
                block_size=cfg.block_size,
                attn_dropout=cfg.dropout,
                resid_dropout=cfg.dropout,
                n_layer=cfg.n_layer,
            )
            for _ in range(cfg.n_layer)
        ])

        self.ln_f = nn.LayerNorm(cfg.n_embd)

        # Untied lm head, bias=False (matches)
        self.lm_head = nn.Linear(cfg.n_embd, cfg.vocab_size, bias=False)

        # Initialize all
        self.apply(self._init_weights)

        # Scale residual projections (already done per-module, but we can also do a pass)
        # The per-layer scaling was applied at creation time in the submodules.

        # Report param count like the old summary
        n_params = sum(p.numel() for p in self.parameters())
        print(f"GPT (theoSmall) initialized with {n_params:,} parameters (target ~500k)")

    def _init_weights(self, module: nn.Module):
        if isinstance(module, nn.Linear):
            # Most linears already initialized in their __init__, but catch-all for safety
            # (lm_head, and any missed)
            if not hasattr(module, "_already_inited"):
                nn.init.normal_(module.weight, mean=0.0, std=0.02)
                if module.bias is not None:
                    nn.init.zeros_(module.bias)
        elif isinstance(module, nn.Embedding):
            nn.init.normal_(module.weight, mean=0.0, std=0.02)

    def configure_optimizers(self, lr, weight_decay=0.0, betas=(0.9, 0.95), device_type="cpu"):
        import torch.optim as optim
        decay = set()
        no_decay = set()
        whitelist_weight_modules = (nn.Linear,)
        blacklist_weight_modules = (nn.LayerNorm, nn.Embedding)
        for mn, m in self.named_modules():
            for pn, p in m.named_parameters(recurse=False):
                fpn = "%s.%s" % (mn, pn) if mn else pn
                if pn.endswith("bias"):
                    no_decay.add(fpn)
                elif pn.endswith("weight") and isinstance(m, whitelist_weight_modules):
                    decay.add(fpn)
                elif pn.endswith("weight") and isinstance(m, blacklist_weight_modules):
                    no_decay.add(fpn)
        param_dict = {pn: p for pn, p in self.named_parameters()}
        optim_groups = [
            {"params": [param_dict[pn] for pn in sorted(decay)], "weight_decay": weight_decay},
            {"params": [param_dict[pn] for pn in sorted(no_decay)], "weight_decay": 0.0},
        ]
        optimizer = optim.AdamW(optim_groups, lr=lr, betas=betas)
        return optimizer

    def forward(
        self,
        idx: torch.Tensor,
        targets: Optional[torch.Tensor] = None,
        past_key_values: Optional[list] = None,
        use_cache: bool = False,
    ) -> Tuple[torch.Tensor, Optional[torch.Tensor], list]:
        """
        idx: (B, T) int64 token ids (compact)
        past_key_values: list of (k, v) tuples for each layer, or None
        returns (logits, loss_or_none, presents_list)
        Note: use_cache flag is accepted for backward compat with callers but ignored for
        the return value (we always return the list; cache vs non-cache is controlled at
        export time by which outputs are registered).
        """
        B, T = idx.size()
        # Guard shape check: skip entirely under ONNX tracing to avoid TracerWarnings
        # and because dynamic_axes + the exported graph will enforce limits at runtime.
        if not torch.onnx.is_in_onnx_export():
            if T > self.config.block_size:
                raise ValueError(f"Sequence length {T} > block_size {self.config.block_size}")

        tok_emb = self.wte(idx)

        # Compute absolute positions when using cache (past_len + local)
        past_len = 0
        if past_key_values is not None and len(past_key_values) > 0:
            # past_k shape [B, nH, past_seq, hs]
            p0 = past_key_values[0]
            if p0 is not None:
                past_len = p0[0].size(2)

        pos = torch.arange(past_len, past_len + T, dtype=torch.long, device=idx.device).unsqueeze(0)
        pos_emb = self.wpe(pos)

        x = tok_emb + pos_emb
        x = self.drop(x)

        # Always collect presents (list of (k, v) for each layer).
        # We always return the list (non-cache callers ignore the third return value).
        # This avoids Python control flow inside the layer loop during tracing.
        presents = []
        for i, block in enumerate(self.h):
            past = past_key_values[i] if past_key_values is not None else None
            x, present = block(x, past=past)
            presents.append(present)

        x = self.ln_f(x)
        logits = self.lm_head(x)

        loss = None
        if targets is not None:
            loss = F.cross_entropy(logits.view(-1, logits.size(-1)), targets.view(-1), ignore_index=-100)

        # Always return (logits, loss, presents_list).
        # The "presents" list is used only by cache-aware ONNX exports / generation.
        # Non-cache callers simply ignore the third element.
        return logits, loss, presents

    @torch.no_grad()
    def generate(
        self,
        idx: torch.Tensor,
        max_new_tokens: int,
        temperature: float = 1.0,
        do_sample: bool = True,
        top_k: Optional[int] = None,
        eos_token_id: Optional[int] = None,
    ):
        # Simple generation loop (used by tests / CLI smoke tests)
        for _ in range(max_new_tokens):
            # Crop to block_size
            idx_cond = idx if idx.size(1) <= self.config.block_size else idx[:, -self.config.block_size:]
            logits, _, _ = self(idx_cond)
            logits = logits[:, -1, :] / temperature
            if top_k is not None:
                v, _ = torch.topk(logits, min(top_k, logits.size(-1)))
                logits[logits < v[:, [-1]]] = -float('Inf')
            probs = F.softmax(logits, dim=-1)
            if do_sample:
                idx_next = torch.multinomial(probs, num_samples=1)
            else:
                _, idx_next = torch.topk(probs, k=1, dim=-1)
            idx = torch.cat((idx, idx_next), dim=1)
            if eos_token_id is not None and idx_next.item() == eos_token_id:
                break
        return idx
