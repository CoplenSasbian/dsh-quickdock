'use strict';

const { EventEmitter } = require('node:events');

function createElectronMock() {
  const calls = [];
  const windows = [];
  const ipcHandlers = new Map();
  const ipcListeners = new Map();
  const app = new EventEmitter();
  app.commandLine = { appendSwitch: (...args) => calls.push(['appendSwitch', ...args]) };
  app.disableHardwareAcceleration = () => calls.push(['disableHardwareAcceleration']);
  app.setName = (name) => calls.push(['setName', name]);
  app.requestSingleInstanceLock = () => true;
  app.whenReady = () => Promise.resolve();
  app.getPath = () => 'C:\\Users\\test\\AppData\\Roaming\\dsh-quickdock';
  app.quit = () => calls.push(['quit']);

  const screen = new EventEmitter();
  const primary = { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
  const second = { id: 2, workArea: { x: 1920, y: -200, width: 1280, height: 1024 } };
  screen.getAllDisplays = () => [primary, second];
  screen.getPrimaryDisplay = () => primary;
  screen.getCursorScreenPoint = () => ({ x: 1800, y: 900 });
  screen.getDisplayNearestPoint = (point) => point.x >= 1920 ? second : primary;

  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height };
      this.visible = false;
      this.destroyed = false;
      this.calls = [];
      this.webContents = new EventEmitter();
      this.webContents.send = (channel, payload) => this.calls.push(['send', channel, payload]);
      this.webContents.setWindowOpenHandler = (handler) => { this.openHandler = handler; };
      this.webContents.setBackgroundThrottling = (value) => this.calls.push(['throttling', value]);
      this.webContents.loadURL = (url) => { this.url = url; return Promise.resolve(); };
      windows.push(this);
    }
    getBounds() { return Object.assign({}, this.bounds); }
    setBounds(bounds) { this.bounds = Object.assign({}, bounds); this.calls.push(['bounds', this.getBounds()]); }
    setMenuBarVisibility(value) { this.calls.push(['menu', value]); }
    setAlwaysOnTop(value, level) { this.calls.push(['alwaysOnTop', value, level]); }
    setVisibleOnAllWorkspaces(...args) { this.calls.push(['allWorkspaces', ...args]); }
    setIgnoreMouseEvents(...args) { this.calls.push(['ignoreMouse', ...args]); }
    setSkipTaskbar(value) { this.calls.push(['skipTaskbar', value]); }
    loadURL(url) { return this.webContents.loadURL(url); }
    showInactive() { this.visible = true; this.calls.push(['showInactive']); this.emit('show'); }
    show() { this.visible = true; this.calls.push(['show']); this.emit('show'); }
    hide() { this.visible = false; this.calls.push(['hide']); }
    isVisible() { return this.visible; }
    isDestroyed() { return this.destroyed; }
  }

  const ipcMain = {
    handle(channel, callback) { ipcHandlers.set(channel, callback); },
    on(channel, callback) { ipcListeners.set(channel, callback); },
  };

  return {
    electron: { app, BrowserWindow, ipcMain, powerMonitor: new EventEmitter(), screen },
    windows,
    calls,
    ipcHandlers,
    ipcListeners,
    displays: { primary, second },
  };
}

function createProcessMock() {
  const input = new EventEmitter();
  input.resume = () => {};
  const output = new EventEmitter();
  output.writable = true;
  output.destroyed = false;
  output.lines = [];
  output.write = (text) => { output.lines.push(text); return true; };
  return {
    argv: [],
    env: { LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local' },
    platform: 'win32',
    pid: 222,
    stdin: input,
    stdout: output,
    exitCode: 0,
    killCalls: [],
    kill(pid, signal) {
      this.killCalls.push([pid, signal]);
      if (this.hostAlive === false) {
        const error = new Error('missing');
        error.code = 'ESRCH';
        throw error;
      }
    },
  };
}

function config(statePath) {
  return {
    url: 'http://127.0.0.1:62135/quickdock?t=secret',
    hostPid: 111,
    statePath,
    width: 360,
    minHeight: 280,
    maxHeight: 560,
    margin: 16,
    focusOnSummon: false,
    rememberGeometry: true,
    saveDelayMs: 20,
    hostPollMs: 5000,
    hitPollMs: 5000,
    showFallbackMs: 400,
  };
}

module.exports = { config, createElectronMock, createProcessMock };
