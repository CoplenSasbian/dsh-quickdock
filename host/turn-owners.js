/**
 * Which dock started the turn a session is running.
 *
 * The binding a `DockContext` holds says which session a dock is *showing*; a
 * prompt can still come from the main window, so "who shows it" is not "who
 * started it". The tools a turn gets must follow the initiator (a VS Code turn
 * gets `vscode_*`, a browser turn gets nothing), and tool `when` predicates are
 * evaluated per model step while the turn runs. This registry is that marker:
 *
 *   expectation   the dock's client reported an accepted prompt (`requestId`)
 *   claim         the agent loop claimed that message for a turn
 *   current       session -> { turn, dockId } for the running turn
 *   last          the last attributed turn, kept for diagnostics
 *
 * The correlation identity is exact: the client's submission `requestId` is the
 * `rpcId` the Host records in the durable `user/message` source. A turn that
 * starts without a claimed message (a goal round, a resume) has no owner and
 * therefore gets no dock tools, which is the safe direction.
 *
 * Pure and clock-injectable; the events and the bridge are wired in
 * `host/turn-attribution.js` and `host/quickdock-host.js`.
 */

/** How long a reported submission waits for its turn to start. */
export const EXPECTATION_TTL_MS = 120_000
/** How long the last attributed turn stays available for diagnostics. */
export const LAST_TTL_MS = 30 * 60_000
/** A runaway client cannot grow the expectation map without bound. */
const MAX_EXPECTATIONS = 256
const MAX_ID_LENGTH = 200

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function key(sessionId, requestId) {
  return sessionId + '\u0000' + requestId
}

export class TurnOwners {
  /**
   * @param {{now?: () => number, trace?: (line: string) => void,
   *   expectationTtlMs?: number, lastTtlMs?: number}} [options]
   */
  constructor(options = {}) {
    this.now = typeof options.now === 'function' ? options.now : () => Date.now()
    this.trace = typeof options.trace === 'function' ? options.trace : () => {}
    this.expectationTtlMs = Number(options.expectationTtlMs) > 0 ? Number(options.expectationTtlMs) : EXPECTATION_TTL_MS
    this.lastTtlMs = Number(options.lastTtlMs) > 0 ? Number(options.lastTtlMs) : LAST_TTL_MS
    /** requestId -> { sessionId, requestId, dockId, at } */
    this.expectations = new Map()
    /** sessionId -> { turn, dockId, at } for the running turn. */
    this.current = new Map()
    /** sessionId -> { turn, dockId, at } of the last attributed turn (running or done). */
    this.last = new Map()
  }

  /**
   * Record that `dockId` submitted a prompt whose identity is `requestId`.
   * @param {{sessionId: string, requestId: string, dockId: string}} submission
   * @returns {boolean} whether the expectation was accepted.
   */
  expect(submission) {
    const sessionId = text(submission && submission.sessionId)
    const requestId = text(submission && submission.requestId)
    const dockId = text(submission && submission.dockId)
    if (!sessionId || !requestId || !dockId) return false
    if (sessionId.length > MAX_ID_LENGTH || requestId.length > MAX_ID_LENGTH || dockId.length > MAX_ID_LENGTH) {
      return false
    }
    this.sweep()
    if (this.expectations.size >= MAX_EXPECTATIONS) {
      const oldest = this.expectations.keys().next().value
      if (oldest !== undefined) this.expectations.delete(oldest)
    }
    this.expectations.set(key(sessionId, requestId), { sessionId, requestId, dockId, at: this.now() })
    return true
  }

  /**
   * The dock that submitted one request, or '' when nothing is pending.
   * @param {string} sessionId session the prompt addressed.
   * @param {string} requestId client submission identity.
   * @returns {string} dock id, or ''.
   */
  dockFor(sessionId, requestId) {
    const entry = this.expectations.get(key(text(sessionId), text(requestId)))
    return entry ? entry.dockId : ''
  }

  /**
   * A turn opened. Keeps the number so a claim can attach to it.
   * @param {string} sessionId session id.
   * @param {number} turn turn number.
   */
  begin(sessionId, turn) {
    const id = text(sessionId)
    const number = Number(turn)
    if (!id || !Number.isInteger(number) || number < 0) return
    const current = this.current.get(id)
    if (current && current.turn === number) return
    this.current.set(id, { turn: number, dockId: '', at: this.now() })
  }

  /**
   * The agent loop claimed one message for a turn. The first claim that resolves
   * to a dock owns the turn; later claims (steering, queued input) never steal it.
   * @param {{sessionId: string, turn: number, requestId: string}} claim
   * @returns {string} the turn's owner after this claim, or ''.
   */
  claim(claim) {
    const sessionId = text(claim && claim.sessionId)
    const requestId = text(claim && claim.requestId)
    const turn = Number(claim && claim.turn)
    if (!sessionId || !Number.isInteger(turn) || turn < 0) return ''
    this.sweep()
    const dockId = requestId ? this.dockFor(sessionId, requestId) : ''
    const current = this.current.get(sessionId)
    if (!current || current.turn !== turn) {
      this.current.set(sessionId, { turn, dockId, at: this.now() })
    } else if (!current.dockId && dockId) {
      current.dockId = dockId
      current.at = this.now()
    }
    if (!dockId) return this.ownerOf(sessionId)
    if (requestId) this.expectations.delete(key(sessionId, requestId))
    this.last.set(sessionId, { turn, dockId, at: this.now() })
    this.trace('turn owner: ' + sessionId + ' turn ' + turn + ' <- ' + dockId)
    return dockId
  }

  /**
   * The turn closed: the running marker goes away, the last owner stays.
   * @param {string} sessionId session id.
   * @param {number} [turn] only close when it matches this turn.
   */
  end(sessionId, turn) {
    const id = text(sessionId)
    const current = this.current.get(id)
    if (!current) return
    if (turn !== undefined && Number(turn) !== current.turn) return
    if (current.dockId) this.last.set(id, { turn: current.turn, dockId: current.dockId, at: this.now() })
    this.current.delete(id)
  }

  /**
   * A message never became the turn's opening message (discarded, cancelled).
   * @param {{sessionId: string, requestId: string}} submission
   */
  forget(submission) {
    this.expectations.delete(key(text(submission && submission.sessionId), text(submission && submission.requestId)))
  }

  /**
   * The dock that owns the session's running turn, for a tool `when` predicate.
   * @param {string} sessionId session id.
   * @returns {string} dock id, or '' when the turn is not a dock's.
   */
  ownerOf(sessionId) {
    const current = this.current.get(text(sessionId))
    return current ? current.dockId : ''
  }

  /** The running turn, or null. */
  currentOf(sessionId) {
    const current = this.current.get(text(sessionId))
    return current ? { ...current } : null
  }

  /** The last attributed turn, or null. */
  lastOf(sessionId) {
    const last = this.last.get(text(sessionId))
    return last ? { ...last } : null
  }

  /** Drop stale expectations and old diagnostics. */
  sweep(now = this.now()) {
    for (const [mapKey, entry] of this.expectations) {
      if (now - entry.at > this.expectationTtlMs) this.expectations.delete(mapKey)
    }
    for (const [sessionId, entry] of this.last) {
      if (now - entry.at > this.lastTtlMs) this.last.delete(sessionId)
    }
    return this.expectations.size
  }

  /** Every running turn, for `dock-contexts` and diagnostics. */
  snapshot() {
    this.sweep()
    return [...this.current.entries()].map(([sessionId, entry]) => ({ sessionId, ...entry }))
  }
}
