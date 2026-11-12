/**
 * Host event wiring for turn attribution.
 *
 * The agent loop opens a turn, then claims the inbox batch for it *before* it
 * resolves the tool set (`inbox.claim` precedes `tools.resolve`), and each
 * claimed message keeps the source the client submitted it with. That ordering
 * is what makes the attribution exact and early enough for `when`:
 *
 *   turn()        append turn/start { turn }
 *   preStep()     inbox.claim(target, turn) -> agent/inbox/claimed { message, turn }
 *                 tools.resolve({ agent }) -> every `when` sees the owner
 *
 * The same facts are visible in the durable feed (`session/event`), which is
 * used as a fallback for turn boundaries and for a message that no live claim
 * carried. Kept apart from the registry so both halves are testable.
 */

import { TurnOwners } from './turn-owners.js'

/**
 * The session a scoped subject belongs to.
 *
 * Agent events resolve through `agent.session.id`; `agent.id` is the same
 * session identity in the agent loop, and older shapes expose `sessionId`.
 * @param {object} subject an agent, a session, or an event payload.
 * @returns {string} session id, or ''.
 */
function sessionIdOf(subject) {
  if (!subject || typeof subject !== 'object') return ''
  const agent = subject.agent && typeof subject.agent === 'object' ? subject.agent : subject
  const session = agent.session && typeof agent.session === 'object' ? agent.session : undefined
  const id = session ? session.id || session.sessionId : ''
  return String(id || agent.sessionId || agent.id || '').trim()
}

export class TurnAttribution {
  /**
   * @param {{owners?: TurnOwners, trace?: (line: string) => void, logger?: object}} [options]
   */
  constructor(options = {}) {
    this.trace = typeof options.trace === 'function' ? options.trace : () => {}
    this.logger = options.logger
    this.owners = options.owners instanceof TurnOwners
      ? options.owners
      : new TurnOwners({ trace: this.trace })
  }

  /**
   * Subscribe to the agent loop and the durable session feed.
   * @param {object} ctx Cordis host context.
   * @returns {() => void} detach every subscription.
   */
  attach(ctx) {
    if (!ctx || typeof ctx.on !== 'function') return () => {}
    const offs = []
    const on = (event, handler) => {
      try {
        const off = ctx.on(event, handler)
        if (typeof off === 'function') offs.push(off)
      } catch (error) {
        const message = String((error && error.message) || error)
        this.trace('turn attribution: cannot listen to ' + event + ': ' + message)
        this.logger?.warn?.('quickdock: cannot listen to %s: %s', event, message)
      }
    }
    on('agent/inbox/claimed', (payload) => this.claim(payload))
    on('agent/inbox/discarded', (payload) => this.discard(payload))
    on('session/event', (session, event) => this.durable(session, event))
    on('agent/status', (payload) => this.status(payload))
    on('agent/disposed', (payload) => this.owners.end(sessionIdOf(payload && payload.agent)))
    return () => {
      for (const off of offs) {
        try { off() } catch (_) { /* already detached */ }
      }
    }
  }

  /**
   * One claimed message: attribute the turn it opens.
   * @param {{agent?: object, message?: object, turn?: number}} payload
   */
  claim(payload) {
    const message = payload && payload.message
    const source = message && message.source
    const requestId = source && source.rpcId
    if (requestId === undefined || requestId === null) return
    this.owners.claim({
      sessionId: sessionIdOf(payload && payload.agent),
      turn: payload && payload.turn,
      requestId: String(requestId)
    })
  }

  /**
   * A pending message was cancelled before it could start a turn.
   * @param {{agent?: object, message?: object}} payload
   */
  discard(payload) {
    const message = payload && payload.message
    const source = message && message.source
    const requestId = source && source.rpcId
    if (requestId === undefined || requestId === null) return
    this.owners.forget({
      sessionId: sessionIdOf(payload && payload.agent),
      requestId: String(requestId)
    })
  }

  /**
   * The durable feed: turn boundaries, and a message whose claim was missed.
   * @param {object} session session the event belongs to.
   * @param {{type?: string, data?: object}} event session event.
   */
  durable(session, event) {
    if (!event || typeof event !== 'object') return
    const sessionId = sessionIdOf(session)
    if (!sessionId) return
    if (event.type === 'turn/start') {
      this.owners.begin(sessionId, event.data && event.data.turn)
      return
    }
    if (event.type === 'turn/end') {
      this.owners.end(sessionId, event.data && event.data.turn)
      return
    }
    if (event.type !== 'user/message') return
    const source = event.data && event.data.source
    const requestId = source && source.rpcId
    if (requestId === undefined || requestId === null) return
    const current = this.owners.currentOf(sessionId)
    if (!current || current.dockId) return
    this.owners.claim({ sessionId, turn: current.turn, requestId: String(requestId) })
  }

  /**
   * The agent went idle or was disposed: no turn is running any more.
   * @param {{agent?: object, status?: string}} payload
   */
  status(payload) {
    if (!payload || payload.status !== 'idle') return
    this.owners.end(sessionIdOf(payload.agent))
  }
}
