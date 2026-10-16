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
import { createTerminalReadiness } from './terminal-readiness.mjs';
import { MAX_TERMINAL_CONTEXT_LENGTH, readTerminalContext } from './terminal-context.mjs';
import { terminalThemeFromColors } from './terminal-theme.mjs';
import {
  canCloseInfoTab,
  isAgentTrace,
  latestAgentTrace,
  traceLiveDecisionActivity,
  traceStepActivities,
  traceToolActivity,
  workflowSelectionActivity,
  formatDuration,
  traceDurationMs,
  updateTraceTab,
} from './agent-trace.mjs';
import {
  pendingIndicatorText,
  sessionRequestPreviewText,
  shouldShowTypingAnimation,
} from './pending-indicator.mjs';
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
const toolDetailsDialog = $('tool-details-dialog');
const removeDocumentDialog = $('remove-document-dialog');
const appShell = $('app-shell');
let contextWindowTokens = DEFAULT_CONTEXT_WINDOW_TOKENS;
let responseTokenLimit = responseTokenLimitForContext(contextWindowTokens);
let contextMeterTokens = contextWindowPreset(contextWindowTokens).meterTokens;
const PANEL_WIDTHS = {
  sessions: { key: 'livingwords-sessions-width', fallback: 264 },
  info: { key: 'livingwords-info-width', fallback: 300 },
};
const INFO_STATE_KEY_PREFIX = 'livingwords-info-state:';
const MAX_DOCUMENT_REFERENCES = 100;
const MAX_RIGHT_PANEL_CONTEXT_LENGTH = 32_000;
const MAX_RIGHT_PANEL_TAB_CONTENT_LENGTH = 8_000;
const INFO_TAB_ICON_PATHS = Object.freeze({
  trace: ['M3 12h4l2-6 4 12 2-6h6'],
  browser: ['M4 5h16v14H4z', 'M4 9h16', 'M7 7h.01', 'M10 7h.01'],
  documents: ['M6 3.75h7l5 5v11.5H6z', 'M13 3.75v5h5', 'M9 13h6', 'M9 16.5h6'],
  'web-search': ['M10.8 3.8a7 7 0 1 0 0 14 7 7 0 0 0 0-14Z', 'm16 16 4.2 4.2'],
  terminal: ['M4 5h16v14H4z', 'm7 9 3 3-3 3', 'M12 15h5'],
});
const TOOL_CATALOG = [
  {
    id: 'documents',
    name: 'Files',
    summary: 'Find answers in files and folders you attach to a conversation.',
    description: 'LivingWords can search, summarize, and read files or folders that you attach to the current conversation. It can use those sources to answer questions and show where information came from.',
    icon: ['M6 3.75h7l5 5v11.5H6z', 'M13 3.75v5h5', 'M9 13h6', 'M9 16.5h6'],
  },
  {
    id: 'document-edits',
    name: 'File edits',
    summary: 'Review proposed changes to attached text files before they are saved.',
    description: 'When you ask LivingWords to change an attached text file, it can prepare a proposed file edit and show you exactly what would change. You can review the comparison before deciding whether to apply it.',
    icon: ['M6 3.75h8l4 4v4.5', 'M14 3.75v4h4', 'M8 12h4', 'M8 15h3', 'm13.5 18.5 5.75-5.75 2 2-5.75 5.75-2.5.5z'],
  },
  {
    id: 'web-research',
    name: 'Web research',
    summary: 'Search DuckDuckGo for current information, then read public pages in the app.',
    description: 'LivingWords is integrated with DuckDuckGo Lite at lite.duckduckgo.com. Search results provided by DuckDuckGo appear in the Web Search tab, and selected result pages open in the Browser tab.',
    icon: ['M12 20.25a8.25 8.25 0 1 0 0-16.5 8.25 8.25 0 0 0 0 16.5Z', 'M3.9 12h16.2', 'M12 3.75c2.1 2.25 3.15 5 3.15 8.25S14.1 18 12 20.25C9.9 18 8.85 15.25 8.85 12S9.9 6 12 3.75Z', 'm17.8 17.8 3 3'],
  },
  {
    id: 'right-panel-context',
    name: 'Open tabs',
    summary: 'Inspect visible content in tabs open in the right panel when it is relevant.',
    description: 'When a request depends on information in the right panel, LivingWords can list the open tabs and read a selected tab’s visible text from Activity, Files, Web Search, Terminal, or Browser. Browser pages are read live; the other tab content is a bounded snapshot from when the request began. Tab content is treated as untrusted data, and actual file contents are read with the Files tools.',
    icon: ['M3 4h18v16H3z', 'M14 4v16', 'M6.5 8h4', 'M6.5 11.5h4', 'M17 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z', 'm18.8 13.8 2 2'],
  },
  {
    id: 'calculator',
    name: 'Calculator',
    summary: 'Work out arithmetic accurately, without guessing.',
    description: 'The calculator handles arithmetic, percentages, parentheses, powers, and common math functions. It computes the result directly instead of asking the language model to estimate it.',
    icon: ['M6 3.75h12v16.5H6z', 'M9 7.5h6', 'M9 12h.01', 'M12 12h.01', 'M15 12h.01', 'M9 15.75h.01', 'M12 15.75h.01', 'M15 15.75h.01'],
  },
  {
    id: 'date-time',
    name: 'Date & time',
    summary: 'Check your device’s current local date and time.',
    description: 'When a request depends on what time it is where you are, LivingWords can check the current date and time from your device, including your configured time zone.',
    icon: ['M12 20.25a8.25 8.25 0 1 0 0-16.5 8.25 8.25 0 0 0 0 16.5Z', 'M12 7.5v4.75l3 1.75'],
  },
  {
    id: 'save-workflow',
    name: 'Save workflow',
    summary: 'Save a completed reusable workflow created through a guided conversation.',
    description: 'The built-in workflow builder may ask up to two optional clarifying questions, offers feedback and suggestions, and incorporates your answers before drafting. You can answer, skip, or say continue; missing details are not blockers, and the builder will use practical defaults. Its Save workflow action stores the completed workflow locally and opens it in Workflows, where you can edit or delete it.',
    icon: ['M5 5h5v5H5z', 'M14 5h5v5h-5z', 'M5 14h5v5H5z', 'M14 14h5v5h-5z', 'M10 7.5h4', 'M7.5 10v4', 'M16.5 10v4', 'M10 16.5h4'],
  },
  {
    id: 'terminal',
    name: 'Terminal',
    summary: 'Run a command only after you review and approve it.',
    description: 'For software and computer tasks, LivingWords can ask to run a single command in the conversation’s Terminal. You see the exact command and can approve or decline it before it runs.',
    icon: ['M4.5 5.25h15v13.5h-15z', 'm7.5 9 2.5 2.25-2.5 2.25', 'M12.5 13.5h3.25'],
  },
];
let assistantAvailable = false;
let sessions = [];
let workflows = [];
let workflowsLoaded = false;
let workflowsLoading = false;
let selectedWorkflowId = null;
let workflowIsNew = false;
let workflowEditorDirty = false;
let workflowOrderSaving = false;
let draggedWorkflowId = null;
let activeWorkspace = 'sessions';
let libraryDocuments = [];
let libraryFiles = [];
let libraryDocumentCount = 0;
let libraryUnindexedCount = 0;
let libraryLoadedSessionId = null;
let traceDurationTimer = null;
let browserBoundsFrame = null;
let activeSessionId = null;
let responseMeterId = 0;
const requestStates = new Map();
const infoSessions = new Map();
const browserStates = new Map();
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
    const session = sessions.find((item) => item.id === sessionId);
    const traceTab = createTraceTab(sessionId, latestAgentTrace(session?.messages));
    state.tabs.unshift(traceTab);
    if (!state.selectedId || traceTab.trace) state.selectedId = traceTab.id;
    infoSessions.set(sessionId, state);
  } else {
    let traceTab = state.tabs.find((tab) => tab.kind === 'trace');
    if (!traceTab) {
      const session = sessions.find((item) => item.id === sessionId);
      traceTab = createTraceTab(sessionId, latestAgentTrace(session?.messages));
      state.tabs.unshift(traceTab);
      if (!state.selectedId) state.selectedId = traceTab.id;
    } else if (!traceTab.recording) {
      const session = sessions.find((item) => item.id === sessionId);
      traceTab.trace = latestAgentTrace(session?.messages) ?? traceTab.trace;
    }
  }
  return state;
}

function createDocumentTab(sessionId) {
  return {
    id: window.crypto.randomUUID(),
    sessionId,
    kind: 'documents',
    title: 'Files',
    surface: document.createElement('div'),
  };
}

