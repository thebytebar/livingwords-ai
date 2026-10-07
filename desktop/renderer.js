import { FitAddon } from '../node_modules/@xterm/addon-fit/lib/addon-fit.mjs';
import { Terminal } from '../node_modules/@xterm/xterm/lib/xterm.mjs';
import renderMathInElement from '../node_modules/katex/dist/contrib/auto-render.mjs';
import { clampSidePanelWidth, SIDE_PANEL_BOUNDS } from './panel-layout.mjs';
import { buildDocumentDiff } from './document-diff.mjs';
import { isNearScrollBottom, preservedScrollTop } from './chat-scroll.mjs';
import {
  contextUsageForDocument,
  documentContextCounts,
  flatContextFileName,
  folderCanExpand,
  mergeRetrievedDocumentIds,
  usedFolderDocuments,
} from './folder-context.mjs';
import { MAX_TERMINAL_CONTEXT_LENGTH, readTerminalContext } from './terminal-context.mjs';
import { createTerminalReadiness } from './terminal-readiness.mjs';
import { terminalThemeFromColors } from './terminal-theme.mjs';
import {
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  contextWindowPreset,
  responseTokenLimitForContext,
} from '../electron/context-window.mjs';

const api = window.livingWords;
const $ = (id) => document.getElementById(id);
const splashStartedAt = performance.now();
const welcome = $('welcome');
const messages = $('messages');
const prompt = $('question');
const sendButton = $('send');
const cancelButton = $('cancel');
const setupDialog = $('setup-dialog');
const settingsDialog = $('settings-dialog');
const aboutDialog = $('about-dialog');
const modelLicenseDialog = $('model-license-dialog');
const documentViewerDialog = $('document-viewer-dialog');
const removeDocumentDialog = $('remove-document-dialog');
const appShell = $('app-shell');
let contextWindowTokens = DEFAULT_CONTEXT_WINDOW_TOKENS;
let responseTokenLimit = responseTokenLimitForContext(contextWindowTokens);
let contextMeterTokens = contextWindowPreset(contextWindowTokens).meterTokens;
const SYSTEM_PROMPT = 'You are a helpful general-purpose assistant. Answer accurately, be clear, and acknowledge uncertainty when appropriate.';
const PANEL_WIDTHS = {
  sessions: { key: 'livingwords-sessions-width', fallback: 264 },
  info: { key: 'livingwords-info-width', fallback: 300 },
};
const INFO_STATE_KEY_PREFIX = 'livingwords-info-state:';
const MAX_DOCUMENT_REFERENCES = 100;
const MAX_DOCUMENT_CONTEXT_CHARS = 12_000;
let assistantAvailable = false;
let sessions = [];
let libraryDocuments = [];
let libraryFiles = [];
let libraryDocumentCount = 0;
let libraryUnindexedCount = 0;
let libraryLoadedSessionId = null;
let activeSessionId = null;
let responseMeterId = 0;
const requestStates = new Map();
const infoSessions = new Map();
const refreshingDocumentSessions = new Set();
let pendingDocumentRemoval = null;

function clampPanelWidth(panel, value) {
  return clampSidePanelWidth({
    panel,
    requestedWidth: value,
    viewportWidth: window.innerWidth,
    mobile: window.matchMedia('(max-width: 820px)').matches,
    tablet: window.matchMedia('(max-width: 1120px)').matches,
    infoOpen: !appShell.classList.contains('info-collapsed'),
    sessionsWidth: Number.parseFloat(getComputedStyle(appShell).getPropertyValue('--sessions-width')) || 264,
    infoWidth: Number.parseFloat(getComputedStyle(appShell).getPropertyValue('--info-width')) || 300,
  });
}

function setPanelWidth(panel, value, persist = true) {
  const config = PANEL_WIDTHS[panel];
  const width = clampPanelWidth(panel, value);
  appShell.style.setProperty(panel === 'sessions' ? '--sessions-width' : '--info-width', `${width}px`);
  const resizer = $(`${panel}-resizer`);
  resizer.setAttribute('aria-valuenow', String(width));
  resizer.setAttribute('aria-valuemax', String(clampPanelWidth(panel, SIDE_PANEL_BOUNDS[panel].max)));
  if (persist) localStorage.setItem(config.key, String(width));
}

function initializePanelWidths() {
  for (const [panel, config] of Object.entries(PANEL_WIDTHS)) {
    const saved = Number(localStorage.getItem(config.key));
    setPanelWidth(panel, Number.isFinite(saved) && saved > 0 ? saved : config.fallback, false);
  }
}

function installPanelResizer(panel) {
  const grip = $(`${panel}-resizer`);
  const isSessions = panel === 'sessions';
  let drag = null;
  const getWidth = () => Number.parseFloat(getComputedStyle(appShell).getPropertyValue(
    isSessions ? '--sessions-width' : '--info-width',
  )) || PANEL_WIDTHS[panel].fallback;
  const adjust = (amount) => setPanelWidth(panel, getWidth() + amount);

  grip.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    drag = { pointerId: event.pointerId, startX: event.clientX, startWidth: getWidth() };
    grip.setPointerCapture(event.pointerId);
    document.body.classList.add('resizing-panel');
  });
  grip.addEventListener('pointermove', (event) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const delta = event.clientX - drag.startX;
    setPanelWidth(panel, drag.startWidth + (isSessions ? delta : -delta));
  });
  const stopDragging = (event) => {
    if (!drag || (event && drag.pointerId !== event.pointerId)) return;
    drag = null;
    document.body.classList.remove('resizing-panel');
  };
  grip.addEventListener('pointerup', stopDragging);
  grip.addEventListener('pointercancel', stopDragging);
  grip.addEventListener('lostpointercapture', stopDragging);
  grip.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowRight') adjust(isSessions ? 10 : -10);
    else if (event.key === 'ArrowLeft') adjust(isSessions ? -10 : 10);
    else if (event.key === 'Home') setPanelWidth(panel, SIDE_PANEL_BOUNDS[panel].min);
    else if (event.key === 'End') setPanelWidth(panel, SIDE_PANEL_BOUNDS[panel].max);
    else return;
    event.preventDefault();
  });
}

function infoState(sessionId = activeSessionId) {
  if (!sessionId) return null;
  let state = infoSessions.get(sessionId);
  if (!state) {
    state = restoreInfoState(sessionId);
    infoSessions.set(sessionId, state);
  }
  const session = sessions.find((item) => item.id === sessionId);
  if ((session?.selectedDocumentIds ?? []).length > 0
    && !state.tabs.some((tab) => tab.kind === 'documents')) {
    const tab = createDocumentTab(sessionId);
    state.tabs.push(tab);
    if (!state.selectedId) state.selectedId = tab.id;
    persistInfoState(sessionId, state);
  }
  return state;
}

function createDocumentTab(sessionId) {
  return {
    id: window.crypto.randomUUID(),
    sessionId,
    kind: 'documents',
    title: 'Documents',
    surface: document.createElement('div'),
  };
}

function restoreInfoState(sessionId) {
  const serialized = localStorage.getItem(`${INFO_STATE_KEY_PREFIX}${sessionId}`);
  if (!serialized) return { tabs: [], selectedId: null, open: false };

  let saved;
  try {
    saved = JSON.parse(serialized);
  } catch (error) {
    console.error(`Could not restore the tools panel state for conversation ${sessionId}: ${error.message}`);
    return { tabs: [], selectedId: null, open: false };
  }
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) {
    console.error(`Could not restore the tools panel state for conversation ${sessionId}: saved state is invalid.`);
    return { tabs: [], selectedId: null, open: false };
  }

  const hasRestorableDocuments = saved.documents === true;
  const hadTerminalTabs = saved.terminals === true;
  const state = {
    tabs: [],
    selectedId: null,
    open: saved.open === true && (hasRestorableDocuments || !hadTerminalTabs),
  };
  if (hasRestorableDocuments) {
    const tab = createDocumentTab(sessionId);
    state.tabs.push(tab);
    state.selectedId = tab.id;
  }
  return state;
}

function persistInfoState(sessionId, state = infoSessions.get(sessionId)) {
  if (!sessionId || !state) return;
  localStorage.setItem(`${INFO_STATE_KEY_PREFIX}${sessionId}`, JSON.stringify({
    open: state.open,
    documents: state.tabs.some((tab) => tab.kind === 'documents'),
    terminals: state.tabs.some((tab) => tab.kind === 'terminal'),
  }));
}

function selectedTerminal(sessionId = activeSessionId) {
  const state = infoSessions.get(sessionId);
  return state?.tabs.find((tab) => tab.kind === 'terminal' && tab.id === state.selectedId) ?? null;
}

function terminalContext(sessionId = activeSessionId) {
  const tab = selectedTerminal(sessionId);
  return tab ? readTerminalContext(tab.terminal, MAX_TERMINAL_CONTEXT_LENGTH) : '';
}

function currentTerminalTheme() {
  const styles = getComputedStyle(document.documentElement);
  return terminalThemeFromColors({
    background: styles.getPropertyValue('--bg'),
    foreground: styles.getPropertyValue('--text'),
    accent: styles.getPropertyValue('--accent'),
    accentContrast: styles.getPropertyValue('--accent-contrast'),
  });
}

function renderInfoPanel() {
  const state = infoSessions.get(activeSessionId);
  const tabList = $('info-tab-list');
  const panels = $('info-tab-panels');
  const documentsMenuItem = $('info-add-menu').querySelector('[data-add-info-tab="documents"]');
  documentsMenuItem.hidden = Boolean(state?.tabs.some((tab) => tab.kind === 'documents'));
  if (![...$('info-add-menu').querySelectorAll('[role="menuitem"]')].some((item) => !item.hidden)) {
    $('info-add-menu').hidden = true;
    $('info-add-tab').setAttribute('aria-expanded', 'false');
  }
  tabList.replaceChildren();
  panels.replaceChildren();
  if (!state) return;

  for (const tab of state.tabs) {
    const selected = tab.id === state.selectedId;
    const wrapper = document.createElement('div');
    wrapper.className = 'info-tab';
    wrapper.classList.toggle('selected', selected);
    const select = document.createElement('button');
    select.type = 'button';
    select.id = `info-tab-${tab.id}`;
    select.className = 'info-tab-select';
    select.setAttribute('role', 'tab');
    select.setAttribute('aria-controls', `info-panel-${tab.id}`);
    select.setAttribute('aria-selected', String(selected));
    select.tabIndex = selected ? 0 : -1;
    select.textContent = tab.title;
    select.addEventListener('click', () => {
      state.selectedId = tab.id;
      persistInfoState(activeSessionId, state);
      renderInfoPanel();
      if (tab.kind === 'terminal') fitTerminal(tab);
      if (tab.kind === 'documents') void refreshDocumentLibrary(tab.sessionId);
      updateLimitMeters();
    });
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'info-tab-close';
    close.setAttribute('aria-label', `Close ${tab.title}`);
    close.title = `Close ${tab.title}`;
    close.textContent = '×';
    const session = sessions.find((item) => item.id === activeSessionId);
    const documentTabLocked = tab.kind === 'documents' && (session?.selectedDocumentIds ?? []).length > 0;
    close.hidden = documentTabLocked;
    close.setAttribute('aria-hidden', String(documentTabLocked));
    close.addEventListener('click', () => closeInfoTab(activeSessionId, tab.id));
    wrapper.append(select, close);
    tabList.append(wrapper);

    tab.surface.hidden = !selected;
    tab.surface.id = `info-panel-${tab.id}`;
    tab.surface.setAttribute('role', 'tabpanel');
    tab.surface.setAttribute('aria-labelledby', `info-tab-${tab.id}`);
    panels.append(tab.surface);
    if (tab.kind === 'documents') renderDocumentLibrarySurface(tab);
  }
}

