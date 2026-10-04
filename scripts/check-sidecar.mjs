import { constants } from 'node:fs';
import { createReadStream } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { MODEL_FILENAME, MODEL_SHA256, MODEL_SIZE } from '../electron/model-artifact.mjs';

const platform = process.platform === 'darwin' ? 'mac'
  : process.platform === 'win32' ? 'win'
    : process.platform;
const executable = join(
  process.cwd(),
  'sidecars',
  platform,
  process.arch,
  process.platform === 'win32' ? 'llama-server.exe' : 'llama-server',
);

try {
  await access(executable, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
} catch {
  console.error(
    `Missing the executable llama.cpp runtime for ${platform}-${process.arch}: ${executable}\n` +
    'Build the pinned sidecar as described in docs/DESKTOP.md before packaging.',
  );
  process.exitCode = 1;
}

const modelPath = join(process.cwd(), '.livingwords', 'desktop-model', MODEL_FILENAME);
try {
  const modelStat = await stat(modelPath);
  if (modelStat.size !== MODEL_SIZE) {
    throw new Error(`Expected ${MODEL_SIZE} bytes; found ${modelStat.size}.`);
  }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(modelPath)) hash.update(chunk);
  if (hash.digest('hex') !== MODEL_SHA256) {
    throw new Error('SHA-256 does not match the pinned model artifact.');
  }
} catch (error) {
  console.error(
    `The verified Gemma model is missing or invalid at ${modelPath}: ${error.message}\n` +
    'Run `npm install` or `node scripts/install-desktop-model.mjs` before packaging.',
  );
  process.exitCode = 1;
}
