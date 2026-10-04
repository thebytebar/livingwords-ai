import { FitAddon } from '../node_modules/@xterm/addon-fit/lib/addon-fit.mjs';
import { Terminal } from '../node_modules/@xterm/xterm/lib/xterm.mjs';
import renderMathInElement from '../node_modules/katex/dist/contrib/auto-render.mjs';
import { clampSidePanelWidth, SIDE_PANEL_BOUNDS } from './panel-layout.mjs';
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
const appShell = $('app-shell');
let contextWindowTokens = DEFAULT_CONTEXT_WINDOW_TOKENS;
let responseTokenLimit = responseTokenLimitForContext(contextWindowTokens);
let contextMeterTokens = contextWindowPreset(contextWindowTokens).meterTokens;
const SYSTEM_PROMPT = 'You are a helpful general-purpose assistant. Answer accurately, be clear, and acknowledge uncertainty when appropriate.';
const PANEL_WIDTHS = {
  sessions: { key: 'livingwords-sessions-width', fallback: 264 },
  info: { key: 'livingwords-info-width', fallback: 300 },
};
let assistantAvailable = false;
let sessions = [];
let activeSessionId = null;
let responseMeterId = 0;
const requestStates = new Map();
const infoSessions = new Map();

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
    state = { tabs: [], selectedId: null };
    infoSessions.set(sessionId, state);
  }
  return state;
}

function selectedTerminal(sessionId = activeSessionId) {
  const state = infoSessions.get(sessionId);
  return state?.tabs.find((tab) => tab.id === state.selectedId) ?? null;
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
    select.setAttribute('aria-controls', `terminal-panel-${tab.id}`);
    select.setAttribute('aria-selected', String(selected));
    select.tabIndex = selected ? 0 : -1;
    select.textContent = tab.title;
    select.addEventListener('click', () => {
      state.selectedId = tab.id;
      renderInfoPanel();
      fitTerminal(tab);
      updateLimitMeters();
    });
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'info-tab-close';
    close.setAttribute('aria-label', `Close ${tab.title}`);
    close.title = `Close ${tab.title}`;
    close.textContent = '×';
    close.addEventListener('click', () => closeInfoTab(activeSessionId, tab.id));
    wrapper.append(select, close);
    tabList.append(wrapper);

    tab.surface.hidden = !selected;
    tab.surface.id = `terminal-panel-${tab.id}`;
    tab.surface.setAttribute('role', 'tabpanel');
    tab.surface.setAttribute('aria-labelledby', `info-tab-${tab.id}`);
    panels.append(tab.surface);
  }
}

function fitTerminal(tab) {
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

function closeInfoTab(sessionId, terminalId) {
  const state = infoSessions.get(sessionId);
  const index = state?.tabs.findIndex((tab) => tab.id === terminalId) ?? -1;
  if (!state || index < 0) return;
  const [tab] = state.tabs.splice(index, 1);
  tab.readiness.fail(new Error('Terminal closed before the shell prompt was ready.'));
  tab.resizeObserver?.disconnect();
  tab.terminal.dispose();
  void api.closeTerminal(tab.id, sessionId).catch((error) => {
    showActivity({ kind: 'error', message: `Could not close terminal: ${error.message}` });
  });
  if (state.selectedId === tab.id) {
    state.selectedId = state.tabs[Math.min(index, state.tabs.length - 1)]?.id ?? null;
  }
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
    tab.readiness.fail(new Error('Conversation closed before the shell prompt was ready.'));
    tab.resizeObserver?.disconnect();
    tab.terminal.dispose();
  }
  infoSessions.delete(sessionId);
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
  return estimateTokens(`${SYSTEM_PROMPT}\n${selectedTerminalOutput}\n${prompt}`);
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
  prompt.disabled = Boolean(state);
  cancelButton.hidden = !state || !['queued', 'running'].includes(state.status);
  cancelButton.disabled = !state || !['queued', 'running'].includes(state.status);
  cancelButton.textContent = state?.status === 'queued' ? 'Remove from queue' : 'Cancel';
  updateLimitMeters();
}

