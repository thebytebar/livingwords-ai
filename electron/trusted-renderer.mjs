import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function isTrustedRendererUrl(frameUrl, rendererPath) {
  if (typeof frameUrl !== 'string') return false;

  try {
    const url = new URL(frameUrl);
    return url.protocol === 'file:'
      && !url.search
      && !url.hash
      && resolve(fileURLToPath(url)) === resolve(rendererPath);
  } catch {
    return false;
  }
}
