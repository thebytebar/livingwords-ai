const MAX_CHANGED_LINES = 20_000;
const MAX_CHANGED_CHARACTERS = 400_000;
const CONTEXT_LINES = 3;

export function buildDocumentDiff(oldContent, newContent) {
  if (typeof oldContent !== 'string' || typeof newContent !== 'string') {
    throw new Error('Document diff contents must be text.');
  }
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix
    && oldLines[oldLines.length - suffix - 1] === newLines[newLines.length - suffix - 1]) {
    suffix += 1;
  }
  const removed = oldLines.slice(prefix, oldLines.length - suffix);
  const added = newLines.slice(prefix, newLines.length - suffix);
  const changedCharacters = [...removed, ...added].reduce((sum, line) => sum + line.length, 0);
  if (removed.length + added.length > MAX_CHANGED_LINES || changedCharacters > MAX_CHANGED_CHARACTERS) {
    return { lines: [], previewable: false, unchanged: false };
  }
  if (removed.length === 0 && added.length === 0) {
    return { lines: [{ type: 'context', text: 'No content changes.' }], previewable: true, unchanged: true };
  }

  const lines = [];
  const contextStart = Math.max(0, prefix - CONTEXT_LINES);
  if (contextStart > 0) {
    lines.push({ type: 'context', text: `… ${contextStart} unchanged lines omitted …` });
  }
  for (let index = contextStart; index < prefix; index += 1) {
    lines.push({ type: 'context', text: oldLines[index] });
  }
  for (const text of removed) lines.push({ type: 'removed', text });
  for (const text of added) lines.push({ type: 'added', text });

  const suffixStart = oldLines.length - suffix;
  const contextLimit = Math.min(oldLines.length, suffixStart + CONTEXT_LINES);
  for (let index = suffixStart; index < contextLimit; index += 1) {
    lines.push({ type: 'context', text: oldLines[index] });
  }
  const omittedSuffix = suffix - (contextLimit - suffixStart);
  if (omittedSuffix > 0) {
    lines.push({ type: 'context', text: `… ${omittedSuffix} unchanged lines omitted …` });
  }
  return { lines, previewable: true, unchanged: false };
}
