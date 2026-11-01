'use strict';

/**
 * Two entries, two switches.
 *
 * DSH loads plugins by module specifier, so the package exposes
 *   dsh-quickdock/service - the Host API
 *   dsh-quickdock/dock    - the windows, attached to that service
 * Each is its own entry in the plugin list, which is the "component switch" the
 * user asked for; index.js still mounts both for a single-entry install.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { config, createContext } = require('./helpers');

const SERVICE = pathToFileURL(path.join(__dirname, '..', '..', 'service.js')).href;
const DOCK = pathToFileURL(path.join(__dirname, '..', '..', 'dock.js')).href;
const INDEX = pathToFileURL(path.join(__dirname, '..', '..', 'index.js')).href;

/** Import one entry and apply it to a fresh mock context. */
async function mountEntry(entry, overrides) {
  const module = await import(entry);
  const { ctx, routes, services } = createContext();
  const app = module.apply(ctx, config(overrides));
  return { module, app, ctx, routes, services };
}

test('entries: each one declares a name and a config schema', async () => {
  for (const entry of [SERVICE, DOCK, INDEX]) {
    const module = await import(entry);
    assert.strictEqual(typeof module.apply, 'function', entry);
    assert.ok(module.Config, 'a config schema is required so DSH can render switches');
  }
});

test('entries: the service declares the services it reads', async () => {
  const service = await import(SERVICE);
  // Reading ctx.webServer/ctx.connection without declaring them fails activation
  // with 'cannot get property "webServer" without inject'.
  assert.deepStrictEqual(service.inject, ['webServer', 'connection']);
});

test('entries: the service mounts the API and no windows', async () => {
  const { app, routes } = await mountEntry(SERVICE, {});
  assert.ok(app, 'the host exists');
  assert.deepStrictEqual(app.state.components, { service: true, dock: false });
  assert.ok(routes.some((row) => row.path === '/quickdock'));
  assert.strictEqual(app.dock, null, 'no supervisor in the service entry');
});

test('entries: the package row mounts the service and stays active', async () => {
  const { app } = await mountEntry(INDEX, {});
  // Active *and* mounting: DSH serves the client bundle (the Dock button) for the
  // row named after the package, and a row that mounted nothing left the Host
  // unregistered at start-up, so the dock only worked after a plugin reload.
  assert.ok(app, 'the package row must mount');
  assert.strictEqual(app.state.components.service, true);
  assert.strictEqual(app.state.components.dock, false, 'the windows are their own row');
});

test('entries: the dock entry attaches to the running service', async () => {
  const shared = await import(pathToFileURL(path.join(__dirname, '..', '..', 'host', 'shared.js')).href);
  const { app: service } = await mountEntry(SERVICE, { dock: true });
  assert.strictEqual(shared.getHost(), service, 'the service published itself');
  const dockModule = await import(DOCK);
  const { ctx } = createContext();
  const mounted = dockModule.apply(ctx, config({}));
  assert.strictEqual(mounted, service, 'the dock mounts on the same host');
  assert.strictEqual(service.state.components.dock, true);
});

test('entries: the dock entry alone warns instead of crashing', async () => {
  const shared = await import(pathToFileURL(path.join(__dirname, '..', '..', 'host', 'shared.js')).href);
  shared.setHost(null);
  const dockModule = await import(DOCK);
  const { ctx } = createContext();
  const warns = [];
  ctx.logger = { warn: (message) => warns.push(message), info: () => {} };
  const mounted = dockModule.apply(ctx, config({}));
  assert.strictEqual(mounted, undefined, 'nothing to attach to');
  assert.ok(warns.some((line) => line.includes('needs dsh-quickdock/service')), 'the reason is logged');
});
