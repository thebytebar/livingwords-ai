import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const MAX_SKILLS = 32;
const MAX_SKILL_NAME_LENGTH = 80;
const MAX_SKILL_DESCRIPTION_LENGTH = 240;
const MAX_SKILL_STEPS = 100;
const MAX_SKILL_STEP_LENGTH = 1_500;
const MAX_SKILL_CONTENT_LENGTH = 12_000;

const LEGACY_BUNDLED_SKILL_IDS = new Set(['web-research']);
const LEGACY_BUILTIN_SKILL_IDS = new Set(['workflow-builder']);
const SKILL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const RENAMED_TOOL_REFERENCES = Object.freeze({
  search_attached_documents: 'document_search_attached',
  read_attached_document: 'document_read_attached',
  propose_document_edit: 'document_propose_edit',
  inspect_folder: 'document_inspect_folder',
  list_directory: 'document_list_directory',
  read_file: 'document_read_file',
  grep: 'document_grep',
  search_web: 'web_search',
  research_web: 'web_research',
  open_web_page: 'browser_open_page',
  read_web_page: 'browser_read_page',
  list_open_right_panel_tabs: 'panel_list_tabs',
  read_open_right_panel_tab: 'panel_read_tab',
  close_right_panel_tab: 'panel_close_tab',
  run_terminal_command: 'terminal_run_command',
  calculate: 'calculator_evaluate',
  get_local_datetime: 'time_get_local_datetime',
  save_skill: 'skill_save',
  get_tool_details: 'tool_get_details',
});

export const SKILL_BUILDER = Object.freeze({
  id: 'skill-builder',
  name: 'Build a skill',
  description: 'Reviews the conversation and creates a reusable assistant skill from it.',
  prompt: [
    'Use when the user asks to create, design, or improve a reusable skill for the assistant.',
    'Review the full conversation and extract the repeatable task, intended audience, desired result, user preferences, corrections, and important boundaries.',
    'Do not restart discovery or conduct a back-and-forth interview. Do not ask clarifying questions; use practical defaults and make any necessary assumptions explicit in the skill.',
    'Treat the user’s statements as requirements and assistant suggestions as context only; honor the user’s corrections.',
    'Create a concise name, a brief description, and a clear, complete reusable prompt that reflects what the conversation established.',
    'When asked to create a skill, save it without presenting an intermediate draft or asking for confirmation; the user can review and edit it in the Skills editor.',
  ].join('\n'),
});

export const WEB_RESEARCH_SKILL = Object.freeze({
  id: 'builtin-web-research',
  name: 'Web research',
  description: 'Searches current public web sources and produces a concise, cited answer.',
  prompt: [
    'Use when the user asks to search the web or internet, research something online, find current information, or summarize public web sources.',
    'Clarify the question internally and form a focused search query that preserves the user’s requested scope.',
    'For research or a sourced answer, use @web_research to search DuckDuckGo and read up to two promising pages in one operation; do not separately search and open the same pages.',
    'If the user only wants search results or links, use @web_search without opening pages.',
    'If the user provides a specific URL to read or analyze, use @browser_read_page directly with that URL; do not call @browser_open_page first.',
    'Base factual claims on successfully read page text; distinguish search-result snippets from page content and cite the exact URLs returned.',
    'If sources are sparse, unreadable, or disagree, state the limitation and what remains uncertain instead of filling gaps with guesses.',
    'Give a concise, useful answer grounded in current public web sources, with citations and transparent limitations.',
  ].join('\n'),
});

export const ASK_THE_BIBLE_SKILL = Object.freeze({
  id: 'builtin-ask-the-bible',
  name: 'Ask The Bible',
  description: 'You are a biblical scholar helping people find relevant Bible verses that answer their questions.',
  prompt: [
    'You are a biblical scholar helping people find relevant Bible verses that answer their questions.',
    'Please search for and provide up to 15 Bible verses that might contain answers or insights related to this question. Do not try to answer the question for the user. Instead just provide relevant verses. For each verse, provide',
    '1. The exact book name',
    '2. The chapter number',
    '3. The verse number',
    '4. The KJV version of the verse',
    '5. A brief explanation (at least 2 sentences) of why this verse is relevant to the question',
    '',
    '**Important** Format as a numbered list in format:',
    '',
    '**{book} {chapter}:{verse}** *{VerseContent}*',
    '',
    '- {explanation}',
  ].join('\n'),
});

const BUILTIN_SKILLS = [SKILL_BUILDER, WEB_RESEARCH_SKILL, ASK_THE_BIBLE_SKILL];
const BUILTIN_SKILL_IDS = new Set(BUILTIN_SKILLS.map(({ id }) => id));
const LEGACY_ASK_THE_BIBLE_PROMPT = ASK_THE_BIBLE_SKILL.prompt;

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedText(value, label, maximum) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum) {
    throw new Error(`${label} must contain 1–${maximum} characters.`);
  }
  return value.trim();
}

