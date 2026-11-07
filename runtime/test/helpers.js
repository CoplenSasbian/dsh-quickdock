'use strict';

/**
 * Shared fixtures for the Host-half tests: a minimal DSH context, a config
 * factory and tiny HTTP/Response helpers. Keeping them here lets every test
 * file exercise the same wiring.
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

// The Host keeps config.json and host.log in its state directory. Point it at a
// scratch copy seeded with `port: 0`: a real config.json would win over the row
// value and make the suite open a listener.
const stateRoot = path.join(os.tmpdir(), 'dsh-quickdock-test-state');
process.env.DSH_QUICKDOCK_STATE_DIR = stateRoot;
try {
  fs.mkdirSync(stateRoot, { recursive: true });
  fs.writeFileSync(path.join(stateRoot, 'config.json'), JSON.stringify({ port: 0 }));
} catch (_) {
  /* the row config still keeps the listener off */
}

// A unit test must never launch (or download) a real Electron: a missing explicit
// path makes an accidental dock spawn fail fast instead of starting the machine's
// install. Tests that exercise the resolver pass their own env.
process.env.DSH_QUICKDOCK_ELECTRON_PATH = process.env.DSH_QUICKDOCK_ELECTRON_PATH || 'Z:\\__no_electron__';

// The package row mounts nothing: the components live in service.js/dock.js.
// Tests exercise the service component through this alias, so `dock: true` can
// still mount both when a test needs the windows.
const INDEX = pathToFileURL(path.join(__dirname, '..', '..', 'service.js')).href;

/** Build a mock ctx that records routes, listeners and listener options. */
function createContext() {
  const routes = [];
  const fetchRoutes = new Map();
  const events = new Map();
  const listenerOptions = new Map();
  let origin = 'http://127.0.0.1:1234';

  const services = {
    webApp: { getAdvertisedUrl: () => origin },
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
    // The shell hands the iframe a tokenised URL; tests only need the shape.
    authenticatedUrl: (base) => base + '/?token=test-token',
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
    inputHeight: 820,
    margin: 16,
    rememberGeometry: false,
    alwaysOnTop: false,
    focusOnSummon: false,
    theme: 'auto',
    locale: 'auto',
    headerButton: true,
    headerButtonOrder: 1010,
    // 0 keeps the loopback listener off: tests call host.handleHttp directly and
    // must not bind a port (the files run in parallel).
    port: 0,
    // Never download or launch a real Electron binary from a unit test.
    prefetchElectron: false,
    clickThrough: false,
    windowControls: 'system'
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
      setHeader(name, value) { this.headers[String(name)] = value; return this; },
      getHeader(name) { return this.headers[String(name)]; },
      writeHead(code, head) {
        this.statusCode = code;
        this.headers = Object.assign({}, this.headers, head || {});
        return this;
      },
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
