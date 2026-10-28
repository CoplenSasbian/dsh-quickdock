/**
 * Folding of the live assistant stream (agent/assistant-stream).
 *
 * session/event only carries committed messages, so a dock bound to a running
 * turn would print one blob per message. These frames provide the per-token
 * text used by both dock windows. Rendering only, never durable.
 */

import { STREAM_LIMITS } from './constants.js'

function emptyStream() {
  return { active: true, thinking: '', text: '', tools: [], turn: 0, step: 0, startedAt: Date.now() }
}

export class StreamBuffer {
  constructor() {
    this.value = null
  }

  /** Current stream snapshot, or null when nothing is streaming. */
  current() {
    return this.value
  }

  clear() {
    if (!this.value) return false
    this.value = null
    return true
  }

  /**
   * Fold one stream frame.
   * @param {{type: string, [key: string]: unknown}} frame start | chunk | end.
   */
  apply(frame) {
    if (!frame || typeof frame !== 'object') return
    if (frame.type === 'start') {
      this.value = Object.assign(emptyStream(), {
        turn: Number(frame.turn) || 0,
        step: Number(frame.step) || 0
      })
      return
    }
    if (frame.type === 'end') {
      // The durable assistant/message lands right after; let it take over.
      this.value = null
      return
    }
    if (frame.type !== 'chunk') return
    // A dock opened mid-stream never saw 'start'.
    if (!this.value) this.value = emptyStream()
    const stream = this.value
    const chunk = frame.chunk
    if (!chunk) return

    switch (chunk.type) {
      case 'reasoning-delta':
        stream.thinking += String(chunk.text ?? '')
        break
      case 'text-delta':
        stream.text += String(chunk.text ?? '')
        break
      case 'tool-call-delta': {
        const id = String(chunk.id ?? '')
        let tool = stream.tools.find((item) => item.id === id)
        if (!tool) {
          tool = { id, name: '', args: '' }
          stream.tools.push(tool)
        }
        if (chunk.name) tool.name = String(chunk.name)
        if (chunk.argumentsDelta) tool.args += String(chunk.argumentsDelta)
        if (tool.args.length > STREAM_LIMITS.args) tool.args = tool.args.slice(0, STREAM_LIMITS.args) + '…'
        break
      }
      default:
        break
    }
    // Pages render tails only, so the head can be dropped (SSE cost matters).
    if (stream.thinking.length > STREAM_LIMITS.thinking) stream.thinking = stream.thinking.slice(-STREAM_LIMITS.thinking)
    if (stream.text.length > STREAM_LIMITS.text) stream.text = stream.text.slice(-STREAM_LIMITS.text)
  }
}
