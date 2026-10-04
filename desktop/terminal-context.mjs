export const MAX_TERMINAL_CONTEXT_LENGTH = 6_000;

export function readTerminalContext(terminal, limit = MAX_TERMINAL_CONTEXT_LENGTH) {
  const buffer = terminal?.buffer?.active;
  if (!buffer || !Number.isInteger(limit) || limit < 1) return '';

  const lines = [];
  const start = Math.max(0, buffer.length - limit);
  for (let index = start; index < buffer.length; index += 1) {
    const line = buffer.getLine(index);
    if (line) lines.push(line.translateToString(true));
  }
  return lines.join('\n').slice(-limit).trim();
}
