#!/usr/bin/env node

import { chmod, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const compiler = join(root, 'node_modules', 'typescript', 'bin', 'tsc');

await rm(dist, { recursive: true, force: true });
const result = spawnSync(process.execPath, [compiler], { cwd: root, stdio: 'inherit' });
if (result.error) {
  console.error(`Could not run the TypeScript compiler: ${result.error.message}`);
  process.exitCode = 1;
} else if (result.status !== 0) {
  process.exitCode = result.status ?? 1;
} else if (process.platform !== 'win32') {
  await chmod(join(dist, 'cli', 'index.js'), 0o755);
}
