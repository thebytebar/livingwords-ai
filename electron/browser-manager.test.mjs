import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  createBrowserAgentTools,
  createBrowserManager,
  DEFAULT_BROWSER_SEARCH_URL,
  DUCKDUCKGO_VERIFICATION_REQUIRED_CODE,
  rendererBoundsToParentBounds,
  validateBrowserPageUrl,
  validateBrowserSearchUrl,
} from './browser-manager.mjs';

function mockBrowser({ onLinkNavigation } = {}) {
  const events = [];
  let createCount = 0;
  let stopCount = 0;
  const webContents = new EventEmitter();
  webContents.searchHtml = `
    <html><body>
      <div class="results_links">
        <h2><a class="result__a" href="https://example.test/result">Search result</a></h2>
        <a class="result__snippet">Result snippet</a>
      </div>
      <div class="results_links">
        <h2><a class="result__a" href="http://127.0.0.1/private">Private result</a></h2>
        <a class="result__snippet">Unsafe</a>
      </div>
    </body></html>
  `;
  webContents.session = {
    async fetch() {
      webContents.fetchCount = (webContents.fetchCount ?? 0) + 1;
      throw new Error('Search must use page navigation, not fetch.');
    },
  };
  webContents.setWindowOpenHandler = (handler) => { webContents.windowOpenHandler = handler; };
  webContents.loadURL = async (url) => {
    webContents.url = url;
    webContents.title = 'Loaded page';
  };
  webContents.getURL = () => webContents.url ?? '';
  webContents.getTitle = () => webContents.title ?? '';
  webContents.executeJavaScript = async (script) => script === 'document.body?.outerHTML ?? ""'
    ? webContents.searchHtml
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
    onLinkNavigation,
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
  assert.equal(DEFAULT_BROWSER_SEARCH_URL, 'https://duckduckgo.com/?q={query}');
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

test('closing a browser cancels in-flight navigation without publishing a load error', async () => {
  const { manager, webContents, events } = mockBrowser();
  let rejectLoad;
  webContents.loadURL = () => new Promise((_resolve, reject) => {
    rejectLoad = reject;
  });
  webContents.close = () => {
    rejectLoad?.(new Error("ERR_FAILED (-2) loading 'https://example.test/page'"));
  };

  const navigation = manager.navigate('https://example.test/page');
  manager.close();

  await assert.rejects(navigation, /navigation was cancelled/u);
  assert.equal(events.some((event) => event.type === 'state' && event.state.error), false);
});

test('DuckDuckGo search navigates to its HTML page with GET and extracts bounded results', async () => {
  const { manager, webContents, events } = mockBrowser();
  const results = await manager.searchDuckDuckGo(' private words ');
  assert.deepEqual(results, [{
    title: 'Search result',
    url: 'https://example.test/result',
    snippet: 'Result snippet',
  }]);
  assert.equal(webContents.url, 'https://html.duckduckgo.com/html/?q=private+words');
  assert.equal(webContents.fetchCount ?? 0, 0);
  assert.equal(events.some((event) => event.type === 'activate'), false);
});

test('DuckDuckGo HTML parsing unwraps result redirects from ddgs-style body elements', async () => {
  const { manager, webContents } = mockBrowser();
  webContents.searchHtml = `
    <html><body>
      <div class="body">
        <h2>Search result</h2>
        <a href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.test%2Fresult">Result details</a>
      </div>
    </body></html>
  `;

  assert.deepEqual(await manager.searchDuckDuckGo('query'), [{
    title: 'Search result',
    url: 'https://example.test/result',
    snippet: 'Result details',
  }]);
});

test('DuckDuckGo verification challenges, unreadable pages, and no-results pages are reported correctly', async () => {
  const { manager, webContents } = mockBrowser();
  webContents.searchHtml = '<html><body><form id="challenge-form">Confirm this search was made by a human</form></body></html>';
  await assert.rejects(manager.searchDuckDuckGo('query'), (error) => {
    assert.match(error.message, /human verification/u);
    assert.match(error.message, /Web Search tab/u);
    assert.equal(error.code, DUCKDUCKGO_VERIFICATION_REQUIRED_CODE);
    assert.equal(error.cause?.code, DUCKDUCKGO_VERIFICATION_REQUIRED_CODE);
    return true;
  });
  webContents.searchHtml = '<html><body>Unexpected response</body></html>';
  await assert.rejects(manager.searchDuckDuckGo('query'), /no readable results/u);
  webContents.searchHtml = '<html><body>No results found</body></html>';
  assert.deepEqual(await manager.searchDuckDuckGo('query'), []);
});

test('DuckDuckGo HTML search rejects oversized responses', async () => {
  const { manager, webContents } = mockBrowser();
  webContents.searchHtml = `<html><body>${'x'.repeat(1_000_001)}</body></html>`;
  await assert.rejects(manager.searchDuckDuckGo('query'), /too large/u);
});

test('DuckDuckGo HTML search forwards cancellation to page navigation', async () => {
  const { manager, webContents } = mockBrowser();
  webContents.loadURL = () => new Promise(() => {});
  const controller = new AbortController();
  const search = manager.searchDuckDuckGo('query', { signal: controller.signal });
  controller.abort(new Error('search cancelled'));
  await assert.rejects(search, /search cancelled/u);
});

test('browser navigation refuses non-web, local, and credential-bearing URLs before creating a view', async () => {
  const { manager, createdCount } = mockBrowser();
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'https://user:secret@example.test/']) {
    await assert.rejects(manager.navigate(url), /HTTP or HTTPS/u);
  }
  await assert.rejects(manager.navigate('http://localhost/'), /public web host/u);
  assert.equal(createdCount(), 0);
});

test('browser manager can route web-search page links into separate browser tabs', async () => {
  const openedLinks = [];
  const { manager, webContents } = mockBrowser({
    onLinkNavigation(url, { isRedirect }) {
      openedLinks.push({ url, isRedirect });
      return false;
    },
  });
  await manager.navigate('https://html.duckduckgo.com/html/?q=example');
  let prevented = false;
  webContents.emit('will-navigate', { preventDefault() { prevented = true; } }, 'https://example.test/article');
  assert.equal(prevented, true);
  assert.deepEqual(openedLinks, [{
    url: 'https://example.test/article',
    isRedirect: false,
  }]);

  const openWindowResult = webContents.windowOpenHandler({ url: 'https://example.test/other' });
  assert.deepEqual(openWindowResult, { action: 'deny' });
  assert.equal(openedLinks.at(-1).url, 'https://example.test/other');
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
  assert.match(open.description, /without reading its contents/u);
  assert.match(open.description, /call browser_read_page with the URL directly/u);
  assert.match(read.description, /reads it in the same call/u);
  assert.match(read.description, /do not call browser_open_page first/u);
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
