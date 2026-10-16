import assert from 'node:assert/strict';
import test from 'node:test';
import { createTerminalAgentTool } from './terminal-agent-tool.mjs';

test('terminal agent tool validates a single command and delegates through approval handler', async () => {
  let received;
  const tool = createTerminalAgentTool({
    async requestCommand(request) {
      received = request;
      return 'approved output';
    },
  });
  const signal = new AbortController().signal;
  assert.equal(tool.permission, 'allow');
  assert.equal(tool.validate_input({ command: ' pwd ' }), null);
  assert.match(tool.validate_input({ command: 'one\ntwo' }), /single line/u);
  assert.match(tool.validate_input({ command: 'pwd', extra: true }), /Only a command/u);
  assert.equal(await tool.execute({ command: ' pwd ' }, { signal }), 'approved output');
  assert.deepEqual(received, { command: 'pwd', signal });
});

test('terminal agent tool requires its confirmation-gated handler', () => {
  assert.throws(() => createTerminalAgentTool({}), /approval-gated/u);
});
