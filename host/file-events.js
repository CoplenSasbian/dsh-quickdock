/**
 * What DSH's own file tools wrote, in order, for a dock to review.
 *
 * DSH's filesystem service is the only seam its tools change files through, and
 * `fs/observed` fires once per completed mutation - the tool emits it after
 * publication (present, with a version) or after a delete (absent). Nothing a
 * build tool or a shell command writes goes through that seam, so this feed is
 * exactly "the agent changed this file": the difference between a review an
 * editor wants and every file a Gradle or Maven build happens to touch.
 *
 * The feed is a bounded ring with a monotonic sequence, read by long-poll
 * (`GET /quickdock/api/file-events?since=<seq>&wait=<ms>`). Events are not
 * consumed: several docks can follow the same cursor independently.
 */

/** Events kept for late readers; the ring drops the oldest beyond this. */
const MAX_EVENTS = 200
/** A poll may wait at most this long before it answers "nothing new". */
export const MAX_WAIT_MS = 25000
/** Default long-poll budget when a caller does not ask for one. */
export const DEFAULT_WAIT_MS = 10000

/** Sequence number a caller passes back; numbers are opaque to it. */
function cursorOf(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  const whole = Math.trunc(number)
  return whole > 0 ? whole : 0
}

export class FileEvents {
  /**
   * @param {{limit?: number, trace?: (line: string) => void}} [options]
   */
  constructor(options = {}) {
    this.trace = typeof options.trace === 'function' ? options.trace : () => {}
    const limit = Number(options.limit)
    this.limit = Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : MAX_EVENTS
    /** Every retained event, oldest first. */
    this.events = []
    /** Sequence of the newest event; 0 means "nothing recorded yet". */
    this.seq = 0
    /** Pending long-poll resolvers, woken by the next event. */
    this.waiters = new Set()
  }

  /**
   * Record DSH's file writes as they happen.
   * @param {object} ctx Cordis host context.
   * @returns {() => void} detach the subscription.
   */
  attach(ctx) {
    if (!ctx || typeof ctx.on !== 'function') return () => {}
    let off
    try {
      off = ctx.on('fs/observed', (target, observation) => this.observe(target, observation))
    } catch (error) {
      const message = String((error && error.message) || error)
      this.trace('file events: cannot listen to fs/observed: ' + message)
      return () => {}
    }
    return () => {
      try {
        if (typeof off === 'function') off()
      } catch (_) {
        /* already detached */
      }
    }
  }

  /**
   * One completed mutation, as the filesystem service reported it.
   * @param {{displayPath?: string}} target resolved target.
   * @param {{kind?: string}} observation present (a write) or absent (a delete).
   */
  observe(target, observation) {
    const path = String((target && target.displayPath) || '').trim()
    if (!path) return
    this.record(path, observation && observation.kind === 'absent' ? 'delete' : 'write')
  }

  /**
   * Append one event and wake every waiting poll.
   * @param {string} path path as DSH displays it: absolute, or workspace-relative.
   * @param {'write'|'delete'} kind what happened to the file.
   */
  record(path, kind) {
    this.seq += 1
    this.events.push({ seq: this.seq, path, kind: kind === 'delete' ? 'delete' : 'write', at: Date.now() })
    const excess = this.events.length - this.limit
    if (excess > 0) this.events.splice(0, excess)
    this.wake()
  }

  /**
   * Everything recorded after a cursor.
   * @param {number|string} cursor last sequence the caller saw.
   * @returns {{ok: boolean, seq: number, events: object[], dropped: number}} snapshot.
   */
  since(cursor) {
    const after = cursorOf(cursor)
    const oldest = this.seq - this.events.length
    return {
      ok: true,
      seq: this.seq,
      events: this.events.filter((event) => event.seq > after),
      // Events the ring had already dropped: the caller must not assume it saw
      // every write of that window (a restart of the dock, a long pause).
      dropped: after < oldest ? oldest - after : 0
    }
  }

  /**
   * The snapshot for a cursor, waiting for the next event when there is none.
   *
   * A zero budget answers immediately; so does a cursor that is already behind,
   * which keeps a busy dock from ever sleeping.
   * @param {number|string} cursor last sequence the caller saw.
   * @param {number|string} [waitMs] long-poll budget.
   * @returns {Promise<{ok: boolean, seq: number, events: object[], dropped: number}>} snapshot.
   */
  async wait(cursor, waitMs) {
    const first = this.since(cursor)
    if (first.events.length > 0 || first.dropped > 0) return first
    const budget = Math.min(MAX_WAIT_MS, Math.max(0, cursorOf(waitMs) || DEFAULT_WAIT_MS))
    await this.#sleep(budget)
    return this.since(cursor)
  }

  /** Resolve every pending poll: the ring just moved. */
  wake() {
    for (const waiter of [...this.waiters]) waiter()
  }

  /** Drop every pending poll (teardown): they answer with what is left. */
  dispose() {
    this.events = []
    // Wake first: a poll waiting on the ring must not hang until its timeout.
    this.wake()
    this.waiters.clear()
  }

  #sleep(budget) {
    if (budget <= 0) return Promise.resolve()
    return new Promise((resolve) => {
      let timer = null
      const waiter = () => {
        if (timer) clearTimeout(timer)
        timer = null
        this.waiters.delete(waiter)
        resolve()
      }
      this.waiters.add(waiter)
      timer = setTimeout(waiter, budget)
      if (typeof timer.unref === 'function') timer.unref()
    })
  }
}
