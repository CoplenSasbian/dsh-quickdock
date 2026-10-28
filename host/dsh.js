/**
 * Adapter over the DSH host services.
 *
 * The plugin talks to a dozen optional services, and every call site used to
 * repeat the same `try { ctx.get(...) }` guard. This facade keeps that knowledge
 * in one place: a missing service yields an empty result instead of throwing.
 */

const EMPTY = Object.freeze([])

export class DshFacade {
  /** @param {object} ctx Cordis host context. */
  constructor(ctx) {
    this.ctx = ctx
  }

  get logger() {
    return this.ctx.logger
  }

  /** Injected services (declared in the plugin's `inject` list). */
  get webServer() {
    return this.ctx.webServer
  }

  get connection() {
    return this.ctx.connection
  }

  get baseDir() {
    return this.ctx.root?.baseDir
  }

  #get(name) {
    try {
      return this.ctx.get(name)
    } catch (_) {
      return undefined
    }
  }

  get sessions() {
    return this.#get('sessions')
  }

  get sessionController() {
    return this.#get('sessionController')
  }

  get agents() {
    return this.#get('agents')
  }

  get projections() {
    return this.#get('sessionProjections')
  }

  get permissionPresets() {
    return this.#get('permissionPresets')
  }

  get agentPresets() {
    return this.#get('agentPresets')
  }

  get workspaceRegistry() {
    return this.#get('workspaceRegistry')
  }

  get theme() {
    return this.#get('theme')
  }

  /** One live session object, or undefined when it is not loaded. */
  session(sessionId) {
    if (!sessionId) return undefined
    try {
      return this.sessions?.get?.(sessionId)
    } catch (_) {
      return undefined
    }
  }

  /** Agent status ('running', ...) or undefined. */
  agentStatus(sessionId) {
    if (!sessionId) return undefined
    try {
      return this.agents?.get?.(sessionId)?.status
    } catch (_) {
      return undefined
    }
  }

  runningAgents() {
    try {
      const rows = this.agents?.list?.() ?? EMPTY
      return Array.isArray(rows) ? rows : EMPTY
    } catch (_) {
      return EMPTY
    }
  }

  /**
   * Workspaces with their session ids.
   * @returns {{id: string, name: string, path: string, sessionIds: string[]}[]}
   */
  workspaces() {
    try {
      const rows = this.workspaceRegistry?.list?.() ?? EMPTY
      if (!Array.isArray(rows)) return []
      return rows.map((row) => ({
        id: String(row.id),
        name: String(row.title ?? row.name ?? row.id),
        path: String(row.path ?? ''),
        sessionIds: Array.isArray(row.sessionIds) ? row.sessionIds : []
      }))
    } catch (_) {
      return []
    }
  }

  /** Workspace id owning a session, or null when unknown. */
  workspaceIdOf(sessionId) {
    if (!sessionId) return null
    for (const workspace of this.workspaces()) {
      if (workspace.sessionIds.includes(sessionId)) return workspace.id
    }
    return null
  }

  /** Projection values for a session (empty object when unavailable). */
  projectionValues(session, keys) {
    try {
      return this.projections?.snapshot?.(session, keys)?.values ?? {}
    } catch (_) {
      return {}
    }
  }

  /** One projected state slice (undefined when unavailable). */
  projectionState(session, key) {
    try {
      return this.projections?.stateOf?.(session, key)
    } catch (_) {
      return undefined
    }
  }
}