function defaultSkillDescription(prompt) {
  const firstSentence = prompt.trim().replace(/\s+/gu, ' ').split(/(?<=[.!?])\s/u, 1)[0];
  return firstSentence.slice(0, MAX_SKILL_DESCRIPTION_LENGTH).trim();
}

export function validateSkill(value, {
  allowMissingId = false,
  requireDescription = false,
} = {}) {
  if (!isRecord(value)) throw new Error('Skill must be an object.');
  if (requireDescription && value.description === undefined) {
    throw new Error('Skill description must be a string.');
  }
  const supportedKeys = new Set(['id', 'name', 'description', 'prompt', 'starter', 'steps', 'toolReferences', 'goal']);
  const unsupported = Object.keys(value).find((key) => !supportedKeys.has(key));
  if (unsupported) throw new Error(`Unsupported skill field: ${unsupported}.`);
  const id = value.id;
  if (allowMissingId && id === undefined) {
    // New skill IDs are assigned by the local store.
  } else if (typeof id !== 'string' || !SKILL_ID_PATTERN.test(id)) {
    throw new Error('Skill ID must use lowercase letters, numbers, and hyphens.');
  }
  if ('prompt' in value && typeof value.prompt !== 'string') {
    throw new Error('Skill prompt must be a string.');
  }
  let prompt;
  if (typeof value.prompt === 'string') {
    if ('starter' in value || 'steps' in value || 'goal' in value) {
      throw new Error('Skill prompt cannot be combined with legacy skill fields.');
    }
    prompt = boundedText(value.prompt, 'Skill prompt', MAX_SKILL_CONTENT_LENGTH);
  } else {
    if (typeof value.steps !== 'string' && !Array.isArray(value.steps)) {
      throw new Error('Skill prompt must be a string.');
    }
    const steps = typeof value.steps === 'string'
      ? value.steps.split(/\r?\n/u).map((step) => step.trim()).filter(Boolean)
      : value.steps.map((step, index) => boundedText(step, `Skill step ${index + 1}`, MAX_SKILL_STEP_LENGTH));
    if (steps.length < 1 || steps.length > MAX_SKILL_STEPS) {
      throw new Error(`A skill must contain 1–${MAX_SKILL_STEPS} legacy steps.`);
    }
    const starter = boundedText(value.starter, 'Skill starter', MAX_SKILL_CONTENT_LENGTH);
    const goal = boundedText(value.goal, 'Skill goal', MAX_SKILL_CONTENT_LENGTH);
    prompt = [
      `When to use this skill:\n${starter}`,
      `Skill instructions:\n${steps.map((step) => `- ${step}`).join('\n')}`,
      `Desired outcome:\n${goal}`,
    ].join('\n\n');
  }
  const skill = {
    ...(id !== undefined ? { id } : {}),
    name: boundedText(value.name, 'Skill name', MAX_SKILL_NAME_LENGTH),
    description: value.description === undefined
      ? defaultSkillDescription(prompt)
      : boundedText(value.description, 'Skill description', MAX_SKILL_DESCRIPTION_LENGTH),
    prompt: prompt.replace(/@([a-zA-Z][a-zA-Z0-9_-]{0,63})/gu, (mention, name) =>
      RENAMED_TOOL_REFERENCES[name] ? `@${RENAMED_TOOL_REFERENCES[name]}` : mention),
  };
  const contentLength = skill.name.length + skill.prompt.length;
  if (contentLength > MAX_SKILL_CONTENT_LENGTH) {
    throw new Error(`Skill content must not exceed ${MAX_SKILL_CONTENT_LENGTH} characters.`);
  }
  return skill;
}

function validateLegacyState(value) {
  if (!isRecord(value) || ![1, 2, 3, 4, 5].includes(value.schema_version)
    || !Array.isArray(value.overrides) || !Array.isArray(value.custom)) {
    throw new Error('The saved skills file has an unsupported format.');
  }
  // Versions 1 and 2 may contain a saved priority order; it is intentionally discarded.
  const supportedStateKeys = value.schema_version < 3
    ? ['schema_version', 'overrides', 'custom', 'order']
    : ['schema_version', 'overrides', 'custom'];
  if (Object.keys(value).some((key) => !supportedStateKeys.includes(key))) {
    throw new Error('The saved skills file contains unsupported fields.');
  }
  const hasMigratedLegacySkill = value.custom.some((candidate) => isRecord(candidate)
    && LEGACY_BUNDLED_SKILL_IDS.has(candidate.id));
  if (value.overrides.length > LEGACY_BUNDLED_SKILL_IDS.size
    || value.custom.length > MAX_SKILLS
      && (!hasMigratedLegacySkill || value.custom.length > MAX_SKILLS + LEGACY_BUNDLED_SKILL_IDS.size)
    || value.overrides.length + value.custom.length > MAX_SKILLS + LEGACY_BUNDLED_SKILL_IDS.size) {
    throw new Error('The saved skills file contains too many skills.');
  }
  const legacySkills = new Map();
  for (const candidate of value.overrides) {
    const skill = validateSkill(candidate);
    if (!LEGACY_BUNDLED_SKILL_IDS.has(skill.id) || legacySkills.has(skill.id)) {
      throw new Error('The saved skills file contains an invalid legacy skill override.');
    }
    legacySkills.set(skill.id, skill);
  }
  const custom = [...legacySkills.values()];
  const ids = new Set(legacySkills.keys());
  for (const candidate of value.custom) {
    const skill = validateSkill(candidate);
    if (ids.has(skill.id) || BUILTIN_SKILL_IDS.has(skill.id)
      || LEGACY_BUILTIN_SKILL_IDS.has(skill.id)) {
      throw new Error('The saved skills file contains duplicate or reserved skill IDs.');
    }
    ids.add(skill.id);
    custom.push(skill);
  }
  return { schema_version: 5, overrides: new Map(), custom };
}

