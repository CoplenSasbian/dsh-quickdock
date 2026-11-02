'use strict';

/**
 * Settings changes made in DSH must reach the dock.
 *
 * The function keys (permission / model / reasoning) live on the SESSION: DSH's
 * own UI writes them there, and the dock only keeps a copy for its composer. The
 * dock-to-DSH direction always worked (it applies through the controller), but
 * the other direction did not: the copy was written at bind time and never read
 * again, so the dock showed a stale permission or model.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { config, createContext } = require('./helpers');

const HOST = pathToFileURL(path.join(__dirname, '..', '..', 'host', 'quickdock-host.js')).href;

/**
 * A context whose session carries its own permission and model selection, and
 * whose projection service exposes the change feed the Host subscribes to.
 * @returns {object} the helpers' context plus setters and the captured listeners.
 */
function settingsContext() {
  const base = createContext();
  const listeners = [];
  const session = { id: 's-settings' };
  let permission = 'workspace-write';
  let selection = {
    pending: null,
    lastUsed: { provider: 'deepseek', model: 'a', reasoningEffort: 'low' }
  };
  base.services.sessions.get = (id) => (id === session.id ? session : undefined);
  base.services.permissionPresets.current = () => permission;
  base.services.sessionProjections.stateOf = (_target, key) => (key === 'modelSelection' ? selection : undefined);
  base.services.sessionProjections.onChanged = (listener) => {
    listeners.push(listener);
    return () => {};
  };
  return Object.assign(base, {
    listeners,
    session,
    setPermission: (value) => { permission = value; },
    setSelection: (value) => { selection = value; }
  });
}

test('settings: the host subscribes to the session projection feed', async () => {
  const { QuickDockHost } = await import(HOST);
  const fixture = settingsContext();
  const app = new QuickDockHost(fixture.ctx, config());
  app.start();
  assert.strictEqual(fixture.listeners.length, 1, 'one projection listener');
});

test('settings: a permission and model change made in DSH is adopted', async () => {
  const { QuickDockHost } = await import(HOST);
  const fixture = settingsContext();
  const app = new QuickDockHost(fixture.ctx, config());
  app.start();
  app.state.sessionId = fixture.session.id;
  // What the dock last sent, before DSH changed anything.
  app.state.settings.permission = 'read-only';
  app.state.settings.model = 'deepseek/a';
  app.state.settings.reasoning = 'low';

  fixture.setPermission('danger-full-access');
  fixture.setSelection({
    pending: { provider: 'deepseek', model: 'b', reasoningEffort: 'high' },
    lastUsed: { provider: 'deepseek', model: 'a', reasoningEffort: 'low' }
  });
  fixture.listeners[0](fixture.session, 'modelSelection', null, 7);

  assert.strictEqual(app.state.settings.permission, 'danger-full-access', 'permission follows DSH');
  assert.strictEqual(app.state.settings.model, 'deepseek/b', 'model follows DSH');
  assert.strictEqual(app.state.settings.reasoning, 'high', 'reasoning follows DSH');
});

test('settings: another session\'s change is not adopted', async () => {
  const { QuickDockHost } = await import(HOST);
  const fixture = settingsContext();
  const app = new QuickDockHost(fixture.ctx, config());
  app.start();
  app.state.sessionId = fixture.session.id;
  app.state.settings.permission = 'workspace-write';
  app.state.settings.model = 'deepseek/a';

  fixture.setPermission('custom');
  fixture.setSelection({ pending: { provider: 'other', model: 'z' }, lastUsed: null });
  fixture.listeners[0]({ id: 'someone-else' }, 'modelSelection', null, 9);

  assert.strictEqual(app.state.settings.permission, 'workspace-write', 'the bound session keeps its settings');
  assert.strictEqual(app.state.settings.model, 'deepseek/a');
});
