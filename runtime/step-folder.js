'use strict';

/**
 * 把 session/event 折成 dock 展示用的行。
 *
 * 只读折叠：绝不 append 或改写任何事件。
 * 对外只暴露 rows()（最新一轮的行）和 apply()（吃一个事件）。
 */

/** 内容指纹：同样的文本得到同一个短串。 */
function fingerprint(text) {
  let hash = 5381
  for (let i = 0; i < text.length; i++) hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0
  return hash.toString(36)
}

/**
 * 折叠行的稳定标识。
 *
 * 同一条 assistant 消息可能被投递多次（流式增量、重连重放），
 * 用它来归并成一行；取不到消息 id 时退回内容指纹。
 */
function rowKey(message, text) {
  const id = message && (message.id ?? message.messageId ?? message.uuid)
  if (typeof id === 'string' && id) return id
  return fingerprint(text)
}

class StepFolder {
  /**
   * @param maxSteps 最多保留多少行
   * @param onMerge  同一 id 被重复折进来时的回调（用于排查重复投放）
   */
  constructor(maxSteps, onMerge) {
    this.maxSteps = maxSteps
    this.onMerge = typeof onMerge === 'function' ? onMerge : null
    this.reset()
  }

  reset() {
    /** 按时间顺序的行 */
    this.list = []
    /** 行 id → 行，用于 tool/result、approval/decided 回填状态 */
    this.byId = new Map()
    /** 行 id → 触发它的事件序号，用于按轮次过滤 */
    this.seqOf = new Map()
    /** 最新一轮从哪个事件序号开始 */
    this.turnStartSeq = null
  }

  /** 最新一轮的行（给 state 用）。 */
  rows() {
    const from = this.turnStartSeq
    if (from === null) return this.list.slice()
    return this.list.filter((row) => (this.seqOf.get(row.id) ?? 0) >= from)
  }

  apply(event) {
    const { type, seq, data, time } = event
    const push = (row) => {
      const existing = this.byId.get(row.id)
      if (existing) {
        // 同一个 id 再次到达（重连重放、流式增量更新）：就地合并，不新增行。
        // 时间保持首次出现的值，避免已经显示的时间戳来回跳。
        const { time: _ignored, ...fields } = row
        Object.assign(existing, fields)
        this.seqOf.set(row.id, seq)
        if (this.onMerge) this.onMerge(row.id)
        return
      }
      if (this.list.length >= this.maxSteps) {
        const dropped = this.list.shift()
        this.byId.delete(dropped.id)
        this.seqOf.delete(dropped.id)
      }
      this.list.push(row)
      this.byId.set(row.id, row)
      this.seqOf.set(row.id, seq)
    }
    switch (type) {
      case 'turn/start': {
        // 新一轮提问开始：只展示这之后的记录
        this.turnStartSeq = seq
        break
      }
      case 'tool/call': {
        const raw = String(data.arguments ?? '')
        let parsed = null
        try { parsed = JSON.parse(raw) } catch { parsed = null }
        // description 是给人看的摘要，放前面；原始 JSON 压缩后跟在后面
        const description = parsed && typeof parsed.description === 'string' ? parsed.description.trim() : ''
        let cmd = ''
        try { cmd = parsed ? JSON.stringify(parsed) : raw } catch { cmd = raw }
        push({
          id: 'tool-' + data.callId,
          kind: 'tool',
          tool: data.name,
          description: description.slice(0, 200),
          command: cmd.slice(0, 600),
          status: 'run',
          time: time ?? '',
        })
        break
      }
      case 'tool/result': {
        const row = this.byId.get('tool-' + data.message.toolCallId)
        if (row) {
          row.status = data.error || data.message.content?.[0]?.isError ? 'fail' : 'done'
          const text = data.message.content?.find?.((b) => b.type === 'text')?.text
          if (typeof text === 'string') row.text = text.slice(0, 300)
        }
        break
      }
      case 'assistant/message': {
        const message = data.message ?? {}
        const content = message.content ?? []
        for (const block of content) {
          if (block.type === 'reasoning' && typeof block.text === 'string' && block.text.trim()) {
            push({ id: 'think-' + rowKey(message, block.text), kind: 'think', text: block.text, status: 'done', time: time ?? '' })
          } else if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
            push({ id: 'say-' + rowKey(message, block.text), kind: 'say', text: block.text, status: 'done', time: time ?? '' })
          }
        }
        break
      }
      case 'approval/asked': {
        push({ id: 'ask-' + data.id, kind: 'tool', tool: data.toolName, command: data.reason ?? '', status: 'ask', time: time ?? '' })
        break
      }
      case 'approval/decided': {
        const row = this.byId.get('ask-' + data.id)
        if (row) row.status = data.outcome === 'allowed-once' ? 'done' : 'fail'
        break
      }
      default:
        break
    }
    return this.rows()
  }
}

module.exports = { StepFolder };
