import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  createBrowserAgentTools,
  createBrowserManager,
  DEFAULT_BROWSER_SEARCH_URL,
  rendererBoundsToParentBounds,
  validateBrowserPageUrl,
  validateBrowserSearchUrl,
} from './browser-manager.mjs';

function mockBrowser() {
  const events = [];
  let createCount = 0;
  let stopCount = 0;
  const webContents = new EventEmitter();
  webContents.setWindowOpenHandler = (handler) => { webContents.windowOpenHandler = handler; };
  webContents.loadURL = async (url) => {
    webContents.url = url;
    webContents.title = 'Loaded page';
  };
  webContents.getURL = () => webContents.url ?? '';
  webContents.getTitle = () => webContents.title ?? '';
  webContents.executeJavaScript = async (script) => script.includes('#challenge-form')
    ? webContents.duckDuckGoResponse
    : ({
    url: webContents.getURL(),
    title: webContents.getTitle(),
    text: 'Page text',
    links: [
      { title: 'Article', url: 'https://example.test/article' },
      { title: 'Local file', url: 'file:///secret' },
      { title: 'Bad URL', url: 'not a URL' },
    ],
  });
  webContents.duckDuckGoResponse = {
    challenge: false,
    noResults: false,
    results: [
      { title: 'Search result', url: 'https://example.test/result', snippet: 'Result snippet' },
      { title: 'Private result', url: 'http://127.0.0.1/private', snippet: 'Unsafe' },
    ],
  };
  webContents.stop = () => { stopCount += 1; };
  webContents.canGoBack = () => false;
  webContents.canGoForward = () => false;
  webContents.close = () => {};
  const view = {
    webContents,
    setBounds(value) { view.bounds = value; },
    setVisible(value) { view.visible = value; },
  };
  const manager = createBrowserManager({
    createView() {
      createCount += 1;
      return view;
    },
    onActivate() { events.push({ type: 'activate' }); },
    onStateChange(state) { events.push({ type: 'state', state }); },
  });
  return {
    manager,
    webContents,
    view,
    events,
    createdCount: () => createCount,
    stoppedCount: () => stopCount,
  };
}

test('search URL requires exactly one query placeholder and uses HTTP(S)', () => {
  assert.equal(validateBrowserSearchUrl(DEFAULT_BROWSER_SEARCH_URL), DEFAULT_BROWSER_SEARCH_URL);
  assert.throws(() => validateBrowserSearchUrl('file:///tmp/search?q={query}'), /HTTP or HTTPS/u);
  assert.throws(() => validateBrowserSearchUrl('https://search.test/'), /exactly one/u);
  assert.throws(() => validateBrowserSearchUrl('https://search.test/?q={query}&x={query}'), /exactly one/u);
  assert.throws(() => validateBrowserSearchUrl('https://127.0.0.1/?q={query}'), /public web host/u);
});

test('browser page URLs reject local and private network destinations', () => {
  for (const url of [
    'http://localhost/',
    'http://printer.local/',
    'http://10.0.0.1/',
    'http://192.168.1.1/',
    'http://[::1]/',
    'http://[::ffff:c0a8:0101]/',
  ]) {
    assert.throws(() => validateBrowserPageUrl(url), /public web host/u, url);
  }
  assert.equal(validateBrowserPageUrl('https://example.com/'), 'https://example.com/');
});

test('browser bounds map renderer CSS pixels into parent-view coordinates', () => {
  assert.deepEqual(
    rendererBoundsToParentBounds(
      { x: 520, y: 140, width: 260, height: 480 },
      { x: 3, y: 28, width: 1600, height: 900 },
      { width: 800, height: 450 },
    ),
    { x: 1043, y: 308, width: 520, height: 960 },
  );
  assert.throws(
    () => rendererBoundsToParentBounds(
      { x: 0, y: 0, width: 100, height: 100 },
      { x: 0, y: 0, width: 800, height: 450 },
      { width: 0, height: 450 },
    ),
    /viewport dimensions are invalid/u,
  );
});

test('browser manager searches, navigates, bounds visible content, and reads safe page links', async () => {
  const { manager, view, events } = mockBrowser();
  manager.setBounds({ x: 4.4, y: 20, width: 400, height: 300 }, false);

  const search = await manager.search('private words', 'https://search.test/?q={query}');
  assert.equal(view.visible, false);
  assert.deepEqual(view.bounds, { x: 4, y: 20, width: 400, height: 300 });
  assert.equal(search.url, 'https://search.test/?q=private%20words');
  assert.equal(search.title, 'Loaded page');
  assert.equal(search.text, 'Page text');
  assert.deepEqual(search.links, [{ title: 'Article', url: 'https://example.test/article' }]);
  assert.ok(events.some((event) => event.type === 'activate'));

  manager.setBounds({ x: 4, y: 20, width: 400, height: 300 }, true);
  assert.equal(view.visible, true);
  assert.deepEqual(await manager.navigate('https://example.test/path'), {
    url: 'https://example.test/path',
    title: 'Loaded page',
  });
  assert.throws(() => manager.setBounds({ x: 0, y: 0, width: -1, height: 0 }, true), /bounds are invalid/u);
  manager.close();
});

