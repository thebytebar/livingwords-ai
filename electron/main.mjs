import { app, BrowserWindow, clipboard, ipcMain, Menu, nativeImage, shell } from 'electron';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readChatCompletionStream } from './chat-completion-stream.mjs';
import { createAssistantService } from '../dist/core/assistant.js';
import { createConversationStore } from './conversation-store.mjs';
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
    generate: async (systemPrompt, userPrompt, maxTokens, onChunk, _onFinish, allowTerminalCommands) => {
      const inactivityTimeout = createInactivityTimeout(
        RESPONSE_INACTIVITY_TIMEOUT_MS,
        `Local assistant did not stream response data for ${RESPONSE_INACTIVITY_TIMEOUT_MS / 1_000} seconds.`,
      );
      try {
        const response = await fetch(`${endpoint.url}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: endpoint.model,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
            ...(allowTerminalCommands ? {
              tools: [{
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
              }],
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
  ipcMain.handle('livingwords:sessions:list', trustedHandler(() => conversationStore.list()));
  ipcMain.handle('livingwords:sessions:create', trustedHandler(() =>
    serializeSessionWrite(() => conversationStore.create())));
  ipcMain.handle('livingwords:sessions:save', trustedHandler((_event, session) =>
    serializeSessionWrite(() => conversationStore.save(session))));
  ipcMain.handle('livingwords:sessions:delete', trustedHandler((_event, id) =>
    serializeSessionWrite(async () => {
      await conversationStore.delete(id);
      terminalManager.closeSession(id);
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
    const result = requestQueue.enqueue({
      requestId,
      sessionId,
      run: async (signal) => {
        const assistant = await waitForAbort(getAssistant(signal), signal);
        let finishReason = null;
        const answer = await assistant.ask(question, {
          history,
          terminalContext,
          maxTokens: responseTokenLimitForContext(contextWindowTokens),
          runTerminalCommand: (command) => requestTerminalCommand({
            requestId,
            sessionId,
            command,
            signal,
          }),
          onChunk: (chunk) => publishRequestChunk({ requestId, sessionId, chunk }),
          onFinish: (reason) => { finishReason = reason; },
        });
        return { answer, finishReason };
      },
    });
    result.then(
      ({ answer, finishReason }) =>
        publishRequestResult({ requestId, sessionId, status: 'completed', answer, finishReason }),
      (error) => publishRequestResult({
        requestId,
        sessionId,
        status: error?.code === 'REQUEST_CANCELLED' ? 'cancelled' : 'failed',
        ...(error?.code === 'REQUEST_CANCELLED'
          ? {}
          : { error: error instanceof Error ? error.message : String(error) }),
      }),
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
  mainWindow.on('closed', () => {
    terminalManager.closeAll();
    rejectPendingTerminalCommands('The app window closed before the terminal command completed.');
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
  event.preventDefault();
  isQuitting = true;
  terminalManager.closeAll();
  void modelManager.stop().finally(() => app.quit());
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
