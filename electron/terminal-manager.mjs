import { randomUUID } from 'node:crypto';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_INPUT_LENGTH = 16_384;
const MAX_COMMAND_LENGTH = 4_000;
const MAX_COMMAND_OUTPUT_LENGTH = 6_000;
const COMMAND_TIMEOUT_MS = 120_000;

function validateId(value, name) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new Error(`${name} is invalid.`);
  }
  return value;
}

function validateSize(value, name) {
  if (!Number.isInteger(value) || value < 2 || value > 500) {
    throw new Error(`Terminal ${name} must be between 2 and 500.`);
  }
  return value;
}

export function createTerminalManager({
  spawnTerminal,
  homeDirectory,
  shell,
  shellArgs,
  env,
  onData,
  onExit,
  commandInput,
}) {
  if (typeof spawnTerminal !== 'function'
    || typeof homeDirectory !== 'string' || !homeDirectory
    || typeof shell !== 'string' || !shell
    || !Array.isArray(shellArgs) || shellArgs.some((argument) => typeof argument !== 'string')
    || !env || typeof env !== 'object'
    || typeof onData !== 'function' || typeof onExit !== 'function'
    || typeof commandInput !== 'function') {
    throw new TypeError('Terminal manager configuration is invalid.');
  }

  const terminals = new Map();

  function finishCommand(terminal, error, output = '') {
    const execution = terminal.execution;
    if (!execution) return;
    terminal.execution = null;
    clearTimeout(execution.timeout);
    execution.signal?.removeEventListener('abort', execution.abort);
    if (error) execution.reject(error);
    else {
      const boundedOutput = output.slice(-MAX_COMMAND_OUTPUT_LENGTH).replace(/\r\n?/gu, '\n').trim();
      onData({
        terminalId: execution.terminalId,
        sessionId: terminal.sessionId,
        data: `\r\n${boundedOutput}\r\n`,
      });
      execution.resolve(boundedOutput);
    }
  }

  function closeTerminal(terminalId, sessionId) {
    const terminal = terminals.get(terminalId);
    if (!terminal || (sessionId && terminal.sessionId !== sessionId)) return false;
    terminals.delete(terminalId);
    finishCommand(terminal, new Error('Terminal closed before the command completed.'));
    terminal.process.kill();
    return true;
  }

  return Object.freeze({
    create({ terminalId: rawTerminalId, sessionId: rawSessionId, cols, rows }) {
      const terminalId = validateId(rawTerminalId, 'Terminal ID');
      const sessionId = validateId(rawSessionId, 'Conversation ID');
      validateSize(cols, 'columns');
      validateSize(rows, 'rows');
      if (terminals.has(terminalId)) throw new Error('Terminal ID is already in use.');

      const process = spawnTerminal(shell, shellArgs, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: homeDirectory,
        env: { ...env, TERM: 'xterm-256color' },
      });
      const terminal = { process, sessionId };
      terminals.set(terminalId, terminal);
      process.onData((data) => {
        if (terminals.get(terminalId) !== terminal || typeof data !== 'string') return;
        const execution = terminal.execution;
        if (!execution) {
          onData({ terminalId, sessionId, data });
          return;
        }

        execution.pending += data;
        if (!execution.started) {
          const startIndex = execution.pending.indexOf(execution.startToken);
          if (startIndex < 0) {
            execution.pending = execution.pending.slice(-(execution.startToken.length - 1));
            return;
          }
          execution.pending = execution.pending.slice(startIndex + execution.startToken.length);
          execution.started = true;
        }
        const endIndex = execution.pending.indexOf(execution.endToken);
        if (endIndex >= 0) {
          const commandOutput = execution.output + execution.pending.slice(0, endIndex);
          const trailingData = execution.pending.slice(endIndex + execution.endToken.length);
          finishCommand(terminal, null, commandOutput);
          if (trailingData) onData({ terminalId, sessionId, data: trailingData });
        } else if (execution.pending.length > execution.endToken.length) {
          const safeLength = execution.pending.length - execution.endToken.length + 1;
          execution.output = (execution.output + execution.pending.slice(0, safeLength))
            .slice(-MAX_COMMAND_OUTPUT_LENGTH);
          execution.pending = execution.pending.slice(safeLength);
        }
      });
      process.onExit((event) => {
        if (terminals.get(terminalId) !== terminal) return;
        terminals.delete(terminalId);
        finishCommand(terminal, new Error('Terminal exited before the command completed.'));
        onExit({ terminalId, sessionId, exitCode: event.exitCode });
      });
      return { terminalId };
    },
    write(rawTerminalId, data) {
      const terminalId = validateId(rawTerminalId, 'Terminal ID');
      if (typeof data !== 'string' || data.length === 0 || data.length > MAX_INPUT_LENGTH) {
        throw new Error(`Terminal input must contain 1–${MAX_INPUT_LENGTH} characters.`);
      }
      const terminal = terminals.get(terminalId);
      if (!terminal) throw new Error('Terminal is no longer running.');
      if (terminal.execution && data !== '\x03') {
        throw new Error('Terminal input is unavailable while an assistant command is running.');
      }
      terminal.process.write(data);
    },
    resize(rawTerminalId, cols, rows) {
      const terminalId = validateId(rawTerminalId, 'Terminal ID');
      validateSize(cols, 'columns');
      validateSize(rows, 'rows');
      const terminal = terminals.get(terminalId);
      if (!terminal) throw new Error('Terminal is no longer running.');
      terminal.process.resize(cols, rows);
    },
    execute(rawTerminalId, rawSessionId, command, signal) {
      const terminalId = validateId(rawTerminalId, 'Terminal ID');
      const sessionId = validateId(rawSessionId, 'Conversation ID');
      if (typeof command !== 'string' || !command.trim() || command.length > MAX_COMMAND_LENGTH
        || /[\r\n]/u.test(command)) {
        throw new Error(`Terminal commands must be a single line of 1–${MAX_COMMAND_LENGTH} characters.`);
      }
      const terminal = terminals.get(terminalId);
      if (!terminal || terminal.sessionId !== sessionId) {
        throw new Error('Terminal is no longer running for this conversation.');
      }
      if (terminal.execution) throw new Error('A command is already running in this terminal.');
      if (signal?.aborted) throw new Error('Terminal command was cancelled.');

      const startMarker = `__LW_COMMAND_START_${randomUUID()}__`;
      const endMarker = `__LW_COMMAND_END_${randomUUID()}__`;
      const input = commandInput({ command: command.trim(), startMarker, endMarker });
      if (!input || typeof input.input !== 'string' || !input.input
        || typeof input.startToken !== 'string' || !input.startToken
        || typeof input.endToken !== 'string' || !input.endToken) {
        throw new Error('Terminal command input could not be prepared.');
      }

      return new Promise((resolve, reject) => {
        const execution = {
          terminalId,
          command: command.trim(),
          startToken: input.startToken,
          endToken: input.endToken,
          pending: '',
          output: '',
          started: false,
          displayPending: '',
          resolve,
          reject,
          signal,
          abort: null,
          timeout: null,
        };
        execution.abort = () => {
          finishCommand(terminal, new Error('Terminal command was cancelled.'));
          terminal.process.write('\x03');
        };
        execution.timeout = setTimeout(() => {
          finishCommand(terminal, new Error('Terminal command timed out after 120 seconds.'));
          terminal.process.write('\x03');
        }, COMMAND_TIMEOUT_MS);
        terminal.execution = execution;
        signal?.addEventListener('abort', execution.abort, { once: true });
        onData({ terminalId, sessionId, data: execution.command });
        try {
          terminal.process.write(input.input);
        } catch (error) {
          finishCommand(terminal, error);
        }
      });
    },
    close(rawTerminalId, rawSessionId) {
      const terminalId = validateId(rawTerminalId, 'Terminal ID');
      const sessionId = rawSessionId === undefined
        ? undefined
        : validateId(rawSessionId, 'Conversation ID');
      return closeTerminal(terminalId, sessionId);
    },
    closeSession(rawSessionId) {
      const sessionId = validateId(rawSessionId, 'Conversation ID');
      for (const [terminalId, terminal] of terminals) {
        if (terminal.sessionId === sessionId) closeTerminal(terminalId, sessionId);
      }
    },
    closeAll() {
      for (const terminalId of terminals.keys()) closeTerminal(terminalId);
    },
  });
}
