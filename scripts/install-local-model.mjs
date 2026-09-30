#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(process.env.INIT_CWD ?? packageRoot);
const stateDir = join(root, '.livingwords');
const modelRepo = 'mlx-community/gemma-4-e2b-it-4bit';
const modelRevision = '238767527555cb75a05732a84dff5d6ba0dd6809';
const mlxVlmVersion = '0.7.4';
const modelDir = join(stateDir, 'models', 'gemma-4-e2b-it-4bit');
const environmentDir = join(stateDir, 'python');
const manifestPath = join(stateDir, 'install.json');
const runtimeLockPath = join(stateDir, 'python-requirements.lock.txt');

function log(message) {
  console.log(`[livingwords setup] ${message}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    ...options,
  });
  if (result.error) {
    throw new Error(`Could not run "${command}": ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`"${command} ${args.join(' ')}" failed with exit code ${result.status ?? 'unknown'}`);
  }
}

function pythonVersion(command) {
  const result = spawnSync(command, ['-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.status !== 0 || result.error) return null;
  const match = result.stdout.trim().match(/^(\d+)\.(\d+)$/u);
  if (!match) return null;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  return major === 3 && minor >= 10 && minor <= 12 ? `${major}.${minor}` : null;
}

function findPython() {
  if (process.env.LW_PYTHON) {
    const version = pythonVersion(process.env.LW_PYTHON);
    if (!version) {
      throw new Error(`LW_PYTHON=${process.env.LW_PYTHON} must point to Python 3.10, 3.11, or 3.12.`);
    }
    return process.env.LW_PYTHON;
  }
  for (const candidate of ['python3.12', 'python3.11', 'python3.10', 'python3']) {
    if (pythonVersion(candidate)) return candidate;
  }
  throw new Error(
    'Pinned MLX-VLM setup requires Python 3.10, 3.11, or 3.12. Install Python 3.11 (for example, `brew install python@3.11`) and rerun `npm install`.',
  );
}

async function hasModelFiles() {
  try {
    const entries = await readdir(modelDir);
    return entries.includes('config.json') && entries.some((entry) => entry.endsWith('.safetensors'));
  } catch {
    return false;
  }
}

async function isAlreadyInstalled() {
  if (!(await hasModelFiles())) return false;
  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    return manifest.modelRepo === modelRepo &&
      manifest.modelRevision === modelRevision &&
      manifest.mlxVlmVersion === mlxVlmVersion &&
      manifest.platform === 'darwin-arm64' &&
      existsSync(runtimeLockPath) &&
      existsSync(join(environmentDir, 'bin', 'mlx_vlm.server'));
  } catch {
    return false;
  }
}

function installedMlxVlmVersion(python) {
  const result = spawnSync(python, ['-m', 'pip', 'show', 'mlx-vlm'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.status !== 0 || result.error) return null;
  return result.stdout.match(/^Version:\s*(.+)$/mu)?.[1]?.trim() ?? null;
}

function capture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
  if (result.error) throw new Error(`Could not run "${command}": ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`"${command} ${args.join(' ')}" failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

async function main() {
  if (process.env.LW_SKIP_MODEL_INSTALL === '1') {
    log('Model setup skipped because LW_SKIP_MODEL_INSTALL=1.');
    return;
  }

  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    log(`Skipping MLX model setup on ${process.platform}-${process.arch}; MLX requires Apple Silicon macOS.`);
    log('Install dependencies normally. To run inference, use a local OpenAI-compatible server and set LW_BASE_URL.');
    return;
  }

  if (await isAlreadyInstalled()) {
    log(`Gemma 4 is already installed at ${modelDir}; no model files were downloaded.`);
    return;
  }

  const python = findPython();
  await mkdir(stateDir, { recursive: true });
  await mkdir(join(stateDir, 'huggingface'), { recursive: true });
  await mkdir(dirname(modelDir), { recursive: true });

  const environmentPython = join(environmentDir, 'bin', 'python');
  if (!existsSync(environmentPython)) {
    log(`Creating project-local Python environment with ${python} at ${environmentDir}.`);
    run(python, ['-m', 'venv', environmentDir]);
  }

  const serverExecutable = join(environmentDir, 'bin', 'mlx_vlm.server');
  const hasMatchingRuntimeLock = existsSync(runtimeLockPath) &&
    (await readFile(runtimeLockPath, 'utf8')).split(/\r?\n/u)
      .some((line) => line.toLowerCase() === `mlx-vlm==${mlxVlmVersion}`);
  if (installedMlxVlmVersion(environmentPython) !== mlxVlmVersion || !existsSync(serverExecutable)) {
    if (hasMatchingRuntimeLock) {
      log(`Restoring pinned Python dependencies from ${runtimeLockPath}.`);
      run(environmentPython, ['-m', 'pip', 'install', '-r', runtimeLockPath]);
    } else {
      log(`Installing pinned mlx-vlm==${mlxVlmVersion} into the project-local environment.`);
      run(environmentPython, ['-m', 'pip', 'install', `mlx-vlm==${mlxVlmVersion}`]);
    }
  } else {
    log(`Reusing mlx-vlm==${mlxVlmVersion} in the project-local environment.`);
  }

  if (!hasMatchingRuntimeLock) {
    const versions = capture(environmentPython, ['-m', 'pip', 'freeze'])
      .split(/\r?\n/u)
      .filter(Boolean)
      .sort()
      .join('\n');
    if (!versions.split('\n').some((line) => line.toLowerCase() === `mlx-vlm==${mlxVlmVersion}`)) {
      throw new Error(`The Python environment does not contain the expected mlx-vlm==${mlxVlmVersion}.`);
    }
    await writeFile(runtimeLockPath, `${versions}\n`, 'utf8');
  }

  log(`Downloading ${modelRepo} at revision ${modelRevision} to ${modelDir}.`);
  log('The multi-gigabyte download is stored only under .livingwords/ and is resumable on retry.');
  const downloadScript = [
    'from huggingface_hub import snapshot_download',
    'snapshot_download(',
    `    repo_id=${JSON.stringify(modelRepo)},`,
    `    revision=${JSON.stringify(modelRevision)},`,
    `    local_dir=${JSON.stringify(modelDir)},`,
    ')',
  ].join('\n');
  run(environmentPython, ['-c', downloadScript], {
    env: {
      ...process.env,
      HF_HOME: join(stateDir, 'huggingface'),
      HUGGINGFACE_HUB_CACHE: join(stateDir, 'huggingface', 'hub'),
    },
  });

  if (!(await hasModelFiles())) {
    throw new Error(`Model download completed without config.json and safetensors in ${modelDir}.`);
  }

  const installedVersion = installedMlxVlmVersion(environmentPython);
  if (installedVersion !== mlxVlmVersion) {
    throw new Error(`Expected mlx-vlm ${mlxVlmVersion}, found ${installedVersion ?? 'unknown'}.`);
  }
  if (!existsSync(serverExecutable)) {
    throw new Error(`MLX-VLM server entry point was not installed at ${serverExecutable}.`);
  }

  const manifest = {
    modelRepo,
    modelRevision,
    mlxVlmVersion,
    pythonVersion: pythonVersion(environmentPython),
    platform: 'darwin-arm64',
    installedAt: new Date().toISOString(),
  };
  const tempManifest = `${manifestPath}.tmp`;
  await writeFile(tempManifest, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await rename(tempManifest, manifestPath);
  log('Local Gemma runtime and model are ready. Re-running npm install will reuse them.');
}

main().catch((error) => {
  console.error(`\n[livingwords setup] ${error.message}`);
  console.error('[livingwords setup] Set LW_SKIP_MODEL_INSTALL=1 to install JavaScript dependencies without the model, then follow docs/USAGE.md.');
  process.exitCode = 1;
});
