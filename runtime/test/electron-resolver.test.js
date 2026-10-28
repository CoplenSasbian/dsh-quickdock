'use strict';

/**
 * Electron candidate ordering.
 *
 * The self-managed copy under %LOCALAPPDATA% must come first: security software
 * on some Windows machines blocks Electron binaries stored under user folders
 * (Desktop, ~/.dsh), where the process starts but cannot write its profile.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const RESOLVER = pathToFileURL(path.join(__dirname, '..', '..', 'host', 'electron-resolver.js')).href;

async function createResolver(overrides) {
  const { ElectronResolver } = await import(RESOLVER);
  return new ElectronResolver(Object.assign({
    env: { LOCALAPPDATA: 'C:/Local', USERPROFILE: 'C:/Users/test' },
    platform: 'win32',
    homeDir: 'C:/Users/test/.dsh',
    trace: () => {},
    t: (key) => key,
    requireResolve: () => 'C:/app/node_modules/electron/package.json'
  }, overrides || {}));
}

test('the self-managed download is preferred over the npm package', async () => {
  const resolver = await createResolver();
  const candidates = resolver.candidates();
  // Candidate entries are paths (a directory is resolved to its executable later).
  assert.strictEqual(candidates[0], path.join('C:/Local', 'dsh-quickdock', 'electron', resolver.version));
  assert.strictEqual(candidates[1], path.join('C:/app/node_modules/electron/dist', 'electron.exe'));
  assert.strictEqual(candidates[2], path.join('C:/Users/test/.dsh/electron'));
  assert.strictEqual(candidates.length, 3);
});

test('an explicit binary always wins', async () => {
  const resolver = await createResolver({ env: { LOCALAPPDATA: 'C:/Local', DSH_QUICKDOCK_ELECTRON_PATH: 'D:/tools/electron.exe' } });
  assert.strictEqual(resolver.candidates()[0], 'D:/tools/electron.exe');
});

test('a missing npm package does not break the list', async () => {
  const resolver = await createResolver({ requireResolve: () => { throw new Error('not installed') } });
  const candidates = resolver.candidates();
  assert.ok(!candidates.some((entry) => entry.includes('node_modules')));
  assert.strictEqual(candidates.length, 2);
});

test('the version can be overridden through the environment', async () => {
  const resolver = await createResolver({ env: { LOCALAPPDATA: 'C:/Local', DSH_QUICKDOCK_ELECTRON_VERSION: '40.0.0' } });
  assert.ok(resolver.candidates()[0].includes('40.0.0'));
});