function renderDocumentLibraryTabs(sessionId) {
  for (const tab of infoSessions.get(sessionId)?.tabs ?? []) {
    if (tab.kind === 'documents') renderDocumentLibrarySurface(tab);
  }
}

function fitTerminal(tab) {
  if (tab?.kind !== 'terminal') return;
  requestAnimationFrame(() => {
    if (!tab.surface.isConnected || tab.surface.hidden
      || tab.surface.clientWidth === 0 || tab.surface.clientHeight === 0) return;
    try {
      tab.fitAddon.fit();
      if (tab.started) {
        void api.resizeTerminal(tab.id, tab.terminal.cols, tab.terminal.rows).catch((error) => {
          showActivity({ kind: 'error', message: `Could not resize terminal: ${error.message}` });
        });
      }
    } catch (error) {
      showActivity({ kind: 'error', message: `Could not fit terminal to the panel: ${error.message}` });
    }
  });
}

async function waitForTerminalPanelReady(tab) {
  const deadline = performance.now() + 5_000;
  while (performance.now() < deadline) {
    if (!tab.surface.isConnected || tab.surface.hidden
      || tab.sessionId !== activeSessionId
      || appShell.classList.contains('info-collapsed')) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      continue;
    }
    const screen = tab.surface.querySelector('.xterm-screen');
    if (screen && tab.surface.clientWidth > 0 && tab.surface.clientHeight > 0) {
      tab.fitAddon.fit();
      const screenBounds = screen.getBoundingClientRect();
      if (tab.terminal.cols > 0 && tab.terminal.rows > 0
        && screenBounds.width > 0 && screenBounds.height > 0) {
        return;
      }
    }
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  throw new Error('The terminal panel did not finish initializing. Open the Tools panel and try again.');
}

async function addTerminalTab(sessionId) {
  if (!sessionId || !sessions.some((session) => session.id === sessionId)) return;
  const state = infoState(sessionId);
  const id = window.crypto.randomUUID();
  const title = 'Terminal';
  const terminal = new Terminal({
    cursorBlink: false,
    cursorStyle: 'block',
    cursorInactiveStyle: 'block',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: 12,
    scrollback: 1000,
    convertEol: true,
    theme: currentTerminalTheme(),
  });
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  const surface = document.createElement('div');
  surface.className = 'terminal-surface';
  const cursorMarker = document.createElement('span');
  cursorMarker.className = 'terminal-cursor-marker';
  cursorMarker.setAttribute('aria-hidden', 'true');
  surface.append(cursorMarker);
  const readiness = createTerminalReadiness();
  const tab = {
    id,
    sessionId,
    kind: 'terminal',
    title,
    terminal,
    fitAddon,
    surface,
    started: false,
    shellReady: false,
    readiness,
    resizeObserver: null,
  };
  state.tabs.push(tab);
  state.selectedId = id;
  persistInfoState(sessionId, state);
  renderInfoPanel();
  terminal.open(surface);
  function updateCursorMarker() {
    const screen = surface.querySelector('.xterm-screen');
    if (!screen || terminal.cols < 1 || terminal.rows < 1) {
      cursorMarker.hidden = true;
      return;
    }
    const surfaceRect = surface.getBoundingClientRect();
    const screenRect = screen.getBoundingClientRect();
    const cellWidth = screenRect.width / terminal.cols;
    const cellHeight = screenRect.height / terminal.rows;
    if (cellWidth <= 0 || cellHeight <= 0) {
      cursorMarker.hidden = true;
      return;
    }
    const buffer = terminal.buffer.active;
    cursorMarker.style.left = `${screenRect.left - surfaceRect.left + Math.min(buffer.cursorX, terminal.cols - 1) * cellWidth}px`;
    cursorMarker.style.top = `${screenRect.top - surfaceRect.top + buffer.cursorY * cellHeight}px`;
    cursorMarker.style.width = `${Math.max(2, cellWidth * 0.14)}px`;
    cursorMarker.style.height = `${cellHeight}px`;
    cursorMarker.hidden = false;
  }
  terminal.onCursorMove(updateCursorMarker);
  terminal.onRender(updateCursorMarker);
  terminal.onResize(updateCursorMarker);
  terminal.onData((data) => {
    if (!tab.started) return;
    void api.writeTerminal(id, data).catch((error) => {
      terminal.write(`\r\n\x1b[31mTerminal input failed: ${error.message}\x1b[0m\r\n`);
    });
  });
  terminal.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown') return true;
    const key = event.key.toLowerCase();
    const selection = terminal.getSelection();
    const copyShortcut = key === 'c' && (event.ctrlKey || event.metaKey) && selection.length > 0;
    if (copyShortcut) {
      event.preventDefault();
      void copyTerminalSelection(tab);
      return false;
    }
    const pasteShortcut = key === 'v'
      && (event.metaKey || event.ctrlKey);
    if (pasteShortcut) {
      event.preventDefault();
      void pasteClipboardToTerminal(tab);
      return false;
    }
    return true;
  });
  tab.resizeObserver = new ResizeObserver(() => {
    fitTerminal(tab);
    updateCursorMarker();
  });
  tab.resizeObserver.observe(surface);
  fitTerminal(tab);
  requestAnimationFrame(updateCursorMarker);

  let createdTerminalId;
  try {
    await waitForTerminalPanelReady(tab);
    const result = await api.createTerminal({
      terminalId: id,
      sessionId,
      cols: terminal.cols,
      rows: terminal.rows,
    });
    createdTerminalId = result.terminalId;
    if (!state.tabs.includes(tab)) {
      await api.closeTerminal(result.terminalId, sessionId);
      return;
    }
    tab.started = true;
    fitAddon.fit();
    await api.resizeTerminal(tab.id, terminal.cols, terminal.rows);
    await readiness.waitUntilReady();
    tab.shellReady = true;
    terminal.focus();
    return tab;
  } catch (error) {
    readiness.fail(error);
    tab.shellReady = false;
    if (createdTerminalId) {
      tab.started = false;
      try {
        await api.closeTerminal(createdTerminalId, sessionId);
      } catch (closeError) {
        showActivity({ kind: 'error', message: `Could not close the uninitialized terminal: ${closeError.message}` });
      }
    }
    terminal.writeln(`\r\nTerminal could not start: ${error.message}`);
    showActivity({ kind: 'error', message: `Could not start terminal: ${error.message}` });
    return null;
  }
}

async function ensureTerminalReady(sessionId) {
  if (!sessions.some((session) => session.id === sessionId)) {
    throw new Error('The conversation for this terminal command no longer exists.');
  }
  if (activeSessionId !== sessionId) selectSession(sessionId);
  openInfoPanel();
  const state = infoState(sessionId);
  let tab = state.tabs.find((candidate) => candidate.id === state.selectedId && candidate.started)
    ?? state.tabs.find((candidate) => candidate.started);
  if (!tab) tab = await addTerminalTab(sessionId);
  if (!tab?.started) throw new Error('A terminal could not be started for this conversation.');
  state.selectedId = tab.id;
  persistInfoState(sessionId, state);
  renderInfoPanel();
  await waitForTerminalPanelReady(tab);
  await tab.readiness.waitUntilReady();
  tab.shellReady = true;
  tab.terminal.focus();
  return tab;
}

function confirmTerminalCommand(command) {
  const dialog = $('terminal-command-dialog');
  $('terminal-command-text').textContent = command;
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true });
    dialog.showModal();
  });
}

async function handleTerminalCommandRequest(request) {
  if (!request || typeof request.commandId !== 'string'
    || typeof request.requestId !== 'string' || typeof request.sessionId !== 'string'
    || typeof request.command !== 'string') return;
  const state = requestState(request.sessionId);
  if (state?.requestId === request.requestId) {
    state.status = 'awaiting-command-approval';
    if (activeSessionId === request.sessionId) renderSession(activeSession());
  }
  let responseSent = false;
  try {
    const decision = await confirmTerminalCommand(request.command);
    if (decision !== 'approve') {
      await api.respondToTerminalCommand({ commandId: request.commandId, decision: 'decline' });
      responseSent = true;
      return;
    }
    if (state?.requestId === request.requestId) {
      state.status = 'starting-terminal';
      if (activeSessionId === request.sessionId) renderSession(activeSession());
    }
    const tab = await ensureTerminalReady(request.sessionId);
    if (state?.requestId === request.requestId) {
      state.status = 'running-command';
      if (activeSessionId === request.sessionId) renderSession(activeSession());
    }
    responseSent = true;
    await api.respondToTerminalCommand({
      commandId: request.commandId,
      decision: 'approve',
      terminalId: tab.id,
    });
    showActivity({ kind: 'complete', message: 'Command finished in the conversation terminal.' });
  } catch (error) {
    if (!responseSent) {
      try {
        await api.respondToTerminalCommand({
          commandId: request.commandId,
          decision: 'error',
          error: error.message,
        });
      } catch (responseError) {
        showActivity({ kind: 'error', message: `Could not report the terminal command failure: ${responseError.message}` });
      }
    }
    showActivity({ kind: 'error', message: `Could not run the terminal command: ${error.message}` });
  }
}

function renderDocumentDiff(oldContent, newContent, preview) {
  preview.replaceChildren();
  const diff = buildDocumentDiff(oldContent, newContent);
  for (const item of diff.lines) {
    const line = document.createElement('span');
    line.className = `diff-${item.type}`;
    const marker = item.type === 'removed' ? '- ' : item.type === 'added' ? '+ ' : '  ';
    line.textContent = `${marker}${item.text}\n`;
    preview.append(line);
  }
  return diff;
}

function confirmDocumentEdit(request) {
  const dialog = $('document-edit-dialog');
  $('document-edit-copy').textContent =
    `The assistant proposes changing "${request.name}". Review the diff; the original will only be written if you approve.`;
  const warning = $('document-edit-warning');
  const approve = $('document-edit-approve');
  const result = renderDocumentDiff(request.oldContent, request.newContent, $('document-edit-preview'));
  warning.hidden = result.previewable;
  warning.textContent = result.previewable
    ? ''
    : 'This change is too large to review safely here. Ask for a smaller edit; nothing has been changed.';
  approve.disabled = !result.previewable || result.unchanged;
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true });
    dialog.showModal();
  });
}

async function handleDocumentEditRequest(request) {
  if (!request || typeof request.proposalId !== 'string'
    || typeof request.requestId !== 'string' || typeof request.sessionId !== 'string'
    || typeof request.name !== 'string' || typeof request.oldContent !== 'string'
    || typeof request.newContent !== 'string') return;
  const state = requestState(request.sessionId);
  if (state?.requestId === request.requestId) {
    state.status = 'awaiting-document-approval';
    if (activeSessionId === request.sessionId) renderSession(activeSession());
  }
  let responseSent = false;
  try {
    const decision = await confirmDocumentEdit(request);
    responseSent = true;
    const result = await api.respondToDocumentEdit({
      proposalId: request.proposalId,
      sessionId: request.sessionId,
      decision: decision === 'approve' ? 'approve' : 'decline',
    });
    if (result.applied) {
      showActivity({ kind: 'complete', message: `Approved changes to "${result.name}".` });
    }
  } catch (error) {
    if (!responseSent) {
      try {
        await api.respondToDocumentEdit({
          proposalId: request.proposalId,
          sessionId: request.sessionId,
          decision: 'decline',
        });
      } catch (responseError) {
        showActivity({ kind: 'error', message: `Could not dismiss the document edit proposal: ${responseError.message}` });
      }
    }
    showActivity({ kind: 'error', message: `Could not review or apply the document edit: ${error.message}` });
  }
}

