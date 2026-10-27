/**
 * QuickDock 本地调试宿主（不是生产代码，只用来在没有完整 DSH 的环境里验证宿主半）。
 *
 * 用法：
 *   node --import ./scripts/register-hook.mjs scripts/dev-harness.mjs
 *
 * 环境变量：
 *   QD_PORT         固定端口（默认随机）
 *   QD_NO_ELECTRON=1 不真的 spawn Electron（只验证 API 层）
 */
import http from 'node:http'
import { apply } from '../index.js'

const listenPort = Number(process.env.QD_PORT || 0)

const sessionsStore = new Map()
const workspaces = [
  // s-cold 故意**不**放进 sessionsStore：模拟"没在当前进程里打开过"的冷会话
  { id: 'ws-demo', title: 'dsh-quickdock', path: 'D:/node/dsh-quickdock', sessionIds: ['s-demo', 's-cold'] },
  { id: 'ws-other', title: 'another-workspace', path: 'D:/node/another', sessionIds: ['s-other'] }
]
const liveAgents = new Map()
const calls = []
const eventHandlers = new Map()

function record(name, payload) {
  calls.push({ name, payload, at: Date.now() })
  console.log('[mock] ' + name + ' ' + JSON.stringify(payload ?? {}))
}

function makeSession(id, title) {
  return {
    id,
    title,
    permission: 'workspace-write',
    header: { cwd: 'D:/node/dsh-quickdock', createdAt: Date.now() - 3600_000 }
  }
}
sessionsStore.set('s-demo', makeSession('s-demo', '把 QuickDock 接进 DSH'))
sessionsStore.set('s-other', makeSession('s-other', '另一个工作区里的会话'))

