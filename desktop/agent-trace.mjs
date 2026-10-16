export function isAgentTrace(trace) {
  return Boolean(trace && typeof trace === 'object' && !Array.isArray(trace)
    && trace.schema_version === 1
    && typeof trace.run_id === 'string'
    && Array.isArray(trace.steps));
}

export function latestAgentTrace(messages) {
  if (!Array.isArray(messages)) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'assistant' && isAgentTrace(message.trace)) return message.trace;
  }
  return null;
}

export function canCloseInfoTab(tab, hasAttachedFiles = false) {
  if (tab?.kind === 'trace') return false;
  if (tab?.kind === 'documents') return !hasAttachedFiles;
  return true;
}

export function mergeAgentTraces(previous, next) {
  if (!isAgentTrace(next)) return isAgentTrace(previous) ? previous : null;
  if (!isAgentTrace(previous) || previous.run_id !== next.run_id) return next;

  const stepsByNumber = new Map(previous.steps.map((step) => [step.step_number, step]));
  for (const step of next.steps) stepsByNumber.set(step.step_number, step);
  return {
    ...previous,
    ...next,
    steps: [...stepsByNumber.values()].sort((left, right) => left.step_number - right.step_number),
  };
}

const LIVE_TOOL_STATUSES = new Set([
  'pending',
  'running',
  'success',
  'failed',
  'rejected',
  'needs_human',
  'not_executed',
]);

const LIVE_PROGRESS_PHASES = new Set(['preparing', 'thinking', 'using_tool']);

