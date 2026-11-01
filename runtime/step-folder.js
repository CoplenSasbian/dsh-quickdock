'use strict';

/**
 * Folds session/event records into the rows shown by the dock.
 *
 * Read-only: no event is appended or rewritten. Each event type is handled by
 * one strategy in EVENT_HANDLERS, so adding a row type means adding a handler
 * instead of growing a switch.
 */

/** Content fingerprint: the same text always yields the same short id. */
function fingerprint(text) {
  let hash = 5381
  for (let i = 0; i < text.length; i++) hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0
  return hash.toString(36)
}

/**
 * Stable row identity.
 *
 * One assistant message can be delivered several times (streaming deltas,
 * reconnect replays); the message id merges them into one row. Without an id it
 * falls back to the content fingerprint.
 */
function rowKey(message, text) {
  const id = message && (message.id ?? message.messageId ?? message.uuid)
  if (typeof id === 'string' && id) return id
  return fingerprint(text)
}

/** Maximum characters kept in a row summary. */
const SUMMARY_MAX = 140
/** Argument keys that best explain what a step is doing, in priority order. */
const SUMMARY_KEYS = [
  'command', 'cmd', 'url', 'file_path', 'path', 'file',
  'prompt', 'text', 'name',
]

/** Collapse whitespace into one line and truncate the tail. */
function oneLine(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  const limit = max || SUMMARY_MAX
  return text.length > limit ? text.slice(0, limit - 1) + '…' : text
}

/**
 * Keep only the last three path segments.
 *
 * Rows are narrow and CSS truncates from the tail, which would hide the file
 * name; condensing the path in advance keeps the useful part visible.
 */
function shortPath(value) {
  const text = oneLine(value)
  if (!/[\\/]/.test(text)) return text
  const parts = text.split(/[\\/]+/).filter(Boolean)
  if (parts.length <= 3) return text
  return '…/' + parts.slice(-3).join('/')
}

/**
 * Condense tool arguments into one human-readable subtitle.
 *
 * The description is already the row title, so only the most telling value is
 * used: bash -> the command, read/edit -> the path, grep/glob -> the needle and
 * scope. Non-JSON arguments (still streaming) are kept verbatim.
 */
function summarizeArgs(parsed, raw) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return oneLine(raw)

  // Search tools: the pattern is the point, the path is the scope.
  const needle = typeof parsed.pattern === 'string' ? parsed.pattern
    : typeof parsed.query === 'string' ? parsed.query : ''
  if (needle.trim()) {
    const scope = typeof parsed.path === 'string' && parsed.path.trim() ? shortPath(parsed.path) : ''
    return oneLine(scope ? needle.trim() + '  in  ' + scope : needle.trim())
  }

  for (const key of SUMMARY_KEYS) {
    const value = parsed[key]
    if (typeof value !== 'string' || !value.trim()) continue
    return /path|file/i.test(key) ? shortPath(value) : oneLine(value)
  }

  // Nothing telling to show: DSH draws no `key=value` tail, so an argument the
  // summary table above does not recognize leaves the row with its title only.
  return ''
}

/**
 * Added/removed line counts for an edit.
 *
 * A plain LCS over two rolling rows is enough for a "+3 −1" badge. Huge edits
 * (>400 lines) fall back to the length difference rather than stalling a stream.
 */
function lineDiffStats(before, after) {
  const toLines = (value) => {
    const text = String(value ?? '').replace(/\r\n?/g, '\n')
    return text === '' ? [] : text.split('\n')
  }
  const a = toLines(before)
  const b = toLines(after)
  if (!a.length && !b.length) return [0, 0]
  if (a.length > 400 || b.length > 400) {
    return [Math.max(0, b.length - a.length), Math.max(0, a.length - b.length)]
  }
  let prev = new Uint32Array(b.length + 1)
  let cur = new Uint32Array(b.length + 1)
  for (let i = 1; i <= a.length; i++) {
    cur[0] = 0
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1] + 1
        : Math.max(prev[j], cur[j - 1])
    }
    const swap = prev
    prev = cur
    cur = swap
  }
  const lcs = prev[b.length]
  return [b.length - lcs, a.length - lcs]
}

/**
 * Line range from a read result footer:
 *   "(Showing lines 10-29 of 100. Use offset=30 to continue.)"
 *   "(Output capped. Showing lines 1-500. ...)"
 *   "(End of file - total 14 lines)"   <- start comes from the request offset
 */