function createWebSearchTab(sessionId) {
  return {
    id: `web-search-${sessionId}`,
    sessionId,
    kind: 'web-search',
    title: 'Web Search',
    surface: document.createElement('div'),
    searches: [],
  };
}

function createBrowserTab(sessionId, browserTabId = window.crypto.randomUUID(), url = '') {
  return {
    id: `browser-${browserTabId}`,
    browserTabId,
    sessionId,
    kind: 'browser',
    title: browserTitleFromUrl(url),
    surface: document.createElement('div'),
  };
}

function createInfoTabIcon(kind) {
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('aria-hidden', 'true');
  icon.setAttribute('focusable', 'false');
  for (const pathData of INFO_TAB_ICON_PATHS[kind] ?? []) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', pathData);
    icon.append(path);
  }
  return icon;
}

function browserTitleFromUrl(url) {
  try {
    return new URL(url).hostname || 'Browser';
  } catch {
    return 'Browser';
  }
}

function createTraceTab(sessionId, trace = null) {
  return {
    id: `trace-${sessionId}`,
    sessionId,
    kind: 'trace',
    title: 'Activity',
    surface: document.createElement('div'),
    trace: isAgentTrace(trace) ? trace : null,
    recording: false,
    workflowSelection: null,
  };
}

function appendActivity(container, activity) {
  const isCompleted = activity.completed === true;
  const item = document.createElement('div');
  item.className = 'agent-trace-step';
  if (!isCompleted) item.classList.add('agent-trace-step-pending');
  const header = document.createElement('div');
  header.className = 'agent-trace-step-header';
  const title = document.createElement('span');
  title.className = 'agent-trace-step-title';
  title.textContent = activity.title;
  header.append(title);
  item.append(header);
  if (isCompleted && typeof activity.description === 'string' && activity.description) {
    const description = document.createElement('p');
    description.className = 'agent-trace-description';
    description.textContent = activity.description;
    item.append(description);
  }
  container.append(item);
}

function appendLiveToolActivities(container, calls, events) {
  for (const call of calls) {
    appendActivity(container, traceToolActivity(
      call,
      events.filter((event) => event.call_index === call.call_index),
    ));
  }
}

function traceDurationElement(className, label, startedAt, completedAt = '') {
  if (typeof startedAt !== 'string' || !Number.isFinite(Date.parse(startedAt))) return null;
  const duration = document.createElement('span');
  duration.className = className;
  duration.dataset.startedAt = startedAt;
  if (completedAt && Number.isFinite(Date.parse(completedAt))) {
    duration.dataset.completedAt = completedAt;
  }
  duration.dataset.label = label;
  refreshTraceDurationElement(duration);
  return duration;
}

function refreshTraceDurationElement(element, now = Date.now()) {
  const start = Date.parse(element.dataset.startedAt);
  const finish = element.dataset.completedAt ? Date.parse(element.dataset.completedAt) : now;
  if (!Number.isFinite(start) || !Number.isFinite(finish)) return;
  const duration = formatDuration(Math.max(0, finish - start));
  element.textContent = element.dataset.label ? `${element.dataset.label}: ${duration}` : duration;
}

function refreshTraceDurationTicker() {
  const recordingTabs = [...infoSessions.values()]
    .flatMap((state) => state.tabs)
    .filter((tab) => tab.kind === 'trace' && tab.recording);
  if (recordingTabs.length === 0) {
    if (traceDurationTimer !== null) {
      window.clearInterval(traceDurationTimer);
      traceDurationTimer = null;
    }
    return;
  }
  if (traceDurationTimer !== null) return;
  traceDurationTimer = window.setInterval(() => {
    const now = Date.now();
    for (const element of document.querySelectorAll('.agent-trace-duration[data-started-at]')) {
      refreshTraceDurationElement(element, now);
    }
  }, 1_000);
}

function appendLiveProgress(container, tab) {
  const calls = tab.liveToolStep?.calls ?? [];
  const events = tab.liveToolStep?.events ?? [];
  if (!tab.progress && events.length === 0 && calls.length === 0) return;
  appendActivity(container, traceLiveDecisionActivity(tab.progress, calls));
  appendLiveToolActivities(container, calls, events);
}

function renderTraceSurface(tab) {
  const surface = tab.surface;
  const previousSteps = surface.querySelector('.agent-trace-steps');
  const wasNearBottom = previousSteps ? isNearScrollBottom({
    scrollHeight: previousSteps.scrollHeight,
    clientHeight: previousSteps.clientHeight,
    scrollTop: previousSteps.scrollTop,
  }) : true;
  const previousScrollTop = previousSteps?.scrollTop ?? 0;
  surface.className = 'agent-trace-surface';
  surface.replaceChildren();
  const startedAt = tab.recording
    ? (tab.recordingStartedAt ?? tab.progress?.started_at)
    : (tab.trace?.started_at ?? tab.recordingStartedAt);
  const completedAt = tab.recording
    ? ''
    : (tab.recordingCompletedAt ?? tab.trace?.completed_at ?? '');
  const heading = document.createElement('div');
  heading.className = 'agent-trace-heading';
  const title = document.createElement('h2');
  title.textContent = 'Activities';
  heading.append(title);
  surface.append(heading);
  const divider = document.createElement('hr');
  divider.className = 'agent-trace-divider';
  surface.append(divider);
  const stepsContainer = document.createElement('div');
  stepsContainer.className = 'agent-trace-steps';
  if (!tab.trace && !tab.recording && !tab.workflowSelection) {
    const empty = document.createElement('p');
    empty.className = 'agent-trace-empty';
    empty.textContent = 'No activity yet. It will appear here while the assistant works.';
    stepsContainer.append(empty);
  }
  if (tab.workflowSelection) {
    appendActivity(stepsContainer, workflowSelectionActivity(tab.workflowSelection.name));
  }
  if (isAgentTrace(tab.trace)) {
    for (const step of tab.trace.steps) {
      const activities = traceStepActivities(step);
      for (const activity of activities) appendActivity(stepsContainer, activity);
    }
  }
  if (tab.recording) appendLiveProgress(stepsContainer, tab);
  surface.append(stepsContainer);

  const footer = document.createElement('footer');
  footer.className = 'agent-trace-footer';
  const duration = traceDurationElement(
    'agent-trace-duration',
    tab.recording ? 'Elapsed' : 'Duration',
    startedAt,
    completedAt,
  );
  if (duration) footer.append(duration);
  surface.append(footer);
  stepsContainer.scrollTop = wasNearBottom
    ? stepsContainer.scrollHeight
    : preservedScrollTop(previousScrollTop, stepsContainer.scrollHeight, stepsContainer.clientHeight);
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

  const hasRestorableDocuments = saved.documentsAdded === true;
  const state = {
    tabs: [],
    selectedId: null,
    open: saved.open === true,
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
    documentsAdded: state.tabs.some((tab) => tab.kind === 'documents'),
  }));
}

function setWorkspace(workspace, { openSidebar = false } = {}) {
  activeWorkspace = workspace === 'workflows' || workspace === 'tools' ? workspace : 'sessions';
  const isWorkflows = activeWorkspace === 'workflows';
  const isTools = activeWorkspace === 'tools';
  appShell.classList.toggle('workflows-active', isWorkflows);
  appShell.classList.toggle('tools-active', isTools);
  appShell.classList.remove('sessions-open');
  $('sessions-panel').hidden = isWorkflows;
  $('workflow-sidebar').hidden = !isWorkflows;
  $('tools-main').hidden = !isTools;
  $('main-panel').hidden = isWorkflows || isTools;
  $('workflow-main').hidden = !isWorkflows;
  $('info-toggle').hidden = isWorkflows || isTools;
  $('info-panel').hidden = isWorkflows || isTools || !(infoState()?.open ?? false);

  $('chat-nav').classList.toggle('active', !isWorkflows && !isTools);
  if (isWorkflows || isTools) $('chat-nav').removeAttribute('aria-current');
  else $('chat-nav').setAttribute('aria-current', 'page');
  $('workflows-nav').classList.toggle('active', isWorkflows);
  if (isWorkflows) $('workflows-nav').setAttribute('aria-current', 'page');
  else $('workflows-nav').removeAttribute('aria-current');
  $('tools-nav').classList.toggle('active', isTools);
  if (isTools) $('tools-nav').setAttribute('aria-current', 'page');
  else $('tools-nav').removeAttribute('aria-current');
  $('chat-nav').setAttribute('aria-expanded', 'false');
  $('workflows-nav').setAttribute('aria-expanded', String(isWorkflows && openSidebar));

  if (isWorkflows && !workflowsLoaded) void loadWorkflowPreferences();
  if (!isWorkflows && !isTools && activeSessionId) {
    const panelOpen = infoState()?.open ?? false;
    appShell.classList.toggle('info-collapsed', !panelOpen);
    $('info-toggle').setAttribute('aria-expanded', String(panelOpen));
    $('info-toggle').title = panelOpen
        ? 'Hide Activity, tools, and files'
        : 'Show Activity, tools, and files';
    renderInfoPanel();
    const tab = selectedTerminal();
    if (tab && panelOpen) fitTerminal(tab);
  }
  if (isWorkflows && openSidebar) {
    appShell.classList.add('sessions-open');
    $('workflows-nav').setAttribute('aria-expanded', 'true');
  }
  queueBrowserBoundsSync();
}

