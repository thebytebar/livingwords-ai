import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createWebResearchAgentTool,
  webResearchQueryFromTask,
} from './web-research.mjs';

function createSearchResults(count) {
  return Array.from({ length: count }, (_, index) => ({
    title: `Result ${index + 1}`,
    url: `https://example.test/article-${index + 1}`,
    snippet: `Snippet ${index + 1}`,
  }));
}

test('one research tool call searches and reads two pages with bounded evidence', async () => {
  const reads = [];
  let published;
  const tool = createWebResearchAgentTool({
    getProvider: () => 'duckduckgo',
    searchImpl: async (query) => {
      assert.equal(query, 'current science news');
      return createSearchResults(3);
    },
    async readPage(url) {
      reads.push(url);
      return {
        url,
        title: `Page ${reads.length}`,
        text: 'Evidence '.repeat(400),
        truncated: true,
      };
    },
    onResults: (results) => { published = results; },
  });

  assert.equal(tool.validate_input({ query: 'current science news' }), null);
  assert.match(tool.validate_input({ query: '' }), /search query/u);
  assert.match(tool.validate_input({ query: 'topic', extra: true }), /Only query/u);
  const result = await tool.execute({ query: 'current science news' });

  assert.equal(published.results.length, 3);
  assert.deepEqual(reads, [
    'https://example.test/article-1',
    'https://example.test/article-2',
  ]);
  assert.equal(result.result_count, 3);
  assert.equal(result.sources.length, 2);
  assert.ok(result.sources.every((source) => source.status === 'read'));
  assert.ok(result.sources.every((source) => source.text.length === 2_200));
  assert.equal(result.additional_results_not_read, 1);
  assert.ok(JSON.stringify(result).length < 8_000);
});

test('individual page-read errors are explicit and do not discard other evidence', async () => {
  const tool = createWebResearchAgentTool({
    getProvider: () => 'duckduckgo',
    searchImpl: async () => createSearchResults(2),
    async readPage(url) {
      if (url.endsWith('1')) throw new Error('The page could not be loaded.');
      return { url, title: 'Readable page', text: 'Verified page text.', truncated: false };
    },
  });

  const result = await tool.execute({ query: 'topic' });

  assert.equal(result.sources[0].status, 'unread');
  assert.equal(result.sources[0].error, 'The page could not be loaded.');
  assert.equal(result.sources[1].status, 'read');
  assert.equal(result.sources[1].text, 'Verified page text.');
});

test('research propagates cancellation rather than returning partial success', async () => {
  const controller = new AbortController();
  let reads = 0;
  const tool = createWebResearchAgentTool({
    getProvider: () => 'duckduckgo',
    searchImpl: async (_query, { signal }) => {
      assert.equal(signal, controller.signal);
      return createSearchResults(2);
    },
    async readPage(_url, { signal }) {
      assert.equal(signal, controller.signal);
      reads += 1;
      controller.abort(new Error('Cancelled by the user.'));
      throw signal.reason;
    },
  });

  await assert.rejects(
    tool.execute({ query: 'topic' }, { signal: controller.signal }),
    /Cancelled by the user/u,
  );
  assert.equal(reads, 1);
});

test('research with no results returns an empty evidence set without reading pages', async () => {
  const tool = createWebResearchAgentTool({
    getProvider: () => 'duckduckgo',
    searchImpl: async () => [],
    async readPage() {
      throw new Error('No page should be read.');
    },
  });

  assert.deepEqual(await tool.execute({ query: 'topic' }), {
    query: 'topic',
    provider: 'duckduckgo',
    result_count: 0,
    sources: [],
    additional_results_not_read: 0,
  });
});

test('research output stays within the agent observation budget at maximum field lengths', async () => {
  const url = `https://example.test/${'u'.repeat(479)}`;
  const tool = createWebResearchAgentTool({
    getProvider: () => 'duckduckgo',
    searchImpl: async () => Array.from({ length: 5 }, () => ({
      title: 't'.repeat(180),
      url,
      snippet: 's'.repeat(500),
    })),
    async readPage(sourceUrl) {
      return {
        url: sourceUrl,
        title: 'p'.repeat(300),
        text: 'e'.repeat(3_000),
        truncated: true,
      };
    },
  });

  const result = await tool.execute({ query: 'q'.repeat(500) });
  assert.ok(JSON.stringify(result).length <= 8_000);
});

test('research query preparation normalizes and bounds long requests', () => {
  assert.equal(webResearchQueryFromTask('  Find current\nscience news  '), 'Find current science news');
  const query = webResearchQueryFromTask(`${'topic '.repeat(100)}tail`);
  assert.ok(query.length <= 500);
  assert.ok(!query.endsWith(' '));
  assert.throws(() => webResearchQueryFromTask('  '), /non-empty task/u);
});
