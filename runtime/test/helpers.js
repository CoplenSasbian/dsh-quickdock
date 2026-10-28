'use strict';

/**
 * Shared fixtures for the Host-half tests: a minimal DSH context, a config
 * factory and tiny HTTP/Response helpers. Keeping them here lets every test
 * file exercise the same wiring.
 */

const path = require('node:path');
const { pathToFileURL } = require('node:url');

const INDEX = pathToFileURL(path.join(__dirname, '..', '..', 'index.js')).href;

/** Build a mock ctx that records routes, listeners and listener options. */
function createContext() {
  const routes = [];
  const fetchRoutes = new Map();
  const events = new Map();
  const listenerOptions = new Map();
  let origin = 'http://127.0.0.1:1234';

  const services = {
    sessions: { get: () => undefined },
    workspaceRegistry: { list: () => [], archivedSessionIds: [] },
    agents: { get: () => undefined, list: () => [] },
    sessionProjections: { snapshot: () => ({ values: {} }), stateOf: () => undefined },
    sessionController: {
      async create() { return { sessionId: 's-x' }; },
      async prompt() { return { accepted: true }; },
      async cancel() { return { accepted: true }; },
      async fork() { return { sessionId: 's-y' }; },
      async selectModel() { return { selected: {} }; },
      async modelCatalog() { return { default: undefined, groups: [] }; },
      async list() { return []; }
    },
    permissionPresets: {
      catalog: () => ({ options: [{ value: 'workspace-write', name: 'workspace write' }], defaultPreset: 'workspace-write' }),
      current: () => 'workspace-write',
      set: () => {}
    },
    agentPresets: { list: async () => [] }
  };

  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get(name) { return services[name]; },
    on(event, handler, options) {
      const list = events.get(event) || [];
      list.push(handler);
      events.set(event, list);
      const opts = listenerOptions.get(event) || [];
      opts.push(options);
      listenerOptions.set(event, opts);
      return () => {};
    },
    effect(callback) {
      const dispose = callback();
      return () => { if (typeof dispose === 'function') dispose(); };
    }
  };

  ctx.webServer = {
    getOrigin: () => origin,
    register(route) {
      routes.push({ path: route.path, handler: route.handler });
      return () => {};
    }
  };
  ctx.connection = {
    fetch: {
      register(route) {
        fetchRoutes.set(route.path, route);
        return () => {};
      }
    }
  };

  return { ctx, routes, fetchRoutes, events, listenerOptions, services, setOrigin: (value) => { origin = value; } };
}

/** Plugin config with test defaults (mirrors the schema in index.js). */
function config(overrides) {
  return Object.assign({
    enabled: true,
    autoLaunch: false,
    width: 480,
    inputHeight: 172,
    displayHeight: 520,
    margin: 16,
    rememberGeometry: false,
    alwaysOnTop: false,
    focusOnSummon: false,
    hideOnEscape: true,
    followBoundOnly: true,
    defaultWorkspaceId: '',
    agentPreset: '',
    submitMode: 'queue',
    thinkMode: 'fold',
    showTiming: true,
    maxSteps: 200,
    theme: 'auto',
    locale: 'auto',
    headerButton: true,
    headerButtonOrder: 1010,
    approvalTimeoutMs: 300000
  }, overrides || {});
}

/** Invoke a page/API handler with a minimal req/res pair and collect the body. */
function invoke(handler, url, headers, rawBody) {
  return new Promise((resolve) => {
    const chunks = [];
    const body = rawBody === undefined ? '' : String(rawBody);
    const req = {
      url,
      method: body ? 'POST' : 'GET',
      headers: headers || {},
      async *[Symbol.asyncIterator]() {
        if (body) yield Buffer.from(body);
      }
    };
    const res = {
      statusCode: 0,
      headers: {},
      writeHead(code, head) { this.statusCode = code; this.headers = head || {}; return this; },
      write(chunk) { chunks.push(String(chunk)); return true; },
      end(chunk) {
        if (chunk !== undefined) chunks.push(String(chunk));
        resolve({ status: this.statusCode, body: chunks.join('') });
      }
    };
    handler(req, res);
  });
}

/** Call the browser bridge and return parsed JSON. */
async function bridgeCall(fetchRoutes, action, payload) {
  const route = fetchRoutes.get('/api/quickdock');
  const response = await route.fetch(new Request('http://x/api/quickdock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ action }, payload || {}))
  }));
  return response.json();
}

/** Tokenized page URL from the bridge (the entry a browser would use). */
async function pageUrl(fetchRoutes) {
  const result = await bridgeCall(fetchRoutes, 'web-url');
  return result.url;
}

module.exports = { INDEX, bridgeCall, config, createContext, invoke, pageUrl };
