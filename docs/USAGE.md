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

The tools and documents panel remembers whether it was open and restores the Documents tab for each conversation. Terminal tabs are temporary and are not restored; the app warns before closing while terminal sessions are active.

### Use your local documents

1. Click **+** in the lower-left corner of the composer to open the Documents tab. You can also add Documents from the **+** menu in the tools and documents panel.
2. In Documents, click **+** and choose **Add files** or **Add folder**. Select supported text files, including code and configuration files such as `.js` and `.json`, or text-based PDF (`.pdf`) files, or a folder containing them.
3. LivingWords references selected files in place; it does not copy or move originals. The Documents panel lists one row per file or folder. Remove a row to detach that reference from the conversation. The composer shows the total number of unique supported files attached, including files found in folders.
4. Ask about the attached documents. The assistant searches locally and adds bounded relevant excerpts to context rather than loading entire files or folders. Broad project-overview questions automatically start with README, manifest, and overview-document excerpts. Answers can cite passages such as `[S1]`; click a citation to open the source document and inspect its full contents.

Folder indexing is recursive and has no 100-file cap. Hidden entries, symbolic links, `.gitignore` matches, and common generated/dependency folders are skipped during bulk indexing. The local index refreshes when a file's size or modification time changes. Duplicate files reached through multiple references count once. Individual files are limited to 20 MB; derived text and search indexes share a 250 MB cache budget across conversations, with inactive conversation caches evicted least-recently-used and rebuilt on demand. If a folder contains files outside the local index, the assistant can search them on demand within bounded per-search file and byte limits; ignored/generated paths are considered only when the assistant explicitly opts in. Scanned PDFs, OCR, and unsupported formats are not supported. Search ranks matching terms locally; it is not semantic search and can miss passages phrased differently from the question.

When you ask about attached files, the assistant searches them on demand and reads bounded passages; citations open the referenced document in the viewer. An attached folder starts with a compact inventory (depth 2 by default, capped at depth 3 and 200 entries) and recognized project guidance such as `AGENTS.md`, `CLAUDE.md`, and `.github/copilot-instructions.md`. Guidance is treated as untrusted project data, not as system instructions. The assistant can then list directories, read files in pages (up to 2,000 lines or 50 KB per read), and grep within the attached folder using bounded results and regex complexity limits; it does not load the full folder into the prompt. The Documents panel shows folder files whose contents were actually included in that conversation's model context, not every indexed file or path returned by a directory listing. Expand a file's **Included in context** details to see whether it came from a document excerpt, folder read, search match, or project instructions, along with the saved passage and its page or line location when known. The provenance indicates which material was supplied to the model; it does not claim which material the model relied on internally. Older conversations may have citation excerpts but not detailed access records. When available, open a passage to view the document at its line location. When you ask to edit an attached text file, LivingWords shows a diff and waits for your approval before writing to the original. If the file changes before you approve, the proposal is rejected so a newer edit is not overwritten. PDFs are read-only. Click a file's view icon or an in-chat citation to open the document viewer. Folder rows expand to show the context-used files; use the filename filter to narrow the list. Removing references or deleting a conversation removes only LivingWords' local index and extracted text; original files are never deleted.

The app keeps references, extracted text, and indexes in its local user-data directory; they are not sent to a cloud service. Older imported copies cannot be mapped to their original paths, so the first version using references removes those old app-managed copies and attachments. Existing conversation messages are preserved; reattach the source files you still want to use.

The assistant uses the model's general pretrained knowledge; its answers can be wrong and should be checked when accuracy matters. It does not claim personal faith or experiences. The app is desktop-only and does not expose a command-line or HTTP chat surface.

## Memory guidance

- Use the bundled desktop Gemma 4 E2B Instruct runtime provided with this app.
- Keep the app and its model process as the only resident local inference runtime.
- Choose a context window in Settings: 8K, 16K, 32K (default), 64K, or 128K. Larger windows use more memory.
- The response limit is 2K, 4K, 8K, 10K, or 10K tokens for those window sizes, respectively.

Changing the context window restarts the local model and cancels any response in progress. Actual memory use depends on the runtime version, model cache, and context configuration. Leave memory headroom for macOS and other applications.

## Scope and local data

The app searches only files and folders explicitly referenced in the current conversation; it does not connect to external knowledge collections. Existing `.livingwords/index.json` and desktop `index.json` files are not loaded or modified; remove them manually if you no longer need them. Conversations and citation excerpts are saved locally on this device.

The model is pretrained and is not fine-tuned by this project. No external knowledge source is bundled or presented as authoritative.