function renderToolCards() {
  const grid = $('tools-grid');
  grid.replaceChildren();
  for (const tool of TOOL_CATALOG) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'tool-card';
    card.dataset.toolId = tool.id;
    card.setAttribute('aria-haspopup', 'dialog');
    card.setAttribute('aria-label', `${tool.name}. ${tool.summary} View details.`);

    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('aria-hidden', 'true');
    icon.setAttribute('focusable', 'false');
    for (const pathData of tool.icon) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', pathData);
      icon.append(path);
    }
    const iconWrap = document.createElement('span');
    iconWrap.className = 'tool-card-icon';
    iconWrap.append(icon);

    const name = document.createElement('h2');
    name.className = 'tool-card-name';
    name.textContent = tool.name;
    const summary = document.createElement('p');
    summary.className = 'tool-card-summary';
    summary.textContent = tool.summary;
    const prompt = document.createElement('span');
    prompt.className = 'tool-card-prompt';
    prompt.textContent = 'Learn more';

    card.append(iconWrap, name, summary, prompt);
    grid.append(card);
  }
}

function selectedTerminal(sessionId = activeSessionId) {
  const state = infoSessions.get(sessionId);
  return state?.tabs.find((tab) => tab.kind === 'terminal' && tab.id === state.selectedId) ?? null;
}

function focusActivityTab(sessionId, state = infoState(sessionId)) {
  const activityTab = state?.tabs.find((tab) => tab.kind === 'trace');
  if (!state || !activityTab) return;
  state.selectedId = activityTab.id;
  if (activeWorkspace === 'sessions' && activeSessionId === sessionId) state.open = true;
  persistInfoState(sessionId, state);
  if (activeSessionId === sessionId) openInfoPanel();
}

function ensureBrowserTab(sessionId, browserTabId, url = '') {
  if (!sessionId || typeof browserTabId !== 'string') return;
  const state = infoState(sessionId);
  let tab = state.tabs.find((candidate) => candidate.kind === 'browser'
    && candidate.browserTabId === browserTabId);
  if (!tab) {
    tab = createBrowserTab(sessionId, browserTabId, url);
    state.tabs.push(tab);
  }
  persistInfoState(sessionId, state);
  if (activeSessionId === sessionId && state.open && activeWorkspace === 'sessions') {
    renderInfoPanel();
  }
}

function openBrowserTab(sessionId, url = '', { select = false } = {}) {
  if (!sessionId) return null;
  const state = infoState(sessionId);
  const tab = createBrowserTab(sessionId, window.crypto.randomUUID(), url);
  state.tabs.push(tab);
  if (select) state.selectedId = tab.id;
  if (activeWorkspace === 'sessions' && activeSessionId === sessionId) state.open = true;
  persistInfoState(sessionId, state);
  if (activeSessionId === sessionId) openInfoPanel();
  return tab;
}

function showWebSearchResults(sessionId, resultSet) {
  if (!sessionId || !resultSet || typeof resultSet.query !== 'string'
    || !Array.isArray(resultSet.results)) return;
  const state = infoState(sessionId);
  let tab = state.tabs.find((candidate) => candidate.kind === 'web-search');
  let created = false;
  if (!tab) {
    tab = createWebSearchTab(sessionId);
    state.tabs.push(tab);
    created = true;
  }
  tab.query = resultSet.query;
  tab.searching = false;
  tab.searchError = '';
  tab.searches.push(resultSet);
  if (tab.searches.length > 20) tab.searches.shift();
  persistInfoState(sessionId, state);
  if (activeSessionId === sessionId && activeWorkspace === 'sessions' && state.open) {
    if (created) renderInfoPanel();
    else if (state.selectedId === tab.id) renderWebSearchSurface(tab);
  }
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

function browserStateFor(tab) {
  return browserStates.get(JSON.stringify([tab.sessionId, tab.browserTabId]))
    ?? { url: '', title: '', loading: false, error: '' };
}

function renderBrowserSurface(tab) {
  const surface = tab.surface;
  surface.replaceChildren();
  surface.className = 'browser-tab-surface';

  const toolbar = document.createElement('div');
  toolbar.className = 'browser-toolbar';
  const addBrowserButton = (label, title, action) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'quiet-button browser-control';
    button.textContent = label;
    button.title = title;
    button.setAttribute('aria-label', title);
    button.addEventListener('click', () => {
      void action().catch((error) => {
        showActivity({ kind: 'error', message: `Browser action failed: ${error.message}` });
      });
    });
    return button;
  };
  toolbar.append(
    addBrowserButton('‹', 'Go back', () => api.browserBack(tab.sessionId, tab.browserTabId)),
    addBrowserButton('›', 'Go forward', () => api.browserForward(tab.sessionId, tab.browserTabId)),
    addBrowserButton('↻', 'Reload page', () => api.reloadBrowser(tab.sessionId, tab.browserTabId)),
  );

  const form = document.createElement('form');
  form.className = 'browser-navigation-form';
  const address = document.createElement('input');
  address.type = 'text';
  address.className = 'browser-address';
  address.autocomplete = 'off';
  address.spellcheck = false;
  address.setAttribute('aria-label', 'Search the web or enter a page URL');
  address.placeholder = 'Search the web or enter a URL';
  const current = browserStateFor(tab);
  address.value = current.url;
  address.addEventListener('focus', () => address.select());
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = address.value.trim();
    if (!value) return;
    let parsedUrl;
    try {
      parsedUrl = new URL(value);
    } catch {
      parsedUrl = null;
    }
    const action = parsedUrl && ['http:', 'https:'].includes(parsedUrl.protocol)
      ? api.navigateBrowser(tab.sessionId, tab.browserTabId, value)
      : api.searchBrowser(tab.sessionId, tab.browserTabId, value);
    void action.catch((error) => {
      showActivity({ kind: 'error', message: `Could not open web content: ${error.message}` });
    });
  });
  const go = document.createElement('button');
  go.type = 'submit';
  go.className = 'quiet-button browser-control';
  go.textContent = 'Go';
  form.append(address, go);
  toolbar.append(form);

  const status = document.createElement('p');
  status.className = 'browser-status';
  status.setAttribute('role', 'status');
  status.textContent = current.error || (current.loading
    ? 'Loading web page…'
    : current.title || 'Websites and search requests are external; page content is untrusted.');

  const viewport = document.createElement('div');
  viewport.className = 'browser-viewport';
  viewport.setAttribute('aria-label', 'Visible web page');
  surface.append(toolbar, status, viewport);
}

