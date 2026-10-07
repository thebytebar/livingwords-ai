import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, shell } from 'electron';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readChatCompletionStream } from './chat-completion-stream.mjs';
import { createAssistantService } from '../dist/core/assistant.js';
import { createConversationStore } from './conversation-store.mjs';
import {
  createDocumentLibrary,
  sanitizeCitedAnswer,
  SUPPORTED_DOCUMENT_EXTENSIONS,
} from './document-library.mjs';
import {
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  contextWindowPreset,
  responseTokenLimitForContext,
  validateContextWindowTokens,
} from './context-window.mjs';
import { createContextSettingsStore } from './context-settings-store.mjs';
import { createInactivityTimeout } from './inactivity-timeout.mjs';
import { MODEL_FILENAME } from './model-artifact.mjs';
import { createModelManager } from './model-manager.mjs';
import { createRequestQueue, RequestCancelledError } from './request-queue.mjs';
import { createTerminalManager } from './terminal-manager.mjs';
import { isTrustedRendererUrl } from './trusted-renderer.mjs';
import pty from 'node-pty';

const here = dirname(fileURLToPath(import.meta.url));
const APP_NAME = 'LivingWords AI';
const RESPONSE_INACTIVITY_TIMEOUT_MS = 120_000;
app.setName(APP_NAME);
const allowedExternalHosts = new Set(['ai.google.dev', 'huggingface.co', 'www.apache.org']);
const sidecarPlatform = process.platform === 'darwin' ? 'mac'
  : process.platform === 'win32' ? 'win'
    : process.platform;
const modelManager = createModelManager({
  modelPath: app.isPackaged
    ? join(process.resourcesPath, 'models', MODEL_FILENAME)
    : resolve(here, '..', '.livingwords', 'desktop-model', MODEL_FILENAME),
  getRuntimePath: () => {
    if (process.env.LW_LLAMA_SERVER) return process.env.LW_LLAMA_SERVER;
    if (app.isPackaged) {
      return join(process.resourcesPath, 'llama-server', sidecarPlatform, process.arch,
        process.platform === 'win32' ? 'llama-server.exe' : 'llama-server');
    }
    return resolve(here, '..', 'sidecars', sidecarPlatform, process.arch,
      process.platform === 'win32' ? 'llama-server.exe' : 'llama-server');
  },
});

let mainWindow;
let isQuitting = false;
const conversationStore = createConversationStore(join(app.getPath('userData'), 'conversations.json'));
const documentLibrary = createDocumentLibrary(join(app.getPath('userData'), 'document-library'));
const contextSettingsStore = createContextSettingsStore(join(app.getPath('userData'), 'settings.json'));
let contextWindowTokens = DEFAULT_CONTEXT_WINDOW_TOKENS;
let contextSettingsLoadError = null;
let contextTransition = Promise.resolve();
let sessionWriteQueue = Promise.resolve();
const terminalShell = process.platform === 'win32'
  ? process.env.COMSPEC ?? 'powershell.exe'
  : process.env.SHELL ?? '/bin/sh';
const terminalManager = createTerminalManager({
  spawnTerminal: pty.spawn,
  homeDirectory: app.getPath('home'),
  shell: terminalShell,
  shellArgs: process.platform === 'win32'
    ? (/(?:powershell|pwsh)(?:\.exe)?$/iu.test(terminalShell) ? ['-NoLogo', '-NoExit'] : [])
    : ['-i'],
  env: process.env,
  commandInput: ({ command, startMarker, endMarker }) => {
    if (process.platform !== 'win32') {
      const quotedCommand = `'${command.replaceAll("'", "'\\''")}'`;
      return {
        input: `printf '\\177%s\\177' '${startMarker}'; eval ${quotedCommand}; printf '\\177%s\\177' '${endMarker}'\n`,
        startToken: `\x7f${startMarker}\x7f`,
        endToken: `\x7f${endMarker}\x7f`,
      };
    }
    if (/(?:powershell|pwsh)(?:\.exe)?$/iu.test(terminalShell)) {
      const quotedCommand = command.replaceAll("'", "''");
      return {
        input: `[Console]::Write([char]127 + '${startMarker}' + [char]127); Invoke-Expression '${quotedCommand}'; [Console]::Write([char]127 + '${endMarker}' + [char]127)\n`,
        startToken: `\x7f${startMarker}\x7f`,
        endToken: `\x7f${endMarker}\x7f`,
      };
    }
    const encodedCommand = Buffer.from(command, 'utf16le').toString('base64');
    return {
      input: `powershell.exe -NoProfile -Command "[Console]::Write([char]127 + '${startMarker}' + [char]127); & cmd.exe /d /s /c ([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encodedCommand}'))); [Console]::Write([char]127 + '${endMarker}' + [char]127)"\r\n`,
      startToken: `\x7f${startMarker}\x7f`,
      endToken: `\x7f${endMarker}\x7f`,
    };
  },
  onData: (event) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('livingwords:terminal-data', event);
    }
  },
  onExit: (event) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('livingwords:terminal-exit', event);
    }
  },
});
const MAX_TERMINAL_CONTEXT_LENGTH = 6_000;
const pendingCommandRequests = new Map();
const pendingDocumentEditRequests = new Map();

