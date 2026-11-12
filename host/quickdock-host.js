/**
 * QuickDock Host composition root.
 *
 * The plugin is a window around DSH's own Web UI: it owns a fixed loopback
 * listener that serves one shell page (title bar + iframe), a small bridge the
 * Client half uses, and the Electron supervisor that shows the window. All dock
 * content comes from DSH itself, so no session data is modelled here.
 */

import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { get } from 'node:https'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createApiRouter } from './api.js'
import { createBridgeHandler } from './bridge.js'
import { API_PREFIX, API_VERSION, BIND_HOST, BRIDGE_PATH, DEFAULT_PORT, PAGE_PATH, WINDOW_BOUNDS } from './constants.js'
import { startAppProxy } from './app-proxy.js'
import { DshFacade } from './dsh.js'
import { DockContexts } from './dock-contexts.js'
import { TurnAttribution } from './turn-attribution.js'
import { TurnOwners } from './turn-owners.js'
import { DEFAULT_ELECTRON_VERSION, ElectronResolver } from './electron-resolver.js'
import { sendJson } from './http.js'
import { LocaleController } from './locale.js'
import { PageRenderer } from './page.js'
import { DEFAULT_CONFIG, configPath, readConfig, resolveValue, sanitize, writeConfig, writeTemplateIfMissing } from './config-file.js'
import { createDockComponent } from './dock-component.js'
import { descriptorPath } from './mcp-descriptor.js'
import { McpPairing, profilePatchPath } from './mcp-pairing.js'
import { viewNames, normalizeView, viewTransport } from './views.js'
import { readVersion } from './version.js'
import { ThemeStore } from './theme.js'
import { createTrace, traceLogPath } from './trace.js'

/** Compare two dotted versions (a > b => positive). */
function compareVersions(a, b) {
  const left = String(a).split('.').map(Number)
  const right = String(b).split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    const diff = (left[index] || 0) - (right[index] || 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** Minimal HTTPS JSON GET with a timeout (no global fetch assumptions). */
function httpsJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const request = get(url, { headers: { accept: 'application/json' }, timeout: timeoutMs }, (response) => {
      if (response.statusCode !== 200) {
        response.resume()
        reject(new Error('HTTP ' + response.statusCode))
        return
      }
      let raw = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { raw += chunk })
      response.on('end', () => {
        try {
          resolve(JSON.parse(raw))
        } catch (error) {
          reject(error)
        }
      })
    })
    request.on('timeout', () => request.destroy(new Error('timeout')))
    request.on('error', reject)
  })
}

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

export class QuickDockHost {
  /**
   * @param {object} ctx Cordis host context (`connection` injected).
   * @param {object} config validated plugin config.
   */
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
    // Fixed window bounds, not settings: every consumer (window options, the
    // runtime payload, a resize) reads them from here.
    Object.assign(this.config, WINDOW_BOUNDS)
    this.dsh = new DshFacade(ctx)
    this.tracePath = traceLogPath()
    this.trace = createTrace({ path: this.tracePath })
    /** User configuration (`config.json`), overriding the Loader row config. */
    this.configFile = configPath(this.tracePath)
    writeTemplateIfMissing(this.configFile)
    this.fileConfig = readConfig(this.configFile)
    this.disposers = []
    /** The loopback listener that serves the shell page and the API. */
    this.server = null
    /** Loopback proxy for embedded views (`view=vscode`), started on demand. */
    this.appProxy = null
    /** The app origin the current proxy serves. */
    this.appProxyOrigin = ''
    /** Registers the paired editor's MCP server in the profile patch. */
    this.mcpPairing = null

    this.state = {
      sessionId: null,
      // The loopback listener: one address, no token (see config.port).
      server: { port: Number(config.port) || DEFAULT_PORT, ok: false, error: '', attempt: 0 },
      // running: process alive; visible: a window is actually on screen.
      dock: { running: false, visible: false, alwaysOnTop: config.alwaysOnTop, error: '' },
      // Desktop runtime download, surfaced in the DSH sidebar footer while active.
      download: { active: false, received: 0, total: 0, ok: false, error: '' },
      components: { service: false, dock: false },
      version: null
    }
    /** Bumped by postBind: the dock window follows this session. */
    this.dockTargetSeq = 0
    /** Bumped on request: the dock shell reloads the app in its iframe. */
    this.dockReloadSeq = 0
    /** This Electron window's own dock id (the shell URL carries it). */
    this.dockId = 'electron-' + randomBytes(6).toString('hex')
    /** Every connected dock: identity, tools, workspace and its own binding. */
    this.dockContexts = new DockContexts({ trace: (line) => this.trace(line) })
    /** Which dock started the running turn of each session (see turn-owners.js). */
    this.turnOwners = new TurnOwners({ trace: (line) => this.trace(line) })
    this.turnAttribution = new TurnAttribution({
      owners: this.turnOwners,
      trace: (line) => this.trace(line),
      logger: this.dsh.logger
    })
    /** The reverse request: "show this session in the DSH main window". */
    this.handoff = { sessionId: '', seq: 0 }
    this.lastDownloadPublishAt = 0

    this.publish = () => { /* state is read directly; nothing to push */ }

    this.locale = new LocaleController({
      preference: config.locale,
      onChange: () => this.publish()
    })

