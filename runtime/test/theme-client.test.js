'use strict';

/**
 * Client-half theme sync: DSH built-in snapshots carry an empty token map, so
 * the palette has to be read from resolved computed styles and pushed on every
 * change. The bundle is a single script, hence the VM sandbox with a tiny DOM.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

const CLIENT = path.join(__dirname, '..', '..', 'client.js');
const THEME = pathToFileURL(path.join(__dirname, '..', '..', 'host', 'theme.js')).href;

async function whitelist() {
  return (await import(THEME)).THEME_TOKENS;
}

function fakeElement() {
  const attributes = Object.create(null);
  const element = {
    style: {},
    parentNode: null,
    setAttribute(name, value) { attributes[name] = String(value); },
    hasAttribute(name) { return Object.prototype.hasOwnProperty.call(attributes, name); },
    removeAttribute(name) { delete attributes[name]; },
    appendChild(child) { child.parentNode = element; return child; },
    removeChild(child) { if (child.parentNode === element) child.parentNode = null; return child; }
  };
  return element;
}

/** A DOM stub whose body resolves --dsw-* through a probe element. */
function environment(options) {
  const body = fakeElement();
  const root = fakeElement();
  const state = {
    body,
    root,
    palette: options.palette,
    snapshot: options.snapshot,
    calls: [],
    listeners: [],
    observers: []
  };
  state.document = {
    body,
    documentElement: root,
    createElement: () => fakeElement()
  };
  state.computed = (target) => {
    if (target === body) {
      return {
        backgroundColor: 'rgb(20, 20, 20)',
        getPropertyValue: (name) => state.palette.raw[name] || ''
      };
    }
    if (target === root) {
      return { backgroundColor: 'rgba(0, 0, 0, 0)', getPropertyValue: () => '' };
    }
    const value = String(target.style.backgroundColor || '');
    const chain = /^var\((--[\w-]+),\s*(.+)\)$/.exec(value);
    if (!chain) return { backgroundColor: value, getPropertyValue: () => '' };
    return {
      backgroundColor: state.palette.colors[chain[1]] || chain[2],
      getPropertyValue: () => ''
    };
  };
  state.themePushes = () => state.calls.filter((call) => call.action === 'theme');
  state.setScheme = (scheme) => {
    if (scheme === 'dark') body.setAttribute('data-ds-dark-theme', '');
    else body.removeAttribute('data-ds-dark-theme');
  };
  state.emitThemeChange = (snapshot) => {
    state.snapshot = snapshot;
    for (const listener of state.listeners) {
      if (listener.name === 'theme/change') listener.callback(snapshot);
    }
  };
  return state;
}

/** Load the Client bundle, wire apply() and return the recording environment. */
function start(options) {
  const state = environment(options);
  const timers = new Set();
  const later = (callback, delay) => {
    const id = setTimeout(() => {
      timers.delete(id);
      callback();
    }, delay);
    timers.add(id);
    return id;
  };
  state.stop = () => {
    for (const id of timers) clearTimeout(id);
    timers.clear();
  };
  let definition = null;
  class FakeObserver {
    constructor(callback) {
      this.callback = callback;
      state.observers.push(this);
    }
    observe() {}
    disconnect() { this.disconnected = true; }
  }
  const sandbox = {
    console,
    setTimeout: later,
    clearTimeout: (id) => { timers.delete(id); clearTimeout(id); },
    JSON,
    Promise,
    URL,
    navigator: { languages: ['en-US'], language: 'en-US' },
    document: state.document,
    getComputedStyle: state.computed,
    requestAnimationFrame: (callback) => later(callback, 0),
    MutationObserver: FakeObserver,
    fetch: (url, init) => {
      state.calls.push(init && init.body ? JSON.parse(init.body) : {});
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
    },
    window: {
      __ModuleLoader__: { load: (value) => { definition = value; } },
      getComputedStyle: state.computed,
      focus() {}
    }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(CLIENT, 'utf8'), sandbox, { filename: 'client.js' });

  const plugin = definition.factory(() => ({ createElement: () => null }));
  const themeContext = {
    theme: { getTheme: () => state.snapshot },
    on(name, callback) { state.listeners.push({ name, callback }); },
    effect(callback) {
      const dispose = callback();
      state.disposers = (state.disposers || []).concat(dispose);
    }
  };
  plugin.apply({
    slots: { inject() {}, register() {} },
    inject(names, callback) {
      if (names.indexOf('theme') >= 0) callback(themeContext);
    }
  });
  return state;
}

