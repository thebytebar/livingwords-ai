import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, stat, statfs, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { finished } from 'node:stream/promises';
import {
  MODEL_DOWNLOAD_URL,
  MODEL_SHA256,
  MODEL_SIZE,
} from '../electron/model-artifact.mjs';

const EXTRA_FREE_SPACE = 256 * 1024 * 1024;

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function ensureDiskSpace(directory, requiredBytes) {
  const filesystem = await statfs(directory);
  const freeBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
  if (freeBytes < requiredBytes) {
    throw new Error(
      `Not enough free disk space for the desktop model. Need about ${Math.ceil(requiredBytes / 1024 ** 3)} GB free.`,
    );
  }
}

export async function downloadDesktopModel({
  destination,
  fetchImpl = fetch,
  onProgress = () => {},
  extraFreeSpace = EXTRA_FREE_SPACE,
  artifact = {},
}) {
  const model = {
    downloadUrl: artifact.downloadUrl ?? MODEL_DOWNLOAD_URL,
    sha256: artifact.sha256 ?? MODEL_SHA256,
    size: artifact.size ?? MODEL_SIZE,
  };
  const partialPath = `${destination}.part`;
  await mkdir(dirname(destination), { recursive: true });
  try {
    if ((await stat(destination)).size === model.size &&
        await sha256(destination) === model.sha256) {
      return destination;
    }
  } catch {
    // Missing or invalid model: continue with download or resume.
  }

  let offset = 0;
  try {
    offset = (await stat(partialPath)).size;
  } catch {
    offset = 0;
  }
  if (offset > model.size) {
    await unlink(partialPath);
    offset = 0;
  }
  await ensureDiskSpace(dirname(destination), model.size - offset + extraFreeSpace);

  let response = await fetchImpl(model.downloadUrl, {
    headers: offset ? { range: `bytes=${offset}-` } : {},
    redirect: 'follow',
  });
  if (offset && response.status !== 206) {
    await response.body?.cancel();
    await unlink(partialPath);
    offset = 0;
    response = await fetchImpl(model.downloadUrl, { redirect: 'follow' });
  } else if (offset) {
    const range = response.headers.get('content-range');
    if (!range?.startsWith(`bytes ${offset}-`)) {
      await response.body?.cancel();
      throw new Error('Model server returned an invalid byte range; the partial file was retained for retry.');
    }
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`Desktop model download failed with HTTP ${response.status}.`);
  }

  const stream = createWriteStream(partialPath, { flags: offset ? 'a' : 'w' });
  const streamFinished = finished(stream);
  streamFinished.catch(() => {});
  const reader = response.body.getReader();
  let downloaded = offset;
  let lastProgress = -1;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (downloaded + value.byteLength > model.size) {
        throw new Error('Desktop model download exceeded the pinned file size.');
      }
      await new Promise((resolve, reject) => {
        stream.write(Buffer.from(value), (error) => error ? reject(error) : resolve());
      });
      downloaded += value.byteLength;
      const progress = Math.floor((downloaded / model.size) * 100);
      if (progress !== lastProgress) {
        lastProgress = progress;
        onProgress(progress);
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    stream.destroy();
    throw error;
  }
  stream.end();
  await streamFinished;

  const file = await stat(partialPath);
  if (file.size !== model.size) {
    throw new Error(`Desktop model download is incomplete (${file.size} of ${model.size} bytes). Retry to resume.`);
  }
  if (await sha256(partialPath) !== model.sha256) {
    await unlink(partialPath);
    throw new Error('Desktop model checksum did not match the pinned artifact; the partial file was removed.');
  }
  await unlink(destination).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
  });
  await rename(partialPath, destination);
  return destination;
}
