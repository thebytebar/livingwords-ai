import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  validateContextWindowTokens,
} from './context-window.mjs';

export function createContextSettingsStore(filePath) {
  let writeQueue = Promise.resolve();

  return Object.freeze({
    async load() {
      let contents;
      try {
        contents = await readFile(filePath, 'utf8');
      } catch (error) {
        if (error?.code === 'ENOENT') return DEFAULT_CONTEXT_WINDOW_TOKENS;
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
      return validateContextWindowTokens(settings.contextWindowTokens);
    },
    save(contextWindowTokens) {
      const value = validateContextWindowTokens(contextWindowTokens);
      const write = writeQueue.catch(() => {}).then(async () => {
        await mkdir(dirname(filePath), { recursive: true });
        const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
        try {
          await writeFile(
            temporaryPath,
            `${JSON.stringify({ contextWindowTokens: value })}\n`,
            { encoding: 'utf8', mode: 0o600 },
          );
          await rename(temporaryPath, filePath);
        } catch (error) {
          throw new Error(`Could not save local settings: ${error.message}`, { cause: error });
        }
      });
      writeQueue = write;
      return write;
    },
  });
}
