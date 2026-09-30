# Usage

LivingWords runs pretrained **Gemma 4 E2B Instruct** locally. RAG is optional: without an index, chat and ask answer from general model knowledge and explicitly label the answer as ungrounded; with an index, they retrieve and cite user-selected sources. The runtime does not load a default corpus or train/modify model weights; legacy sample corpora in the source checkout are not read or packaged.

## 1. Install and start the local model

On macOS Apple Silicon, `npm install` automatically:

1. Creates a Python virtual environment at `.livingwords/python`.
2. Installs pinned `mlx-vlm==0.7.4`.
3. Downloads the 4-bit Gemma 4 E2B Instruct model at a fixed Hugging Face revision into `.livingwords/models/gemma-4-e2b-it-4bit`.

The setup is idempotent: a matching manifest and model files skip repeated package installs and downloads. Hugging Face caches are redirected under `.livingwords/huggingface`, allowing interrupted downloads to resume. The exact Python dependency versions resolved on first setup are saved to `.livingwords/python-requirements.lock.txt`; model files use a fixed Hub commit. The setup uses network access and requires Python 3.10, 3.11, or 3.12; model-gated authentication is not needed for the pinned public MLX checkpoint. No weights are bundled or committed. `.livingwords/` is gitignored.

On non-Apple-Silicon platforms, `npm install` explicitly skips the MLX environment and model download. Use a local OpenAI-compatible endpoint by setting `LW_BASE_URL` to its `/v1` URL (and `LW_MODEL` if required); the app verifies that endpoint before each inference session and does not manage its process.

To skip the model setup intentionally on Apple Silicon, run `LW_SKIP_MODEL_INSTALL=1 npm install`. To rerun an interrupted setup, run `npm install` again. A Python prerequisite failure includes instructions to install a supported Python version. The managed MLX-VLM server starts at inference-app startup for `lw ask`, `lw chat`, `lw generate`, and `lw serve`; it listens on `127.0.0.1:8080`, reuses an already-running server only if `/v1/models` lists the expected Gemma model, and writes diagnostics to `.livingwords/logs/model-server.log`. A different service/model on that port is reported as a conflict.

The `lw serve` process stops a model server it started when it exits. One-shot commands and `lw chat` likewise clean up their managed process at exit. For the 8 GB profile, MLX-VLM is started with one concurrent sequence, a 4,096-token KV cache limit, and a 512-token output ceiling.

## 2. Index sources you provide

The ingestion command accepts a single `.txt` or `.md` file, or recursively scans a directory for those extensions. Hidden files/directories and other file types are skipped.

```bash
npm install
npm run build
npx lw ingest ./my-sources
```

The default index path is `.livingwords/index.json`. On a fresh install, you can start chatting without any corpus:

```bash
npx lw chat
```

The CLI and web app make clear that answers are ungrounded while no index exists. To enable RAG, index your own sources:

```bash
npx lw ingest ./my-sources
npx lw chat
```

An existing index enables retrieval and citations; when it exists but no relevant passage matches, the assistant still declines to answer from unsupported sources. The index stores chunks and relative source names, not embeddings. It can be rebuilt at any time or written elsewhere:

```bash
npx lw ingest ./my-sources --index ./local-index.json --chunk-size 1200 --overlap 180
npx lw chat --index ./local-index.json
```

Chunking uses word boundaries and approximately 1,200 characters per chunk with about 180 characters of overlap. These defaults produce compact evidence blocks while retaining nearby context.

## 3. Ask questions

```bash
npx lw ask "What do you know about forgiveness?"
npx lw ask "What do my sources say about hope?" --top-k 3 --max-tokens 256
npx lw chat
```

With no index, `ask` and `chat` provide a general-purpose answer labeled “No source corpus is indexed”; no citations or grounding are claimed. With an index, retrieval uses BM25 over normalized terms; it has no embedding model or extra model-memory cost. The default is at most four evidence passages (hard limit: eight) and 384 answer tokens; answer generation is capped at 512 tokens. If an index exists but no matching evidence is retrieved, the model is not called and the CLI states that the indexed sources do not support an answer. For a low lexical match, try a more specific query or index the relevant document.

Each prompt labels evidence `[S1]`, `[S2]`, etc. The model is instructed to cite source-supported claims using those IDs. Output removes references not present in the retrieved source list and always includes a footer mapping citation IDs to source file and chunk. Check cited passages directly; citations identify evidence supplied to the model and do not guarantee that every generated inference is entailed.

## HTTP API and web UI

```bash
npx lw serve --port 3000
```

Open `http://localhost:3000`. `POST /api/ask` accepts:

```json
{ "question": "What do these sources say about forgiveness?", "maxTokens": 384 }
```

It returns an `answer`, booleans `supported` and `grounded`, and a `sources` array containing source path and chunk number. When no index exists, the response is general-purpose with `grounded: false`, `supported: false`, and no sources. `GET /api/health` reports `ragAvailable` and indexed passage count. `POST /api/generate` remains as a compatibility alias. The server binds to `127.0.0.1`.

## General-purpose generation

For a non-theological prompt that does not require indexed evidence:

```bash
npx lw generate "Explain how a bicycle derailleur works."
```

This always calls the pretrained model directly and does not use RAG; its output is labeled as ungrounded.

## Memory guidance

- Use the 4-bit Gemma 4 E2B Instruct checkpoint with MLX-VLM on Apple Silicon.
- Keep MLX-VLM and the Node application as the only resident model/runtime processes.
- Retrieval defaults to four passages of approximately 1,200 characters each; reduce `--top-k` when working with a tight context budget.
- Generated output defaults to 384 tokens and is capped at 512.
- Indexing and retrieval are CPU/local text operations and do not load another neural model.

Actual memory use depends on the runtime version, model cache, and context configuration. If the runtime reports memory pressure, lower answer tokens and top-k; do not assume all 8 GB are available to the model.

## Scope and limitations

From-scratch training, SFT, DPO, LoRA, QLoRA, and weight finetuning are not supported. The supported theological adaptation mechanism is retrieval from source documents that you choose. No corpus, translation, or doctrine is asserted to be authoritative by this package.

BM25 is lexical rather than semantic; it can miss paraphrases or related passages without overlapping terms. Answers are generated text, not pastoral counsel or an authoritative interpretation. Review source material and model output.
