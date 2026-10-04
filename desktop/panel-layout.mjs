export const SIDE_PANEL_BOUNDS = Object.freeze({
  sessions: { min: 200, max: 420 },
  info: { min: 220, max: 580 },
});

export function clampSidePanelWidth({
  panel,
  requestedWidth,
  viewportWidth,
  mobile,
  tablet,
  infoOpen,
  sessionsWidth,
  infoWidth,
}) {
  const limits = SIDE_PANEL_BOUNDS[panel];
  if (!limits || !Number.isFinite(requestedWidth) || !Number.isFinite(viewportWidth)) {
    throw new TypeError('Panel resize dimensions are invalid.');
  }

  let available;
  if (mobile) {
    available = panel === 'sessions' ? viewportWidth - 56 - 120 : viewportWidth * 0.78;
  } else {
    const railWidth = tablet ? 58 : 62;
    const mainMinimum = tablet ? 340 : 320;
    const otherWidth = panel === 'sessions'
      ? (infoOpen ? infoWidth : 0)
      : sessionsWidth;
    available = viewportWidth - railWidth - mainMinimum - otherWidth;
  }
  return Math.round(Math.max(limits.min, Math.min(limits.max, available, requestedWidth)));
}