function renderWebSearchSurface(tab) {
  const surface = tab.surface;
  surface.replaceChildren();
  surface.className = 'web-search-tab-surface';
  const heading = document.createElement('div');
  heading.className = 'web-search-tab-heading';
  const title = document.createElement('h2');
  title.textContent = 'Search results';
  const attribution = document.createElement('p');
  attribution.className = 'web-search-attribution';
  attribution.textContent = 'Powered by ';
  const attributionLink = document.createElement('a');
  attributionLink.href = 'https://lite.duckduckgo.com/lite/';
  attributionLink.textContent = 'DuckDuckGo';
  attributionLink.setAttribute('aria-label', 'Search powered by DuckDuckGo');
  attributionLink.title = 'Search powered by DuckDuckGo';
  attributionLink.addEventListener('click', (event) => {
    event.preventDefault();
    const browserTab = openBrowserTab(tab.sessionId, attributionLink.href);
    void api.navigateBrowser(tab.sessionId, browserTab.browserTabId, attributionLink.href).catch((error) => {
      showActivity({ kind: 'error', message: `Could not open DuckDuckGo Lite: ${error.message}` });
    });
  });
  attribution.append(attributionLink);
  heading.append(title, attribution);
  surface.append(heading);

  const form = document.createElement('form');
  form.className = 'web-search-form';
  form.setAttribute('role', 'search');
  form.setAttribute('aria-label', 'Search the web');
  const query = document.createElement('input');
  query.type = 'search';
  query.className = 'web-search-query';
  query.maxLength = 500;
  query.autocomplete = 'off';
  query.placeholder = 'Search the web';
  query.setAttribute('aria-label', 'Web search query');
  query.value = tab.query ?? tab.searches.at(-1)?.query ?? '';
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'quiet-button web-search-submit';
  submit.textContent = tab.searching ? 'Searching…' : 'Search';
  submit.disabled = tab.searching === true;
  const status = document.createElement('p');
  status.className = 'web-search-status';
  status.setAttribute('role', 'status');
  status.textContent = tab.searching ? 'Searching…' : tab.searchError ?? '';
  form.append(query, submit);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const searchQuery = query.value.trim();
    if (!searchQuery || tab.searching) return;
    tab.query = searchQuery;
    tab.searching = true;
    tab.searchError = '';
    submit.disabled = true;
    submit.textContent = 'Searching…';
    status.textContent = 'Searching…';
    void api.searchWeb(tab.sessionId, searchQuery).catch((error) => {
      tab.searching = false;
      tab.searchError = error.message;
      renderWebSearchSurface(tab);
    });
  });
  surface.append(form, status);

  const searches = document.createElement('div');
  searches.className = 'web-search-runs';
  for (const resultSet of tab.searches) {
    const section = document.createElement('section');
    section.className = 'web-search-run';
    const query = document.createElement('h3');
    query.textContent = resultSet.query;
    section.append(query);
    if (resultSet.results.length === 0) {
      section.classList.add('web-search-run-empty');
    }
    for (const result of resultSet.results) {
      if (!result || typeof result.title !== 'string' || typeof result.url !== 'string') continue;
      let url;
      try {
        url = new URL(result.url);
      } catch {
        continue;
      }
      if (!['http:', 'https:'].includes(url.protocol)) continue;
      const card = document.createElement('article');
      card.className = 'web-search-result';
      const link = document.createElement('a');
      link.href = url.href;
      link.textContent = result.title;
      link.addEventListener('click', (event) => {
        event.preventDefault();
        const browserTab = openBrowserTab(tab.sessionId, url.href, { select: true });
        void api.navigateBrowser(tab.sessionId, browserTab.browserTabId, url.href).catch((error) => {
          showActivity({ kind: 'error', message: `Could not open the search result: ${error.message}` });
        });
      });
      const address = document.createElement('p');
      address.className = 'web-search-result-url';
      address.textContent = url.hostname;
      card.append(link, address);
      if (typeof result.snippet === 'string' && result.snippet) {
        const snippet = document.createElement('p');
        snippet.textContent = result.snippet;
        card.append(snippet);
      }
      if (typeof result.publishedAt === 'string' && result.publishedAt) {
        const published = document.createElement('p');
        published.className = 'web-search-result-meta';
        published.textContent = result.publishedAt;
        card.append(published);
      }
      section.append(card);
    }
    searches.append(section);
  }
  surface.append(searches);
}

function syncBrowserViewBounds() {
  const state = infoSessions.get(activeSessionId);
  const tab = state?.tabs.find((candidate) =>
    candidate.kind === 'browser' && candidate.id === state.selectedId);
  const viewport = tab?.surface.querySelector('.browser-viewport');
  const dialogOpen = [...document.querySelectorAll('dialog')].some((dialog) => dialog.open);
  const visible = Boolean(tab && viewport?.isConnected && !viewport.hidden
    && !viewport.closest('[hidden]') && !$('info-panel').hidden && !dialogOpen
    && !appShell.classList.contains('info-collapsed'));
  const rect = viewport?.getBoundingClientRect();
  const bounds = rect
    ? { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
    : { x: 0, y: 0, width: 0, height: 0 };
  if (!activeSessionId) return;
  void api.setBrowserBounds(activeSessionId, visible ? tab.browserTabId : null, bounds, visible, {
    width: window.innerWidth,
    height: window.innerHeight,
  }).catch((error) => {
    showActivity({ kind: 'error', message: `Could not position the Browser tab: ${error.message}` });
  });
}

function queueBrowserBoundsSync() {
  if (browserBoundsFrame !== null) return;
  browserBoundsFrame = requestAnimationFrame(() => {
    browserBoundsFrame = null;
    syncBrowserViewBounds();
  });
}

function renderInfoPanel() {
  const state = infoSessions.get(activeSessionId);
  const tabList = $('info-tab-list');
  const panels = $('info-tab-panels');
  const filesMenuItem = $('info-add-menu').querySelector('[data-add-info-tab="documents"]');
  const webSearchMenuItem = $('info-add-menu').querySelector('[data-add-info-tab="web-search"]');
  filesMenuItem.hidden = state?.tabs.some((tab) => tab.kind === 'documents') ?? false;
  webSearchMenuItem.hidden = state?.tabs.some((tab) => tab.kind === 'web-search') ?? false;
  const previousFocusedElement = document.activeElement;
  const focusedTabControl = tabList.contains(document.activeElement)
    ? document.activeElement.id
    : '';
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
    select.setAttribute('aria-label', tab.title);
    select.title = tab.title;
    select.tabIndex = selected ? 0 : -1;
    select.append(createInfoTabIcon(tab.kind));
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
    close.id = `info-tab-close-${tab.id}`;
    close.className = 'info-tab-close';
    close.setAttribute('aria-label', `Close ${tab.title}`);
    close.title = `Close ${tab.title}`;
    close.textContent = '×';
    const session = sessions.find((item) => item.id === activeSessionId);
    const hasAttachedFiles = (session?.selectedDocumentIds ?? []).length > 0;
    const tabCanClose = canCloseInfoTab(tab, hasAttachedFiles);
    close.hidden = !tabCanClose;
    close.setAttribute('aria-hidden', String(!tabCanClose));
    close.addEventListener('click', () => closeInfoTab(activeSessionId, tab.id));
    wrapper.append(select, close);
    tabList.append(wrapper);

    tab.surface.hidden = !selected;
    tab.surface.id = `info-panel-${tab.id}`;
    tab.surface.setAttribute('role', 'tabpanel');
    tab.surface.setAttribute('aria-labelledby', `info-tab-${tab.id}`);
    panels.append(tab.surface);
    if (tab.kind === 'documents') renderDocumentLibrarySurface(tab);
    else if (tab.kind === 'trace') renderTraceSurface(tab);
    else if (tab.kind === 'browser') renderBrowserSurface(tab);
    else if (tab.kind === 'web-search') renderWebSearchSurface(tab);
  }
  if (focusedTabControl) document.getElementById(focusedTabControl)?.focus({ preventScroll: true });
  else if (previousFocusedElement instanceof HTMLElement && previousFocusedElement.isConnected) {
    previousFocusedElement.focus({ preventScroll: true });
  }
  queueBrowserBoundsSync();
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
  throw new Error('The terminal panel did not finish initializing. Open the Activity panel and try again.');
}

