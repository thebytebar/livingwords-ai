# Architecture and concepts

LivingWords separates general language ability from theological knowledge:

- **General-purpose language model:** pretrained Gemma 4 E2B Instruct, served locally. The supported target for Apple Silicon is MLX-VLM with a 4-bit checkpoint.
- **Theological context:** user-provided `.txt` and `.md` documents, split into overlapping chunks and indexed locally.
- **Retrieval:** a lightweight BM25 ranker selects up to four passages. This version deliberately avoids a second embedding model to keep memory use low on an 8 GB laptop.
- **Grounded generation:** the question and retrieved excerpts are sent to the local model with source IDs. Instructions require source-limited answers, citations, and explicit uncertainty where excerpts do not support an answer.
- **Fallback:** if there is no lexical evidence, generation is skipped and the system returns an explicit unsupported-answer response.
- **No-index mode:** RAG is optional. When there is no index, chat and ask use the pretrained model as a general-purpose assistant, explicitly label the answer as ungrounded, and return no citations. An existing index with no relevant match does not use this fallback.

```text
User-owned .txt/.md sources
        │
        ├── chunk (about 1,200 chars; about 180-char overlap)
        └── local BM25 index (.livingwords/index.json)
                         │
Question ── no index? ── general prompt ──┐
            │                             │
            └── BM25 top 4 ─ cited prompt ├── local Gemma 4 E2B
                                          │
                              ungrounded notice or citations
```

The index contains extracted text and relative filenames, not vector embeddings. Source IDs such as `[S1]` are request-local references mapped to a source file and chunk. Model output cannot be guaranteed to entail its citations; the source excerpts should be checked.

## Memory profile

The default prompt is limited to four passages (hard limit: eight), each approximately 1,200 characters; answer generation defaults to 384 tokens and has a hard 512-token cap. Chunking and retrieval run in Node.js without another model. Quantization and context settings are delegated to MLX-VLM, and actual memory use varies by runtime/model revision. Leave memory headroom for macOS and other applications.

## Scope

Gemma is used as a pretrained general-purpose model target. The project does not pretrain, SFT, DPO, LoRA/QLoRA, or finetune weights. The only supported theological knowledge/adaptation mechanism is retrieval from explicitly provided source material. Legacy sample data in the source checkout is not used by the runtime; no corpus or interpretation is endorsed.

BM25 is inexpensive and explainable but lexical: semantically related text with no shared terms may not be found. If retrieval is weak, narrow the question or improve the source collection. General-purpose `lw generate` does not use retrieval and should not be treated as a source-grounded theological answer.
