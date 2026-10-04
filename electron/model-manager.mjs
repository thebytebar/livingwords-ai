import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import {
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  validateContextWindowTokens,
} from './context-window.mjs';
import { MODEL_FILENAME, MODEL_ID, MODEL_SIZE } from './model-artifact.mjs';

const HOST = '127.0.0.1';

export function configuredGpuLayers(value = process.env.LW_LLAMA_GPU_LAYERS) {
  if (value === undefined || value === '') return 0;
  const layers = Number(value);
  if (!Number.isInteger(layers) || layers < 0 || layers > 99) {
    throw new Error('LW_LLAMA_GPU_LAYERS must be a whole number between 0 and 99.');
  }
  return layers;
}

export function llamaServerArguments({
  modelPath,
  modelId,
  host,
  port,
  gpuLayers,
  threads,
  contextWindowTokens = DEFAULT_CONTEXT_WINDOW_TOKENS,
}) {
  return [
    '--model', modelPath,
    '--alias', modelId,
    '--host', host,
    '--port', String(port),
    '--ctx-size', String(validateContextWindowTokens(contextWindowTokens)),
    '--parallel', '1',
    '--n-gpu-layers', String(gpuLayers),
    '--threads', String(threads),
    '--jinja',
    '--reasoning', 'off',
  ];
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, HOST, resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Could not allocate a local inference port.');
  }
  const { port } = address;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