function closeInfoTab(sessionId, tabId) {
  const state = infoSessions.get(sessionId);
  const index = state?.tabs.findIndex((tab) => tab.id === tabId) ?? -1;
  if (!state || index < 0) return;
  const currentTab = state.tabs[index];
  const session = sessions.find((item) => item.id === sessionId);
  if (currentTab.kind === 'documents' && (session?.selectedDocumentIds ?? []).length > 0) return;
  const [tab] = state.tabs.splice(index, 1);
  if (tab.kind === 'terminal') {
    tab.readiness.fail(new Error('Terminal closed before the shell prompt was ready.'));
    tab.resizeObserver?.disconnect();
    tab.terminal.dispose();
    void api.closeTerminal(tab.id, sessionId).catch((error) => {
      showActivity({ kind: 'error', message: `Could not close terminal: ${error.message}` });
    });
  }
  if (state.selectedId === tab.id) {
    state.selectedId = state.tabs[Math.min(index, state.tabs.length - 1)]?.id ?? null;
  }
  persistInfoState(sessionId, state);
  renderInfoPanel();
}

async function copyTerminalSelection(tab) {
  const selection = tab.terminal.getSelection();
  if (!selection) return;
  try {
    await api.writeClipboardText(selection);
  } catch (error) {
    showActivity({ kind: 'error', message: `Could not copy terminal selection: ${error.message}` });
  }
}

async function pasteClipboardToTerminal(tab) {
  try {
    const text = await api.readClipboardText();
    if (text) tab.terminal.paste(text);
  } catch (error) {
    showActivity({ kind: 'error', message: `Could not paste into terminal: ${error.message}` });
  }
}

function closeSessionInfo(sessionId) {
  const state = infoSessions.get(sessionId);
  if (!state) return;
  for (const tab of state.tabs) {
    if (tab.kind === 'terminal') {
      tab.readiness.fail(new Error('Conversation closed before the shell prompt was ready.'));
      tab.resizeObserver?.disconnect();
      tab.terminal.dispose();
    }
  }
  infoSessions.delete(sessionId);
  localStorage.removeItem(`${INFO_STATE_KEY_PREFIX}${sessionId}`);
}

function selectedDocumentIds(session = activeSession()) {
  return session?.selectedDocumentIds ?? [];
}

function renderSelectedDocumentSources() {
  const session = activeSession();
  const container = $('selected-document-sources');
  const chips = $('selected-document-chips');
  chips.replaceChildren();
  if (!session || (session.selectedDocumentIds ?? []).length === 0
    || libraryLoadedSessionId !== session.id) {
    container.hidden = true;
    return;
  }
  const counts = documentContextCounts(
    libraryFiles,
    session.selectedDocumentIds,
    new Set(session.retrievedDocumentIds ?? []),
  );
  chips.textContent = `${counts.used.toLocaleString()}/${counts.total.toLocaleString()} Documents`;
  container.setAttribute('aria-label', `Documents used in context: ${counts.used} of ${counts.total}`);
  container.title = `${counts.used} of ${counts.total} attached documents used in this conversation's context`;
  container.hidden = false;
}

async function importDocuments(sessionId = activeSessionId) {
  try {
    if (!sessionId) return;
    const result = await api.importDocuments(sessionId);
    if (result.canceled) return;
    const addition = result.results;
    const documents = await api.listDocuments(sessionId);
    if (activeSessionId === sessionId) libraryLoadedSessionId = sessionId;
    const session = sessions.find((item) => item.id === sessionId);
    const previousReferences = session?.selectedDocumentIds ?? [];
    const newReferenceIds = addition.added.map((item) => item.id);
    if (session) session.selectedDocumentIds = [...new Set([...previousReferences, ...newReferenceIds])];
    infoState(sessionId);
    if (activeSessionId === sessionId) {
      libraryDocuments = documents.references;
      libraryFiles = documents.files;
      libraryDocumentCount = documents.documentCount;
      libraryUnindexedCount = documents.unindexedCount;
      if (newReferenceIds.length > 0) openDocumentLibraryTab(sessionId, { refresh: false });
      renderSelectedDocumentSources();
    }
    const attachedCount = newReferenceIds.filter((id) => !previousReferences.includes(id)).length;
    const summary = [
      attachedCount > 0 ? `Added ${attachedCount} file or folder ${attachedCount === 1 ? 'reference' : 'references'}.` : '',
      documents.unindexedCount > 0 ? `${documents.unindexedCount} supported files could not be indexed under the 250 MB local cache limit. The assistant can search them on demand.` : '',
      ...addition.errors.map((item) => `${item.name}: ${item.error}`),
    ].filter(Boolean);
    if (addition.errors.length > 0 || documents.unindexedCount > 0) {
      showActivity({
        kind: 'error',
        message: summary.join(' · ') || 'Some selected files could not be indexed.',
      });
    } else if (attachedCount > 0) {
      showActivity({ kind: 'complete', message: summary.join(' ') });
    } else {
      showActivity({ kind: 'complete', message: '' });
    }
  } catch (error) {
    showActivity({ kind: 'error', message: `Could not add documents: ${error.message}` });
  }
}

async function addDocumentFolder(sessionId = activeSessionId) {
  try {
    if (!sessionId) return;
    const result = await api.addDocumentFolder(sessionId);
    if (result.canceled) return;
    const documents = await api.listDocuments(sessionId);
    if (activeSessionId === sessionId) libraryLoadedSessionId = sessionId;
    const session = sessions.find((item) => item.id === sessionId);
    const previousReferences = session?.selectedDocumentIds ?? [];
    const newReferenceIds = result.added.map((item) => item.id);
    if (session) session.selectedDocumentIds = [...new Set([...previousReferences, ...newReferenceIds])];
    infoState(sessionId);
    if (activeSessionId === sessionId) {
      libraryDocuments = documents.references;
      libraryFiles = documents.files;
      libraryDocumentCount = documents.documentCount;
      libraryUnindexedCount = documents.unindexedCount;
      if (newReferenceIds.length > 0) openDocumentLibraryTab(sessionId, { refresh: false });
      renderSelectedDocumentSources();
    }
    const attachedCount = newReferenceIds.filter((id) => !previousReferences.includes(id)).length;
    const messages = [
      attachedCount > 0 ? `Added ${attachedCount} folder reference.` : '',
      documents.unindexedCount > 0 ? `${documents.unindexedCount} supported files could not be indexed under the 250 MB local cache limit. The assistant can search them on demand.` : '',
      ...result.errors.map((item) => `${item.name}: ${item.error}`),
    ].filter(Boolean);
    if (result.errors.length > 0 || documents.unindexedCount > 0) {
      showActivity({ kind: 'error', message: messages.join(' · ') || 'Some files in the folder could not be indexed.' });
    } else if (attachedCount > 0) {
      showActivity({ kind: 'complete', message: messages.join(' ') });
    }
  } catch (error) {
    showActivity({ kind: 'error', message: `Could not add folder: ${error.message}` });
  }
}

function requestDocumentRemoval(sessionId, referenceId, name, kind) {
  if (removeDocumentDialog.open) return;
  pendingDocumentRemoval = { sessionId, referenceId, name, kind };
  $('remove-document-name').textContent = name;
  $('remove-document-title').textContent = `Remove this ${kind} reference?`;
  removeDocumentDialog.querySelector('.eyebrow').textContent = `REMOVE ${kind.toLocaleUpperCase()}`;
  removeDocumentDialog.returnValue = '';
  removeDocumentDialog.showModal();
}

async function removeLibraryDocument(sessionId, referenceId, name) {
  try {
    const updatedSession = await api.removeDocument(referenceId, sessionId);
    if (!updatedSession || updatedSession.id !== sessionId) {
      throw new Error('The updated conversation could not be loaded after document removal.');
    }
    const sessionIndex = sessions.findIndex((item) => item.id === sessionId);
    if (sessionIndex < 0) throw new Error('The conversation is no longer available.');
    sessions[sessionIndex] = updatedSession;
    if (activeSessionId === sessionId) renderSession(updatedSession);
    else renderSessions();

    if (activeSessionId === sessionId) {
      const listing = await api.listDocuments(sessionId);
      libraryLoadedSessionId = sessionId;
      libraryDocuments = listing.references;
      libraryFiles = listing.files;
      libraryDocumentCount = listing.documentCount;
      libraryUnindexedCount = listing.unindexedCount;
    }
    if (activeSessionId === sessionId) {
      renderSelectedDocumentSources();
      ensureDocumentTab(sessionId);
      renderInfoPanel();
    }
    showActivity({ kind: 'complete', message: `Removed the reference to "${name}". The original was not changed.` });
  } catch (error) {
    showActivity({ kind: 'error', message: `Could not remove "${name}": ${error.message}` });
  }
}

function reportDocumentList(listing, sessionId) {
  if (activeSessionId !== sessionId) return;
  const messages = [];
  if (listing.unindexedCount > 0) {
    messages.push(`${listing.unindexedCount} supported files aren't in the local cache under the 250 MB limit; the assistant can search them on demand.`);
  }
  messages.push(...listing.errors.map((item) => `${item.name}: ${item.error}`));
  if (messages.length > 0) showActivity({ kind: 'error', message: messages.join(' · ') });
}

function documentIcon(kind) {
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', kind === 'folder'
    ? 'M3.5 6.5h6l2 2h9v10a1.5 1.5 0 0 1-1.5 1.5h-14a1.5 1.5 0 0 1-1.5-1.5z'
    : 'M6 3.5h8l4.5 4.5v12a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4.5 20V5A1.5 1.5 0 0 1 6 3.5ZM14 4v4h4');
  icon.append(path);
  return icon;
}

function plusIcon() {
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M12 5v14M5 12h14');
  icon.append(path);
  return icon;
}

function searchIcon() {
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('aria-hidden', 'true');
  const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  circle.setAttribute('cx', '10.8');
  circle.setAttribute('cy', '10.8');
  circle.setAttribute('r', '6.5');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'm16 16 4 4');
  icon.append(circle, path);
  return icon;
}

function documentActionButton(action, label, onClick) {
  const paths = {
    view: 'M2.5 12s3.2-6 9.5-6 9.5 6 9.5 6-3.2 6-9.5 6-9.5-6-9.5-6Zm9.5-3a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z',
    remove: 'M4 7h16M9 7V4h6v3m3 0-.8 13H6.8L6 7m4 3v6m4-6v6',
  };
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `document-action-button document-${action}-button`;
  button.setAttribute('aria-label', label);
  button.title = label;
  button.append(documentIcon(action));
  button.querySelector('path').setAttribute('d', paths[action]);
  button.addEventListener('click', onClick);
  return button;
}