function settle() {
  return new Promise((resolve) => setTimeout(resolve, 80));
}

function snapshot(scheme) {
  return {
    preference: scheme,
    active: { id: scheme, colorScheme: scheme, tokens: {} },
    fontFamilies: { text: 'Inter', code: 'Mono' },
    fontSizes: { text: 13, code: 11 }
  };
}

function paletteFor(tokens, resolver) {
  const raw = {};
  const colors = {};
  const read = typeof resolver === 'function' ? resolver : () => resolver;
  tokens.forEach((name, index) => {
    raw[name] = read(name, index);
    colors[name] = read(name, index);
  });
  return { raw, colors };
}

test('the palette comes from resolved computed styles, not the snapshot', async () => {
  const tokens = await whitelist();
  const palette = paletteFor(tokens, (name, index) => 'rgb(' + (index + 10) + ', 0, 0)');
  const state = start({ palette, snapshot: snapshot('dark') });
  state.setScheme('dark');
  await settle();

  const pushes = state.themePushes();
  assert.strictEqual(pushes.length, 1, 'exactly one palette push');
  const payload = pushes[0].theme;
  assert.strictEqual(payload.colorScheme, 'dark');
  assert.deepStrictEqual(Object.keys(payload.tokens).sort(), [...tokens].sort());
  assert.strictEqual(payload.tokens['--dsw-alias-bg-base'], 'rgb(10, 0, 0)');
  assert.strictEqual(payload.fonts.text, 'Inter');
  assert.strictEqual(payload.fonts.sizeText, 13);
});

test('var() chains are resolved through a probe element', async () => {
  const tokens = await whitelist();
  const palette = paletteFor(tokens, 'var(--dsw-static-token)');
  tokens.forEach((name) => { palette.colors[name] = 'rgb(90, 80, 70)'; });
  const state = start({ palette, snapshot: snapshot('light') });
  state.setScheme('light');
  await settle();

  const payload = state.themePushes()[0].theme;
  assert.strictEqual(payload.colorScheme, 'light');
  for (const name of tokens) assert.strictEqual(payload.tokens[name], 'rgb(90, 80, 70)');
  assert.ok(!payload.tokens['--dsw-alias-bg-base'].includes('var('), 'no unresolved chains');
});

test('a live theme change re-reads and pushes the new palette', async () => {
  const tokens = await whitelist();
  const dark = paletteFor(tokens, 'rgb(10, 10, 10)');
  const state = start({ palette: dark, snapshot: snapshot('dark') });
  state.setScheme('dark');
  await settle();
  assert.strictEqual(state.themePushes().length, 1);

  const light = paletteFor(tokens, 'rgb(250, 250, 250)');
  state.palette = light;
  state.setScheme('light');
  state.emitThemeChange(snapshot('light'));
  await settle();

  const pushes = state.themePushes();
  assert.strictEqual(pushes.length, 2);
  assert.strictEqual(pushes[1].theme.colorScheme, 'light');
  assert.strictEqual(pushes[1].theme.tokens['--dsw-alias-bg-base'], 'rgb(250, 250, 250)');
});

test('an unchanged palette is not pushed twice', async () => {
  const tokens = await whitelist();
  const palette = paletteFor(tokens, 'rgb(10, 10, 10)');
  const state = start({ palette, snapshot: snapshot('dark') });
  state.setScheme('dark');
  await settle();

  state.emitThemeChange(snapshot('dark'));
  await settle();
  assert.strictEqual(state.themePushes().length, 1);
  state.stop();
});

test('no readable palette means no push (the dock keeps its own colours)', async () => {
  const tokens = await whitelist();
  const palette = { raw: {}, colors: {} };
  const state = start({ palette, snapshot: snapshot('dark') });
  await settle();
  assert.strictEqual(state.themePushes().length, 0);
  assert.ok(tokens.length > 0);
  state.stop();
});
