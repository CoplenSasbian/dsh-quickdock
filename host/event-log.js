/**
 * Pass-through log of session events.
 *
 * The Host folds rows for the dock, but a client must never see only what the
 * dock happens to render: every event a session emits is retained here verbatim
 * and served over the API. Filtering belongs to the client — an IDE plugin can
 * read `todo/write`, `job/*` or `workspace/changes` even though the run window
 * draws none of them.
 *
 * The log is bounded per session (count and bytes, oldest evicted first) so a
 * long agent run cannot grow the process without limit; `dropped` reports what
 * the bound cut off.
 */

/** Turn one filter expression ("tool/*,assistant/message") into a predicate. */
export function eventMatcher(expression) {
  const text = String(expression || '').trim()
  if (!text) return null
  const exact = new Set()
  const prefixes = []
  for (const part of text.split(',')) {
    const token = part.trim()
    if (!token) continue
    if (token.endsWith('/*')) prefixes.push(token.slice(0, -1))
    else if (token === '*') prefixes.push('')
    else exact.add(token)
  }
  if (!exact.size && !prefixes.length) return null
  return (type) => exact.has(type) || prefixes.some((prefix) => type.startsWith(prefix))
}

export class EventLog {
  /**
   * @param {{maxEvents?: number, maxBytes?: number, maxSessions?: number}} [limits]
   */
  constructor(limits = {}) {
    this.maxEvents = limits.maxEvents ?? 2000
    this.maxBytes = limits.maxBytes ?? 8 * 1024 * 1024
    this.maxSessions = limits.maxSessions ?? 8
    this.sessions = new Map()
  }

  /** Per-session bucket, touched so the least recently used session evicts first. */
  #bucket(sessionId) {
    const existing = this.sessions.get(sessionId)
    if (existing) {
      this.sessions.delete(sessionId)
      this.sessions.set(sessionId, existing)
      return existing
    }
    const bucket = { events: [], bytes: 0, dropped: 0, latestSeq: 0 }
    this.sessions.set(sessionId, bucket)
    while (this.sessions.size > this.maxSessions) {
      const oldest = this.sessions.keys().next().value
      this.sessions.delete(oldest)
    }
    return bucket
  }

  /**
   * Retain one event exactly as the session emitted it.
   * @param {string} sessionId owning session.
   * @param {{type: string, seq?: number, time?: number, data?: unknown,
   *          surfaceOp?: unknown}} event session event.
   * @returns {object|null} the stored record.
   */
  append(sessionId, event) {
    if (!sessionId || !event || typeof event !== 'object') return null
    const type = String(event.type || '')
    if (!type) return null
    const record = {
      seq: Number(event.seq) || 0,
      time: event.time ?? 0,
      type,
      data: event.data === undefined ? null : event.data
    }
    if (event.surfaceOp !== undefined) record.surfaceOp = event.surfaceOp

    const bucket = this.#bucket(sessionId)
    const size = JSON.stringify(record).length
    bucket.events.push(record)
    bucket.bytes += size
    if (record.seq > bucket.latestSeq) bucket.latestSeq = record.seq
    while (bucket.events.length > this.maxEvents || bucket.bytes > this.maxBytes) {
      const dropped = bucket.events.shift()
      if (!dropped) break
      bucket.bytes -= JSON.stringify(dropped).length
      bucket.dropped += 1
    }
    return record
  }

  /**
   * Read events after a sequence number.
   * @param {string} sessionId owning session.
   * @param {{from?: number|string, limit?: number|string, type?: string}} [query]
   * @returns {{sessionId: string, events: object[], latestSeq: number,
   *            dropped: number, retained: number}}
   */
  list(sessionId, query = {}) {
    const bucket = this.sessions.get(sessionId)
    if (!bucket) return { sessionId, events: [], latestSeq: 0, dropped: 0, retained: 0 }
    // Reading counts as use: a client polling one session keeps that one alive.
    this.sessions.delete(sessionId)
    this.sessions.set(sessionId, bucket)
    const from = Number(query.from) || 0
    const limit = Math.min(Math.max(Number(query.limit) || 200, 1), 1000)
    const match = eventMatcher(query.type)
    const events = []
    for (const record of bucket.events) {
      if (record.seq <= from) continue
      if (match && !match(record.type)) continue
      events.push(record)
      if (events.length >= limit) break
    }
    return {
      sessionId,
      events,
      latestSeq: bucket.latestSeq,
      dropped: bucket.dropped,
      retained: bucket.events.length
    }
  }

  /** Drop one session's log (session reset). */
  forget(sessionId) {
    return this.sessions.delete(sessionId)
  }

  /** Connected session count, for diagnostics. */
  get size() {
    return this.sessions.size
  }
}
