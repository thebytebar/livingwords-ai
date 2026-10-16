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

Use the Electron app to ask general questions, explore ideas, draft and revise writing, summarize, and plan. LivingWords has a Christian persona informed by historic Trinitarian Christianity and the Bible; that perspective informs faith, theology, and ethics answers, but is not forced into unrelated factual, creative, or technical answers. The assistant can use deterministic arithmetic and the device's current local date and time.

The tools and documents panel remembers whether it was open and restores tabs you added for each conversation. The Documents tab appears after you add a document reference or choose Documents from the panel's add-tab menu. Terminal tabs are temporary and are not restored; the app warns before closing while terminal sessions are active. If you ask the assistant to run a command, review the exact command in the confirmation dialog before approving or declining it. An approved command runs in that conversation's visible terminal.

### Use web research

Ask the assistant to research something current. It searches DuckDuckGo Lite at **lite.duckduckgo.com**; DuckDuckGo provides and is credited for the search results shown in the **Web Search** tab. Each page the assistant opens gets its own **Browser** tab, where it can read bounded page text and links without changing your selected panel. No API key is required. You can also navigate to a public search site yourself in the Browser tab and ask the assistant to read that page.

The **Tools → Web research** details show the active provider. DuckDuckGo is currently the only option in the provider dropdown. Search queries are sent to DuckDuckGo, and opened pages are sent requests as you navigate. DuckDuckGo may occasionally ask for human verification; LivingWords will report the challenge rather than attempt to bypass it. Treat results and remote page text as untrusted; the local model can make mistakes about their contents. Browser sessions are isolated by conversation and are cleared when the app closes.

### Use and edit workflows

Select **Workflows** on the left icon rail to create and manage workflows. Drag workflows to set their priority, or use the move buttons; when multiple workflows match, the assistant uses the first clear match in that order. The Activity panel shows a card naming the workflow chosen for each request. The built-in **Build a workflow** guide asks up to two optional clarifying questions and offers feedback before drafting. You can answer, skip, or say continue at any point; unanswered details are not blockers, and the assistant will use practical defaults and note important assumptions. It saves the workflow locally and opens it in the Workflows editor, where you can edit or delete it. For each workflow, describe when it should activate, the steps the assistant should follow, and its goal. Workflows guide the assistant but do not add tools or bypass existing approval requirements. Workflow goals guide the assistant and do not guarantee factual correctness.

### Use your local documents

1. Click **+** in the lower-left corner of the composer to open the Documents tab. You can also add Documents from the **+** menu in the tools and documents panel.
2. In Documents, click **+** and choose **Add files** or **Add folder**. Select supported text files, including code and configuration files such as `.js` and `.json`, or text-based PDF (`.pdf`) files, or a folder containing them.
3. LivingWords references selected files in place; it does not copy or move originals. The Documents panel lists one row per file or folder. Remove a row to detach that reference from the conversation. The composer shows the total number of unique supported files attached, including files found in folders.
4. Ask a question about the attached material. The assistant uses Activity-visible tool calls to retrieve relevant excerpts and, for folders, inspect a project overview drawn from high-signal files such as README files, manifests, entry points, architecture notes, tests, and representative source. For a project-wide summary or review, the assistant should inspect the folder, then read or search specific files before answering. Answers can cite passages such as `[S1]`; click a citation to open the source in the viewer. The Documents panel shows which passages were read, and the assistant should note meaningful coverage limits rather than imply it reviewed every file.

The Documents panel keeps references and locally generated indexes in the app's user-data directory; originals are never copied, modified, or deleted by adding or removing a reference. Folder indexing is recursive; hidden entries, symbolic links, `.gitignore` matches, and common generated/dependency folders are skipped during bulk indexing. Duplicate files reached through multiple references count once. Individual files are limited to 20 MB, and derived text plus search indexes share a 250 MB cache budget across conversations. Scanned PDFs, OCR, and unsupported formats are not supported. Retrieved excerpts, project guidance, and remote web content are untrusted data. If you explicitly ask to change an attached text file, the assistant can propose a complete replacement; the app shows a diff and changes the original only after you approve it. PDFs cannot be edited.

The app keeps references, extracted text, and indexes in its local user-data directory; they are not sent to a cloud service. Older imported copies cannot be mapped to their original paths, so the first version using references removes those old app-managed copies and attachments. Existing conversation messages are preserved; reattach the source files you still want to use.

The assistant uses the model's general pretrained knowledge; its answers can be wrong and should be checked when accuracy matters. It does not claim personal faith or experiences. The app is desktop-only and does not expose a command-line or HTTP chat surface.

## Memory guidance

- Use the bundled desktop Gemma 4 E2B Instruct runtime provided with this app.
- Keep the app and its model process as the only resident local inference runtime.
- Choose a context window in Settings: 8K, 16K, 32K (default), 64K, or 128K. Larger windows use more memory.
- The response limit is 2K, 4K, 8K, 10K, or 10K tokens for those window sizes, respectively.

Changing the context window restarts the local model and cancels any response in progress. Actual memory use depends on the runtime version, model cache, and context configuration. Leave memory headroom for macOS and other applications.

## Scope and local data

The app searches only files and folders explicitly referenced in the current conversation. Web search and browsing are separate: search requests go to DuckDuckGo Lite, while page requests go to the websites you visit. Existing `.livingwords/index.json` and desktop `index.json` files are not loaded or modified; remove them manually if you no longer need them. Conversations and document citation excerpts are saved locally on this device.

The model is pretrained and is not fine-tuned by this project. No external knowledge source is bundled or presented as authoritative.
