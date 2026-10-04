# Usage

LivingWords is local desktop AI for serious work: a private AI for writing, thinking, planning, and software tasks. It runs pretrained **Gemma 4 E2B Instruct** on your computer. There is no account, subscription, or per-prompt cloud fee; you provide the computer, storage, and power.

## 1. Install and start the desktop app

Install dependencies and launch the Electron app:

```bash
npm install
npm run dev
```

`npm install` downloads the pinned desktop Gemma GGUF into `.livingwords/desktop-model/` on all platforms; the transfer resumes if interrupted and is SHA-256 verified. The app packages that model into the build so there is no first-launch model download. `.livingwords/` is gitignored.

## 2. Use the desktop assistant

Use the Electron app to ask general questions, explore ideas, draft and revise writing, summarize, and plan. LivingWords has a Christian persona informed by historic Trinitarian Christianity and the Bible; that perspective informs faith, theology, and ethics answers, but is not forced into unrelated factual, creative, or technical answers. For software tasks, you can also use the built-in terminal. When the assistant proposes a command, review the exact command and approve it before it runs with your account permissions.

The assistant uses the model's general pretrained knowledge; its answers can be wrong and should be checked when accuracy matters. It does not claim personal faith or experiences. The app is desktop-only and does not expose a command-line or HTTP chat surface.

## Memory guidance

- Use the bundled desktop Gemma 4 E2B Instruct runtime provided with this app.
- Keep the app and its model process as the only resident local inference runtime.
- Choose a context window in Settings: 8K, 16K, 32K (default), 64K, or 128K. Larger windows use more memory.
- The response limit is 2K, 4K, 8K, 10K, or 10K tokens for those window sizes, respectively.

Changing the context window restarts the local model and cancels any response in progress. Actual memory use depends on the runtime version, model cache, and context configuration. Leave memory headroom for macOS and other applications.

## Scope and local data

The current app does not import documents or search external knowledge collections. Existing `.livingwords/index.json` and desktop `index.json` files are not loaded or modified; remove them manually if you no longer need them. Conversations are saved locally on this device.

The model is pretrained and is not fine-tuned by this project. No external knowledge source is bundled or presented as authoritative.
