# LivingWords desktop

The **File**, **Window**, and **Help** menus provide the platform's standard window and app actions. The **View** menu provides native zoom-in, zoom-out, and reset-zoom commands.

Settings provides 8K, 16K, 32K, 64K, and 128K context-window presets; 32K is the default. The selection is saved locally in the app's settings file. The response limits for those presets are 2,000, 4,000, 8,000, 10,000, and 10,000 tokens, respectively. The context meter estimates prompt usage against the selected window's rounded display scale. Assistant Markdown supports rendered inline and display math using `$...$`, `$$...$$`, `\(...\)`, and `\[...\]` delimiters.

Response requests are aborted after 120 seconds without data from the local model's stream. The timeout restarts whenever stream data arrives, so a long response can continue as long as generation remains active.

LivingWords is local desktop AI with trusted, private workflows for serious users: a private AI for writing, thinking, planning, and software tasks, with no account, subscription, or per-prompt cloud fees. The Electron app runs its bundled model on the user's device and keeps conversation data local. Its multi-pane workspace includes a Chat/Settings icon rail, searchable Sessions list, central conversation, and optional Tools panel. The built-in terminal supports software workflows, with explicit approval for every assistant-proposed command. Both side panels can be resized with their divider or keyboard arrows; their widths persist on this device. The Info panel opens on the current chat and supports multiple terminal tabs, each labeled "Terminal." Tabs start interactive shells with a solid, high-contrast block cursor. Select terminal text by dragging across it and press Ctrl+C (or Cmd+C on macOS) to copy; with no selection, Ctrl+C remains available for terminal interrupts. Each chat keeps independent terminal processes while the app is running; new terminals start in the user's home directory and tabs close explicitly or when their chat is deleted. The Info panel and a terminal are opened automatically when that conversation has no live terminal; before running a command, the app waits for the shell's initial prompt to render and settle in the visible terminal panel. Commands run as the signed-in user in the selected live terminal, are limited to one line of 4,000 characters and 120 seconds, and up to 6,000 output characters are returned to the assistant as untrusted data. The selected terminal's most recent 6,000 characters can also be included as untrusted context in that chat's next prompt; other terminal tabs are not included. Terminal contents and process state are not saved across app restarts. Conversations and their message context persist locally; the light/dark theme preference is local as well, and terminal colors follow the selected theme. The inference runtime starts loading when the app opens, conversation history scrolls independently of the composer, and sessions can be deleted from the local store. Assistant replies stream and render as sanitized Markdown. The layout is inspired by Kiro Crew but does not use Kiro branding or assets or implement multi-agent orchestration.

## Supported release targets

| Operating system | Initial architecture | Inference |
|---|---|---|
| macOS 14+ | Apple Silicon (`arm64`) | Bundled `llama.cpp`, Metal-enabled with CPU fallback |
| Windows 10/11 | x64 | Bundled CPU `llama.cpp` |
| Linux (Ubuntu 22.04 baseline) | x64 | Bundled CPU `llama.cpp` |

The desktop workflow currently builds and packages macOS arm64 only; Windows and Linux builds are paused while the macOS deployment pipeline is stabilized. The app is ad-hoc signed to seal its bundled resources, but it is not Developer ID signed or notarized, so recipients must approve it in Gatekeeper on first launch. GPU acceleration beyond the macOS Metal build, additional CPU architectures, Developer ID distribution, and older OS releases are not yet release commitments. The CPU-capable `llama.cpp` build is the compatibility baseline; performance and memory use depend on the host. Gemma 4 E2B is a multi-billion-parameter model, so verify that the device has several gigabytes of free memory and disk space before installation.

## Model and runtime

The npm postinstall downloads this immutable Hugging Face artifact to `.livingwords/desktop-model/`:

