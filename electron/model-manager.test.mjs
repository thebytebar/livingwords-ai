import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CONTEXT_WINDOW_PRESETS } from './context-window.mjs';
import { MODEL_FILENAME, MODEL_SIZE } from './model-artifact.mjs';
import { configuredGpuLayers, createModelManager, llamaServerArguments } from './model-manager.mjs';

test('desktop inference defaults to CPU and validates explicit GPU offload', () => {
  assert.equal(configuredGpuLayers(undefined), 0);
  assert.equal(configuredGpuLayers('0'), 0);
  assert.equal(configuredGpuLayers('12'), 12);
  for (const invalid of ['-1', '1.5', '100', 'fast']) {
    assert.throws(() => configuredGpuLayers(invalid), /LW_LLAMA_GPU_LAYERS/u);
  }
});

test('desktop inference disables thinking so the output budget is reserved for the answer', () => {
  const args = llamaServerArguments({
    modelPath: '/models/gemma.gguf',
    modelId: 'gemma',
    host: '127.0.0.1',
    port: 12345,
    gpuLayers: 0,
    threads: 4,
  });
  assert.deepEqual(args.slice(args.indexOf('--ctx-size'), args.indexOf('--ctx-size') + 2), ['--ctx-size', '32768']);
  assert.deepEqual(args.slice(args.indexOf('--reasoning'), args.indexOf('--reasoning') + 2), ['--reasoning', 'off']);
  assert.ok(args.includes('--jinja'));
});

test('desktop inference accepts only supported context window presets', () => {
  for (const { tokens } of CONTEXT_WINDOW_PRESETS) {
    const args = llamaServerArguments({
      modelPath: '/models/gemma.gguf',
      modelId: 'gemma',
      host: '127.0.0.1',
      port: 12345,
      gpuLayers: 0,
      threads: 4,
      contextWindowTokens: tokens,
    });
    assert.deepEqual(args.slice(args.indexOf('--ctx-size'), args.indexOf('--ctx-size') + 2), [
      '--ctx-size',
      String(tokens),
    ]);
  }
  assert.throws(() => llamaServerArguments({
    modelPath: '/models/gemma.gguf',
    modelId: 'gemma',
    host: '127.0.0.1',
    port: 12345,
    gpuLayers: 0,
    threads: 4,
    contextWindowTokens: 24_000,
  }), /supported preset sizes/u);
});

