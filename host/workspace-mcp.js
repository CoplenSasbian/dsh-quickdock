/**
 * Workspace-scoped MCP bridge (Host half of QuickDock).
 *
 * A local dock — an editor extension, a companion app, anything that speaks the
 * Model Context Protocol — announces its MCP endpoint together with the working
 * directory it belongs to:
 *
 *   POST /workspace-mcp/register
 *   { "workspace": "C:\\work\\proj", "url": "http://127.0.0.1:7311/mcp", "name": "vscode" }
 *
 * Every DSH session whose working directory is that directory, or sits below
 * it, mounts its own `dsh-mcp-client` instance on the agent scope, so exactly
 * those sessions get the server's `mcp__<name>__*` tools. Sessions outside the
 * directory never see them, and the profile's global MCP fleet is untouched.
 *
 * Mounted by the package's own row (`ctx.plugin` from index.js), so QuickDock
 * stays one bundle: no second package, no second patch row.
 *
 * @module dsh-quickdock/host/workspace-mcp
 */

import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { isAbsolute, dirname, join, posix, resolve as resolvePath, sep, win32 } from 'node:path'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'workspace-mcp'

/** HTTP route the dock calls; the registered route is a prefix of this path. */
const ROUTE = '/workspace-mcp'

/** `serverName` contract shared with `dsh-mcp-client`. */
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/** Default per-connection budget handed to `dsh-mcp-client`. */
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000

/** Largest accepted request body, in bytes. */
const BODY_LIMIT = 512 * 1024

/** Ceiling on how long one register call waits for live sessions. */
const WAIT_LIMIT_MS = 60_000

/** Build marker surfaced by the diagnostics route. */
const REVISION = 3

/**
 * Candidate roots of the running installation, most authoritative first. The
 * Host sets `DSH_INSTALL_DIR` for shell tool calls, not for its own process, so
 * a packaged Desktop app is also located through Electron's resources path.
 * @returns existing-looking install anchors.
 */
function installAnchors() {
  const anchors = []
  const push = (candidate) => {
    if (typeof candidate === 'string' && candidate.length > 0 && !anchors.includes(candidate)) anchors.push(candidate)
  }
  push(process.env.DSH_INSTALL_DIR)
  const packaged = 'app.asar/dsh/node_modules/@deepseek-ai/dsh'
  if (typeof process.resourcesPath === 'string' && process.resourcesPath.length > 0) {
    push(join(process.resourcesPath, ...packaged.split('/')))
  }
  push(join(dirname(process.execPath), 'resources', ...packaged.split('/')))
  return anchors
}

/**
 * Normalize plugin configuration.
 * @param {Record<string, unknown> | undefined} config - the Loader row's config.
 * @returns resolved options.
 */
function resolveOptions(config) {
  const raw = config ?? {}
  return {
    token: typeof raw.token === 'string' && raw.token.length > 0 ? raw.token : null,
    startupTimeoutMs: Number.isFinite(raw.startupTimeoutMs) ? raw.startupTimeoutMs : DEFAULT_STARTUP_TIMEOUT_MS,
    waitForSessionsMs: Number.isFinite(raw.waitForSessionsMs) ? raw.waitForSessionsMs : 15_000,
    maxSessionsPerServer: Number.isFinite(raw.maxSessionsPerServer) ? raw.maxSessionsPerServer : 32,
  }
}

/** Path semantics for the running platform. */
function paths() {
  return process.platform === 'win32' ? win32 : posix
}

/**
 * Resolve one directory to an absolute path without a trailing separator.
 * @param {string} input - dock-supplied directory.
 * @returns absolute path.
 * @throws when the value is not a non-empty absolute path.
 */
function absoluteDirectory(input) {
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw new Error('workspace must be a non-empty absolute directory')
  }
  if (!isAbsolute(input)) throw new Error(`workspace must be absolute: ${input}`)
  const dialect = paths()
  const resolved = dialect.resolve(input)
  const root = dialect.parse(resolved).root
  return resolved.length > root.length ? resolved.replace(/[\\/]+$/, '') : resolved
}

/**
 * Stable map key for one directory; Windows paths compare case-insensitively.
 * @param {string} directory - absolute path.
 * @returns comparison key.
 */
function directoryKey(directory) {
  return process.platform === 'win32' ? directory.toLowerCase() : directory
}

/**
 * Whether a session directory lives inside a registered workspace directory.
 * @param {string} workspaceKey - `directoryKey` of the workspace.
 * @param {string} cwdKey - `directoryKey` of the session directory.
 * @returns true for the directory itself and every descendant.
 */
