'use strict';

/**
 * Theme bridge unit tests: token mapping, adoption rules and inline CSS.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const THEME = pathToFileURL(path.join(__dirname, '..', '..', 'host', 'theme.js')).href;

async function themeModule() {
  return import(THEME);
}

const FULL_TOKENS = {
  '--dsw-alias-bg-base': '#101010',
  '--dsw-alias-bg-layer-1': '#161616',
  '--dsw-alias-bg-layer-2': '#1c1c1c',
  '--dsw-alias-border-l1': '#303030',
  '--dsw-alias-border-l2': '#3a3a3a',
  '--dsw-alias-label-primary': '#eeeeee'
};

test('the whitelist maps 21 DSH alias tokens', async () => {
  const { THEME_TOKENS, THEME_TOKEN_MAP } = await themeModule();
  assert.strictEqual(THEME_TOKENS.length, 21);
  assert.strictEqual(THEME_TOKEN_MAP['--dsw-alias-bg-base'], '--qd-bg-base');
  assert.strictEqual(THEME_TOKEN_MAP['--dsw-alias-state-warn-primary'], '--qd-state-warn');
});

test('normalizeTheme rejects incomplete payloads', async () => {
  const { normalizeTheme } = await themeModule();
  assert.strictEqual(normalizeTheme(null), null);
  assert.strictEqual(normalizeTheme({ tokens: {} }), null);
  assert.strictEqual(normalizeTheme({ tokens: { '--qd-bg-base': '#000' } }), null);
});

test('normalizeTheme accepts both DSH and dock token names', async () => {
  const { normalizeTheme } = await themeModule();
  const fromDsh = normalizeTheme({ colorScheme: 'light', tokens: FULL_TOKENS });
  assert.ok(fromDsh);
  assert.strictEqual(fromDsh.colorScheme, 'light');
  assert.strictEqual(fromDsh.tokens['--qd-bg-base'], '#101010');
  assert.strictEqual(fromDsh.tokens['--qd-label-primary'], '#eeeeee');
  assert.strictEqual(fromDsh.tokens['--qd-brand-fg'], '#101010',
    'text on brand follows the base surface (DSH accents are monochrome)');
  assert.strictEqual(fromDsh.fonts.sizeText, 12);
  assert.strictEqual(fromDsh.fonts.sizeCode, 11);

  const fromDock = normalizeTheme({
    tokens: { '--qd-bg-base': '#fff', '--qd-bg-layer-1': '#f5f5f5', '--qd-bg-layer-2': '#eee',
      '--qd-border-l1': '#ddd', '--qd-border-l2': '#ccc', '--qd-label-primary': '#111' }
  });
  assert.ok(fromDock, 'dock-named tokens are accepted too');
  assert.strictEqual(fromDock.colorScheme, 'dark');
});

test('themeFromSnapshot reads a DSH theme snapshot', async () => {
  const { themeFromSnapshot } = await themeModule();
  assert.strictEqual(themeFromSnapshot(null), null);
  const payload = themeFromSnapshot({
    active: { colorScheme: 'dark', tokens: FULL_TOKENS },
    fontFamilies: { text: 'Inter', code: 'Mono' },
    fontSizes: { text: 13, code: 11 }
  });
  assert.ok(payload);
  assert.strictEqual(payload.colorScheme, 'dark');
  assert.strictEqual(payload.fonts.text, 'Inter');
  assert.strictEqual(payload.fonts.sizeText, 13);
});

test('themeCss renders first-paint variables and fonts', async () => {
  const { themeCss, normalizeTheme } = await themeModule();
  assert.strictEqual(themeCss(null), '');
  const css = themeCss(normalizeTheme({ tokens: FULL_TOKENS, fonts: { text: 'Inter', sizeText: 13 } }));
  // Specificity must beat the dock's own html[data-theme="light"] palette.
  assert.match(css, /^<style>html\[data-theme\]\{/);
  assert.match(css, /--qd-bg-base: #101010;/);
  assert.match(css, /--qd-font-text: Inter;/);
  assert.match(css, /--qd-font-size-text: 13px;/);
});

test('the fallback scheme only applies until DSH reports a theme', async () => {
  const { ThemeStore, normalizeTheme } = await themeModule();
  assert.strictEqual(new ThemeStore({ fallback: 'auto' }).colorScheme(), 'dark');
  assert.strictEqual(new ThemeStore({ fallback: 'light' }).colorScheme(), 'light');
  const store = new ThemeStore({ fallback: 'light' });
  store.accept(normalizeTheme({ colorScheme: 'dark', tokens: FULL_TOKENS }));
  assert.strictEqual(store.colorScheme(), 'dark', 'the pushed theme wins over the fallback');
});

test('an identical palette is adopted without notifying twice', async () => {
  const { ThemeStore } = await themeModule();
  let pushes = 0;
  const store = new ThemeStore({ onChange: () => { pushes += 1; } });
  const payload = { colorScheme: 'dark', tokens: FULL_TOKENS };
  assert.strictEqual(store.accept(payload), true);
  assert.strictEqual(store.accept(payload), true);
  assert.strictEqual(pushes, 1);
});
