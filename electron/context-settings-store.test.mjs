import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createContextSettingsStore } from './context-settings-store.mjs';
import { DEFAULT_WEB_SEARCH_PROVIDER } from './web-search.mjs';

test('context settings default to 32K and persist a supported selection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'livingwords-context-settings-'));
  const path = join(root, 'preferences.json');
  const store = createContextSettingsStore(path);

  try {
    assert.equal(await store.load(), 32_768);
    await store.save(65_536);
    assert.equal(await store.load(), 65_536);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { contextWindowTokens: 65_536 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('web search settings default to DuckDuckGo Lite and persist the selected provider', async () => {
  const root = await mkdtemp(join(tmpdir(), 'livingwords-context-settings-'));
  const path = join(root, 'preferences.json');
  const store = createContextSettingsStore(path);

  try {
    assert.deepEqual(await store.loadWebSearchSettings(), { provider: DEFAULT_WEB_SEARCH_PROVIDER });
    assert.deepEqual(await store.saveWebSearchSettings({ provider: 'duckduckgo' }), {
      provider: 'duckduckgo',
    });
    assert.deepEqual(await store.loadWebSearchSettings(), { provider: 'duckduckgo' });
    assert.equal(await store.load(), 32_768);
    const saved = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(saved.webSearchProvider, 'duckduckgo');
    await store.save(65_536);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), {
      contextWindowTokens: 65_536,
      webSearchProvider: 'duckduckgo',
    });
    await assert.rejects(
      store.saveWebSearchSettings({ provider: 'unknown' }),
      /supported web search provider/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('loading web search settings migrates away from old providers and credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'livingwords-context-settings-'));
  const path = join(root, 'preferences.json');
  const store = createContextSettingsStore(path);

  try {
    await writeFile(path, JSON.stringify({
      browserSearchUrl: 'https://custom-search.example/?q={query}',
      webSearchProvider: 'exa',
      webSearchApiKeys: { exa: 'encrypted-key' },
      contextWindowTokens: 32_768,
    }));
    assert.deepEqual(await store.loadWebSearchSettings(), { provider: 'duckduckgo' });
    const migrated = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(migrated.webSearchProvider, 'duckduckgo');
    assert.equal(Object.hasOwn(migrated, 'webSearchApiKeys'), false);
    assert.equal(Object.hasOwn(migrated, 'browserSearchUrl'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('saving web search settings removes obsolete credentials and custom search URLs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'livingwords-context-settings-'));
  const path = join(root, 'preferences.json');
  const store = createContextSettingsStore(path);

  try {
    await writeFile(path, JSON.stringify({
      browserSearchUrl: 'https://custom-search.example/?q={query}',
      webSearchApiKeys: { exa: 'encrypted-key' },
      contextWindowTokens: 32_768,
    }));
    await store.saveWebSearchSettings({ provider: 'duckduckgo' });
    const saved = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(Object.hasOwn(saved, 'browserSearchUrl'), false);
    assert.equal(Object.hasOwn(saved, 'webSearchApiKeys'), false);
    assert.equal(saved.webSearchProvider, 'duckduckgo');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('context settings reject malformed files and unsupported values', async () => {
  const root = await mkdtemp(join(tmpdir(), 'livingwords-context-settings-'));
  const path = join(root, 'preferences.json');
  const store = createContextSettingsStore(path);

  try {
    await writeFile(path, '{');
    await assert.rejects(store.load(), /not valid JSON/u);
    await writeFile(path, JSON.stringify({ contextWindowTokens: 24_000 }));
    await assert.rejects(store.load(), /supported preset sizes/u);
    assert.throws(() => store.save(24_000), /supported preset sizes/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
