import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { downloadDesktopModel } from './download-desktop-model.mjs';

test('npm model install download resumes, verifies and atomically saves the artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'livingwords-model-'));
  const destination = join(root, 'model.gguf');
  const modelBytes = Buffer.from('reproducible-local-model-fixture');
  const sha256 = createHash('sha256').update(modelBytes).digest('hex');
  let requests = 0;
  const server = createServer((request, response) => {
    requests += 1;
    const offset = Number(request.headers.range?.match(/^bytes=(\d+)-$/u)?.[1] ?? 0);
    if (offset) {
      response.writeHead(206, {
        'content-range': `bytes ${offset}-${modelBytes.length - 1}/${modelBytes.length}`,
        'content-length': modelBytes.length - offset,
      });
      response.end(modelBytes.subarray(offset));
      return;
    }
    response.writeHead(200);
    response.end(modelBytes.subarray(0, 9));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const fetchImpl = (url, options) => fetch(url, options);
  const artifact = {
    downloadUrl: `http://127.0.0.1:${address.port}/model`,
    size: modelBytes.length,
    sha256,
  };

  try {
    await assert.rejects(
      downloadDesktopModel({ destination, fetchImpl, artifact, extraFreeSpace: 0 }),
      /is incomplete/u,
    );
    assert.equal((await stat(`${destination}.part`)).size, 9);
    const progress = [];
    await downloadDesktopModel({
      destination,
      fetchImpl,
      artifact,
      extraFreeSpace: 0,
      onProgress: (value) => progress.push(value),
    });
    assert.equal(requests, 2);
    assert.deepEqual(await readFile(destination), modelBytes);
    assert.deepEqual(progress, [100]);
    await assert.rejects(stat(`${destination}.part`));
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('desktop model downloader rejects an invalid checksum and removes the corrupted partial', async () => {
  const root = await mkdtemp(join(tmpdir(), 'livingwords-model-checksum-'));
  const destination = join(root, 'model.gguf');
  const modelBytes = Buffer.from('not the expected model');
  const server = createServer((_request, response) => response.end(modelBytes));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  try {
    await assert.rejects(
      downloadDesktopModel({
        destination,
        artifact: {
          downloadUrl: `http://127.0.0.1:${address.port}/model`,
          size: modelBytes.length,
          sha256: '0'.repeat(64),
        },
        extraFreeSpace: 0,
      }),
      /checksum did not match/u,
    );
    await assert.rejects(stat(`${destination}.part`));
    await assert.rejects(stat(destination));
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('desktop model downloader replaces invalid cached bytes with the verified artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'livingwords-model-cache-'));
  const destination = join(root, 'model.gguf');
  await writeFile(destination, 'invalid cached data');
  const modelBytes = Buffer.from('replacement model');
  const sha256 = createHash('sha256').update(modelBytes).digest('hex');
  const server = createServer((_request, response) => response.end(modelBytes));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  try {
    await downloadDesktopModel({
      destination,
      artifact: {
        downloadUrl: `http://127.0.0.1:${address.port}/model`,
        size: modelBytes.length,
        sha256,
      },
      extraFreeSpace: 0,
    });
    assert.deepEqual(await readFile(destination), modelBytes);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