function showActivity(activity) {
  const container = $('activity');
  container.hidden = !activity.message;
  container.classList.toggle('activity-error', activity.kind === 'error' || activity.kind === 'startup-error');
  $('activity-message').textContent = activity.message || '';
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
      preview.textContent = state.status === 'queued'
        ? `Queued${state.queuePosition ? ` · ${state.queuePosition}` : ''}`
        : state.status === 'cancelling'
          ? 'Cancelling…'
          : state.status === 'saving'
            ? 'Submitting…'
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

function renderMarkdown(content) {
  const html = window.marked.parse(content);
  const container = document.createElement('div');
  container.innerHTML = window.DOMPurify.sanitize(html);
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
  return container.innerHTML;
}

function responseFooter(content, { streaming = false } = {}) {
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
    `Approximately ${tokens} of ${responseTokenLimit} response tokens${streaming ? ', response in progress' : ''}`,
  );
  ring.setAttribute('aria-describedby', tooltipId);

  const tooltip = document.createElement('div');
  tooltip.id = tooltipId;
  tooltip.className = 'context-meter-tooltip';
  tooltip.setAttribute('role', 'tooltip');
  const heading = document.createElement('div');
  heading.className = 'limit-meter-heading';
  const title = document.createElement('span');
  title.textContent = streaming ? 'Response so far' : 'Response estimate';
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
    content.innerHTML = renderMarkdown(state.answer);
    wrapper.append(label, content, responseFooter(state.answer, { streaming: true }));
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
  activeSessionId = session.id;
  $('conversation-title').textContent = session.title || 'A thoughtful place to begin';
  messages.replaceChildren();
  const state = requestState(session.id);
  const showMessages = session.messages.length > 0 || Boolean(state);
  welcome.hidden = showMessages;
  appShell.classList.toggle('welcome-active', !showMessages);
  messages.style.display = showMessages ? 'flex' : 'none';
  for (const message of session.messages) renderMessage(message);
  if (state && state.status !== 'saving') renderPendingMessage(state);
  messages.scrollTop = messages.scrollHeight;
  updateComposerControls();
  renderSessions();
  if (sessionChanged) {
    renderInfoPanel();
    const tab = selectedTerminal(session.id);
    if (tab) fitTerminal(tab);
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
    `"${session.title || 'New conversation'}" and its messages will be permanently deleted.`;
  const deleteDialog = $('delete-dialog');
  const confirmed = await new Promise((resolve) => {
    deleteDialog.addEventListener('close', () => {
      resolve(deleteDialog.returnValue === 'delete');
    }, { once: true });
    deleteDialog.showModal();
  });
  if (!confirmed) return;

  try {
    await api.deleteSession(id);
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
    showActivity({ kind: 'complete', message: 'Conversation deleted.' });
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
    for (const tab of state.tabs) tab.terminal.options.theme = terminalTheme;
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
  appShell.classList.remove('sessions-open');
  $('chat-nav').setAttribute('aria-expanded', 'false');
  appShell.classList.remove('info-collapsed');
  $('info-panel').hidden = false;
  $('info-toggle').setAttribute('aria-expanded', 'true');
  $('info-toggle').title = 'Hide tools panel';
  setPanelWidth('info', Number.parseFloat(getComputedStyle(appShell).getPropertyValue('--info-width')) || PANEL_WIDTHS.info.fallback);
  setPanelWidth('sessions', Number.parseFloat(getComputedStyle(appShell).getPropertyValue('--sessions-width')) || PANEL_WIDTHS.sessions.fallback);
  setPanelWidth('info', Number.parseFloat(getComputedStyle(appShell).getPropertyValue('--info-width')) || PANEL_WIDTHS.info.fallback);
  renderInfoPanel();
  const tab = selectedTerminal();
  if (tab) fitTerminal(tab);
}

function closeInfoPanel() {
  appShell.classList.add('info-collapsed');
  $('info-panel').hidden = true;
  $('info-toggle').setAttribute('aria-expanded', 'false');
  $('info-toggle').title = 'Show tools panel';
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
  requestStates.delete(result.sessionId);
  let markerAlreadyPersisted = false;

  if (result.status === 'completed') {
    session.messages.push({
      role: 'assistant',
      content: result.answer,
      ...(result.finishReason === 'length' ? { status: 'truncated' } : {}),
    });
  } else if (result.status === 'cancelled') {
    if (state?.answer) {
      session.messages.push({ role: 'assistant', content: state.answer, status: 'interrupted' });
    }
    const lastMessage = session.messages.at(-1);
    markerAlreadyPersisted = lastMessage?.role === 'assistant'
      && lastMessage.status === 'cancelled'
      && lastMessage.content === 'This response was cancelled.';
    if (!markerAlreadyPersisted) {
      session.messages.push({
        role: 'assistant',
        content: 'This response was cancelled.',
        status: 'cancelled',
      });
    }
  } else {
    session.messages.push(state?.answer
      ? { role: 'assistant', content: state.answer, status: 'interrupted' }
      : {
          role: 'assistant',
          content: `I couldn't complete that request: ${result.error}`,
        });
  }

  if (!markerAlreadyPersisted) {
    try {
      await saveSession(session);
    } catch (error) {
      showActivity({ kind: 'error', message: `The response finished but could not be saved: ${error.message}` });
    }
  }
  if (activeSessionId === session.id) {
    renderSession(session);
    messages.scrollTop = messages.scrollHeight;
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
  if (activeSessionId !== sessionId || state.renderScheduled) return;
  state.renderScheduled = true;
  requestAnimationFrame(() => {
    state.renderScheduled = false;
    if (requestState(sessionId) === state && activeSessionId === sessionId) {
      renderSession(activeSession());
      updateLimitMeters();
    }
  });
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
  if (button.dataset.addInfoTab === 'terminal' && activeSessionId) {
    void addTerminalTab(activeSessionId);
  }
});
document.addEventListener('click', (event) => {
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
