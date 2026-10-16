import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createRightPanelAgentTools,
  validateRightPanelTabs,
} from './right-panel-tools.mjs';

test('validates bounded right-panel snapshots and keeps browser tabs as live references', () => {
  const tabs = validateRightPanelTabs([
    {
      id: 'trace-session',
      kind: 'trace',
      title: 'Activity',
      selected: true,
      content: 'Opened a web page.',
    },
    {
      id: 'browser-page',
      kind: 'browser',
      title: 'example.com',
      selected: false,
      browserTabId: 'browser-id_1',
    },
  ]);

  assert.deepEqual(tabs, [
    {
      id: 'trace-session',
      kind: 'trace',
      title: 'Activity',
      selected: true,
      content: 'Opened a web page.',
    },
    {
      id: 'browser-page',
      kind: 'browser',
      title: 'example.com',
      selected: false,
      browserTabId: 'browser-id_1',
    },
  ]);
  assert.deepEqual(validateRightPanelTabs(undefined), []);
  assert.throws(() => validateRightPanelTabs([{ ...tabs[0], kind: 'unknown' }]), /invalid tab/u);
  assert.throws(() => validateRightPanelTabs([tabs[0], tabs[0]]), /invalid tab/u);
  assert.throws(() => validateRightPanelTabs([{
    ...tabs[1],
    browserTabId: '../other-session',
  }]), /invalid tab/u);
  assert.throws(() => validateRightPanelTabs([{
    ...tabs[0],
    content: 'x'.repeat(8_001),
  }]), /invalid tab/u);
  assert.throws(() => validateRightPanelTabs([{
    id: 'large-content',
    kind: 'trace',
    title: 'Activity',
    selected: true,
    content: 'x'.repeat(8_000),
  }, {
    id: 'fifth-content',
    kind: 'web-search',
    title: 'Web Search',
    selected: false,
    content: 'x'.repeat(8_000),
  }, {
    id: 'last-content',
    kind: 'terminal',
    title: 'Terminal',
    selected: false,
    content: 'x'.repeat(8_000),
  }, {
    id: 'over-limit',
    kind: 'documents',
    title: 'Files',
    selected: false,
    content: 'x'.repeat(8_000),
  }, {
    id: 'more-content',
    kind: 'trace',
    title: 'Earlier Activity',
    selected: false,
    content: 'x'.repeat(8_000),
  }]), /maximum allowed size/u);
});

test('lists all open tabs and reads their content only when requested', async () => {
  let browserReads = 0;
  const [listTabs, readTab] = createRightPanelAgentTools({
    tabs: validateRightPanelTabs([
      {
        id: 'search-tab',
        kind: 'web-search',
        title: 'Web Search',
        selected: true,
        content: 'Result title\nResult snippet',
      },
      {
        id: 'page-tab',
        kind: 'browser',
        title: 'example.com',
        selected: false,
        browserTabId: 'page-1',
      },
    ]),
    async readBrowserTab(browserTabId) {
      browserReads += 1;
      assert.equal(browserTabId, 'page-1');
      return {
        title: 'Example',
        url: 'https://example.com/',
        text: 'Page text',
        links: [{ title: 'More', url: 'https://example.com/more' }],
        truncated: false,
      };
    },
  });

  assert.equal(listTabs.name, 'list_open_right_panel_tabs');
  assert.equal(readTab.name, 'read_open_right_panel_tab');
  assert.deepEqual(listTabs.execute({}), [
    { id: 'search-tab', kind: 'web-search', title: 'Web Search', selected: true },
    { id: 'page-tab', kind: 'browser', title: 'example.com', selected: false },
  ]);
  assert.equal(browserReads, 0);
  assert.equal(readTab.validate_input({ tab_id: 'missing' }), 'That right-panel tab is not open.');
  assert.match(await readTab.execute({ tab_id: 'search-tab' }), /Result title\nResult snippet/u);
  const browserContent = await readTab.execute({ tab_id: 'page-tab' });
  assert.match(browserContent, /https:\/\/example\.com\//u);
  assert.match(browserContent, /Page text/u);
  assert.match(browserContent, /More: https:\/\/example\.com\/more/u);
  assert.equal(browserReads, 1);
});

test('discovers Browser and Web Search tabs added after the request starts', async () => {
  const tabs = [];
  let liveBrowserTabs = [];
  const [listTabs, readTab] = createRightPanelAgentTools({
    tabs,
    listBrowserTabs: () => liveBrowserTabs,
    async readBrowserTab(browserTabId) {
      assert.equal(browserTabId, 'new-page');
      return {
        title: 'New page',
        url: 'https://example.com/new',
        text: 'Newly opened content',
        links: [],
        truncated: false,
      };
    },
  });

  tabs.push({
    id: 'web-search-session',
    kind: 'web-search',
    title: 'Web Search',
    selected: false,
    content: 'New query results',
  });
  liveBrowserTabs = [{
    id: 'browser-new-page',
    kind: 'browser',
    title: 'example.com',
    selected: false,
    browserTabId: 'new-page',
  }];

  assert.deepEqual(listTabs.execute({}), [
    { id: 'web-search-session', kind: 'web-search', title: 'Web Search', selected: false },
    { id: 'browser-new-page', kind: 'browser', title: 'example.com', selected: false },
  ]);
  assert.equal(readTab.validate_input({ tab_id: 'browser-new-page' }), null);
  assert.match(await readTab.execute({ tab_id: 'browser-new-page' }), /Newly opened content/u);
});

test('limits read output and notes snapshots that were already truncated', async () => {
  const [listTabs, readTab] = createRightPanelAgentTools({
    tabs: validateRightPanelTabs([{
      id: 'terminal',
      kind: 'terminal',
      title: 'Terminal',
      selected: true,
      content: 'x'.repeat(8_000),
      truncated: true,
    }]),
    async readBrowserTab() {
      throw new Error('Browser reader is not used for this tab.');
    },
  });

  assert.equal(listTabs.execute({})[0].id, 'terminal');
  const result = await readTab.execute({ tab_id: 'terminal' });
  assert.ok(result.length <= 8_000);
  assert.match(result, /truncated to fit the available context/u);
});
