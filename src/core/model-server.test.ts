import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ensureLocalModelServer, stopLocalModelServer } from './model-server.js';

async function startModelListServer(modelId: string): Promise<{
  server: Server;
  baseUrl: string;
  requestCount: () => number;
}> {
  let requests = 0;
  const server = createServer((request, response) => {
    if (request.url === '/v1/models') {
      requests += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: modelId }] }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requestCount: () => requests,
  };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

test('ensureLocalModelServer reuses a compatible OpenAI-style local server', async () => {
  const { server, baseUrl } = await startModelListServer('mlx-community/gemma-4-e2b-it-4bit');
  try {
    assert.equal(
      await ensureLocalModelServer({ baseUrl }),
      'mlx-community/gemma-4-e2b-it-4bit',
    );
  } finally {
    await closeServer(server);
  }
});

test('ensureLocalModelServer returns the actual model identifier exposed by the server', async () => {
  const actualId = '/project/.livingwords/models/gemma-4-e2b-it-4bit';
  const { server, baseUrl } = await startModelListServer(actualId);
  try {
    assert.equal(await ensureLocalModelServer({ baseUrl }), actualId);
  } finally {
    await closeServer(server);
  }
});

test('concurrent startup requests share one readiness check', async () => {
  const { server, baseUrl, requestCount } = await startModelListServer('mlx-community/gemma-4-e2b-it-4bit');
  try {
    await Promise.all([
      ensureLocalModelServer({ baseUrl }),
      ensureLocalModelServer({ baseUrl }),
      ensureLocalModelServer({ baseUrl }),
    ]);
    assert.equal(requestCount(), 1);
  } finally {
    await closeServer(server);
  }
});

test('ensureLocalModelServer reports a model mismatch instead of using a conflicting port', async () => {
  const { server, baseUrl } = await startModelListServer('some-other-model');
  try {
    await assert.rejects(
      ensureLocalModelServer({ baseUrl }),
      /Port is already serving a different model/u,
    );
  } finally {
    await closeServer(server);
  }
});

test('ensureLocalModelServer gives a clear error for an offline configured endpoint', async () => {
  const { server, baseUrl } = await startModelListServer('mlx-community/gemma-4-e2b-it-4bit');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await closeServer(server);

  await assert.rejects(
    ensureLocalModelServer({ baseUrl }),
    /No compatible local model server is responding/u,
  );
});

test('ensureLocalModelServer validates endpoint and model configuration', async () => {
  await assert.rejects(
    ensureLocalModelServer({ baseUrl: 'not-a-url' }),
    /Invalid local model server URL/u,
  );
  await assert.rejects(
    ensureLocalModelServer({ modelId: '   ' }),
    /LW_MODEL must be a non-empty model identifier/u,
  );
});

test('managed server startup uses local model files and can be stopped cleanly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'livingwords-model-server-'));
  const stateDirectory = join(root, '.livingwords');
  const modelDirectory = join(stateDirectory, 'models', 'gemma-4-e2b-it-4bit');
  const fakeServer = join(root, 'fake-mlx-server.mjs');
  const portReservation = createServer();
  try {
    await mkdir(modelDirectory, { recursive: true });
    await writeFile(join(modelDirectory, 'config.json'), '{}', 'utf8');
    await writeFile(join(modelDirectory, 'weights.safetensors'), 'test fixture', 'utf8');
    await mkdir(stateDirectory, { recursive: true });
    await writeFile(join(stateDirectory, 'install.json'), JSON.stringify({
      modelRepo: 'mlx-community/gemma-4-e2b-it-4bit',
      modelRevision: '238767527555cb75a05732a84dff5d6ba0dd6809',
      mlxVlmVersion: '0.7.4',
      platform: 'darwin-arm64',
    }), 'utf8');
    await writeFile(fakeServer, [
      "import { createServer } from 'node:http';",
      "const args = process.argv.slice(2);",
      "const value = (name) => args[args.indexOf(name) + 1];",
      "const model = value('--model');",
      "const port = Number(value('--port'));",
      "createServer((request, response) => {",
      "  if (request.url === '/v1/models') {",
      "    response.writeHead(200, { 'content-type': 'application/json' });",
      "    response.end(JSON.stringify({ data: [{ id: model }] }));",
      "  } else { response.writeHead(404).end(); }",
      "}).listen(port, '127.0.0.1');",
    ].join('\n'), 'utf8');
    await new Promise<void>((resolve, reject) => {
      portReservation.once('error', reject);
      portReservation.listen(0, '127.0.0.1', () => resolve());
    });
    const address = portReservation.address();
    assert.ok(address && typeof address !== 'string');
    await closeServer(portReservation);

    const modelUrl = `http://127.0.0.1:${address.port}/v1`;
    const modelId = await ensureLocalModelServer({
      baseUrl: modelUrl,
      manageServer: true,
      modelDirectory,
      serverExecutable: process.execPath,
      serverCommandPrefix: [fakeServer],
      stateDirectory,
      platform: 'darwin',
      arch: 'arm64',
      startupTimeoutMs: 5000,
    });
    assert.equal(modelId, modelDirectory);

    const response = await fetch(`${modelUrl}/models`);
    assert.equal(response.status, 200);
    await stopLocalModelServer();
    await assert.rejects(fetch(`${modelUrl}/models`));
  } finally {
    if (portReservation.listening) await closeServer(portReservation);
    await stopLocalModelServer();
    await rm(root, { recursive: true, force: true });
  }
});
