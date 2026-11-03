'use strict';

/**
 * Two components, mounted from their own rows.
 *
 *   dsh-quickdock/service - the listener, the shell page and the browser bridge
 *   dsh-quickdock/dock    - the Electron window on top of that service
 *
 * They are mounted from the same Host object but can be enabled separately, so a
 * headless deployment never touches Electron.
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
  const { ctx } = createContext();
  const service = await import(SERVICE);
  const app = service.apply(ctx, config(flags));
  if (flags && flags.dock === true && app) {
    const dock = await import(DOCK);
    dock.apply(ctx, config(flags));
  }
  return { app, ctx };
}

test('components: the service mounts without Electron', async () => {
  const { app } = await mount({});
  assert.ok(app, 'the host object is returned');
  assert.deepStrictEqual(app.state.components, { service: true, dock: false });
  assert.ok(typeof app.handleHttp === 'function', 'the shell page and API are served by the host listener');
  assert.strictEqual(app.dock, null, 'no supervisor in the service component');
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
  assert.ok(app.page, 'the service still renders the shell page');
});

test('components: the package row mounts both components', async () => {
  const { apply } = await import(ROOT);
  const { ctx } = createContext();
  const app = apply(ctx, config({}));
  assert.ok(app, 'the row must mount so the page exists from start-up');
  assert.deepStrictEqual(app.state.components, { service: true, dock: true });
});

test('components: the dock row attaches to the service', async () => {
  const { app } = await mount({ dock: true });
  assert.strictEqual(app.state.components.dock, true);
  assert.ok(app.dockComponent.enabled, 'the window component is mounted');
});
