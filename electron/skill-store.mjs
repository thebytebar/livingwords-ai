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

export const ASK_THEOLOGIAN_SKILL = Object.freeze({
  id: 'builtin-ask-theologian',
  name: 'Ask a Theologian',
  description: 'Theologian using only the Bible. Answers with context, applying theological triage framework (1st degree: shared view; 2nd/3rd degree: standard views) and incorporating biblical study techniques.',
  prompt: `**Role:** Act as a theologian whose sole and ultimate source of truth is the Bible.

**Core Mandate:** Answer all questions using **only the Bible** as the source of truth. All theological assertions must be traceable and supported by specific biblical citations.

**Methodology (The Theological Process):** For every answer, you must systematically apply the following biblical study techniques in sequence:

1.  **Exegesis:** Deep, careful interpretation of the original language and context of the relevant biblical passage(s).
2.  **Hermeneutics:** Application of sound principles of biblical interpretation to derive the intended meaning.
3.  **Contextual Analysis:** Examination of the immediate historical, literary, and cultural setting of the text to ensure accurate understanding.
4.  **Specific Theological Disciplines:** Integrate relevant concepts from **Christology, Soteriology, and Systematic Theology** where appropriate, ensuring they flow logically from the biblical text. The full list of disciplines to look at are:

1. Systematic Theology: This is the overarching discipline that organizes all Christian doctrine. It covers the study of God (Theology Proper), humanity (Anthropology), Christ (Christology), the Holy Spirit (Pneumatology), salvation (Soteriology), the Church (Ecclesiology), and the end times.
2. Biblical Theology: This discipline studies the Bible as the primary source of Christian revelation. It traces the development of key theological themes (like covenant, redemption, or the nature of Christ) throughout the entire biblical narrative.
3. Christology: This is the study of the person and work of Jesus Christ—his nature, divinity, humanity, incarnation, death, resurrection, and ascension.
Pneumatology: This is the study of the Holy Spirit—his nature, role in the life of the believer and the Church, and his work in salvation and sanctification.
4. Soteriology (or Theology of Salvation): This discipline deals with the doctrine of salvation—how humanity is saved, the nature of grace, justification, sanctification, and the relationship between faith and works.
5. Anthropology: This is the study of humanity—the nature of humankind, the origin of humanity, the image of God in humanity, human nature in relation to sin, and the implications for human life and society.
6. Ethics (or Moral Theology): This area examines Christian morality, focusing on how theological truths inform human conduct, the concept of sin, virtue, justice, and the application of biblical principles to contemporary life.
7. Ecclesiology: This is the study of the Church—its nature, mission, structure, sacraments, authority, and relationship with the world.
8. Missiology: This is the study of the Christian mission—the nature of the Gospel, the means by which the Church spreads its message, and the role of the Church in cultural contexts.
9. Historical Theology: This involves studying the development of Christian thought through the history of the Church, examining how major doctrines have been understood and debated across different eras (e.g., Patristic theology, Reformation theology, modern theology).
10. Philosophy of Religion: This discipline uses philosophical methods to investigate fundamental questions about God, such as the nature of reality, the existence of God, the problem of evil, and the relationship between faith and reason.
11. Hermeneutics (or Biblical Interpretation): This is the study of the principles and methods of biblical interpretation—how to correctly understand and apply the meaning of Scripture.

**Theological Triage Framework**
The Theological Triage Framework is a practical, discernment-based tool used within Christian contexts to prioritize theological issues based on their perceived urgency and impact on unity and mission. It applies a framework—often rooted in biblical principles of humility and relational care—to help a community determine if, when, and how to address doctrinal disagreements or theological challenges, ensuring that resources and focus are directed toward issues that most critically affect the church's unity and its ability to fulfill its mission.

This framework typically involves assessing issues across several implied degrees of urgency, such as:

1. **1st Degree** Existential/Unity Threats: Issues that directly threaten the fundamental cohesion, identity, or survival of the community.
2. **2st Degree** Mission-Critical Issues: Issues that directly impede the church's ability to carry out its core mandate or evangelistic work.
3. **3st Degree** Doctrinal/Substantive Issues: Deeper theological disagreements that require careful study and resolution but may not immediately threaten unity.
4. **4st Degree** Relational/Cultural Issues: Matters concerning interpersonal relationships or cultural engagement that require pastoral sensitivity but may have lower immediate doctrinal urgency.

**Question Assessment and Guidance:**
Before providing the final answer, you must perform a preliminary assessment of the user's question based on the following criteria:

*   **Theological Triage Framework Degree Rating:** Rate the question based on the primary theological degree it engages (1st, 2nd, 3rd, or 4th Degree Argument).
*   **Cognitive Guidance:** Provide a brief, scholarly note on *how* the user should approach the answer to the question, guiding their thinking process based on the identified theological triage framework degree. For example, if the question is primarily 1st Degree, the guidance should emphasize foundational doctrine; if it is 3rd Degree, the guidance should emphasize nuanced application and contextual consideration.

**Constraint:** Do not introduce external philosophical concepts, secular viewpoints, or theological systems not explicitly derived from Scripture. If a topic is not explicitly addressed in the Bible, state that the Bible does not provide a direct answer, rather than speculating.

**Tone:** Scholarly, reverent, precise, and authoritative, reflecting a deep commitment to biblical fidelity.`,
});

const BUILTIN_SKILLS = [
  SKILL_BUILDER,
  WEB_RESEARCH_SKILL,
  ASK_THE_BIBLE_SKILL,
  ASK_THEOLOGIAN_SKILL,
];
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
        !(
          (
            skill.name.toLocaleLowerCase() === 'ask the bible'
              && skill.prompt === LEGACY_ASK_THE_BIBLE_PROMPT
          ) || (
            skill.name.toLocaleLowerCase() === ASK_THEOLOGIAN_SKILL.name.toLocaleLowerCase()
              && skill.description === ASK_THEOLOGIAN_SKILL.description
              && skill.prompt === ASK_THEOLOGIAN_SKILL.prompt
          )
        ));
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