function validateHistory(history) {
  if (history === undefined) return [];
  if (!Array.isArray(history) || history.length > 8) {
    throw new Error('Conversation context must contain at most 8 prior messages.');
  }
  let totalLength = 0;
  return history.map((message) => {
    if (!message || typeof message !== 'object'
      || !['user', 'assistant'].includes(message.role)
      || typeof message.content !== 'string'
      || message.content.length > 4_000) {
      throw new Error('Conversation context contains an invalid message.');
    }
    totalLength += message.content.length;
    if (totalLength > 8_000) throw new Error('Conversation context is too long.');
    return { role: message.role, content: message.content };
  });
}

function serializeSessionWrite(operation) {
  const result = sessionWriteQueue.then(operation);
  sessionWriteQueue = result.catch(() => {});
  return result;
}

async function addDocumentReferencesToSession(sessionId, addReferences) {
  const session = await conversationStore.get(sessionId);
  const result = await addReferences();
  const newIds = [...new Set(result.added.map((reference) => reference.id))];
  const selectedDocumentIds = [...new Set([...(session.selectedDocumentIds ?? []), ...newIds])];
  if (selectedDocumentIds.length > 100) {
    const cleanupErrors = [];
    for (const reference of result.added.filter((item) => !item.duplicate)) {
      try {
        await documentLibrary.remove(reference.id, sessionId);
      } catch (error) {
        cleanupErrors.push(error.message);
      }
    }
    const reason = `A conversation can attach at most 100 file or folder references.`;
    if (cleanupErrors.length > 0) {
      throw new Error(`${reason} Failed to clean up new references: ${cleanupErrors.join('; ')}`);
    }
    throw new Error(reason);
  }
  try {
    await conversationStore.save({ ...session, selectedDocumentIds });
  } catch (error) {
    const cleanupErrors = [];
    for (const reference of result.added.filter((item) => !item.duplicate)) {
      try {
        await documentLibrary.remove(reference.id, sessionId);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError.message);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new Error(`Could not save the conversation's document references: ${error.message}. Cleanup also failed: ${cleanupErrors.join('; ')}`, {
        cause: error,
      });
    }
    throw error;
  }
  return result;
}

function publishActivity(activity) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('livingwords:activity', activity);
  }
}

function publishRequestStatus(status) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('livingwords:request-status', status);
  }
}

function publishRequestResult(result) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('livingwords:request-result', result);
  }
}

function publishRequestChunk(chunk) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('livingwords:request-chunk', chunk);
  }
}

function publishTerminalCommandRequest(request) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('livingwords:terminal:command-request', request);
  }
}

function publishDocumentEditRequest(request) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('livingwords:document:edit-request', request);
  }
}

function requestTerminalCommand({ requestId, sessionId, command, signal }) {
  if (signal.aborted) return Promise.reject(new RequestCancelledError());
  const commandId = randomUUID();
  return new Promise((resolve, reject) => {
    const pending = {
      requestId,
      sessionId,
      command,
      signal,
      resolve,
      reject,
      abort: null,
      executing: false,
    };
    pending.abort = () => {
      pendingCommandRequests.delete(commandId);
      reject(new RequestCancelledError());
    };
    pendingCommandRequests.set(commandId, pending);
    signal.addEventListener('abort', pending.abort, { once: true });
    if (!mainWindow || mainWindow.isDestroyed()) {
      pendingCommandRequests.delete(commandId);
      signal.removeEventListener('abort', pending.abort);
      reject(new Error('The terminal command could not be shown because the app window is unavailable.'));
      return;
    }
    publishTerminalCommandRequest({
      requestId,
      sessionId,
      commandId,
      command,
    });
  });
}

function finishTerminalCommandRequest(commandId, pending, error, output) {
  if (pendingCommandRequests.get(commandId) !== pending) return;
  pendingCommandRequests.delete(commandId);
  pending.signal.removeEventListener('abort', pending.abort);
  if (error) pending.reject(error);
  else pending.resolve(output);
}

function rejectPendingTerminalCommands(message) {
  for (const [commandId, pending] of pendingCommandRequests) {
    finishTerminalCommandRequest(commandId, pending, new Error(message));
  }
}