async function openDocumentViewer(sessionId, fileId, fallbackName = 'Document', location = {}) {
  try {
    const content = await api.readDocumentContent(fileId, sessionId);
    $('document-viewer-title').textContent = content.name || fallbackName;
    const locationLabel = Number.isSafeInteger(location.startLine) && location.startLine > 0
      ? ` · Context at line ${location.startLine}`
      : Number.isSafeInteger(location.page) && location.page > 0
        ? ` · Context from page ${location.page}`
        : '';
    $('document-viewer-meta').textContent = `${content.extension.slice(1).toUpperCase()} · ${content.text.length.toLocaleString()} characters${locationLabel}`;
    const viewerContent = $('document-viewer-content');
    viewerContent.textContent = content.text;
    viewerContent.scrollTop = 0;
    viewerContent.scrollLeft = 0;
    documentViewerDialog.scrollTop = 0;
    if (!documentViewerDialog.open) documentViewerDialog.showModal();
    const lineHeight = Number.parseFloat(getComputedStyle(viewerContent).lineHeight);
    if (Number.isSafeInteger(location.startLine) && location.startLine > 0 && Number.isFinite(lineHeight)) {
      viewerContent.scrollTop = Math.max(0, (location.startLine - 1) * lineHeight);
    }
  } catch (error) {
    showActivity({ kind: 'error', message: `Could not open "${fallbackName}": ${error.message}` });
  }
}

function renderDocumentLibrarySurface(tab) {
  const surface = document.createElement('section');
  surface.className = 'document-library-surface';
  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'document-library-search';
  search.placeholder = 'Filter by filename';
  search.setAttribute('aria-label', 'Filter documents by filename');
  search.hidden = true;
  let applyDocumentFilter = () => {};

  const heading = document.createElement('div');
  heading.className = 'document-library-heading';
  const title = document.createElement('h2');
  title.textContent = 'Documents';
  const headerActions = document.createElement('div');
  headerActions.className = 'document-header-actions';
  const searchToggle = document.createElement('button');
  searchToggle.type = 'button';
  searchToggle.className = 'document-search-toggle';
  searchToggle.setAttribute('aria-label', 'Search documents');
  searchToggle.setAttribute('aria-expanded', 'false');
  searchToggle.title = 'Search documents';
  searchToggle.append(searchIcon());
  searchToggle.addEventListener('click', () => {
    const isOpening = search.hidden;
    search.hidden = !isOpening;
    searchToggle.setAttribute('aria-expanded', String(isOpening));
    searchToggle.setAttribute('aria-label', isOpening ? 'Close document search' : 'Search documents');
    searchToggle.title = isOpening ? 'Close document search' : 'Search documents';
    if (isOpening) search.focus();
    else {
      search.value = '';
      applyDocumentFilter();
    }
  });
  const addWrap = document.createElement('div');
  addWrap.className = 'document-add-wrap';
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'document-add-button';
  add.append(plusIcon());
  add.setAttribute('aria-label', 'Add files or folders');
  add.title = 'Add files or folders';
  add.setAttribute('aria-haspopup', 'menu');
  add.setAttribute('aria-expanded', 'false');
  const addMenu = document.createElement('div');
  addMenu.className = 'document-add-menu';
  addMenu.setAttribute('role', 'menu');
  addMenu.hidden = true;
  for (const [action, text] of [['files', 'Add files'], ['folder', 'Add folder']]) {
    const option = document.createElement('button');
    option.type = 'button';
    option.setAttribute('role', 'menuitem');
    option.textContent = text;
    option.addEventListener('click', () => {
      addMenu.hidden = true;
      add.setAttribute('aria-expanded', 'false');
      if (action === 'files') void importDocuments(tab.sessionId);
      else void addDocumentFolder(tab.sessionId);
    });
    addMenu.append(option);
  }
  add.addEventListener('click', () => {
    addMenu.hidden = !addMenu.hidden;
    add.setAttribute('aria-expanded', String(!addMenu.hidden));
  });
  addWrap.append(add, addMenu);
  headerActions.append(searchToggle, addWrap);
  heading.append(title, headerActions);
  surface.append(heading);

  surface.append(search);
  const count = document.createElement('p');
  count.className = 'document-selection-count';
  count.textContent = `${libraryDocumentCount} ${libraryDocumentCount === 1 ? 'Document' : 'Documents'}`;
  surface.append(count);
  if (libraryUnindexedCount > 0) {
    const overflow = document.createElement('p');
    overflow.className = 'document-library-warning';
    overflow.textContent = `${libraryUnindexedCount} supported files aren't in the local index cache. The assistant can search them on demand.`;
    surface.append(overflow);
  }

  const list = document.createElement('div');
  list.className = 'document-library-list';
  if (libraryDocuments.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'document-library-empty';
    empty.textContent = 'No file or folder references yet.';
    list.append(empty);
  } else {
    const session = sessions.find((candidate) => candidate.id === tab.sessionId);
    for (const item of libraryDocuments) {
      const makeFileRow = (
        file,
        canRemove,
        viewable = true,
        displayName = file.name,
        searchText = file.name,
        contextUsage = [],
      ) => {
        const row = document.createElement('div');
        row.className = 'document-library-item';
        row.dataset.search = searchText.toLocaleLowerCase();
        row.append(documentIcon('file'));
        const name = document.createElement('strong');
        name.className = 'document-library-name';
        name.textContent = displayName;
        row.append(name);
        const actions = document.createElement('div');
        actions.className = 'document-library-actions';
        const view = documentActionButton('view', `View ${displayName}`, () =>
          void openDocumentViewer(tab.sessionId, file.id, displayName));
        view.disabled = !viewable;
        actions.append(view);
        if (canRemove) {
          actions.append(documentActionButton('remove', `Remove ${item.name} reference from this conversation`, () =>
            requestDocumentRemoval(tab.sessionId, item.id, item.name, item.kind)));
        }
        row.append(actions);
        if (contextUsage.length > 0) {
          const usageDetails = document.createElement('details');
          usageDetails.className = 'document-context-provenance';
          const usageSummary = document.createElement('summary');
          usageSummary.textContent = `Included in context · ${contextUsage.length} ${contextUsage.length === 1 ? 'passage' : 'passages'}`;
          usageDetails.append(usageSummary);
          for (const usage of [...contextUsage].reverse()) {
            const entry = document.createElement('div');
            entry.className = 'document-context-evidence';
            const methodLabels = {
              'attached-document': 'Attached excerpt',
              'document-search': 'Document search',
              'document-read': 'Document read',
              citation: 'Cited source',
              'folder-instructions': 'Folder instructions',
              'folder-read': 'Folder read',
              'folder-grep': 'Folder search match',
            };
            const location = usage.startLine
              ? ` · lines ${usage.startLine}${usage.endLine && usage.endLine !== usage.startLine ? `–${usage.endLine}` : ''}`
              : usage.page
                ? ` · page ${usage.page}`
                : '';
            const label = document.createElement('p');
            label.className = 'document-context-evidence-label';
            label.textContent = `${methodLabels[usage.method] ?? 'Document context'}${location}`;
            entry.append(label);
            if (usage.name && usage.name !== displayName) {
              const path = document.createElement('p');
              path.className = 'document-context-evidence-path';
              path.textContent = usage.name;
              entry.append(path);
            }
            const excerpt = document.createElement('blockquote');
            excerpt.textContent = usage.excerpt;
            entry.append(excerpt);
            if (usage.truncated) {
              const shortened = document.createElement('p');
              shortened.className = 'document-context-evidence-note';
              shortened.textContent = 'Excerpt shortened; open the document to inspect more.';
              entry.append(shortened);
            }
            const open = document.createElement('button');
            open.type = 'button';
            open.className = 'document-context-open';
            open.textContent = usage.startLine ? `Open at line ${usage.startLine}` : 'Open document';
            open.addEventListener('click', () => void openDocumentViewer(
              tab.sessionId,
              file.id,
              displayName,
              { startLine: usage.startLine, page: usage.page },
            ));
            entry.append(open);
            usageDetails.append(entry);
          }
          row.append(usageDetails);
        }
        return row;
      };

      if (item.kind === 'file') {
        const file = libraryFiles.find((candidate) => candidate.referenceIds.includes(item.id));
        const usage = file?.id ? contextUsageForDocument(session?.messages ?? [], file.id) : [];
        list.append(makeFileRow(file ?? { id: null, name: item.name }, true, Boolean(file), item.name, item.name, usage));
        continue;
      }

      const folderFiles = libraryFiles.filter((file) => file.referenceIds.includes(item.id));
      const retrievedDocumentIds = new Set(
        sessions.find((session) => session.id === tab.sessionId)?.retrievedDocumentIds ?? [],
      );
      const files = usedFolderDocuments(folderFiles, retrievedDocumentIds);
      const flatFiles = [...files].sort((left, right) =>
        flatContextFileName(left.name).localeCompare(flatContextFileName(right.name))
        || left.name.localeCompare(right.name));
      const group = document.createElement('section');
      group.className = 'document-folder-group';
      group.dataset.search = `${item.name} ${flatFiles.map((file) => flatContextFileName(file.name)).join(' ')}`.toLocaleLowerCase();
      const row = document.createElement('div');
      row.className = 'document-library-item document-folder-row';
      row.append(documentIcon('folder'));
      const folderName = document.createElement('strong');
      folderName.className = 'document-library-name';
      folderName.textContent = item.name;
      row.append(folderName);
      const contextCount = document.createElement('span');
      contextCount.className = 'document-context-count';
      contextCount.textContent = String(files.length);
      contextCount.setAttribute('aria-label', `${files.length} files used in this conversation's context`);
      row.append(contextCount);
      const actions = document.createElement('div');
      actions.className = 'document-library-actions';
      const expand = document.createElement('button');
      expand.type = 'button';
      expand.className = 'document-folder-toggle';
      const canExpand = folderCanExpand(files);
      expand.disabled = !canExpand;
      expand.dataset.userExpanded = 'false';
      expand.setAttribute('aria-expanded', 'false');
      expand.setAttribute('aria-label', canExpand
        ? `Expand ${item.name}`
        : `No files from ${item.name} have been used in this conversation's context yet`);
      if (!canExpand) expand.title = `No files from ${item.name} have been used in this conversation's context yet`;
      expand.textContent = '›';
      actions.append(expand);
      actions.append(documentActionButton('remove', `Remove ${item.name} reference from this conversation`, () =>
        requestDocumentRemoval(tab.sessionId, item.id, item.name, item.kind)));
      row.append(actions);
      const children = document.createElement('div');
      children.className = 'document-folder-children';
      children.hidden = true;
      const note = document.createElement('p');
      note.className = 'document-folder-note';
      note.textContent = 'Only files used in this conversation are shown.';
      children.append(note);
      if (files.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'document-library-empty';
        empty.textContent = 'No files from this folder have been used in the conversation context yet.';
        children.append(empty);
      } else {
        for (const file of flatFiles) {
          const displayName = flatContextFileName(file.name);
          const usage = contextUsageForDocument(session?.messages ?? [], file.id);
          children.append(makeFileRow(file, false, true, displayName, displayName, usage));
        }
      }
      expand.addEventListener('click', () => {
        children.hidden = !children.hidden;
        expand.dataset.userExpanded = String(!children.hidden);
        expand.setAttribute('aria-expanded', String(!children.hidden));
        expand.setAttribute('aria-label', `${children.hidden ? 'Expand' : 'Collapse'} ${item.name}`);
        expand.textContent = children.hidden ? '›' : '⌄';
      });
      group.append(row, children);
      list.append(group);
    }
  }
  surface.append(list);
  applyDocumentFilter = () => {
    const query = search.value.trim().toLocaleLowerCase();
    for (const row of list.querySelectorAll('.document-library-item')) {
      const group = row.closest('.document-folder-group');
      if (!group || row.classList.contains('document-folder-row')) {
        const target = group ?? row;
        target.hidden = !target.dataset.search.includes(query);
        if (query && group) {
          const rootChildren = group.querySelector(':scope > .document-folder-children');
          const rootToggle = group.querySelector(':scope > .document-folder-row .document-folder-toggle');
          if (rootChildren && rootToggle) {
            rootChildren.hidden = false;
            rootToggle.setAttribute('aria-expanded', 'true');
            rootToggle.textContent = '⌄';
          }
        } else if (!query && group) {
          const rootChildren = group.querySelector(':scope > .document-folder-children');
          const rootToggle = group.querySelector(':scope > .document-folder-row .document-folder-toggle');
          if (rootChildren && rootToggle) {
            const expanded = rootToggle.dataset.userExpanded === 'true';
            rootChildren.hidden = !expanded;
            rootToggle.setAttribute('aria-expanded', String(expanded));
            rootToggle.textContent = expanded ? '⌄' : '›';
          }
        }
      }
    }
    for (const row of list.querySelectorAll('.document-folder-children .document-library-item')) {
      const queryMatch = row.dataset.search.includes(query);
      row.hidden = !queryMatch;
      if (query && queryMatch) {
        const children = row.parentElement;
        children.hidden = false;
        const toggle = children.previousElementSibling.querySelector('.document-folder-toggle');
        toggle.setAttribute('aria-expanded', 'true');
        toggle.textContent = '⌄';
      }
    }
  };
  search.addEventListener('input', applyDocumentFilter);
  tab.surface.replaceChildren(surface);
}

