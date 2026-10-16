import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const MAX_WORKFLOWS = 32;
const MAX_WORKFLOW_NAME_LENGTH = 80;
const MAX_WORKFLOW_STARTER_LENGTH = 1_500;
const MAX_WORKFLOW_STEPS = 12;
const MAX_WORKFLOW_STEP_LENGTH = 1_500;
const MAX_WORKFLOW_GOAL_LENGTH = 2_000;
const MAX_WORKFLOW_CONTENT_LENGTH = 10_000;

const LEGACY_BUNDLED_WORKFLOW_IDS = new Set(['web-research']);
const WORKFLOW_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;

export const WORKFLOW_BUILDER = Object.freeze({
  id: 'workflow-builder',
  name: 'Build a workflow',
  starter: 'Use when the user asks to create, design, or improve a reusable workflow for the assistant.',
  steps: [
    'Understand the repeatable task, intended audience, desired result, and any important boundaries.',
    'Ask only useful, optional clarifying questions, one at a time; tell the user they may answer, skip, or continue.',
    'Ask no more than two follow-up questions unless the user explicitly wants more discussion.',
    'Offer useful recommendations and examples, invite feedback, and incorporate the user’s answers before drafting.',
    'When the user skips questions or asks to continue, use practical defaults, note important assumptions, and draft without treating missing details as blockers.',
    'Create a concise name, activation guidance, ordered steps, and goal once the user is ready to proceed.',
    'For a direct request to create a workflow, save the completed workflow without asking for a final confirmation; the user can edit or delete it from the Workflows page.',
  ],
  goal: 'Guide the user through creating a clear reusable workflow and open it in the Workflows editor after saving.',
});

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedText(value, label, maximum) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum) {
    throw new Error(`${label} must contain 1–${maximum} characters.`);
  }
  return value.trim();
}

export function validateWorkflow(value, { allowMissingId = false } = {}) {
  if (!isRecord(value)) throw new Error('Workflow must be an object.');
  const supportedKeys = new Set(['id', 'name', 'starter', 'steps', 'goal']);
  const unsupported = Object.keys(value).find((key) => !supportedKeys.has(key));
  if (unsupported) throw new Error(`Unsupported workflow field: ${unsupported}.`);
  const id = value.id;
  if (allowMissingId && id === undefined) {
    // New workflow IDs are assigned by the local store.
  } else if (typeof id !== 'string' || !WORKFLOW_ID_PATTERN.test(id)) {
    throw new Error('Workflow ID must use lowercase letters, numbers, and hyphens.');
  }
  if (typeof value.steps !== 'string' && !Array.isArray(value.steps)) {
    throw new Error('Workflow steps must be an array of instructions.');
  }
  const steps = typeof value.steps === 'string'
    ? value.steps.split(/\r?\n/u).map((step) => step.trim()).filter(Boolean)
    : value.steps.map((step, index) => boundedText(step, `Workflow step ${index + 1}`, MAX_WORKFLOW_STEP_LENGTH));
  if (steps.length < 1 || steps.length > MAX_WORKFLOW_STEPS) {
    throw new Error(`A workflow must contain 1–${MAX_WORKFLOW_STEPS} steps.`);
  }
  const workflow = {
    ...(id !== undefined ? { id } : {}),
    name: boundedText(value.name, 'Workflow name', MAX_WORKFLOW_NAME_LENGTH),
    starter: boundedText(value.starter, 'Workflow starter', MAX_WORKFLOW_STARTER_LENGTH),
    steps,
    goal: boundedText(value.goal, 'Workflow goal', MAX_WORKFLOW_GOAL_LENGTH),
  };
  const contentLength = workflow.name.length + workflow.starter.length + workflow.goal.length
    + workflow.steps.reduce((total, step) => total + step.length, 0);
  if (contentLength > MAX_WORKFLOW_CONTENT_LENGTH) {
    throw new Error(`Workflow content must not exceed ${MAX_WORKFLOW_CONTENT_LENGTH} characters.`);
  }
  return workflow;
}

