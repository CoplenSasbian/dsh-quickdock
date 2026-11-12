'use strict';

/**
 * The dock context registry: identity, reserved fields, per-dock bindings and
 * expiry. Pure: the clock is injected, nothing touches the filesystem.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MODULE = pathToFileURL(path.join(__dirname, '..', '..', 'host', 'dock-contexts.js')).href;

let DockContexts;
let LEGACY_ID;
let DOCK_TTL_MS;

test.before(async () => {
  ({ DockContexts, LEGACY_ID, DOCK_TTL_MS } = await import(MODULE));
});

function registry(now = () => 1_000_000) {
  return new DockContexts({ now, ttlMs: DOCK_TTL_MS });
}

test('dock contexts: create, merge and list', () => {
  const docks = registry();
  const created = docks.upsert({ id: 'vscode-1', type: 'vscode' });
  assert.equal(created.id, 'vscode-1');
  assert.equal(created.type, 'vscode');
  assert.deepEqual(created.session, { sessionId: '', seq: 0, reloadSeq: 0 });
  assert.equal(docks.get('vscode-1').id, 'vscode-1');

  const merged = docks.upsert({
    id: 'vscode-1',
    client: { name: 'Visual Studio Code', pid: 42 },
    tools: { url: 'http://127.0.0.1:47920/mcp', token: 't' },
    workspace: { path: 'C:\\work' },
    systemPrompt: 'the user is in VS Code'
  });
  assert.equal(merged.type, 'vscode');
  assert.equal(merged.client.pid, 42);
  assert.equal(merged.tools.token, 't');
  assert.equal(merged.workspace.path, 'C:\\work');
  assert.equal(merged.systemPrompt, 'the user is in VS Code');

  docks.upsert({ id: 'vscode-2', type: 'vscode' });
  assert.deepEqual(docks.list().map((context) => context.id).sort(), ['vscode-1', 'vscode-2']);
});

test('dock contexts: bind and target are per dock', () => {
  const docks = registry();
  const first = docks.bind('dock-a', 'session-1');
  assert.deepEqual(first, { sessionId: 'session-1', seq: 1, reloadSeq: 0 });
  const second = docks.bind('dock-b', 'session-2');
  assert.deepEqual(second, { sessionId: 'session-2', seq: 1, reloadSeq: 0 });
  assert.deepEqual(docks.target('dock-a'), { sessionId: 'session-1', seq: 1, reloadSeq: 0 });
  assert.deepEqual(docks.target('dock-b'), { sessionId: 'session-2', seq: 1, reloadSeq: 0 });

  docks.bind('dock-a', 'session-3');
  assert.equal(docks.target('dock-a').seq, 2);
  assert.equal(docks.target('dock-b').seq, 1);

  // Reporting the session a dock already shows must not bump `seq`: the shell
  // would otherwise tell the app to open it again and loop.
  docks.bind('dock-a', 'session-3');
  assert.equal(docks.target('dock-a').seq, 2);

  docks.reload('dock-a');
  assert.equal(docks.target('dock-a').reloadSeq, 1);
  assert.equal(docks.target('dock-b').reloadSeq, 0);
});

test('dock contexts: a bind creates the context on demand', () => {
  const docks = registry();
  assert.equal(docks.get('dock-late'), undefined);
  docks.bind('dock-late', 'session-x');
  const context = docks.get('dock-late');
  assert.ok(context);
  assert.equal(context.type, 'unknown');
  assert.equal(context.session.sessionId, 'session-x');
});

test('dock contexts: stale contexts are pruned, fresh ones survive', () => {
  let now = 1_000_000;
  const docks = new DockContexts({ now: () => now, ttlMs: 1000 });
  docks.upsert({ id: 'dock-a', type: 'vscode' });
  now += 600;
  docks.upsert({ id: 'dock-b', type: 'electron' });
  now += 600; // dock-a is 1200 ms old, dock-b 600
  const alive = docks.list().map((context) => context.id).sort();
  assert.deepEqual(alive, ['dock-b']);
  assert.equal(docks.get('dock-a'), undefined);
});

test('dock contexts: remove drops the binding with the context', () => {
  const docks = registry();
  docks.bind('dock-a', 'session-1');
  assert.equal(docks.snapshot('dock-a').sessionId, 'session-1');
  assert.equal(docks.remove('dock-a'), true);
  assert.equal(docks.remove('dock-a'), false);
  assert.equal(docks.target('dock-a'), undefined);
  assert.equal(docks.snapshot('dock-a'), null);
});

test('dock contexts: the snapshot is transport-safe', () => {
  const docks = registry();
  docks.upsert({
    id: 'vscode-1',
    type: 'vscode',
    client: { name: 'Visual Studio Code' },
    tools: { url: 'http://127.0.0.1:47920/mcp', token: 'secret' },
    workspace: { path: 'C:\\work' }
  });
  docks.bind('vscode-1', 'session-9');
  const snapshot = docks.snapshot('vscode-1');
  assert.equal(snapshot.id, 'vscode-1');
  assert.equal(snapshot.type, 'vscode');
  assert.equal(snapshot.hasTools, true);
  assert.equal(snapshot.toolsUrl, 'http://127.0.0.1:47920/mcp');
  assert.equal(snapshot.sessionId, 'session-9');
  assert.equal(snapshot.workspace.path, 'C:\\work');
  // The token is a capability: it never leaves the host in a snapshot.
  assert.equal(JSON.stringify(snapshot).includes('secret'), false);
});

test('dock contexts: an id is required and the legacy id is reserved', () => {
  const docks = registry();
  assert.throws(() => docks.upsert({ type: 'vscode' }), /id is required/);
  assert.equal(LEGACY_ID, 'legacy');
  docks.upsert({ id: LEGACY_ID, type: 'vscode' });
  assert.equal(docks.get(LEGACY_ID).type, 'vscode');
});