function openDocumentLibraryTab(sessionId = activeSessionId, { refresh = true } = {}) {
  if (!sessionId) return;
  const state = infoState(sessionId);
  let tab = state.tabs.find((item) => item.kind === 'documents');
  if (!tab) {
    tab = createDocumentTab(sessionId);
    state.tabs.push(tab);
  }
  state.selectedId = tab.id;
  persistInfoState(sessionId, state);
  openInfoPanel();
  renderInfoPanel();
  if (refresh && (sessions.find((session) => session.id === sessionId)?.selectedDocumentIds ?? []).length > 0) {
    void refreshDocumentLibrary(sessionId);
  }
}

function ensureDocumentTab(sessionId) {
  if (!sessionId) return null;
  const state = infoState(sessionId);
  let tab = state.tabs.find((item) => item.kind === 'documents');
  if (!tab) {
    tab = createDocumentTab(sessionId);
    state.tabs.push(tab);
    if (!state.selectedId) state.selectedId = tab.id;
    persistInfoState(sessionId, state);
  }
  return tab;
}

function activeSession() {
  return sessions.find((session) => session.id === activeSessionId) ?? null;
}

function requestState(sessionId) {
  return requestStates.get(sessionId) ?? null;
}

function requestHistory(session) {
  const history = [];
  let historyLength = 0;
  for (const message of session.messages.filter((item) => item.status !== 'cancelled').slice(-8).reverse()) {
    if (historyLength >= 8_000) break;
    const content = message.content.slice(-Math.min(4_000, 8_000 - historyLength));
    history.push({ role: message.role, content });
    historyLength += content.length;
  }
  return history.reverse();
}

function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

function estimatedPromptTokens(question, history, selectedTerminalOutput = '') {
  const prompt = history.length === 0
    ? question
    : `Prior conversation:\n${history.map(({ role, content }) =>
      `${role === 'user' ? 'User' : 'Assistant'}: ${content}`
    ).join('\n')}\n\nCurrent question:\n${question}`;
  const selectedCount = selectedDocumentIds().length;
  const documentBudget = selectedCount > 0 ? MAX_DOCUMENT_CONTEXT_CHARS : 0;
  return estimateTokens(`${SYSTEM_PROMPT}\n${selectedTerminalOutput}\n${prompt}`) + estimateTokens(' '.repeat(documentBudget));
}

function updateContextMeter(value) {
  const meter = $('context-meter-track');
  const wrapper = meter.closest('.context-meter');
  const percentage = Math.min(100, value / contextMeterTokens * 100);
  meter.setAttribute('aria-valuemax', String(contextMeterTokens));
  meter.setAttribute('aria-valuenow', String(Math.min(value, contextMeterTokens)));
  meter.setAttribute('aria-valuetext', `Approximately ${value} of ${contextMeterTokens.toLocaleString()} context tokens`);
  meter.style.setProperty('--meter-progress', `${percentage}%`);
  wrapper.classList.toggle('near-limit', value >= contextMeterTokens * 0.8 && value <= contextMeterTokens);
  wrapper.classList.toggle('over-limit', value > contextMeterTokens);
  wrapper.querySelector('.context-meter-value').textContent = `${Math.round(percentage)}%`;
  $('context-meter-value').textContent =
    `~${value.toLocaleString()} / ${contextMeterTokens.toLocaleString()} tokens`;
  wrapper.querySelector('.limit-meter-fill').style.width = `${percentage}%`;
}

function updateLimitMeters() {
  const session = activeSession();
  const state = session ? requestState(session.id) : null;
  const history = session ? requestHistory(session) : [];
  const promptTokens = state?.promptTokens
    ?? estimatedPromptTokens(prompt.value, history, terminalContext());
  updateContextMeter(promptTokens);
}

function updateComposerControls() {
  const state = requestState(activeSessionId);
  sendButton.disabled = !assistantAvailable || Boolean(state);
  cancelButton.hidden = !state || !['queued', 'running'].includes(state.status);
  cancelButton.disabled = !state || !['queued', 'running'].includes(state.status);
  cancelButton.textContent = state?.status === 'queued' ? 'Remove from queue' : 'Cancel';
  updateLimitMeters();
}

function showActivity(activity) {
  const container = $('activity');
  const message = activity.message || '';
  const isError = activity.kind === 'error' || activity.kind === 'startup-error';
  container.hidden = !activity.message;
  container.classList.toggle('activity-error', isError);
  $('activity-message').textContent = message;
  $('activity-clear').hidden = !isError || !message;
  if (activity.kind === 'complete') container.hidden = true;
}

function setAssistantStatus(state, label, detail) {
  const card = document.querySelector('.assistant-card');
  card.dataset.state = state;
  $('assistant-status').textContent = label;
  $('assistant-detail').textContent = detail;
}

function updateSessionTitle(session, question) {
  if (session.messages.length !== 1) return;
  const title = question.replace(/\s+/gu, ' ').trim();
  session.title = title.length > 54 ? `${title.slice(0, 51)}…` : title;
}

function renderSessions() {
  const list = $('session-list');
  const query = $('session-search').value.trim().toLocaleLowerCase();
  list.replaceChildren();
  const filtered = [...sessions]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .filter((session) => [
      session.title,
      ...session.messages.map((message) => message.content),
    ].some((value) => value.toLocaleLowerCase().includes(query)));

  if (filtered.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'sessions-empty';
    empty.textContent = query ? 'No matching conversations.' : 'Your conversations will appear here.';
    list.append(empty);
    return;
  }

  for (const session of filtered) {
    const item = document.createElement('div');
    item.className = 'session-item';
    item.dataset.sessionId = session.id;
    item.classList.toggle('selected', session.id === activeSessionId);

    const openButton = document.createElement('button');
    openButton.type = 'button';
    openButton.className = 'session-open';
    openButton.setAttribute('aria-pressed', String(session.id === activeSessionId));
    openButton.setAttribute('aria-label', `Open conversation: ${session.title || 'New conversation'}`);
    openButton.addEventListener('click', () => selectSession(session.id));
    const title = document.createElement('strong');
    title.textContent = session.title || 'New conversation';
    const preview = document.createElement('span');
    preview.className = 'session-preview';
    const lastMessage = session.messages.at(-1);
    const state = requestState(session.id);
    if (state) {
      preview.classList.add('session-thinking');
      preview.setAttribute('role', 'status');
      preview.textContent = state.answer
        ? 'Typing…'
        : state.status === 'queued'
          ? `Queued${state.queuePosition ? ` · ${state.queuePosition}` : ''}`
          : state.status === 'cancelling'
            ? 'Cancelling…'
            : state.status === 'saving' || state.status === 'submitting'
              ? 'Submitting…'
              : state.status === 'awaiting-command-approval'
                ? 'Awaiting approval…'
                : 'Thinking…';
    } else {
      preview.textContent = lastMessage?.content ?? 'New conversation';
    }
    const date = document.createElement('time');
    date.className = 'session-date';
    date.dateTime = session.updatedAt;
    date.textContent = formatSessionDate(session.updatedAt);
    openButton.append(title, date, preview);

    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'session-delete';
    deleteButton.textContent = '×';
    deleteButton.title = state
      ? 'Cannot delete a conversation while a request is pending'
      : 'Delete conversation';
    deleteButton.setAttribute('aria-label', `Delete conversation: ${session.title || 'New conversation'}`);
    deleteButton.disabled = Boolean(state);
    deleteButton.addEventListener('click', () => void deleteSession(session.id));
    item.append(openButton, deleteButton);
    list.append(item);
  }
}

function formatSessionDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
}

function renderMarkdown(content, { renderMath = true } = {}) {
  const html = window.marked.parse(content);
  const container = document.createElement('div');
  container.innerHTML = window.DOMPurify.sanitize(html);
  if (renderMath) {
    renderMathInElement(container, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '$', right: '$', display: false },
        { left: '\\[', right: '\\]', display: true },
        { left: '\\(', right: '\\)', display: false },
      ],
      throwOnError: false,
      trust: false,
    });
  }
  return container.innerHTML;
}

function linkDocumentCitations(container, sources) {
  if (!Array.isArray(sources) || sources.length === 0) return;
  const sourceMap = new Map(sources.map((source) => [source.citationId, source]));
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);

  for (const node of textNodes) {
    const text = node.nodeValue ?? '';
    const pattern = /\[S\d{1,3}\]/gu;
    let previousIndex = 0;
    let match;
    const fragment = document.createDocumentFragment();
    let changed = false;
    while ((match = pattern.exec(text)) !== null) {
      const source = sourceMap.get(match[0].slice(1, -1));
      if (!source || typeof source.documentId !== 'string') continue;
      changed = true;
      fragment.append(document.createTextNode(text.slice(previousIndex, match.index)));
      const citation = document.createElement('button');
      citation.type = 'button';
      citation.className = 'inline-citation';
      citation.textContent = match[0];
      citation.setAttribute('aria-label', `Open cited document ${source.name}`);
      citation.addEventListener('click', () => {
        void openDocumentViewer(activeSessionId, source.documentId, source.name, { page: source.page });
      });
      fragment.append(citation);
      previousIndex = match.index + match[0].length;
    }
    if (changed) {
      fragment.append(document.createTextNode(text.slice(previousIndex)));
      node.replaceWith(fragment);
    }
  }
}