function validateSkillState(value) {
  if (!isRecord(value) || value.schema_version !== 1 || !Array.isArray(value.skills)
    || Object.keys(value).some((key) => !['schema_version', 'skills'].includes(key))) {
    throw new Error('The saved skills file has an unsupported format.');
  }
  if (value.skills.length > MAX_SKILLS) {
    throw new Error('The saved skills file contains too many skills.');
  }
  const ids = new Set(BUILTIN_SKILL_IDS);
  const custom = value.skills.map((candidate) => {
    const skill = validateSkill(candidate);
    if (ids.has(skill.id)) {
      throw new Error('The saved skills file contains duplicate or reserved skill IDs.');
    }
    ids.add(skill.id);
    return skill;
  });
  return { schema_version: 5, overrides: new Map(), custom };
}

function validateState(value) {
  return isRecord(value) && Object.hasOwn(value, 'skills')
    ? validateSkillState(value)
    : validateLegacyState(value);
}

export function createSkillStore(filePath, { legacyFilePath } = {}) {
  if (typeof filePath !== 'string' || !filePath) throw new TypeError('A skill file path is required.');
  if (legacyFilePath !== undefined
    && (typeof legacyFilePath !== 'string' || !legacyFilePath || legacyFilePath === filePath)) {
    throw new TypeError('A distinct legacy workflow file path is required.');
  }
  let writeQueue = Promise.resolve();

  async function readStateFile(path, description) {
    let contents;
    try {
      contents = await readFile(path, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw new Error(`Could not read ${description}: ${error.message}`, { cause: error });
    }
    let parsed;
    try {
      parsed = JSON.parse(contents);
    } catch (error) {
      throw new Error(`The ${description} is not valid JSON.`, { cause: error });
    }
    return validateState(parsed);
  }

  async function readState() {
    const state = await readStateFile(filePath, 'saved skills file');
    if (state) {
      const customSkills = state.custom.filter((skill) =>
        !(skill.name.toLocaleLowerCase() === 'ask the bible'
          && skill.prompt === LEGACY_ASK_THE_BIBLE_PROMPT));
      if (customSkills.length !== state.custom.length) {
        state.custom = customSkills;
        await writeState(state);
      }
      return state;
    }
    if (legacyFilePath) {
      const legacyState = await readStateFile(legacyFilePath, 'legacy workflows file');
      if (legacyState) {
        await writeState(legacyState);
        return legacyState;
      }
    }
    return {
      schema_version: 5,
      overrides: new Map(),
      custom: [],
    };
  }

  async function writeState(state) {
    const persisted = {
      schema_version: 1,
      skills: state.custom,
    };
    await mkdir(dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(persisted)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      await rename(temporaryPath, filePath);
    } catch (error) {
      throw new Error(`Could not save local skills: ${error.message}`, { cause: error });
    }
  }

  function update(mutator) {
    const write = writeQueue.catch(() => {}).then(async () => {
      const state = await readState();
      const result = mutator(state);
      await writeState(state);
      return result;
    });
    writeQueue = write;
    return write;
  }

  return Object.freeze({
    async list() {
      const state = await readState();
      return [...BUILTIN_SKILLS, ...state.custom].map((skill) => {
        return {
          ...skill,
          source: BUILTIN_SKILL_IDS.has(skill.id) ? 'builtin' : 'custom',
          customized: false,
        };
      });
    },
    save(value) {
      const skill = validateSkill(value, { allowMissingId: true });
      return update((state) => {
        if (skill.id === undefined) {
          if (state.custom.length >= MAX_SKILLS) {
            throw new Error(`At most ${MAX_SKILLS} custom skills can be saved.`);
          }
          skill.id = `custom-${randomUUID()}`;
          state.custom.push(skill);
          return { ...skill };
        }
        const index = state.custom.findIndex((item) => item.id === skill.id);
        if (index < 0) throw new Error('This skill no longer exists. Reload the skill list and try again.');
        state.custom[index] = skill;
        return { ...skill };
      });
    },
    delete(id) {
      if (typeof id !== 'string' || !SKILL_ID_PATTERN.test(id)) {
        throw new Error('Skill ID is invalid.');
      }
      return update((state) => {
        const index = state.custom.findIndex((skill) => skill.id === id);
        if (index < 0) throw new Error('This skill no longer exists. Reload the skill list and try again.');
        state.custom.splice(index, 1);
      });
    },
  });
}