test('desktop runtime uses only the model injected into the app build', async () => {
  const root = await mkdtemp(join(tmpdir(), 'livingwords-bundled-model-'));
  const modelPath = join(root, 'resources', 'models', MODEL_FILENAME);
  const runtimePath = join(root, 'resources', 'llama-server');
  await mkdir(join(root, 'resources', 'models'), { recursive: true });
  const model = await open(modelPath, 'w');
  await model.truncate(MODEL_SIZE);
  await model.close();
  await writeFile(runtimePath, 'test runtime');
  await chmod(runtimePath, 0o755);
  const manager = createModelManager({ modelPath, getRuntimePath: () => runtimePath });

  try {
    const status = await manager.getStatus();
    assert.equal(status.modelReady, true);
    assert.equal(status.runtimeAvailable, true);
    assert.equal(status.setupRequired, false);
    assert.equal(status.assistantReady, false);
    assert.equal(status.assistantStarting, false);
    assert.equal(status.assistantError, null);
    assert.equal('modelName' in status, false);
    assert.equal(status.modelSizeBytes, MODEL_SIZE);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('desktop runtime can be warmed before the first question and reports readiness', async () => {
  const root = await mkdtemp(join(tmpdir(), 'livingwords-runtime-warmup-'));
  const modelPath = join(root, 'model.gguf');
  const runtimePath = join(root, 'llama-server');
  const model = await open(modelPath, 'w');
  await model.truncate(MODEL_SIZE);
  await model.close();
  await writeFile(runtimePath, [
    '#!/usr/bin/env node',
    'const http = require("node:http");',
    'const args = process.argv.slice(2);',
    'const port = Number(args[args.indexOf("--port") + 1]);',
    'const server = http.createServer((_request, response) => {',
    '  response.setHeader("content-type", "application/json");',
    '  response.end(JSON.stringify({ data: [{ id: "test-assistant" }] }));',
    '});',
    'server.listen(port, "127.0.0.1");',
    'process.on("SIGTERM", () => server.close(() => process.exit(0)));',
  ].join('\n'));
  await chmod(runtimePath, 0o755);
  const manager = createModelManager({ modelPath, getRuntimePath: () => runtimePath });
  const activities = [];

  try {
    const endpoint = await manager.ensureReady((activity) => activities.push(activity));
    assert.equal(endpoint.model, 'test-assistant');
    assert.ok(activities.some((activity) => activity.kind === 'ready'));
    const status = await manager.getStatus();
    assert.equal(status.assistantReady, true);
    assert.equal(status.assistantStarting, false);
    await manager.stop();
  } finally {
    await manager.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('desktop runtime restarts with the newly selected context window', async () => {
  const root = await mkdtemp(join(tmpdir(), 'livingwords-runtime-context-change-'));
  const modelPath = join(root, 'model.gguf');
  const runtimePath = join(root, 'llama-server');
  const launchLogPath = join(root, 'launch-contexts.log');
  const model = await open(modelPath, 'w');
  await model.truncate(MODEL_SIZE);
  await model.close();
  await writeFile(runtimePath, [
    '#!/usr/bin/env node',
    'const fs = require("node:fs");',
    'const http = require("node:http");',
    'const args = process.argv.slice(2);',
    `fs.appendFileSync(${JSON.stringify(launchLogPath)}, args[args.indexOf("--ctx-size") + 1] + "\\n");`,
    'const port = Number(args[args.indexOf("--port") + 1]);',
    'const server = http.createServer((_request, response) => {',
    '  response.setHeader("content-type", "application/json");',
    '  response.end(JSON.stringify({ data: [{ id: "test-assistant" }] }));',
    '});',
    'server.listen(port, "127.0.0.1");',
    'process.on("SIGTERM", () => server.close(() => process.exit(0)));',
  ].join('\n'));
  await chmod(runtimePath, 0o755);
  const manager = createModelManager({ modelPath, getRuntimePath: () => runtimePath });

  try {
    const firstEndpoint = await manager.ensureReady(() => {});
    assert.equal(firstEndpoint.contextWindowTokens, 32_768);
    manager.setContextWindowTokens(65_536);
    const restartedEndpoint = await manager.restart(() => {});
    assert.equal(restartedEndpoint.contextWindowTokens, 65_536);
    assert.deepEqual((await readFile(launchLogPath, 'utf8')).trim().split('\n'), ['32768', '65536']);
  } finally {
    await manager.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('desktop runtime reports when the local assistant stops after becoming ready', async () => {
  const root = await mkdtemp(join(tmpdir(), 'livingwords-runtime-exit-'));
  const modelPath = join(root, 'model.gguf');
  const runtimePath = join(root, 'llama-server');
  const model = await open(modelPath, 'w');
  await model.truncate(MODEL_SIZE);
  await model.close();
  await writeFile(runtimePath, [
    '#!/usr/bin/env node',
    'const http = require("node:http");',
    'const args = process.argv.slice(2);',
    'const port = Number(args[args.indexOf("--port") + 1]);',
    'const server = http.createServer((_request, response) => {',
    '  response.setHeader("content-type", "application/json");',
    '  response.end(JSON.stringify({ data: [{ id: "test-assistant" }] }));',
    '});',
    'server.listen(port, "127.0.0.1");',
    'setTimeout(() => process.exit(7), 800);',
  ].join('\n'));
  await chmod(runtimePath, 0o755);
  const manager = createModelManager({ modelPath, getRuntimePath: () => runtimePath });
  const activities = [];

  try {
    await manager.ensureReady((activity) => activities.push(activity));
    await new Promise((resolve) => setTimeout(resolve, 1_000));

    const status = await manager.getStatus();
    assert.equal(status.assistantReady, false);
    assert.match(status.assistantError, /stopped unexpectedly/u);
    assert.ok(activities.some((activity) => activity.kind === 'startup-error'));
  } finally {
    await manager.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('desktop runtime reports when npm did not inject the model into the build', async () => {
  const root = await mkdtemp(join(tmpdir(), 'livingwords-missing-model-'));
  const manager = createModelManager({
    modelPath: join(root, 'missing', MODEL_FILENAME),
    getRuntimePath: () => join(root, 'missing', 'llama-server'),
  });

  try {
    const status = await manager.getStatus();
    assert.equal(status.modelReady, false);
    assert.equal(status.setupRequired, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('desktop development discovers llama-server from PATH', async () => {
  const root = await mkdtemp(join(tmpdir(), 'livingwords-runtime-path-'));
  const modelPath = join(root, 'model.gguf');
  const runtimeDirectory = join(root, 'bin');
  const runtimePath = join(runtimeDirectory, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server');
  await mkdir(runtimeDirectory, { recursive: true });
  const model = await open(modelPath, 'w');
  await model.truncate(MODEL_SIZE);
  await model.close();
  await writeFile(runtimePath, 'test runtime');
  await chmod(runtimePath, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = runtimeDirectory;
  const manager = createModelManager({
    modelPath,
    getRuntimePath: () => join(root, 'sidecar', 'llama-server'),
  });

  try {
    const status = await manager.getStatus();
    assert.equal(status.modelReady, true);
    assert.equal(status.runtimeAvailable, true);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
});