async function addTerminalTab(sessionId, { select = true } = {}) {
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
  if (select) state.selectedId = id;
  persistInfoState(sessionId, state);
  if (activeSessionId === sessionId) renderInfoPanel();
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
    if (select) await waitForTerminalPanelReady(tab);
    const result = await api.createTerminal({
      terminalId: id,
      sessionId,
      cols: terminal.cols || 80,
      rows: terminal.rows || 24,
    });
    createdTerminalId = result.terminalId;
    if (!state.tabs.includes(tab)) {
      await api.closeTerminal(result.terminalId, sessionId);
      return;
    }
    tab.started = true;
    if (select) {
      fitAddon.fit();
      await api.resizeTerminal(tab.id, terminal.cols, terminal.rows);
    }
    await readiness.waitUntilReady();
    tab.shellReady = true;
    if (select) terminal.focus();
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
  const state = infoState(sessionId);
  let tab = state.tabs.find((candidate) => candidate.id === state.selectedId && candidate.started)
    ?? state.tabs.find((candidate) => candidate.started);
  if (!tab) tab = await addTerminalTab(sessionId, { select: false });
  if (!tab?.started) throw new Error('A terminal could not be started for this conversation.');
  const terminalSelected = activeSessionId === sessionId
    && activeWorkspace === 'sessions'
    && state.open
    && state.selectedId === tab.id;
  if (terminalSelected) await waitForTerminalPanelReady(tab);
  await tab.readiness.waitUntilReady();
  tab.shellReady = true;
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
  if (!canCloseInfoTab(currentTab, (session?.selectedDocumentIds ?? []).length > 0)) return;
  const [tab] = state.tabs.splice(index, 1);
  if (tab.kind === 'terminal') {
    tab.readiness.fail(new Error('Terminal closed before the shell prompt was ready.'));
    tab.resizeObserver?.disconnect();
    tab.terminal.dispose();
    void api.closeTerminal(tab.id, sessionId).catch((error) => {
      showActivity({ kind: 'error', message: `Could not close terminal: ${error.message}` });
    });
  }
  if (tab.kind === 'browser') {
    browserStates.delete(JSON.stringify([sessionId, tab.browserTabId]));
    void api.closeBrowser(sessionId, tab.browserTabId).catch((error) => {
      showActivity({ kind: 'error', message: `Could not close Browser tab: ${error.message}` });
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
    if (tab.kind === 'browser') {
      browserStates.delete(JSON.stringify([sessionId, tab.browserTabId]));
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
  const documentCount = counts.total.toLocaleString();
  const documentLabel = counts.total === 1 ? 'Document' : 'Documents';
  chips.textContent = `${documentCount} ${documentLabel}`;
  container.setAttribute('aria-label', `${documentCount} attached ${documentLabel.toLowerCase()}`);
  container.title = `${documentCount} attached ${documentLabel.toLowerCase()}`;
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
      ...addition.errors.map((item) => `${item.name}: ${item.error}`),
    ].filter(Boolean);
    if (addition.errors.length > 0) {
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
      ...result.errors.map((item) => `${item.name}: ${item.error}`),
    ].filter(Boolean);
    if (result.errors.length > 0) {
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
    const removal = await api.removeDocument(referenceId, sessionId);
    const updatedSession = removal?.session;
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
    showActivity(removal.cleanupWarning
      ? { kind: 'error', message: `Removed the reference to "${name}", but ${removal.cleanupWarning}` }
      : { kind: 'complete', message: `Removed the reference to "${name}". The original was not changed.` });
  } catch (error) {
    showActivity({ kind: 'error', message: `Could not remove "${name}": ${error.message}` });
  }
}

function reportDocumentList(listing, sessionId) {
  if (activeSessionId !== sessionId) return;
  const messages = listing.errors.map((item) => `${item.name}: ${item.error}`);
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
  title.textContent = 'Files';
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
    overflow.className = 'document-library-info';
    overflow.textContent = `${libraryUnindexedCount} ${libraryUnindexedCount === 1 ? 'file is' : 'files are'} not cached locally and will be searched on demand; searches may take longer.`;
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

function openWebSearchTab(sessionId = activeSessionId) {
  if (!sessionId) return;
  const state = infoState(sessionId);
  let tab = state.tabs.find((item) => item.kind === 'web-search');
  if (!tab) {
    tab = createWebSearchTab(sessionId);
    state.tabs.push(tab);
  }
  state.selectedId = tab.id;
  persistInfoState(sessionId, state);
  openInfoPanel();
}

function openDocumentLibraryTab(sessionId = activeSessionId, { refresh = true } = {}) {
  if (!sessionId) return;
  const tab = ensureDocumentTab(sessionId);
  if (!tab) return;
  const state = infoState(sessionId);
  state.selectedId = tab.id;
  persistInfoState(sessionId, state);
  openInfoPanel();
  if (refresh) void refreshDocumentLibrary(sessionId);
}

function activeSession() {
  return sessions.find((session) => session.id === activeSessionId) ?? null;
}

function requestState(sessionId) {
  return requestStates.get(sessionId) ?? null;
}

function startTraceRecording(sessionId) {
  const state = infoState(sessionId);
  const tab = state?.tabs.find((item) => item.kind === 'trace');
  if (!state || !tab) return;
  tab.recordingStartedAt = null;
  tab.recordingCompletedAt = null;
  tab.progress = null;
  tab.workflowSelection = null;
  updateTraceTab(tab, { recording: true });
  refreshTraceDurationTicker();
  focusActivityTab(sessionId, state);
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

function estimatedPromptTokens(question, history) {
  return estimateTokens(JSON.stringify({
    task: question,
    conversation_history: history,
    summary: '',
    recent_steps: [],
    step_number: 1,
  }));
}

function rightPanelSurfaceText(surface) {
  const blocks = surface.querySelectorAll('h1, h2, h3, p, li, button, a, [role="button"]');
  const text = [...blocks]
    .map((element) => element.textContent?.trim() ?? '')
    .filter(Boolean)
    .join('\n');
  return text || surface.textContent?.trim() || '';
}

function rightPanelContext(sessionId) {
  const state = infoState(sessionId);
  let remaining = MAX_RIGHT_PANEL_CONTEXT_LENGTH;
  return state.tabs.map((tab) => {
    const entry = {
      id: tab.id,
      kind: tab.kind,
      title: tab.title,
      selected: tab.id === state.selectedId,
    };
    if (tab.kind === 'browser') {
      entry.browserTabId = tab.browserTabId;
      return entry;
    }
    const content = tab.kind === 'terminal'
      ? readTerminalContext(tab.terminal)
      : rightPanelSurfaceText(tab.surface);
    const length = Math.min(content.length, MAX_RIGHT_PANEL_TAB_CONTENT_LENGTH, remaining);
    entry.content = content.slice(0, length);
    entry.truncated = length < content.length;
    remaining -= length;
    return entry;
  });
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
    ?? estimatedPromptTokens(prompt.value, history);
  updateContextMeter(promptTokens);
}

function resizePrompt() {
  prompt.style.height = 'auto';
  const containerHeight = $('sessions-panel').clientHeight || appShell.clientHeight;
  const maxHeight = Math.max(38, Math.floor(containerHeight * 0.25));
  const height = Math.min(prompt.scrollHeight, maxHeight);
  prompt.style.height = `${height}px`;
  prompt.style.overflowY = prompt.scrollHeight > maxHeight ? 'auto' : 'hidden';
}

function updateComposerControls() {
  const state = requestState(activeSessionId);
  sendButton.disabled = !assistantAvailable || Boolean(state);
  cancelButton.hidden = !state || !['queued', 'running', 'cancelling'].includes(state.status);
  cancelButton.disabled = !state || state.status === 'cancelling'
    || !['queued', 'running'].includes(state.status);
  cancelButton.textContent = state?.status === 'queued'
    ? 'Remove from queue'
    : state?.status === 'cancelling' ? 'Cancelling…' : 'Cancel';
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
      preview.textContent = sessionRequestPreviewText(state);
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

function responseFooter(content, generationDurationMs) {
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
  let duration;
  if (Number.isSafeInteger(generationDurationMs) && generationDurationMs >= 0) {
    duration = document.createElement('span');
    duration.className = 'response-generation-duration';
    duration.textContent = `Generated in ${formatDuration(generationDurationMs)}`;
  }

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
  if (duration) footer.append(duration);
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
    wrapper.append(responseFooter(message.content, message.generationDurationMs));
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
  if (!shouldShowTypingAnimation(state)) {
    const content = document.createElement('div');
    content.className = 'message-content';
    content.innerHTML = renderMarkdown(state.answer, { renderMath: false });
    wrapper.append(label, content);
  } else {
    const indicator = document.createElement('div');
    indicator.className = 'typing-indicator';
    const indicatorText = pendingIndicatorText(state.status, state.queuePosition);
    if (indicatorText !== null) {
      indicator.textContent = indicatorText;
    } else {
      indicator.setAttribute('aria-hidden', 'true');
      for (let index = 0; index < 3; index += 1) indicator.append(document.createElement('span'));
    }
    wrapper.setAttribute('role', 'status');
    wrapper.append(label, indicator);
  }
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
    $('info-panel').hidden = activeWorkspace !== 'sessions' || !panelOpen;
    $('info-toggle').setAttribute('aria-expanded', String(panelOpen));
    $('info-toggle').title = panelOpen
        ? 'Hide Activity, tools, and files'
        : 'Show Activity, tools, and files';
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
  if (activeWorkspace !== 'sessions') return;
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
  $('info-toggle').title = 'Hide Activity, tools, and files';
  setPanelWidth('info', Number.parseFloat(getComputedStyle(appShell).getPropertyValue('--info-width')) || PANEL_WIDTHS.info.fallback);
  setPanelWidth('sessions', Number.parseFloat(getComputedStyle(appShell).getPropertyValue('--sessions-width')) || PANEL_WIDTHS.sessions.fallback);
  setPanelWidth('info', Number.parseFloat(getComputedStyle(appShell).getPropertyValue('--info-width')) || PANEL_WIDTHS.info.fallback);
  renderInfoPanel();
  queueBrowserBoundsSync();
  const tab = selectedTerminal();
  if (tab) fitTerminal(tab);
}

function closeInfoPanel() {
  if (activeWorkspace !== 'sessions') return;
  const state = infoState();
  if (state) {
    state.open = false;
    persistInfoState(activeSessionId, state);
  }
  appShell.classList.add('info-collapsed');
  $('info-panel').hidden = true;
  $('info-toggle').setAttribute('aria-expanded', 'false');
  $('info-toggle').title = 'Show Activity, tools, and files';
  $('info-toggle').focus();
  queueBrowserBoundsSync();
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
  const state = {
    requestId,
    status: 'saving',
    queuePosition: null,
    answer: '',
    promptTokens: estimatedPromptTokens(question, history),
    renderScheduled: false,
    autoScroll: true,
  };
  const previousTitle = session.title;
  const userMessage = { role: 'user', content: question };
  session.messages.push(userMessage);
  updateSessionTitle(session, question);
  requestStates.set(session.id, state);
  startTraceRecording(session.id);
  if (activeSessionId === session.id) {
    renderSession(session);
    messages.style.display = 'flex';
    welcome.hidden = true;
    messages.scrollTop = messages.scrollHeight;
  }
  prompt.value = '';
  resizePrompt();
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
      resizePrompt();
      if (activeSessionId === session.id) renderSession(session);
      return;
    }

    try {
      state.status = 'submitting';
      if (activeSessionId === session.id) renderSession(session);
      await api.ask(requestId, session.id, question, history, rightPanelContext(session.id));
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
      resizePrompt();
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
  if (state.status === 'cancelling' && ['queued', 'running'].includes(status.status)) return;
  state.status = status.status;
  state.queuePosition = status.queuePosition ?? null;
  if (status.status === 'running') {
    const traceTab = infoState(status.sessionId)?.tabs.find((tab) => tab.kind === 'trace');
    const startedAt = new Date().toISOString();
    state.startedAt = startedAt;
    if (traceTab) {
      traceTab.trace = null;
      traceTab.liveToolStep = null;
      traceTab.progress = null;
      traceTab.workflowSelection = null;
    }
    updateTraceTab(traceTab, {
      recording: true,
      startedAt,
      progress: { step_number: 1, started_at: startedAt, phase: 'preparing' },
    });
    refreshTraceDurationTicker();
    if (activeSessionId === status.sessionId) renderInfoPanel();
  }
  renderSessions();
  if (activeSessionId === status.sessionId) renderSession(activeSession());
}

function handleRequestTrace(update) {
  if (!update || typeof update !== 'object'
    || typeof update.requestId !== 'string' || typeof update.sessionId !== 'string') return;
  const state = requestState(update.sessionId);
  if (!state || state.requestId !== update.requestId) return;
  const traceTab = infoState(update.sessionId)?.tabs.find((tab) => tab.kind === 'trace');
  if (!traceTab) return;
  updateTraceTab(traceTab, {
    trace: update.trace,
    recording: true,
    toolEvent: update.toolEvent,
    progress: update.progress,
  });
  refreshTraceDurationTicker();
  if (isAgentTrace(update.trace)) {
    state.trace = update.trace;
    const lastStepStatus = update.trace.steps.at(-1)?.status;
    if (['complete', 'failed', 'rejected', 'needs_human'].includes(lastStepStatus)) {
      state.status = 'finishing';
      renderSessions();
    }
  }
  if (activeSessionId === update.sessionId) {
    const panelState = infoState(update.sessionId);
    if (panelState.open && activeWorkspace === 'sessions') renderInfoPanel();
  }
}

async function handleRequestResult(result) {
  const state = requestState(result.sessionId);
  if (state && state.requestId !== result.requestId) return;
  requestStates.delete(result.sessionId);
  renderSessions();
  const session = sessions.find((item) => item.id === result.sessionId);
  if (!session) return;
  const previousScrollTop = messages.scrollTop;
  const shouldAutoScroll = state?.autoScroll !== false;
  const trace = isAgentTrace(result.trace) ? result.trace
    : isAgentTrace(state?.trace) ? state.trace : null;
  const traceDuration = traceDurationMs(trace);
  const requestStartedAt = typeof state?.startedAt === 'string'
    ? Date.parse(state.startedAt)
    : Number.NaN;
  const generationDurationMs = traceDuration
    ?? (Number.isFinite(requestStartedAt) ? Math.max(0, Date.now() - requestStartedAt) : null);
  const generationDurationProperty = generationDurationMs === null
    ? {}
    : { generationDurationMs };
  const traceTab = infoState(session.id)?.tabs.find((tab) => tab.kind === 'trace');
  if (traceTab) {
    updateTraceTab(traceTab, {
      trace,
      recording: false,
      completedAt: new Date().toISOString(),
    });
    refreshTraceDurationTicker();
    if (activeSessionId === session.id) renderInfoPanel();
  }
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
      ...generationDurationProperty,
      ...(trace ? { trace } : {}),
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
        ...generationDurationProperty,
        ...(trace ? { trace } : {}),
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
        ...(trace ? { trace } : {}),
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
          ...generationDurationProperty,
          ...(trace ? { trace } : {}),
        }
      : {
          role: 'assistant',
          content: `I couldn't complete that request: ${result.error}`,
          ...contextUsageProperty,
          ...generationDurationProperty,
          ...(trace ? { trace } : {}),
        });
  }

  if (markerAlreadyPersisted && trace) {
    const lastMessage = session.messages.at(-1);
    session.messages[session.messages.length - 1] = { ...lastMessage, trace };
  }
  if (activeSessionId === session.id) {
    renderSession(session);
    messages.scrollTop = shouldAutoScroll
      ? messages.scrollHeight
      : preservedScrollTop(previousScrollTop, messages.scrollHeight, messages.clientHeight);
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
        wrapper.removeAttribute('role');
        wrapper.querySelector('.typing-indicator')?.remove();
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
  const previousStatus = state.status;
  state.status = 'cancelling';
  if (activeSessionId) renderSession(activeSession());
  try {
    const cancelled = await api.cancel(state.requestId);
    if (!cancelled) {
      if (requestState(activeSessionId) === state) state.status = previousStatus;
      if (activeSessionId) renderSession(activeSession());
      showActivity({ kind: 'error', message: 'This request has already finished.' });
      return;
    }
    renderSession(activeSession());
  } catch (error) {
    if (requestState(activeSessionId) === state) state.status = previousStatus;
    if (activeSessionId) renderSession(activeSession());
    showActivity({ kind: 'error', message: `Cancellation was requested, but its status could not be saved: ${error.message}` });
  }
}

function handleActivity(activity) {
  if (activity.kind === 'workflow'
    && typeof activity.sessionId === 'string'
    && typeof activity.workflowName === 'string') {
    const state = infoState(activity.sessionId);
    const traceTab = state?.tabs.find((tab) => tab.kind === 'trace');
    if (!traceTab) return;
    traceTab.workflowSelection = {
      id: activity.workflowId,
      name: activity.workflowName,
    };
    if (activeSessionId === activity.sessionId && activeWorkspace === 'sessions') {
      renderInfoPanel();
    }
  } else if (activity.kind === 'model') {
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
messages.addEventListener('click', (event) => {
  if (event.button !== 0) return;
  const link = event.target.closest('.message-content a[href]');
  if (!link || !activeSessionId) return;
  let url;
  try {
    url = new URL(link.href);
  } catch {
    return;
  }
  if (!['https:', 'http:'].includes(url.protocol)) return;
  event.preventDefault();
  const browserTab = openBrowserTab(activeSessionId, url.href);
  void api.navigateBrowser(activeSessionId, browserTab.browserTabId, url.href).catch((error) => {
    showActivity({ kind: 'error', message: `Could not open web link: ${error.message}` });
  });
});
$('question').addEventListener('input', () => {
  resizePrompt();
  updateLimitMeters();
});
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
  const isMobile = window.matchMedia('(max-width: 820px)').matches;
  if (activeWorkspace !== 'sessions') {
    setWorkspace('sessions');
    if (isMobile) {
      appShell.classList.add('sessions-open');
      $('chat-nav').setAttribute('aria-expanded', 'true');
    }
  } else if (isMobile) {
    const isOpen = appShell.classList.toggle('sessions-open');
    $('chat-nav').setAttribute('aria-expanded', String(isOpen));
  } else {
    prompt.focus();
  }
});
$('workflows-nav').addEventListener('click', () => {
  const isMobile = window.matchMedia('(max-width: 820px)').matches;
  if (activeWorkspace === 'workflows' && isMobile) {
    const isOpen = appShell.classList.toggle('sessions-open');
    $('workflows-nav').setAttribute('aria-expanded', String(isOpen));
    return;
  }
  setWorkspace('workflows', { openSidebar: isMobile });
});
$('tools-nav').addEventListener('click', () => setWorkspace('tools'));
renderToolCards();
$('tools-grid').addEventListener('click', (event) => {
  const card = event.target.closest('[data-tool-id]');
  if (!card) return;
  const tool = TOOL_CATALOG.find((item) => item.id === card.dataset.toolId);
  if (!tool) return;
  $('tool-details-title').textContent = tool.name;
  $('tool-details-description').textContent = tool.description;
  toolDetailsDialog.showModal();
});
$('tool-details-close').addEventListener('click', () => toolDetailsDialog.close());
function openSettings() {
  if (!settingsDialog.open) {
    settingsDialog.showModal();
  }
  queueBrowserBoundsSync();
}

function setWorkflowError(message) {
  const error = $('workflow-error');
  error.hidden = !message;
  error.textContent = message ?? '';
}

function renderWorkflowList(selectedId = selectedWorkflowId) {
  const list = $('workflow-list');
  list.replaceChildren();
  if (workflows.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'workflow-list-empty';
    empty.textContent = 'No workflows yet. Create one to give the assistant a repeatable task guide.';
    list.append(empty);
    return;
  }
  workflows.forEach((workflow, index) => {
    const item = document.createElement('div');
    item.className = 'workflow-list-item';
    item.dataset.workflowId = workflow.id;
    item.draggable = !workflowOrderSaving;
    const select = document.createElement('button');
    select.type = 'button';
    select.className = 'workflow-list-select';
    select.setAttribute('aria-pressed', String(workflow.id === selectedId));
    const name = document.createElement('strong');
    name.textContent = workflow.name;
    const origin = document.createElement('span');
    origin.textContent = `Priority ${index + 1} · ${workflow.source === 'builtin' ? 'Built-in workflow' : 'My workflow'}`;
    select.append(name, origin);
    const controls = document.createElement('div');
    controls.className = 'workflow-priority-controls';
    for (const [offset, label, glyph] of [
      [-1, 'Move earlier', '↑'],
      [1, 'Move later', '↓'],
    ]) {
      const move = document.createElement('button');
      move.type = 'button';
      move.dataset.workflowMove = String(offset);
      move.setAttribute('aria-label', `${label}: ${workflow.name}`);
      move.title = `${label}: ${workflow.name}`;
      move.textContent = glyph;
      move.disabled = index + offset < 0 || index + offset >= workflows.length || workflowOrderSaving;
      controls.append(move);
    }
    item.append(select, controls);
    list.append(item);
  });
}

function setWorkflowEditor(workflow, { newWorkflow = false } = {}) {
  selectedWorkflowId = workflow?.id ?? null;
  workflowIsNew = !workflow && newWorkflow;
  workflowEditorDirty = false;
  const isBuiltIn = workflow?.source === 'builtin';
  $('workflow-editor').hidden = !workflow && !newWorkflow;
  $('workflow-empty').hidden = Boolean(workflow || newWorkflow);
  $('workflow-name').value = workflow?.name ?? '';
  $('workflow-starter').value = workflow?.starter ?? '';
  $('workflow-steps').value = workflow?.steps.join('\n') ?? '';
  $('workflow-goal').value = workflow?.goal ?? '';
  for (const id of ['workflow-name', 'workflow-starter', 'workflow-steps', 'workflow-goal']) {
    $(id).readOnly = isBuiltIn;
  }
  $('workflow-detail-title').textContent = workflow?.name ?? (newWorkflow ? 'New workflow' : 'Workflow details');
  $('workflow-origin').textContent = workflow
    ? (isBuiltIn ? 'BUILT-IN WORKFLOW' : 'YOUR WORKFLOW')
    : (newWorkflow ? 'NEW WORKFLOW' : '');
  $('workflow-detail-description').textContent = isBuiltIn
    ? 'This built-in guide helps you design and save a reusable workflow from chat.'
    : 'Edit the intent and instructions the assistant uses for this kind of task.';
  $('workflow-delete').hidden = !workflow || workflow.source !== 'custom';
  $('workflow-save').hidden = isBuiltIn;
  $('workflow-save').textContent = workflowIsNew ? 'Create workflow' : 'Save workflow';
  renderWorkflowList();
}

async function loadWorkflowPreferences() {
  if (workflowsLoading) return;
  workflowsLoading = true;
  setWorkflowError('');
  try {
    const result = await api.listWorkflows();
    workflows = result.workflows;
    if (!Array.isArray(workflows)) throw new Error('The workflow list returned an invalid response.');
    workflowsLoaded = true;
    const workflow = workflows.find((item) => item.id === selectedWorkflowId) ?? workflows[0] ?? null;
    setWorkflowEditor(workflow);
    if (result.error) setWorkflowError(`Could not load saved workflow changes: ${result.error}`);
  } catch (error) {
    workflowsLoaded = false;
    workflows = [];
    setWorkflowEditor(null);
    renderWorkflowList(null);
    setWorkflowError(`Could not load workflows: ${error.message}`);
  } finally {
    workflowsLoading = false;
  }
}

function mayDiscardWorkflowChanges() {
  return !workflowEditorDirty
    || window.confirm('Discard your unsaved workflow changes?');
}

function workflowEditorValue() {
  return {
    ...(selectedWorkflowId ? { id: selectedWorkflowId } : {}),
    name: $('workflow-name').value,
    starter: $('workflow-starter').value,
    steps: $('workflow-steps').value.split(/\r?\n/u).map((step) => step.trim()).filter(Boolean),
    goal: $('workflow-goal').value,
  };
}

async function saveWorkflowOrder(nextWorkflows) {
  if (workflowOrderSaving) return;
  const previousWorkflows = workflows;
  workflowOrderSaving = true;
  workflows = nextWorkflows;
  renderWorkflowList();
  try {
    const result = await api.reorderWorkflows(workflows.map(({ id }) => id));
    if (!Array.isArray(result.workflows)) throw new Error('The reordered workflow list returned an invalid response.');
    workflows = result.workflows;
    setWorkflowError('');
  } catch (error) {
    workflows = previousWorkflows;
    setWorkflowError(`Could not update workflow priority: ${error.message}`);
  } finally {
    workflowOrderSaving = false;
    renderWorkflowList();
  }
}

function moveWorkflow(workflowId, targetId, after = false) {
  if (workflowOrderSaving || workflowId === targetId) return;
  const nextWorkflows = [...workflows];
  const fromIndex = nextWorkflows.findIndex((workflow) => workflow.id === workflowId);
  const targetIndex = nextWorkflows.findIndex((workflow) => workflow.id === targetId);
  if (fromIndex < 0 || targetIndex < 0) return;
  const [workflow] = nextWorkflows.splice(fromIndex, 1);
  const insertionIndex = nextWorkflows.findIndex((item) => item.id === targetId) + Number(after);
  nextWorkflows.splice(insertionIndex, 0, workflow);
  void saveWorkflowOrder(nextWorkflows);
}

$('workflow-list').addEventListener('click', (event) => {
  const item = event.target.closest('.workflow-list-item');
  if (!item) return;
  const moveButton = event.target.closest('[data-workflow-move]');
  if (moveButton) {
    moveWorkflow(
      item.dataset.workflowId,
      workflows[workflows.findIndex((workflow) => workflow.id === item.dataset.workflowId)
        + Number(moveButton.dataset.workflowMove)]?.id,
      Number(moveButton.dataset.workflowMove) > 0,
    );
    return;
  }
  if (!event.target.closest('.workflow-list-select')) return;
  if (item.dataset.workflowId === selectedWorkflowId && !workflowIsNew) return;
  if (!mayDiscardWorkflowChanges()) {
    renderWorkflowList();
    return;
  }
  const workflow = workflows.find((candidate) => candidate.id === item.dataset.workflowId) ?? null;
  setWorkflowEditor(workflow);
  setWorkflowError('');
});

$('workflow-list').addEventListener('dragstart', (event) => {
  const item = event.target.closest('.workflow-list-item');
  if (!item || workflowOrderSaving) {
    event.preventDefault();
    return;
  }
  draggedWorkflowId = item.dataset.workflowId;
  item.classList.add('is-dragging');
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', draggedWorkflowId);
});

$('workflow-list').addEventListener('dragover', (event) => {
  const item = event.target.closest('.workflow-list-item');
  if (!item || !draggedWorkflowId || item.dataset.workflowId === draggedWorkflowId) return;
  event.preventDefault();
  const rect = item.getBoundingClientRect();
  item.classList.toggle('is-drop-before', event.clientY < rect.top + rect.height / 2);
  item.classList.toggle('is-drop-after', event.clientY >= rect.top + rect.height / 2);
  event.dataTransfer.dropEffect = 'move';
});

$('workflow-list').addEventListener('drop', (event) => {
  const item = event.target.closest('.workflow-list-item');
  if (!item || !draggedWorkflowId || item.dataset.workflowId === draggedWorkflowId) return;
  event.preventDefault();
  const rect = item.getBoundingClientRect();
  moveWorkflow(draggedWorkflowId, item.dataset.workflowId, event.clientY >= rect.top + rect.height / 2);
  draggedWorkflowId = null;
  for (const row of $('workflow-list').querySelectorAll('.workflow-list-item')) {
    row.classList.remove('is-dragging', 'is-drop-before', 'is-drop-after');
  }
});

$('workflow-list').addEventListener('dragend', () => {
  draggedWorkflowId = null;
  for (const row of $('workflow-list').querySelectorAll('.workflow-list-item')) {
    row.classList.remove('is-dragging', 'is-drop-before', 'is-drop-after');
  }
});

$('workflow-new').addEventListener('click', () => {
  if (!mayDiscardWorkflowChanges()) return;
  setWorkflowEditor(null, { newWorkflow: true });
  $('workflow-name').focus();
  setWorkflowError('');
});

for (const id of ['workflow-name', 'workflow-starter', 'workflow-steps', 'workflow-goal']) {
  $(id).addEventListener('input', () => {
    workflowEditorDirty = true;
    setWorkflowError('');
  });
}

$('workflow-save').addEventListener('click', async () => {
  const button = $('workflow-save');
  button.disabled = true;
  setWorkflowError('');
  try {
    const result = await api.saveWorkflow(workflowEditorValue());
    workflows = result.workflows;
    setWorkflowEditor(workflows.find((workflow) => workflow.id === result.saved.id) ?? null);
    setWorkflowError('');
  } catch (error) {
    setWorkflowError(`Could not save the workflow: ${error.message}`);
  } finally {
    button.disabled = false;
  }
});

$('workflow-delete').addEventListener('click', async () => {
  const workflow = workflows.find((item) => item.id === selectedWorkflowId);
  if (!workflow || workflow.source !== 'custom'
    || !window.confirm(`Delete the workflow “${workflow.name}”?`)) return;
  try {
    const result = await api.deleteWorkflow(workflow.id);
    workflows = result.workflows;
    const next = workflows[0] ?? null;
    setWorkflowEditor(next);
    setWorkflowError('');
  } catch (error) {
    setWorkflowError(`Could not delete the workflow: ${error.message}`);
  }
});

$('settings-button').addEventListener('click', openSettings);
api.onOpenSettings(openSettings);
$('settings-close').addEventListener('click', () => {
  settingsDialog.close();
});
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
  if (activeWorkspace !== 'sessions') return;
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
  else if (button.dataset.composerDocumentAdd === 'website' && sessionId) {
    openBrowserTab(sessionId, '', { select: true });
  } else if (button.dataset.composerDocumentAdd === 'web-search' && sessionId) {
    openWebSearchTab(sessionId);
  }
});
$('info-add-tab').addEventListener('click', () => {
  const menu = $('info-add-menu');
  const open = menu.hidden;
  const state = activeSessionId ? infoState(activeSessionId) : null;
  menu.querySelector('[data-add-info-tab="documents"]').hidden =
    state?.tabs.some((tab) => tab.kind === 'documents') ?? false;
  menu.querySelector('[data-add-info-tab="web-search"]').hidden =
    state?.tabs.some((tab) => tab.kind === 'web-search') ?? false;
  menu.hidden = !open;
  $('info-add-tab').setAttribute('aria-expanded', String(open));
});
for (const button of document.querySelectorAll('[data-add-info-tab]')) {
  button.prepend(createInfoTabIcon(button.dataset.addInfoTab));
}
$('info-add-menu').addEventListener('click', (event) => {
  const button = event.target.closest('[data-add-info-tab]');
  if (!button) return;
  $('info-add-menu').hidden = true;
  $('info-add-tab').setAttribute('aria-expanded', 'false');
  if (button.dataset.addInfoTab === 'terminal' && activeSessionId) void addTerminalTab(activeSessionId);
  else if (button.dataset.addInfoTab === 'browser' && activeSessionId) openBrowserTab(activeSessionId);
  else if (button.dataset.addInfoTab === 'web-search' && activeSessionId) {
    const state = infoState(activeSessionId);
    if (!state.tabs.some((tab) => tab.kind === 'web-search')) openWebSearchTab(activeSessionId);
  }
  else if (button.dataset.addInfoTab === 'documents' && activeSessionId) {
    const state = infoState(activeSessionId);
    if (!state.tabs.some((tab) => tab.kind === 'documents')) {
      openDocumentLibraryTab(activeSessionId);
    }
  }
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
api.onBrowserState((state) => {
  if (!state || typeof state.sessionId !== 'string'
    || typeof state.browserTabId !== 'string') return;
  browserStates.set(JSON.stringify([state.sessionId, state.browserTabId]), state);
  const tab = infoSessions.get(state.sessionId)?.tabs.find((candidate) =>
    candidate.kind === 'browser' && candidate.browserTabId === state.browserTabId);
  if (tab) {
    tab.title = state.title || browserTitleFromUrl(state.url);
    const tabButton = document.getElementById(`info-tab-${tab.id}`);
    if (tabButton) {
      tabButton.setAttribute('aria-label', tab.title);
      tabButton.title = tab.title;
    }
    const closeButton = document.getElementById(`info-tab-close-${tab.id}`);
    if (closeButton) {
      closeButton.setAttribute('aria-label', `Close ${tab.title}`);
      closeButton.title = `Close ${tab.title}`;
    }
    if (activeSessionId === state.sessionId) renderBrowserSurface(tab);
  }
  queueBrowserBoundsSync();
});
api.onBrowserActivate((request) => {
  if (!request || typeof request.sessionId !== 'string'
    || typeof request.browserTabId !== 'string') return;
  ensureBrowserTab(request.sessionId, request.browserTabId, request.url);
});
api.onWebSearchResults((event) => {
  if (!event || typeof event.sessionId !== 'string') return;
  showWebSearchResults(event.sessionId, event.resultSet);
});
$('setup-later').addEventListener('click', () => setupDialog.close());
$('setup-start').addEventListener('click', () => setupDialog.close());
api.onActivity((activity) => {
  handleActivity(activity);
});
api.onWorkflowCreated((result) => {
  if (!result || typeof result.sessionId !== 'string'
    || !Array.isArray(result.workflows) || !result.workflow
    || typeof result.workflow.id !== 'string') return;
  workflows = result.workflows;
  workflowsLoaded = true;
  const created = workflows.find((workflow) => workflow.id === result.workflow.id);
  if (!created) {
    setWorkflowError('The workflow was saved, but it could not be found in the updated workflow list.');
    setWorkspace('workflows', { openSidebar: window.matchMedia('(max-width: 820px)').matches });
    return;
  }
  if (workflowEditorDirty) {
    renderWorkflowList();
    setWorkflowError(`Created “${created.name}”. Save or discard the current edits to open it.`);
  } else {
    setWorkflowEditor(created);
    setWorkflowError('');
  }
  setWorkspace('workflows', { openSidebar: window.matchMedia('(max-width: 820px)').matches });
});
api.onWorkflowsUpdated((updatedWorkflows) => {
  if (!Array.isArray(updatedWorkflows)) return;
  workflows = updatedWorkflows;
  workflowsLoaded = true;
  if (!workflowEditorDirty && !workflowIsNew) {
    const selected = workflows.find((workflow) => workflow.id === selectedWorkflowId)
      ?? workflows[0]
      ?? null;
    setWorkflowEditor(selected);
  } else {
    renderWorkflowList();
  }
});
api.onRequestStatus(handleRequestStatus);
api.onRequestChunk(handleRequestChunk);
api.onRequestTrace(handleRequestTrace);
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
  resizePrompt();
  for (const tab of infoSessions.get(activeSessionId)?.tabs ?? []) fitTerminal(tab);
  queueBrowserBoundsSync();
});
resizePrompt();
const browserBoundsObserver = new ResizeObserver(queueBrowserBoundsSync);
browserBoundsObserver.observe($('info-panel'));
for (const dialog of document.querySelectorAll('dialog')) {
  dialog.addEventListener('toggle', queueBrowserBoundsSync);
  dialog.addEventListener('close', queueBrowserBoundsSync);
}
applyTheme(localStorage.getItem('livingwords-theme') ?? 'dark');
void initializeRenderer();