function parseReadRange(text, offset) {
  const source = String(text || '')
  const showing = /Showing lines (\d+)-(\d+)/.exec(source)
  if (showing) return [Number(showing[1]), Number(showing[2])]
  const eof = /End of file - total (\d+) lines/.exec(source)
  if (eof) {
    const total = Number(eof[1])
    const from = Number.isFinite(offset) && offset > 0 ? offset : 1
    return from <= total ? [from, total] : null
  }
  return null
}

const EDIT_TOOL = /^(edit|edit_file)$/i
const READ_TOOL = /^(read|read_file)$/i
const MAX_DETAIL = 8000
const MAX_ROW_TEXT = 300
const MAX_DESCRIPTION = 200

/** Parse tool arguments without throwing on partial JSON. */
function parseArgs(raw) {
  try {
    return JSON.parse(raw)
  } catch (_) {
    return null
  }
}

/** Text content of a tool result message (multiple blocks are joined). */
function resultText(message) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  return blocks
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/**
 * Event strategies.
 *
 * Every handler receives the folder instance and the event, and mutates rows
 * through the folder's row helpers. Unknown event types stay ignored, which is
 * also how a future DSH event degrades safely.
 */
/**
 * Settle one tool row: status, result text, and the metadata DSH derives from
 * the result (edit diff totals, read line range).
 * @param {object} folder folder instance owning the row.
 * @param {object} row row to settle.
 * @param {{text: string, diffs?: unknown[], failed?: boolean}} result settle data.
 */
function settleTool(folder, row, result) {
  const text = String(result.text || '')
  row.status = result.failed ? 'fail' : 'done'
  if (text) row.text = text.slice(0, MAX_ROW_TEXT)

  // edit: the result's meta.diffs covers the whole file (replace_all included),
  // so it is more accurate than the argument-side estimate.
  const diffs = Array.isArray(result.diffs) ? result.diffs : null
  if (diffs && diffs.length && EDIT_TOOL.test(String(row.tool || ''))) {
    let added = 0
    let removed = 0
    for (const hunk of diffs) {
      if (!hunk || typeof hunk.newText !== 'string') continue
      const stats = lineDiffStats(typeof hunk.oldText === 'string' ? hunk.oldText : '', hunk.newText)
      added += stats[0]
      removed += stats[1]
    }
    row.delta = [added, removed]
  }
  // read: the real range comes from the footer, with the request offset as start.
  if (READ_TOOL.test(String(row.tool || ''))) {
    let offset = 1
    try {
      offset = Number(parseArgs(folder.details.get(String(row.id))?.args || '{}').offset) || 1
    } catch (_) {
      offset = 1
    }
    const range = parseReadRange(text, offset)
    if (range) row.lines = range
  }
  const detail = folder.details.get(String(row.id)) || { args: '', result: '' }
  detail.result = text.slice(0, MAX_DETAIL)
  folder.details.set(String(row.id), detail)
}

/**
 * Add or refresh one PTC sub-call row. The arguments arrive as an object, and
 * the row hangs off the parent call so the dock can nest it.
 */
function pushPtcRow(folder, data, time, seq, status) {
  const raw = typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments || {})
  const parsed = typeof data.arguments === 'string' ? parseArgs(raw) : data.arguments || null
  const description = parsed && typeof parsed.description === 'string'
    ? oneLine(parsed.description, MAX_DESCRIPTION)
    : ''
  const parent = data.parentCallId ? String(data.parentCallId) : ''
  const delta = EDIT_TOOL.test(String(data.name || ''))
    && parsed && typeof parsed.old_string === 'string' && typeof parsed.new_string === 'string'
    ? lineDiffStats(parsed.old_string, parsed.new_string)
    : null
  folder.pushRow(seq, {
    id: 'tool-' + data.subCallId,
    kind: 'tool',
    tool: String(data.name || ''),
    description,
    command: summarizeArgs(parsed, raw),
    status,
    time,
    ...parent ? { parent } : {},
    ...delta ? { delta } : {},
  })
  folder.details.set('tool-' + data.subCallId, { args: raw.slice(0, MAX_DETAIL), result: '' })
  return folder.byId.get('tool-' + data.subCallId)
}

