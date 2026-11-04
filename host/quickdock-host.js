/**
 * QuickDock Host composition root.
 *
 * The plugin is a window around DSH's own Web UI: it owns a fixed loopback
 * listener that serves one shell page (title bar + iframe), a small bridge the
 * Client half uses, and the Electron supervisor that shows the window. All dock
 * content comes from DSH itself, so no session data is modelled here.
 */

import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createApiRouter } from './api.js'
import { createBridgeHandler } from './bridge.js'
import { API_PREFIX, API_VERSION, BIND_HOST, BRIDGE_PATH, DEFAULT_PORT, PAGE_PATH } from './constants.js'
import { DshFacade } from './dsh.js'
import { ElectronResolver } from './electron-resolver.js'
import { sendJson } from './http.js'
import { LocaleController } from './locale.js'
import { PageRenderer } from './page.js'
import { DEFAULT_CONFIG, configPath, readConfig, resolveValue, sanitize, writeConfig, writeTemplateIfMissing } from './config-file.js'
import { createDockComponent } from './dock-component.js'
import { readVersion } from './version.js'
import { ThemeStore } from './theme.js'
import { createTrace, traceLogPath } from './trace.js'

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

    this.state = {
      sessionId: null,
      // The loopback listener: one address, no token (see config.port).
      server: { port: Number(config.port) || DEFAULT_PORT, ok: false, error: '' },
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
  dockTargetInfo() {
    return { sessionId: this.state.sessionId || '', seq: this.dockTargetSeq, reloadSeq: this.dockReloadSeq }
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

  /** The shell page address (no token: the fixed port is the handshake). */
  pageUrl() {
    const port = (this.state.server && this.state.server.port) || this.serverPort()
    return 'http://' + BIND_HOST + ':' + port + PAGE_PATH + '?view=frame'
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
    }
    const version = readVersion(ROOT_DIR)
    this.state.version = version
    this.trace('host half loaded: version=' + (version.pkg || '?')
      + ' commit=' + (version.hash || 'unknown') + ' startedAt=' + version.startedAt
      + ' components=' + (service ? 'service' : '-') + (dock ? '+dock' : ''))
    this.dsh.logger?.info?.('quickdock: host half loaded ' + (version.hash || ''))
    // Resident mode: the window is up before the first Dock click.
    if (service && dock && this.config.autoLaunch) {
      const launchTimer = setTimeout(() => this.dock?.summon(), 600)
      this.#disposeOn(() => clearTimeout(launchTimer), 'quickdock: launch timer')
    }
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
    // Keep the row-config copy in step so the next spawn inherits the values...
    this.config.ballSize = config.ballSize
    this.config.ballIcon = config.ballIcon
    this.config.ballAlwaysVisible = config.ballAlwaysVisible
    this.config.snapToEdge = config.snapToEdge
    this.config.closeAction = config.closeAction
    this.config.collapseOnClose = config.closeAction === 'ball'
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
      minWidth: config.minWidth,
      minHeight: config.minHeight,
      maxWidth: config.maxWidth,
      maxHeight: config.maxHeight,
      ballSize: config.ballSize,
      ballIcon: config.ballIcon,
      ballAlwaysVisible: config.ballAlwaysVisible,
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
   * Serve the shell page and the API on a fixed loopback port.
   *
   * One address, no token: the port in the config is the whole handshake. The
   * cost is that anything on this machine can call the API; that is the trade the
   * fixed port buys, and `port` is the one setting to change when it is taken.
   */
  #startServer() {
    const port = this.serverPort()
    if (!(port > 0)) {
      this.trace('server disabled: port=' + port)
      return
    }
    this.server = createServer((req, res) => { void this.handleHttp(req, res) })
    this.server.on('error', (error) => {
      const code = String(error?.code || 'error')
      this.state.server.ok = false
      this.state.server.error = code
      this.trace('server error on ' + BIND_HOST + ':' + port + ': ' + code
        + (code === 'EADDRINUSE' ? ' (port busy: set config.port to a free port)' : ''))
      this.dsh.logger?.warn?.('quickdock: cannot listen on %s:%s (%s); set config.port', BIND_HOST, port, code)
    })
    this.server.listen(port, BIND_HOST, () => {
      const address = this.server?.address()
      const bound = address && typeof address === 'object' ? address.port : port
      this.state.server.port = bound
      this.state.server.ok = true
      this.state.server.error = ''
      this.trace('server listening on http://' + BIND_HOST + ':' + bound)
    })
    this.#disposeOn(() => {
      const server = this.server
      this.server = null
      if (!server) return
      try { server.close() } catch (_) { /* already closed */ }
    }, 'quickdock: http server')
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
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '600'
      })
      res.end()
      return
    }
    if (url.pathname === PAGE_PATH || url.pathname === PAGE_PATH + '/') {
      const source = this.webUiUrl()
      if (!source) {
        res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('the DSH Web UI is not available in this composition')
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(this.page.renderFrame(source, {
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
    this.config.minWidth = config.minWidth
    this.config.minHeight = config.minHeight
    this.config.maxWidth = config.maxWidth
    this.config.maxHeight = config.maxHeight
    this.config.alwaysOnTop = config.alwaysOnTop
    this.config.rememberGeometry = config.rememberGeometry
    this.config.focusOnSummon = config.focusOnSummon
    this.config.ballSize = config.ballSize
    this.config.autoLaunch = config.autoLaunch
    this.config.prefetchElectron = config.prefetchElectron
    this.config.headerButton = config.headerButton
    this.config.ballIcon = config.ballIcon
    this.config.ballAlwaysVisible = config.ballAlwaysVisible
    this.config.snapToEdge = config.snapToEdge
    this.config.closeAction = config.closeAction
    this.config.collapseOnClose = config.closeAction === 'ball'
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
  postBind(body) {
    const sessionId = String(body?.sessionId ?? '')
    if (!sessionId) return { ok: false }
    this.state.sessionId = sessionId
    // Bump the target: the dock window is a separate app instance, and the shell
    // forwards `seq` changes to it over postMessage.
    this.dockTargetSeq += 1
    this.publish()
    // On-demand mode: creating the dock here is the expected transition - but
    // only when this composition actually mounted the window component.
    if (this.state.components.dock) {
      this.dock?.summon()
      // The user clicked Dock in the main window: the window must come forward,
      // not just become visible behind it.
      this.dockComponent?.focus?.()
      this.dock?.notifyAttach(sessionId)
    }
    return {
      ok: true,
      dockRunning: Boolean(this.dock && this.dock.alive),
      starting: Boolean(this.dock && this.dock.starting),
      error: this.state.dock.error || undefined
    }
  }

  /** Plugin metadata for the Client and for diagnostics. */
  meta() {
    return {
      name: 'dsh-quickdock',
      apiVersion: API_VERSION,
      components: this.state.components,
      capabilities: ['dock-target', 'handoff'],
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
