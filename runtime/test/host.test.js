'use strict';

/**
 * Host-half smoke tests: apply() wiring, page/API authorization, theme adoption
 * and approval delegation.
 *
 * No dock process is started (that needs a real Electron). End-to-end checks
 * (spawn -> ready -> control channel) run through scripts/dev-harness.mjs.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { INDEX, bridgeCall, config, createContext, invoke, pageUrl } = require('./helpers');

const HOST = pathToFileURL(path.join(__dirname, '..', '..', 'host', 'quickdock-host.js')).href;

async function tokenOf(fetchRoutes) {
  return new URL(await pageUrl(fetchRoutes)).searchParams.get('t');
}

test('apply() wires the page and API routes', async () => {
  const { apply } = await import(INDEX);
  const { ctx, routes, fetchRoutes } = createContext();
  apply(ctx, config());
  assert.ok(routes.some((route) => route.path === '/quickdock'), 'the /quickdock page route must be registered');
  assert.ok(fetchRoutes.has('/api/quickdock'), 'the browser bridge route must be registered');
});

test('page: correct token returns HTML, wrong token returns 403', async () => {
  const { apply } = await import(INDEX);
  const { ctx, routes, fetchRoutes } = createContext();
  apply(ctx, config());
  const handler = routes.find((route) => route.path === '/quickdock').handler;

  const token = await tokenOf(fetchRoutes);
  assert.ok(token && token.length > 20, 'the page URL must carry a token');

  const okPage = await invoke(handler, '/quickdock?t=' + token, {});
  assert.strictEqual(okPage.status, 200);
  assert.match(okPage.body, /QuickDock/);
  assert.match(okPage.body, /--qd-bg-base/, 'the page must inline theme variables');

  const denied = await invoke(handler, '/quickdock?t=wrong', {});
  assert.strictEqual(denied.status, 403);
});

test('api: missing token returns 401, token returns state', async () => {
  const { apply } = await import(INDEX);
  const { ctx, routes, fetchRoutes } = createContext();
  apply(ctx, config());
  const handler = routes.find((route) => route.path === '/quickdock').handler;

  const unauthorized = await invoke(handler, '/quickdock/api/state', {});
  assert.strictEqual(unauthorized.status, 401);

  const token = await tokenOf(fetchRoutes);
  const authorized = await invoke(handler, '/quickdock/api/state?t=' + token, {});
  assert.strictEqual(authorized.status, 200);
  const state = JSON.parse(authorized.body);
  assert.strictEqual(state.sessionId, null);
  assert.strictEqual(state.status, 'idle');
  assert.ok(Array.isArray(state.catalogs.permissions), 'the permission catalog must be an array');
});

test('api: failures return readable JSON (not an empty 400)', async () => {
  const { apply } = await import(INDEX);
  const { ctx, routes, fetchRoutes } = createContext();
  apply(ctx, config());
  const handler = routes.find((route) => route.path === '/quickdock').handler;
  const token = await tokenOf(fetchRoutes);

  const response = await invoke(handler, '/quickdock/api/task?t=' + token, {
    authorization: 'Bearer ' + token
  }, JSON.stringify({ text: '' }));
  assert.strictEqual(response.status, 400);
  const body = JSON.parse(response.body);
  assert.strictEqual(body.ok, false);
  assert.ok(body.error && body.error.length > 0, 'an error response must carry a reason');
});

test('theme: at least six known tokens are required', async () => {
  const { apply } = await import(INDEX);
  const { ctx, routes, fetchRoutes } = createContext();
  apply(ctx, config());
  const handler = routes.find((route) => route.path === '/quickdock').handler;

  assert.strictEqual((await bridgeCall(fetchRoutes, 'theme', {
    theme: { tokens: { '--dsw-alias-bg-base': '#000' } }
  })).ok, false, 'too few tokens must be rejected');

  const accepted = await bridgeCall(fetchRoutes, 'theme', {
    theme: {
      colorScheme: 'light',
      tokens: {
        '--dsw-alias-bg-base': '#ffffff',
        '--dsw-alias-bg-layer-1': '#f6f7f8',
        '--dsw-alias-bg-layer-2': '#f0f1f3',
        '--dsw-alias-border-l1': '#e3e4e6',
        '--dsw-alias-label-primary': '#1c1c1e',
        '--dsw-alias-label-secondary': '#5f6066',
        '--dsw-alias-brand-primary': '#2b6cf6'
      }
    }
  });
  assert.strictEqual(accepted.ok, true);

  // Once accepted, the page carries the scheme and the mapped --qd-* variables.
  const token = await tokenOf(fetchRoutes);
  const page = await invoke(handler, '/quickdock?t=' + token, {});
  assert.match(page.body, /data-theme="light"/);
  assert.match(page.body, /--qd-bg-base: #ffffff/);
});

test('approval listeners must prepend (DSH registers its own first)', async () => {
  const { apply } = await import(INDEX);
  const { ctx, events, listenerOptions } = createContext();
  apply(ctx, config());
  for (const name of ['approval/request', 'user-questions/request']) {
    const listeners = events.get(name) || [];
    assert.ok(listeners.length >= 1, name + ' must have a listener');
    const options = listenerOptions.get(name) || [];
    assert.ok(options[0] && options[0].prepend === true,
      name + ' must prepend: in the waterfall DSH registers first, so the dock would never see it');
  }
});

test('a claimed approval falls back to DSH when the dock hides', async () => {
  const { QuickDockHost } = await import(HOST);
  const { ctx, events } = createContext();
  const app = new QuickDockHost(ctx, config());
  app.start();
  app.state.sessionId = 's-demo';
  app.state.newSession = false;
  app.dock.state.dock.running = true;
  app.dock.state.dock.visible = true;
  app.dock.summon = () => {};

  const handler = (events.get('approval/request') || [])[0];
  assert.ok(handler, 'an approval/request listener must exist');
  let delegated = 0;
  const pending = handler(
    { agent: { id: 's-demo' }, toolName: 'bash', reason: 'escalate sandbox' },
    () => {
      delegated += 1;
      return Promise.resolve('allowed-once');
    }
  );
  assert.strictEqual(app.state.interaction.kind, 'approval', 'the dock owns a visible request');

  // The user closes the dock while the approval is on screen: no dialog may be lost.
  app.dock.onStatus({ type: 'hidden' });

  assert.strictEqual(await pending, 'allowed-once', 'the request is handed to the next listener');
  assert.strictEqual(delegated, 1, "DSH's own dialog takes over");
  assert.strictEqual(app.state.interaction, null);
});

test('client API: switching is backend-only and every turn stays readable', async () => {
  const { QuickDockHost } = await import(HOST);
  const { ctx, events, routes, fetchRoutes, services } = createContext();
  services.workspaceRegistry.list = () => [
    { id: 'ws-demo', title: 'Demo', path: 'C:/demo', sessionIds: ['s-demo'] }
  ];
  services.sessions.get = (id) => (id === 's-demo' ? { id: 's-demo' } : undefined);
  services.sessionProjections.snapshot = () => ({
    values: {
      turnOutline: [
        { turn: 1, seq: 1, prompt: 'first prompt', response: 'done one' },
        { turn: 2, seq: 10, prompt: 'second prompt', response: '' }
      ]
    }
  });
  const app = new QuickDockHost(ctx, config());
  app.start();
  app.state.sessionId = 's-demo';
  app.state.workspaceId = 'ws-demo';
  app.state.newSession = false;

  // Two turns of the same session, folded from the live event feed.
  const onEvent = (events.get('session/event') || [])[0];
  const session = { id: 's-demo' };
  onEvent(session, { type: 'turn/start', seq: 1, data: { turn: 1 }, time: '2026-10-28T10:00:00.000Z' });
  onEvent(session, { type: 'tool/call', seq: 2, data: { callId: 'c1', name: 'read_file', arguments: '{"path":"a"}' } });
  onEvent(session, { type: 'turn/end', seq: 3, data: { turn: 1 }, time: '2026-10-28T10:00:05.000Z' });
  onEvent(session, { type: 'turn/start', seq: 10, data: { turn: 2 }, time: '2026-10-28T10:01:00.000Z' });
  onEvent(session, { type: 'tool/call', seq: 11, data: { callId: 'c2', name: 'bash', arguments: '{"command":"ls"}' } });

  const handler = routes.find((route) => route.path === '/quickdock').handler;
  const token = await tokenOf(fetchRoutes);
  const get = async (path) => {
    const url = '/quickdock/api/' + path + (path.includes('?') ? '&' : '?') + 't=' + token;
    return JSON.parse((await invoke(handler, url, {})).body);
  };
  const post = async (path, body) => {
    const url = '/quickdock/api/' + path + '?t=' + token;
    return JSON.parse((await invoke(handler, url, { authorization: 'Bearer ' + token }, JSON.stringify(body))).body);
  };

  const meta = await get('meta');
  assert.strictEqual(meta.apiVersion, 1);
  assert.ok(meta.capabilities.includes('turns'), 'turn history is part of the contract');

  const spaces = await get('workspaces');
  assert.strictEqual(spaces.workspaceId, 'ws-demo');
  assert.deepStrictEqual(spaces.workspaces.map((row) => row.id), ['ws-demo']);

  const sessions = await get('sessions?workspaceId=ws-demo');
  assert.deepStrictEqual(sessions.sessions.map((row) => row.sessionId), ['s-demo']);
  assert.ok(sessions.sessions[0].title, 'a session entry always carries a title');

  const state = await get('state');
  assert.deepStrictEqual(state.turn, { number: 2, count: 2 }, 'the dock still receives the newest turn');
  assert.deepStrictEqual(state.steps.map((row) => row.id), ['tool-c2']);

  const turns = await get('turns?sessionId=s-demo');
  assert.strictEqual(turns.outline, true);
  assert.deepStrictEqual(turns.turns.map((row) => row.turn), [1, 2]);
  assert.deepStrictEqual(turns.turns.map((row) => row.rows), [1, 1]);
  assert.strictEqual(turns.turns[0].prompt, 'first prompt');

  const first = await get('turn?turn=1');
  assert.strictEqual(first.observed, true);
  assert.deepStrictEqual(first.steps.map((row) => row.id), ['tool-c1']);
  const latest = await get('turn');
  assert.strictEqual(latest.turn, 2, 'omitting turn reads the newest one');
  assert.strictEqual((await get('turn?turn=99')).observed, false);

  // Switching workspaces/sessions is an API capability; the dock UI never calls it.
  const selected = await post('select', { workspaceId: 'ws-other', sessionId: 's-other' });
  assert.strictEqual(selected.ok, true);
  assert.strictEqual(app.state.workspaceId, 'ws-other');
  assert.strictEqual(app.state.sessionId, 's-other');
});

test('POST task binds a client-named session and keeps earlier turns', async () => {
  const { QuickDockHost } = await import(HOST);
  const { ctx, routes, fetchRoutes } = createContext();
  const app = new QuickDockHost(ctx, config());
  app.start();
  app.state.sessionId = 's-bound';
  app.state.newSession = false;

  const handler = routes.find((route) => route.path === '/quickdock').handler;
  const token = await tokenOf(fetchRoutes);
  const response = await invoke(
    handler,
    '/quickdock/api/task?t=' + token,
    { authorization: 'Bearer ' + token },
    JSON.stringify({ text: 'next prompt', sessionId: 's-other' })
  );
  const body = JSON.parse(response.body);
  assert.strictEqual(body.sessionId, 's-other');
  assert.strictEqual(app.state.sessionId, 's-other', 'the named session becomes the bound one');
  assert.ok(app.state.folders.has('s-other'), 'its folder exists, ready to fold the new turn');
});

test('approval: unbound session or hidden window delegates to DSH', async () => {
  const { apply } = await import(INDEX);
  const { ctx, events } = createContext();
  apply(ctx, config());

  const handler = (events.get('approval/request') || [])[0];
  assert.ok(handler, 'an approval/request listener must exist');

  let delegated = 0;
  const next = () => {
    delegated += 1;
    return Promise.resolve('allowed-once');
  };
  const request = { agent: { id: 's-unbound' }, toolName: 'bash', reason: 'escalate sandbox' };

  const outcome = await handler(request, next);
  assert.strictEqual(delegated, 1, 'an unbound session must call next()');
  assert.strictEqual(outcome, 'allowed-once', 'the decision is passed back to DSH');
});