const EVENT_HANDLERS = {
  'turn/start'(folder, event) {
    // A new prompt opens a turn. Rows still belong to the previous turns; the
    // dock renders only the newest one, other clients can read any turn.
    const last = folder.turns[folder.turns.length - 1]
    const seq = Number(event.seq) || 0
    // A replayed/retried boundary must not reopen or reorder the list.
    if (last && seq <= last.seq) return
    const turn = Number(event.data && event.data.turn)
    if (last && Number.isFinite(turn) && turn <= last.turn) return
    folder.turns.push({
      turn: Number.isFinite(turn) ? turn : (last ? last.turn + 1 : 1),
      seq,
      time: event.time || '',
      endedAt: ''
    })
  },

  'turn/end'(folder, event) {
    const last = folder.turns[folder.turns.length - 1]
    if (!last) return
    const turn = Number(event.data && event.data.turn)
    const entry = Number.isFinite(turn)
      ? folder.turns.find((item) => item.turn === turn)
      : last
    if (entry) entry.endedAt = event.time || ''
  },

  'tool/call'(folder, event) {
    const { data, time, seq } = event
    const raw = String(data.arguments ?? '')
    const parsed = parseArgs(raw)
    // The description is the title; the command is the one-line subtitle.
    const description = parsed && typeof parsed.description === 'string'
      ? oneLine(parsed.description, MAX_DESCRIPTION)
      : ''
    const toolName = String(data.name || '')
    // Edit rows can count their lines right away; read rows wait for the result.
    const delta = EDIT_TOOL.test(toolName)
      && parsed && typeof parsed.old_string === 'string' && typeof parsed.new_string === 'string'
      ? lineDiffStats(parsed.old_string, parsed.new_string)
      : null
    // Sub-calls name their parent: the dock nests them like the call tree the
    // main window draws, instead of flattening them into sibling rows.
    const parent = data.parentCallId ? String(data.parentCallId) : ''
    folder.pushRow(seq, {
      id: 'tool-' + data.callId,
      kind: 'tool',
      tool: data.name,
      description: description.slice(0, MAX_DESCRIPTION),
      command: summarizeArgs(parsed, raw),
      status: 'run',
      time: time ?? '',
      ...parent ? { parent } : {},
      ...delta ? { delta } : {},
    })
    // Full arguments live in details only (keeps the state snapshot small).
    folder.details.set('tool-' + data.callId, { args: raw.slice(0, MAX_DETAIL), result: '' })
  },

  'tool/result'(folder, event) {
    const { data } = event
    const row = folder.byId.get('tool-' + data.message.toolCallId)
    if (!row) return
    settleTool(folder, row, {
      text: resultText(data.message),
      diffs: data.meta?.diffs,
      failed: Boolean(data.error || data.message.content?.[0]?.isError),
    })
  },

  /**
   * PTC sub-calls: a run_code call dispatches real tools from inside the program.
   * They arrive as their own event pair (dispatch-start / dispatch) with
   * subCallId + parentCallId, which is exactly the call tree the main window
   * draws — without these the dock shows one opaque "code" row.
   */
  'tool/ptc-dispatch-start'(folder, event) {
    const { data, time, seq } = event
    if (!data || !data.subCallId) return
    pushPtcRow(folder, data, time ?? '', seq, 'run')
  },

  'tool/ptc-dispatch'(folder, event) {
    const { data, time, seq } = event
    if (!data || !data.subCallId) return
    const id = 'tool-' + data.subCallId
    const row = folder.byId.get(id) || pushPtcRow(folder, data, time ?? '', seq, 'done')
    if (!row) return
    settleTool(folder, row, {
      text: resultText({ content: data.content }),
      failed: Boolean(data.isError),
    })
  },

  'assistant/message'(folder, event) {
    const { data, time, seq } = event
    const message = data.message ?? {}
    for (const block of (message.content ?? [])) {
      if (block.type === 'reasoning' && typeof block.text === 'string' && block.text.trim()) {
        folder.pushRow(seq, {
          id: 'think-' + rowKey(message, block.text),
          kind: 'think',
          text: block.text,
          status: 'done',
          time: time ?? ''
        })
      } else if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        folder.pushRow(seq, {
          id: 'say-' + rowKey(message, block.text),
          kind: 'say',
          text: block.text,
          status: 'done',
          time: time ?? ''
        })
      }
    }
  },

  'approval/asked'(folder, event) {
    const { data, time, seq } = event
    folder.pushRow(seq, {
      id: 'ask-' + data.id,
      kind: 'tool',
      tool: data.toolName,
      command: data.reason ?? '',
      status: 'ask',
      time: time ?? ''
    })
  },

  'approval/decided'(folder, event) {
    const row = folder.byId.get('ask-' + event.data.id)
    if (row) row.status = event.data.outcome === 'allowed-once' ? 'done' : 'fail'
  }
}