function responseFooter(content) {
  const footer = document.createElement('div');
  footer.className = 'response-footer';

  const copyButton = document.createElement('button');
  copyButton.className = 'response-copy';
  copyButton.type = 'button';
  copyButton.setAttribute('aria-label', 'Copy response');
  copyButton.title = 'Copy response';
  const copyIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  copyIcon.setAttribute('viewBox', '0 0 24 24');
  copyIcon.setAttribute('aria-hidden', 'true');
  const copyBack = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  copyBack.setAttribute('x', '8');
  copyBack.setAttribute('y', '8');
  copyBack.setAttribute('width', '12');
  copyBack.setAttribute('height', '12');
  copyBack.setAttribute('rx', '2');
  const copyFront = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  copyFront.setAttribute('d', 'M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3');
  copyIcon.append(copyBack, copyFront);
  copyButton.append(copyIcon);
  copyButton.addEventListener('click', () => void copyResponse(copyButton, content));
  footer.append(copyButton);

  const tokens = estimateTokens(content);
  const percentage = Math.min(100, tokens / responseTokenLimit * 100);
  const tooltipId = `response-meter-tooltip-${responseMeterId++}`;
  const meter = document.createElement('div');
  meter.className = `context-meter response-meter${tokens >= responseTokenLimit * 0.8 ? ' near-limit' : ''}`;
  if (tokens > responseTokenLimit) meter.classList.replace('near-limit', 'over-limit');

  const ring = document.createElement('div');
  ring.className = 'context-meter-ring';
  ring.style.setProperty('--meter-progress', `${percentage}%`);
  ring.setAttribute('role', 'progressbar');
  ring.setAttribute('tabindex', '0');
  ring.setAttribute('aria-label', 'Estimated response output usage');
  ring.setAttribute('aria-valuemin', '0');
  ring.setAttribute('aria-valuemax', String(responseTokenLimit));
  ring.setAttribute('aria-valuenow', String(Math.min(tokens, responseTokenLimit)));
  ring.setAttribute(
    'aria-valuetext',
    `Approximately ${tokens} of ${responseTokenLimit} response tokens`,
  );
  ring.setAttribute('aria-describedby', tooltipId);

  const tooltip = document.createElement('div');
  tooltip.id = tooltipId;
  tooltip.className = 'context-meter-tooltip';
  tooltip.setAttribute('role', 'tooltip');
  const heading = document.createElement('div');
  heading.className = 'limit-meter-heading';
  const title = document.createElement('span');
  title.textContent = 'Response estimate';
  const count = document.createElement('span');
  count.textContent = `~${tokens.toLocaleString()} / ${responseTokenLimit} tokens`;
  heading.append(title, count);
  const track = document.createElement('div');
  track.className = 'limit-meter-track';
  track.setAttribute('aria-hidden', 'true');
  const fill = document.createElement('span');
  fill.className = 'limit-meter-fill';
  fill.style.width = `${percentage}%`;
  track.append(fill);
  const detail = document.createElement('p');
  detail.textContent = 'Approximate output-token usage.';
  tooltip.append(heading, track, detail);
  meter.append(ring, tooltip);
  footer.append(meter);
  return footer;
}

async function copyResponse(button, content) {
  try {
    await api.writeClipboardText(content);
    button.classList.add('copied');
    button.setAttribute('aria-label', 'Response copied');
    button.title = 'Response copied';
    setTimeout(() => {
      button.classList.remove('copied');
      button.setAttribute('aria-label', 'Copy response');
      button.title = 'Copy response';
    }, 1500);
  } catch (error) {
    showActivity({ kind: 'error', message: `Could not copy response: ${error.message}` });
  }
}

function renderMessage(message) {
  const wrapper = document.createElement('article');
  wrapper.className = `message ${message.role}`;
  if (message.status) wrapper.classList.add(`message-${message.status}`);
  if (message.role === 'assistant') {
    const label = document.createElement('div');
    label.className = 'message-label';
    label.textContent = message.status === 'cancelled'
      ? 'CANCELLED'
      : message.status === 'truncated' || message.status === 'interrupted'
        ? 'LIVINGWORDS · INCOMPLETE'
        : 'LIVINGWORDS';
    wrapper.append(label);
  }
  const content = document.createElement('div');
  content.className = 'message-content';
  if (message.role === 'assistant') {
    content.innerHTML = renderMarkdown(message.content);
    linkDocumentCitations(content, message.sources);
  } else {
    content.textContent = message.content;
  }
  wrapper.append(content);

  if (message.status === 'truncated' || message.status === 'interrupted') {
    const notice = document.createElement('div');
    notice.className = 'message-notice';
    notice.textContent = message.status === 'truncated'
      ? 'This response reached the output-token limit and may be incomplete.'
      : 'This response was interrupted before it finished.';
    wrapper.append(notice);
  }
  if (message.role === 'assistant' && message.status !== 'cancelled') {
    wrapper.append(responseFooter(message.content));
  }
  messages.append(wrapper);
}

function renderPendingMessage(state) {
  const wrapper = document.createElement('article');
  wrapper.className = 'message assistant message-pending';
  wrapper.setAttribute('aria-label', state.status === 'queued'
    ? 'Request is queued'
    : state.answer ? 'Assistant response in progress' : 'Assistant is responding');
  const label = document.createElement('div');
  label.className = 'message-label';
  label.textContent = 'LIVINGWORDS';
  if (state.answer) {
    const content = document.createElement('div');
    content.className = 'message-content';
    content.innerHTML = renderMarkdown(state.answer, { renderMath: false });
    wrapper.append(label, content);
    messages.append(wrapper);
    return;
  }
  wrapper.setAttribute('role', 'status');
  const indicator = document.createElement('div');
  indicator.className = 'typing-indicator';
  if (state.status === 'queued') {
    indicator.textContent = state.queuePosition
      ? `Waiting in queue · position ${state.queuePosition}`
      : 'Waiting in queue';
  } else if (state.status === 'cancelling') {
    indicator.textContent = 'Cancelling response…';
  } else if (state.status === 'awaiting-command-approval') {
    indicator.textContent = 'Waiting for terminal command approval…';
  } else {
    indicator.setAttribute('aria-hidden', 'true');
    for (let index = 0; index < 3; index += 1) indicator.append(document.createElement('span'));
  }
  wrapper.append(label, indicator);
  messages.append(wrapper);
}

function renderSession(session) {
  if (!session) return;
  const sessionChanged = activeSessionId !== session.id;
  const previousScrollTop = messages.scrollTop;
  activeSessionId = session.id;
  if (sessionChanged) {
    libraryDocuments = [];
    libraryFiles = [];
    libraryDocumentCount = 0;
    libraryUnindexedCount = 0;
    libraryLoadedSessionId = null;
    const panelOpen = infoState(session.id)?.open ?? false;
    appShell.classList.toggle('info-collapsed', !panelOpen);
    $('info-panel').hidden = !panelOpen;
    $('info-toggle').setAttribute('aria-expanded', String(panelOpen));
    $('info-toggle').title = panelOpen ? 'Hide tools and documents' : 'Show tools and documents';
  }
  if ((session.selectedDocumentIds ?? []).length > 0) ensureDocumentTab(session.id);
  $('conversation-title').textContent = session.title || 'A thoughtful place to begin';
  messages.replaceChildren();
  const state = requestState(session.id);
  const showMessages = session.messages.length > 0 || Boolean(state);
  welcome.hidden = showMessages;
  appShell.classList.toggle('welcome-active', !showMessages);
  messages.style.display = showMessages ? 'flex' : 'none';
  for (const message of session.messages) renderMessage(message);
  if (state && state.status !== 'saving') renderPendingMessage(state);
  messages.scrollTop = state?.autoScroll === false
    ? preservedScrollTop(previousScrollTop, messages.scrollHeight, messages.clientHeight)
    : messages.scrollHeight;
  renderSelectedDocumentSources();
  updateComposerControls();
  renderSessions();
  if (sessionChanged) {
    renderInfoPanel();
    const tab = selectedTerminal(session.id);
    if (tab) fitTerminal(tab);
    void loadDocumentLibrary(session.id).catch((error) => {
      if (activeSessionId === session.id) {
        showActivity({ kind: 'error', message: `Could not load this conversation's documents: ${error.message}` });
      }
    });
  }
}

function animateWelcomeLogo() {
  welcome.classList.remove('is-animating');
  void welcome.offsetWidth;
  welcome.classList.add('is-animating');
}

function selectSession(id) {
  const session = sessions.find((item) => item.id === id);
  if (session) {
    renderSession(session);
    appShell.classList.remove('sessions-open');
    $('chat-nav').setAttribute('aria-expanded', 'false');
  }
}

async function deleteSession(id) {
  const session = sessions.find((item) => item.id === id);
  if (!session) return;
  if (requestState(id)) {
    showActivity({ kind: 'error', message: 'Wait for the queued or active request to finish before deleting this conversation.' });
    return;
  }
  $('delete-dialog-copy').textContent =
    `"${session.title || 'New conversation'}", its messages, document references, and local indexes will be permanently deleted. Original files will not be deleted.`;
  const deleteDialog = $('delete-dialog');
  const confirmed = await new Promise((resolve) => {
    deleteDialog.addEventListener('close', () => {
      resolve(deleteDialog.returnValue === 'delete');
    }, { once: true });
    deleteDialog.showModal();
  });
  if (!confirmed) return;

  try {
    const deletion = await api.deleteSession(id);
    sessions = sessions.filter((item) => item.id !== id);
    closeSessionInfo(id);
    if (activeSessionId === id) {
      activeSessionId = null;
      messages.replaceChildren();
      messages.style.display = 'none';
      welcome.hidden = false;
      $('conversation-title').textContent = 'A thoughtful place to begin';
      if (sessions.length > 0) {
        const mostRecent = [...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
        renderSession(mostRecent);
      } else {
        renderSessions();
        const freshSession = await api.createSession();
        sessions = [freshSession];
        renderSession(freshSession);
      }
    } else {
      renderSessions();
    }
    showActivity({
      kind: deletion?.cleanupWarning ? 'error' : 'complete',
      message: deletion?.cleanupWarning ?? 'Conversation and its documents deleted.',
    });
  } catch (error) {
    showActivity({ kind: 'error', message: `Could not delete this conversation: ${error.message}` });
  }
}

async function createSession() {
  try {
    const session = await api.createSession();
    sessions.unshift(session);
    renderSession(session);
    animateWelcomeLogo();
    appShell.classList.remove('sessions-open');
    $('chat-nav').setAttribute('aria-expanded', 'false');
    prompt.focus();
  } catch (error) {
    showActivity({ kind: 'error', message: `Could not create a conversation: ${error.message}` });
  }
}

async function saveSession(session) {
  session.updatedAt = new Date().toISOString();
  await api.saveSession(session);
  renderSessions();
}

function applyTheme(theme) {
  const selected = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = selected;
  const styles = getComputedStyle(document.documentElement);
  const terminalTheme = terminalThemeFromColors({
    background: styles.getPropertyValue('--bg'),
    foreground: styles.getPropertyValue('--text'),
    accent: styles.getPropertyValue('--accent'),
    accentContrast: styles.getPropertyValue('--accent-contrast'),
  });
  for (const state of infoSessions.values()) {
    for (const tab of state.tabs) {
      if (tab.kind === 'terminal') tab.terminal.options.theme = terminalTheme;
    }
  }
  for (const button of document.querySelectorAll('[data-theme-choice]')) {
    button.setAttribute('aria-pressed', String(button.dataset.themeChoice === selected));
  }
}

async function initializeRenderer() {
  await Promise.all([
    loadContextWindowPreference(),
    refreshStatus().catch((error) => {
      setAssistantStatus('unavailable', 'Assistant status unavailable', error.message.slice(0, 120));
    }),
    loadSessions().catch((error) => {
      showActivity({ kind: 'error', message: `Could not load local conversations: ${error.message}` });
    }),
  ]);

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const minimumSplashDuration = reducedMotion ? 0 : 1850;
  const remainingSplashDuration = Math.max(0, minimumSplashDuration - (performance.now() - splashStartedAt));
  if (remainingSplashDuration > 0) {
    await new Promise((resolve) => window.setTimeout(resolve, remainingSplashDuration));
  }

  const splash = $('splash-screen');
  appShell.inert = false;
  appShell.removeAttribute('aria-hidden');
  splash.setAttribute('aria-hidden', 'true');
  splash.classList.add('is-leaving');

  await new Promise((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      window.clearTimeout(fallback);
      splash.hidden = true;
      resolve();
    };
    const fallback = window.setTimeout(finish, reducedMotion ? 100 : 800);
    splash.addEventListener('transitionend', (event) => {
      if (event.target === splash && event.propertyName === 'opacity') finish();
    }, { once: true });
  });
}

