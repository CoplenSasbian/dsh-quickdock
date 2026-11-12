'use strict';

/**
 * The shell page and the two endpoints behind it.
 *
 * The dock window loads the frame shell, which embeds the DSH Web UI - so the
 * only things this Host still owns are the address, the target session, and the
 * reload signal.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { config, createContext, invoke, bridgeCall } = require('./helpers');

const SERVICE = pathToFileURL(path.join(__dirname, '..', '..', 'service.js')).href;

/** Apply the service entry and return the host plus its page/API handler. */
async function start(overrides) {
  const { apply } = await import(SERVICE);
  const { ctx, fetchRoutes, services } = createContext();
  const app = apply(ctx, config(overrides));
  return { app, ctx, fetchRoutes, services, get: (url) => invoke((req, res) => app.handleHttp(req, res), url, {}) };
}

test('shell: the page embeds the Web UI in an iframe', async () => {
  const { app, get } = await start();
  const page = await get('/quickdock');
  assert.strictEqual(page.status, 200);
  assert.match(page.body, /class="qd-frame-bar/);
  assert.match(page.body, /data-qd-view="electron"/);
  assert.match(page.body, /<iframe src="http:\/\/127\.0\.0\.1:1234\/\?token=test-token&amp;dock=1"/);
  assert.match(page.body, /quickdock:toggle-sidebar/, 'the title bar drives the sidebar over postMessage');
  assert.match(page.body, /data-action="pin"/);
  assert.match(app.pageUrl(), /^http:\/\/127\.0\.0\.1:47910\/quickdock\?view=electron&dock=electron-[0-9a-f]+$/);
});

test('shell: view=vscode trims the window chrome and embeds the app proxy', async () => {
  const { app, get } = await start();
  try {
    const page = await get('/quickdock?view=vscode');
    assert.strictEqual(page.status, 200);
    assert.match(page.body, /data-qd-view="vscode"/);
    assert.match(page.body, /qd-frame-bar--editor/);
    assert.doesNotMatch(page.body, /<button[^>]*data-action="pin"/, 'no dead window controls in an editor tab');
    assert.doesNotMatch(page.body, /<button[^>]*data-action="collapse"/);
    assert.doesNotMatch(page.body, /<button[^>]*data-action="close"/);
    assert.ok(app.appProxy, 'the embedded view starts the app proxy');
    assert.match(
      page.body,
      new RegExp('<iframe src="' + app.appProxy.origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/\\?dock=1"')
    );
  } finally {
    app.appProxy?.dispose?.();
    app.appProxy = null;
  }
});

test('shell: the old view=frame URL still renders the desktop window', async () => {
  const { app, get } = await start();
  const page = await get('/quickdock?view=frame');
  assert.strictEqual(page.status, 200);
  assert.match(page.body, /data-qd-view="electron"/);
  assert.match(page.body, /data-action="pin"/);
  assert.doesNotMatch(page.body, /\/\/127\.0\.0\.1:\d+\/\?dock=1/, 'frame keeps the direct app URL');
  assert.strictEqual(app.appProxy, null, 'the desktop view needs no proxy');
});

test('shell: an unknown view is a readable 400', async () => {
  const { get } = await start();
  const page = await get('/quickdock?view=nope');
  assert.strictEqual(page.status, 400);
  assert.match(page.body, /unknown view/);
  assert.match(page.body, /electron/);
});

test('shell: a composition without a Web UI answers 503 instead of a broken page', async () => {
  const { get, services, ctx } = await start();
  delete services.webApp;
  delete ctx.webServer;
  const page = await get('/quickdock');
  assert.strictEqual(page.status, 503);
});

test('api: dock-target reports the bound session and the counters', async () => {
  const { app, get } = await start();
  const first = JSON.parse((await get('/quickdock/api/dock-target')).body);
  assert.deepStrictEqual(first, { sessionId: '', seq: 0, reloadSeq: 0 });

  app.postBind({ sessionId: 's-demo' });
  const bound = JSON.parse((await get('/quickdock/api/dock-target')).body);
  assert.strictEqual(bound.sessionId, 's-demo');
  assert.strictEqual(bound.seq, 1, 'binding bumps the sequence the shell watches');
  assert.strictEqual(app.state.sessionId, 's-demo');

  app.requestDockReload();
  const reloaded = JSON.parse((await get('/quickdock/api/dock-target')).body);
  assert.strictEqual(reloaded.reloadSeq, 1);
});

test('bridge: dock-contexts lists the connected docks', async () => {
  const { app, fetchRoutes } = await start();
  app.postDockContext({ id: 'vscode-1', type: 'vscode' });
  const result = await bridgeCall(fetchRoutes, 'dock-contexts');
  assert.equal(result.ok, true);
  assert.deepEqual(result.docks.map((dock) => dock.id), ['vscode-1']);
  assert.equal(result.docks[0].hasTools, false);
});
test('api: dock contexts register, bind and remove per dock', async () => {
  const { app } = await start();
  const call = (url, body, method) => invoke((req, res) => app.handleHttp(req, res), url, {}, body === undefined ? undefined : JSON.stringify(body), method);
  const json = (result) => JSON.parse(result.body);

  const created = await call('/quickdock/api/dock-context', { id: 'vscode-1', type: 'vscode', workspace: { path: 'C:\\work' } });
  assert.equal(created.status, 200);
  assert.equal(json(created).dock.id, 'vscode-1');

  const listed = json(await call('/quickdock/api/dock-contexts'));
  assert.deepEqual(listed.docks.map((dock) => dock.id), ['vscode-1']);
  assert.equal(listed.docks[0].type, 'vscode');

  const bound = await call('/quickdock/api/bind?dock=vscode-1', { sessionId: 'session-1' });
  assert.equal(bound.status, 200);
  assert.equal(json(bound).dock, 'vscode-1');

  assert.equal(json(await call('/quickdock/api/dock-target?dock=vscode-1')).sessionId, 'session-1');
  // The legacy target is untouched: a dock with an id does not move it.
  assert.equal(json(await call('/quickdock/api/dock-target')).sessionId, '');

  const removed = await call('/quickdock/api/dock-context?id=vscode-1', undefined, 'DELETE');
  assert.equal(removed.status, 200);
  assert.deepEqual(json(await call('/quickdock/api/dock-contexts')).docks, []);
});
test('api: meta describes the remaining contract', async () => {
  const { app, get } = await start();
  const meta = JSON.parse((await get('/quickdock/api/meta')).body);
  assert.strictEqual(meta.apiVersion, 2);
  assert.deepStrictEqual(meta.capabilities, ['dock-target', 'handoff', 'app-proxy', 'mcp-pairing', 'dock-contexts', 'turn-attribution']);
  assert.deepStrictEqual(meta.views, ['electron', 'vscode', 'browser']);
  assert.strictEqual(meta.mcp, null, 'pairing off: there is no watcher to report');
  assert.strictEqual(meta.name, 'dsh-quickdock');
  assert.strictEqual(app.meta().components.service, true);
});

test('api: an unknown path returns a readable 404', async () => {
  const { get } = await start();
  const response = await get('/quickdock/api/nope');
  assert.strictEqual(response.status, 404);
  assert.ok(JSON.parse(response.body).error);
});

test('api: the dock hands a session back to the main window', async () => {
  const { app, get } = await start();
  assert.deepStrictEqual(JSON.parse((await get('/quickdock/api/handoff')).body), { sessionId: '', seq: 0 });

  // The shell writes the request; the main window polls this read side.
  const posted = app.handoffToMain('s-reverse');
  assert.deepStrictEqual(posted, { ok: true, seq: 1 });
  assert.deepStrictEqual(JSON.parse((await get('/quickdock/api/handoff')).body), { sessionId: 's-reverse', seq: 1 });

  app.handoffToMain('s-second');
  assert.strictEqual(JSON.parse((await get('/quickdock/api/handoff')).body).seq, 2);
  assert.deepStrictEqual(app.handoffToMain(''), { ok: false }, 'an empty session is rejected');
});

test('bridge: bind reports the dock status without a running window', async () => {
  const { app } = await start();
  const result = app.postBind({ sessionId: 's-bridge' });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.dockRunning, false);
  assert.deepStrictEqual(app.postBind({}), { ok: false }, 'a bind needs a session id');
});

test('bridge: the theme and locale reported by the Client half stick', async () => {
  const { app } = await start();
  const tokens = {
    '--dsw-alias-bg-base': '#101014',
    '--dsw-alias-bg-layer-1': '#17171b',
    '--dsw-alias-bg-layer-2': '#1d1d22',
    '--dsw-alias-border-l1': '#2a2a30',
    '--dsw-alias-label-primary': '#ededf0',
    '--dsw-alias-label-secondary': '#9a9aa4',
    '--dsw-alias-brand-primary': '#4d8eff'
  };
  assert.strictEqual(app.acceptTheme({ colorScheme: 'dark', tokens }), true);
  assert.strictEqual(app.acceptLocale('zh'), true);
  assert.strictEqual(app.locale.locale, 'zh');
});