function covers(workspaceKey, cwdKey) {
  if (cwdKey.length === 0) return false
  if (cwdKey === workspaceKey) return true
  const boundary = workspaceKey.endsWith('/') || workspaceKey.endsWith(sep) ? workspaceKey : workspaceKey + sep
  return cwdKey.startsWith(boundary)
}

/**
 * Short stable hash used to disambiguate generated server names.
 * @param {string} text - source text.
 * @returns 6 lowercase hex characters.
 */
function shortHash(text) {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0').slice(0, 6)
}

/**
 * Derive a `serverName` for a registration that did not name one.
 * @param {string} workspace - absolute workspace directory.
 * @param {string | undefined} url - HTTP endpoint, when the transport has one.
 * @param {string | undefined} command - stdio command, when it has one.
 * @returns a name matching the client's namespace pattern.
 */
function deriveServerName(workspace, url, command) {
  let label = 'mcp'
  if (typeof url === 'string' && url.length > 0) {
    try {
      const parsed = new URL(url)
      if (parsed.hostname.length > 0) label = parsed.hostname
    } catch {
      // The client's own schema rejects a malformed URL later.
    }
  } else if (typeof command === 'string' && command.length > 0) {
    label = command
  }
  const base = label.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20) || 'mcp'
  return `${base}-${shortHash(`${workspace}\u0000${url ?? command ?? ''}`)}`.slice(0, 32)
}

/**
 * Read and parse a JSON request body.
 * @param {import('node:http').IncomingMessage} request - incoming request.
 * @returns parsed body object.
 */
async function readJsonBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > BODY_LIMIT) throw new Error(`request body exceeds ${BODY_LIMIT} bytes`)
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text.length === 0) return {}
  const parsed = JSON.parse(text)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('request body must be a JSON object')
  }
  return parsed
}

/**
 * Whether the request came from this machine.
 * @param {import('node:http').IncomingMessage} request - incoming request.
 * @returns true for loopback peers.
 */
function fromLoopback(request) {
  const address = request.socket?.remoteAddress ?? ''
  return address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.')
}

/**
 * Write one JSON response.
 * @param {import('node:http').ServerResponse} response - response to finish.
 * @param {number} status - HTTP status code.
 * @param {unknown} body - JSON-serializable body.
 */
function sendJson(response, status, body) {
  const payload = Buffer.from(`${JSON.stringify(body, null, 2)}\n`, 'utf8')
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.length),
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type,authorization,x-workspace-mcp-token',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
  })
  response.end(payload)
}

/**
 * Install the workspace-scoped MCP bridge.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {Record<string, unknown> | undefined} config - the row's configuration.
 */