function applyContextWindow(value) {
  const preset = contextWindowPreset(value);
  contextWindowTokens = value;
  responseTokenLimit = responseTokenLimitForContext(value);
  contextMeterTokens = preset.meterTokens;
  $('context-window-select').value = String(value);
  $('context-window-response-limit').textContent =
    `Response limit: ${responseTokenLimit.toLocaleString()} tokens`;
  $('context-meter-track').setAttribute('aria-valuemax', String(contextMeterTokens));
  $('context-meter-track').setAttribute(
    'aria-valuetext',
    `Approximately 0 of ${contextMeterTokens.toLocaleString()} context tokens`,
  );
  $('context-meter-value').textContent = `~0 / ${contextMeterTokens.toLocaleString()} tokens`;
  const session = activeSession();
  if (session) renderSession(session);
  else updateLimitMeters();
}

async function loadContextWindowPreference() {
  const select = $('context-window-select');
  try {
    const settings = await api.getContextWindow();
    applyContextWindow(settings.contextWindowTokens);
    select.disabled = false;
    if (settings.settingsError) {
      showActivity({ kind: 'error', message: `Could not load saved context setting: ${settings.settingsError}` });
    }
  } catch (error) {
    select.disabled = true;
    showActivity({ kind: 'error', message: `Could not load the context setting: ${error.message}` });
  }
}

function openInfoPanel() {
  const state = infoState();
  if (state) {
    state.open = true;
    persistInfoState(activeSessionId, state);
  }
  appShell.classList.remove('sessions-open');
  $('chat-nav').setAttribute('aria-expanded', 'false');
  appShell.classList.remove('info-collapsed');
  $('info-panel').hidden = false;
  $('info-toggle').setAttribute('aria-expanded', 'true');
  $('info-toggle').title = 'Hide tools and documents';
  setPanelWidth('info', Number.parseFloat(getComputedStyle(appShell).getPropertyValue('--info-width')) || PANEL_WIDTHS.info.fallback);
  setPanelWidth('sessions', Number.parseFloat(getComputedStyle(appShell).getPropertyValue('--sessions-width')) || PANEL_WIDTHS.sessions.fallback);
  setPanelWidth('info', Number.parseFloat(getComputedStyle(appShell).getPropertyValue('--info-width')) || PANEL_WIDTHS.info.fallback);
  renderInfoPanel();
  const tab = selectedTerminal();
  if (tab) fitTerminal(tab);
}

function closeInfoPanel() {
  const state = infoState();
  if (state) {
    state.open = false;
    persistInfoState(activeSessionId, state);
  }
  appShell.classList.add('info-collapsed');
  $('info-panel').hidden = true;
  $('info-toggle').setAttribute('aria-expanded', 'false');
  $('info-toggle').title = 'Show tools and documents';
  $('info-toggle').focus();
}

async function refreshStatus() {
  const status = await api.status();
  assistantAvailable = status.modelReady && status.runtimeAvailable;
  if (status.assistantReady) {
    setAssistantStatus('ready', 'Assistant ready', 'Learn more about the model and license details');
  } else if (status.assistantStarting) {
    setAssistantStatus('starting', 'Starting local AI', 'Loading the assistant for your conversation');
  } else if (status.assistantError) {
    setAssistantStatus('unavailable', 'Assistant unavailable', status.assistantError.slice(0, 120));
  } else if (!status.modelReady) {
    setAssistantStatus('unavailable', 'Assistant unavailable', 'AI resources are missing from this app');
  } else if (!status.runtimeAvailable) {
    setAssistantStatus('unavailable', 'Assistant unavailable', 'The local runtime is not available');
  } else {
    setAssistantStatus('starting', 'Starting local AI', 'Preparing to load the assistant');
  }
  if (!status.modelReady || !status.runtimeAvailable) {
    $('setup-assistant-warning').hidden = status.modelReady;
    $('setup-runtime-warning').hidden = status.runtimeAvailable;
    if (!setupDialog.open) setupDialog.showModal();
  } else {
    $('setup-runtime-warning').hidden = true;
    $('setup-assistant-warning').hidden = true;
  }
  if (status.assistantError) {
    showActivity({ kind: 'startup-error', message: `Local assistant could not start: ${status.assistantError}` });
  }
  updateComposerControls();
}

async function loadSessions() {
  sessions = await api.listSessions();
  if (sessions.length === 0) {
    const initial = await api.createSession();
    sessions = [initial];
  }
  renderSession(sessions[0]);
}

async function loadDocumentLibrary(sessionId) {
  const documents = await api.listCachedDocuments(sessionId);
  if (activeSessionId !== sessionId) return;
  libraryLoadedSessionId = sessionId;
  libraryDocuments = documents.references;
  libraryFiles = documents.files;
  libraryDocumentCount = documents.documentCount;
  libraryUnindexedCount = documents.unindexedCount;
  if ((activeSession()?.selectedDocumentIds ?? []).length > 0) ensureDocumentTab(sessionId);
  renderSelectedDocumentSources();
  if (infoSessions.get(sessionId)?.tabs.some((tab) => tab.kind === 'documents')) renderInfoPanel();
}

async function refreshDocumentLibrary(sessionId) {
  if (refreshingDocumentSessions.has(sessionId)) return;
  refreshingDocumentSessions.add(sessionId);
  try {
    const documents = await api.listDocuments(sessionId);
    if (activeSessionId !== sessionId) return;
    libraryLoadedSessionId = sessionId;
    libraryDocuments = documents.references;
    libraryFiles = documents.files;
    libraryDocumentCount = documents.documentCount;
    libraryUnindexedCount = documents.unindexedCount;
    renderSelectedDocumentSources();
    if (infoSessions.get(sessionId)?.tabs.some((tab) => tab.kind === 'documents')) {
      renderInfoPanel();
    }
    reportDocumentList(documents, sessionId);
  } catch (error) {
    if (activeSessionId === sessionId) {
      showActivity({ kind: 'error', message: `Could not refresh this conversation's documents: ${error.message}` });
    }
  } finally {
    refreshingDocumentSessions.delete(sessionId);
  }
}

async function ask(question) {
  if (!assistantAvailable) {
    setupDialog.showModal();
    return;
  }
  const session = activeSession();
  if (!session || requestState(session.id)) return;

  const requestId = window.crypto.randomUUID();
  const history = requestHistory(session);
  const selectedTerminalOutput = terminalContext(session.id);
  const state = {
    requestId,
    status: 'saving',
    queuePosition: null,
    answer: '',
    promptTokens: estimatedPromptTokens(question, history, selectedTerminalOutput),
    renderScheduled: false,
    autoScroll: true,
  };
  const previousTitle = session.title;
  const userMessage = { role: 'user', content: question };
  session.messages.push(userMessage);
  updateSessionTitle(session, question);
  requestStates.set(session.id, state);
  if (activeSessionId === session.id) {
    renderSession(session);
    messages.style.display = 'flex';
    welcome.hidden = true;
    messages.scrollTop = messages.scrollHeight;
  }
  prompt.value = '';
  prompt.focus();
  try {
    try {
      await saveSession(session);
    } catch (error) {
      session.messages.pop();
      session.title = previousTitle;
      requestStates.delete(session.id);
      showActivity({ kind: 'error', message: `Could not save this conversation: ${error.message}` });
      prompt.value = question;
      if (activeSessionId === session.id) renderSession(session);
      return;
    }

    try {
      state.status = 'submitting';
      if (activeSessionId === session.id) renderSession(session);
      await api.ask(requestId, session.id, question, history, selectedTerminalOutput);
      if (requestStates.get(session.id) === state && state.status === 'submitting') {
        state.status = 'queued';
        renderSessions();
        if (activeSessionId === session.id) renderSession(session);
      }
    } catch (error) {
      if (requestStates.get(session.id) !== state) return;
      session.messages.pop();
      session.title = previousTitle;
      requestStates.delete(session.id);
      try {
        await saveSession(session);
      } catch (rollbackError) {
        showActivity({ kind: 'error', message: `The request could not be queued, and its conversation update could not be reverted: ${rollbackError.message}` });
      }
      prompt.value = question;
      if (activeSessionId === session.id) {
        renderSession(session);
      }
      showActivity({ kind: 'error', message: `Could not queue this request: ${error.message}` });
      return;
    }
  } finally {
    if (activeSessionId === session.id) prompt.focus();
  }
}

function handleRequestStatus(status) {
  const state = requestState(status.sessionId);
  if (!state || state.requestId !== status.requestId) return;
  state.status = status.status;
  state.queuePosition = status.queuePosition ?? null;
  renderSessions();
  if (activeSessionId === status.sessionId) renderSession(activeSession());
}

async function handleRequestResult(result) {
  const session = sessions.find((item) => item.id === result.sessionId);
  if (!session) return;
  const state = requestState(result.sessionId);
  if (state && state.requestId !== result.requestId) return;
  const previousScrollTop = messages.scrollTop;
  const shouldAutoScroll = state?.autoScroll !== false;
  requestStates.delete(result.sessionId);
  let markerAlreadyPersisted = false;
  const retrievedDocumentIds = Array.isArray(result.retrievedDocumentIds)
    ? result.retrievedDocumentIds.filter((id) => typeof id === 'string' && /^[0-9a-f-]{36}$/u.test(id))
    : [];
  const contextUsage = Array.isArray(result.contextUsage) ? result.contextUsage : [];
  const contextUsageProperty = contextUsage.length > 0 ? { contextUsage } : {};
  const retrievedDocumentsChanged = mergeRetrievedDocumentIds(session, retrievedDocumentIds);

  if (result.status === 'completed') {
    session.messages.push({
      role: 'assistant',
      content: result.answer,
      ...(result.finishReason === 'length' ? { status: 'truncated' } : {}),
      ...(Array.isArray(result.sources) && result.sources.length > 0 ? { sources: result.sources } : {}),
      ...contextUsageProperty,
    });
  } else if (result.status === 'cancelled') {
    const partialAnswer = result.answer ?? state?.answer;
    if (partialAnswer) {
      session.messages.push({
        role: 'assistant',
        content: partialAnswer,
        status: 'interrupted',
        ...(Array.isArray(result.sources) && result.sources.length > 0 ? { sources: result.sources } : {}),
        ...contextUsageProperty,
      });
    }
    const lastMessage = session.messages.at(-1);
    markerAlreadyPersisted = lastMessage?.role === 'assistant'
      && lastMessage.status === 'cancelled'
      && lastMessage.content === 'This response was cancelled.';
    if (!markerAlreadyPersisted || retrievedDocumentsChanged) {
      session.messages.push({
        role: 'assistant',
        content: 'This response was cancelled.',
        status: 'cancelled',
        ...contextUsageProperty,
      });
    } else if (contextUsage.length > 0) {
      session.messages[session.messages.length - 1] = {
        ...lastMessage,
        contextUsage: [...(lastMessage.contextUsage ?? []), ...contextUsage].slice(-100),
      };
      markerAlreadyPersisted = false;
    }
  } else {
    const partialAnswer = result.answer ?? state?.answer;
    session.messages.push(partialAnswer
      ? {
          role: 'assistant',
          content: partialAnswer,
          status: 'interrupted',
          ...(Array.isArray(result.sources) && result.sources.length > 0 ? { sources: result.sources } : {}),
          ...contextUsageProperty,
        }
      : {
          role: 'assistant',
          content: `I couldn't complete that request: ${result.error}`,
          ...contextUsageProperty,
        });
  }

  if (!markerAlreadyPersisted) {
    try {
      await saveSession(session);
    } catch (error) {
      showActivity({ kind: 'error', message: `The response finished but could not be saved: ${error.message}` });
    }
  }
  if (retrievedDocumentsChanged || contextUsage.length > 0) {
    try {
      const listing = await api.listCachedDocuments(session.id);
      if (activeSessionId === session.id) {
        libraryLoadedSessionId = session.id;
        libraryDocuments = listing.references;
        libraryFiles = listing.files;
        libraryDocumentCount = listing.documentCount;
        libraryUnindexedCount = listing.unindexedCount;
        renderDocumentLibraryTabs(session.id);
      }
    } catch (error) {
      showActivity({ kind: 'error', message: `The response finished, but retrieved files could not be listed: ${error.message}` });
    }
  }
  if (activeSessionId === session.id) {
    renderSession(session);
    messages.scrollTop = shouldAutoScroll
      ? messages.scrollHeight
      : preservedScrollTop(previousScrollTop, messages.scrollHeight, messages.clientHeight);
  } else {
    renderSessions();
  }
  if (result.status === 'completed') {
    showActivity({ kind: 'complete', message: 'Response ready.' });
  } else if (result.status === 'cancelled') {
    showActivity({ kind: 'complete', message: 'Response cancelled.' });
  } else {
    showActivity({ kind: 'error', message: result.error });
  }
}

