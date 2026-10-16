import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createWebSearchAgentTool,
  DEFAULT_WEB_SEARCH_PROVIDER,
  searchWeb,
  validateWebSearchProvider,
  WEB_SEARCH_PROVIDERS,
} from './web-search.mjs';

test('DuckDuckGo Lite is the only configured provider', () => {
  assert.equal(DEFAULT_WEB_SEARCH_PROVIDER, 'duckduckgo');
  assert.deepEqual(WEB_SEARCH_PROVIDERS, [{ id: 'duckduckgo', name: 'DuckDuckGo Lite' }]);
  assert.equal(validateWebSearchProvider('duckduckgo'), 'duckduckgo');
  assert.throws(() => validateWebSearchProvider('exa'), /supported web search provider/u);
});

test('search delegates to DuckDuckGo Lite and normalizes bounded public results', async () => {
  let request;
  const result = await searchWeb({
    query: '  latest science news ',
    provider: 'duckduckgo',
    searchImpl: async (...args) => {
      request = args;
      return [
        {
          title: '  Result  ',
          url: 'https://example.test/article',
          snippet: ' A useful summary ',
        },
        { title: 'Private', url: 'http://127.0.0.1/secret', snippet: 'No' },
      ];
    },
  });

  assert.equal(request[0], 'latest science news');
  assert.deepEqual(result, {
    provider: 'duckduckgo',
    query: 'latest science news',
    results: [{
      title: 'Result',
      url: 'https://example.test/article',
      snippet: 'A useful summary',
    }],
  });
});

test('search rejects malformed queries, invalid search responses, and missing integration', async () => {
  await assert.rejects(
    searchWeb({ query: ' ', provider: 'duckduckgo', searchImpl: async () => [] }),
    /Search query must contain/u,
  );
  await assert.rejects(
    searchWeb({ query: 'query', provider: 'duckduckgo', searchImpl: async () => null }),
    /invalid search response/u,
  );
  await assert.rejects(
    searchWeb({ query: 'query', provider: 'duckduckgo' }),
    /requires a DuckDuckGo Lite browser integration/u,
  );
});

test('search results are capped to five bounded records within the agent observation limit', async () => {
  const result = await searchWeb({
    query: 'q'.repeat(500),
    provider: 'duckduckgo',
    searchImpl: async () => Array.from({ length: 20 }, (_, index) => ({
      title: `t${index}`.padEnd(300, 't'),
      url: `https://example.test/${'u'.repeat(400)}`,
      snippet: 's'.repeat(2_000),
    })),
  });
  assert.equal(result.results.length, 5);
  assert.ok(result.results.every((item) =>
    item.title.length <= 180 && item.url.length <= 500 && item.snippet.length <= 500));
  assert.ok(JSON.stringify(result).length <= 8_000);
});

test('search agent tool publishes DuckDuckGo results and forwards cancellation', async () => {
  let published;
  let forwardedSignal;
  const tool = createWebSearchAgentTool({
    getProvider: () => 'duckduckgo',
    searchImpl: async (_query, { signal }) => {
      forwardedSignal = signal;
      return [{ title: 'Result', url: 'https://example.test', snippet: 'Snippet' }];
    },
    onResults: (resultSet) => { published = resultSet; },
  });
  assert.equal(tool.validate_input({ query: 'weather' }), null);
  assert.match(tool.validate_input({ query: '' }), /search query/u);
  const controller = new AbortController();
  const result = await tool.execute({ query: 'weather' }, { signal: controller.signal });
  assert.deepEqual(published, result);
  assert.equal(forwardedSignal, controller.signal);
  assert.equal(result.results[0].url, 'https://example.test/');
});
