# Architecture and concepts

LivingWords is local desktop AI with trusted, private workflows for serious users: a private AI for writing, thinking, planning, and software tasks, built around a pretrained Gemma model:

- **Model:** Gemma 4 E2B Instruct provides language ability; the project does not pretrain or fine-tune model weights.
- **Inference:** Electron desktop builds run the model through a bundled `llama.cpp` runtime on macOS, Windows, and Linux.
- **Interfaces:** the desktop app is the supported product; there is no CLI or HTTP web interface.
- **Workflows:** general-purpose chat with a Christian persona informed by historic Trinitarian Christianity and the Bible, plus a built-in terminal for software tasks. The Christian perspective is used when relevant to faith, theology, and ethics, not forced into unrelated answers. Assistant-proposed terminal commands require user approval before they run.
- **Conversation context:** the Electron app stores chat sessions locally and supplies a bounded history from the selected conversation when generating follow-up answers.
- **Privacy:** inference runs locally on the device, and conversation data is stored locally; the Electron renderer cannot access Node.js or the filesystem directly.
- **Cost model:** there is no account, subscription, or per-prompt cloud fee. Users provide the hardware, storage, and power needed to run the model.

The desktop client bundles its pinned GGUF model into each Electron build. `npm install` downloads and verifies the model into the ignored project model cache before the build injects it into app resources. The installed app does not download weights on first launch. See the [desktop build guide](DESKTOP.md) for artifact pins and release caveats.

## Memory profile

The desktop Settings window offers 8K, 16K, 32K, 64K, and 128K context windows, with 32K as the default. The response limit is approximately one quarter of the selected window, rounded down to the nearest 1,000 tokens and capped at 10,000. Larger contexts use more memory; changing the context restarts the local inference runtime and cancels any active response.

## Scope and local data

Chat prompts are processed by the bundled local model. Document import and external knowledge collections are not included. Existing `.livingwords/index.json` and desktop `index.json` files are ignored and left untouched. The selected context window and its corresponding response limit apply to each request.

The model is pretrained and is not fine-tuned by this project. It can make mistakes; verify answers when accuracy matters.
