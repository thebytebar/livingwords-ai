const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('livingWords', Object.freeze({
  status: () => ipcRenderer.invoke('livingwords:status'),
  getContextWindow: () => ipcRenderer.invoke('livingwords:context-window:get'),
  setContextWindow: (contextWindowTokens) =>
    ipcRenderer.invoke('livingwords:context-window:set', contextWindowTokens),
  readClipboardText: () => ipcRenderer.invoke('livingwords:clipboard:read-text'),
  writeClipboardText: (text) => ipcRenderer.invoke('livingwords:clipboard:write-text', text),
  listSessions: () => ipcRenderer.invoke('livingwords:sessions:list'),
  createSession: () => ipcRenderer.invoke('livingwords:sessions:create'),
  saveSession: (session) => ipcRenderer.invoke('livingwords:sessions:save', session),
  deleteSession: (id) => ipcRenderer.invoke('livingwords:sessions:delete', id),
  ask: (requestId, sessionId, question, history, terminalContext) =>
    ipcRenderer.invoke('livingwords:ask', requestId, sessionId, question, history, terminalContext),
  createTerminal: (request) => ipcRenderer.invoke('livingwords:terminal:create', request),
  writeTerminal: (terminalId, data) => ipcRenderer.invoke('livingwords:terminal:write', terminalId, data),
  resizeTerminal: (terminalId, cols, rows) =>
    ipcRenderer.invoke('livingwords:terminal:resize', terminalId, cols, rows),
  closeTerminal: (terminalId, sessionId) =>
    ipcRenderer.invoke('livingwords:terminal:close', terminalId, sessionId),
  respondToTerminalCommand: (response) =>
    ipcRenderer.invoke('livingwords:terminal:command-response', response),
  onTerminalData: (listener) => {
    if (typeof listener !== 'function') throw new TypeError('Terminal data listener must be a function.');
    const handler = (_event, data) => listener(data);
    ipcRenderer.on('livingwords:terminal-data', handler);
    return () => ipcRenderer.removeListener('livingwords:terminal-data', handler);
  },
  onTerminalExit: (listener) => {
    if (typeof listener !== 'function') throw new TypeError('Terminal exit listener must be a function.');
    const handler = (_event, status) => listener(status);
    ipcRenderer.on('livingwords:terminal-exit', handler);
    return () => ipcRenderer.removeListener('livingwords:terminal-exit', handler);
  },
  onTerminalCommandRequest: (listener) => {
    if (typeof listener !== 'function') throw new TypeError('Terminal command listener must be a function.');
    const handler = (_event, request) => listener(request);
    ipcRenderer.on('livingwords:terminal:command-request', handler);
    return () => ipcRenderer.removeListener('livingwords:terminal:command-request', handler);
  },
  cancel: (requestId) => ipcRenderer.invoke('livingwords:cancel', requestId),
  onOpenSettings: (listener) => {
    if (typeof listener !== 'function') throw new TypeError('Settings listener must be a function.');
    const handler = () => listener();
    ipcRenderer.on('livingwords:open-settings', handler);
    return () => ipcRenderer.removeListener('livingwords:open-settings', handler);
  },
  onOpenAbout: (listener) => {
    if (typeof listener !== 'function') throw new TypeError('About listener must be a function.');
    const handler = (_event, details) => listener(details);
    ipcRenderer.on('livingwords:open-about', handler);
    return () => ipcRenderer.removeListener('livingwords:open-about', handler);
  },
  onActivity: (listener) => {
    if (typeof listener !== 'function') throw new TypeError('Activity listener must be a function.');
    const handler = (_event, activity) => listener(activity);
    ipcRenderer.on('livingwords:activity', handler);
    return () => ipcRenderer.removeListener('livingwords:activity', handler);
  },
  onRequestStatus: (listener) => {
    if (typeof listener !== 'function') throw new TypeError('Request status listener must be a function.');
    const handler = (_event, status) => listener(status);
    ipcRenderer.on('livingwords:request-status', handler);
    return () => ipcRenderer.removeListener('livingwords:request-status', handler);
  },
  onRequestChunk: (listener) => {
    if (typeof listener !== 'function') throw new TypeError('Response chunk listener must be a function.');
    const handler = (_event, chunk) => listener(chunk);
    ipcRenderer.on('livingwords:request-chunk', handler);
    return () => ipcRenderer.removeListener('livingwords:request-chunk', handler);
  },
  onRequestResult: (listener) => {
    if (typeof listener !== 'function') throw new TypeError('Request result listener must be a function.');
    const handler = (_event, result) => listener(result);
    ipcRenderer.on('livingwords:request-result', handler);
    return () => ipcRenderer.removeListener('livingwords:request-result', handler);
  },
}));