export function apply(ctx, config) {
  const options = resolveOptions(config)
  const logger = ctx.logger

  /** workspace key → { workspace, key, servers: Map<serverName, server> } */
  const workspaces = new Map()
  /** agent → Map<serverName, mount> */
  const mountsByAgent = new WeakMap()
  /** agent → serialized reconciliation tail */
  const queues = new WeakMap()
  /** every live mount, so this plugin's own unload withdraws them */
  const liveMounts = new Set()
  /** cached namespace of the shipped MCP client bridge */
  let clientModulePromise

  /**
   * Load the shipped `dsh-mcp-client` from the installation. Profile bundles do
   * not resolve `@deepseek-ai/*` themselves, so the package is resolved through
   * the running installation's own anchor.
   * @returns the client module namespace.
   */
  function loadClient() {
    clientModulePromise ??= (async () => {
      const failures = []
      for (const anchor of installAnchors()) {
        let resolver
        try {
          resolver = createRequire(join(anchor, 'package.json'))
          resolver.resolve('@deepseek-ai/dsh-mcp-client/package.json')
        } catch (error) {
          failures.push(`${anchor}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
          continue
        }
        // The Host's CommonJS loader is asar-aware, and Node 24 requires ESM
        // synchronously; a dynamic `import()` of an asar path is not portable
        // across Electron main processes, so it stays as a fallback only.
        try {
          return resolver('@deepseek-ai/dsh-mcp-client')
        } catch (error) {
          failures.push(`require from ${anchor}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
        }
        try {
          return await import(pathToFileURL(resolver.resolve('@deepseek-ai/dsh-mcp-client')).href)
        } catch (error) {
          failures.push(`import from ${anchor}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
        }
      }
      throw new Error(`cannot resolve @deepseek-ai/dsh-mcp-client (${failures.join(' | ')})`)
    })()
    return clientModulePromise
  }

  /**
   * The effective working directory of one live agent.
   * @param {{ id: string, session?: { header?: { cwd?: string } } }} agent - live agent.
   * @returns absolute directory, or undefined when the session has none.
   */
  function sessionDirectory(agent) {
    const workingDirectory = ctx.get('workingDirectory')
    if (workingDirectory !== undefined && agent.session !== undefined) {
      try {
        const current = workingDirectory.get(agent.session)
        if (typeof current === 'string' && current.length > 0) return current
      } catch {
        // Fall through to the durable header copy.
      }
    }
    const header = agent.session?.header?.cwd
    return typeof header === 'string' && header.length > 0 ? header : undefined
  }

  /**
   * Read the per-agent mount table, creating it on first use.
   * @param {object} agent - live agent.
   * @returns the agent's mount map.
   */
  function mountsOf(agent) {
    let mounts = mountsByAgent.get(agent)
    if (mounts === undefined) {
      mounts = new Map()
      mountsByAgent.set(agent, mounts)
    }
    return mounts
  }

  /**
   * Serialize work per agent so overlapping registry changes cannot mount or
   * unmount the same namespace twice concurrently.
   * @param {object} agent - live agent.
   * @param {() => Promise<void>} task - work to run after earlier work settles.
   * @returns the queued work.
   */
  function enqueue(agent, task) {
    const previous = queues.get(agent) ?? Promise.resolve()
    const next = previous.then(task, task).catch((error) => {
      logger?.warn?.(`workspace-mcp: reconciliation failed for session ${agent.id}`)
      logger?.warn?.(error)
    })
    queues.set(agent, next)
    return next
  }

  /**
   * Servers whose workspace covers one session directory; the most specific
   * workspace wins a name collision.
   * @param {string | undefined} directory - the session directory.
   * @returns server entries keyed by name.
   */
  function serversFor(directory) {
    const wanted = new Map()
    if (directory === undefined) return wanted
    const cwdKey = directoryKey(directory)
    const candidates = [...workspaces.values()]
      .filter(entry => covers(entry.key, cwdKey))
      .sort((left, right) => left.key.length - right.key.length)
    for (const entry of candidates) {
      for (const [serverName, server] of entry.servers) wanted.set(serverName, server)
    }
    return wanted
  }

  /**
   * Mount one server on one agent and observe its connection status.
   * @param {object} agent - live agent.
   * @param {object} server - registered server entry.
   * @param {object} client - the `dsh-mcp-client` namespace.
   * @returns the mount record.
   */
  function mount(agent, server, client) {
    const resolvedConfig = client.Config(server.client)
    const handle = agent.ctx.plugin(client, resolvedConfig)
    const record = {
      server,
      serverName: server.name,
      agent,
      agentId: agent.id,
      handle,
      state: 'connecting',
      error: undefined,
      settled: undefined,
    }
    record.settled = handle.await().then(() => {
      record.state = 'connected'
    }).catch((error) => {
      record.state = 'failed'
      record.error = error instanceof Error ? error.message : String(error)
      logger?.warn?.(`workspace-mcp: "${server.name}" failed to connect for session ${agent.id}`)
      logger?.warn?.(error)
    })
    mountsOf(agent).set(server.name, record)
    liveMounts.add(record)
    return record
  }

  /**
   * Drop one mount and let the client's own teardown close its transport.
   * @param {object} agent - owning agent.
   * @param {string} serverName - namespace to drop.
   * @returns Promise settling when the mount's disposal settles.
   */
  async function unmount(agent, serverName) {
    const mounts = mountsByAgent.get(agent)
    const record = mounts?.get(serverName)
    if (record === undefined) return
    mounts.delete(serverName)
    liveMounts.delete(record)
    await record.settled
    try {
      await record.handle?.dispose?.()
    } catch (error) {
      logger?.warn?.(`workspace-mcp: teardown of "${serverName}" failed for session ${agent.id}`)
      logger?.warn?.(error)
    }
  }

  /**
   * Drop every live mount of one server entry.
   * @param {object} server - the registration being replaced or removed.
   * @returns Promise settling when every affected mount is gone.
   */
  async function unmountServer(server) {
    const affected = [...liveMounts].filter(record => record.server === server)
    await Promise.all(affected.map(record => unmount(record.agent, record.serverName)))
  }

  /**
   * Reconcile one agent against the current registry.
   * @param {object} agent - live agent.
   * @returns Promise settling when this agent's mounts match the registry.
   */
  function syncAgent(agent) {
    return enqueue(agent, async () => {
      const client = await loadClient()
      const wanted = serversFor(sessionDirectory(agent))
      const mounts = mountsOf(agent)
      for (const [serverName, record] of [...mounts]) {
        if (wanted.get(serverName) !== record.server) await unmount(agent, serverName)
      }
      for (const [serverName, server] of wanted) {
        if (mounts.has(serverName)) continue
        const already = [...liveMounts].filter(record => record.server === server).length
        if (already >= options.maxSessionsPerServer) {
          logger?.warn?.(`workspace-mcp: "${serverName}" reached maxSessionsPerServer (${options.maxSessionsPerServer})`)
          continue
        }
        try {
          mount(agent, server, client)
        } catch (error) {
          logger?.warn?.(`workspace-mcp: cannot mount "${serverName}" for session ${agent.id}`)
          logger?.warn?.(error)
        }
      }
    })
  }

  /**
   * Plain view of one server registration.
   * @param {object} server - stored server entry.
   * @returns JSON view.
   */
  function describe(server) {
    return {
      name: server.name,
      workspace: server.workspace,
      transport: server.transport,
      ...server.transport === 'streamable-http'
        ? { url: server.client.url }
        : { command: server.client.command, args: server.client.args ?? [] },
    }
  }

  /**
   * Validate and store one server registration, replacing an equal name.
   * @param {object} body - request body.
   * @returns the stored entry and its JSON view.
   */
  function register(body) {
    const workspace = absoluteDirectory(body.workspace)
    const key = directoryKey(workspace)
    const transport = body.transport === 'stdio' ? 'stdio' : 'streamable-http'
    const client = { transport }
    if (transport === 'streamable-http') {
      if (typeof body.url !== 'string' || body.url.length === 0) {
        throw new Error('url is required for transport "streamable-http"')
      }
      client.url = body.url
      if (body.headers !== undefined) {
        if (body.headers === null || typeof body.headers !== 'object' || Array.isArray(body.headers)) {
          throw new Error('headers must be an object of string values')
        }
        client.headers = Object.fromEntries(Object.entries(body.headers).map(([header, value]) => [header, String(value)]))
      }
    } else {
      if (typeof body.command !== 'string' || body.command.length === 0) {
        throw new Error('command is required for transport "stdio"')
      }
      client.command = body.command
      if (Array.isArray(body.args)) client.args = body.args.map(String)
      if (body.env !== undefined) {
        if (body.env === null || typeof body.env !== 'object' || Array.isArray(body.env)) {
          throw new Error('env must be an object of string values')
        }
        client.env = Object.fromEntries(Object.entries(body.env).map(([entry, value]) => [entry, String(value)]))
      }
      if (typeof body.cwd === 'string' && body.cwd.length > 0) client.cwd = absoluteDirectory(body.cwd)
    }
    const serverName = typeof body.name === 'string' && body.name.length > 0
      ? body.name
      : deriveServerName(workspace, client.url, client.command)
    if (!SERVER_NAME_PATTERN.test(serverName)) {
      throw new Error(`name must match ${SERVER_NAME_PATTERN.source} (got "${serverName}")`)
    }
    client.serverName = serverName
    client.failOnStartupError = false
    client.expandTemplates = false
    client.startupTimeoutMs = options.startupTimeoutMs
    if (Number.isFinite(body.toolCallTimeoutMs)) client.toolCallTimeoutMs = body.toolCallTimeoutMs

    let entry = workspaces.get(key)
    if (entry === undefined) {
      entry = { workspace, key, servers: new Map() }
      workspaces.set(key, entry)
    }
    const previous = entry.servers.get(serverName)
    const server = { name: serverName, workspace, key, transport, client }
    entry.servers.set(serverName, server)
    return { entry, server, previous, spec: describe(server) }
  }

  /**
   * Remove one registration, or every registration of one workspace.
   * @param {object} body - request body.
   * @returns which registrations were removed.
   */
  function unregister(body) {
    const workspace = absoluteDirectory(body.workspace)
    const key = directoryKey(workspace)
    const entry = workspaces.get(key)
    if (entry === undefined) return { workspace, removed: [] }
    const named = typeof body.name === 'string' && body.name.length > 0
    const removed = named
      ? [body.name].filter(serverName => entry.servers.delete(serverName))
      : [...entry.servers.keys()]
    if (!named) entry.servers.clear()
    if (entry.servers.size === 0) workspaces.delete(key)
    return { workspace, removed }
  }

  /**
   * Current registry view, optionally narrowed to one workspace.
   * @param {string | undefined} workspaceFilter - absolute directory filter.
   * @returns JSON view of every registration and its live mounts.
   */
  function list(workspaceFilter) {
    const filterKey = workspaceFilter === undefined ? undefined : directoryKey(absoluteDirectory(workspaceFilter))
    return [...workspaces.values()]
      .filter(entry => filterKey === undefined || entry.key === filterKey)
      .map(entry => ({
        workspace: entry.workspace,
        servers: [...entry.servers.values()].map(server => ({
          ...describe(server),
          sessions: [...liveMounts]
            .filter(record => record.server === server)
            .map(record => ({ sessionId: record.agentId, state: record.state, error: record.error })),
        })),
      }))
  }

  /**
   * Register or replace one server and reconcile every affected live session.
   * @param {object} body - request body.
   * @param {number} waitMs - budget for waiting on live sessions to settle.
   * @returns the response body.
   */
  async function registerAndSync(body, waitMs) {
    const registered = register(body)
    if (registered.previous !== undefined) await unmountServer(registered.previous)
    const matched = (ctx.get('agents')?.list?.() ?? [])
      .filter(agent => covers(registered.entry.key, directoryKey(sessionDirectory(agent) ?? '')))
    await Promise.all(matched.map(agent => syncAgent(agent)))
    const settled = await Promise.race([
      Promise.all(matched.map(async (agent) => {
        const record = mountsByAgent.get(agent)?.get(registered.server.name)
        if (record === undefined) return { sessionId: agent.id, state: 'not-mounted' }
        await record.settled
        return { sessionId: agent.id, state: record.state, error: record.error }
      })),
      new Promise((resolve) => setTimeout(() => resolve(null), Math.max(waitMs, 0))),
    ])
    return {
      ok: true,
      registered: registered.spec,
      replaced: registered.previous !== undefined,
      sessions: settled ?? matched.map(agent => ({ sessionId: agent.id, state: 'connecting' })),
    }
  }

  /**
   * Remove one or every server of a workspace and drop its mounts.
   * @param {object} body - request body.
   * @returns the response body.
   */
  async function unregisterAndSync(body) {
    const targets = []
    const entry = workspaces.get(directoryKey(absoluteDirectory(body.workspace)))
    if (entry !== undefined) {
      for (const server of entry.servers.values()) {
        if (typeof body.name !== 'string' || body.name.length === 0 || server.name === body.name) targets.push(server)
      }
    }
    const result = unregister(body)
    await Promise.all(targets.map(server => unmountServer(server)))
    return { ok: true, ...result }
  }

  /**
   * Diagnose module resolution and per-session mounts.
   * @returns JSON view of the bridge's runtime wiring.
   */
  async function diagnostics() {
    let client
    try {
      const module = await loadClient()
      client = { ok: true, apply: typeof module.apply, config: typeof module.Config, connectionStatusOf: typeof module.connectionStatusOf }
    } catch (error) {
      client = { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    const agents = ctx.get('agents')?.list?.() ?? []
    return {
      ok: client.ok,
      revision: REVISION,
      anchors: installAnchors(),
      dshEnv: Object.keys(process.env).filter(key => key.startsWith('DSH_')).sort(),
      client,
      registrations: list(),
      sessions: agents.map(agent => ({
        sessionId: agent.id,
        cwd: sessionDirectory(agent) ?? null,
        mounted: [...(mountsByAgent.get(agent)?.keys() ?? [])],
      })),
    }
  }

  // ---- HTTP surface -------------------------------------------------------

  /**
   * Answer one route request.
   * @param {import('node:http').IncomingMessage} request - incoming request.
   * @param {import('node:http').ServerResponse} response - response to finish.
   */
  async function handleRequest(request, response) {
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'content-type,authorization,x-workspace-mcp-token',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
        'access-control-max-age': '600',
      })
      response.end()
      return
    }
    if (options.token !== null) {
      const header = request.headers['x-workspace-mcp-token'] ?? request.headers.authorization
      const presented = typeof header === 'string' ? header.replace(/^Bearer\s+/i, '') : ''
      if (presented !== options.token) {
        sendJson(response, 401, { ok: false, error: 'invalid or missing workspace-mcp token' })
        return
      }
    } else if (!fromLoopback(request)) {
      sendJson(response, 403, { ok: false, error: 'workspace-mcp accepts loopback requests only unless config.token is set' })
      return
    }
    const url = new URL(request.url ?? '/', 'http://localhost')
    const pathname = url.pathname.replace(/\/+$/, '')
    const action = pathname === ROUTE ? '' : pathname.slice(ROUTE.length + 1)
    try {
      if (request.method === 'GET' && (action === '' || action === 'health')) {
        sendJson(response, 200, { ok: true, plugin: 'workspace-mcp', route: ROUTE, revision: REVISION, registrations: list().length })
        return
      }
      if (request.method === 'GET' && action === 'doctor') {
        sendJson(response, 200, await diagnostics())
        return
      }
      if (request.method === 'GET' && action === 'list') {
        sendJson(response, 200, { ok: true, workspaces: list(url.searchParams.get('workspace') ?? undefined) })
        return
      }
      if (request.method === 'POST' && action === 'register') {
        const body = await readJsonBody(request)
        const waitMs = Math.min(Number.isFinite(body.waitMs) ? body.waitMs : options.waitForSessionsMs, WAIT_LIMIT_MS)
        sendJson(response, 200, await registerAndSync(body, waitMs))
        return
      }
      if (request.method === 'POST' && action === 'unregister') {
        sendJson(response, 200, await unregisterAndSync(await readJsonBody(request)))
        return
      }
      sendJson(response, 404, { ok: false, error: `unknown workspace-mcp action: ${request.method} ${pathname}` })
    } catch (error) {
      sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  // ---- Contributions ------------------------------------------------------

  ctx.inject(['webServer'], (routeCtx) => {
    routeCtx.effect(() => routeCtx.webServer.register({
      kind: 'prefix',
      path: ROUTE,
      handler: (request, response) => { void handleRequest(request, response) },
    }), 'workspace-mcp.route')
  })

  ctx.inject(['tools'], (toolCtx) => {
    const definition = {
      name: 'workspace_mcp',
      description: 'Manage MCP servers scoped to one working directory. A registered server is mounted only in sessions whose working directory is that directory or below it.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'register', 'unregister'], description: 'list current registrations; register an endpoint; unregister one name, or every name of a workspace' },
          workspace: { type: 'string', description: 'Absolute working directory the MCP server belongs to' },
          url: { type: 'string', description: 'Streamable HTTP MCP endpoint, used by action=register' },
          name: { type: 'string', description: 'Server namespace for tool names (mcp__<name>__<tool>); derived from the endpoint when omitted' },
          headers: { type: 'object', description: 'Extra request headers for the MCP endpoint' },
          transport: { type: 'string', enum: ['streamable-http', 'stdio'], description: 'Transport; defaults to streamable-http' },
          command: { type: 'string', description: 'Executable for transport=stdio' },
          args: { type: 'array', items: { type: 'string' }, description: 'Arguments for transport=stdio' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(args) {
        if (args.action === 'list') return JSON.stringify({ ok: true, workspaces: list(args.workspace) }, null, 2)
        if (args.action === 'register') {
          return JSON.stringify(await registerAndSync(args, options.waitForSessionsMs), null, 2)
        }
        return JSON.stringify(await unregisterAndSync(args), null, 2)
      },
    }
    toolCtx.effect(() => toolCtx.tools.register(definition), 'workspace-mcp.tool')
  })

  ctx.on('agent/created', ({ agent }) => { void syncAgent(agent) })
  ctx.on('agent/disposed', ({ agent }) => {
    const mounts = mountsByAgent.get(agent)
    if (mounts === undefined) return
    for (const serverName of [...mounts.keys()]) void unmount(agent, serverName)
    mountsByAgent.delete(agent)
  })

  // Mounts live on agent contexts, so this plugin's own unload must withdraw
  // them as well.
  ctx.effect(() => () => {
    for (const record of [...liveMounts]) void record.handle?.dispose?.()
    liveMounts.clear()
    workspaces.clear()
  }, 'workspace-mcp.mounts')

  // Sessions that already existed when this row activated get the registry
  // state they should already have had.
  for (const agent of ctx.get('agents')?.list?.() ?? []) void syncAgent(agent)

  // Warm the client module so the first registration does not pay for it.
  void loadClient().catch((error) => {
    logger?.error?.('workspace-mcp: cannot resolve @deepseek-ai/dsh-mcp-client')
    logger?.error?.(error)
  })
}
