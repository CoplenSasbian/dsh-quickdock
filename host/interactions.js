/**
 * Approval / question broker.
 *
 * DSH dispatches both requests as waterfalls. When the dock owns the bound
 * session and the window is really visible, the broker claims the request and
 * resolves it from the dock UI. Otherwise the listener delegates with next().
 */

import { randomUUID } from 'node:crypto'

/** Result returned to `approval/request` when nobody answered in time. */
const NO_ANSWER = null

export class InteractionBroker {
  /**
   * @param {{state: object, timeoutMs: number, publish: () => void,
   *          summon: () => void, trace: (message: unknown) => void}} deps
   */
  constructor(deps) {
    this.state = deps.state
    this.timeoutMs = deps.timeoutMs
    this.publish = deps.publish
    this.summon = deps.summon
    this.trace = deps.trace
    this.pending = null
  }

  /** The interaction currently shown to the user, or null. */
  current() {
    return this.state.interaction
  }

  /**
   * Ask the dock user a question.
   * @param {object} payload interaction payload ({kind:'approval'|'question', ...}).
   * @param {AbortSignal} [signal] request lifetime from DSH.
   * @returns {Promise<boolean|object|null>} allow/deny, answer payload, or null.
   */
  ask(payload, signal) {
    // A decision needs a visible landing spot: raise the dock first.
    try {
      this.summon()
    } catch (error) {
      this.trace('approval summon failed: ' + error)
    }
    return new Promise((resolve) => {
      const id = 'q-' + randomUUID()
      const timeout = setTimeout(() => finish(null), this.timeoutMs)
      if (timeout.unref) timeout.unref()
      const onAbort = () => finish(null)
      this.state.interaction = Object.assign({}, payload, { id, status: 'open' })
      this.publish()

      const finish = (result) => {
        clearTimeout(timeout)
        signal?.removeEventListener?.('abort', onAbort)
        if (this.state.interaction?.id === id) this.state.interaction = null
        this.pending = null
        this.publish()
        resolve(result)
      }
      signal?.addEventListener?.('abort', onAbort, { once: true })

      this.pending = finish
    })
  }

  /**
   * Resolve the open interaction from a page request.
   * @param {{id: string, outcome?: string, answers?: object[]}} body
   * @returns {boolean} whether an interaction was waiting for this answer.
   */
  answer(body) {
    const pending = this.pending
    const interaction = this.state.interaction
    if (!pending || !interaction || interaction.id !== body?.id) return false
    if (interaction.kind === 'approval') pending(body.outcome === 'allow')
    else pending({ answers: body.answers ?? [] })
    return true
  }

  /** Drop any pending interaction (window hidden, session switched, dispose). */
  reset() {
    if (!this.state.interaction && !this.pending) return
    this.state.interaction = null
    const pending = this.pending
    this.pending = null
    pending?.(NO_ANSWER)
  }
}
