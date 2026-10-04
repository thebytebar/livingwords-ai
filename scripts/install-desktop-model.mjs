import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadDesktopModel } from './download-desktop-model.mjs';
import { MODEL_FILENAME, MODEL_SIZE } from '../electron/model-artifact.mjs';

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const projectRoot = resolve(process.env.INIT_CWD ?? packageRoot);
const destination = resolve(
  process.env.LW_DESKTOP_MODEL_PATH ??
  resolve(projectRoot, '.livingwords', 'desktop-model', MODEL_FILENAME),
);

if (process.env.LW_SKIP_MODEL_INSTALL === '1') {
  console.log('[livingwords setup] Desktop model download skipped because LW_SKIP_MODEL_INSTALL=1.');
} else {
  console.log(`[livingwords setup] Preparing the desktop Gemma model (${(MODEL_SIZE / 1024 ** 3).toFixed(2)} GiB).`);
  console.log(`[livingwords setup] Destination: ${destination}`);
  console.log('[livingwords setup] The download can resume if interrupted and is SHA-256 verified.');
  try {
    await downloadDesktopModel({
      destination,
      onProgress: (progress) => {
        if (progress % 5 === 0) process.stdout.write(`\r[livingwords setup] Download progress: ${progress}%`);
      },
    });
    process.stdout.write('\n');
    console.log('[livingwords setup] Desktop Gemma model is ready for Electron packaging.');
  } catch (error) {
    console.error(`\n[livingwords setup] ${error.message}`);
    console.error('[livingwords setup] Retry `npm install` to resume the download.');
    process.exitCode = 1;
  }
}
