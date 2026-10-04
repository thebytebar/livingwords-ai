import assert from 'node:assert/strict';
import test from 'node:test';
import { terminalThemeFromColors } from './terminal-theme.mjs';

test('terminal theme takes its colors from the selected application theme', () => {
  assert.deepEqual(terminalThemeFromColors({
    background: '#f5f4f0',
    foreground: '#24251f',
    accent: '#c4a35a',
    accentContrast: '#fffdf7',
  }), {
    background: '#f5f4f0',
    foreground: '#24251f',
    cursor: '#c4a35a',
    cursorAccent: '#fffdf7',
    selectionBackground: 'rgba(196, 163, 90, 0.45)',
  });
  assert.deepEqual(terminalThemeFromColors({
    background: '#11120f',
    foreground: '#eeeae1',
    accent: '#c4a35a',
    accentContrast: '#171710',
  }), {
    background: '#11120f',
    foreground: '#eeeae1',
    cursor: '#c4a35a',
    cursorAccent: '#171710',
    selectionBackground: 'rgba(196, 163, 90, 0.45)',
  });
});

test('terminal theme rejects missing colors', () => {
  assert.throws(() => terminalThemeFromColors({
    background: '#000',
    foreground: '',
    accent: '#fff',
    accentContrast: '#000',
  }), /colors are invalid/u);
});
