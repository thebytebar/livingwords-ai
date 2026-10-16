import { createAgentHarness, serializeTrace } from '../src/core/agent-loop.js';

const workspace = { release: 'draft', checks: [] as string[] };
let modelTurn = 0;

const harness = createAgentHarness({
  max_steps: 5,
  require_verification: true,
  model: {
    async respond({ context }) {
      modelTurn += 1;
      if (modelTurn === 1) {
        return {
          thought: 'Prepare the release, then inspect the persisted state.',
          done: false,
          tool_calls: [{
            name: 'publish_release',
            arguments: { release: '2.4.0' },
          }],
          token_usage: { input_tokens: 110, output_tokens: 24, total_tokens: 134 },
        };
      }
      if (modelTurn === 2) {
        return {
          thought: 'Read the release state to confirm the write.',
          done: false,
          tool_calls: [{ name: 'read_release_state', arguments: {} }],
          token_usage: { input_tokens: 145, output_tokens: 18, total_tokens: 163 },
        };
      }
      return {
        thought: 'The stored state and release check agree.',
        done: true,
        final_answer: `Release ${workspace.release} is published; checks: ${workspace.checks.join(', ')}.`,
        token_usage: { input_tokens: 175, output_tokens: 29, total_tokens: 204 },
      };
    },
  },
  tools: [
    {
      name: 'publish_release',
      description: 'Publish a release into the workspace.',
      async execute(args) {
        const release = (args as { release: string }).release;
        workspace.release = release;
        return { saved: true, release };
      },
      verify: (_args, result) => {
        const release = (result as { release: string }).release;
        return {
          passed: workspace.release === release,
          details: `Workspace stores release ${workspace.release}.`,
        };
      },
    },
    {
      name: 'read_release_state',
      description: 'Read the current release and run a check.',
      async execute() {
        workspace.checks.push('release-state-read');
        return { release: workspace.release, checks: [...workspace.checks] };
      },
      verify: (_args, result) => {
        const state = result as { release: string; checks: string[] };
        return {
          passed: state.release === workspace.release && state.checks.includes('release-state-read'),
          details: 'The persisted release and inspection check match the workspace.',
        };
      },
    },
  ],
});

const result = await harness.run('Publish release 2.4.0, inspect the saved state, and report the verified result.');
console.log(JSON.stringify({
  final_answer: result.final_answer,
  success: result.success,
  stop_reason: result.stop_reason,
  metrics: result.metrics,
  trace: JSON.parse(serializeTrace(result.trace)),
}, null, 2));

if (!result.success) process.exitCode = 1;