function requestDocumentEdit({ requestId, sessionId, documentId, content, signal }) {
  if (signal.aborted) return Promise.reject(new RequestCancelledError());
  return documentLibrary.prepareEdit(sessionId, documentId, content).then((proposal) => {
    if (signal.aborted) {
      documentLibrary.discardEdit(proposal.proposalId, sessionId);
      throw new RequestCancelledError();
    }
    if (!mainWindow || mainWindow.isDestroyed()) {
      documentLibrary.discardEdit(proposal.proposalId, sessionId);
      throw new Error('The document edit cannot be reviewed because the app window is unavailable.');
    }
    return new Promise((resolve, reject) => {
      const pending = {
        requestId,
        sessionId,
        proposal,
        signal,
        resolve,
        reject,
        abort: null,
        executing: false,
      };
      pending.abort = () => {
        pendingDocumentEditRequests.delete(proposal.proposalId);
        documentLibrary.discardEdit(proposal.proposalId, sessionId);
        reject(new RequestCancelledError());
      };
      pendingDocumentEditRequests.set(proposal.proposalId, pending);
      signal.addEventListener('abort', pending.abort, { once: true });
      publishDocumentEditRequest({
        requestId,
        sessionId,
        proposalId: proposal.proposalId,
        name: proposal.name,
        oldContent: proposal.oldContent,
        newContent: proposal.newContent,
      });
    });
  });
}

function finishDocumentEditRequest(proposalId, pending, error, result) {
  if (pendingDocumentEditRequests.get(proposalId) !== pending) return;
  pendingDocumentEditRequests.delete(proposalId);
  pending.signal.removeEventListener('abort', pending.abort);
  if (error) pending.reject(error);
  else pending.resolve(result);
}

function rejectPendingDocumentEdits(message) {
  for (const [proposalId, pending] of pendingDocumentEditRequests) {
    documentLibrary.discardEdit(proposalId, pending.sessionId);
    finishDocumentEditRequest(proposalId, pending, new Error(message));
  }
}

const requestQueue = createRequestQueue({
  maxWaitingRequests: 10,
  onStateChange: publishRequestStatus,
});

