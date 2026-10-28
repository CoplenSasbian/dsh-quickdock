/**
 * QuickDock Host composition root.
 *
 * The plugin entry only builds this object: every responsibility lives in a
 * collaborator (adapter, repository, hub, broker, supervisor) and is wired here
 * once. Construction is side-effect free; start() subscribes and registers.
 */

import { randomBytes, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createApiRouter } from './api.js'
import { createBridgeHandler } from './bridge.js'
import { CatalogService } from './catalogs.js'
import {
  API_PREFIX,
  API_VERSION,
  BRIDGE_PATH,
  CATALOG_WARMUP_MS,
  INDEX_TICKER_MS,
  MAX_TRACKED_SESSIONS,
  PAGE_PATH,
  STREAM_FLUSH_MS,
  VIEWS
} from './constants.js'
import { DockProcess } from './dock-process.js'
import { DshFacade } from './dsh.js'
import { ElectronResolver } from './electron-resolver.js'
import { EventHub } from './event-hub.js'
import { DELEGATE, InteractionBroker } from './interactions.js'
import { LocaleController } from './locale.js'
import { PageRenderer } from './page.js'
import { SessionIndex } from './session-index.js'
import { createSnapshotBuilder } from './snapshot.js'
import { StreamBuffer } from './stream-buffer.js'
import { ThemeStore } from './theme.js'
import { createTrace, traceLogPath } from './trace.js'

const require = createRequire(import.meta.url)
const { StepFolder } = require('../runtime/step-folder.js')

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Local IANA zone (DSH accepts UTC or IANA names only). */
function localTimeZone() {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    return typeof zone === 'string' && zone ? zone : 'UTC'
  } catch (_) {
    return 'UTC'
  }
}

export class QuickDockHost {
  /**
   * @param {object} ctx Cordis host context (`webServer` and `connection` injected).
   * @param {object} config validated plugin config.
   */
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
    this.dsh = new DshFacade(ctx)
    this.token = randomBytes(32).toString('base64url')
    this.tracePath = traceLogPath()
    this.trace = createTrace({ path: this.tracePath })
    this.disposers = []
    this.streamFlushTimer = null

    this.state = {
      workspaceId: config.defaultWorkspaceId || null,
      sessionId: null,
      newSession: true,
      fork: false,
      folders: new Map(),
      interaction: null,
      settings: {
        permission: 'workspace-write',
        model: '',
        reasoning: '',
        agentPreset: config.agentPreset || ''
      },
      catalogs: { permissions: [], models: [], reasoning: [], agents: [] },
      locale: 'en',
      // running: process alive; visible: a window is actually on screen.
      dock: { running: false, visible: false, alwaysOnTop: config.alwaysOnTop, error: '' }
    }

    this.publish = () => this.hub.publishState(this.snapshot())

    this.locale = new LocaleController({
      preference: config.locale,
      onChange: (locale) => this.#onLocaleChange(locale)
    })
    this.state.locale = this.locale.locale

