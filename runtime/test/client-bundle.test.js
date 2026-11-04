'use strict';

/**
 * The client bundle must register the header Dock button.
 *
 * This is the half of the plugin DSH loads into its own page. It cannot be
 * exercised through the Host, so the test materialises the bundle the way the
 * module loader does: run it with a stubbed __ModuleLoader__, take the factory,
 * call it with a React stub, then apply the plugin to a context that records slot
 * registrations.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const BUNDLE = path.join(__dirname, '..', '..', 'client.js')
const HEADER_SLOT = 'conversation.session.header.actions'

/** Minimal React the bundle can build components with. */
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: 'Fragment',
  memo: (fn) => fn,
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useRef: (value) => ({ current: value }),
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn
}

/**
 * Load the bundle the way the page does.
 * @returns {{id: string, plugin: object|null}} what the loader received.
 */
function materialise() {
  const loaded = []
  const sandbox = {
    window: { __ModuleLoader__: { load: (entry) => loaded.push(entry) } },
    document: {
      createElement: () => ({ style: {}, dataset: {}, appendChild() {}, setAttribute() {}, addEventListener() {} }),
      head: { appendChild() {} },
      querySelector: () => null,
      addEventListener() {}
    },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    console: { log() {}, warn() {}, error() {} }
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(fs.readFileSync(BUNDLE, 'utf8'), sandbox, { filename: 'client.js' })
  if (!loaded.length) return { id: '', plugin: null }
  const requireStub = (name) => {
    if (name === 'react-dom/client') return { createRoot: () => ({ render() {}, unmount() {} }) }
    return reactStub
  }
  return { id: loaded[0].id, plugin: loaded[0].factory(requireStub) }
}

test('client bundle: registers exactly one module, under the package id', () => {
  const { id, plugin } = materialise()
  assert.strictEqual(id, 'dsh-quickdock', 'DSH resolves the bundle for the package row')
  assert.ok(plugin && typeof plugin.apply === 'function', 'the bundle exports a plugin')
  // The array comes from the bundle's own VM context, so compare its contents.
  assert.strictEqual(plugin.inject.join(','), 'slots', 'reading ctx.slots requires the slots service')
})

test('client bundle: apply registers the header Dock button', async () => {
  const { plugin } = materialise()
  const calls = []
  const ctx = {
    slots: {
      inject: (name, register) => {
        calls.push(['inject', name])
        register()
      },
      register: (entry) => calls.push(['register', entry.name, entry.id])
    },
    uiWorkspace: { openSession: () => {} },
    logger: { warn() {}, info() {} },
    effect: () => {}
  }
  // apply() reads the configuration first, so it settles asynchronously.
  await plugin.apply(ctx)
  assert.deepStrictEqual(calls[0], ['inject', HEADER_SLOT], 'the button lives in the session header')
  const registered = calls.find((row) => row[0] === 'register' && row[1] === HEADER_SLOT)
  assert.ok(registered, 'a button was registered')
  assert.strictEqual(registered[2], 'dsh-quickdock-send-to-dock', 'with the dock id')
})
