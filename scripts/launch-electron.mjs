import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const electronPackage = require.resolve('electron/package.json');
const electronExecutable = process.platform === 'darwin'
  ? join(dirname(electronPackage), 'dist', 'LivingWords AI.app', 'Contents', 'MacOS', 'Electron')
  : require('electron');
const child = spawn(electronExecutable, process.argv.slice(2), {
  stdio: 'inherit',
  windowsHide: false,
});
let childClosed = false;

child.on('error', (error) => {
  console.error(`Could not launch Electron: ${error.message}`);
  process.exitCode = 1;
});
child.on('close', (code, signal) => {
  childClosed = true;
  if (code === null) {
    console.error(`Electron exited with signal ${signal}.`);
    process.exitCode = 1;
  } else {
    process.exitCode = code;
  }
});

for (const signal of ['SIGINT', 'SIGTERM', 'SIGUSR2']) {
  process.on(signal, () => {
    if (!childClosed) child.kill(signal);
  });
}
