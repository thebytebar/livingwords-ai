import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { closeSync, existsSync, openSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const DEFAULT_MODEL_BASE_URL = 'http://127.0.0.1:8080/v1';
export const DEFAULT_MODEL_ID = 'mlx-community/gemma-4-e2b-it-4bit';
const DEFAULT_MODEL_REVISION = '238767527555cb75a05732a84dff5d6ba0dd6809';
const DEFAULT_MLX_VLM_VERSION = '0.7.4';
const STARTUP_TIMEOUT_MS = 180_000;
const PROBE_TIMEOUT_MS = 1_500;

interface ModelListResponse {
  data?: Array<{ id?: unknown }>;
}

export interface ModelServerOptions {
  baseUrl?: string;
  modelId?: string;
  modelDirectory?: string;
  serverExecutable?: string;
  serverCommandPrefix?: string[];
  stateDirectory?: string;
  manageServer?: boolean;
  platform?: NodeJS.Platform;
  arch?: string;
  startupTimeoutMs?: number;
}

let managedChild: ChildProcess | null = null;
let startupInProgress: Promise<string> | null = null;
let logDescriptor: number | null = null;
let exitCleanupInstalled = false;

function normalizedBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/u, '');
}

function expectedModelId(modelId: string): string {
  return modelId.split('/').at(-1)!.toLowerCase();
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
}

function isManagedEndpoint(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.protocol === 'http:' &&
      url.port === '8080' &&
      url.pathname.replace(/\/+$/u, '') === '/v1' &&
      isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}

function matchingModelId(data: ModelListResponse, modelId: string): string | undefined {
  const expected = expectedModelId(modelId);
  const match = data.data?.find(({ id }) =>
    typeof id === 'string' && id.toLowerCase().includes(expected)
  );
  return typeof match?.id === 'string' ? match.id : undefined;
}

type ProbeResult =
  | { status: 'ready'; modelId: string }
  | { status: 'offline' }
  | { status: 'conflict'; message: string };