class StepFolder {
  /**
   * @param {number} maxSteps maximum retained rows.
   * @param {(id: string) => void} [onMerge] called when a duplicate id merges.
   */
  constructor(maxSteps, onMerge) {
    this.maxSteps = maxSteps
    this.onMerge = typeof onMerge === 'function' ? onMerge : null
    this.reset()
  }

  reset() {
    /** Rows in arrival order. */
    this.list = []
    /** Row id -> row (tool/result and approval/decided update rows in place). */
    this.byId = new Map()
    /** Row id -> event sequence, used to filter by turn. */
    this.seqOf = new Map()
    /**
     * Row id -> full {args, result} detail for expanding a row.
     *
     * Not part of the row and never pushed: one turn can hold dozens of tool
     * calls whose arguments would bloat every state frame. Pages fetch a row on
     * demand (GET /quickdock/api/step-detail).
     */
    this.details = new Map()
    /**
     * Started turns in ascending order: { turn, seq, time, endedAt }.
     * Rows are attributed to a turn by their event sequence (half-open range
     * [this turn's seq, next turn's seq)).
     */
    this.turns = []
  }

  /** Turn number of the latest started turn, or null. */
  latestTurn() {
    return this.turns.length ? this.turns[this.turns.length - 1].turn : null
  }

  /** Number of started turns (all of them, even when their rows were evicted). */
  get turnCount() {
    return this.turns.length
  }

  /** Whether a turn with this number was recorded. */
  hasTurn(turn) {
    const value = Number(turn)
    return this.turns.some((entry) => entry.turn === value)
  }

  /**
   * Rows of one turn, or of the latest turn when omitted (what the dock renders).
   * @param {number|null} [turn] turn number from the turn/start payload.
   * @returns {object[]}
   */
  rows(turn) {
    if (!this.turns.length) return this.list.slice()
    const index = turn === undefined || turn === null
      ? this.turns.length - 1
      : this.turns.findIndex((entry) => entry.turn === Number(turn))
    if (index < 0) return []
    const from = this.turns[index].seq
    const to = index + 1 < this.turns.length ? this.turns[index + 1].seq : Infinity
    return this.list.filter((row) => {
      const seq = this.seqOf.get(row.id) ?? 0
      return seq >= from && seq < to
    })
  }

  /**
   * Turn metadata for history clients: number, boundary sequence, timestamps and
   * how many rows this backend still retains for it (older rows are evicted
   * beyond maxSteps; the turn stays listed so navigation does not lose turns).
   */
  turnList() {
    return this.turns.map((entry, index) => {
      const from = entry.seq
      const to = index + 1 < this.turns.length ? this.turns[index + 1].seq : Infinity
      let count = 0
      for (const row of this.list) {
        const seq = this.seqOf.get(row.id) ?? 0
        if (seq >= from && seq < to) count += 1
      }
      return {
        turn: entry.turn,
        seq: entry.seq,
        startedAt: entry.time,
        endedAt: entry.endedAt,
        rows: count
      }
    })
  }

  /**
   * Insert or merge one row.
   * @param {number} seq event sequence.
   * @param {object} row row fields (id required).
   */
  pushRow(seq, row) {
    const existing = this.byId.get(row.id)
    if (existing) {
      // Same id again (replay or streaming increment): merge in place and keep
      // the original timestamp so the visible time does not jump around.
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
      this.details.delete(dropped.id)
    }
    this.list.push(row)
    this.byId.set(row.id, row)
    this.seqOf.set(row.id, seq)
  }

  /**
   * Fold one session event.
   * @param {{type: string, seq: number, data: object, time?: string}} event
   * @returns {object[]} rows of the latest turn.
   */
  apply(event) {
    const handler = EVENT_HANDLERS[event?.type]
    if (handler) handler(this, event)
    return this.rows()
  }

  /** Full detail of one row (fetched on demand); null when unknown. */
  detailOf(id) {
    return this.details.get(String(id)) || null
  }
}

module.exports = { StepFolder, lineDiffStats, parseReadRange };