    this.hub = new EventHub({ onStateClient: () => void this.index.refresh() })
    this.index = new SessionIndex({
      dsh: this.dsh,
      t: (key, params) => this.locale.t(key, params),
      trace: this.trace,
      publish: () => this.publish()
    })
    this.stream = new StreamBuffer()
    this.theme = new ThemeStore({
      // 'auto' keeps the built-in palette until the Client half reports one.
      fallback: config.theme,
      getSnapshot: () => this.dsh.theme?.getTheme?.(),
      onChange: (payload) => {
        this.trace('theme -> dock: ' + payload.colorScheme + ' (' + Object.keys(payload.tokens).length + ' tokens)')
        this.hub.publishTheme(payload)
      }
    })
    this.broker = new InteractionBroker({
      state: this.state,
      timeoutMs: Number(config.approvalTimeoutMs) || 300000,
      publish: () => this.publish(),
      summon: () => this.dock.summon(),
      trace: this.trace
    })
    this.catalogService = new CatalogService({
      state: this.state,
      dsh: this.dsh,
      t: (key, params) => this.locale.t(key, params),
      trace: this.trace,
      logger: this.dsh.logger,
      publish: () => this.publish()
    })
    this.snapshotBuilder = createSnapshotBuilder({
      config,
      state: this.state,
      dsh: this.dsh,
      index: this.index,
      hub: this.hub,
      stream: this.stream
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
    this.dock = new DockProcess({
      state: this.state,
      config,
      rootDir: ROOT_DIR,
      token: this.token,
      pageUrl: () => this.pageUrl(),
      resolver: this.resolver,
      logger: this.dsh.logger,
      trace: this.trace,
      t: (key, params) => this.locale.t(key, params),
      publish: () => this.publish(),
      // A hidden/closed/crashed dock can no longer answer: hand the pending
      // approval back to DSH instead of waiting for the timeout.
      onInactive: () => this.broker.reset()
    })
    this.dock.tracePath = this.tracePath

    this.page = new PageRenderer({
      rootDir: ROOT_DIR,
      theme: this.theme,
      locale: this.locale,
      trace: this.trace
    })
    this.api = createApiRouter({
      app: this,
      token: this.token,
      trace: this.trace,
      logger: this.dsh.logger
    })
    this.bridge = createBridgeHandler({ app: this })
  }

  /** Translate a key with the active locale. */
  t(key, params) {
    return this.locale.t(key, params)
  }

  /** Current state snapshot pushed to dock pages. */
  snapshot() {
    return this.snapshotBuilder()
  }

  /** Absolute page URL (token included) used by the dock process and by tests. */
  pageUrl() {
    return this.dsh.webServer.getOrigin() + PAGE_PATH + '?t=' + this.token
  }

  /* ------------------------------ lifecycle ------------------------------ */

  /** Subscribe, register routes and warm catalogs. */
  start() {
    this.#watchEvents()
    this.#registerRoutes()
    this.#registerBridge()
    this.catalogService.refreshAll()
    void this.index.refresh()
    this.#startTimers()
    this.dsh.logger?.info?.('quickdock: host half loaded')
  }

  #watchEvents() {
    this.ctx.on('theme/change', (snapshot) => {
      this.theme.acceptSnapshot(snapshot)
    })
    this.ctx.on('session/event', (session, event) => this.#onSessionEvent(session, event))
    this.ctx.on('agent/status', (payload) => this.#onAgentStatus(payload))
    this.ctx.on('agent/assistant-stream', (payload) => this.#onAssistantStream(payload))

    // Must prepend: DSH's own approval UI registers earlier in the waterfall.
    this.ctx.on('approval/request', async (request, next) => {
      if (!this.#dockCanAnswer(request)) return next()
      this.trace('approval -> dock: ' + (request.toolName || '?') + ' ' + (request.reason || ''))
      const decision = await this.broker.ask({
        kind: 'approval',
        toolName: request.toolName,
        reason: request.reason ?? '',
        // DSH already localizes this text for sandbox escalations.
        displayReason: request.displayReason,
        callId: request.callId ?? ''
      }, request.signal)
      // The dock went away before answering: DSH must take the request over,
      // otherwise the user has no dialog left to allow it.
      if (decision === DELEGATE) {
        this.trace('approval -> DSH: dock is gone')
        return next()
      }
      if (decision === null) return 'cancelled'
      return decision ? 'allowed-once' : 'rejected'
    }, { prepend: true })

    this.ctx.on('user-questions/request', async (request, next) => {
      if (!this.#dockCanAnswer(request)) return next()
      const answer = await this.broker.ask({
        kind: 'question',
        questions: request.questions ?? []
      }, request.signal)
      if (answer === DELEGATE) return next()
      // No answer (timeout / aborted): leave the request pending for DSH.
      if (answer === null) return { pending: true }
      return answer
    }, { prepend: true })
  }

  #registerRoutes() {
    this.ctx.effect(() => this.ctx.webServer.register({
      kind: 'prefix',
      path: PAGE_PATH,
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://x')
        if (url.pathname === PAGE_PATH || url.pathname === PAGE_PATH + '/') {
          if (url.searchParams.get('t') !== this.token) {
            res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
            res.end('invalid token')
            return
          }
          const view = url.searchParams.get('view') === VIEWS.display ? VIEWS.display : VIEWS.input
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
          res.end(this.page.render(view))
          return
        }
        if (url.pathname.startsWith(API_PREFIX)) {
          await this.api.handle(req, res, url)
          return
        }
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('not found')
      }
    }), 'quickdock: page + api routes')
  }

  #registerBridge() {
    this.ctx.effect(() => this.ctx.connection.fetch.register({
      path: BRIDGE_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: this.bridge
    }), 'quickdock: browser bridge route')
  }

  #startTimers() {
    // Session titles and running flags drift while a page is open.
    const indexTimer = setInterval(() => {
      if (!this.hub.sseSize) return
      void this.index.refresh()
    }, INDEX_TICKER_MS)
    if (indexTimer.unref) indexTimer.unref()
    this.#disposeOn(() => clearInterval(indexTimer), 'quickdock: session index ticker')

    const catalogTimer = setTimeout(() => void this.catalogService.refreshModels(), CATALOG_WARMUP_MS)
    this.#disposeOn(() => clearTimeout(catalogTimer), 'quickdock: catalog timer')

    if (this.config.autoLaunch) {
      const launchTimer = setTimeout(() => void this.dock.spawnDock(), 500)
      this.#disposeOn(() => clearTimeout(launchTimer), 'quickdock: launch timer')
      const retryTimer = setInterval(() => {
        if (!this.dock.child && !this.dock.stopping) void this.dock.spawnDock()
      }, 30000)
      if (retryTimer.unref) retryTimer.unref()
      this.#disposeOn(() => clearInterval(retryTimer), 'quickdock: dock retry timer')
    }

    this.#disposeOn(() => {
      if (this.streamFlushTimer) clearTimeout(this.streamFlushTimer)
      this.hub.dispose()
      this.broker.reset()
      this.dock.stop()
    }, 'quickdock: dock lifecycle')
  }

  #disposeOn(dispose, label) {
    this.ctx.effect(() => dispose, label)
  }

  /* ------------------------------ events ------------------------------ */

  #onLocaleChange(locale) {
    this.state.locale = locale
    this.hub.publishLocale(this.locale.snapshot())
    this.publish()
  }

  #onSessionEvent(session, event) {
    // Titles change as the conversation grows; the index follows slowly.
    this.index.maybeRefresh()
    if (!this.state.sessionId || session?.id !== this.state.sessionId) return
    if (event?.type === 'turn/start') this.#clearStream()
    this.#ensureFolder(session.id)
    this.state.folders.get(session.id).apply(event)
    this.publish()
  }

  #onAgentStatus(payload) {
    const agent = payload?.agent
    // Running flags belong to every session, not just the bound one.
    this.index.maybeRefresh({ force: true })
    if (!this.state.sessionId || agent?.id !== this.state.sessionId) return
    if (agent.status !== 'running') this.#clearStream()
    this.publish()
  }

  #onAssistantStream(payload) {
    if (!this.state.sessionId || !payload?.frame) return
    const sessionId = payload.agent?.id ?? payload.agent?.session?.id ?? null
    if (sessionId && sessionId !== this.state.sessionId) return
    try {
      this.stream.apply(payload.frame)
    } catch (error) {
      this.trace('stream frame failed: ' + String(error?.message || error))
    }
    this.#scheduleStreamFlush()
  }

  #clearStream() {
    if (!this.stream.clear()) return
    this.#scheduleStreamFlush()
  }

  #scheduleStreamFlush() {
    if (this.streamFlushTimer) return
    this.streamFlushTimer = setTimeout(() => {
      this.streamFlushTimer = null
      this.publish()
    }, STREAM_FLUSH_MS)
    if (this.streamFlushTimer.unref) this.streamFlushTimer.unref()
  }

  #ensureFolder(sessionId) {
    if (this.state.folders.has(sessionId)) return this.state.folders.get(sessionId)
    // Switching sessions is a client capability, so several sessions can keep
    // folded turns; bound the memory by evicting the oldest tracked one.
    while (this.state.folders.size >= MAX_TRACKED_SESSIONS) {
      const oldest = this.state.folders.keys().next().value
      if (oldest === undefined || oldest === sessionId) break
      this.state.folders.delete(oldest)
    }
    const folder = new StepFolder(this.config.maxSteps, (id) => this.trace('fold: merged duplicate row ' + id))
    this.state.folders.set(sessionId, folder)
    return folder
  }

  #sessionIdOf(request) {
    return request?.agent?.session?.id ?? request?.agent?.id ?? null
  }

  /**
   * Whether the dock may claim this request: same session, process alive and a
   * window really visible. A hidden dock must delegate, otherwise DSH waits for
   * approvalTimeoutMs with nothing on screen.
   */
  #dockCanAnswer(request) {
    const sessionId = this.#sessionIdOf(request)
    if (!sessionId || !this.state.sessionId || sessionId !== this.state.sessionId) return false
    return Boolean(this.state.dock.running && this.state.dock.visible)
  }

  /* ------------------------------ api actions ------------------------------ */

  acceptTheme(payload) {
    return this.theme.accept(payload)
  }

  acceptLocale(value) {
    return this.locale.accept(value)
  }

  answer(body) {
    return this.broker.answer(body)
  }

  /** Catalog snapshot for the page menus. */
  catalogs() {
    return this.state.catalogs
  }

  refreshModels() {
    return this.catalogService.refreshModels()
  }

  stepDetail(id, sessionId) {
    const target = sessionId || this.state.sessionId
    const folder = target ? this.state.folders.get(target) : null
    return folder?.detailOf?.(id) || { args: '', result: '' }
  }

  /* --------------------------- client capabilities --------------------------- */

  /**
   * Capability manifest for non-dock clients (IDE plugins, editors).
   *
   * The dock is one client of this API. It does not expose switching or history,
   * but the Host supports both: clients may select any workspace/session and
   * read every turn. `state.steps` always carries the latest turn (what the dock
   * renders); older turns come from /turns and /turn.
   */
  meta() {
    return {
      name: 'dsh-quickdock',
      apiVersion: API_VERSION,
      capabilities: [
        'state', 'stream', 'workspaces', 'sessions', 'select', 'bind', 'task',
        'stop', 'turns', 'turn', 'step-detail', 'catalogs', 'settings', 'answer',
        'theme', 'locale'
      ],
      // The dock UI binds the latest turn only; that is a client choice, not an
      // API limit. Turn history is read through the two endpoints below.
      turns: { latestInState: true, history: 'turns+turn', retention: 'maxSteps' },
      interactions: { approvals: 'claim-and-delegate', questions: 'claim-and-delegate' }
    }
  }

  /** Workspaces a client can switch to (sessions are listed separately). */
  listWorkspaces() {
    const workspaces = this.dsh.workspaces().map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      path: workspace.path,
      sessionCount: workspace.sessionIds.length
    }))
    return { workspaceId: this.state.workspaceId, workspaces }
  }

  /**
   * Sessions of one workspace (or every indexed session).
   * @param {string} [workspaceId] undefined/empty = all workspaces.
   */
  listSessions(workspaceId) {
    // Pickers deserve a fresh list; the refresh itself stays async/non-blocking.
    this.index.maybeRefresh()
    const workspaces = this.dsh.workspaces()
    const workspace = workspaceId ? workspaces.find((row) => row.id === workspaceId) : null
    if (workspaceId && !workspace) return { workspaceId, sessions: [] }
    const allowed = workspace ? new Set(workspace.sessionIds) : null
    const sessions = this.index.list().filter((row) => !allowed || allowed.has(row.sessionId))
    if (allowed) {
      const seen = new Set(sessions.map((row) => row.sessionId))
      // A workspace can list a session the index has not seen yet (cold/blank).
      for (const sessionId of allowed) {
        if (seen.has(sessionId)) continue
        sessions.push({
          sessionId,
          title: this.index.title(sessionId),
          cwd: '',
          updatedAt: 0,
          running: false,
          blank: true
        })
      }
      sessions.sort((a, b) => b.updatedAt - a.updatedAt)
    }
    return {
      workspaceId: workspace ? workspace.id : (workspaceId || null),
      sessions: sessions.map((row) => ({
        sessionId: row.sessionId,
        title: row.title || this.index.title(row.sessionId),
        cwd: row.cwd,
        updatedAt: row.updatedAt,
        running: row.running,
        blank: row.blank
      }))
    }
  }

  /**
   * Every turn of a session, newest last.
   *
   * Rows are only folded for sessions the Host attached to (the bound session);
   * the previews come from DSH's `turnOutline` projection, which covers the whole
   * log. A turn with `rows > 0` can be read with /turn.
   * @param {string} [sessionId] defaults to the bound session.
   */
  listTurns(sessionId) {
    const id = String(sessionId || this.state.sessionId || '')
    if (!id) return { sessionId: null, outline: false, turns: [] }
    const live = this.dsh.session(id)
    const values = live ? this.dsh.projectionValues(live, ['turnOutline']) : {}
    const outline = Array.isArray(values.turnOutline) ? values.turnOutline : null
    const folder = this.state.folders.get(id) || null
    const observed = new Map(folder ? folder.turnList().map((entry) => [entry.turn, entry]) : [])
    const turns = []
    const listed = new Set()
    if (outline) {
      for (const entry of outline) {
        if (!entry || typeof entry.turn !== 'number') continue
        const local = observed.get(entry.turn)
        listed.add(entry.turn)
        turns.push({
          turn: entry.turn,
          seq: Number(entry.seq) || 0,
          prompt: typeof entry.prompt === 'string' ? entry.prompt : '',
          response: typeof entry.response === 'string' ? entry.response : '',
          rows: local ? local.rows : 0,
          startedAt: local ? local.startedAt : '',
          endedAt: local ? local.endedAt : ''
        })
      }
    }
    if (folder) {
      for (const entry of folder.turnList()) {
        if (listed.has(entry.turn)) continue
        turns.push(Object.assign({ prompt: '', response: '' }, entry))
      }
    }
    turns.sort((a, b) => a.turn - b.turn)
    return { sessionId: id, outline: Boolean(outline), turns }
  }

  /**
   * Rows of one turn of the bound session (all turns are retained backend-side;
   * the dock simply renders the latest).
   * @param {string|number} value turn number; empty = latest.
   */
  turnDetail(value, sessionId) {
    const target = sessionId || this.state.sessionId
    const folder = target ? this.state.folders.get(target) : null
    if (!folder) return { sessionId: target || null, turn: null, observed: false, steps: [] }
    const wantsTurn = value !== '' && value !== undefined && value !== null
    const turn = wantsTurn ? Number(value) : folder.latestTurn()
    if (!Number.isFinite(turn) || (wantsTurn && !folder.hasTurn(turn))) {
      return { sessionId: target, turn: Number.isFinite(turn) ? turn : null, observed: false, steps: [] }
    }
    return { sessionId: target, turn, observed: true, steps: folder.rows(turn) }
  }

  openStateStream(req, res) {
    this.hub.openStateStream(req, res, {
      state: this.snapshot(),
      theme: this.theme.current(),
      locale: this.locale.snapshot()
    })
  }

  openBusStream(req, res) {
    this.hub.openBusStream(req, res)
  }

  /** Tell the DSH main window to open the bound session. */
  openSessionInDsh() {
    const sessionId = this.state.sessionId
    if (!sessionId) return { ok: false, error: this.t('host.noSession') }
    if (!this.hub.busSize) return { ok: false, error: this.t('host.busOffline') }
    this.hub.sendCommand({ type: 'open-session', sessionId })
    this.trace('open-in-dsh: ' + sessionId)
    return { ok: true }
  }

  /** Submit a task: fork/create a session, apply settings, queue the prompt. */
  async postTask(body) {
    const text = String(body?.text ?? '').trim()
    if (!text) throw new Error(this.t('host.missingMessage'))
    const controller = this.dsh.sessionController
    if (!controller) throw new Error(this.t('host.noSessionController'))

    const workspaceId = body?.workspaceId || this.state.workspaceId
    const fork = body?.fork === true
    let sessionId = body?.sessionId || (this.state.newSession ? null : this.state.sessionId)

    if (fork && this.state.sessionId) {
      const forked = await controller.fork({ sessionId: this.state.sessionId })
      sessionId = forked.sessionId
      this.state.sessionId = sessionId
      this.state.newSession = false
    } else if (!sessionId) {
      const created = await controller.create({
        ...(workspaceId ? { workspaceId } : {}),
        ...(this.state.settings.agentPreset ? { agentPreset: this.state.settings.agentPreset } : {})
      })
      sessionId = created.sessionId
      this.state.sessionId = sessionId
      this.state.newSession = false
      this.state.workspaceId = this.dsh.workspaceIdOf(sessionId) ?? workspaceId ?? this.state.workspaceId
      // create() does not accept a permission preset.
      this.catalogService.applyPermissionPreset(sessionId)
    } else {
      // A client may name a session it has not bound yet: follow it, so its
      // events reach the folder and the newly opened turn becomes visible.
      if (body?.sessionId && sessionId !== this.state.sessionId) {
        this.state.sessionId = sessionId
        this.state.newSession = false
        this.state.workspaceId = this.dsh.workspaceIdOf(sessionId) ?? this.state.workspaceId
        this.stream.clear()
        this.catalogService.syncSettingsFromSession(sessionId)
        this.broker.reset()
      }
      this.catalogService.applyPermissionPreset(sessionId)
    }

    // A model failure must not block the prompt (it is logged by the service).
    await this.catalogService.applyModelSelection(sessionId)

    // Keep the folded history: every prompt opens a new turn (turn/start), and
    // the dock simply renders the newest one while other clients read the rest.
    this.#ensureFolder(sessionId)

    // prompt() calls signal.throwIfAborted() immediately: the signal is required.
    const abort = new AbortController()
    try {
      await controller.prompt({
        sessionId,
        content: [{ type: 'text', text }],
        requestId: 'qd-' + randomUUID(),
        mode: this.config.submitMode === 'steer' ? 'steer' : 'queue',
        clientTimeZone: localTimeZone()
      }, abort.signal)
    } catch (error) {
      this.trace('prompt failed: ' + String(error?.message || error))
      throw error
    }

    this.publish()
    return { sessionId }
  }

  /** Switch workspace/session or start a blank conversation. */
  postSelect(body) {
    if (body?.workspaceId !== undefined) this.state.workspaceId = body.workspaceId || null
    if (body?.sessionId !== undefined) {
      this.state.sessionId = body.sessionId || null
      this.state.newSession = body.newSession === true || !body.sessionId
      if (this.state.sessionId) {
        this.state.workspaceId = this.dsh.workspaceIdOf(this.state.sessionId) ?? this.state.workspaceId
      }
    }
    if (body?.newSession === true) {
      this.state.sessionId = null
      this.state.newSession = true
    }
    this.stream.clear()
    if (this.state.sessionId) {
      // Show the session's real permission/model, not the dock's last choice.
      this.catalogService.syncSettingsFromSession(this.state.sessionId)
      this.#ensureFolder(this.state.sessionId)
      this.broker.reset()
    }
    this.publish()
    return {
      ok: true,
      workspaceId: this.state.workspaceId,
      sessionId: this.state.sessionId,
      newSession: this.state.newSession
    }
  }

  /** Update a function key; bound sessions receive the change immediately. */
  async postSettings(body) {
    const errors = []
    if (body?.permission !== undefined) {
      this.state.settings.permission = String(body.permission)
      if (this.state.sessionId && !this.catalogService.applyPermissionPreset(this.state.sessionId)) {
        errors.push(this.t('host.permissionNotApplied'))
      }
    }
    if (body?.model !== undefined) {
      this.state.settings.model = String(body.model)
      // Old effort ids may not exist on the new model.
      if (body.reasoning === undefined) this.state.settings.reasoning = ''
      if (this.state.sessionId && this.state.settings.model) {
        if (!await this.catalogService.applyModelSelection(this.state.sessionId)) {
          errors.push(this.t('host.modelNotApplied'))
        }
      }
    }
    if (body?.reasoning !== undefined) {
      this.state.settings.reasoning = String(body.reasoning)
      if (this.state.sessionId && this.state.settings.model) {
        if (!await this.catalogService.applyModelSelection(this.state.sessionId)) {
          errors.push(this.t('host.reasoningNotApplied'))
        }
      }
    }
    if (body?.agentPreset !== undefined) this.state.settings.agentPreset = String(body.agentPreset)
    this.publish()
    return errors.length ? { ok: false, error: errors.join('; ') } : { ok: true }
  }

  /** Stop the running turn of the bound session. */
  async postStop() {
    if (!this.state.sessionId) return { ok: false }
    const controller = this.dsh.sessionController
    if (!controller?.cancel) return { ok: false }
    try {
      this.stream.clear()
      await controller.cancel({ sessionId: this.state.sessionId })
    } catch (error) {
      this.dsh.logger?.warn?.('quickdock: cancel failed: %s', String(error))
      return { ok: false, error: String(error) }
    }
    this.publish()
    return { ok: true }
  }

  /** Bind the dock to an existing session (the header button path). */
  postBind(body) {
    const sessionId = String(body?.sessionId ?? '')
    if (!sessionId) return { ok: false }
    this.state.sessionId = sessionId
    this.state.newSession = false
    this.state.workspaceId = this.dsh.workspaceIdOf(sessionId) ?? this.state.workspaceId
    this.broker.reset()
    this.stream.clear()
    this.#ensureFolder(sessionId)
    this.catalogService.syncSettingsFromSession(sessionId)
    this.catalogService.refreshPermissions()
    this.publish()
    // On-demand mode: creating the dock here is the expected transition.
    this.dock.summon()
    this.dock.notifyAttach(sessionId)
    return {
      ok: true,
      dockRunning: this.dock.alive,
      // A just-spawned dock is not ready yet; the Client keeps polling.
      starting: this.dock.starting,
      error: this.state.dock.error || undefined
    }
  }

  /** Window-level settings from either page. */
  postWindow(body) {
    if (body?.alwaysOnTop !== undefined) this.state.dock.alwaysOnTop = Boolean(body.alwaysOnTop)
    this.dock.applyWindow({ alwaysOnTop: this.state.dock.alwaysOnTop })
    // Both pin buttons read runtime.alwaysOnTop.
    this.publish()
    return { ok: true, ...this.state.dock }
  }

  /** Switch the dock binding without activity (legacy open path). */
  postOpenSession(body) {
    const sessionId = String(body?.sessionId ?? '')
    if (!sessionId) return { ok: false }
    this.state.sessionId = sessionId
    this.publish()
    return { ok: true }
  }
}
