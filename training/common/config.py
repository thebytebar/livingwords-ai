"""Canonical model configuration for LivingWords LLM.

Only `theoSmall` (~500k params) is supported.
pico and nano have been removed per project direction.
"""

from __future__ import annotations
from dataclasses import dataclass
from typing import Dict


@dataclass(frozen=True)
class ModelConfig:
    vocab_size: int
    n_embd: int
    n_head: int
    n_layer: int
    block_size: int
    dropout: float = 0.1


# The single supported configuration (theoSmall)
THEO_SMALL: ModelConfig = ModelConfig(
    vocab_size=1536,
    n_embd=96,
    n_head=6,
    n_layer=6,
    block_size=256,
    dropout=0.1,
)

# Named access (for CLI / scripts that want to do --model theoSmall in the future)
CONFIGS: Dict[str, ModelConfig] = {
    "theoSmall": THEO_SMALL,
    # "theoSmall" is the only entry. pico and nano are intentionally omitted.
}

DEFAULT_CONFIG_NAME = "theoSmall"
DEFAULT_CONFIG = THEO_SMALL


def get_config(name: str | None = None) -> ModelConfig:
    if name is None or name == DEFAULT_CONFIG_NAME:
        return DEFAULT_CONFIG
    if name not in CONFIGS:
        raise ValueError(f"Unknown config '{name}'. Only '{DEFAULT_CONFIG_NAME}' is supported.")
    return CONFIGS[name]


def config_to_dict(cfg: ModelConfig) -> Dict:
    return {
        "vocabSize": cfg.vocab_size,
        "nEmbd": cfg.n_embd,
        "nHead": cfg.n_head,
        "nLayer": cfg.n_layer,
        "blockSize": cfg.block_size,
        "dropout": cfg.dropout,
    }
