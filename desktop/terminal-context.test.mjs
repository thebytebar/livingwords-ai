import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_TERMINAL_CONTEXT_LENGTH, readTerminalContext } from './terminal-context.mjs';

function terminalWithLines(lines) {
  return {
    buffer: {
      active: {
        length: lines.length,
        getLine(index) {
          return { translateToString: () => lines[index] };
        },
      },
    },
  };
}

test('terminal context reads recent visible text without terminal escape codes', () => {
  assert.equal(readTerminalContext(terminalWithLines(['$ ls', 'README.md', 'package.json'])),
    '$ ls\nREADME.md\npackage.json');
});

test('terminal context keeps only a bounded recent excerpt', () => {
  const output = 'x'.repeat(MAX_TERMINAL_CONTEXT_LENGTH + 100);
  const context = readTerminalContext(terminalWithLines([output]));
  assert.equal(context.length, MAX_TERMINAL_CONTEXT_LENGTH);
  assert.equal(context, output.slice(-MAX_TERMINAL_CONTEXT_LENGTH));
});

test('terminal context tolerates missing terminal buffers', () => {
  assert.equal(readTerminalContext(null), '');
  assert.equal(readTerminalContext(terminalWithLines(['output']), 0), '');
});
