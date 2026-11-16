'use strict';

/**
 * Dock-side MCP pairing.
 *
 * The workspace MCP bridge lives on DSH's Web origin; an IDE dock only ever
 * knows this Host's loopback listener. These tests cover the forwarding layer:
 * the dock posts the bridge's own body here, the Host adds the origin and the
 * shared secret, and a bridge answer (or refusal) comes back unchanged.
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { config, createContext, invoke } = require('./helpers');

const SERVICE = pathToFileURL(path.join(__dirname, '..', '..', 'service.js')).href;

/** Apply the service entry and return the host plus a JSON caller. */
async function start(overrides) {
  const { apply } = await import(SERVICE);
  const { ctx, setOrigin } = createContext();
  const app = apply(ctx, config(overrides));
  const call = (url, body, method) => invoke(
    (req, res) => app.handleHttp(req, res),
    url,
    {},
    body === undefined ? undefined : JSON.stringify(body),
    method
  );
  return { app, call, setOrigin, json: (result) => JSON.parse(result.body) };
}

/**
 * A stand-in for the workspace MCP bridge: records what it receives and answers
 * from a queue (the last answer repeats).
 * @param {{status?: number, body?: object}[]} answers canned replies.
 */
async function fakeBridge(answers) {
  const seen = [];
  const queue = answers.slice();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: text ? JSON.parse(text) : null });
      const answer = queue.length > 1 ? queue.shift() : queue[0];
      res.writeHead((answer && answer.status) || 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify((answer && answer.body) || { ok: true }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    url: 'http://127.0.0.1:' + address.port,
    seen,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

test('meta: names the workspace MCP bridge so a dock can find it', async () => {
  const { app, call, json } = await start();
  const meta = json(await call('/quickdock/api/meta'));
  assert.deepStrictEqual(meta.mcpBridge, {
    enabled: true,
    origin: 'http://127.0.0.1:1234',
    route: '/workspace-mcp',
    tokenRequired: false
  });
  assert.strictEqual(app.mcpBridgeInfo().enabled, true);
});

test('mcp: a dock registers its endpoint and the Host forwards it with the token', async () => {
  const bridge = await fakeBridge([{
    body: {
      ok: true,
      registered: { name: 'vscode', workspace: 'C:\\work\\proj' },
      replaced: false,
      sessions: [{ sessionId: 's-1', state: 'connected' }]
    }
  }]);
  const { call, setOrigin, json } = await start({ mcpBridgeToken: 'secret' });
  setOrigin(bridge.url);
  try {
    const body = {
      workspace: 'C:\\work\\proj',
      url: 'http://127.0.0.1:7311/mcp',
      name: 'vscode',
      headers: { Authorization: 'Bearer local' },
      waitMs: 0
    };
    const result = await call('/quickdock/api/mcp-register', body);
    assert.strictEqual(result.status, 200);
    assert.deepStrictEqual(json(result).sessions, [{ sessionId: 's-1', state: 'connected' }]);

    assert.strictEqual(bridge.seen.length, 1);
    assert.strictEqual(bridge.seen[0].method, 'POST');
    assert.strictEqual(bridge.seen[0].url, '/workspace-mcp/register');
    assert.strictEqual(bridge.seen[0].headers['x-workspace-mcp-token'], 'secret');
    assert.deepStrictEqual(bridge.seen[0].body, body);
  } finally {
    await bridge.close();
  }
});

test('mcp: list and unregister reach the same bridge routes', async () => {
  const bridge = await fakeBridge([
    { body: { ok: true, workspaces: [{ workspace: 'C:\\work', servers: [{ name: 'vscode', url: 'http://127.0.0.1:7311/mcp' }] }] } },
    { body: { ok: true, workspace: 'C:\\work', removed: ['vscode'] } }
  ]);
  const { call, setOrigin, json } = await start();
  setOrigin(bridge.url);
  try {
    const listed = await call('/quickdock/api/mcp-list?workspace=' + encodeURIComponent('C:\\work'));
    assert.strictEqual(listed.status, 200);
    assert.strictEqual(json(listed).workspaces[0].servers[0].name, 'vscode');
    assert.strictEqual(bridge.seen[0].method, 'GET');
    assert.strictEqual(bridge.seen[0].url, '/workspace-mcp/list?workspace=C%3A%5Cwork');

    const removed = await call('/quickdock/api/mcp-unregister', { workspace: 'C:\\work', name: 'vscode' });
    assert.strictEqual(removed.status, 200);
    assert.deepStrictEqual(json(removed).removed, ['vscode']);
    assert.strictEqual(bridge.seen[1].url, '/workspace-mcp/unregister');
    assert.deepStrictEqual(bridge.seen[1].body, { workspace: 'C:\\work', name: 'vscode' });
  } finally {
    await bridge.close();
  }
});

test('mcp: a dock may describe its tools, and the bridge never sees them', async () => {
  const bridge = await fakeBridge([{ body: { ok: true, registered: { name: 'vscode' } } }]);
  const { call, setOrigin } = await start();
  setOrigin(bridge.url);
  try {
    const result = await call('/quickdock/api/mcp-register', {
      workspace: 'C:\\work\\proj',
      url: 'http://127.0.0.1:7311/mcp',
      name: 'vscode',
      version: '0.7.0',
      tools: ['vscode_search', 'vscode_read_file'],
      waitMs: 0
    });
    assert.strictEqual(result.status, 200);
    assert.deepStrictEqual(bridge.seen[0].body, {
      workspace: 'C:\\work\\proj',
      url: 'http://127.0.0.1:7311/mcp',
      name: 'vscode',
      waitMs: 0
    });
  } finally {
    await bridge.close();
  }
});

test('mcp: the panel lists what a dock published, with its live mount state', async () => {
  const bridge = await fakeBridge([
    { body: { ok: true, registered: { name: 'vscode' }, sessions: [] } },
    {
      body: {
        ok: true,
        workspaces: [{
          workspace: 'C:\\work\\proj',
          servers: [{
            name: 'vscode',
            workspace: 'C:\\work\\proj',
            url: 'http://127.0.0.1:7311/mcp',
            sessions: [{ sessionId: 's-1', state: 'connected' }, { sessionId: 's-2', state: 'connected' }]
          }]
        }]
      }
    }
  ]);
  const { call, setOrigin, json } = await start();
  setOrigin(bridge.url);
  try {
    await call('/quickdock/api/mcp-register', {
      workspace: 'C:\\work\\proj',
      url: 'http://127.0.0.1:7311/mcp',
      name: 'vscode',
      version: '0.7.0',
      tools: ['vscode_search', 'vscode_apply_edit']
    });

    const panel = await call('/quickdock/api/mcp-servers?workspace=' + encodeURIComponent('C:\\work\\proj'));
    assert.strictEqual(panel.status, 200);
    const answer = json(panel);
    assert.strictEqual(answer.servers.length, 1);
    assert.deepStrictEqual(answer.servers[0].tools, ['vscode_search', 'vscode_apply_edit']);
    assert.strictEqual(answer.servers[0].version, '0.7.0');
    assert.strictEqual(answer.servers[0].mounted.sessions, 2);
    assert.strictEqual(bridge.seen[1].url, '/workspace-mcp/list?workspace=C%3A%5Cwork%5Cproj');
  } finally {
    await bridge.close();
  }
});

test('mcp: an unregister takes the dock out of the panel too', async () => {
  const bridge = await fakeBridge([{ body: { ok: true } }]);
  const { call, setOrigin, json } = await start();
  setOrigin(bridge.url);
  try {
    await call('/quickdock/api/mcp-register', {
      workspace: 'C:\\work\\proj',
      url: 'http://127.0.0.1:7311/mcp',
      name: 'vscode',
      tools: ['vscode_search']
    });
    assert.strictEqual(json(await call('/quickdock/api/mcp-servers?workspace=' + encodeURIComponent('C:\\work\\proj'))).servers.length, 1);

    await call('/quickdock/api/mcp-unregister', { workspace: 'C:\\work\\proj', name: 'vscode' });
    assert.deepStrictEqual(json(await call('/quickdock/api/mcp-servers?workspace=' + encodeURIComponent('C:\\work\\proj'))).servers, []);
  } finally {
    await bridge.close();
  }
});

test('mcp: a rejected registration keeps the bridge’s own explanation', async () => {
  const bridge = await fakeBridge([{
    status: 400,
    body: { ok: false, error: 'workspace must be absolute: proj' }
  }]);
  const { call, setOrigin, json } = await start();
  setOrigin(bridge.url);
  try {
    const result = await call('/quickdock/api/mcp-register', { workspace: 'proj', url: 'http://127.0.0.1:7311/mcp' });
    assert.strictEqual(result.status, 400);
    assert.match(json(result).error, /workspace must be absolute: proj/);
  } finally {
    await bridge.close();
  }
});

test('mcp: an unreachable bridge is a readable error, not a hang', async () => {
  const { call, setOrigin, json } = await start();
  setOrigin('http://127.0.0.1:1');
  const result = await call('/quickdock/api/mcp-register', { workspace: 'C:\\work', url: 'http://127.0.0.1:7311/mcp' });
  assert.strictEqual(result.status, 400);
  assert.match(json(result).error, /workspace-mcp register failed/);
});

test('mcp: a composition with the bridge disabled says so', async () => {
  const { call, json } = await start({ mcpBridge: false });
  const meta = json(await call('/quickdock/api/meta'));
  assert.strictEqual(meta.mcpBridge.enabled, false);
  const result = await call('/quickdock/api/mcp-register', { workspace: 'C:\\work', url: 'http://127.0.0.1:7311/mcp' });
  assert.strictEqual(result.status, 400);
  assert.match(json(result).error, /mcpBridge: false/);
});

test('dock-mcp: an origin is a scheme, a host and a port', async () => {
  const { bridgeOrigin } = await import(pathToFileURL(path.join(__dirname, '..', '..', 'host', 'dock-mcp.js')).href);
  assert.strictEqual(bridgeOrigin('http://127.0.0.1:58935/?token=x'), 'http://127.0.0.1:58935');
  assert.strictEqual(bridgeOrigin('https://dsh.example/quickdock'), 'https://dsh.example');
  assert.strictEqual(bridgeOrigin(''), null);
  assert.strictEqual(bridgeOrigin(undefined), null);
  assert.strictEqual(bridgeOrigin('not a url'), null);
});
