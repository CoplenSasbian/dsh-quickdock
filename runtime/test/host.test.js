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

const { INDEX, bridgeCall, config, createContext, invoke, pageUrl } = require('./helpers');

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
