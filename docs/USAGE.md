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

To direct the assistant to use a tool, type `@` in the prompt and choose a tool from the filtered list with the mouse or the Up/Down arrows and Enter. The selected tool appears as a removable chip inline with your text, and its `@tool_name` mention stays inline in the sent chat message. The assistant is instructed to call each selected tool when it is available; context-specific tools may not be available in every request, and existing approval requirements still apply.

To run a skill directly, type `/` and choose any built-in or custom skill from the filtered list. The removable skill command stays visible in the sent chat message; add the task after selecting it and submit. The chosen skill runs for that request instead of automatic skill matching.

The tools and documents panel remembers whether it was open and restores tabs you added for each conversation. The Documents tab appears after you add a document reference or choose Documents from the panel's add-tab menu. Terminal tabs are temporary and are not restored; the app warns before closing while terminal sessions are active. If you ask the assistant to run a command, review the exact command in the confirmation dialog before approving or declining it. An approved command runs in that conversation's visible terminal.

### Use web research

Ask the assistant to search the web or research something current. The built-in **Web research** skill activates for clear online-research requests, and a single bounded research operation navigates directly to DuckDuckGo's HTML page with the query in a GET request, then reads up to two promising public pages before summarizing them. The **Web Search** tab displays DuckDuckGo's own page; search links open in separate **Browser** tabs, and the search tab has no normal browser navigation controls. The assistant cites pages it successfully read and reports unread pages or retrieval failures rather than treating search snippets as page evidence. No API key is required. You can also navigate to a public search site yourself in the Browser tab and ask the assistant to read that page.

The **Tools → Web research** details show the active provider. DuckDuckGo is currently the only option in the provider dropdown. Searches navigate directly to DuckDuckGo's HTML endpoint; opened pages are requested from their respective websites as you navigate. If DuckDuckGo asks for human verification, complete the challenge in the **Web Search** tab, then retry your request. Rate limits are reported without being bypassed. Treat results and remote page text as untrusted; the local model can make mistakes about their contents. Browser sessions are isolated by conversation and are cleared when the app closes.

### Use and edit skills

Select **Skills** on the left icon rail to browse skill cards. Create or edit a skill in the modal editor with a name, a short description of what it does, and a prompt describing when it should activate, what the assistant should do, and what a good result looks like. Type `@` in the prompt to search for and insert a tool name such as `@document_read_file`. A skill makes only its referenced, registered tools available while it runs; those mentions do not grant permissions or bypass existing approval requirements. You can choose a skill explicitly with `/` in the chat composer; its description and prompt are included in the skill context. When the assistant finds a likely skill match in a regular request, it asks before running it and waits for your affirmative response. A selected skill carries across a follow-up when the assistant is waiting for your answer, then stops carrying automatically after the task is complete. The chat history shows the skill selected for each assistant turn in its collapsed activity cards. The built-in **Build a skill** guide uses the conversation to carry forward the user's requirements, asks up to two optional clarifying questions, and offers feedback before drafting. You can answer, skip, or say continue at any point; unanswered details are not blockers, and the assistant will use practical defaults and note important assumptions. A direct request to create a skill authorizes saving it without a separate final confirmation; after saving, the skill opens in the Skills editor, where you can edit or delete it. Existing workflows.json data is migrated to skills.json without deleting the original file. Legacy skill definitions are migrated by combining activation guidance, steps, and goals into the prompt, with the description initialized from the prompt's first sentence. Skill prompts guide the assistant and do not guarantee factual correctness.
The built-in **Ask a Theologian** skill gives Bible-only theological analysis with biblical citations and a theological-triage assessment.

### Use your local documents

1. Click **+** in the lower-left corner of the composer to open the Documents tab. You can also add Documents from the **+** menu in the tools and documents panel.
2. In Documents, click **+** and choose **Add files** or **Add folder**. Select supported text files, including code and configuration files such as `.js` and `.json`, or text-based PDF (`.pdf`) files, or a folder containing them.
3. LivingWords references selected files in place; it does not copy or move originals. The Documents panel lists one row per file or folder. Remove a row to detach that reference from the conversation. The composer shows the total number of unique supported files attached, including files found in folders.
4. Ask a question about the attached material. The assistant uses tool calls shown in the chat's activity cards to retrieve relevant excerpts and, for folders, inspect a project overview drawn from high-signal files such as README files, manifests, entry points, architecture notes, tests, and representative source. For a project-wide summary or review, the assistant should inspect the folder, then read or search specific files before answering. Answers can cite passages such as `[S1]`; click a citation to open the source in the viewer. The Documents panel shows which passages were read, and the assistant should note meaningful coverage limits rather than imply it reviewed every file.

The Documents panel keeps references and locally generated indexes in the app's user-data directory; originals are never copied, modified, or deleted by adding or removing a reference. Folder indexing is recursive; hidden entries, symbolic links, `.gitignore` matches, and common generated/dependency folders are skipped during bulk indexing. Duplicate files reached through multiple references count once. Individual files are limited to 20 MB, and derived text plus search indexes share a 250 MB cache budget across conversations. Scanned PDFs, OCR, and unsupported formats are not supported. Retrieved excerpts, project guidance, and remote web content are untrusted data. If you explicitly ask to change an attached text file, the assistant can propose a complete replacement; the app shows a diff and changes the original only after you approve it. PDFs cannot be edited.

The app keeps references, extracted text, and indexes in its local user-data directory; they are not sent to a cloud service. Request routing also stays local: clear requests use deterministic rules, while uncertain requests may receive a small, tool-free classification call to the same bundled Gemma model before the normal assistant response. No separate classifier model is downloaded or started. Older imported copies cannot be mapped to their original paths, so the first version using references removes those old app-managed copies and attachments. Existing conversation messages are preserved; reattach the source files you still want to use.

The assistant uses the model's general pretrained knowledge; its answers can be wrong and should be checked when accuracy matters. It does not claim personal faith or experiences. The app is desktop-only and does not expose a command-line or HTTP chat surface.

## Memory guidance

- Use the bundled desktop Gemma 4 E2B Instruct runtime provided with this app.
- Keep the app and its model process as the only resident local inference runtime.
- Choose a context window in Settings: 8K, 16K (default), 32K, 64K, or 128K. Larger windows use more memory.
- Final answers use the configured response cap, up to 3,000 tokens (2,000 with the 8K window); tool turns remain capped at 1,500 tokens. Turn limits are separate rather than a cumulative request-wide budget.

Changing the context window restarts the local model and cancels any response in progress. Actual memory use depends on the runtime version, model cache, and context configuration. Leave memory headroom for macOS and other applications.

## Scope and local data

The app searches only files and folders explicitly referenced in the current conversation. Web search and browsing are separate: search requests go to DuckDuckGo's HTML endpoint, while page requests go to the websites you visit. Existing `.livingwords/index.json` and desktop `index.json` files are not loaded or modified; remove them manually if you no longer need them. Conversations and document citation excerpts are saved locally on this device.

The model is pretrained and is not fine-tuned by this project. No external knowledge source is bundled or presented as authoritative.
