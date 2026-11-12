/**
 * In-memory registry of connected docks.
 *
 * One `DockContext` per connected dock instance (a VS Code window, the Electron
 * window, a browser tab, a future IDE). The descriptor a client writes only
 * carries identity, tools and the reserved fields; the binding is owned here.
 *
 * The registry is intentionally pure: the clock is injectable, nothing touches
 * the filesystem, and the HTTP layer only decides which calls reach it.
 * Contract: `DOCK-CONTEXT.md`.
 */

/** A context whose heartbeat is older than this is gone. */
export const DOCK_TTL_MS = 120_000
/** Legacy single-dock id, used by clients written before contexts existed. */
export const LEGACY_ID = 'legacy'

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * One context per connected dock.
 */
export class DockContexts {
  /**
   * @param {{now?: () => number, ttlMs?: number, trace?: (line: string) => void}} [options]
   */
  constructor(options = {}) {
    this.now = typeof options.now === 'function' ? options.now : () => Date.now()
    this.ttlMs = Number(options.ttlMs) > 0 ? Number(options.ttlMs) : DOCK_TTL_MS
    this.trace = typeof options.trace === 'function' ? options.trace : () => {}
    /** @type {Map<string, object>} */
    this.contexts = new Map()
  }

  /**
   * Create or merge one context. Only the fields present in `fields` change;
   * every call refreshes the heartbeat.
   * @param {object} fields partial context.
   * @returns {object} the stored context.
   */
  upsert(fields = {}) {
    const id = text(fields.id)
    if (!id) throw new Error('dock context id is required')
    const now = new Date(this.now()).toISOString()
    let context = this.contexts.get(id)
    if (!context) {
      context = {
        id,
        type: 'unknown',
        client: undefined,
        tools: undefined,
        workspace: undefined,
        systemPrompt: undefined,
        session: { sessionId: '', seq: 0, reloadSeq: 0 },
        createdAt: now,
        heartbeatAt: now
      }
      this.contexts.set(id, context)
      this.trace('dock context: created ' + id)
    }
    if (typeof fields.type === 'string' && fields.type.trim()) context.type = fields.type.trim()
    if (fields.client !== undefined) context.client = fields.client && typeof fields.client === 'object' ? fields.client : undefined
    if (fields.tools !== undefined) {
      context.tools = fields.tools && typeof fields.tools === 'object' ? fields.tools : undefined
    }
    if (fields.workspace !== undefined) {
      context.workspace = fields.workspace && typeof fields.workspace === 'object' ? fields.workspace : undefined
    }
    if (fields.systemPrompt !== undefined) {
      context.systemPrompt = typeof fields.systemPrompt === 'string' ? fields.systemPrompt : undefined
    }
    context.heartbeatAt = now
    return context
  }

  /** One context, or undefined. */
  get(id) {
    return this.contexts.get(text(id))
  }

  /** Every live context (after pruning). */
  list() {
    this.prune()
    return [...this.contexts.values()]
  }

  /** Remove a context; its binding and tools go with it. */
  remove(id) {
    const key = text(id)
    const existed = this.contexts.delete(key)
    if (existed) this.trace('dock context: removed ' + key)
    return existed
  }

  /** Refresh the heartbeat without changing anything else. */
  touch(id) {
    const context = this.get(id)
    if (context) context.heartbeatAt = new Date(this.now()).toISOString()
    return context
  }

  /**
   * Bind one docking context to a session. Creates the context on demand (a
   * client may call bind before its descriptor arrives).
   * @param {string} id dock id.
   * @param {string} sessionId session to show.
   * @returns {{sessionId: string, seq: number, reloadSeq: number}}
   */
  bind(id, sessionId) {
    const context = this.upsert({ id })
    const next = text(sessionId)
    // A dock reporting the session it already shows must not bump `seq`: the
    // shell would read that as "open it again" and the app would report again.
    if (context.session.sessionId !== next) {
      context.session.sessionId = next
      context.session.seq += 1
      this.trace('dock context: bind ' + context.id + ' -> ' + next + ' (seq ' + context.session.seq + ')')
    }
    return { ...context.session }
  }

  /** Bump the reload counter of one context. */
  reload(id) {
    const context = this.upsert({ id })
    context.session.reloadSeq += 1
    return { ...context.session }
  }

  /** The binding a shell polls, or undefined when the context does not exist. */
  target(id) {
    const context = this.get(id)
    return context ? { ...context.session } : undefined
  }

  /** Drop contexts whose heartbeat went stale. */
  prune(now = this.now()) {
    for (const [id, context] of this.contexts) {
      const age = now - Date.parse(context.heartbeatAt)
      if (!Number.isFinite(age) || age > this.ttlMs) {
        this.contexts.delete(id)
        this.trace('dock context: expired ' + id)
      }
    }
    return this.contexts.size
  }

  /**
   * A compact, transport-safe view for the API and the dock menu.
   * @param {string} id dock id.
   * @returns {object|null} snapshot, or null when unknown.
   */
  snapshot(id) {
    const context = this.get(id)
    if (!context) return null
    return {
      id: context.id,
      type: context.type,
      client: context.client,
      workspace: context.workspace,
      hasTools: Boolean(context.tools && context.tools.url),
      toolsUrl: context.tools && context.tools.url ? String(context.tools.url) : undefined,
      sessionId: context.session.sessionId || undefined,
      seq: context.session.seq,
      reloadSeq: context.session.reloadSeq,
      createdAt: context.createdAt,
      heartbeatAt: context.heartbeatAt
    }
  }
}
