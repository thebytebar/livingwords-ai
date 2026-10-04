import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { isTrustedRendererUrl } from './trusted-renderer.mjs';

test('trusted renderer check accepts the canonical local file URL', () => {
  const rendererPath = join('/app with spaces', 'desktop', 'index.html');

  assert.equal(isTrustedRendererUrl(pathToFileURL(rendererPath).href, rendererPath), true);
});

test('trusted renderer check rejects alternate or remote documents', () => {
  const rendererPath = join('/app', 'desktop', 'index.html');

  for (const frameUrl of [
    undefined,
    'not a URL',
    'https://example.com/desktop/index.html',
    pathToFileURL(join('/app', 'desktop', 'other.html')).href,
    `${pathToFileURL(rendererPath).href}?debug=1`,
    `${pathToFileURL(rendererPath).href}#other-document`,
  ]) {
    assert.equal(isTrustedRendererUrl(frameUrl, rendererPath), false, String(frameUrl));
  }
});
