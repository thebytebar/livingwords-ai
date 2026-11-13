const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('livingWords', Object.freeze({
  status: () => ipcRenderer.invoke('livingwords:status'),
  getContextWindow: () => ipcRenderer.invoke('livingwords:context-window:get'),
  setContextWindow: (contextWindowTokens) =>
    ipcRenderer.invoke('livingwords:context-window:set', contextWindowTokens),
  getWebSearchSettings: (provider) => ipcRenderer.invoke('livingwords:web-search-settings:get', provider),
  setWebSearchSettings: (provider) =>
    ipcRenderer.invoke('livingwords:web-search-settings:set', provider),
  searchWeb: (sessionId, query) =>
    ipcRenderer.invoke('livingwords:web-search:query', sessionId, query),
  openWebSearch: (sessionId) =>
    ipcRenderer.invoke('livingwords:web-search:open', sessionId),
  listSkills: () => ipcRenderer.invoke('livingwords:skills:list'),
  saveSkill: (skill) => ipcRenderer.invoke('livingwords:skills:save', skill),
  deleteSkill: (id) => ipcRenderer.invoke('livingwords:skills:delete', id),
  setBrowserBounds: (sessionId, browserTabId, bounds, visible, viewportSize) =>
    ipcRenderer.invoke('livingwords:browser:bounds', sessionId, browserTabId, bounds, visible, viewportSize),
  searchBrowser: (sessionId, browserTabId, query) =>
    ipcRenderer.invoke('livingwords:browser:search', sessionId, browserTabId, query),
  navigateBrowser: (sessionId, browserTabId, url) =>
    ipcRenderer.invoke('livingwords:browser:navigate', sessionId, browserTabId, url),
  browserBack: (sessionId, browserTabId) =>
    ipcRenderer.invoke('livingwords:browser:back', sessionId, browserTabId),
  browserForward: (sessionId, browserTabId) =>
    ipcRenderer.invoke('livingwords:browser:forward', sessionId, browserTabId),
  reloadBrowser: (sessionId, browserTabId) =>
    ipcRenderer.invoke('livingwords:browser:reload', sessionId, browserTabId),
  closeBrowser: (sessionId, browserTabId) =>
    ipcRenderer.invoke('livingwords:browser:close', sessionId, browserTabId),
  readClipboardText: () => ipcRenderer.invoke('livingwords:clipboard:read-text'),
  writeClipboardText: (text) => ipcRenderer.invoke('livingwords:clipboard:write-text', text),
  listDocuments: (sessionId) => ipcRenderer.invoke('livingwords:documents:list', sessionId),
  listCachedDocuments: (sessionId) => ipcRenderer.invoke('livingwords:documents:list-cached', sessionId),
  readDocumentContent: (fileId, sessionId) =>
    ipcRenderer.invoke('livingwords:documents:content', fileId, sessionId),
  importDocuments: (sessionId) => ipcRenderer.invoke('livingwords:documents:import', sessionId),
  addDocumentFolder: (sessionId) => ipcRenderer.invoke('livingwords:documents:add-folder', sessionId),
  removeDocument: (id, sessionId) => ipcRenderer.invoke('livingwords:documents:remove', id, sessionId),
  listSessions: () => ipcRenderer.invoke('livingwords:sessions:list'),
  createSession: () => ipcRenderer.invoke('livingwords:sessions:create'),
  saveSession: (session) => ipcRenderer.invoke('livingwords:sessions:save', session),
  deleteSession: (id) => ipcRenderer.invoke('livingwords:sessions:delete', id),
  ask: (
    requestId,
    sessionId,
    question,
    history,
    rightPanelTabs,
    selectedToolNames,
    taggedQuestion,
    selectedSkillId,
  ) =>
    ipcRenderer.invoke(
      'livingwords:ask',
      requestId,
      sessionId,
      question,
      history,
      rightPanelTabs,
      selectedToolNames,
      taggedQuestion,
      selectedSkillId,
    ),
  createTerminal: (request) => ipcRenderer.invoke('livingwords:terminal:create', request),
  writeTerminal: (terminalId, data) => ipcRenderer.invoke('livingwords:terminal:write', terminalId, data),
  resizeTerminal: (terminalId, cols, rows) =>
    ipcRenderer.invoke('livingwords:terminal:resize', terminalId, cols, rows),
  closeTerminal: (terminalId, sessionId) =>
    ipcRenderer.invoke('livingwords:terminal:close', terminalId, sessionId),
  respondToTerminalCommand: (response) =>
    ipcRenderer.invoke('livingwords:terminal:command-response', response),
  respondToDocumentEdit: (response) =>
    ipcRenderer.invoke('livingwords:document:edit-response', response),
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
  onDocumentEditRequest: (listener) => {
    if (typeof listener !== 'function') throw new TypeError('Document edit listener must be a function.');
    const handler = (_event, request) => listener(request);
    ipcRenderer.on('livingwords:document:edit-request', handler);
    return () => ipcRenderer.removeListener('livingwords:document:edit-request', handler);
  },
  onSkillCreated: (listener) => {
    if (typeof listener !== 'function') throw new TypeError('Skill created listener must be a function.');
    const handler = (_event, request) => listener(request);
    ipcRenderer.on('livingwords:skill:created', handler);
    return () => ipcRenderer.removeListener('livingwords:skill:created', handler);
  },
  onSkillsUpdated: (listener) => {
    if (typeof listener !== 'function') throw new TypeError('Skills updated listener must be a function.');
    const handler = (_event, skills) => listener(skills);
    ipcRenderer.on('livingwords:skills:updated', handler);
    return () => ipcRenderer.removeListener('livingwords:skills:updated', handler);
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
  onRequestTrace: (listener) => {
    if (typeof listener !== 'function') throw new TypeError('Request trace listener must be a function.');
    const handler = (_event, traceUpdate) => listener(traceUpdate);
    ipcRenderer.on('livingwords:request-trace', handler);
    return () => ipcRenderer.removeListener('livingwords:request-trace', handler);
  },
  onRequestResult: (listener) => {
    if (typeof listener !== 'function') throw new TypeError('Request result listener must be a function.');
    const handler = (_event, result) => listener(result);
    ipcRenderer.on('livingwords:request-result', handler);
    return () => ipcRenderer.removeListener('livingwords:request-result', handler);
  },
  onBrowserState: (listener) => {
    if (typeof listener !== 'function') throw new TypeError('Browser state listener must be a function.');
    const handler = (_event, state) => listener(state);
    ipcRenderer.on('livingwords:browser:state', handler);
    return () => ipcRenderer.removeListener('livingwords:browser:state', handler);
  },
  onBrowserActivate: (listener) => {
    if (typeof listener !== 'function') throw new TypeError('Browser activation listener must be a function.');
    const handler = (_event, request) => listener(request);
    ipcRenderer.on('livingwords:browser:activate', handler);
    return () => ipcRenderer.removeListener('livingwords:browser:activate', handler);
  },
  onWebSearchResults: (listener) => {
    if (typeof listener !== 'function') throw new TypeError('Web search results listener must be a function.');
    const handler = (_event, event) => listener(event);
    ipcRenderer.on('livingwords:web-search:results', handler);
    return () => ipcRenderer.removeListener('livingwords:web-search:results', handler);
  },
  onWebSearchStart: (listener) => {
    if (typeof listener !== 'function') throw new TypeError('Web search start listener must be a function.');
    const handler = (_event, event) => listener(event);
    ipcRenderer.on('livingwords:web-search:start', handler);
    return () => ipcRenderer.removeListener('livingwords:web-search:start', handler);
  },
  onWebSearchError: (listener) => {
    if (typeof listener !== 'function') throw new TypeError('Web search error listener must be a function.');
    const handler = (_event, event) => listener(event);
    ipcRenderer.on('livingwords:web-search:error', handler);
    return () => ipcRenderer.removeListener('livingwords:web-search:error', handler);
  },
  onRightPanelTabClosed: (listener) => {
    if (typeof listener !== 'function') throw new TypeError('Right-panel tab listener must be a function.');
    const handler = (_event, event) => listener(event);
    ipcRenderer.on('livingwords:right-panel:tab-closed', handler);
    return () => ipcRenderer.removeListener('livingwords:right-panel:tab-closed', handler);
  },
}));
