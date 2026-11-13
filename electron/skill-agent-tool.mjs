import { validateSkill } from './skill-store.mjs';

export function createSkillSaveTool({ saveSkill }) {
  if (typeof saveSkill !== 'function') {
    throw new TypeError('A skill save handler is required.');
  }
  return {
    name: 'skill_save',
    description: 'Save a completed skill created from the user’s requirements to the local skill list.',
    permission: 'allow',
    final_answer_on_success: 'Skill saved. You can review it in Skills.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 80 },
        description: { type: 'string', minLength: 1, maxLength: 240 },
        prompt: { type: 'string', minLength: 1, maxLength: 12_000 },
      },
      required: ['name', 'description', 'prompt'],
      additionalProperties: false,
    },
    validate_input(arguments_) {
      try {
        validateSkill(arguments_, { allowMissingId: true, requireDescription: true });
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
    execute(arguments_, context) {
      return saveSkill({
        skill: validateSkill(arguments_, { allowMissingId: true, requireDescription: true }),
        signal: context.signal,
      });
    },
  };
}
