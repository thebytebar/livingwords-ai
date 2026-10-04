export function terminalThemeFromColors({ background, foreground, accent, accentContrast }) {
  if (![background, foreground, accent, accentContrast]
    .every((color) => typeof color === 'string' && color.trim())) {
    throw new TypeError('Terminal theme colors are invalid.');
  }
  return {
    background: background.trim(),
    foreground: foreground.trim(),
    cursor: accent.trim(),
    cursorAccent: accentContrast.trim(),
    selectionBackground: 'rgba(196, 163, 90, 0.45)',
  };
}
