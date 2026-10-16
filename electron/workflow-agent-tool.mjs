import { validateWorkflow } from './workflow-store.mjs';

export function createWorkflowSaveTool({ saveWorkflow }) {
  if (typeof saveWorkflow !== 'function') {
    throw new TypeError('A workflow save handler is required.');
  }
  return {
    name: 'save_workflow',
    description: 'Save a completed workflow created from the user’s requirements to the local workflow list.',
    permission: 'allow',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 80 },
        starter: { type: 'string', minLength: 1, maxLength: 1_500 },
        steps: {
          type: 'array',
          minItems: 1,
          maxItems: 12,
          items: { type: 'string', minLength: 1, maxLength: 1_500 },
        },
        goal: { type: 'string', minLength: 1, maxLength: 2_000 },
      },
      required: ['name', 'starter', 'steps', 'goal'],
      additionalProperties: false,
    },
    validate_input(arguments_) {
      try {
        validateWorkflow(arguments_, { allowMissingId: true });
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
    execute(arguments_, context) {
      return saveWorkflow({
        workflow: validateWorkflow(arguments_, { allowMissingId: true }),
        signal: context.signal,
      });
    },
  };
}
