/**
 * Adapter over the DSH host services.
 *
 * The plugin talks to a handful of optional services, and every call site used to
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

  get connection() {
    return this.ctx.connection
  }

  /** Injected services (declared in the plugin's `inject` list). */
  get webServer() {
    return this.ctx.webServer
  }

  /** The Web GUI this process serves (absent in a headless composition). */
  get webApp() {
    return this.#get('webApp')
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

  get workspaceRegistry() {
    return this.#get('workspaceRegistry')
  }

  get theme() {
    return this.#get('theme')
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
}
