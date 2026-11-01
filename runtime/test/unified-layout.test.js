'use strict';

/**
 * Unified layout: no second window. Every display-window call site has to cope
 * with it being absent - this used to throw at start-up and the dock never came
 * up at all.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');

process.env.LOCALAPPDATA = path.join(os.tmpdir(), 'qd-unified-test');

const { DockRuntime } = require('../main.cjs');
const { createElectronMock, createProcessMock } = require('./electron-mock');

function makeRuntime(config) {
  const mock = createElectronMock();
  const runtime = new DockRuntime(mock.electron, {
    config: Object.assign({
      url: 'http://127.0.0.1:1/quickdock',
      hostPid: 111,
      rememberGeometry: false,
      width: 480,
      displayHeight: 520
    }, config),
    process: createProcessMock()
  });
  runtime.store = {
    state: {},
    update() {},
    close() { return Promise.resolve() }
  };
  return { mock, runtime };
}

test('unified: the runtime starts with no display window', async () => {
  const { mock, runtime } = makeRuntime({ layout: 'unified' });
  runtime.createMainWindow = () => {
    const win = new mock.electron.BrowserWindow({ x: 100, y: 100, width: 484, height: 176 });
    win.loadURL = (url) => { runtime.loadedUrl = url; win.url = url; return Promise.resolve() };
    return win;
  };
  runtime.startControlServer = () => { runtime.controlPort = 1; return Promise.resolve() };
  runtime.pollHost = () => {};
  runtime.pollHitTest = () => {};
  await runtime.start();
  assert.strictEqual(runtime.displayWin, null, 'no second window in unified mode');
  assert.strictEqual(runtime.displayWantH, 520, 'the pane height stands in for the window');
  assert.strictEqual(runtime.displayWantW, 480, 'and its width');
});

test('split: the display window is still created', () => {
  const { mock, runtime } = makeRuntime({ layout: 'split' });
  runtime.win = new mock.electron.BrowserWindow({ x: 100, y: 100, width: 484, height: 176 });
  const win = runtime.createDisplayWindow(mock.electron.screen.getPrimaryDisplay());
  assert.ok(win, 'split mode keeps the second window');
});