    this.theme = new ThemeStore({
      // 'auto' keeps the built-in palette until the Client half reports one.
      fallback: config.theme,
      getSnapshot: () => this.dsh.theme?.getTheme?.(),
      onChange: (payload) => {
        this.trace('theme -> shell: ' + payload.colorScheme + ' (' + Object.keys(payload.tokens).length + ' tokens)')
      }
    })

    this.resolver = new ElectronResolver({
      env: process.env,
      platform: process.platform,
      homeDir: this.dsh.baseDir || process.env.DSH_HOME || join(process.env.USERPROFILE || '', '.dsh'),
      logger: this.dsh.logger,
      trace: this.trace,
      t: (key, params) => this.locale.t(key, params),
      requireResolve: (specifier) => require.resolve(specifier)
    })
    this.resolver.onProgress = (event) => this.#onDownloadProgress(event)

    // The window component owns the supervisor; a headless mount never creates one.
    this.dockComponent = createDockComponent({
      config,
      state: this.state,
      dsh: this.dsh,
      locale: this.locale,
      resolver: this.resolver,
      trace: this.trace,
      tracePath: () => this.tracePath,
      publish: () => this.publish(),
      pageUrl: () => this.pageUrl(),
      rootDir: ROOT_DIR,
      token: ''
    })