function handleRequestChunk({ requestId, sessionId, chunk }) {
  const state = requestState(sessionId);
  if (!state || state.requestId !== requestId || typeof chunk !== 'string' || !chunk) return;
  state.answer += chunk;
  const preview = [...$('session-list').children]
    .find((item) => item.dataset.sessionId === sessionId)
    ?.querySelector('.session-preview');
  if (preview) preview.textContent = 'Typing…';
  if (activeSessionId !== sessionId || state.renderScheduled) return;
  state.renderScheduled = true;
  window.setTimeout(() => {
    state.renderScheduled = false;
    if (requestState(sessionId) === state && activeSessionId === sessionId) {
      const previousScrollTop = messages.scrollTop;
      const wrapper = messages.querySelector('.message-pending');
      let content = wrapper?.querySelector('.message-content');
      if (wrapper && !content) {
        content = document.createElement('div');
        content.className = 'message-content';
        wrapper.querySelector('.typing-indicator')?.remove();
        wrapper.removeAttribute('role');
        wrapper.append(content);
      }
      if (content) content.innerHTML = renderMarkdown(state.answer, { renderMath: false });
      messages.scrollTop = state.autoScroll === false
        ? preservedScrollTop(previousScrollTop, messages.scrollHeight, messages.clientHeight)
        : messages.scrollHeight;
      updateLimitMeters();
    }
  }, 100);
}

async function cancelCurrentRequest() {
  const state = requestState(activeSessionId);
  if (!state || !['queued', 'running'].includes(state.status)) return;
  try {
    const cancelled = await api.cancel(state.requestId);
    if (!cancelled) {
      showActivity({ kind: 'error', message: 'This request has already finished.' });
      return;
    }
    state.status = 'cancelling';
    renderSession(activeSession());
  } catch (error) {
    showActivity({ kind: 'error', message: `Cancellation was requested, but its status could not be saved: ${error.message}` });
  }
}

function handleActivity(activity) {
  if (activity.kind === 'model') {
    setAssistantStatus('starting', 'Starting local AI', 'Loading the assistant for your conversation');
  } else if (activity.kind === 'ready') {
    setAssistantStatus('ready', 'Assistant ready', 'Learn more about the model and license details');
  } else if (activity.kind === 'startup-error') {
    setAssistantStatus('unavailable', 'Assistant unavailable', activity.message.slice(0, 120));
  } else if (activity.kind !== 'complete') {
    showActivity(activity);
  }
}

$('composer').addEventListener('submit', (event) => {
  event.preventDefault();
  const question = prompt.value.trim();
  if (question) void ask(question);
});
messages.addEventListener('scroll', () => {
  const state = requestState(activeSessionId);
  if (state) state.autoScroll = isNearScrollBottom(messages);
});
$('question').addEventListener('input', updateLimitMeters);
$('cancel').addEventListener('click', () => void cancelCurrentRequest());
prompt.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    $('composer').requestSubmit();
  }
});
for (const button of document.querySelectorAll('[data-question]')) {
  button.addEventListener('click', () => void ask(button.dataset.question));
}
$('new-chat').addEventListener('click', () => void createSession());
$('session-search').addEventListener('input', renderSessions);
$('chat-nav').addEventListener('click', () => {
  if (window.matchMedia('(max-width: 820px)').matches) {
    const isOpen = appShell.classList.toggle('sessions-open');
    $('chat-nav').setAttribute('aria-expanded', String(isOpen));
  } else {
    prompt.focus();
  }
});
function openSettings() {
  if (!settingsDialog.open) settingsDialog.showModal();
}

$('settings-button').addEventListener('click', openSettings);
api.onOpenSettings(openSettings);
$('settings-close').addEventListener('click', () => settingsDialog.close());
$('document-viewer-close').addEventListener('click', () => documentViewerDialog.close());
$('activity-clear').addEventListener('click', () => showActivity({ kind: 'complete', message: '' }));
removeDocumentDialog.addEventListener('close', () => {
  const removal = pendingDocumentRemoval;
  pendingDocumentRemoval = null;
  if (removal && removeDocumentDialog.returnValue === 'remove') {
    void removeLibraryDocument(removal.sessionId, removal.referenceId, removal.name);
  }
});
$('context-window-select').addEventListener('change', async (event) => {
  const select = event.currentTarget;
  const selectedContextWindowTokens = Number(select.value);
  select.disabled = true;
  try {
    const settings = await api.setContextWindow(selectedContextWindowTokens);
    applyContextWindow(settings.contextWindowTokens);
  } catch (error) {
    applyContextWindow(contextWindowTokens);
    showActivity({ kind: 'error', message: `Could not change the context window: ${error.message}` });
  } finally {
    select.disabled = false;
  }
});
function openAbout({ version } = {}) {
  $('about-version').textContent = version ? `Version ${version}` : '';
  if (!aboutDialog.open) aboutDialog.showModal();
}

api.onOpenAbout(openAbout);
$('about-close').addEventListener('click', () => aboutDialog.close());
$('about-model-details').addEventListener('click', () => {
  aboutDialog.close();
  modelLicenseDialog.showModal();
});
$('assistant-info').addEventListener('click', () => modelLicenseDialog.showModal());
$('model-license-close').addEventListener('click', () => modelLicenseDialog.close());
for (const button of document.querySelectorAll('[data-theme-choice]')) {
  button.addEventListener('click', () => {
    applyTheme(button.dataset.themeChoice);
    localStorage.setItem('livingwords-theme', button.dataset.themeChoice);
  });
}
$('info-toggle').addEventListener('click', () => {
  if (appShell.classList.contains('info-collapsed')) openInfoPanel();
  else closeInfoPanel();
});
$('info-close').addEventListener('click', closeInfoPanel);
$('add-document-source').addEventListener('click', () => {
  const menu = $('composer-document-menu');
  const open = menu.hidden;
  menu.hidden = !open;
  $('add-document-source').setAttribute('aria-expanded', String(open));
});
$('composer-document-menu').addEventListener('click', (event) => {
  const button = event.target.closest('[data-composer-document-add]');
  if (!button) return;
  const menu = $('composer-document-menu');
  menu.hidden = true;
  $('add-document-source').setAttribute('aria-expanded', 'false');
  const sessionId = activeSessionId;
  if (button.dataset.composerDocumentAdd === 'files') void importDocuments(sessionId);
  else if (button.dataset.composerDocumentAdd === 'folder') void addDocumentFolder(sessionId);
});
$('info-add-tab').addEventListener('click', () => {
  const menu = $('info-add-menu');
  const open = menu.hidden;
  menu.hidden = !open;
  $('info-add-tab').setAttribute('aria-expanded', String(open));
});
$('info-add-menu').addEventListener('click', (event) => {
  const button = event.target.closest('[data-add-info-tab]');
  if (!button) return;
  $('info-add-menu').hidden = true;
  $('info-add-tab').setAttribute('aria-expanded', 'false');
  if (button.dataset.addInfoTab === 'documents') openDocumentLibraryTab();
  else if (button.dataset.addInfoTab === 'terminal' && activeSessionId) void addTerminalTab(activeSessionId);
});
document.addEventListener('click', (event) => {
  for (const menu of document.querySelectorAll('.document-add-menu:not([hidden])')) {
    const wrap = menu.closest('.document-add-wrap');
    if (menu.contains(event.target) || wrap?.contains(event.target)) continue;
    menu.hidden = true;
    wrap?.querySelector('.document-add-button')?.setAttribute('aria-expanded', 'false');
  }
  if ($('info-add-menu').hidden || $('info-add-menu').contains(event.target)
    || $('info-add-tab').contains(event.target)) return;
  $('info-add-menu').hidden = true;
  $('info-add-tab').setAttribute('aria-expanded', 'false');
});
api.onTerminalData(({ terminalId, data }) => {
  if (typeof terminalId !== 'string' || typeof data !== 'string') return;
  for (const state of infoSessions.values()) {
    const tab = state.tabs.find((candidate) => candidate.id === terminalId);
    if (!tab) continue;
    tab.terminal.write(data, () => {
      tab.readiness.observeRenderedOutput();
      if (activeSessionId === tab.sessionId) updateLimitMeters();
    });
    break;
  }
});
api.onTerminalExit(({ terminalId, exitCode }) => {
  if (typeof terminalId !== 'string') return;
  for (const state of infoSessions.values()) {
    const tab = state.tabs.find((candidate) => candidate.id === terminalId);
    if (!tab) continue;
    tab.started = false;
    tab.shellReady = false;
    tab.readiness.fail(new Error('Terminal exited before its shell prompt was ready.'));
    tab.terminal.writeln(`\r\nProcess exited${Number.isInteger(exitCode) ? ` with code ${exitCode}` : ''}.`);
    break;
  }
});
api.onTerminalCommandRequest((request) => {
  void handleTerminalCommandRequest(request);
});
api.onDocumentEditRequest((request) => {
  void handleDocumentEditRequest(request);
});
$('setup-later').addEventListener('click', () => setupDialog.close());
$('setup-start').addEventListener('click', () => setupDialog.close());
api.onActivity((activity) => {
  handleActivity(activity);
});
api.onRequestStatus(handleRequestStatus);
api.onRequestChunk(handleRequestChunk);
api.onRequestResult((result) => void handleRequestResult(result));
initializePanelWidths();
installPanelResizer('sessions');
installPanelResizer('info');
window.addEventListener('resize', () => {
  for (const panel of Object.keys(PANEL_WIDTHS)) {
    const property = panel === 'sessions' ? '--sessions-width' : '--info-width';
    const width = Number.parseFloat(getComputedStyle(appShell).getPropertyValue(property))
      || PANEL_WIDTHS[panel].fallback;
    setPanelWidth(panel, clampPanelWidth(panel, width));
  }
  for (const tab of infoSessions.get(activeSessionId)?.tabs ?? []) fitTerminal(tab);
});
applyTheme(localStorage.getItem('livingwords-theme') ?? 'dark');
void initializeRenderer();
