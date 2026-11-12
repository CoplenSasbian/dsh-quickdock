'use strict';

/**
 * The VS Code MCP descriptor.
 *
 * Every rule in MCP-PAIRING.md's "Liveness" section is judged from the file plus
 * an injected clock and pid probe, so these tests never touch a real editor.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MODULE = pathToFileURL(path.join(__dirname, '..', '..', 'host', 'mcp-descriptor.js')).href;

const NOW = Date.parse('2026-11-08T13:58:15.000Z');

/** A descriptor written by a live extension at NOW. */
function descriptor(overrides) {
  return Object.assign({
    apiVersion: 1,
    kind: 'dsh-vscode-mcp',
    extension: { id: 'dsh.dsh-vsdock', version: '0.3.0' },
    editor: { name: 'Visual Studio Code', version: '1.145.0' },
    url: 'http://127.0.0.1:47920/mcp',
    healthUrl: 'http://127.0.0.1:47920/health',
    token: 'b7Qm-token',
    pid: 4321,
    heartbeatAt: new Date(NOW).toISOString(),
    workspaceFolders: []
  }, overrides || {});
}

/** Verdict for one raw descriptor, evaluated now. */
async function judge(raw, options) {
  const { evaluate } = await import(MODULE);
  return evaluate(raw, Object.assign({ now: NOW, isAlive: () => true }, options || {}));
}

test('descriptor: a fresh loopback descriptor is live', async () => {
  const result = await judge(descriptor());
  assert.strictEqual(result.state, 'live');
  assert.strictEqual(result.code, 'live');
  assert.strictEqual(result.value.url, 'http://127.0.0.1:47920/mcp');
  assert.strictEqual(result.value.healthUrl, 'http://127.0.0.1:47920/health');
  assert.strictEqual(result.value.token, 'b7Qm-token');
  assert.strictEqual(result.value.pid, 4321);
  assert.strictEqual(result.value.extensionId, 'dsh.dsh-vsdock');
});

test('descriptor: healthUrl falls back to the endpoint summary', async () => {
  const result = await judge(descriptor({ healthUrl: undefined, url: 'http://127.0.0.1:47920/mcp' }));
  assert.strictEqual(result.state, 'live');
  assert.strictEqual(result.value.healthUrl, 'http://127.0.0.1:47920/health');
});

test('descriptor: only the documented kind and shape version pair', async () => {
  assert.strictEqual((await judge(descriptor({ kind: 'other-mcp' }))).code, 'kind');
  assert.strictEqual((await judge(descriptor({ apiVersion: 2 }))).code, 'apiVersion');
  assert.strictEqual((await judge(descriptor({ kind: undefined }))).code, 'kind');
});

test('descriptor: the URL must be loopback http with a port', async () => {
  for (const url of [
    'http://10.0.0.5:47920/mcp',
    'https://127.0.0.1:47920/mcp',
    'http://127.0.0.1/mcp',
    'http://user:pass@127.0.0.1:47920/mcp',
    'not a url'
  ]) {
    const result = await judge(descriptor({ url }));
    assert.strictEqual(result.state, 'invalid', url);
    assert.strictEqual(result.code, 'url', url);
  }
  assert.strictEqual((await judge(descriptor({ url: 'http://localhost:47920/mcp' }))).state, 'live');
});

test('descriptor: a remote health URL is rejected as well', async () => {
  const result = await judge(descriptor({ healthUrl: 'http://10.0.0.5:47920/health' }));
  assert.strictEqual(result.code, 'healthUrl');
});

test('descriptor: the token is a non-empty capability, never a document', async () => {
  assert.strictEqual((await judge(descriptor({ token: '' }))).code, 'token');
  assert.strictEqual((await judge(descriptor({ token: undefined }))).code, 'token');
  assert.strictEqual((await judge(descriptor({ token: 'x'.repeat(201) }))).code, 'token');
  assert.strictEqual((await judge(descriptor({ token: 'has space' }))).code, 'token');
  assert.strictEqual((await judge(descriptor({ token: 'line\nbreak' }))).code, 'token');
});

test('descriptor: pid and heartbeat are checked before the file counts as live', async () => {
  assert.strictEqual((await judge(descriptor({ pid: 0 }))).code, 'pid');
  assert.strictEqual((await judge(descriptor({ pid: '4321' }))).code, 'pid');
  assert.strictEqual((await judge(descriptor({ heartbeatAt: 'yesterday' }))).code, 'heartbeat');
  assert.strictEqual((await judge(descriptor({ heartbeatAt: undefined }))).code, 'heartbeat');
});

test('descriptor: a dead writer is stale, not invalid', async () => {
  const result = await judge(descriptor(), { isAlive: () => false });
  assert.strictEqual(result.state, 'stale');
  assert.strictEqual(result.code, 'pid-dead');
  assert.match(result.reason, /4321/);
});

test('descriptor: a heartbeat older than 90 s is stale', async () => {
  const result = await judge(descriptor({ heartbeatAt: new Date(NOW - 91000).toISOString() }));
  assert.strictEqual(result.state, 'stale');
  assert.strictEqual(result.code, 'heartbeat-stale');
});

test('descriptor: a heartbeat far in the future is stale too', async () => {
  const result = await judge(descriptor({ heartbeatAt: new Date(NOW + 91000).toISOString() }));
  assert.strictEqual(result.state, 'stale');
  assert.strictEqual(result.code, 'heartbeat-future');
  assert.strictEqual((await judge(descriptor({ heartbeatAt: new Date(NOW + 30000).toISOString() }))).state, 'live');
});

test('descriptor: reading is state, not an exception', async () => {
  const { readDescriptor } = await import(MODULE);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-mcp-descriptor-'));
  const file = path.join(dir, 'mcp.json');
  assert.strictEqual(readDescriptor(file).state, 'absent');
  fs.writeFileSync(file, '{ broken');
  const malformed = readDescriptor(file);
  assert.strictEqual(malformed.state, 'invalid');
  assert.strictEqual(malformed.code, 'json');
  fs.writeFileSync(file, JSON.stringify(descriptor()));
  assert.strictEqual(readDescriptor(file, { now: NOW, isAlive: () => true }).state, 'live');
});
