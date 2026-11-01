'use strict';

/**
 * The task window: created with the configured height and parked between the
 * input window and the run window, on whichever side the run window sits.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');

process.env.LOCALAPPDATA = path.join(os.tmpdir(), 'qd-todo-window-test');

const { DockRuntime } = require('../main.cjs');
const { createElectronMock, createProcessMock } = require('./electron-mock');

/** A runtime with an input window and a task window, no start(). */
function setup(extra) {
  const mock = createElectronMock();
  const runtime = new DockRuntime(mock.electron, {
    config: Object.assign({
      url: 'http://127.0.0.1:1/quickdock',
      hostPid: 111,
      rememberGeometry: false,
      width: 480,
      todoHeight: 180,
    }, extra),
    process: createProcessMock(),
  });
  // prepareWindow(win, store) only touches store.state.alwaysOnTop in this mock.
  runtime.store = { state: { alwaysOnTop: false }, update() {}, close() { return Promise.resolve() } };
  return { mock, runtime };
}

test('createTodoWindow: configured size and the todo view', () => {
  const { mock, runtime } = setup();
  const win = runtime.createTodoWindow(mock.electron.screen.getPrimaryDisplay());
  assert.strictEqual(win.getBounds().height, 180, 'height comes from todoHeight');
  assert.strictEqual(win.getBounds().width, 480, 'width matches the input window');
});

test('placeTodoWindow: between the input window and the run window below', () => {
  const { mock, runtime } = setup();
  runtime.win = new mock.electron.BrowserWindow({ x: 1400, y: 400, width: 480, height: 200 });
  runtime.todoWin = runtime.createTodoWindow(mock.electron.screen.getPrimaryDisplay());
  const area = mock.electron.screen.getPrimaryDisplay().workArea;
  runtime.placeTodoWindow(runtime.win.getBounds(), area, false);
  const bounds = runtime.todoWin.getBounds();
  // The two panels overlap by 14px so they read as one stack (same constant the
  // display window uses).
  assert.strictEqual(bounds.y, 400 + 200 - 14, 'sits directly under the input window');
  assert.strictEqual(bounds.height, 180);
});

test('placeTodoWindow: mirrors above when the run window flipped', () => {
  const { mock, runtime } = setup();
  runtime.win = new mock.electron.BrowserWindow({ x: 1400, y: 600, width: 480, height: 200 });
  runtime.todoWin = runtime.createTodoWindow(mock.electron.screen.getPrimaryDisplay());
  const area = mock.electron.screen.getPrimaryDisplay().workArea;
  runtime.placeTodoWindow(runtime.win.getBounds(), area, true);
  const bounds = runtime.todoWin.getBounds();
  assert.strictEqual(bounds.y, 600 - 180 + 14, 'sits directly above the input window');
});
