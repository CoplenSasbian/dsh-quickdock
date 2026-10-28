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
const fs = require('node:fs');
const os = require('node:os');
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
  // No ~/.dsh/electron entry: DSH's own runtime answers --version but dies before
  // 'ready' when hosting a window, so only our download may be offered.
  assert.strictEqual(candidates.length, 2);
});

test('an explicit binary always wins', async () => {
  const resolver = await createResolver({ env: { LOCALAPPDATA: 'C:/Local', DSH_QUICKDOCK_ELECTRON_PATH: 'D:/tools/electron.exe' } });
  assert.strictEqual(resolver.candidates()[0], 'D:/tools/electron.exe');
});

test('a missing npm package does not break the list', async () => {
  const resolver = await createResolver({ requireResolve: () => { throw new Error('not installed') } });
  const candidates = resolver.candidates();
  assert.ok(!candidates.some((entry) => entry.includes('node_modules')));
  assert.strictEqual(candidates.length, 1);
});

test('the version can be overridden through the environment', async () => {
  const resolver = await createResolver({ env: { LOCALAPPDATA: 'C:/Local', DSH_QUICKDOCK_ELECTRON_VERSION: '40.0.0' } });
  assert.ok(resolver.candidates()[0].includes('40.0.0'));
});

test('downloads fall back from the configured mirror to the upstream default', async () => {
  const resolver = await createResolver({ env: { LOCALAPPDATA: 'C:/Local', ELECTRON_MIRROR: 'https://example.com/electron/' } });
  // A blocked mirror must not be the last word: the list ends with @electron/get's
  // own default (GitHub releases), which is reachable where npmmirror is not.
  assert.deepStrictEqual(resolver.mirrors(), [
    'https://example.com/electron/',
    'https://npmmirror.com/mirrors/electron/',
    null
  ]);
});

test('a DSH-managed ~/.dsh/electron is never offered, even at the same version', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-dsh-'));
  fs.mkdirSync(path.join(home, 'electron'));
  fs.writeFileSync(path.join(home, 'electron', 'version'), '44.7.0\n');
  const resolver = await createResolver({ homeDir: home });
  assert.ok(!resolver.candidates().some((entry) => entry.includes('.dsh')));
});

test('without an override the list is the China mirror and then the default', async () => {
  const resolver = await createResolver();
  assert.deepStrictEqual(resolver.mirrors(), ['https://npmmirror.com/mirrors/electron/', null]);
});

test('an override equal to the built-in mirror is not tried twice', async () => {
  const resolver = await createResolver({ env: { LOCALAPPDATA: 'C:/Local', ELECTRON_MIRROR: 'https://npmmirror.com/mirrors/electron/' } });
  assert.deepStrictEqual(resolver.mirrors(), ['https://npmmirror.com/mirrors/electron/', null]);
});
