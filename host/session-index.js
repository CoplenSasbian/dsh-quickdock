/**
 * Session title index (repository).
 *
 * Cold sessions are not loaded into `sessions`, and their projections are the
 * only place a real title survives. sessionController.list() is the cold-safe
 * reader and also feeds the running flag shown in the dock.
 */

import { SESSION_INDEX_TTL_MS } from './constants.js'

function basename(cwd) {
  const parts = String(cwd || '').split(/[\\/]/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : ''
}

export class SessionIndex {
  /**
   * @param {{dsh: object, t: (key: string, params?: object) => string,
   *          trace: (message: unknown) => void, publish: () => void, ttlMs?: number}} deps
   */
  constructor(deps) {
    this.dsh = deps.dsh
    this.t = deps.t
    this.trace = deps.trace
    this.publish = deps.publish
    this.ttlMs = deps.ttlMs ?? SESSION_INDEX_TTL_MS
    this.entries = new Map()
    this.refreshedAt = 0
    this.lastAttemptAt = 0
  }

  /** Index entry for a session id, or undefined. */
  meta(sessionId) {
    return sessionId ? this.entries.get(sessionId) : undefined
  }

  /** When the index was last refreshed. */
  get updatedAt() {
    return this.refreshedAt
  }

  /** Force a refresh from DSH (also called when a page connects). */
  async refresh() {
    const controller = this.dsh.sessionController
    if (!controller?.list) return
    this.lastAttemptAt = Date.now()
    try {
      const rows = await controller.list()
      if (!Array.isArray(rows)) return
      const next = new Map()
      for (const row of rows) {
        const id = String(row?.sessionId ?? '')
        if (!id) continue
        const values = row?.projections?.values ?? {}
        next.set(id, {
          title: typeof values.title === 'string' ? values.title.trim() : '',
          updatedAt: Number(row.updatedAt) || 0,
          running: row.running === true,
          blank: row.blank === true,
          cwd: typeof row.cwd === 'string' ? row.cwd : ''
        })
      }
      this.entries = next
      this.refreshedAt = Date.now()
      this.publish()
    } catch (error) {
      this.trace('session list failed: ' + String(error?.message || error))
    }
  }

  /**
   * Refresh at most once per TTL.
   * @param {{force?: boolean}} [options] force ignores the TTL.
   */
  maybeRefresh(options = {}) {
    const now = Date.now()
    if (!options.force && now - this.lastAttemptAt < this.ttlMs) return
    void this.refresh()
  }

  /** Title from a live session's projections. */
  liveTitle(session) {
    if (!session) return ''
    try {
      const values = this.dsh.projectionValues(session, ['title', 'sessionListMetadata'])
      if (typeof values.title === 'string' && values.title.trim()) return values.title.trim()
      return basename(session.header?.cwd) || String(session.id || '')
    } catch (_) {
      return String(session.id || '')
    }
  }

  /** Timestamp of the last user prompt (null when unknown). */
  lastPromptAt(session) {
    if (!session) return null
    try {
      const values = this.dsh.projectionValues(session, ['sessionListMetadata'])
      const stamp = values?.sessionListMetadata?.lastPromptAt
      return typeof stamp === 'number' ? stamp : null
    } catch (_) {
      return null
    }
  }

  /**
   * Display title for a session row.
   *
   * Order: index title -> live projection -> cwd basename -> a localized
   * placeholder. A session id is never shown as a title.
   */
  title(sessionId, live) {
    const meta = this.meta(sessionId)
    if (meta?.title) return meta.title
    if (live) {
      const fromLive = this.liveTitle(live)
      if (fromLive && fromLive !== live.id) return fromLive
    }
    const base = basename(meta?.cwd || live?.header?.cwd)
    if (base) return base
    return meta?.blank === false ? this.t('host.untitledSession') : this.t('host.newSessionTitle')
  }
}
