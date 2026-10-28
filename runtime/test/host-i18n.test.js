'use strict';

/**
 * Locale integration: the configured or client-reported language decides the
 * page language, the injected catalog and the language of Host error messages.
 */

const test = require('node:test');
const assert = require('node:assert');

const { readFileSync } = require('node:fs');
const path = require('node:path');

const { INDEX, bridgeCall, config, createContext, invoke, pageUrl } = require('./helpers');

const ZH = JSON.parse(readFileSync(path.join(__dirname, '..', '..', 'locale', 'zh.json'), 'utf8'));
const EN = JSON.parse(readFileSync(path.join(__dirname, '..', '..', 'locale', 'en.json'), 'utf8'));

async function tokenOf(fetchRoutes) {
  return new URL(await pageUrl(fetchRoutes)).searchParams.get('t');
}

/** Serialized catalog entry as it appears inside the injected JSON payload. */
function jsonEntry(key, catalog) {
  return JSON.stringify(key) + ':' + JSON.stringify(catalog[key]);
}

test('config.locale=zh serves a Chinese page and state', async () => {
  const { apply } = await import(INDEX);
  const { ctx, routes, fetchRoutes } = createContext();
  apply(ctx, config({ locale: 'zh' }));
  const handler = routes.find((route) => route.path === '/quickdock').handler;
  const token = await tokenOf(fetchRoutes);

  const page = await invoke(handler, '/quickdock?t=' + token, {});
  assert.match(page.body, /<html lang="zh-CN"/);
  assert.match(page.body, /window.__QD_I18N__/);
  assert.ok(page.body.includes(jsonEntry('status.idle', ZH)), 'the injected catalog is Chinese');

  const state = JSON.parse((await invoke(handler, '/quickdock/api/state?t=' + token, {})).body);
  assert.strictEqual(state.locale, 'zh');
});

test('a locale pushed by the Client half switches the page language', async () => {
  const { apply } = await import(INDEX);
  const { ctx, routes, fetchRoutes } = createContext();
  apply(ctx, config());
  const handler = routes.find((route) => route.path === '/quickdock').handler;

  assert.strictEqual((await bridgeCall(fetchRoutes, 'locale', { locale: 'zh' })).ok, true);
  const token = await tokenOf(fetchRoutes);
  const page = await invoke(handler, '/quickdock?t=' + token, {});
  assert.match(page.body, /<html lang="zh-CN"/);

  const state = JSON.parse((await invoke(handler, '/quickdock/api/state?t=' + token, {})).body);
  assert.strictEqual(state.locale, 'zh');

  // Unsupported languages are refused, the active one stays.
  assert.strictEqual((await bridgeCall(fetchRoutes, 'locale', { locale: 'fr-FR' })).ok, false);
  const after = JSON.parse((await invoke(handler, '/quickdock/api/state?t=' + token, {})).body);
  assert.strictEqual(after.locale, 'zh');
});

test('an explicit config.locale wins over the browser report', async () => {
  const { apply } = await import(INDEX);
  const { ctx, routes, fetchRoutes } = createContext();
  apply(ctx, config({ locale: 'en' }));
  const handler = routes.find((route) => route.path === '/quickdock').handler;

  assert.strictEqual((await bridgeCall(fetchRoutes, 'locale', { locale: 'zh' })).ok, false);
  const token = await tokenOf(fetchRoutes);
  const page = await invoke(handler, '/quickdock?t=' + token, {});
  assert.match(page.body, /<html lang="en"/);
  assert.ok(page.body.includes(jsonEntry('status.idle', EN)));
});

test('Host error messages follow the active locale', async () => {
  const { apply } = await import(INDEX);
  const { ctx, routes, fetchRoutes } = createContext();
  apply(ctx, config({ locale: 'zh' }));
  const handler = routes.find((route) => route.path === '/quickdock').handler;
  const token = await tokenOf(fetchRoutes);

  const response = await invoke(handler, '/quickdock/api/task?t=' + token, {
    authorization: 'Bearer ' + token
  }, JSON.stringify({ text: '' }));
  assert.strictEqual(response.status, 400);
  assert.strictEqual(JSON.parse(response.body).error, ZH['host.missingMessage']);
});