const MODEL_CATALOG = {
  default: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' },
  routableProviders: ['deepseek-official'],
  groups: [{
    id: 'deepseek-official',
    name: 'DeepSeek',
    models: [
      { id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash', reasoning: { efforts: [{ id: 'high', name: '高' }, { id: 'max', name: '最高' }], defaultEffort: 'high' } },
      { id: 'deepseek-pro', name: 'DeepSeek Pro', reasoning: { efforts: [{ id: 'low', name: '低' }, { id: 'high', name: '高' }], defaultEffort: 'high' } }
    ]
  }],
  failures: []
}

const PERMISSION_CATALOG = {
  options: [
    { value: 'read-only', name: '只读', description: '只能读取，不能修改文件' },
    { value: 'workspace-write', name: '工作区写入', description: '可在工作区内修改文件' },
    { value: 'danger-full-access', name: '完全访问', description: '不限制文件与命令' }
  ],
  defaultOptions: [],
  defaultPreset: 'workspace-write'
}

const sessionController = {
  async create(request) {
    record('sessionController.create', request)
    const id = 's-new-' + Math.random().toString(36).slice(2, 8)
    sessionsStore.set(id, makeSession(id, '新会话'))
    workspaces[0].sessionIds.push(id)
    return { sessionId: id }
  },
  async fork(request) {
    record('sessionController.fork', request)
    const id = 's-fork-' + Math.random().toString(36).slice(2, 8)
    sessionsStore.set(id, makeSession(id, '分叉会话'))
    return { sessionId: id }
  },
  async prompt(request, signal) {
    // 与真实 DSH 一致：prompt 的第一件事就是 signal.throwIfAborted()，
    // 传 undefined 会抛 TypeError，最终变成空 body 的 400。
    if (!signal || typeof signal.throwIfAborted !== 'function') {
      throw new Error('sessionController.prompt requires an AbortSignal as the second argument')
    }
    signal.throwIfAborted()
    record('sessionController.prompt', request)
    liveAgents.set(request.sessionId, { id: request.sessionId, status: 'running' })
    return { accepted: true }
  },
  async cancel(request) {
    record('sessionController.cancel', request)
    liveAgents.delete(request.sessionId)
    return { accepted: true }
  },
  async selectModel(request) {
    record('sessionController.selectModel', request)
    return { selected: { provider: request.provider, model: request.model, reasoningEffort: request.reasoningEffort } }
  },
  async modelCatalog() {
    record('sessionController.modelCatalog')
    return MODEL_CATALOG
  },
  /** 冷安全列表：真实 DSH 里标题来自投影缓存，冷会话同样有。 */
  async list() {
    record('sessionController.list')
    const rows = []
    for (const w of workspaces) {
      for (const id of w.sessionIds) {
        const live = sessionsStore.get(id)
        if (live) {
          rows.push({
            sessionId: id,
            updatedAt: Date.now() - 60_000,
            running: liveAgents.get(id)?.status === 'running',
            blank: false,
            cwd: w.path,
            projections: { values: { title: live.title, sessionListMetadata: { blank: false, lastPromptAt: Date.now() - 60_000 } } }
          })
        } else {
          // 冷会话：sessions 里没有它，但 list 仍然给出标题
          rows.push({
            sessionId: id,
            updatedAt: Date.now() - 7200_000,
            running: false,
            blank: false,
            cwd: w.path,
            projections: { values: { title: '冷会话也应有标题', sessionListMetadata: { blank: false, lastPromptAt: Date.now() - 7200_000 } } }
          })
        }
      }
    }
    return rows
  }
}

const permissionPresets = {
  catalog() { return PERMISSION_CATALOG },
  current(session) { return session?.permission || 'workspace-write' },
  set(session, name) {
    record('permissionPresets.set', { sessionId: session?.id, name })
    if (!session) throw new Error('session required')
    session.permission = name
  }
}

const services = {
  sessions: { get: (id) => sessionsStore.get(id) },
  workspaceRegistry: { list: () => workspaces, archivedSessionIds: [] },
  sessionController,
  permissionPresets,
  agentPresets: {
    async list() {
      record('agentPresets.list')
      return [{ id: 'default', name: '默认' }, { id: 'reviewer', name: '审查员', description: '只读审查' }]
    }
  },
  agents: {
    get: (id) => liveAgents.get(id),
    list: () => [...liveAgents.values()]
  },
  sessionProjections: {
    snapshot: (session, keys) => {
      const values = {}
      if (keys?.includes('title')) values.title = session?.title
      return { values }
    },
    stateOf: (_session, key) => (key === 'modelSelection'
      ? { lastUsed: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' }, pending: null }
      : undefined)
  }
}

let webServer = null
let connection = null

const ctx = {
  logger: {
    info: (...args) => console.log('[log]', ...args),
    warn: (...args) => console.log('[warn]', ...args),
    error: (...args) => console.log('[error]', ...args)
  },
  get(name) {
    if (name === 'webServer') return webServer
    if (name === 'connection') return connection
    return services[name]
  },
  on(event, handler) {
    const list = eventHandlers.get(event) || []
    list.push(handler)
    eventHandlers.set(event, list)
    return () => {}
  },
  effect(callback, label) {
    const disposer = callback()
    record('ctx.effect', label)
    return () => { if (typeof disposer === 'function') disposer() }
  }
}

/* ---------------- HTTP 服务 ---------------- */
let origin = ''
const routes = []
const fetchRoutes = new Map()

const server = http.createServer((req, res) => {
  const url = new URL(req.url, origin || 'http://127.0.0.1')
  for (const route of routes) {
    if (url.pathname === route.path || url.pathname.startsWith(route.path + '/')) {
      return route.handler(req, res)
    }
  }
  if (url.pathname.startsWith('/test/')) return testRoutes(req, res, url)
  res.writeHead(404, { 'Content-Type': 'text/plain' })
  res.end('not found')
})

webServer = {
  getOrigin: () => origin,
  register(route) {
    routes.push({ path: route.path, handler: route.handler })
    record('webServer.register', route.path)
    return () => {}
  }
}

connection = {
  fetch: {
    register(route) {
      fetchRoutes.set(route.path, route)
      record('connection.fetch.register', route.path)
      return () => {}
    }
  }
}

// DSH 里这两个服务是通过 inject 直接挂在 ctx 上的（ctx.webServer / ctx.connection）
Object.defineProperty(ctx, 'webServer', { get: () => webServer, enumerable: true })
Object.defineProperty(ctx, 'connection', { get: () => connection, enumerable: true })

function readJson(req) {
  return new Promise((resolve) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}) } catch { resolve({}) } })
  })
}

