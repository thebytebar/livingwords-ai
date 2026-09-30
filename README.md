# LivingWords LLM

LivingWords is a local-first retrieval-augmented assistant. **Gemma 4 E2B Instruct** is the pretrained general-purpose model; theological knowledge is supplied only through user-selected, indexed sources. The project does not train or fine-tune model weights.

## Design

- **Target device:** Apple M1 with 8 GB unified memory.
- **Inference:** MLX-VLM on Apple Silicon, using a pinned 4-bit Gemma 4 E2B Instruct checkpoint and a local OpenAI-compatible server.
- **Knowledge:** Optionally, local `.txt` and `.md` files selected by you and ingested into a compact BM25 index. The runtime does not load or select a default theology corpus.
- **Grounding:** When an index exists, answers cite retrieved passages and report when the sources do not support a response. Without an index, chat and ask still work as general-purpose AI and explicitly label answers as ungrounded.
- **Memory defaults:** 1,200-character chunks, 180-character approximate overlap, at most four retrieved passages, and at most 384 generated tokens (hard limit 512).

BM25 is intentionally used instead of loading a second embedding model. It is local, deterministic, and inexpensive in memory; it may miss semantically related passages that share few words, so refine queries or provide focused source documents when needed.

## Quick start

Install Node.js 18–22 dependencies:

```bash
npm install
npm run build
```

On macOS Apple Silicon, `npm install` creates `.livingwords/python`, installs pinned `mlx-vlm==0.7.4`, and downloads the pinned 4-bit model snapshot into `.livingwords/models/`. The multi-gigabyte setup is idempotent and Hugging Face downloads resume if interrupted. No weights are committed or included in the npm package. First use of `lw chat`, `lw ask`, `lw generate`, or `lw serve` starts the project-local `mlx_vlm.server` when needed; a compatible server already using port 8080 is reused.

On other platforms, npm dependencies install normally and the MLX setup is explicitly skipped. Use a local OpenAI-compatible server and set `LW_BASE_URL` to its `/v1` URL; the application does not start MLX on unsupported platforms. Apple Silicon requires Python 3.10+ and network access to install MLX-VLM and the model. If you intentionally want JS-only setup, use `LW_SKIP_MODEL_INSTALL=1 npm install`.

The managed server binds only to `127.0.0.1:8080`; logs are written to `.livingwords/logs/model-server.log`. A conflicting model on that port produces an actionable error rather than being silently reused. `LW_BASE_URL` can select another local OpenAI-compatible endpoint. `.livingwords/` is gitignored.

In another terminal, start chatting immediately without preparing a corpus:

```bash
npx lw chat
```

Answers are clearly labeled as ungrounded until you add a source index. To enable retrieval and citations, index your own source documents:

```bash
npx lw ingest ./my-sources
npx lw ask "What do these sources say about forgiveness?"
npx lw chat
npx lw serve --port 3000
```

The index is written to `.livingwords/index.json` by default. `.livingwords/` is git-ignored. Only `.txt` and `.md` files are ingested; documents remain on disk and are not uploaded. To use a different index path, pass `--index`.

`npx lw ask "..."` and `npx lw chat` use general pretrained knowledge and visibly label the response when no index exists; with an index, they use retrieval and citations. `npx lw generate "..."` always sends a general-purpose prompt without RAG and labels that output as ungrounded.

## Commands

| Command | Purpose |
|---|---|
| `lw ingest <path>` | Build a local BM25 index from a file or directory |
| `lw ask <question>` | General answer without an index; source-grounded answer when an index exists |
| `lw chat` | Interactive chat, source-grounded when an index exists |
| `lw serve` | Local web chat and HTTP API; reports whether an index is active |
| `lw generate <prompt>` | General-purpose local Gemma generation without RAG |

The API request accepts `{ "question": "..." }`; it returns `{ "answer", "supported", "grounded", "sources" }`. With no index, it returns a general answer with `grounded: false`, `supported: false`, and no sources. `/api/health` exposes `ragAvailable`. `/api/generate` remains as a compatibility alias and follows the same optional-RAG behavior.

## Training and adaptation scope

From-scratch training, SFT, DPO, LoRA, QLoRA, and all weight-finetuning workflows are out of scope. Their scripts and helpers have been removed; no such workflow is exposed by the supported CLI, runtime, or package. RAG over explicitly supplied sources is the only theological knowledge/adaptation mechanism. Earlier sample corpora and ONNX weights remain in the source checkout as unreferenced historical artifacts; they are neither loaded nor included in the npm package.

## Documentation

- [Usage guide](docs/USAGE.md)
- [Architecture and limitations](docs/CONCEPTS.md)

## License

MIT
