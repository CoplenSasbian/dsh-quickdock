'use strict';

/**
 * 宿主半的冒烟测试：apply() 能不能装配起来、页面/接口的鉴权是否正确。
 *
 * 这里**不触发 dock 进程**（那需要真 Electron），只验证宿主侧的路由与状态。
 * 端到端（spawn → ready → 控制通道）用 scripts/dev-harness.mjs 手工跑。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const INDEX = pathToFileURL(path.join(__dirname, '..', '..', 'index.js')).href;

function createContext() {
  const routes = [];
  const fetchRoutes = new Map();
  const events = new Map();
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
      async modelCatalog() { return { default: undefined, groups: [] }; }
    },
    permissionPresets: {
      catalog: () => ({ options: [{ value: 'workspace-write', name: '工作区写入' }], defaultPreset: 'workspace-write' }),
      current: () => 'workspace-write',
      set: () => {}
    },
    agentPresets: { list: async () => [] }
  };

  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get(name) { return services[name]; },
    on(event, handler) {
      const list = events.get(event) || [];
      list.push(handler);
      events.set(event, list);
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

  return { ctx, routes, fetchRoutes, events, setOrigin: (value) => { origin = value; } };
}

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
    headerButton: true,
    headerButtonOrder: 1010,
    approvalTimeoutMs: 300000
  }, overrides || {});
}

/** 把处理函数包成一个最小的 res 对象，收集 status/body。 */
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
      end(chunk) { if (chunk !== undefined) chunks.push(String(chunk)); resolve({ status: this.statusCode, body: chunks.join('') }); }
    };
    handler(req, res);
  });
}

test('apply() 装配页面与接口路由', async () => {
  const { apply } = await import(INDEX);
  const { ctx, routes, fetchRoutes } = createContext();
  apply(ctx, config());
  assert.ok(routes.some((r) => r.path === '/quickdock'), '应注册 /quickdock 页面路由');
  assert.ok(fetchRoutes.has('/api/quickdock'), '应注册客户端桥接路由');
});

test('页面：token 正确才返回 HTML，错误 token 返回 403', async () => {
  const { apply } = await import(INDEX);
  const { ctx, routes, fetchRoutes } = createContext();
  apply(ctx, config());
  const handler = routes.find((r) => r.path === '/quickdock').handler;

  // 从桥接路由拿带 token 的页面地址（浏览器用户看到的是同一个入口）
  const webUrl = await bridgeUrlWith(fetchRoutes);
  const token = new URL(webUrl).searchParams.get('t');
  assert.ok(token && token.length > 20, '页面地址应带一次性 token');

  const okPage = await invoke(handler, '/quickdock?t=' + token, {});
  assert.strictEqual(okPage.status, 200);
  assert.match(okPage.body, /QuickDock/);
  assert.match(okPage.body, /--qd-bg-base/, '页面应内联主题变量');

  const denied = await invoke(handler, '/quickdock?t=wrong', {});
  assert.strictEqual(denied.status, 403);
});

test('接口：未带 token 返回 401，带 token 返回状态', async () => {
  const { apply } = await import(INDEX);
  const { ctx, routes, fetchRoutes } = createContext();
  apply(ctx, config());
  const handler = routes.find((r) => r.path === '/quickdock').handler;

  const unauthorized = await invoke(handler, '/quickdock/api/state', {});
  assert.strictEqual(unauthorized.status, 401);

  const webUrl = await bridgeUrlWith(fetchRoutes);
  const token = new URL(webUrl).searchParams.get('t');
  const authorized = await invoke(handler, '/quickdock/api/state?t=' + token, {});
  assert.strictEqual(authorized.status, 200);
  const state = JSON.parse(authorized.body);
  assert.strictEqual(state.sessionId, null);
  assert.strictEqual(state.status, 'idle');
  assert.ok(Array.isArray(state.catalogs.permissions), '权限目录应是数组');
});

async function bridgeUrlWith(fetchRoutes) {
  const route = fetchRoutes.get('/api/quickdock');
  const response = await route.fetch(new Request('http://x/api/quickdock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'web-url' })
  }));
  const body = await response.json();
  return body.url;
}

test('接口：失败时返回可读的 JSON 错误（不是空 400）', async () => {
  const { apply } = await import(INDEX);
  const { ctx, routes, fetchRoutes } = createContext();
  apply(ctx, config());
  const handler = routes.find((r) => r.path === '/quickdock').handler;
  const token = new URL(await bridgeUrlWith(fetchRoutes)).searchParams.get('t');

  const res = await invoke(handler, '/quickdock/api/task?t=' + token, {
    authorization: 'Bearer ' + token
  }, JSON.stringify({ text: '' }));
  assert.strictEqual(res.status, 400);
  const body = JSON.parse(res.body);
  assert.strictEqual(body.ok, false);
  assert.ok(body.error && body.error.length > 0, '错误响应必须带原因');
});

test('主题：只有 6 个以上已知 token 才被采纳', async () => {
  const { apply } = await import(INDEX);
  const { ctx, routes, fetchRoutes } = createContext();
  apply(ctx, config());
  const handler = routes.find((r) => r.path === '/quickdock').handler;
  const token = new URL(await bridgeUrlWith(fetchRoutes)).searchParams.get('t');

  const bridge = async (theme) => {
    const route = fetchRoutes.get('/api/quickdock');
    const response = await route.fetch(new Request('http://x/api/quickdock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'theme', theme })
    }));
    return response.json();
  };

  assert.strictEqual((await bridge({ tokens: { '--dsw-alias-bg-base': '#000' } })).ok, false, 'token 太少应拒绝');

  const ok = await bridge({
    colorScheme: 'light',
    tokens: {
      '--dsw-alias-bg-base': '#ffffff',
      '--dsw-alias-bg-layer-1': '#f6f7f8',
      '--dsw-alias-bg-layer-2': '#f0f1f3',
      '--dsw-alias-border-l1': '#e3e4e6',
      '--dsw-alias-label-primary': '#1c1c1e',
      '--dsw-alias-label-secondary': '#5f6066',
      '--dsw-alias-brand-primary': '#2b6cf6'
    }
  });
  assert.strictEqual(ok.ok, true);

  // 采纳后页面应带上深/浅标记与映射后的 --qd-* 变量
  const page = await invoke(handler, '/quickdock?t=' + token, {});
  assert.match(page.body, /data-theme="light"/);
  assert.match(page.body, /--qd-bg-base: #ffffff/);
});
