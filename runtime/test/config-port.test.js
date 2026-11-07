'use strict';

/**
 * The loopback port is a user setting, not a Loader-row constant.
 *
 * The Host merges config.json over the row over the schema default, so a taken
 * 47910 can be moved from the settings page (or by editing the file) instead of
 * reinstalling. The listener stays off in these tests: the seeded file holds
 * `port: 0`, which also proves a file value wins over the row.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { config, createContext } = require('./helpers');

const CONFIG_FILE = pathToFileURL(path.join(__dirname, '..', '..', 'host', 'config-file.js')).href;
const SERVICE = pathToFileURL(path.join(__dirname, '..', '..', 'service.js')).href;

test('config: the port resolves file over row over default', async () => {
  const { DEFAULT_CONFIG, resolveValue, sanitize } = await import(CONFIG_FILE);
  assert.strictEqual(DEFAULT_CONFIG.port, 47910, 'the documented default');
  assert.strictEqual(resolveValue({}, {}, 'port'), 47910);
  assert.strictEqual(resolveValue({}, { port: 48100 }, 'port'), 48100, 'the row is the deploy-time value');
  assert.strictEqual(resolveValue({ port: 0 }, { port: 48100 }, 'port'), 0, '0 disables, so the file wins');

  assert.strictEqual(sanitize({ port: -5 }).port, 0, 'a negative port clamps to "off"');
  assert.strictEqual(sanitize({ port: 70000 }).port, 65535, 'a port above the range clamps');
  assert.strictEqual(sanitize({ port: 'nope' }).port, undefined, 'a non-number is dropped');
});

test('config: setConfig keeps the stored port and the listener state', async () => {
  const { apply } = await import(SERVICE);
  const { ctx } = createContext();
  const app = apply(ctx, config());
  assert.ok(app, 'the service mounted');
  assert.strictEqual(app.effectiveConfig().port, 0, 'the seeded file wins over the row');
  assert.strictEqual(app.serverPort(), 0);
  assert.deepStrictEqual(app.serverStatus(), { ok: false, serving: false, port: 47910, attempt: 47910, error: '' }, '0 never binds; the advertised default is unchanged');

  const stored = app.setConfig({ port: 0 });
  assert.strictEqual(stored.port, 0, 'the settings page gets the saved value back');
});

test('config: applyPort refuses an out-of-range port instead of binding it', async () => {
  const { apply } = await import(SERVICE);
  const { ctx } = createContext();
  const app = apply(ctx, config());
  const result = await app.applyPort(70000);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error, 'invalid port');
  assert.strictEqual(app.effectiveConfig().port, 0, 'nothing was persisted');
});