function waitForAbort(promise, signal) {
  if (signal.aborted) return Promise.reject(new RequestCancelledError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new RequestCancelledError());
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

async function getAssistant(signal) {
  if (signal.aborted) throw new RequestCancelledError();
  await waitForAbort(contextTransition, signal);
  const endpoint = await modelManager.ensureReady(publishActivity);
  if (signal.aborted) throw new RequestCancelledError();
  return createAssistantService({
    generate: async (
      systemPrompt,
      userPrompt,
      maxTokens,
      onChunk,
      _onFinish,
      allowTerminalCommands,
      allowDocumentEdits,
      allowDocumentSearch,
      allowFolderTools,
    ) => {
      const inactivityTimeout = createInactivityTimeout(
        RESPONSE_INACTIVITY_TIMEOUT_MS,
        `Local assistant did not stream response data for ${RESPONSE_INACTIVITY_TIMEOUT_MS / 1_000} seconds.`,
      );
      try {
        const tools = [];
        if (allowTerminalCommands) {
          tools.push({
            type: 'function',
            function: {
              name: 'run_terminal_command',
              description: 'Run a shell command in the current conversation after the user approves it.',
              parameters: {
                type: 'object',
                properties: { command: { type: 'string' } },
                required: ['command'],
                additionalProperties: false,
              },
            },
          });
        }
        if (allowDocumentEdits) {
          tools.push({
            type: 'function',
            function: {
              name: 'propose_document_edit',
              description: 'Propose new complete content for an attached text file. The app shows a diff and requires approval before writing.',
              parameters: {
                type: 'object',
                properties: {
                  documentId: { type: 'string' },
                  content: { type: 'string' },
                },
                required: ['documentId', 'content'],
                additionalProperties: false,
              },
            },
          });
        }
        if (allowDocumentSearch) {
          tools.push({
            type: 'function',
            function: {
              name: 'search_attached_documents',
              description: 'Search files and folders attached to this conversation for relevant passages. Set includeIgnored to true only when ignored/generated files are relevant to the task.',
              parameters: {
                type: 'object',
                properties: {
                  query: { type: 'string' },
                  includeIgnored: { type: 'boolean' },
                },
                required: ['query'],
                additionalProperties: false,
              },
            },
          });
          tools.push({
            type: 'function',
            function: {
              name: 'read_attached_document',
              description: 'Read a bounded relevant passage from a document previously found in the attached documents.',
              parameters: {
                type: 'object',
                properties: {
                  documentId: { type: 'string' },
                  query: { type: 'string' },
                },
                required: ['documentId'],
                additionalProperties: false,
              },
            },
          });
        }
        if (allowFolderTools) {
          tools.push({
            type: 'function',
            function: {
              name: 'list_directory',
              description: 'List visible supported files and folders under one attached folder. Paths are relative to folderId; depth is limited to 3. Set includeIgnored only when relevant to the task.',
              parameters: {
                type: 'object',
                properties: {
                  folderId: { type: 'string' },
                  path: { type: 'string' },
                  depth: { type: 'integer', minimum: 0, maximum: 3 },
                  includeIgnored: { type: 'boolean' },
                },
                required: ['folderId'],
                additionalProperties: false,
              },
            },
          });
          tools.push({
            type: 'function',
            function: {
              name: 'read_file',
              description: 'Read a supported text file inside one attached folder using a relative path. Reads are paginated by line offset; each result is capped at 2,000 lines and 50 KB.',
              parameters: {
                type: 'object',
                properties: {
                  folderId: { type: 'string' },
                  path: { type: 'string' },
                  offset: { type: 'integer', minimum: 0 },
                  limit: { type: 'integer', minimum: 1, maximum: 2_000 },
                  includeIgnored: { type: 'boolean' },
                },
                required: ['folderId', 'path'],
                additionalProperties: false,
              },
            },
          });
          tools.push({
            type: 'function',
            function: {
              name: 'grep',
              description: 'Search a specific attached folder for regular-expression matches. Optionally scope by relative directory and filename glob. Output and scan volume are capped.',
              parameters: {
                type: 'object',
                properties: {
                  folderId: { type: 'string' },
                  pattern: { type: 'string' },
                  path: { type: 'string' },
                  glob: { type: 'string' },
                  includeIgnored: { type: 'boolean' },
                },
                required: ['folderId', 'pattern'],
                additionalProperties: false,
              },
            },
          });
        }
        const response = await fetch(`${endpoint.url}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: endpoint.model,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
            ...(tools.length > 0 ? {
              tools,
              tool_choice: 'auto',
            } : {}),
            temperature: 0.2,
            max_tokens: maxTokens,
            stream: true,
          }),
          signal: AbortSignal.any([signal, inactivityTimeout.signal]),
        });
        if (!response.ok) {
          throw new Error(`Local assistant returned HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
        }
        const completion = await readChatCompletionStream(
          response.body,
          onChunk ?? (() => {}),
          inactivityTimeout.reset,
        );
        return { ...completion, answer: completion.answer.trim() };
      } finally {
        inactivityTimeout.dispose();
      }
    },
  });
}

function registerIpc() {
  const trustedHandler = (handler) => async (event, ...args) => {
    const rendererPath = join(here, '..', 'desktop', 'index.html');
    if (event.senderFrame !== event.sender.mainFrame
      || !isTrustedRendererUrl(event.senderFrame?.url, rendererPath)) {
      throw new Error('Untrusted renderer attempted to access the local assistant.');
    }
    return handler(event, ...args);
  };
  ipcMain.handle('livingwords:status', trustedHandler(async () => {
    return modelManager.getStatus();
  }));
  ipcMain.handle('livingwords:context-window:get', trustedHandler(() => ({
    contextWindowTokens,
    responseTokenLimit: responseTokenLimitForContext(contextWindowTokens),
    settingsError: contextSettingsLoadError,
  })));
  ipcMain.handle('livingwords:context-window:set', trustedHandler(async (_event, value) => {
    const nextContextWindowTokens = validateContextWindowTokens(value);
    if (nextContextWindowTokens === contextWindowTokens) {
      return {
        contextWindowTokens,
        responseTokenLimit: responseTokenLimitForContext(contextWindowTokens),
      };
    }
    await contextSettingsStore.save(nextContextWindowTokens);
    contextWindowTokens = nextContextWindowTokens;
    contextSettingsLoadError = null;
    modelManager.setContextWindowTokens(nextContextWindowTokens);
    const activeRequestId = requestQueue.activeRequestId;
    if (activeRequestId) requestQueue.cancel(activeRequestId);

    const selectedPreset = contextWindowPreset(nextContextWindowTokens);
    publishActivity({
      kind: 'model',
      message: `Restarting the local model with a ${selectedPreset.label} context window…`,
    });
    const transition = contextTransition.catch(() => {}).then(() => modelManager.restart(publishActivity));
    contextTransition = transition;
    void transition.catch((error) => {
      publishActivity({
        kind: 'startup-error',
        message: `Local assistant could not restart: ${error instanceof Error ? error.message : String(error)}`,
      });
    });
    return {
      contextWindowTokens,
      responseTokenLimit: responseTokenLimitForContext(contextWindowTokens),
    };
  }));
  ipcMain.handle('livingwords:clipboard:read-text', trustedHandler(() => clipboard.readText()));
  ipcMain.handle('livingwords:clipboard:write-text', trustedHandler((_event, text) => {
    if (typeof text !== 'string') throw new Error('Clipboard content must be text.');
    clipboard.writeText(text);
  }));
  ipcMain.handle('livingwords:documents:list', trustedHandler(async (_event, sessionId) => {
    await conversationStore.get(sessionId);
    return documentLibrary.list(sessionId);
  }));
  ipcMain.handle('livingwords:documents:list-cached', trustedHandler(async (_event, sessionId) => {
    await conversationStore.get(sessionId);
    return documentLibrary.listCached(sessionId);
  }));
  ipcMain.handle('livingwords:documents:content', trustedHandler(async (_event, fileId, sessionId) => {
    await conversationStore.get(sessionId);
    return documentLibrary.readContent(sessionId, fileId);
  }));
  ipcMain.handle('livingwords:documents:import', trustedHandler(async (_event, sessionId) => {
    await conversationStore.get(sessionId);
    const selection = await dialog.showOpenDialog(mainWindow, {
      title: 'Add documents to LivingWords',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Supported documents', extensions: SUPPORTED_DOCUMENT_EXTENSIONS }],
    });
    if (selection.canceled) return { canceled: true, results: [] };
    return {
      canceled: false,
      results: await serializeSessionWrite(async () => {
        return addDocumentReferencesToSession(sessionId, () =>
          documentLibrary.addFiles(selection.filePaths, sessionId));
      }),
    };
  }));
  ipcMain.handle('livingwords:documents:add-folder', trustedHandler(async (_event, sessionId) => {
    await conversationStore.get(sessionId);
    const selection = await dialog.showOpenDialog(mainWindow, {
      title: 'Add a folder to this conversation',
      properties: ['openDirectory'],
    });
    if (selection.canceled || selection.filePaths.length === 0) return { canceled: true };
    return serializeSessionWrite(async () => {
      return addDocumentReferencesToSession(sessionId, () =>
        documentLibrary.addFolder(selection.filePaths[0], sessionId));
    });
  }));
  ipcMain.handle('livingwords:documents:remove', trustedHandler((_event, id, sessionId) =>
    serializeSessionWrite(async () => {
      await conversationStore.get(sessionId);
      await documentLibrary.remove(id, sessionId, (retainedFileIds) =>
        conversationStore.removeDocumentSelection(id, sessionId, retainedFileIds));
      return conversationStore.get(sessionId);
    })));
  ipcMain.handle('livingwords:sessions:list', trustedHandler(() => conversationStore.list()));
  ipcMain.handle('livingwords:sessions:create', trustedHandler(() =>
    serializeSessionWrite(() => conversationStore.create())));
  ipcMain.handle('livingwords:sessions:save', trustedHandler((_event, session) =>
    serializeSessionWrite(() => conversationStore.save(session))));
  ipcMain.handle('livingwords:sessions:delete', trustedHandler((_event, id) =>
    serializeSessionWrite(async () => {
      let conversationDeleted = false;
      try {
        await documentLibrary.removeSession(id, async () => {
          await conversationStore.delete(id);
          conversationDeleted = true;
        });
      } catch (error) {
        if (!conversationDeleted) throw error;
        terminalManager.closeSession(id);
        return { cleanupWarning: error instanceof Error ? error.message : String(error) };
      }
      terminalManager.closeSession(id);
      return { cleanupWarning: null };
    })));
  ipcMain.handle('livingwords:terminal:create', trustedHandler((_event, request) => {
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      throw new Error('Terminal request is invalid.');
    }
    return terminalManager.create(request);
  }));
  ipcMain.handle('livingwords:terminal:write', trustedHandler((_event, terminalId, data) =>
    terminalManager.write(terminalId, data)));
  ipcMain.handle('livingwords:terminal:resize', trustedHandler((_event, terminalId, cols, rows) =>
    terminalManager.resize(terminalId, cols, rows)));
  ipcMain.handle('livingwords:terminal:close', trustedHandler((_event, terminalId, sessionId) =>
    terminalManager.close(terminalId, sessionId)));
  ipcMain.handle('livingwords:terminal:command-response', trustedHandler(async (_event, response) => {
    if (!response || typeof response !== 'object' || Array.isArray(response)
      || typeof response.commandId !== 'string' || !response.commandId
      || !['approve', 'decline', 'error'].includes(response.decision)) {
      throw new Error('Terminal command response is invalid.');
    }
    const pending = pendingCommandRequests.get(response.commandId);
    if (!pending || pending.signal.aborted) throw new Error('This terminal command request is no longer active.');
    if (pending.executing) throw new Error('This terminal command request is already being handled.');
    if (response.decision === 'decline') {
      finishTerminalCommandRequest(response.commandId, pending, null,
        'The user declined to run this command. It was not executed.');
      return { declined: true };
    }
    if (response.decision === 'error') {
      const message = typeof response.error === 'string' && response.error.length <= 500
        ? response.error
        : 'The terminal could not be prepared.';
      finishTerminalCommandRequest(response.commandId, pending,
        new Error(`Terminal command was not run: ${message}`));
      return { declined: false };
    }
    if (typeof response.terminalId !== 'string' || !response.terminalId) {
      throw new Error('A ready terminal is required to run this command.');
    }
    pending.executing = true;
    try {
      const output = await terminalManager.execute(
        response.terminalId,
        pending.sessionId,
        pending.command,
        pending.signal,
      );
      finishTerminalCommandRequest(response.commandId, pending, null, output);
      return { declined: false, output };
    } catch (error) {
      finishTerminalCommandRequest(response.commandId, pending, error);
      throw error;
    }
  }));
  ipcMain.handle('livingwords:document:edit-response', trustedHandler(async (_event, response) => {
    if (!response || typeof response !== 'object' || Array.isArray(response)
      || typeof response.proposalId !== 'string' || !response.proposalId
      || typeof response.sessionId !== 'string' || !response.sessionId
      || !['approve', 'decline'].includes(response.decision)) {
      throw new Error('Document edit response is invalid.');
    }
    const pending = pendingDocumentEditRequests.get(response.proposalId);
    if (!pending || pending.sessionId !== response.sessionId || pending.signal.aborted) {
      throw new Error('This document edit request is no longer active.');
    }
    if (pending.executing) throw new Error('This document edit request is already being handled.');
    if (response.decision === 'decline') {
      documentLibrary.discardEdit(response.proposalId, pending.sessionId);
      finishDocumentEditRequest(
        response.proposalId,
        pending,
        null,
        'The user declined the proposed edit. The file was not changed.',
      );
      return { applied: false };
    }
    pending.executing = true;
    try {
      const result = await documentLibrary.applyEdit(response.proposalId, pending.sessionId);
      finishDocumentEditRequest(
        response.proposalId,
        pending,
        null,
        `The user approved the edit and the file "${result.name}" was updated.`,
      );
      return { applied: true, name: result.name };
    } catch (error) {
      finishDocumentEditRequest(response.proposalId, pending, error);
      throw error;
    }
  }));
  ipcMain.handle('livingwords:ask', trustedHandler(async (_event, requestId, sessionId, question, rawHistory, rawTerminalContext) => {
    if (typeof requestId !== 'string' || !requestId || requestId.length > 128
      || typeof sessionId !== 'string' || !sessionId || sessionId.length > 128) {
      throw new Error('Request or conversation ID is invalid.');
    }
    if (typeof question !== 'string' || !question.trim() || question.length > 12_000) {
      throw new Error('Enter a question of 1–12,000 characters.');
    }
    const history = validateHistory(rawHistory);
    if (rawTerminalContext !== undefined
      && (typeof rawTerminalContext !== 'string'
        || rawTerminalContext.length > MAX_TERMINAL_CONTEXT_LENGTH)) {
      throw new Error(`Terminal context must contain at most ${MAX_TERMINAL_CONTEXT_LENGTH} characters.`);
    }
    const terminalContext = rawTerminalContext?.trim() ?? '';
    const session = await conversationStore.get(sessionId);
    let documentReferences = [];
    if (session.selectedDocumentIds.length > 0) {
      const listing = await documentLibrary.listCached(sessionId);
      const selectedIds = new Set(session.selectedDocumentIds);
      documentReferences = listing.references.filter((reference) => selectedIds.has(reference.id));
      if (documentReferences.length !== selectedIds.size) {
        throw new Error('One or more attached document references are unavailable. Remove and reattach them before asking about their contents.');
      }
    }
    const isProjectOverviewRequest = documentReferences.some((reference) => reference.kind === 'folder')
      && /\b(project|repository|repo|codebase|code base)\b/iu.test(question)
      && /\b(look|review|understand|about|overview|summarize|summarise|explain|describe|tell)\b/iu.test(question);
    const folderReferenceIds = documentReferences
      .filter((reference) => reference.kind === 'folder')
      .map((reference) => reference.id);
    let documentSources = [];
    const usedDocumentIds = new Set();
    const contextUsage = [];
    let streamedAnswer = '';
    const result = requestQueue.enqueue({
      requestId,
      sessionId,
      run: async (signal) => {
        const assistant = await waitForAbort(getAssistant(signal), signal);
        const folderContexts = folderReferenceIds.length > 0
          ? await waitForAbort(documentLibrary.folderContext(sessionId, folderReferenceIds), signal)
          : [];
        if (isProjectOverviewRequest) {
          const overviewQuery = `${question.slice(0, 1_500)} README purpose overview architecture application functionality`;
          const overviewSources = await waitForAbort(documentLibrary.search(
            sessionId,
            session.selectedDocumentIds,
            overviewQuery,
            { maxCharacters: 8_000, maxResults: 5, prioritizeOverview: true },
          ), signal);
          documentSources = overviewSources.map((source, index) => ({
            ...source,
            citationId: `S${index + 1}`,
          }));
        }
        let finishReason = null;
        const generatedAnswer = await assistant.ask(question, {
          history,
          terminalContext,
          documentReferences,
          documentSources,
          folderContexts,
          maxTokens: responseTokenLimitForContext(contextWindowTokens),
          runTerminalCommand: (command) => requestTerminalCommand({
            requestId,
            sessionId,
            command,
            signal,
          }),
          proposeDocumentEdit: documentReferences.length > 0
            ? (documentId, content) => requestDocumentEdit({
              requestId,
              sessionId,
              documentId,
              content,
              signal,
            })
            : undefined,
          searchDocuments: documentReferences.length > 0
            ? (query, includeIgnored) => documentLibrary.search(
              sessionId,
              session.selectedDocumentIds,
              query,
              { includeIgnored },
            )
            : undefined,
          readDocument: documentReferences.length > 0
            ? (documentId, query) => documentLibrary.readExcerpt(
              sessionId,
              session.selectedDocumentIds,
              documentId,
              query,
            )
            : undefined,
          listDirectory: folderReferenceIds.length > 0
            ? (folderId, path, depth, includeIgnored) => waitForAbort(documentLibrary.listDirectory(
              sessionId,
              folderId,
              path,
              depth,
              includeIgnored,
            ), signal)
            : undefined,
          readFile: folderReferenceIds.length > 0
            ? (folderId, path, offset, limit, includeIgnored) => waitForAbort(documentLibrary.readFolderFile(
              sessionId,
              folderId,
              path,
              offset,
              limit,
              includeIgnored,
            ), signal)
            : undefined,
          grep: folderReferenceIds.length > 0
            ? (folderId, pattern, path, glob, includeIgnored) => waitForAbort(documentLibrary.grep(
              sessionId,
              folderId,
              pattern,
              path,
              glob,
              includeIgnored,
            ), signal)
            : undefined,
          onDocumentContextUsed: (documentId, usage) => {
            usedDocumentIds.add(documentId);
            if (contextUsage.length < 100) contextUsage.push(usage);
          },
          onChunk: (chunk) => {
            streamedAnswer += chunk;
            publishRequestChunk({ requestId, sessionId, chunk });
          },
          onFinish: (reason) => { finishReason = reason; },
        });
        const citedAnswer = sanitizeCitedAnswer(generatedAnswer, documentSources);
        return {
          answer: citedAnswer.answer,
          sources: citedAnswer.sources,
          contextUsage,
          retrievedDocumentIds: [...usedDocumentIds],
          finishReason,
        };
      },
    });
    result.then(
      ({ answer, sources, contextUsage, finishReason }) =>
        publishRequestResult({
          requestId,
          sessionId,
          status: 'completed',
          answer,
          sources,
          contextUsage,
          retrievedDocumentIds: [...usedDocumentIds],
          finishReason,
        }),
      (error) => {
        const failure = {
          requestId,
          sessionId,
          status: error?.code === 'REQUEST_CANCELLED' ? 'cancelled' : 'failed',
          contextUsage,
          retrievedDocumentIds: [...usedDocumentIds],
          ...(error?.code === 'REQUEST_CANCELLED'
            ? {}
            : { error: error instanceof Error ? error.message : String(error) }),
        };
        if (streamedAnswer) {
          const partialAnswer = sanitizeCitedAnswer(streamedAnswer, documentSources);
          publishRequestResult({
            ...failure,
            answer: partialAnswer.answer,
            sources: partialAnswer.sources,
            contextUsage,
            retrievedDocumentIds: [...usedDocumentIds],
          });
        } else {
          publishRequestResult(failure);
        }
      },
    );
    return { requestId };
  }));
  ipcMain.handle('livingwords:cancel', trustedHandler((_event, requestId) => {
    if (typeof requestId !== 'string' || !requestId || requestId.length > 128) {
      throw new Error('Request ID is invalid.');
    }
    const cancellation = requestQueue.cancel(requestId);
    if (!cancellation) return false;
    return serializeSessionWrite(async () => {
      await conversationStore.appendMessage(cancellation.sessionId, {
        role: 'assistant',
        content: 'This response was cancelled.',
        status: 'cancelled',
      });
      return true;
    }).catch((error) => {
      throw new Error(`Request was cancelled, but its cancellation marker could not be saved: ${error.message}`, {
        cause: error,
      });
    });
  }));
}

