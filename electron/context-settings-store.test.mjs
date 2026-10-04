import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createContextSettingsStore } from './context-settings-store.mjs';

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