async function bridge(action, payload) {
  const route = fetchRoutes.get('/api/quickdock')
  if (!route) return { error: 'bridge not registered' }
  const request = new Request('http://harness/api/quickdock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...(payload || {}) })
  })
  const response = await route.fetch(request)
  return response.json()
}

async function testRoutes(req, res, url) {
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }
  if (url.pathname === '/test/calls') return send(200, calls)
  if (url.pathname === '/test/calls/reset') { calls.length = 0; return send(200, { ok: true }) }
  if (url.pathname === '/test/web-url') return send(200, await bridge('web-url'))
  if (url.pathname === '/test/summon') return send(200, await bridge('summon'))
  if (url.pathname === '/test/theme') {
    const body = await readJson(req)
    return send(200, await bridge('theme', { theme: body }))
  }
  if (url.pathname === '/test/bind') {
    const body = await readJson(req)
    return send(200, await bridge('bind', { sessionId: body.sessionId || 's-demo' }))
  }
  if (url.pathname === '/test/status') {
    const body = await readJson(req)
    liveAgents.set(body.sessionId, { id: body.sessionId, status: body.status })
    for (const handler of eventHandlers.get('agent/status') || []) {
      handler({ agent: { id: body.sessionId, status: body.status } })
    }
    return send(200, { ok: true })
  }
  if (url.pathname === '/test/stream') {
    const body = await readJson(req)
    const agent = { id: body.sessionId || 's-demo' }
    for (const handler of eventHandlers.get('agent/assistant-stream') || []) {
      handler({ agent, frame: body.frame })
    }
    return send(200, { ok: true })
  }
  if (url.pathname === '/test/event') {
    const body = await readJson(req)
    for (const handler of eventHandlers.get('session/event') || []) {
      handler(sessionsStore.get(body.sessionId || 's-demo') || { id: 's-demo' }, body.event)
    }
    return send(200, { ok: true })
  }
  if (url.pathname === '/test/approval') {
    const body = await readJson(req)
    const request = {
      agent: { id: body.sessionId || 's-demo' },
      toolName: body.toolName || 'bash',
      reason: body.reason || '写入受限目录',
      callId: 'call-1'
    }
    let result = 'unavailable'
    for (const handler of eventHandlers.get('approval/request') || []) {
      let delegated = false
      const value = await handler(request, () => { delegated = true; return Promise.resolve('unavailable') })
      if (!delegated && typeof value === 'string') { result = value; break }
    }
    return send(200, { result })
  }
  if (url.pathname === '/test/question') {
    const body = await readJson(req)
    const request = {
      agent: { id: body.sessionId || 's-demo' },
      questions: body.questions || [{ id: 'q1', question: '用哪种方案？', options: [{ label: 'A' }, { label: 'B' }] }]
    }
    let result = null
    for (const handler of eventHandlers.get('user-questions/request') || []) {
      let delegated = false
      const value = await handler(request, () => { delegated = true; return Promise.resolve({ pending: true }) })
      if (!delegated) { result = value; break }
    }
    return send(200, { result })
  }
  return send(404, { error: 'unknown test route' })
}

server.listen(listenPort, '127.0.0.1', () => {
  origin = 'http://127.0.0.1:' + server.address().port
  const config = {
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
    defaultWorkspaceId: 'ws-demo',
    agentPreset: '',
    submitMode: 'queue',
    thinkMode: 'fold',
    showTiming: true,
    maxSteps: 200,
    theme: 'auto',
    headerButton: true,
    headerButtonOrder: 1010,
    approvalTimeoutMs: 300000
  }
  if (process.env.QD_NO_ELECTRON === '1') process.env.DSH_QUICKDOCK_ELECTRON_PATH = 'Z:\\__missing__'
  apply(ctx, config)
  console.log('\nQuickDock harness ready at ' + origin)
  bridge('web-url').then((result) => {
    console.log('  page: ' + (result.url || '(unavailable)'))
    console.log('  test: ' + origin + '/test/calls')
    console.log('')
  })
})
