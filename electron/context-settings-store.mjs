import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  validateContextWindowTokens,
} from './context-window.mjs';
import {
  DEFAULT_WEB_SEARCH_PROVIDER,
  validateWebSearchProvider,
  WEB_SEARCH_PROVIDERS,
} from './web-search.mjs';

export function createContextSettingsStore(filePath) {
  let writeQueue = Promise.resolve();

  async function readSettings() {
    let contents;
    try {
      contents = await readFile(filePath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw new Error(`Could not read local settings: ${error.message}`, { cause: error });
    }
    let settings;
    try {
      settings = JSON.parse(contents);
    } catch (error) {
      throw new Error('The saved settings file is not valid JSON.', { cause: error });
    }
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      throw new Error('The saved settings are invalid.');
    }
    return settings;
  }

  function updateSettings(updates, removedKeys = []) {
    const write = writeQueue.catch(() => {}).then(async () => {
      const settings = { ...(await readSettings() ?? {}) };
      for (const key of removedKeys) delete settings[key];
      Object.assign(settings, updates);
      await mkdir(dirname(filePath), { recursive: true });
      const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporaryPath, `${JSON.stringify(settings)}\n`, {
          encoding: 'utf8',
          mode: 0o600,
        });
        await rename(temporaryPath, filePath);
      } catch (error) {
        throw new Error(`Could not save local settings: ${error.message}`, { cause: error });
      }
    });
    writeQueue = write;
    return write;
  }

  return Object.freeze({
    async load() {
      const settings = await readSettings();
      if (settings === null) return DEFAULT_CONTEXT_WINDOW_TOKENS;
      if (settings.contextWindowTokens === undefined) {
        return DEFAULT_CONTEXT_WINDOW_TOKENS;
      }
      return validateContextWindowTokens(settings.contextWindowTokens);
    },
    save(contextWindowTokens) {
      const value = validateContextWindowTokens(contextWindowTokens);
      return updateSettings({ contextWindowTokens: value });
    },
    async loadWebSearchSettings() {
      const settings = await readSettings();
      if (settings === null) return { provider: DEFAULT_WEB_SEARCH_PROVIDER };
      const provider = WEB_SEARCH_PROVIDERS.some(({ id }) => id === settings.webSearchProvider)
        ? settings.webSearchProvider
        : DEFAULT_WEB_SEARCH_PROVIDER;
      if (provider !== settings.webSearchProvider
        || Object.hasOwn(settings, 'webSearchApiKeys')
        || Object.hasOwn(settings, 'browserSearchUrl')) {
        await updateSettings(
          { webSearchProvider: provider },
          ['webSearchApiKeys', 'browserSearchUrl'],
        );
      }
      return { provider };
    },
    async saveWebSearchSettings({ provider: rawProvider }) {
      const provider = validateWebSearchProvider(rawProvider);
      await updateSettings({ webSearchProvider: provider }, ['webSearchApiKeys', 'browserSearchUrl']);
      return { provider };
    },
  });
}