test('DuckDuckGo Lite search extracts safe, bounded result records without activating the Browser tab', async () => {
  const { manager, webContents, events } = mockBrowser();
  const results = await manager.searchDuckDuckGoLite('private words');
  assert.deepEqual(results, [{
    title: 'Search result',
    url: 'https://example.test/result',
    snippet: 'Result snippet',
  }]);
  assert.equal(webContents.getURL(), 'https://lite.duckduckgo.com/lite/?q=private%20words');
  assert.equal(events.some((event) => event.type === 'activate'), false);
});

test('DuckDuckGo Lite verification challenges and unreadable pages are reported explicitly', async () => {
  const { manager, webContents } = mockBrowser();
  webContents.duckDuckGoResponse = { challenge: true, noResults: false, results: [] };
  await assert.rejects(manager.searchDuckDuckGoLite('query'), /human verification/u);
  webContents.duckDuckGoResponse = { challenge: false, noResults: false, results: [] };
  await assert.rejects(manager.searchDuckDuckGoLite('query'), /no readable results/u);
  webContents.duckDuckGoResponse = { challenge: false, noResults: true, results: [] };
  assert.deepEqual(await manager.searchDuckDuckGoLite('query'), []);
});

test('DuckDuckGo Lite navigation stops promptly when the agent request is cancelled', async () => {
  const { manager, webContents, stoppedCount } = mockBrowser();
  webContents.loadURL = async (url) => {
    webContents.url = url;
    return new Promise(() => {});
  };
  const controller = new AbortController();
  const search = manager.searchDuckDuckGoLite('query', { signal: controller.signal });
  controller.abort(new Error('search cancelled'));
  await assert.rejects(search, /search cancelled/u);
  assert.equal(stoppedCount(), 1);
});

test('browser navigation refuses non-web, local, and credential-bearing URLs before creating a view', async () => {
  const { manager, createdCount } = mockBrowser();
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'https://user:secret@example.test/']) {
    await assert.rejects(manager.navigate(url), /HTTP or HTTPS/u);
  }
  await assert.rejects(manager.navigate('http://localhost/'), /public web host/u);
  assert.equal(createdCount(), 0);
});

test('browser agent tools give every opened page a separate tab and reuse it for follow-up reads', async () => {
  const activated = [];
  const calls = [];
  let nextTabId = 0;
  const makeBrowser = (browserTabId) => ({
    async search(...args) { calls.push([browserTabId, 'search', ...args]); return { text: 'results' }; },
    async navigate(...args) { calls.push([browserTabId, 'navigate', ...args]); return { url: args[0] }; },
    async readPage() { calls.push([browserTabId, 'read']); return { text: 'current page' }; },
  });
  const browser = makeBrowser('default');
  const createBrowserTab = () => {
    const browserTabId = `page-${++nextTabId}`;
    return { browserTabId, browser: makeBrowser(browserTabId) };
  };
  const [open, read] = createBrowserAgentTools({
    browser,
    createBrowserTab,
    sessionId: 'session-a',
    onActivate: (...args) => activated.push(args),
  });
  assert.equal(open.validate_input({ url: 'file:///etc/passwd' }).includes('HTTP or HTTPS'), true);
  assert.equal(read.validate_input({ unexpected: true }), 'Only a web page URL is supported.');
  assert.equal(read.validate_input({ url: 'file:///etc/passwd' }).includes('HTTP or HTTPS'), true);
  assert.equal(read.validate_input({}), null);
  await open.execute({ url: 'https://example.test' });
  await open.execute({ url: 'https://example.test/second' });
  await read.execute({ url: 'https://example.test/article' });
  await read.execute({});
  assert.deepEqual(activated, [
    ['session-a', 'page-1', 'https://example.test'],
    ['session-a', 'page-2', 'https://example.test/second'],
    ['session-a', 'page-3', 'https://example.test/article'],
    ['session-a', 'page-3', undefined],
  ]);
  assert.deepEqual(calls, [
    ['page-1', 'navigate', 'https://example.test'],
    ['page-2', 'navigate', 'https://example.test/second'],
    ['page-3', 'navigate', 'https://example.test/article', { activate: false }],
    ['page-3', 'read'],
    ['page-3', 'read'],
  ]);
});