- Repository: [`ggml-org/gemma-4-E2B-it-GGUF`](https://huggingface.co/ggml-org/gemma-4-E2B-it-GGUF)
- Revision: `b4243c156154b6dca9324415f8c7ccc098b4aed1`
- File: `gemma-4-E2B-it-Q4_0.gguf`
- Size: 2,841,481,184 bytes
- SHA-256: `8e30dff3ac4c8434c49a7036fa15564bdbb6044e42bf04550bf1a096ad7e6a52`

The download resumes from a partial file when the server supports byte ranges, checks available disk space, verifies the full file hash, and only then saves the model at its final path. An interrupted or incomplete transfer can be retried by rerunning `npm install` or `node scripts/install-desktop-model.mjs`. The Electron packaging configuration copies this verified file into `resources/models/` in each platform app build. Users install one app containing the model and do not download weights when opening it. The model is not committed to Git or published as part of the npm package.

### Updating the desktop model

The desktop model is the `Q4_0` GGUF file from the [`ggml-org/gemma-4-E2B-it-GGUF`](https://huggingface.co/ggml-org/gemma-4-E2B-it-GGUF) Hugging Face repository. To update it:

1. Select a compatible GGUF artifact and record its immutable Hugging Face commit revision, exact filename, byte size, SHA-256, and license/attribution. Do not pin to a moving branch or `main`.
2. Update `MODEL_REPOSITORY`, `MODEL_REVISION`, `MODEL_FILENAME`, `MODEL_SIZE`, `MODEL_SHA256`, and, if needed, `MODEL_ID` in [`electron/model-artifact.mjs`](../electron/model-artifact.mjs). The download URL is derived from the repository, revision, and filename.
3. Update the model source, revision, file details, and any changed attribution or license information in this guide and [`desktop/THIRD_PARTY_NOTICES.md`](../desktop/THIRD_PARTY_NOTICES.md). Review the model card and license terms before distributing a new artifact.
4. Run `node scripts/install-desktop-model.mjs` to download and verify the pinned model, then run `npm test` and package on each supported platform with `npm run deploy`. The desktop workflow uses the same pinned metadata to fetch the model for release builds.

The downloaded file must match both the pinned size and SHA-256; packaging fails otherwise. When changing the model format or inference requirements, also verify the model's `llama.cpp` compatibility, update the runtime arguments or pinned `llama.cpp` revision as required, and test startup and answer quality on every supported target.

The desktop application starts its own `llama-server` process bound to `127.0.0.1`, uses the selected context window and one inference slot, disables model thinking mode so the output budget is available for the answer, and terminates the process on quit. Changing the context setting cancels any active response and restarts the local runtime; queued requests continue with the new setting. The composer shows estimated prompt usage as a circular meter beside Send; hovering or keyboard-focusing it reveals the estimate and bar. Each assistant response has a footer with an icon-only Copy action and a circular output-usage meter; the response meter updates while text streams, and its tooltip shows the estimate against the active output limit. Estimates use a character-to-token heuristic and can differ from actual tokenizer counts. The response limits are 2,000 / 4,000 / 8,000 / 10,000 / 10,000 tokens for 8K / 16K / 32K / 64K / 128K context, respectively. Desktop requests run through one shared FIFO queue: one request is generated at a time, up to 10 more may wait, and each conversation may have only one queued or active request. Queued and active requests can be cancelled; cancelled turns are marked in the saved conversation. The queue does not increase model parallelism. It defaults to CPU inference (`--n-gpu-layers 0`) to avoid display/GPU instability on Apple Silicon. GPU offload is an opt-in development setting: `LW_LLAMA_GPU_LAYERS=20 npm run dev` requests the selected number of layers (valid range 0–99). If graphics flicker or inference returns compute errors after enabling GPU layers, close the app and retry without that setting. The server binary and its dynamic libraries are packaged outside Electron's ASAR archive. At present, the bundled GGUF is a community-converted quantization of Gemma 4 E2B Instruct. Answer quality should be compared against the released desktop baseline before a production release.

Google's Gemma 4 model is distributed under Apache License 2.0; the selected Hugging Face artifact is labeled Apache-2.0. Selecting the assistant status at the bottom of the Sessions pane opens the model attribution and complete Apache 2.0 terms in the app. `llama.cpp` is MIT-licensed. The desktop package includes [third-party notices](../desktop/THIRD_PARTY_NOTICES.md); verify licenses and source revisions whenever either artifact is updated.

## Build locally

For normal development or packaging, install the Node dependencies and model:

```bash
npm install
npm run dev
```

On macOS, the development command renames Electron's local app bundle to “LivingWords AI.app” before launch so the Dock tooltip and system menu use “LivingWords AI” instead of “Electron.” The Dock and packaged app use a dedicated opaque charcoal-and-gold icon, with the system applying its native app-icon mask.

The desktop model alone can be installed or resumed with `node scripts/install-desktop-model.mjs`. To install dependencies and start the UI without downloading the model, use:

```bash
LW_SKIP_MODEL_INSTALL=1 npm install
npm run dev
```

Development launch looks for a compatible `llama-server` in `sidecars/<platform>/<architecture>/`, then on `PATH`, or at the explicit path in `LW_LLAMA_SERVER`. On macOS, install the development runtime with `brew install llama.cpp`; on Windows/Linux, install a compatible llama.cpp build or provide `LW_LLAMA_SERVER=/path/to/llama-server`. Packaged desktop apps use the bundled sidecar and do not need a separate system install. The model must be present under `.livingwords/desktop-model/` for development; packaged apps read the copy injected into their resources.

Package on a supported host after installing the model and building the runtime sidecar:

```bash
npm run deploy
```

The packaging script verifies the model's size and SHA-256 and fails if either the model or matching sidecar executable is missing. Electron Builder stores them under `resources/models/` and `resources/llama-server/<platform>/<architecture>/`, outside `app.asar`.

### Open an ad-hoc-signed build on another Mac

Share the macOS `.dmg` or installer `.zip` produced by Electron Builder, not an unpacked `LivingWords AI.app` directory. The desktop workflow publishes only these installer files. The recipient must use an Apple silicon Mac running macOS 14 or later.

After downloading and extracting the GitHub Actions artifact, the recipient can open the DMG and drag `LivingWords AI.app` to Applications, or extract the installer ZIP and move the app to Applications. Because the app is ad-hoc signed and not notarized, macOS will not identify it as an Apple-verified developer. To approve this trusted app, Control-click it in Finder, choose **Open**, then confirm **Open** in the warning dialog. If macOS blocks the first launch without offering that button, try opening it once, then use **System Settings → Privacy & Security → Open Anyway**. Apple documents this process in [Safely open apps on your Mac](https://support.apple.com/en-us/102445).

Only approve an app obtained from a source the recipient trusts. Ad-hoc signing seals the app contents so integrity can be checked; it does not establish the publisher's identity or satisfy Gatekeeper automatically. A message that the app is damaged, rather than an unidentified-developer warning, can indicate an invalid or altered bundle; use the packaged DMG/ZIP from the latest workflow run instead of a raw app folder or an older artifact. Launching without a Gatekeeper approval requires Developer ID signing and Apple notarization.

## Rebuild the llama.cpp sidecar

The checked-in [desktop workflow](../.github/workflows/desktop.yml) downloads and verifies the model once, builds llama.cpp at the pinned commit `19e28a27702117d8f2eb16b825b9a308111f67d9`, and packages macOS arm64 on a native runner. Windows and Linux builds are paused while the macOS deployment pipeline is stabilized. The workflow runs for `desktop-v*` tags or by manual dispatch. Workflow outputs are build artifacts; they are not automatically published as GitHub Releases.

To build manually on macOS, install CMake and the Xcode command-line tools, then run the following from the repository root:

```bash
git clone --no-checkout https://github.com/ggml-org/llama.cpp.git /tmp/livingwords-llama.cpp
git -C /tmp/livingwords-llama.cpp checkout --detach 19e28a27702117d8f2eb16b825b9a308111f67d9
cmake -S /tmp/livingwords-llama.cpp -B /tmp/livingwords-llama.cpp/build \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_BUILD_WITH_INSTALL_RPATH=ON \
  -DBUILD_SHARED_LIBS=ON \
  -DLLAMA_BUILD_SERVER=ON \
  -DLLAMA_BUILD_TESTS=OFF \
  -DLLAMA_BUILD_EXAMPLES=OFF \
  -DLLAMA_BUILD_TOOLS=ON \
  -DLLAMA_USE_PREBUILT_UI=OFF \
  -DLLAMA_OPENSSL=OFF \
  -DGGML_NATIVE=OFF \
  '-DCMAKE_INSTALL_RPATH=@executable_path' \
  -DGGML_METAL=ON
cmake --build /tmp/livingwords-llama.cpp/build --config Release --target llama-server --parallel 2
mkdir -p sidecars/mac/arm64
cp "$(find /tmp/livingwords-llama.cpp/build -type f -name llama-server -print -quit)" sidecars/mac/arm64/
find /tmp/livingwords-llama.cpp/build -name '*.dylib' -exec cp -P {} sidecars/mac/arm64/ \;
sidecars/mac/arm64/llama-server --version
```

The server target requires `LLAMA_BUILD_TOOLS=ON`; examples and tests remain disabled. The embedded Web UI and its download are disabled because LivingWords uses the local server API directly. HTTPS support is disabled because the bundled server only listens on loopback, avoiding a runtime dependency on system OpenSSL installations. The workflow applies the corresponding settings and collects runtime libraries for each supported platform.

## Security and local data

- Renderer code runs with context isolation, sandboxing, and Node.js integration disabled. Its Content Security Policy allows inline styles for xterm's runtime-generated cell and selection styles while keeping scripts restricted to app files.
- The preload exposes narrowly scoped terminal lifecycle, input, resize, output, and confirmed-command methods alongside queued question answering, request cancellation/status, setup progress, conversation storage, and status methods. The main process validates renderer origin, terminal IDs, PTY sizes, input lengths, command requests, and prompt-context size before handling requests.
- Terminal shells run locally as the signed-in user with the user's environment and home directory. Commands can access files and programs available to that account. Every assistant-proposed command requires explicit user approval. Command output returned to the model is bounded and labeled untrusted data.
- The model API is reachable only on loopback; the app does not expose an HTTP listener to the LAN.
- Conversation transcripts are stored in `conversations.json` under Electron's user data directory. The local model receives bounded context from the active session only.
- Deleting a session permanently removes that conversation from the local transcript store. Assistant Markdown is sanitized before it is inserted into the page; user messages are always rendered as plain text.
- Light/dark appearance is selected in Settings; the dark theme is the default, and the selected theme is saved on this device.
- Resized Sessions and Info panel widths are saved on this device. Terminal tabs and shell processes are in-memory only and are terminated when their tab or chat is deleted, the app window closes, or the app quits.
- Model weights are bundled in the app resources; conversations are stored outside the installer. Legacy `index.json` files in app data are ignored and left untouched.

Electron Builder signs the macOS app ad hoc so its resource seal can be verified, but release artifacts are not Developer ID signed or notarized. Before distributing production binaries, configure Developer ID signing/notarization, publish third-party notices, test clean installation and upgrades on each supported OS, and benchmark startup, model memory, and answer quality on representative hardware.
