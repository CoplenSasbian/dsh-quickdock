'use strict';

/**
 * Dock supervisor: start failures before 'ready' advance through the Electron
 * candidates instead of dying silently with exit code 0.
 */

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const DOCK_PROCESS = pathToFileURL(path.join(__dirname, '..', '..', 'host', 'dock-process.js')).href;

function createChild() {
  const child = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};
  child.exitCode = null;
  child.killed = false;
  child.kill = () => { child.killed = true; };
  return child;
}

async function createSupervisor(candidates) {
  const { DockProcess } = await import(DOCK_PROCESS);
  const spawned = [];
  const children = [];
  const state = { dock: { running: false, visible: false, alwaysOnTop: false, error: '' } };
  const dock = new DockProcess({
    state,
    config: {
      width: 480, inputHeight: 172, displayHeight: 520, margin: 16,
      rememberGeometry: false, autoLaunch: false, approvalTimeoutMs: 60000
    },
    rootDir: 'C:/app',
    token: 'token',
    pageUrl: () => 'http://127.0.0.1:1/quickdock?t=token',
    resolver: { resolve: async () => candidates },
    logger: {},
    trace: () => {},
    t: (key, params) => key + (params ? ' ' + JSON.stringify(params) : ''),
    publish: () => {},
    spawn: (exe) => {
      spawned.push(exe);
      const child = createChild();
      children.push(child);
      return child;
    }
  });
  return { dock, state, spawned, children };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('exiting before ready moves to the next candidate', async () => {
  const { state, spawned, children, dock } = await createSupervisor([
    { exe: 'C:/blocked/electron.exe', args: [] },
    { exe: 'C:/good/electron.exe', args: [] }
  ]);

  await dock.spawnDock();
  assert.deepStrictEqual(spawned, ['C:/blocked/electron.exe']);

  // The blocked binary starts, cannot write its profile, and exits 0.
  children[0].emit('exit', 0, null);
  await settle();
  await settle();
  assert.deepStrictEqual(spawned, ['C:/blocked/electron.exe', 'C:/good/electron.exe']);

  // The second candidate becomes ready and a normal close is not an error.
  dock.onStatus({ type: 'ready', controlPort: 5000 });
  children[1].emit('exit', 0, null);
  await settle();
  assert.strictEqual(dock.alive, false);
  assert.strictEqual(state.dock.error, '');
  assert.strictEqual(spawned.length, 2);
});

test('all candidates failing reports the real stderr reason', async () => {
  const { state, spawned, children, dock } = await createSupervisor([
    { exe: 'C:/a/electron.exe', args: [] }
  ]);

  await dock.spawnDock();
  children[0].stderr.emit('data', 'ERROR: Lock file can not be created: access denied (0x5)\n');
  children[0].emit('exit', 0, null);
  await settle();

  assert.strictEqual(spawned.length, 1);
  assert.match(state.dock.error, /host\.dockStartFailed/);
  assert.match(state.dock.error, /Lock file can not be created/);
  // A later summon retries from the best candidate again.
  assert.strictEqual(dock.candidates, null);
  assert.strictEqual(dock.candidateIndex, 0);
});

test('a crash after ready uses the restart policy, not the candidate list', async () => {
  const { children, spawned, dock } = await createSupervisor([
    { exe: 'C:/a/electron.exe', args: [] },
    { exe: 'C:/b/electron.exe', args: [] }
  ]);

  await dock.spawnDock();
  dock.onStatus({ type: 'ready', controlPort: 5001 });
  children[0].emit('exit', 1, null);
  await settle();
  await settle();
  // Same candidate is restarted later; the second candidate is not tried.
  assert.deepStrictEqual(spawned, ['C:/a/electron.exe']);
  assert.ok(dock.timer, 'a restart timer is scheduled');
  dock.stop();
});