function openSettings() {
  const window = mainWindow;
  if (!window || window.isDestroyed()) return;
  const sendOpenSettings = () => {
    if (!window.isDestroyed()) window.webContents.send('livingwords:open-settings');
  };
  if (window.webContents.isLoading()) window.webContents.once('did-finish-load', sendOpenSettings);
  else sendOpenSettings();
}

function openAbout() {
  const window = mainWindow;
  if (!window || window.isDestroyed()) return;
  const sendOpenAbout = () => {
    if (!window.isDestroyed()) {
      window.webContents.send('livingwords:open-about', { version: app.getVersion() });
    }
  };
  if (window.webContents.isLoading()) window.webContents.once('did-finish-load', sendOpenAbout);
  else sendOpenAbout();
}

function installApplicationMenu() {
  const aboutItem = {
    label: 'About LivingWords AI',
    click: openAbout,
  };
  const editMenu = {
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { type: 'separator' },
      { role: 'selectAll' },
    ],
  };
  const viewMenu = {
    label: 'View',
    submenu: [
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { role: 'resetZoom' },
    ],
  };
  const settingsItem = {
    label: 'Settings…',
    accelerator: 'CommandOrControl+,',
    click: openSettings,
  };
  const fileMenu = {
    label: 'File',
    submenu: process.platform === 'darwin'
      ? [{ role: 'close' }]
      : [settingsItem, { type: 'separator' }, { role: 'quit' }],
  };
  const windowMenu = {
    label: 'Window',
    submenu: [
      { role: 'minimize' },
      { role: 'zoom' },
      { type: 'separator' },
      { role: 'front' },
    ],
  };
  const helpMenu = {
    label: 'Help',
    submenu: [aboutItem],
  };
  const template = process.platform === 'darwin'
    ? [{
      label: 'LivingWords AI',
      submenu: [
        aboutItem,
        { type: 'separator' },
        settingsItem,
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }, fileMenu, editMenu, viewMenu, windowMenu, helpMenu]
    : [fileMenu, editMenu, viewMenu, windowMenu, helpMenu];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function confirmTerminalShutdown(parentWindow) {
  const terminalCount = terminalManager.activeCount;
  if (terminalCount === 0) return true;
  const response = dialog.showMessageBoxSync(parentWindow, {
    type: 'warning',
    buttons: ['Continue closing', 'Keep LivingWords open'],
    defaultId: 1,
    cancelId: 1,
    title: 'Active terminals will be closed',
    message: `There ${terminalCount === 1 ? 'is' : 'are'} ${terminalCount} active terminal${terminalCount === 1 ? '' : 's'}.`,
    detail: 'Continuing will close these terminal sessions. Terminal tabs and their session output will not be restored when you reopen the app.',
  });
  return response === 0;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: '#11120f',
    title: APP_NAME,
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.on('close', (event) => {
    if (!isQuitting && !confirmTerminalShutdown(mainWindow)) event.preventDefault();
  });
  mainWindow.on('closed', () => {
    terminalManager.closeAll();
    rejectPendingTerminalCommands('The app window closed before the terminal command completed.');
    rejectPendingDocumentEdits('The app window closed before the document edit could be reviewed.');
    mainWindow = null;
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (URL.canParse(url)) {
      const externalUrl = new URL(url);
      if (externalUrl.protocol === 'https:' && allowedExternalHosts.has(externalUrl.hostname)) {
        void shell.openExternal(externalUrl.href).catch((error) => {
          console.error(`Could not open external link: ${error.message}`);
        });
      }
    }
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== pathToFileURL(join(here, '..', 'desktop', 'index.html')).href) event.preventDefault();
  });
  void mainWindow.loadFile(join(here, '..', 'desktop', 'index.html'));
}

