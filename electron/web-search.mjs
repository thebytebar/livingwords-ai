import { validateBrowserPageUrl } from './browser-manager.mjs';

export const DEFAULT_WEB_SEARCH_PROVIDER = 'duckduckgo';
export const WEB_SEARCH_PROVIDERS = Object.freeze([
  { id: 'duckduckgo', name: 'DuckDuckGo Lite' },
]);

const MAX_SEARCH_QUERY_LENGTH = 500;
const MAX_SEARCH_RESULTS = 5;
const MAX_RESULT_TITLE_LENGTH = 180;
const MAX_RESULT_SNIPPET_LENGTH = 500;
const MAX_RESULT_URL_LENGTH = 500;
const PROVIDER_BY_ID = new Map(WEB_SEARCH_PROVIDERS.map((provider) => [provider.id, provider]));

export function validateWebSearchProvider(provider) {
  if (typeof provider !== 'string' || !PROVIDER_BY_ID.has(provider)) {
    throw new Error('Choose a supported web search provider.');
  }
  return provider;
}

function normalizeResult(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)
    || typeof item.url !== 'string' || item.url.length > MAX_RESULT_URL_LENGTH
    || typeof item.title !== 'string') return null;
  let url;
  try {
    url = validateBrowserPageUrl(item.url);
  } catch {
    return null;
  }
  const title = item.title.trim().slice(0, MAX_RESULT_TITLE_LENGTH);
  if (!title) return null;
  return {
    title,
    url,
    snippet: typeof item.snippet === 'string'
      ? item.snippet.trim().slice(0, MAX_RESULT_SNIPPET_LENGTH)
      : '',
  };
}

export async function searchWeb({ query, provider: rawProvider, searchImpl, signal }) {
  if (typeof query !== 'string' || !query.trim() || query.length > MAX_SEARCH_QUERY_LENGTH) {
    throw new Error(`Search query must contain 1–${MAX_SEARCH_QUERY_LENGTH} characters.`);
  }
  const provider = validateWebSearchProvider(rawProvider);
  if (typeof searchImpl !== 'function') {
    throw new TypeError('Web search requires a DuckDuckGo Lite browser integration.');
  }
  if (signal?.aborted) throw signal.reason ?? new Error('Web search was cancelled.');

  const rawResults = await searchImpl(query.trim(), { signal });
  if (signal?.aborted) throw signal.reason ?? new Error('Web search was cancelled.');
  if (!Array.isArray(rawResults)) {
    throw new Error(`${PROVIDER_BY_ID.get(provider).name} returned an invalid search response.`);
  }

  const resultSet = {
    provider,
    query: query.trim(),
    results: rawResults.slice(0, MAX_SEARCH_RESULTS).map(normalizeResult).filter(Boolean),
  };
  return resultSet;
}

export function createWebSearchAgentTool({
  getProvider,
  searchImpl,
  onResults = () => {},
}) {
  if (typeof getProvider !== 'function' || typeof searchImpl !== 'function'
    || typeof onResults !== 'function') {
    throw new TypeError('Web search tool configuration is invalid.');
  }
  return {
    name: 'search_web',
    description: 'Search the public web through DuckDuckGo Lite (lite.duckduckgo.com). Search results are provided by DuckDuckGo; cite result URLs and use open_web_page and read_web_page to verify promising sources.',
    permission: 'allow',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', minLength: 1, maxLength: MAX_SEARCH_QUERY_LENGTH } },
      required: ['query'],
      additionalProperties: false,
    },
    validate_input(args) {
      return !args || typeof args !== 'object' || Array.isArray(args)
        ? 'Arguments must be an object.'
        : Object.keys(args).some((key) => key !== 'query')
          ? 'Only query is supported.'
          : typeof args.query !== 'string' || !args.query.trim()
            || args.query.length > MAX_SEARCH_QUERY_LENGTH
            ? `A search query of 1–${MAX_SEARCH_QUERY_LENGTH} characters is required.`
            : null;
    },
    async execute({ query }, context = {}) {
      const resultSet = await searchWeb({
        query,
        provider: validateWebSearchProvider(getProvider()),
        searchImpl,
        signal: context.signal,
      });
      onResults(resultSet);
      return resultSet;
    },
  };
}