function validateState(value) {
  if (!isRecord(value) || ![1, 2].includes(value.schema_version)
    || !Array.isArray(value.overrides) || !Array.isArray(value.custom)) {
    throw new Error('The saved workflows file has an unsupported format.');
  }
  if (value.schema_version === 2 && !Array.isArray(value.order)) {
    throw new Error('The saved workflows file is missing workflow priority order.');
  }
  if (Object.keys(value).some((key) => !['schema_version', 'overrides', 'custom', 'order'].includes(key))) {
    throw new Error('The saved workflows file contains unsupported fields.');
  }
  const hasMigratedLegacyWorkflow = value.custom.some((candidate) => isRecord(candidate)
    && LEGACY_BUNDLED_WORKFLOW_IDS.has(candidate.id));
  if (value.overrides.length > LEGACY_BUNDLED_WORKFLOW_IDS.size
    || value.custom.length > MAX_WORKFLOWS
      && (!hasMigratedLegacyWorkflow || value.custom.length > MAX_WORKFLOWS + LEGACY_BUNDLED_WORKFLOW_IDS.size)
    || value.overrides.length + value.custom.length > MAX_WORKFLOWS + LEGACY_BUNDLED_WORKFLOW_IDS.size) {
    throw new Error('The saved workflows file contains too many workflows.');
  }
  const legacyWorkflows = new Map();
  for (const candidate of value.overrides) {
    const workflow = validateWorkflow(candidate);
    if (!LEGACY_BUNDLED_WORKFLOW_IDS.has(workflow.id) || legacyWorkflows.has(workflow.id)) {
      throw new Error('The saved workflows file contains an invalid legacy workflow override.');
    }
    legacyWorkflows.set(workflow.id, workflow);
  }
  const custom = [...legacyWorkflows.values()];
  const ids = new Set(legacyWorkflows.keys());
  for (const candidate of value.custom) {
    const workflow = validateWorkflow(candidate);
    if (ids.has(workflow.id) || workflow.id === WORKFLOW_BUILDER.id) {
      throw new Error('The saved workflows file contains duplicate or reserved workflow IDs.');
    }
    ids.add(workflow.id);
    custom.push(workflow);
  }
  const order = value.order === undefined
    ? [WORKFLOW_BUILDER.id, ...custom.map(({ id }) => id)]
    : value.order;
  if (!Array.isArray(order) || order.length !== ids.size + 1
    || new Set(order).size !== order.length
    || order.some((id) => typeof id !== 'string'
      || (id !== WORKFLOW_BUILDER.id && !ids.has(id)))) {
    throw new Error('The saved workflows file contains an invalid workflow priority order.');
  }
  return { schema_version: 2, overrides: new Map(), custom, order };
}

export function createWorkflowStore(filePath) {
  if (typeof filePath !== 'string' || !filePath) throw new TypeError('A workflow file path is required.');
  let writeQueue = Promise.resolve();

  async function readState() {
    let contents;
    try {
      contents = await readFile(filePath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return {
          schema_version: 2,
          overrides: new Map(),
          custom: [],
          order: [WORKFLOW_BUILDER.id],
        };
      }
      throw new Error(`Could not read local workflows: ${error.message}`, { cause: error });
    }
    let parsed;
    try {
      parsed = JSON.parse(contents);
    } catch (error) {
      throw new Error('The saved workflows file is not valid JSON.', { cause: error });
    }
    return validateState(parsed);
  }

  async function writeState(state) {
    const persisted = {
      schema_version: 2,
      overrides: [...state.overrides.values()],
      custom: state.custom,
      order: state.order,
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
      throw new Error(`Could not save local workflows: ${error.message}`, { cause: error });
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
      const workflows = new Map([
        [WORKFLOW_BUILDER.id, WORKFLOW_BUILDER],
        ...state.custom.map((workflow) => [workflow.id, workflow]),
      ]);
      return state.order.map((id) => {
        const workflow = workflows.get(id);
        return {
          ...workflow,
          source: id === WORKFLOW_BUILDER.id ? 'builtin' : 'custom',
          customized: false,
          steps: [...workflow.steps],
        };
      });
    },
    save(value) {
      const workflow = validateWorkflow(value, { allowMissingId: true });
      return update((state) => {
        if (workflow.id === undefined) {
          if (state.custom.length >= MAX_WORKFLOWS) {
            throw new Error(`At most ${MAX_WORKFLOWS} custom workflows can be saved.`);
          }
          workflow.id = `custom-${randomUUID()}`;
          state.custom.push(workflow);
          state.order.push(workflow.id);
          return { ...workflow, steps: [...workflow.steps] };
        }
        const index = state.custom.findIndex((item) => item.id === workflow.id);
        if (index < 0) throw new Error('This workflow no longer exists. Reload the workflow list and try again.');
        state.custom[index] = workflow;
        return { ...workflow, steps: [...workflow.steps] };
      });
    },
    reorder(ids) {
      return update((state) => {
        const availableIds = new Set([WORKFLOW_BUILDER.id, ...state.custom.map(({ id }) => id)]);
        if (!Array.isArray(ids) || ids.length !== availableIds.size
          || new Set(ids).size !== ids.length
          || ids.some((id) => typeof id !== 'string' || !availableIds.has(id))) {
          throw new Error('Workflow priority order must include every available workflow exactly once.');
        }
        state.order = [...ids];
        return ids.map((id) => id);
      });
    },
    delete(id) {
      if (typeof id !== 'string' || !WORKFLOW_ID_PATTERN.test(id)) {
        throw new Error('Workflow ID is invalid.');
      }
      return update((state) => {
        const index = state.custom.findIndex((workflow) => workflow.id === id);
        if (index < 0) throw new Error('This workflow no longer exists. Reload the workflow list and try again.');
        state.custom.splice(index, 1);
        state.order = state.order.filter((workflowId) => workflowId !== id);
      });
    },
  });
}
