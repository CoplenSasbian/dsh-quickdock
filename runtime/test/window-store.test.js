'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WindowStore } = require('../window-store');
const { DEFAULTS } = require('../geometry');

test('updates are debounced and persisted atomically', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'quickdock-store-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'window.json');
  const store = new WindowStore(file, { delay: 20 });
  let writes = 0;
  const original = store.atomicWrite.bind(store);
  store.atomicWrite = async (...args) => { writes += 1; return original(...args); };
  store.update({ x: 10, y: 20 });
  store.update({ x: 20, alwaysOnTop: true });
  store.update({ x: 30, height: 480 });
  assert.equal(fs.existsSync(file), false);
  await new Promise((resolve) => setTimeout(resolve, 45));
  assert.equal(writes, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
    width: DEFAULTS.width, height: 480, alwaysOnTop: true, x: 30, y: 20,
  });
  assert.deepEqual(fs.readdirSync(directory), ['window.json']);
});

test('corrupt state does not block startup', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'quickdock-corrupt-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'window.json');
  fs.writeFileSync(file, '{broken');
  const store = WindowStore.load(file);
  assert.equal(store.state.alwaysOnTop, false);
  assert.equal(store.state.width, DEFAULTS.width);
});