export function createModelManager({
  modelPath,
  getRuntimePath,
  contextWindowTokens = DEFAULT_CONTEXT_WINDOW_TOKENS,
}) {
  let child = null;
  let endpoint = null;
  let startPromise = null;
  let startupError = null;
  let configuredContextWindowTokens = validateContextWindowTokens(contextWindowTokens);
  let startGeneration = 0;

  async function modelIsBundled() {
    try {
      const file = await stat(modelPath);
      return file.isFile() && file.size === MODEL_SIZE;
    } catch {
      return false;
    }
  }

  async function resolveRuntimePath() {
    const configuredPath = process.env.LW_LLAMA_SERVER;
    const candidates = configuredPath
      ? [configuredPath]
      : [
          getRuntimePath(),
          ...(process.env.PATH ?? '')
            .split(process.platform === 'win32' ? ';' : ':')
            .filter(Boolean)
            .map((directory) => `${directory}/${process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'}`),
        ];
    for (const candidate of candidates) {
      try {
        await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
        return candidate;
      } catch {
        if (configuredPath) {
          throw new Error(`LW_LLAMA_SERVER does not point to an executable llama-server: ${configuredPath}`);
        }
      }
    }
    return null;
  }

  async function getStatus() {
    const modelReady = await modelIsBundled();
    const runtimePath = await resolveRuntimePath();
    return {
      modelReady,
      runtimeAvailable: runtimePath !== null,
      setupRequired: !modelReady || runtimePath === null,
      assistantReady: endpoint !== null,
      assistantStarting: startPromise !== null,
      assistantError: startupError,
      modelSizeBytes: MODEL_SIZE,
      platform: `${process.platform}-${process.arch}`,
    };
  }

  function ensureCurrentStart(generation) {
    if (generation === startGeneration) return;
    const error = new Error('Local inference startup was superseded by a context-window change.');
    error.code = 'MODEL_START_SUPERSEDED';
    throw error;
  }

  async function startRuntime(onActivity) {
    const contextTokens = configuredContextWindowTokens;
    const generation = ++startGeneration;
    if (endpoint) return endpoint;
    startPromise = (async () => {
      startupError = null;
      try {
        if (!(await modelIsBundled())) {
          throw new Error(
            'Local assistant resources are missing from this desktop build. Run `npm install`, then rebuild the Electron app.',
          );
        }
        ensureCurrentStart(generation);
        const runtimePath = await resolveRuntimePath();
        if (!runtimePath) {
          throw new Error(
            `The llama.cpp runtime is missing for ${process.platform}-${process.arch}. ` +
            'For development, install llama.cpp (macOS: `brew install llama.cpp`) or set LW_LLAMA_SERVER to the executable path. ' +
            'Packaged desktop builds include the runtime.',
          );
        }
        ensureCurrentStart(generation);
        const port = await availablePort();
        ensureCurrentStart(generation);
        const baseUrl = `http://${HOST}:${port}/v1`;
        const gpuLayers = configuredGpuLayers();
        onActivity({
          kind: 'model',
          message: gpuLayers === 0
            ? 'Starting the local inference runtime in display-safe CPU mode…'
            : `Starting the local inference runtime with ${gpuLayers} GPU layers…`,
        });
        const threads = Math.max(2, Math.min(8, (await import('node:os')).availableParallelism() - 1));
        ensureCurrentStart(generation);
        child = spawn(runtimePath, llamaServerArguments({
          modelPath,
          modelId: MODEL_ID,
          host: HOST,
          port,
          gpuLayers,
          threads,
          contextWindowTokens: contextTokens,
        }), { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        const runtimeProcess = child;
        let launchError = null;
        let childOutput = '';
        let exitDetails = '';
        const captureOutput = (chunk) => {
          childOutput = `${childOutput}${chunk.toString()}`.slice(-3000);
        };
        runtimeProcess.stdout.on('data', captureOutput);
        runtimeProcess.stderr.on('data', captureOutput);
        runtimeProcess.once('error', (error) => {
          launchError = error;
        });
        runtimeProcess.once('exit', (code, signal) => {
          exitDetails = ` (exit code ${code ?? 'unknown'}${signal ? `, signal ${signal}` : ''})`;
          const wasReady = child === runtimeProcess && endpoint !== null;
          if (child === runtimeProcess) child = null;
          endpoint = null;
          if (wasReady) {
            startupError = `The local inference runtime stopped unexpectedly${exitDetails}.`;
            onActivity({ kind: 'startup-error', message: `Local assistant stopped unexpectedly${exitDetails}.` });
          }
        });
        try {
          const deadline = Date.now() + 180_000;
          while (Date.now() < deadline) {
            ensureCurrentStart(generation);
            if (launchError) throw new Error(`Could not start the local inference runtime: ${launchError.message}`);
            if (exitDetails || child !== runtimeProcess || runtimeProcess.exitCode !== null) {
              throw new Error(
                `The local inference runtime exited before becoming ready${exitDetails}.${childOutput ? `\n${childOutput}` : ''}`,
              );
            }
            try {
              const response = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(1_000) });
              ensureCurrentStart(generation);
              if (response.ok) {
                const payload = await response.json();
                ensureCurrentStart(generation);
                const model = payload?.data?.[0]?.id;
                if (typeof model === 'string') {
                  endpoint = { url: baseUrl, model, contextWindowTokens: contextTokens };
                  onActivity({ kind: 'ready', message: 'Local assistant is ready.' });
                  return endpoint;
                }
              }
            } catch {
              // The process may need several seconds to load the local model.
            }
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
          throw new Error(
            `The local inference runtime did not become ready within 180 seconds.${childOutput ? `\n${childOutput}` : ''}`,
          );
        } catch (error) {
          await stop();
          throw error;
        }
      } catch (error) {
        if (error?.code !== 'MODEL_START_SUPERSEDED') {
          startupError = error instanceof Error ? error.message : String(error);
        }
        throw error;
      }
    })().finally(() => {
      if (startPromise === starting) startPromise = null;
    });
    const starting = startPromise;
    return starting;
  }

  async function ensureReady(onActivity) {
    if (endpoint) return endpoint;
    if (startPromise) return startPromise;
    return startRuntime(onActivity);
  }

  function setContextWindowTokens(value) {
    configuredContextWindowTokens = validateContextWindowTokens(value);
  }

  async function restart(onActivity) {
    const previousStart = startPromise;
    await stop();
    if (previousStart) await previousStart.catch(() => {});
    return ensureReady(onActivity);
  }

  async function stop() {
    startGeneration += 1;
    endpoint = null;
    const process = child;
    child = null;
    if (!process || process.exitCode !== null || process.signalCode !== null) return;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 3_000);
      process.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      process.kill('SIGTERM');
    });
    if (process.exitCode === null && process.signalCode === null) {
      process.kill('SIGKILL');
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 1_000);
        process.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  return { getStatus, ensureReady, setContextWindowTokens, restart, stop };
}
