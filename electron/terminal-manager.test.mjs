import assert from 'node:assert/strict';
import test from 'node:test';
import { createTerminalManager } from './terminal-manager.mjs';

const SESSION_A = '00112233-4455-4677-8899-aabbccddeeff';
const SESSION_B = '10112233-4455-4677-8899-aabbccddeeff';
const TERMINAL_A = '20112233-4455-4677-8899-aabbccddeeff';
const TERMINAL_B = '30112233-4455-4677-8899-aabbccddeeff';

function fakeTerminalManager() {
  const children = new Map();
  const data = [];
  const exits = [];
  const manager = createTerminalManager({
    spawnTerminal: (shell, args, options) => {
      const child = {
        shell,
        args,
        options,
        writes: [],
        sizes: [],
        killed: false,
        onData(listener) { this.dataListener = listener; },
        onExit(listener) { this.exitListener = listener; },
        write(value) { this.writes.push(value); },
        resize(cols, rows) { this.sizes.push([cols, rows]); },
        kill() { this.killed = true; },
      };
      children.set(options.cols, child);
      return child;
    },
    homeDirectory: '/home/test',
    shell: '/bin/zsh',
    shellArgs: ['-i'],
    env: { PATH: '/bin' },
    onData: (event) => data.push(event),
    onExit: (event) => exits.push(event),
    commandInput: ({ command, startMarker, endMarker }) => ({
      input: `run '${command}' # ${startMarker} ${endMarker}\n`,
      startToken: `\x7f${startMarker}\x7f`,
      endToken: `\x7f${endMarker}\x7f`,
    }),
  });
  return { manager, children, data, exits };
}

test('terminal manager starts isolated interactive terminals in the home directory', () => {
  const { manager, children } = fakeTerminalManager();
  manager.create({ terminalId: TERMINAL_A, sessionId: SESSION_A, cols: 80, rows: 24 });
  manager.create({ terminalId: TERMINAL_B, sessionId: SESSION_B, cols: 100, rows: 30 });

  assert.equal(children.get(80).shell, '/bin/zsh');
  assert.deepEqual(children.get(80).args, ['-i']);
  assert.equal(children.get(80).options.cwd, '/home/test');
  assert.equal(children.get(80).options.env.TERM, 'xterm-256color');
  assert.notEqual(children.get(80), children.get(100));
});

test('terminal manager forwards output and supports validated input and resize', () => {
  const { manager, children, data } = fakeTerminalManager();
  manager.create({ terminalId: TERMINAL_A, sessionId: SESSION_A, cols: 80, rows: 24 });
  const child = children.get(80);
  child.dataListener('hello\r\n');
  manager.write(TERMINAL_A, 'ls\r');
  manager.resize(TERMINAL_A, 120, 40);

  assert.deepEqual(data, [{ terminalId: TERMINAL_A, sessionId: SESSION_A, data: 'hello\r\n' }]);
  assert.deepEqual(child.writes, ['ls\r']);
  assert.deepEqual(child.sizes, [[120, 40]]);
  assert.throws(() => manager.write(TERMINAL_A, 'x'.repeat(16_385)), /Terminal input/u);
  assert.throws(() => manager.resize(TERMINAL_A, 1, 24), /columns/u);
});

test('terminal manager executes a validated command and returns only bounded command output', async () => {
  const { manager, children, data } = fakeTerminalManager();
  manager.create({ terminalId: TERMINAL_A, sessionId: SESSION_A, cols: 80, rows: 24 });
  const child = children.get(80);
  const command = manager.execute(TERMINAL_A, SESSION_A, 'pwd');
  const [input] = child.writes;
  const [, startMarker, endMarker] = input.match(/# ([^\s]+) ([^\s]+)\n$/u) ?? [];
  assert.match(input, /^run 'pwd'/u);
  assert.throws(
    () => manager.write(TERMINAL_A, 'unexpected input\r'),
    /unavailable while an assistant command is running/u,
  );
  child.dataListener(`${input.replaceAll('\n', '\r\n')}prompt$ `);
  child.dataListener(`\x7f${startMarker}\x7f/home/test\x7f${endMarker}\x7fprompt$ `);

  assert.equal(await command, '/home/test');
  assert.equal(data[0].data, 'pwd');
  assert.equal(data[1].data, '\r\n/home/test\r\n');
  const display = data.map(({ data: chunk }) => chunk).join('');
  assert.match(display, /^pwd\r\n/u);
  assert.match(display, /\/home\/test/u);
  assert.doesNotMatch(display, /LW_COMMAND_(?:START|END)/u);
  assert.doesNotMatch(display, /eval 'pwd'/u);
  assert.throws(() => manager.execute(TERMINAL_A, SESSION_B, 'pwd'), /conversation/u);
  assert.throws(() => manager.execute(TERMINAL_A, SESSION_A, 'x'.repeat(4_001)), /commands/u);
  assert.throws(() => manager.execute(TERMINAL_A, SESSION_A, 'pwd\nwhoami'), /single line/u);
});

test('terminal manager rejects a command if its process exits before completion', async () => {
  const { manager, children } = fakeTerminalManager();
  manager.create({ terminalId: TERMINAL_A, sessionId: SESSION_A, cols: 80, rows: 24 });
  const child = children.get(80);
  const command = manager.execute(TERMINAL_A, SESSION_A, 'sleep 5');
  child.exitListener({ exitCode: 1 });

  await assert.rejects(command, /exited before the command completed/u);
});

test('terminal manager closes only the requested session and reports process exit', () => {
  const { manager, children, exits } = fakeTerminalManager();
  manager.create({ terminalId: TERMINAL_A, sessionId: SESSION_A, cols: 80, rows: 24 });
  manager.create({ terminalId: TERMINAL_B, sessionId: SESSION_B, cols: 100, rows: 30 });
  const first = children.get(80);
  const second = children.get(100);

  assert.equal(manager.close(TERMINAL_A, SESSION_B), false);
  assert.equal(manager.close(TERMINAL_A, SESSION_A), true);
  assert.equal(first.killed, true);
  assert.equal(second.killed, false);
  second.exitListener({ exitCode: 0 });
  assert.deepEqual(exits, [{ terminalId: TERMINAL_B, sessionId: SESSION_B, exitCode: 0 }]);
  assert.throws(() => manager.write(TERMINAL_B, 'ls\r'), /no longer running/u);
});

test('terminal manager closes every process when its session or the app closes', () => {
  const { manager, children } = fakeTerminalManager();
  manager.create({ terminalId: TERMINAL_A, sessionId: SESSION_A, cols: 80, rows: 24 });
  manager.create({ terminalId: TERMINAL_B, sessionId: SESSION_B, cols: 100, rows: 30 });
  manager.closeSession(SESSION_A);
  assert.equal(children.get(80).killed, true);
  assert.equal(children.get(100).killed, false);
  manager.closeAll();
  assert.equal(children.get(100).killed, true);
});
