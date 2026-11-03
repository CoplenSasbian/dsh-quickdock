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

const { config, createContext, invoke } = require('./helpers');

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
  assert.match(page.body, /<iframe src="http:\/\/127\.0\.0\.1:1234\/\?token=test-token&amp;dock=1"/);
  assert.match(page.body, /quickdock:toggle-sidebar/, 'the title bar drives the sidebar over postMessage');
  assert.match(page.body, /data-action="pin"/);
  assert.strictEqual(app.pageUrl(), 'http://127.0.0.1:47910/quickdock?view=frame');
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

test('api: meta describes the remaining contract', async () => {
  const { app, get } = await start();
  const meta = JSON.parse((await get('/quickdock/api/meta')).body);
  assert.strictEqual(meta.apiVersion, 1);
  assert.deepStrictEqual(meta.capabilities, ['dock-target', 'handoff']);
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
