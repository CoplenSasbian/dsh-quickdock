'use strict';

/**
 * The app proxy embedded views load DSH from.
 *
 * DSH's page authentication is a token redirect plus a `SameSite=Strict` cookie,
 * which a third-party context never carries. The proxy has to play the browser's
 * part: take the token once, keep the cookie, and retry with the token when the
 * cookie goes stale (DSH restarted).
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const PROXY = pathToFileURL(path.join(__dirname, '..', '..', 'host', 'app-proxy.js')).href;

/** Listen on an ephemeral loopback port. */
function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/** Close a test server and every connection it kept alive. */
function close(server) {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

test('app proxy: the token unlocks the page and the cookie it mints is kept', async () => {
  const requests = [];
  const app = await listen((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const cookie = String(request.headers.cookie || '');
    requests.push({ url: request.url, cookie, token: url.searchParams.get('token') });
    if (url.searchParams.has('token') && !cookie) {
      response.writeHead(303, {
        location: './',
        'set-cookie': 'dsh-auth-abc=1; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict'
      });
      response.end();
      return;
    }
    if (!cookie) {
      response.writeHead(401, { 'Content-Type': 'text/plain' });
      response.end('dsh web authentication required');
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<html><body>app through the proxy</body></html>');
  });

  const { startAppProxy } = await import(PROXY);
  const proxy = await startAppProxy({ upstreamUrl: `http://127.0.0.1:${app.port}/?token=secret&dock=1` });
  try {
    const page = await fetch(proxy.origin + '/', { headers: { accept: 'text/html' } });
    assert.strictEqual(page.status, 200);
    assert.match(await page.text(), /app through the proxy/);
    // The webview never sees the cookie, and the token never appears in its URL.
    assert.strictEqual(page.headers.get('set-cookie'), null);
    assert.strictEqual(requests[0].token, 'secret');
    assert.strictEqual(requests[0].url, '/?token=secret&dock=1');
    assert.strictEqual(requests.at(-1).token, null);
    assert.match(requests.at(-1).cookie, /^dsh-auth-abc=1/);
  } finally {
    proxy.dispose();
    await close(app.server);
  }
});

test('app proxy: API calls pass through untouched', async () => {
  const requests = [];
  const app = await listen((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      requests.push({
        method: request.method,
        url: request.url,
        body: Buffer.concat(chunks).toString('utf8'),
        cookie: request.headers.cookie || ''
      });
      response.writeHead(201, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
    });
  });

  const { startAppProxy } = await import(PROXY);
  const proxy = await startAppProxy({ upstreamUrl: `http://127.0.0.1:${app.port}/?token=secret&dock=1` });
  try {
    const response = await fetch(proxy.origin + '/api/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ hello: 'world' })
    });
    assert.strictEqual(response.status, 201);
    assert.deepStrictEqual(requests.at(-1), {
      method: 'POST',
      url: '/api/echo',
      body: '{"hello":"world"}',
      cookie: ''
    });
  } finally {
    proxy.dispose();
    await close(app.server);
  }
});

test('app proxy: a stale cookie is dropped and the token is used again', async () => {
  let valid = 'dsh-auth-abc=1';
  const requests = [];
  const app = await listen((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const cookie = String(request.headers.cookie || '');
    requests.push({ url: request.url, cookie });
    if (url.searchParams.has('token')) {
      response.writeHead(303, { location: './', 'set-cookie': `${valid}; Path=/; HttpOnly; SameSite=Strict` });
      response.end();
      return;
    }
    if (cookie !== valid) {
      response.writeHead(401, { 'Content-Type': 'text/plain' });
      response.end('expired');
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<html>ok</html>');
  });

  const { startAppProxy } = await import(PROXY);
  const proxy = await startAppProxy({ upstreamUrl: `http://127.0.0.1:${app.port}/?token=secret&dock=1` });
  try {
    const first = await fetch(proxy.origin + '/', { headers: { accept: 'text/html' } });
    assert.strictEqual(first.status, 200);
    assert.strictEqual(requests.at(-1).cookie, 'dsh-auth-abc=1');

    // DSH restarted with a new signing key: the held cookie no longer works.
    valid = 'dsh-auth-rotated=1';
    requests.length = 0;
    const second = await fetch(proxy.origin + '/', { headers: { accept: 'text/html' } });
    assert.strictEqual(second.status, 200);
    assert.ok(requests.some((entry) => entry.url.includes('token=secret')));
    assert.strictEqual(requests.at(-1).cookie, 'dsh-auth-rotated=1');
  } finally {
    proxy.dispose();
    await close(app.server);
  }
});

test('app proxy: an unreachable app is a 502, not a crash', async () => {
  const { startAppProxy } = await import(PROXY);
  const proxy = await startAppProxy({ upstreamUrl: 'http://127.0.0.1:9/?token=x&dock=1' });
  try {
    const response = await fetch(proxy.origin + '/');
    assert.strictEqual(response.status, 502);
  } finally {
    proxy.dispose();
  }
});