    this.page = new PageRenderer({
      theme: this.theme,
      locale: this.locale,
      trace: this.trace
    })
    this.api = createApiRouter({
      app: this,
      trace: this.trace,
      logger: this.dsh.logger
    })
    this.bridge = createBridgeHandler({ app: this })
  }

  /** Translate a key with the active locale. */
  t(key, params) {
    return this.locale.t(key, params)
  }

  /* ------------------------------ addressing ------------------------------ */

  /** The loopback port the listener uses (0 disables it, used by tests). */
  serverPort() {
    const value = Number(this.config?.port)
    return Number.isFinite(value) ? Math.trunc(value) : DEFAULT_PORT
  }

  /**
   * DSH's own Web UI URL, carrying the launch token and the dock marker.
   *
   * `connection.authenticatedUrl` is the supported way to hand a browser-capable
   * client the page: without it the origin answers 401.
   */
  webUiUrl() {
    const base = this.dsh.webApp?.getAdvertisedUrl?.() || this.dsh.webServer?.getOrigin?.()
    if (!base) return null
    let url = base
    try {
      const authed = this.dsh.connection?.authenticatedUrl?.(base)
      if (authed) url = authed
    } catch (_) { /* fall back to the plain origin */ }
    try {
      const parsed = new URL(url)
      // Marker for the page inside the iframe: the dock-only customisations key
      // off it, so the normal window is untouched.
      parsed.searchParams.set('dock', '1')
      return parsed.href
    } catch (_) {
      return url
    }
  }

  /**
   * Which session the dock window should show, and whether it should reload.
   *
   * The dock window is a separate app instance (in an iframe), so the Dock button
   * cannot simply "be" the conversation: the shell polls this and forwards the
   * change to the app, which navigates to it explicitly.
   * @returns {{sessionId: string, seq: number, reloadSeq: number}} target and counters.
   */
  dockTargetInfo(dockId) {
    const dock = String(dockId || '').trim()
    if (!dock) return { sessionId: this.state.sessionId || '', seq: this.dockTargetSeq, reloadSeq: this.dockReloadSeq }
    this.dockContexts.touch(dock)
    const session = this.dockContexts.target(dock)
    if (!session) return { sessionId: '', seq: 0, reloadSeq: 0 }
    return { sessionId: session.sessionId, seq: session.seq, reloadSeq: session.reloadSeq }
  }

  /** Every connected dock, for the Client half's dock menu. */
  dockContextsInfo() {
    this.dockContexts.prune()
    this.turnOwners.sweep()
    return {
      ok: true,
      docks: this.dockContexts.list().map((context) => {
        const dock = this.dockContexts.snapshot(context.id)
        // The running turn of the session this dock shows, when that dock
        // started it. Bindings answer "shown here"; `turn` answers "started by".
        dock.turn = this.turnOwners.currentOf(dock.sessionId) || null
        return dock
      }),
      turns: this.turnOwners.snapshot(),
      legacy: { sessionId: this.state.sessionId || '' }
    }
  }

  /**
   * A client accepted one submitted prompt, with the identity the Host will echo
   * into the durable `user/message` source as `rpcId`.
   *
   * The dock reports its own submissions because nothing else can tell two
   * clients apart: the request carries no dock identity, and by the time the
   * durable message exists the transport has forgotten which page sent it.
   * @param {{dockId?: string, sessionId?: string, requestId?: string}} body
   * @returns {{ok: boolean, error?: string}} whether the expectation was stored.
   */
  recordDockSubmission(body) {
    const dockId = String(body?.dockId ?? '').trim()
    const sessionId = String(body?.sessionId ?? '').trim()
    const requestId = String(body?.requestId ?? '').trim()
    if (!dockId || !sessionId || !requestId) {
      return { ok: false, error: 'dockId, sessionId and requestId are required' }
    }
    if (!this.turnOwners.expect({ dockId, sessionId, requestId })) {
      return { ok: false, error: 'submission rejected' }
    }
    // A submission is also a heartbeat for a context the shell created earlier.
    if (this.dockContexts.get(dockId)) this.dockContexts.touch(dockId)
    this.trace('dock submission: ' + dockId + ' -> ' + sessionId + ' (' + requestId.slice(0, 8) + ')')
    return { ok: true }
  }

  /**
   * Which dock started the session's running turn.
   * @param {string} sessionId session id.
   * @returns {string} dock id, or '' when the turn is not a dock's.
   */
  turnOwnerOf(sessionId) {
    return this.turnOwners.ownerOf(sessionId)
  }

  /** The running and last attributed turns of one session. */
  turnInfo(sessionId) {
    return {
      id: String(sessionId || ''),
      owner: this.turnOwners.ownerOf(sessionId),
      current: this.turnOwners.currentOf(sessionId),
      last: this.turnOwners.lastOf(sessionId)
    }
  }

  /**
   * Build the `when` predicate for one dock's tools.
   *
   * Tool sets are resolved per model step, so the predicate is a synchronous
   * read of the running turn's owner (see `tools.resolve` in the agent loop).
   * A turn nobody claimed - a goal round, a resume, a prompt from the main
   * window - has no owner and therefore no dock tools.
   * @param {string} dockId dock whose tools are being offered.
   * @returns {(context: object) => boolean} predicate for `ctx.tools.register`.
   */
  toolPredicate(dockId) {
    const id = String(dockId || '').trim()
    return (context) => {
      if (!id) return false
      const agent = context && context.agent ? context.agent : context
      const session = agent && agent.session
      const sessionId = String((session && (session.id || session.sessionId)) || (agent && agent.sessionId) || '')
      return Boolean(sessionId) && this.turnOwnerOf(sessionId) === id
    }
  }

  /** Create or update a dock context from what the client sent on connect. */
  postDockContext(body) {
    const id = String(body?.id ?? '').trim()
    if (!id) return { ok: false, error: 'id required' }
    const context = this.dockContexts.upsert({
      id,
      type: body?.type,
      client: body?.client,
      tools: body?.tools,
      workspace: body?.workspace,
      systemPrompt: body?.systemPrompt
    })
    this.trace('dock context: upsert ' + id + ' (' + context.type + ')')
    return { ok: true, dock: this.dockContexts.snapshot(id) }
  }

  /** A dock went away: drop its context, binding and tools. */
  deleteDockContext(id) {
    const removed = this.dockContexts.remove(id)
    return { ok: removed, id: String(id || '') }
  }

  /** Ask an already-open dock window to reload the app inside its iframe. */
  requestDockReload() {
    this.dockReloadSeq += 1
    return { ok: true, running: Boolean(this.dock && this.dock.alive) }
  }

  /**
   * The dock's read side of the handoff: which session the main window should
   * show, and a counter the main window uses to notice a new request.
   * @returns {{sessionId: string, seq: number}} pending handoff.
   */
  handoffInfo() {
    return { sessionId: this.handoff.sessionId, seq: this.handoff.seq }
  }

  /**
   * Ask the DSH main window to show a session - the reverse of a bind.
   *
   * The main window is a separate tab the Host cannot reach, so the request is
   * stored and the Client half there polls for it.
   * @param {string} sessionId session to open.
   * @returns {{ok: boolean, seq?: number}} result.
   */
  handoffToMain(sessionId) {
    const id = String(sessionId || '').trim()
    if (!id) return { ok: false }
    this.handoff = { sessionId: id, seq: this.handoff.seq + 1 }
    this.trace('handoff -> main window: ' + id)
    return { ok: true, seq: this.handoff.seq }
  }

  /**
   * Start (or reuse) the loopback proxy embedded views load the app from.
   *
   * DSH authenticates its page with an httpOnly, `SameSite=Strict` cookie; a
   * page inside another application (an IDE webview) is a third-party context
   * for `127.0.0.1` and never gets that cookie. Serving the app from this Host
   * makes it same-origin with the shell page and adds the token upstream (see
   * host/app-proxy.js). One proxy serves every embedded view; only a different
   * app origin (a DSH restart) replaces it.
   * @param {string} upstreamUrl the authenticated Web UI URL.
   * @returns {Promise<string>} the proxy origin, or '' when it could not start.
   */
  async ensureAppProxy(upstreamUrl) {
    let origin = ''
    try {
      origin = new URL(upstreamUrl).origin
    } catch (_) {
      return ''
    }
    if (this.appProxy && this.appProxyOrigin === origin) return this.appProxy.origin
    this.appProxy?.dispose?.()
    this.appProxy = null
    this.appProxyOrigin = origin
    try {
      this.appProxy = await startAppProxy({ upstreamUrl, trace: (line) => this.trace(line) })
      return this.appProxy.origin
    } catch (error) {
      const message = String(error?.message || error)
      this.trace('app proxy failed: ' + message)
      this.dsh.logger?.warn?.('quickdock: app proxy failed: %s', message)
      return ''
    }
  }

  /** The shell page address (no token: the fixed port is the handshake). */
  pageUrl() {
    const port = (this.state.server && this.state.server.port) || this.serverPort()
    return 'http://' + BIND_HOST + ':' + port + PAGE_PATH
      + '?view=electron&dock=' + encodeURIComponent(this.dockId)
  }

  /* ------------------------------ lifecycle ------------------------------ */

  /**
   * Mount the requested components.
   * @param {{service?: boolean, dock?: boolean}} [components] what to mount.
   */
  start(components) {
    const service = components ? components.service !== false : true
    const dock = service && (components ? components.dock !== false : true)
    this.state.components = { service, dock }
    // The app proxy is part of the service: take it down with the plugin.
    this.#disposeOn(() => {
      this.appProxy?.dispose?.()
      this.appProxy = null
      this.appProxyOrigin = ''
    }, 'quickdock: app proxy')
    if (this.dockComponent) this.dockComponent.mount({ dock })
    if (dock) {
      // Reloading the plugin must take the window with it: an orphaned Electron
      // process keeps the single-instance lock and blocks the next window.
      this.#disposeOn(() => this.dockComponent?.dispose(), 'quickdock: dock lifecycle')
    }
    this.#applyFileConfig()
    if (service) {
      this.#startServer()
      this.#registerBridge()
      this.#startMcpPairing()
      this.#attachTurnAttribution()
    }
    const version = readVersion(ROOT_DIR)
    this.state.version = version
    this.trace('host half loaded: version=' + (version.pkg || '?')
      + ' commit=' + (version.hash || 'unknown') + ' startedAt=' + version.startedAt
      + ' components=' + (service ? 'service' : '-') + (dock ? '+dock' : ''))
    this.dsh.logger?.info?.('quickdock: host half loaded ' + (version.hash || ''))
    // The runtime download is ~100 MB: start it in the background so the first
    // Dock click does not wait for it (config: prefetchElectron).
    if (dock) {
      const prefetchTimer = setTimeout(() => this.prefetchElectron(), 1500)
      this.#disposeOn(() => clearTimeout(prefetchTimer), 'quickdock: prefetch timer')
    }
    // Resident mode: the window is up before the first Dock click.
    if (service && dock && this.config.autoLaunch) {
      const launchTimer = setTimeout(() => this.dock?.summon(), 600)
      this.#disposeOn(() => clearTimeout(launchTimer), 'quickdock: launch timer')
    }
  }

  /**
   * What the runtime looks like right now.
   * @returns {{version: string, defaultVersion: string, dir: string, exe: string, ready: boolean}} status.
   */
  runtimeInfo() {
    const version = this.resolver?.version || DEFAULT_ELECTRON_VERSION
    const dir = this.resolver ? join(this.resolver.downloadRoot(), version) : ''
    let exe = ''
    try {
      exe = this.resolver?.usable?.()[0]?.exe || ''
    } catch (_) {
      exe = ''
    }
    const download = this.state.download || {}
    return {
      version,
      defaultVersion: DEFAULT_ELECTRON_VERSION,
      dir,
      exe,
      ready: Boolean(exe),
      downloading: download.active === true,
      received: Number(download.received) || 0,
      total: Number(download.total) || 0,
      error: download.error || ''
    }
  }

  /**
   * Delete the downloaded copy and fetch it again (the fix for a broken tree).
   * @returns {Promise<object>} the status after the download.
   */
  redownloadRuntime() {
    if (!this.resolver) throw new Error('runtime resolver unavailable')
    // The running window holds electron.exe: it has to go before the folder is
    // replaced. It is summoned again once the new copy is in place.
    const wasRunning = Boolean(this.dock?.alive)
    if (wasRunning) this.dock.stop()
    this.state.download.active = true
    this.state.download.received = 0
    this.state.download.total = 0
    this.state.download.error = ''
    void (async () => {
      // Give Windows a moment to release the executable handles.
      if (wasRunning) await new Promise((resolve) => setTimeout(resolve, 1200))
      await this.resolver.download()
      this.trace('runtime downloaded again: ' + this.resolver.version)
      if (wasRunning) this.dock?.summon()
    })().catch((error) => {
      this.state.download.active = false
      this.state.download.error = String(error?.message || error)
      this.trace('redownload failed: ' + String(error?.message || error))
    })
    return this.runtimeInfo()
  }

  /**
   * Stable Electron versions the registry publishes, newest first.
   * @returns {Promise<{versions: string[], installed: string[], defaultVersion: string, error: string}>} list.
   */
  async electronVersions() {
    const now = Date.now()
    if (this.versionCache && now - this.versionCache.at < 3600000) return this.versionCache.data
    const root = this.resolver?.downloadRoot?.() || ''
    const installed = []
    try {
      for (const name of readdirSync(root)) {
        if (existsSync(join(root, name, 'electron.exe')) || existsSync(join(root, name, 'electron'))) installed.push(name)
      }
    } catch (_) {
      /* no runtime folder yet */
    }
    const data = {
      versions: [],
      installed,
      defaultVersion: DEFAULT_ELECTRON_VERSION,
      current: this.resolver?.version || DEFAULT_ELECTRON_VERSION,
      error: ''
    }
    const registries = ['https://registry.npmmirror.com/electron', 'https://registry.npmjs.org/electron']
    for (const url of registries) {
      try {
        const body = await httpsJson(url, 5000)
        const all = body && body.versions ? Object.keys(body.versions) : []
        const stable = all.filter((version) => /^\d+\.\d+\.\d+$/.test(version))
        stable.sort(compareVersions)
        stable.reverse()
        data.versions = stable.slice(0, 40)
        break
      } catch (error) {
        data.error = String(error?.message || error)
      }
    }
    if (!data.versions.includes(DEFAULT_ELECTRON_VERSION)) data.versions.unshift(DEFAULT_ELECTRON_VERSION)
    if (!data.versions.includes(data.current)) data.versions.unshift(data.current)
    this.versionCache = { at: now, data }
    return data
  }

  /**
   * Reveal the runtime folder in the file manager.
   * @returns {{dir: string}} the folder that was opened.
   */
  openRuntimeFolder() {
    const version = this.resolver?.version || DEFAULT_ELECTRON_VERSION
    const dir = join(this.resolver?.downloadRoot?.() || '', version)
    try { mkdirSync(dir, { recursive: true }) } catch (_) { /* ignore */ }
    const [command, args] = process.platform === 'win32'
      ? ['explorer.exe', [dir]]
      : process.platform === 'darwin' ? ['open', [dir]] : ['xdg-open', [dir]]
    try {
      spawn(command, args, { detached: true, stdio: 'ignore' }).unref()
    } catch (error) {
      return { dir, error: String(error?.message || error) }
    }
    return { dir }
  }

  /** The Electron supervisor (null when the dock component is not mounted). */
  get dock() {
    return this.dockComponent ? this.dockComponent.dock : null
  }

  /**
   * Mount the window component on an already running Host.
   *
   * This is what `dsh-quickdock/dock` calls: the service entry owns the listener
   * and the bridge, the dock entry only adds the windows.
   * @returns {boolean} whether the component is mounted.
   */
  /**
   * The floating ball diameter actually in use: the value written from DSH's
   * Settings page wins over the row config, which stays the default.
   * @returns {number} diameter in DIP (24-160).
   */
  ballSize() {
    const size = resolveValue(this.fileConfig, this.config, 'ballSize')
    return Math.min(160, Math.max(24, Math.round(Number(size) || 64)))
  }

  /**
   * Store a new ball diameter and apply it to a running window.
   * @param {number} size diameter in DIP.
   * @returns {{ok: boolean, size: number}} applied value.
   */
  setBallSize(size) {
    return this.setConfig({ ballSize: size }).ballSize !== undefined
      ? { ok: true, size: this.ballSize() }
      : { ok: false, error: 'invalid size' }
  }

  /**
   * Effective configuration: file over row over schema defaults.
   * @returns {object} one value per documented key.
   */
  effectiveConfig() {
    const keys = Object.keys(DEFAULT_CONFIG)
    const out = {}
    for (const key of keys) out[key] = resolveValue(this.fileConfig, this.config, key)
    return out
  }

  /**
   * Persist a configuration patch and apply what can change at runtime.
   * @param {object} patch partial configuration.
   * @returns {object} the effective configuration after the write.
   */
  setConfig(patch) {
    const clean = sanitize(Object.assign({}, this.fileConfig, patch))
    this.fileConfig = clean
    writeConfig(this.configFile, clean)
    const config = this.effectiveConfig()
    // A different port is a listener move, not a value: rebind first, then let
    // the window come back on the new address (Electron gets the URL at spawn).
    const portChanged = Number(config.port) !== Number(this.config.port)
    if (portChanged || this.state.server.error) {
      this.restartServer(config.port, () => {
        if (portChanged && (this.dock?.alive || this.dock?.starting)) this.restartDock()
      })
    }
    // Keep the row-config copy in step so the next spawn inherits the values...
    this.config.ballSize = config.ballSize
    this.config.ballIcon = config.ballIcon
    this.config.snapToEdge = config.snapToEdge
    this.config.closeAction = config.closeAction
    this.config.collapseOnClose = config.closeAction === 'ball'
    if (this.config.electronVersion !== config.electronVersion) {
      this.config.electronVersion = config.electronVersion
      if (this.resolver) this.resolver.version = config.electronVersion || DEFAULT_ELECTRON_VERSION
      // A different build has to be fetched: the old attempt is stale.
      this.prefetchStarted = false
      const versionTimer = setTimeout(() => this.prefetchElectron(), 800)
      if (typeof versionTimer?.unref === 'function') versionTimer.unref()
    }
    this.config.alwaysOnTop = config.alwaysOnTop
    this.config.rememberGeometry = config.rememberGeometry
    this.config.focusOnSummon = config.focusOnSummon
    // The shell draws the collapse button: reload it when its mark changes.
    if (config.ballIcon !== this.lastBallIcon) {
      this.lastBallIcon = config.ballIcon
      this.dock?.reloadShell?.()
    }
    // ...and push the runtime-safe ones to a window that is already open.
    this.dock?.applyRuntimeConfig?.({
      minWidth: WINDOW_BOUNDS.minWidth,
      minHeight: WINDOW_BOUNDS.minHeight,
      maxWidth: WINDOW_BOUNDS.maxWidth,
      maxHeight: WINDOW_BOUNDS.maxHeight,
      ballSize: config.ballSize,
      ballIcon: config.ballIcon,
      snapToEdge: config.snapToEdge,
      collapseOnClose: config.closeAction === 'ball',
      alwaysOnTop: config.alwaysOnTop
    })
    return config
  }

  mountDock() {
    if (!this.dockComponent) return false
    if (this.state.components) this.state.components.dock = true
    const mounted = this.dockComponent.mount({ dock: true })
    if (mounted) {
      const supervisor = this.dock
      if (supervisor && typeof supervisor.applyWindow === 'function') {
        supervisor.applyWindow({ alwaysOnTop: this.state.dock.alwaysOnTop })
      }
    }
    return mounted
  }

  /** Remove the window component (the process goes with it). */
  unmountDock() {
    if (this.dockComponent) this.dockComponent.dispose()
    if (this.state.components) this.state.components.dock = false
  }

  /** Snapshot of the runtime download, polled by the Client footer badge. */
  downloadProgress() {
    return Object.assign({}, this.state.download)
  }

  /**
   * Track the runtime download for the UI (throttled: the footer only needs a
   * few updates per second).
   * @param {object} event progress event from the resolver.
   */
  #onDownloadProgress(event) {
    const download = this.state.download
    if (event?.done) {
      download.active = false
      download.ok = Boolean(event.ok)
      download.error = event.error ? String(event.error) : ''
      return
    }
    if (!event) return
    download.active = true
    download.received = Number(event.received) || 0
    download.total = Number(event.total) || 0
    const now = Date.now()
    if (now - this.lastDownloadPublishAt >= 400) this.lastDownloadPublishAt = now
  }

  /**
   * Prepare the Electron runtime in the background, right after the host mounts.
   *
   * Only the window needs Electron, and fetching it is ~100 MB, so doing it here
   * keeps the first Dock click instant instead of stalling behind a download.
   */
  prefetchElectron() {
    if (this.config?.prefetchElectron === false) return
    if (this.prefetchStarted) return
    this.prefetchStarted = true
    try {
      if (this.resolver.executables().length) return
    } catch (_) {
      return
    }
    const started = Date.now()
    this.trace('electron prefetch: start')
    this.resolver.download()
      .then((exe) => this.trace('electron prefetch: ready at ' + exe + ' (' + (Date.now() - started) + ' ms)'))
      .catch((error) => {
        this.trace('electron prefetch: failed: ' + String(error?.message || error))
        this.trace('electron prefetch stack: ' + String(error?.stack || '').split('\n').slice(0, 4).join(' | '))
      })
  }

  /* ------------------------------ transport ------------------------------ */

  /**
   * Serve the shell page and the API on the configured loopback port.
   *
   * One address, no token: the port is the whole handshake. The cost is that
   * anything on this machine can call the API; that is the trade the fixed port
   * buys, and `port` (Settings → QuickDock, or config.json) is the one setting to
   * change when that address is taken.
   */
  #startServer() {
    const port = this.serverPort()
    if (!(port > 0)) {
      this.trace('server disabled: port=' + port)
      return
    }
    this.#listen(port)
    this.#disposeOn(() => {
      const server = this.server
      this.server = null
      if (!server) return
      try { server.close() } catch (_) { /* already closed */ }
    }, 'quickdock: http server')
  }

  /**
   * Bind a listener, keeping the previous one alive until the new address
   * answers: rebinding onto a busy port must not take the working page down.
   * @param {number} port loopback port.
   * @param {(port: number) => void} [onListening] called once the port answers.
   */
  #listen(port, onListening) {
    const previous = this.server
    let previousPort = 0
    try {
      previousPort = previous && previous.listening ? (previous.address()?.port || 0) : 0
    } catch (_) {
      previousPort = 0
    }
    const server = createServer((req, res) => { void this.handleHttp(req, res) })
    this.state.server.attempt = port
    this.state.server.port = previousPort || port
    this.state.server.ok = false
    this.state.server.error = ''
    server.on('error', (error) => {
      const code = String(error?.code || 'error')
      this.state.server.ok = false
      this.state.server.error = code
      // The old address is still serving: report that one, not the failed port.
      if (previousPort) this.state.server.port = previousPort
      this.trace('server error on ' + BIND_HOST + ':' + port + ': ' + code
        + (code === 'EADDRINUSE' ? ' (port busy: set config.port or the Settings row to a free port)' : ''))
      this.dsh.logger?.warn?.('quickdock: cannot listen on %s:%s (%s); set config.port', BIND_HOST, port, code)
      // A listener that never opened holds nothing, but releasing it is explicit.
      try { server.close() } catch (_) { /* never listening */ }
    })
    server.listen(port, BIND_HOST, () => {
      const address = server.address()
      const bound = address && typeof address === 'object' ? address.port : port
      this.server = server
      this.state.server.attempt = bound
      this.state.server.port = bound
      this.state.server.ok = true
      this.state.server.error = ''
      this.trace('server listening on http://' + BIND_HOST + ':' + bound)
      if (previous && previous !== server) {
        try { previous.close() } catch (_) { /* already closed */ }
      }
      if (typeof onListening === 'function') onListening(bound)
    })
  }

  /**
   * Move the listener to another port (a settings change, not a restart).
   * `0` closes it. On EADDRINUSE the previous address keeps serving.
   * @param {number} [port] new port, defaults to the configured one.
   * @param {(port: number) => void} [onListening] fired when the new port answers.
   * @returns {{ok: boolean, port: number, error: string}} what is recorded now.
   */
  restartServer(port = this.serverPort(), onListening) {
    const next = Math.trunc(Number(port) || 0)
    this.config.port = next
    this.state.server.error = ''
    if (!(next > 0)) {
      const server = this.server
      this.server = null
      if (server) {
        try { server.close() } catch (_) { /* already closed */ }
      }
      this.state.server.ok = false
      this.state.server.port = 0
      this.trace('server disabled: port=' + next)
      return this.serverStatus()
    }
    this.#listen(next, onListening)
    return this.serverStatus()
  }

  /**
   * Apply a port from the settings page, then bring the window back on it.
   *
   * The order matters: persist, rebind, wait for the bind attempt to settle, and
   * only then reopen the window - a window opened earlier would carry the old
   * address (`DSH_QUICKDOCK_URL` is fixed at spawn).
   * @param {number} port new loopback port (1-65535; 0 is not a port).
   * @returns {Promise<{ok: boolean, port?: number, error?: string, server: object}>} outcome.
   */
  async applyPort(port) {
    const next = Math.trunc(Number(port))
    if (!Number.isInteger(next) || next < 1 || next > 65535) {
      return { ok: false, error: 'invalid port', server: this.serverStatus() }
    }
    // Re-applying the serving port would collide with the listener it replaces.
    if (next === Number(this.config.port) && this.state.server.ok) {
      return { ok: true, port: this.state.server.port, server: this.serverStatus() }
    }
    const clean = sanitize(Object.assign({}, this.fileConfig, { port: next }))
    this.fileConfig = clean
    writeConfig(this.configFile, clean)
    this.trace('apply port: ' + next)
    const bound = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(0), 3000)
      if (typeof timer?.unref === 'function') timer.unref()
      this.restartServer(next, (value) => {
        clearTimeout(timer)
        resolve(value)
      })
    })
    const server = this.serverStatus()
    if (!bound) {
      // The old address is still serving; the window stays where it works.
      return { ok: false, port: this.state.server.attempt || next, error: server.error || 'ETIMEDOUT', server }
    }
    const dock = this.dock
    if (dock && (dock.alive || dock.starting)) this.restartDock()
    return { ok: true, port: bound, server: this.serverStatus() }
  }

  /** The listener state the bridge, the settings page and the Dock button show. */
  serverStatus() {    let serving = false
    try {
      serving = Boolean(this.server && this.server.listening)
    } catch (_) {
      serving = false
    }
    return {
      ok: Boolean(this.state.server.ok),
      serving,
      port: Number(this.state.server.port) || 0,
      attempt: Number(this.state.server.attempt) || Number(this.state.server.port) || 0,
      error: this.state.server.error || ''
    }
  }

  /**
   * Serve one page or API request.
   * @param {import('node:http').IncomingMessage} req request.
   * @param {import('node:http').ServerResponse} res response.
   */
  async handleHttp(req, res) {
    const url = new URL(req.url ?? '/', 'http://' + BIND_HOST)
    // The frame shell is on its own port; keep the wildcard so any local page or
    // IDE webview can read the two read-only endpoints.
    res.setHeader('Access-Control-Allow-Origin', '*')
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '600'
      })
      res.end()
      return
    }
    if (url.pathname === PAGE_PATH || url.pathname === PAGE_PATH + '/') {
      // The view picks both the chrome and how the app is embedded.
      const view = normalizeView(url.searchParams.get('view'))
      if (!view) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('unknown view; expected one of ' + viewNames().join(', '))
        return
      }
      const source = this.webUiUrl()
      if (!source) {
        res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('the DSH Web UI is not available in this composition')
        return
      }
      let embedded = source
      if (viewTransport(view) === 'proxy') {
        const origin = await this.ensureAppProxy(source)
        if (!origin) {
          res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('the QuickDock app proxy could not start')
          return
        }
        embedded = origin + '/?dock=1'
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(this.page.renderFrame(embedded, {
        view,
        systemControls: this.config?.windowControls === 'system',
        ballIcon: this.config?.ballIcon
      }))
      return
    }
    if (url.pathname.startsWith(API_PREFIX)) {
      // One write endpoint: the shell asks the main window to show a session.
      if (url.pathname === API_PREFIX + 'handoff' && req.method === 'POST') {
        const body = await readJson(req)
        const result = this.handoffToMain(body && body.sessionId)
        sendJson(res, result.ok ? 200 : 400, result)
        return
      }
      await this.api.handle(req, res, url)
      return
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('not found')
  }

  /**
   * Copy the user's configuration over the row config.
   *
   * Everything downstream (window options, supervisor, spawn environment) reads
   * `this.config`, so one merge here keeps the file the single user-facing source.
   */
  #applyFileConfig() {
    const config = this.effectiveConfig()
    // The listener address: every out-of-process client depends on this value.
    this.config.port = config.port
    this.config.alwaysOnTop = config.alwaysOnTop
    this.config.rememberGeometry = config.rememberGeometry
    this.config.focusOnSummon = config.focusOnSummon
    this.config.ballSize = config.ballSize
    this.config.autoLaunch = config.autoLaunch
    this.config.prefetchElectron = config.prefetchElectron
    this.config.electronVersion = config.electronVersion
    if (this.resolver) this.resolver.version = config.electronVersion || DEFAULT_ELECTRON_VERSION
    this.config.headerButton = config.headerButton
    this.config.ballIcon = config.ballIcon
    this.config.snapToEdge = config.snapToEdge
    this.config.closeAction = config.closeAction
    this.config.collapseOnClose = config.closeAction === 'ball'
    this.config.mcpPairing = config.mcpPairing
    /** Mark currently drawn by the shell, to avoid a needless shell reload. */
    this.lastBallIcon = config.ballIcon
  }

  #registerBridge() {
    this.ctx.effect(() => this.ctx.connection.fetch.register({
      path: BRIDGE_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: this.bridge
    }), 'quickdock: browser bridge route')
  }

  /**
   * Start the MCP pairing watcher.
   *
   * The editor publishes `mcp.json` in the state directory once its user has
   * consented; this Host keeps one MCP client row in the profile patch enabled
   * while that server is live (see MCP-PAIRING.md). Without a profile patch to
   * maintain - a headless composition, a profile launched outside DSH - there is
   * nothing to do, and nothing is guessed.
   */
  /**
   * Start following the agent loop, so every running turn knows its dock.
   *
   * `agent/inbox/claimed` fires before the step resolves its tools, and the
   * durable `turn/start` / `turn/end` keep the marker scoped to one turn (see
   * host/turn-attribution.js). This is part of the service: without it the
   * per-dock tool predicates have nothing to read.
   */
  #attachTurnAttribution() {
    const detach = this.turnAttribution.attach(this.ctx)
    // The dispose callback only runs on teardown: attach happens right here, so
    // the very first prompt of this process is already covered.
    this.#disposeOn(detach, 'quickdock: turn attribution')
  }

  #startMcpPairing() {
    if (this.config.mcpPairing === false) {
      this.trace('mcp pairing: disabled by config')
      return
    }
    const patchFile = profilePatchPath({ env: process.env, homeDir: this.dsh.baseDir })
    if (!patchFile) {
      this.trace('mcp pairing: no profile patch to maintain (profile unknown)')
      return
    }
    this.mcpPairing = new McpPairing({
      descriptorFile: descriptorPath(this.tracePath),
      patchFile,
      trace: this.trace,
      logger: this.dsh.logger,
      configEditor: this.dsh.configEditor
    })
    this.mcpPairing.start()
    this.#disposeOn(() => {
      this.mcpPairing?.stop()
      this.mcpPairing = null
    }, 'quickdock: mcp pairing')
    this.trace('mcp pairing: watching ' + this.mcpPairing.descriptorFile + ' -> ' + patchFile)
  }

  #disposeOn(dispose, label) {
    this.ctx.effect(() => dispose, label)
  }

  /* ------------------------------ operations ------------------------------ */

  /** Adopt a theme reported by the Client half (used by the shell page). */
  acceptTheme(payload) {
    return this.theme.accept(payload)
  }

  /** Adopt a locale reported by the Client half. */
  acceptLocale(value) {
    return this.locale.accept(value)
  }

  /** Kill and respawn the window process. */
  restartDock() {
    this.dock?.stop()
    const timer = setTimeout(() => this.dock?.summon(), 400)
    this.#disposeOn(() => clearTimeout(timer), 'quickdock: restart timer')
  }

  /**
   * Bind a session and tell the dock window to show it.
   * @param {{sessionId?: string}} body request body.
   * @returns {object} dock status for the Client to poll.
   */
  postBind(body, dockId) {
    const sessionId = String(body?.sessionId ?? '')
    if (!sessionId) return { ok: false }
    const dock = String(dockId || body?.dock || '').trim()
    if (dock) {
      // One dock, one binding: the shell polls only its own target.
      this.dockContexts.bind(dock, sessionId)
      this.publish()
      // A dock reporting the session it shows (`quiet`) never summons a window.
      const quiet = body?.quiet === true
      if (!quiet && dock === this.dockId && this.state.components.dock) {
        this.dock?.summon()
        this.dockComponent?.focus?.()
        this.dock?.notifyAttach(sessionId)
      }
      return {
        ok: true,
        dock,
        dockRunning: Boolean(this.dock && this.dock.alive),
        starting: Boolean(this.dock && this.dock.starting),
        error: this.state.dock.error || undefined,
        server: this.serverStatus()
      }
    }
    // Legacy callers (no dock id): keep the global binding and mirror it onto
    // this Electron window's own context, which the shell polls by id now.
    this.state.sessionId = sessionId
    this.dockTargetSeq += 1
    this.dockContexts.bind(this.dockId, sessionId)
    this.publish()
    if (this.state.components.dock) {
      this.dock?.summon()
      this.dockComponent?.focus?.()
      this.dock?.notifyAttach(sessionId)
    }
    return {
      ok: true,
      dockRunning: Boolean(this.dock && this.dock.alive),
      starting: Boolean(this.dock && this.dock.starting),
      error: this.state.dock.error || undefined,
      server: this.serverStatus()
    }
  }

  /** Plugin metadata for the Client and for diagnostics. */
  meta() {
    return {
      name: 'dsh-quickdock',
      apiVersion: API_VERSION,
      components: this.state.components,
      capabilities: ['dock-target', 'handoff', 'app-proxy', 'mcp-pairing', 'dock-contexts', 'turn-attribution'],
      dockId: this.dockId,
      // Which shell variants a client may ask for; the pick also decides whether
      // the app comes through the proxy (see host/views.js).
      views: viewNames(),
      // The paired editor's MCP row: what the poller last saw and wrote. Null
      // when the profile has no patch to maintain (headless, foreign profile).
      mcp: this.mcpPairing ? this.mcpPairing.status() : null,
      version: this.state.version?.pkg || null
    }
  }
}

/**
 * Read a small JSON request body.
 *
 * Handles both a real IncomingMessage (event emitter) and the async-iterable
 * stand-in the unit tests use.
 * @param {import('node:http').IncomingMessage} req request.
 * @returns {Promise<object|null>} parsed body, or null when it is not JSON.
 */
async function readJson(req) {
  const limit = 64 * 1024
  let text = ''
  try {
    const chunks = []
    let size = 0
    if (typeof req.on === 'function') {
      text = await new Promise((resolve) => {
        req.on('data', (chunk) => {
          size += chunk.length
          if (size > limit) {
            req.destroy()
            resolve('')
            return
          }
          chunks.push(Buffer.from(chunk))
        })
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
        req.on('error', () => resolve(''))
      })
    } else if (typeof req[Symbol.asyncIterator] === 'function') {
      for await (const chunk of req) {
        size += chunk.length
        if (size > limit) break
        chunks.push(Buffer.from(chunk))
      }
      text = Buffer.concat(chunks).toString('utf8')
    }
    return text ? JSON.parse(text) : null
  } catch (_) {
    return null
  }
}