export function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '0 sec';
  const totalSeconds = Math.floor(milliseconds / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours} hr ${minutes} min`;
  if (minutes > 0) return `${minutes} min ${seconds} sec`;
  return `${seconds} sec`;
}

export function traceDurationMs(trace) {
  if (!isAgentTrace(trace)) return null;
  const startedAt = Date.parse(trace.started_at);
  const completedAt = Date.parse(trace.completed_at);
  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt) || completedAt < startedAt) {
    return null;
  }
  return completedAt - startedAt;
}

export function formatTraceTime(timestamp) {
  if (typeof timestamp !== 'string' || !Number.isFinite(Date.parse(timestamp))) return '';
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function isLiveProgress(progress) {
  return Boolean(progress && typeof progress === 'object' && !Array.isArray(progress)
    && Number.isSafeInteger(progress.step_number) && progress.step_number > 0
    && typeof progress.started_at === 'string' && Number.isFinite(Date.parse(progress.started_at))
    && LIVE_PROGRESS_PHASES.has(progress.phase)
    && (progress.tool_name === undefined || typeof progress.tool_name === 'string'));
}

function isLiveToolEvent(event) {
  return Boolean(event && typeof event === 'object' && !Array.isArray(event)
    && Number.isSafeInteger(event.step_number) && event.step_number > 0
    && Number.isSafeInteger(event.call_index) && event.call_index >= 0
    && typeof event.tool_name === 'string' && event.tool_name.length > 0
    && LIVE_TOOL_STATUSES.has(event.status)
    && (event.timestamp === undefined
      || typeof event.timestamp === 'string' && Number.isFinite(Date.parse(event.timestamp)))
    && (event.arguments === null || event.arguments !== undefined));
}

export function updateTraceTab(tab, {
  trace,
  recording,
  toolEvent,
  progress,
  startedAt,
  completedAt,
} = {}) {
  if (tab?.kind !== 'trace') return false;
  if (isAgentTrace(trace)) tab.trace = mergeAgentTraces(tab.trace, trace);
  if (typeof recording === 'boolean') tab.recording = recording;
  if (typeof startedAt === 'string' && Number.isFinite(Date.parse(startedAt))) {
    tab.recordingStartedAt = startedAt;
  }
  if (typeof completedAt === 'string' && Number.isFinite(Date.parse(completedAt))) {
    tab.recordingCompletedAt = completedAt;
  }
  if (isLiveProgress(progress)) tab.progress = { ...progress };
  if (isLiveToolEvent(toolEvent)) {
    if (toolEvent.status === 'running' && isLiveProgress(tab.progress)) {
      tab.progress = { ...tab.progress, phase: 'using_tool', tool_name: toolEvent.tool_name };
    }
    if (tab.liveToolStep?.step_number !== toolEvent.step_number) {
      tab.liveToolStep = { step_number: toolEvent.step_number, calls: [], events: [] };
    }
    tab.liveToolStep.events ??= [];
    tab.liveToolStep.events.push({ ...toolEvent });
    const calls = tab.liveToolStep.calls;
    const entry = {
      call_index: toolEvent.call_index,
      name: toolEvent.tool_name,
      arguments: toolEvent.arguments,
      status: toolEvent.status,
      ...(toolEvent.result !== undefined ? { result: toolEvent.result } : {}),
      ...(typeof toolEvent.error === 'string' ? { error: toolEvent.error } : {}),
    };
    const existingIndex = calls.findIndex((call) => call.call_index === entry.call_index);
    if (existingIndex < 0) calls.push(entry);
    else calls[existingIndex] = entry;
    calls.sort((left, right) => left.call_index - right.call_index);
  }
  if (isAgentTrace(trace) && tab.liveToolStep
    && trace.steps.some((step) => step.step_number >= tab.liveToolStep.step_number)) {
    tab.liveToolStep = null;
  }
  if (isAgentTrace(trace) && isLiveProgress(tab.progress)
    && trace.steps.some((step) => step.step_number >= tab.progress.step_number)) {
    tab.progress = null;
  }
  if (recording === false) {
    tab.liveToolStep = null;
    tab.progress = null;
  }
  return true;
}

export function traceToolEntries(step) {
  const calls = Array.isArray(step?.tool_calls) ? step.tool_calls : [];
  const observations = Array.isArray(step?.observation) ? step.observation : [];
  const matched = new Set();
  let observationCursor = 0;
  const entries = calls.map((call, callIndex) => {
    const name = typeof call?.name === 'string' && call.name ? call.name : 'Unknown tool';
    let observationIndex = -1;
    for (let index = observationCursor; index < observations.length; index += 1) {
      if (observations[index]?.name === name) {
        observationIndex = index;
        break;
      }
    }
    const observation = observationIndex >= 0 ? observations[observationIndex] : null;
    if (observation) {
      matched.add(observationIndex);
      observationCursor = observationIndex + 1;
    }
    const status = observation?.status
      ?? (step?.status === 'rejected'
        ? 'rejected'
        : step?.status === 'needs_human' ? 'needs_human' : 'not_executed');
    return {
      name,
      ...(typeof call?.id === 'string' ? { id: call.id } : {}),
      arguments: call?.arguments ?? null,
      call_index: callIndex,
      status,
      ...(observation?.result !== undefined ? { result: observation.result } : {}),
      ...(observation?.error ? { error: observation.error } : {}),
    };
  });

  for (const [index, observation] of observations.entries()) {
    if (matched.has(index) || !observation || typeof observation.name !== 'string') continue;
    entries.push({
      name: observation.name,
      arguments: null,
      status: observation.status ?? 'not_executed',
      ...(observation.result !== undefined ? { result: observation.result } : {}),
      ...(observation.error ? { error: observation.error } : {}),
      unmatched: true,
    });
  }
  return entries;
}

export function traceToolTitle(entry) {
  switch (entry?.name) {
    case 'search_web':
      return 'Search web';
    case 'open_web_page':
      return 'Open web page';
    case 'read_web_page':
      return 'Read web page';
    case 'inspect_folder':
      return 'Inspect attached folder';
    case 'list_directory':
      return 'List directory';
    case 'read_file':
      return 'Read project file';
    case 'grep':
      return 'Search project files';
    case 'search_attached_documents':
      return 'Search attached documents';
    case 'read_attached_document':
      return 'Read attached document';
    case 'run_terminal_command':
      return 'Run approved terminal command';
    case 'get_local_datetime':
      return 'Check local date and time';
    case 'calculate':
      return 'Calculate';
    default:
      return typeof entry?.name === 'string' && entry.name
        ? `Run ${activityFieldLabel(entry.name)} tool`
        : 'Run tool';
  }
}

function traceToolProgressTitle(entry) {
  if (entry?.status === 'needs_human') return 'Waiting for approval...';
  const labels = {
    search_web: ['Waiting to search the web...', 'Searching the web...'],
    open_web_page: ['Waiting to open the web page...', 'Opening web page...'],
    read_web_page: ['Waiting to read the web page...', 'Reading web page...'],
    inspect_folder: ['Waiting to inspect the attached folder...', 'Inspecting attached folder...'],
    list_directory: ['Waiting to list the directory...', 'Listing directory...'],
    read_file: ['Waiting to read the project file...', 'Reading project file...'],
    grep: ['Waiting to search project files...', 'Searching project files...'],
    search_attached_documents: ['Waiting to search attached documents...', 'Searching attached documents...'],
    read_attached_document: ['Waiting to read the attached document...', 'Reading attached document...'],
    run_terminal_command: ['Waiting to run the terminal command...', 'Running the terminal command...'],
    get_local_datetime: ['Waiting to check local date and time...', 'Checking local date and time...'],
    calculate: ['Waiting to calculate...', 'Calculating...'],
  }[entry?.name];
  if (entry?.status === 'pending') {
    return labels?.[0] ?? `Waiting to run ${traceToolTitle(entry).toLocaleLowerCase()}...`;
  }
  if (entry?.status === 'running') {
    return labels?.[1] ?? `Working on ${traceToolTitle(entry).toLocaleLowerCase()}...`;
  }
  return null;
}

function getWebHost(value) {
  if (typeof value !== 'string') return '';
  try {
    return new URL(value).hostname.replace(/^www\./u, '');
  } catch {
    return '';
  }
}

function shortText(value, limit = 96) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function activityFieldLabel(key) {
  const label = key
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .replace(/[_-]+/gu, ' ')
    .toLocaleLowerCase();
  return label ? label[0].toLocaleUpperCase() + label.slice(1) : label;
}

export function traceToolStatusLabel(status) {
  return ({
    success: 'Done',
    failed: 'Could not finish',
    rejected: 'Blocked',
    needs_human: 'Needs your approval',
    not_executed: 'Skipped',
    pending: 'Waiting',
    running: 'Working…',
  })[status] ?? 'Status unavailable';
}

export function traceToolDescription(entry) {
  if (entry?.name === 'search_web'
    && typeof entry.arguments?.query === 'string' && entry.arguments.query.trim()) {
    const query = `“${entry.arguments.query.trim()}”`;
    if (entry.status === 'success') return `Searched for ${query}.`;
    if (entry.status === 'pending' || entry.status === 'running') return `Searching for ${query}.`;
  }
  if (entry?.status === 'pending') return 'Waiting to start.';
  if (entry?.status === 'running') return 'Working on this now.';
  if (entry?.status === 'needs_human') return 'Waiting for your approval.';
  if (entry?.status === 'not_executed') return 'This was skipped because the task stopped earlier.';
  if (entry?.status === 'failed' || entry?.status === 'rejected') return 'This action could not be completed.';
  if (entry?.status !== 'success') return 'No further details are available.';

  const result = entry.result;
  switch (entry.name) {
    case 'search_web':
      return typeof entry.arguments?.query === 'string' && entry.arguments.query.trim()
        ? `Searched for “${entry.arguments.query.trim()}”.`
        : 'Searched the web.';
    case 'open_web_page':
      return result?.title
        ? `Opened “${shortText(result.title)}” to check its information.`
        : 'Opened the page to check its information.';
    case 'read_web_page': {
      const page = typeof result?.title === 'string' && result.title
        ? `“${shortText(result.title)}”`
        : typeof result?.url === 'string' && result.url
          ? result.url
          : typeof entry.arguments?.url === 'string' && entry.arguments.url
            ? entry.arguments.url
            : 'the web page';
      return `Read ${page}.`;
    }
    case 'inspect_folder': {
      const fileCount = Number.isSafeInteger(result?.fileCount) ? result.fileCount : null;
      const passageCount = Array.isArray(result?.passages) ? result.passages.length : 0;
      if (fileCount === null) return `Folder overview prepared with ${passageCount} useful passages.`;
      return `Reviewed ${fileCount} ${fileCount === 1 ? 'file' : 'files'} and found ${passageCount} useful ${passageCount === 1 ? 'passage' : 'passages'}.`;
    }
    case 'list_directory': {
      const count = Array.isArray(result?.entries) ? result.entries.length : 0;
      return `Found ${count} ${count === 1 ? 'item' : 'items'}${result?.omittedCount ? '; some items were left out' : ''}.`;
    }
    case 'read_file':
      return result?.path || entry.arguments?.path
        ? `Read ${result?.path ?? entry.arguments.path}${result?.truncated ? '. More of the file is available.' : '.'}`
        : 'Finished reading the project file.';
    case 'grep': {
      const count = Array.isArray(result?.matches) ? result.matches.length : 0;
      const scanned = Number.isSafeInteger(result?.scannedFiles) ? result.scannedFiles : null;
      return `Found ${count} ${count === 1 ? 'match' : 'matches'}${scanned === null ? '' : ` across ${scanned} files`}.`;
    }
    case 'search_attached_documents': {
      const count = Array.isArray(result?.passages) ? result.passages.length : 0;
      return `Found ${count} relevant ${count === 1 ? 'passage' : 'passages'}.`;
    }
    case 'read_attached_document':
      return result?.passage?.name
        ? `Found relevant information in ${result.passage.name}.`
        : result?.passage === null
          ? 'No matching passage was found.'
          : 'Finished reading the attached document.';
    case 'run_terminal_command':
      return 'The approved command finished.';
    case 'get_local_datetime':
      return result?.local ? `Local time is ${result.local}.` : 'Checked the device date and time.';
    case 'calculate':
      return typeof result?.result === 'number' ? `The result is ${result.result}.` : 'Finished the calculation.';
    default:
      return 'Finished checking this information.';
  }
}

export function traceStepTitle(step) {
  return 'Decision';
}

export function workflowSelectionActivity(workflowName) {
  return {
    title: `Workflow selected: ${workflowName}`,
    completed: true,
  };
}

export function traceActivityDescription(step) {
  return typeof step?.thought === 'string' && step.thought.trim()
    ? step.thought.trim()
    : traceThoughtSummary(step);
}

export function traceLiveDecisionActivity(progress, calls = []) {
  const entries = calls.map((call) => ({
    name: call.name,
    arguments: call.arguments,
  }));
  const decided = entries.length > 0 || progress?.phase === 'using_tool';
  if (!decided) return { title: 'Thinking...', completed: false };

  if (entries.length === 0 && typeof progress?.tool_name === 'string') {
    entries.push({ name: progress.tool_name, arguments: {} });
  }
  return {
    title: 'Decision',
    description: traceThoughtSummary({ status: 'success' }, entries),
    completed: true,
  };
}

function traceToolDuration(events) {
  const started = events.find((event) => event.status === 'running');
  const completed = [...events].reverse().find((event) => [
    'success',
    'failed',
    'rejected',
    'needs_human',
    'not_executed',
  ].includes(event.status));
  if (!started || typeof started.timestamp !== 'string'
    || !Number.isFinite(Date.parse(started.timestamp))) {
    return null;
  }
  if (completed && typeof completed.timestamp === 'string'
    && Number.isFinite(Date.parse(completed.timestamp))) {
    return { durationMs: Math.max(0, Date.parse(completed.timestamp) - Date.parse(started.timestamp)) };
  }
  return { durationStartedAt: started.timestamp };
}

export function traceStepActivities(step) {
  const entries = traceToolEntries(step);
  const storedEvents = Array.isArray(step?.tool_events) ? step.tool_events : [];
  const thoughtActivity = {
    title: traceStepTitle(step),
    description: traceActivityDescription(step),
    completed: true,
  };
  const activities = [thoughtActivity];
  const toolActivities = entries.map((entry) => {
    const events = storedEvents.filter((event) => event.call_index === entry.call_index);
    const latestEvent = events.at(-1);
    const finalEntry = latestEvent ? {
      ...entry,
      status: latestEvent.status,
      ...(latestEvent.result !== undefined ? { result: latestEvent.result } : {}),
      ...(typeof latestEvent.error === 'string' ? { error: latestEvent.error } : {}),
    } : entry;
    return traceToolActivity(finalEntry, events);
  });
  activities.push(...toolActivities);
  return activities;
}

export function traceThoughtSummary(step, entries = traceToolEntries(step)) {
  if (typeof step?.thought === 'string' && step.thought.trim()) {
    return step.thought.trim();
  }
  if (entries.length > 0) {
    const intents = entries.map((entry) => {
      const args = entry.arguments;
      if (entry.name === 'search_web' && typeof args?.query === 'string' && args.query.trim()) {
        return `search the web for “${shortText(args.query, 120)}”`;
      }
      if (['open_web_page', 'read_web_page'].includes(entry.name)) {
        const host = getWebHost(args?.url);
        if (host) return `${entry.name === 'open_web_page' ? 'open' : 'read'} ${host}`;
        if (typeof entry.result?.title === 'string' && entry.result.title) {
          return `${entry.name === 'open_web_page' ? 'open' : 'read'} “${shortText(entry.result.title)}”`;
        }
        return entry.name === 'open_web_page' ? 'open the web page' : 'read the web page';
      }
      if (entry.name === 'read_file' && typeof args?.path === 'string') {
        return `read ${args.path}`;
      }
      if (entry.name === 'grep' && typeof args?.pattern === 'string') {
        return `search project files for “${shortText(args.pattern, 120)}”`;
      }
      const title = traceToolTitle(entry);
      return title.startsWith('Run ')
        ? title.toLocaleLowerCase()
        : `use ${title.toLocaleLowerCase()}`;
    });
    if (intents.length === 1) return `The assistant decided to ${intents[0]}.`;
    return `The assistant decided to: ${intents.join('; ')}.`;
  }
  if (step?.status === 'needs_human') return 'The assistant is waiting for approval.';
  if (step?.status === 'complete' || typeof step?.final_answer === 'string') {
    return 'The assistant considered the request and prepared a response.';
  }
  return 'The assistant is considering the request and available information.';
}

export function traceToolActivity(entry, events = []) {
  const completed = ['success', 'failed', 'rejected', 'not_executed'].includes(entry.status);
  return {
    title: traceToolProgressTitle(entry) ?? traceToolTitle(entry),
    ...(completed ? { description: traceToolDescription(entry) } : {}),
    completed,
    ...traceToolDuration(events),
  };
}

export function traceRunStatus(tab) {
  if (tab?.recording) {
    if (tab.progress?.phase === 'preparing') return 'Getting ready to help';
    if (tab.progress?.phase === 'thinking') return 'Considering the next step';
    if (tab.progress?.phase === 'using_tool') {
      switch (tab.progress.tool_name) {
        case 'inspect_folder':
        case 'list_directory':
          return 'Reviewing your folder';
        case 'read_file':
        case 'read_attached_document':
          return 'Reading your files';
        case 'grep':
        case 'search_attached_documents':
          return 'Searching your files';
        default:
          return 'Working with your files';
      }
    }
    return tab.liveToolStep ? 'Working with your information' : 'Working on your request';
  }
  if (!isAgentTrace(tab?.trace)) return 'No activity recorded yet';
  const lastStep = tab.trace.steps.at(-1);
  return ({
    complete: 'Finished',
    failed: 'Could not finish',
    rejected: 'Paused at a safety check',
    needs_human: 'Waiting for your input',
  })[lastStep?.status] ?? 'Activity recorded';
}