async function probe(baseUrl: string, modelId: string): Promise<ProbeResult> {
  let response: Response;
  try {
    response = await fetch(`${normalizedBaseUrl(baseUrl)}/models`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch {
    return { status: 'offline' };
  }
  if (!response.ok) {
    return {
      status: 'conflict',
      message: `The service at ${baseUrl} responded with HTTP ${response.status}, but does not expose the expected OpenAI-compatible /models endpoint.`,
    };
  }

  let models: ModelListResponse;
  try {
    models = await response.json() as ModelListResponse;
  } catch {
    return { status: 'conflict', message: `The service at ${baseUrl} returned invalid JSON from /models.` };
  }
  if (!Array.isArray(models.data)) {
    return { status: 'conflict', message: `The service at ${baseUrl} did not return an OpenAI-compatible model list.` };
  }
  const matchedId = matchingModelId(models, modelId);
  if (!matchedId) {
    const available = models.data.map(({ id }) => typeof id === 'string' ? id : 'unknown').join(', ') || 'none';
    return {
      status: 'conflict',
      message: `Port is already serving a different model (${available}). Stop that process or set LW_BASE_URL to the intended local server.`,
    };
  }
  return { status: 'ready', modelId: matchedId };
}

function installExitCleanup(): void {
  if (exitCleanupInstalled) return;
  exitCleanupInstalled = true;
  process.once('exit', () => {
    if (managedChild && managedChild.exitCode === null && managedChild.signalCode === null) {
      managedChild.kill('SIGTERM');
    }
    managedChild = null;
    if (logDescriptor !== null) {
      try {
        closeSync(logDescriptor);
      } catch {
        // The descriptor may already have been closed after a spawn failure.
      }
      logDescriptor = null;
    }
  });
}

async function getLogTail(path: string): Promise<string> {
  try {
    const content = await readFile(path, 'utf8');
    return content.slice(-5000).trim();
  } catch {
    return '';
  }
}

async function launchManagedServer(
  baseUrl: string,
  modelId: string,
  modelDirectory: string,
  executable: string,
  commandPrefix: string[],
  stateDirectory: string,
  platform: NodeJS.Platform,
  arch: string,
  startupTimeoutMs: number,
): Promise<string> {
  const url = new URL(baseUrl);
  if (!isLoopbackHostname(url.hostname)) {
    throw new Error(`Refusing to launch a model server on non-loopback host ${url.hostname}.`);
  }
  if (platform !== 'darwin' || arch !== 'arm64') {
    throw new Error(
      'Managed MLX inference requires macOS on Apple Silicon. Use an OpenAI-compatible server on this machine and set LW_BASE_URL.',
    );
  }

  const manifestPath = join(stateDirectory, 'install.json');
  const serverLogPath = join(stateDirectory, 'logs', 'model-server.log');
  const pythonDirectory = join(stateDirectory, 'python');
  const configuredExecutable = executable || join(pythonDirectory, 'bin', 'mlx_vlm.server');
  if (!existsSync(configuredExecutable) || !(await modelIsInstalled(modelDirectory, manifestPath))) {
    throw new Error(
      'The project-local Gemma runtime is not installed. Run `npm install` on macOS Apple Silicon, or set LW_BASE_URL to an existing compatible local server.',
    );
  }

  const current = await probe(baseUrl, modelId);
  if (current.status === 'ready') return current.modelId;
  if (current.status === 'conflict') throw new Error(current.message);

  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid model server port in LW_BASE_URL: ${baseUrl}`);
  }

  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(stateDirectory, 'logs'), { recursive: true });
  logDescriptor = openSync(serverLogPath, 'a');
  console.log(`Starting local Gemma 4 server on ${url.host}; diagnostics: ${serverLogPath}`);
  let child: ChildProcess;
  try {
    const options: SpawnOptions = {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HF_HOME: join(stateDirectory, 'huggingface'),
        HUGGINGFACE_HUB_CACHE: join(stateDirectory, 'huggingface', 'hub'),
        MLX_VLM_CACHE_HOME: join(stateDirectory, 'mlx-vlm'),
      },
      stdio: ['ignore', logDescriptor, logDescriptor],
    };
    child = spawn(configuredExecutable, [...commandPrefix,
      '--model', modelDirectory,
      '--host', '127.0.0.1',
      '--port', String(port),
      '--max-num-seqs', '1',
      '--max-kv-size', '4096',
      '--max-tokens', '512',
    ], options);
  } catch (error) {
    closeSync(logDescriptor);
    logDescriptor = null;
    throw new Error(`Could not start the project-local MLX-VLM server: ${String(error)}`, { cause: error });
  }
  closeSync(logDescriptor);
  logDescriptor = null;
  managedChild = child;
  installExitCleanup();
  child.unref();
  let startupError: string | undefined;
  child.on('error', (error) => {
    startupError = error.message;
    if (managedChild === child) managedChild = null;
  });

  const deadline = Date.now() + startupTimeoutMs;
  while (Date.now() < deadline) {
    if (startupError) {
      const tail = await getLogTail(serverLogPath);
      throw new Error(
        `Could not start the project-local MLX-VLM server: ${startupError}.${tail ? `\n\n${tail}` : ''}`,
      );
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      managedChild = null;
      const tail = await getLogTail(serverLogPath);
      throw new Error(
        `MLX-VLM exited before becoming ready. Check ${serverLogPath}.${tail ? `\n\n${tail}` : ''}`,
      );
    }
    const status = await probe(baseUrl, modelId);
    if (status.status === 'ready') return status.modelId;
    if (status.status === 'conflict') {
      await stopLocalModelServer();
      throw new Error(status.message);
    }
    await delay(500);
  }

  const tail = await getLogTail(serverLogPath);
  await stopLocalModelServer();
  throw new Error(
    `MLX-VLM did not become ready at ${baseUrl} within ${startupTimeoutMs / 1000} seconds. Check ${serverLogPath}.${tail ? `\n\n${tail}` : ''}`,
  );
}

async function modelIsInstalled(modelDirectory: string, manifestPath: string): Promise<boolean> {
  try {
    const [entries, manifestRaw] = await Promise.all([
      readdir(modelDirectory),
      readFile(manifestPath, 'utf8'),
    ]);
    const manifest = JSON.parse(manifestRaw) as {
      modelRepo?: unknown;
      modelRevision?: unknown;
      mlxVlmVersion?: unknown;
      platform?: unknown;
    };
    return entries.includes('config.json') &&
      entries.some((entry) => entry.endsWith('.safetensors')) &&
      manifest.modelRepo === DEFAULT_MODEL_ID &&
      manifest.modelRevision === DEFAULT_MODEL_REVISION &&
      manifest.mlxVlmVersion === DEFAULT_MLX_VLM_VERSION &&
      manifest.platform === 'darwin-arm64';
  } catch {
    return false;
  }
}

export function ensureLocalModelServer(options: ModelServerOptions = {}): Promise<string> {
  if (startupInProgress) return startupInProgress;

  const baseUrl = normalizedBaseUrl(
    options.baseUrl ?? process.env.LW_BASE_URL ?? DEFAULT_MODEL_BASE_URL,
  );
  const modelId = options.modelId ?? process.env.LW_MODEL ?? DEFAULT_MODEL_ID;
  if (!modelId.trim()) {
    return Promise.reject(new Error('LW_MODEL must be a non-empty model identifier.'));
  }
  let parsedBaseUrl: URL;
  try {
    parsedBaseUrl = new URL(baseUrl);
  } catch {
    return Promise.reject(new Error(`Invalid local model server URL: ${baseUrl}`));
  }
  if (!['http:', 'https:'].includes(parsedBaseUrl.protocol) ||
      !parsedBaseUrl.pathname.replace(/\/+$/u, '').endsWith('/v1')) {
    return Promise.reject(new Error(`LW_BASE_URL must be an HTTP(S) OpenAI-compatible base URL ending in /v1: ${baseUrl}`));
  }
  const modelDirectory = resolve(options.modelDirectory ?? process.env.LW_MODEL_PATH ??
    join(process.cwd(), '.livingwords', 'models', 'gemma-4-e2b-it-4bit'));
  const isCustomEndpoint = options.manageServer !== true && !isManagedEndpoint(baseUrl);

  const startup = (async () => {
    const existing = await probe(baseUrl, modelId);
    if (existing.status === 'ready') return existing.modelId;
    if (existing.status === 'conflict') throw new Error(existing.message);

    if (isCustomEndpoint) {
      throw new Error(
        `No compatible local model server is responding at ${baseUrl}. Start that server and verify it exposes GET /v1/models.`,
      );
    }

    return launchManagedServer(
      baseUrl,
      modelId,
      modelDirectory,
      options.serverExecutable ?? '',
      options.serverCommandPrefix ?? [],
      resolve(options.stateDirectory ?? join(process.cwd(), '.livingwords')),
      options.platform ?? process.platform,
      options.arch ?? process.arch,
      options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS,
    );
  })().finally(() => {
    startupInProgress = null;
  });
  startupInProgress = startup;
  return startup;
}

export async function stopLocalModelServer(): Promise<void> {
  const child = managedChild;
  managedChild = null;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;

  const exited = new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()));
  child.kill('SIGTERM');
  await Promise.race([exited, delay(3000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await Promise.race([exited, delay(1000)]);
  }
}