app.whenReady().then(async () => {
  if (process.platform === 'darwin') {
    const dockIcon = nativeImage.createFromPath(join(here, '..', 'desktop', 'assets', 'lw-macos-icon.png'));
    if (dockIcon.isEmpty()) throw new Error('Could not load the LivingWords macOS Dock icon.');
    app.dock.setIcon(dockIcon);
  }
  const ownershipMigration = await documentLibrary.migrateLegacyOwnership(await conversationStore.list());
  for (const sessionId of ownershipMigration.changedSessionIds) {
    const session = ownershipMigration.sessions.find((item) => item.id === sessionId);
    if (session) await conversationStore.save(session);
  }
  try {
    contextWindowTokens = await contextSettingsStore.load();
  } catch (error) {
    contextSettingsLoadError = error instanceof Error ? error.message : String(error);
    console.error(`Could not load local context window preference: ${contextSettingsLoadError}`);
  }
  modelManager.setContextWindowTokens(contextWindowTokens);
  installApplicationMenu();
  registerIpc();
  createWindow();
  void modelManager.ensureReady(publishActivity).catch((error) => {
    publishActivity({
      kind: 'startup-error',
      message: `Local assistant could not start: ${error.message}`,
    });
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', (event) => {
  if (isQuitting) return;
  if (!confirmTerminalShutdown(mainWindow)) {
    event.preventDefault();
    return;
  }
  event.preventDefault();
  isQuitting = true;
  terminalManager.closeAll();
  rejectPendingDocumentEdits('The app is closing before the document edit could be reviewed.');
  void modelManager.stop().finally(() => app.quit());
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
