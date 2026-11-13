const DOCUMENT_TOOL_NAMES = new Set([
  'document_search_attached',
  'document_read_attached',
  'document_inspect_folder',
  'document_list_directory',
  'document_read_file',
  'document_grep',
  'document_propose_edit',
]);
const PANEL_TOOL_NAMES = new Set([
  'panel_list_tabs',
  'panel_read_tab',
  'panel_close_tab',
]);

export function inferHighConfidenceRequestMode({
  task,
  selectedToolNames = [],
  hasDocumentTools = false,
  hasOpenTabs = false,
  skill = null,
}) {
  if (typeof task !== 'string' || !Array.isArray(selectedToolNames)) {
    throw new TypeError('Local request classification input is invalid.');
  }
  const selected = new Set(selectedToolNames);
  if ([...selected].some((name) => DOCUMENT_TOOL_NAMES.has(name))) return 'documents';
  if ([...selected].some((name) => name === 'web_search' || name === 'web_research'
    || name === 'browser_read_page' || name === 'browser_open_page')) return 'web';
  if ([...selected].some((name) => PANEL_TOOL_NAMES.has(name))) return 'panel';
  if (selected.has('terminal_run_command')) return 'terminal';
  if (selected.has('skill_save')) return 'skill';
  if (skill?.id === 'builtin-web-research') return 'web';
  if (skill) return 'skill';

  const text = task.toLocaleLowerCase();
  if (hasDocumentTools
    && /\b(?:attached|document|file|folder|notes?|source\s+code|project-wide)\b/u.test(text)) {
    return 'documents';
  }
  const asksForCurrentInfo = /\b(?:current(?:ly)?|latest|newest|recent|today(?:'s)?|right\s+now|as\s+of|this\s+(?:week|month|year)|live)\b/u
    .test(text);
  const refersToOpenPanel = /\b(?:current\s+page|this\s+tab|these\s+search\s+results|open\s+browser|displayed\s+content|right[- ]panel|the\s+terminal|terminal\s+output)\b/u
    .test(text)
    || /\b(?:terminal|web[- ]search)\s+tab\b/u.test(text);
  if (/\b(?:https?:\/\/|www\.)/u.test(text)
    || /\b(?:web|internet|online|browse|website|web\s+search|search\s+the\s+web)\b/u.test(text)
    || /\b(?:current|latest|today's|recent)\b[\s\S]{0,80}\b(?:news|price|version|status|research|information)\b/u.test(text)
    || (asksForCurrentInfo && !requestsDeviceClock(text) && !refersToOpenPanel)
    || needsPublicWebLookup(text)) {
    return 'web';
  }
  if (/\b(?:current\s+page|this\s+tab|these\s+search\s+results|open\s+browser|displayed\s+content|right[- ]panel|the\s+terminal|terminal\s+output)\b/u.test(text)
    || /\b(?:terminal|web[- ]search)\s+tab\b/u.test(text)
    || (hasOpenTabs && /\b(?:explain|summarize|describe|compare|read|what(?:'s| is))\s+(?:this|that|these|those)\b/u.test(text))) {
    return 'panel';
  }
  if (/\b(?:run|execute|launch|start)\b[\s\S]{0,50}\b(?:command|terminal|shell|script)\b/u.test(text)
    || /\b(?:in|using|from)\s+the\s+terminal\b/u.test(text)) {
    return 'terminal';
  }
  if (isStraightforwardArithmetic(task) || requestsDeviceClock(task)) return 'chat';
  return null;
}

export function inferLocalRequestMode(options) {
  return inferHighConfidenceRequestMode(options) ?? 'chat';
}

export function selectAgentTools(tools, {
  task,
  mode,
  selectedToolNames = [],
  skill = null,
}) {
  if (!Array.isArray(tools) || typeof task !== 'string' || typeof mode !== 'string') {
    throw new TypeError('Local agent tool selection input is invalid.');
  }
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const selected = new Set(selectedToolNames);
  const add = (names) => names.map((name) => byName.get(name)).filter(Boolean);
  const withDependencies = (names) => {
    const expanded = new Set(names);
    if (expanded.has('panel_read_tab')) expanded.add('panel_list_tabs');
    if (expanded.has('document_read_file')) expanded.add('document_inspect_folder');
    return [...expanded].map((name) => byName.get(name)).filter(Boolean);
  };

  if (selected.size > 0) {
    return withDependencies(selected);
  }

  if (mode === 'documents') {
    return tools.filter(({ name }) => DOCUMENT_TOOL_NAMES.has(name));
  }
  if (mode === 'web') {
    const text = task.toLocaleLowerCase();
    if (/\bsearch\s+results?\b/u.test(text)
      || /\b(?:only|just)\b[\s\S]{0,40}\b(?:links?|results?)\b/u.test(text)
      || /\b(?:show|list|give|display)\b[\s\S]{0,40}\b(?:search\s+results?|links?)\b/u.test(text)) {
      return add(['web_search']);
    }
    if (/\b(?:https?:\/\/|www\.)/u.test(text)) return add(['browser_read_page']);
    return add(['web_research']);
  }
  if (mode === 'panel') {
    const names = ['panel_list_tabs', 'panel_read_tab'];
    if (/\bclose\b[\s\S]{0,40}\b(?:browser|web[- ]search|tab|tabs)\b/u.test(task)) {
      names.push('panel_close_tab');
    }
    return add(names);
  }
  if (mode === 'terminal') return add(['terminal_run_command']);
  if (mode === 'skill') {
    if (!skill || skill.id === 'skill-builder') return add(['skill_save']);
    const skillText = [
      skill?.name,
      skill?.prompt,
    ].filter((part) => typeof part === 'string').join('\n');
    const referencedTools = new Set(
      [...skillText.matchAll(/@([a-zA-Z][a-zA-Z0-9_-]{0,63})/gu)]
        .map(([, name]) => name)
        .filter((name) => typeof name === 'string' && byName.has(name)),
    );
    return withDependencies(referencedTools);
  }

  const names = [];
  if (!isStraightforwardArithmetic(task) && !requestsDeviceClock(task)) {
    names.push('web_research');
  }
  if (isStraightforwardArithmetic(task)) names.push('calculator_evaluate');
  if (requestsDeviceClock(task)) names.push('time_get_local_datetime');
  return add(names);
}

export function inferHostToolCalls(task, tools, selectedToolNames = []) {
  if (typeof task !== 'string' || !Array.isArray(tools) || !Array.isArray(selectedToolNames)) {
    throw new TypeError('Host tool inference input is invalid.');
  }
  const available = new Set(tools.map(({ name }) => name));
  const selected = new Set(selectedToolNames);
  const calls = [];
  const timeRequested = selected.has('time_get_local_datetime') || requestsDeviceClock(task);
  if (timeRequested && available.has('time_get_local_datetime')) {
    calls.push({ name: 'time_get_local_datetime', arguments: {} });
  }

  if (!timeRequested && available.has('calculator_evaluate')
    && (selected.has('calculator_evaluate') || isStraightforwardArithmetic(task))) {
    const expression = arithmeticExpression(task);
    if (expression) calls.push({ name: 'calculator_evaluate', arguments: { expression } });
  }
  if (calls.length === 0 && selectedToolNames.length === 1) {
    const tool = tools.find(({ name }) => name === selectedToolNames[0]);
    const schema = tool?.input_schema;
    if (schema?.type === 'object' && schema.properties
      && typeof schema.properties === 'object' && !Array.isArray(schema.properties)) {
      const required = Array.isArray(schema.required) ? schema.required : [];
      const propertyNames = Object.keys(schema.properties);
      if (required.length === 0 && propertyNames.length === 0) {
        calls.push({ name: tool.name, arguments: {} });
      } else if (required.length === 1 || (required.length === 0 && propertyNames.length === 1)) {
        const key = required[0] ?? propertyNames[0];
        const property = schema.properties[key];
        if (typeof key === 'string' && property?.type === 'string') {
          const value = explicitToolArgument(task, key);
          if (value) calls.push({ name: tool.name, arguments: { [key]: value } });
        }
      }
    }
  }
  return calls;
}

function explicitToolArgument(task, key) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const labeled = new RegExp(
    `\\b${escapedKey}\\s*[:=]\\s*(?:"([^"]+)"|'([^']+)'|([^,;\\n]+))`,
    'iu',
  ).exec(task);
  const value = (labeled?.[1] ?? labeled?.[2] ?? labeled?.[3])
    ?.trim()
    .replace(/[?.!]+$/u, '');
  if (value) return value;
  if (key !== 'query') return null;
  const query = /\b(?:search|look\s+up|research)\s+(?:the\s+web\s+)?(?:for|about)?\s*["“]?(.+?)["”]?[?.!]?$/iu.exec(task)?.[1];
  return query?.trim() || null;
}

function requestsDeviceClock(task) {
  return /\b(?:what(?:'s| is) the (?:current |local )?time|what time is it|current time|local time|what(?:'s| is) the (?:current |local )?date|what date is it|today'?s date|current date)\b/iu
    .test(task);
}

function needsPublicWebLookup(text) {
  return /\b(?:stock|share)\s+(?:prices?|quotes?|performance|value)\b/u.test(text)
    || /\b(?:prices?|quotes?)\s+for\b[\s\S]{0,40}\b(?:stocks?|shares?)\b/u.test(text)
    || (/\b(?:weather|forecast)\b/u.test(text)
      && !/\b(?:explain|define|how\s+(?:does|do)|why\s+(?:does|is))\b/u.test(text)
      && !/\bwhat\s+is\s+weather\s*[?.!]*$/u.test(text))
    || /\b(?:will\s+it|is\s+it\s+going\s+to|chance\s+of)\b[\s\S]{0,40}\b(?:rain|snow|storm)\b/u.test(text)
    || /\b(?:business hours|store hours|opening hours|closing times?|hours of operation)\b/u.test(text)
    || /\b(?:what time|when) does\b[\s\S]{0,80}\b(?:open|close|closes|closing|shut)\b/u.test(text)
    || /\bhow late\b/u.test(text)
    || /\b(?:phone number|street address|weather forecast|near me)\b/u.test(text)
    || /\b(?:is|are)\b[\s\S]{0,48}\b(?:open|closed)(?:\s+(?:today|now|tonight)\b|\s*[?.!]|$)/u.test(text)
    || /\b(?:look\s*up|find out)\b[\s\S]{0,60}\b(?:hours|closing|address|phone|weather|open|closed)\b/u.test(text);
}

function isStraightforwardArithmetic(task) {
  return /\b(?:calculate|compute|evaluate|what(?:'s| is)|how much is)\b/iu.test(task)
    && arithmeticExpressions(task).length > 0;
}

function arithmeticExpression(task) {
  const expressions = arithmeticExpressions(task);
  return expressions.length === 1 ? expressions[0] : null;
}

function arithmeticExpressions(task) {
  return [...task.matchAll(/-?\d+(?:\.\d+)?(?:\s*[+*/%^]\s*-?\d+(?:\.\d+)?)+/gu)]
    .map(([expression]) => expression.replace(/\s+/gu, ' ').trim());
}
