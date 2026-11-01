'use strict';

/**
 * Two components, mounted from their own rows.
 *
 *   quickdock-service - the API (no Electron)
 *   quickdock-dock    - the windows, on top of the service
 *
 * The package row itself mounts nothing; DSH inserts both components through the
 * package's cordis.patch.yml, which is what gives them separate switches.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { config, createContext } = require('./helpers');
const SERVICE = pathToFileURL(path.join(__dirname, '..', '..', 'service.js')).href;
const DOCK = pathToFileURL(path.join(__dirname, '..', '..', 'dock.js')).href;
const ROOT = pathToFileURL(path.join(__dirname, '..', '..', 'index.js')).href;

/** Mount the service, and optionally the dock row on top of it. */
async function mount(flags) {
  const { ctx, routes } = createContext();
  const service = await import(SERVICE);
  const app = service.apply(ctx, config(flags));
  if (flags && flags.dock === true && app) {
    const dock = await import(DOCK);
    dock.apply(ctx, config(flags));
  }
  return { app, ctx, routes };
}

test('components: the service mounts without Electron', async () => {
  const { app, routes } = await mount({});
  assert.ok(app, 'the host object is returned');
  assert.deepStrictEqual(app.state.components, { service: true, dock: false });
  assert.ok(routes.some((row) => row.path === '/quickdock'), 'routes are registered');
  assert.deepStrictEqual(app.meta().components, { service: true, dock: false });
});

test('components: a bind does not summon the windows when the dock row is off', async () => {
  const { app } = await mount({});
  let summoned = 0;
  app.dockComponent.setSupervisor({
    summon: () => { summoned += 1; return true },
    alive: false,
    starting: false,
    resetWindows() {},
    hide() {},
    restart() {},
    notifyAttach() {},
    setContentHeight() {},
    setMenuSpace() {},
    status: () => ({})
  });
  app.postBind({ sessionId: 's-headless' });
  assert.strictEqual(summoned, 0, 'no window was requested');
});

test('components: a headless mount never builds a supervisor', async () => {
  const { app } = await mount({});
  assert.strictEqual(app.dock, null, 'no supervisor');
  assert.strictEqual(app.dockComponent.enabled, false);
  // The page renderer stays: it is plain HTML and the API serves it.
  assert.ok(app.page, 'the service still renders pages');
});

test('components: the package row mounts the service', async () => {
  const { apply } = await import(ROOT);
  const { ctx } = createContext();
  const app = apply(ctx, config({}));
  assert.ok(app, 'the row must mount so the API exists from start-up');
  assert.deepStrictEqual(app.state.components, { service: true, dock: false });
});

test('components: the dock row attaches to the service', async () => {
  const { app } = await mount({ dock: true });
  assert.strictEqual(app.state.components.dock, true);
  assert.ok(app.dockComponent.enabled, 'the window component is mounted');
});
