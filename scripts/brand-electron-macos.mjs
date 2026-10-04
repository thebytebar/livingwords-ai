import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { access, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

if (process.platform === 'darwin') {
  const require = createRequire(import.meta.url);
  const electronPackage = require.resolve('electron/package.json');
  const dist = join(dirname(electronPackage), 'dist');
  const electronApp = join(dist, 'Electron.app');
  const brandedApp = join(dist, 'LivingWords AI.app');

  const bundleExists = async (path) => access(path).then(() => true, (error) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });

  const [electronAppExists, brandedAppExists] = await Promise.all([
    bundleExists(electronApp),
    bundleExists(brandedApp),
  ]);
  if (electronAppExists && brandedAppExists) await rm(brandedApp, { recursive: true, force: true });
  if (electronAppExists) await rename(electronApp, brandedApp);
  if (!electronAppExists && !brandedAppExists) {
    throw new Error('Could not find Electron’s macOS app bundle to brand.');
  }

  const infoPlist = join(brandedApp, 'Contents', 'Info.plist');

  for (const [key, value] of [
    ['CFBundleName', 'LivingWords AI'],
    ['CFBundleDisplayName', 'LivingWords AI'],
    ['CFBundleIdentifier', 'com.thebytebar.livingwords'],
  ]) {
    execFileSync('plutil', ['-replace', key, '-string', value, infoPlist], {
      stdio: 'inherit',
    });
  }
}
