'use strict';

/**
 * Window behavior: temporary menu growth (setMenuSpace) and pinning
 * (applyAlwaysOnTop).
 *
 * The input window is short (172px by default), so a long model list would be
 * clipped. Opening a menu grows the window upwards and closing it shrinks it
 * back. Only the geometry is verified here:
 *  - bottom edge fixed (growing/shrinking never moves the window)
 *  - truncated at the top of the screen
 *  - restore returns the exact original bounds
 *
 * Pinning is a whole-panel concern: both windows must be pinned together.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');

// main.cjs self-starts unconditionally (that is how Electron boots it). There
// is no electron module in tests, so that failure writes dock.log: point it at
// a temp directory instead of the real log.
process.env.LOCALAPPDATA = path.join(os.tmpdir(), 'qd-menu-space-test');

const { DockRuntime } = require('../main.cjs');
const { createElectronMock, createProcessMock } = require('./electron-mock');

/** Build a runtime with an input window only (no start(), no real Electron). */
function setup(bounds) {
  const mock = createElectronMock();
  const runtime = new DockRuntime(mock.electron, {
    config: {
      url: 'http://127.0.0.1:1/quickdock',
      hostPid: 111,
      rememberGeometry: false,
      width: 480,
    },
    process: createProcessMock(),
  });
  runtime.win = new mock.electron.BrowserWindow(Object.assign({ title: 'QuickDock' }, bounds));
  runtime.displayWin = null;
  return { mock, runtime, win: runtime.win };
}

test('setMenuSpace: grows upwards, bottom edge fixed', () => {
  const { runtime, win } = setup({ x: 1400, y: 860, width: 480, height: 172 });

  assert.strictEqual(runtime.setMenuSpace(300), 300, 'the full request is granted');
  const grown = win.getBounds();
  assert.strictEqual(grown.x, 1400, 'horizontal position is unchanged');
  assert.strictEqual(grown.height, 472, 'height = original + requested');
  assert.strictEqual(grown.y + grown.height, 860 + 172, 'the bottom edge is pinned');

  assert.strictEqual(runtime.setMenuSpace(0), 0, 'releasing returns 0');
  assert.deepStrictEqual(win.getBounds(), { x: 1400, y: 860, width: 480, height: 172 }, 'bounds are restored');
  assert.strictEqual(runtime.menuSpace, null, 'no expanded state remains');
});

test('setMenuSpace: truncated at the top of the screen', () => {
  const { runtime, win } = setup({ x: 400, y: 40, width: 480, height: 172 });

  // Only 40px above the window, 8px padding: at most 32px more.
  assert.strictEqual(runtime.setMenuSpace(300), 32);
  const grown = win.getBounds();
  assert.strictEqual(grown.y, 8);
  assert.strictEqual(grown.height, 172 + 32);

  runtime.setMenuSpace(0);
  assert.deepStrictEqual(win.getBounds(), { x: 400, y: 40, width: 480, height: 172 });
});

test('setMenuSpace: zero is a no-op and repeats are idempotent', () => {
  const { runtime, win } = setup({ x: 100, y: 600, width: 480, height: 172 });
  const before = win.getBounds();

  assert.strictEqual(runtime.setMenuSpace(0), 0);
  assert.deepStrictEqual(win.getBounds(), before, 'zero on a collapsed window moves nothing');

  runtime.setMenuSpace(200);
  const once = win.getBounds();
  runtime.setMenuSpace(200);
  assert.deepStrictEqual(win.getBounds(), once, 'the same height is idempotent');
  assert.strictEqual(once.height, 372);

  runtime.setMenuSpace(0);
  assert.deepStrictEqual(win.getBounds(), before);
});

test('setMenuSpace: persistence uses the original height', () => {
  const { runtime, win } = setup({ x: 100, y: 600, width: 480, height: 172 });
  const saved = [];
  runtime.store = { update: (value) => saved.push(value), state: {} };
  runtime.config.rememberGeometry = true;

  runtime.setMenuSpace(240);
  runtime.remember();
  assert.strictEqual(saved.length, 1);
  assert.strictEqual(saved[0].height, 172, 'the temporary height is never persisted');
  assert.strictEqual(saved[0].y, 600, 'the original position is kept');

  runtime.setMenuSpace(0);
  runtime.remember();
  assert.strictEqual(saved[1].y, 600);
  void win;
});

test('always-on-top pins both windows', () => {
  const { mock, runtime } = setup({ x: 100, y: 600, width: 480, height: 172 });
  runtime.displayWin = new mock.electron.BrowserWindow({ x: 100, y: 100, width: 480, height: 520 });
  runtime.store = { state: { alwaysOnTop: false }, update: () => {} };

  const count = (win, value) => win.calls.filter((c) => c[0] === 'alwaysOnTop' && c[1] === value).length;

  runtime.applyAlwaysOnTop(true);
  assert.strictEqual(count(runtime.win, true), 1, 'the input window is pinned');
  assert.strictEqual(count(runtime.displayWin, true), 1, 'the run window is pinned');
  assert.strictEqual(runtime.store.state.alwaysOnTop, true, 'the store records the flag');

  runtime.applyAlwaysOnTop(false);
  assert.strictEqual(count(runtime.win, false), 1);
  assert.strictEqual(count(runtime.displayWin, false), 1);
  assert.strictEqual(runtime.store.state.alwaysOnTop, false);
});
