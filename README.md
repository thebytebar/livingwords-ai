# LivingWords

**Local desktop AI with trusted, private workflows for serious users.** LivingWords is a private AI for writing, thinking, planning, and working with your terminal. The model runs on your computer, and conversations stay on your device.

Use it without an account, subscription, or per-prompt cloud fees. You provide the computer, storage, and power; the model needs several gigabytes of disk space and memory. LivingWords is powered by pretrained **Gemma 4 E2B Instruct** through a bundled Electron desktop app and `llama.cpp` runtime.

## What you can do

- Ask questions, explore ideas, draft and revise writing, summarize, and plan.
- Get help with software tasks and use the built-in terminal. The app shows assistant-proposed commands and requires your approval before they run.
- Keep conversations and their context on your device; inference runs locally.

LivingWords is a general-purpose assistant with a Christian persona informed by historic Trinitarian Christianity and the Bible. That perspective informs answers about faith, theology, and ethics, but is not forced into unrelated factual, creative, or technical answers. Its answers can be wrong and should be checked when accuracy matters. The current app does not import documents or search external knowledge collections, and assistant responses have a bounded length.

## Quick start

Install Node.js 18–22 dependencies and start the desktop app:

```bash
npm install
npm run dev
```

`npm install` downloads the pinned desktop Gemma GGUF into `.livingwords/desktop-model/` on all platforms; the transfer resumes if interrupted and the file is SHA-256 verified. Electron packaging copies that model into the app resources, so the installed desktop app does not download weights at launch. The weights are not committed or included in the published npm package. `.livingwords/` is gitignored.

For prebuilt macOS packages, including the first-launch Gatekeeper approval required by the current ad-hoc-signed builds, see the [desktop guide](docs/DESKTOP.md#open-an-ad-hoc-signed-build-on-another-mac).

The Electron desktop app is the supported product. LivingWords does not expose a CLI, local web API, or browser-based chat entrypoint.

## Product details

- **On-device inference:** bundled `llama.cpp` runtime and pinned Gemma GGUF model.
- **On-device privacy:** prompts are processed by the local model, and conversations are stored on your device.
- **Open source:** the LivingWords application is licensed under MIT; the bundled model has its own license and attribution.
- **Context window:** choose 8K, 16K, 32K (default), 64K, or 128K in Settings; the response limit scales from 2K to 10K tokens.

## Documentation

- [Usage guide](docs/USAGE.md)
- [Architecture and limitations](docs/CONCEPTS.md)
- [Desktop application and build guide](docs/DESKTOP.md)

## License

MIT
