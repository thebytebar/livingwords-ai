import assert from 'node:assert/strict';
import test from 'node:test';
import { clampSidePanelWidth } from './panel-layout.mjs';

const base = {
  viewportWidth: 1_320,
  mobile: false,
  tablet: false,
  infoOpen: true,
  sessionsWidth: 264,
  infoWidth: 300,
};

test('panel widths stay within configured desktop limits', () => {
  assert.equal(clampSidePanelWidth({ ...base, panel: 'sessions', requestedWidth: 900 }), 420);
  assert.equal(clampSidePanelWidth({ ...base, panel: 'info', requestedWidth: 100 }), 220);
});

test('panel widths preserve minimum chat space when both panels are open', () => {
  assert.equal(clampSidePanelWidth({
    ...base,
    viewportWidth: 900,
    tablet: true,
    panel: 'info',
    requestedWidth: 580,
  }), 238);
  assert.equal(clampSidePanelWidth({
    ...base,
    viewportWidth: 900,
    tablet: true,
    panel: 'sessions',
    requestedWidth: 420,
  }), 202);
});

test('mobile sidebars remain inside the available overlay width', () => {
  assert.equal(clampSidePanelWidth({
    ...base,
    viewportWidth: 600,
    mobile: true,
    panel: 'sessions',
    requestedWidth: 420,
  }), 420);
  assert.equal(clampSidePanelWidth({
    ...base,
    viewportWidth: 600,
    mobile: true,
    panel: 'info',
    requestedWidth: 580,
  }), 468);
});
