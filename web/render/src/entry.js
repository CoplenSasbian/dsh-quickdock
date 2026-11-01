/* DSH-parity render island.
 *
 * The dock's run window draws its rows with the same components the DSH web UI
 * uses (@deepseek-ai/dsh-client-ui-primitives, MIT), so typography, spacing,
 * dots, chevrons and the expanded cards match the main window instead of being
 * re-implemented here.
 *
 * The island owns the turn: a foldable process block (header with step count and
 * duration), its rows, the assistant replies that stay outside the fold, and the
 * live stream rows. Scrolling and hit regions stay in display.js.
 */
import {
  createElement as h, Fragment, useCallback, useEffect, useMemo, useRef, useState
} from 'react'
import { createRoot } from 'react-dom/client'
import { createComposer } from './composer.js'
import {
  DisclosureRow, TerminalBlock, DiffBlock, CodeBlock, MarkdownText, ReadBlock,
  IconAgentPresetOutlineRegular, IconBrowseOutlineRegular, IconChevronDownOutlineRegular,
  IconCodeOutlineRegular, IconEditOutlineRegular, IconGlobeOutlineRegular,
  IconSearchOutlineRegular, IconThinkOutlineRegular
} from '@deepseek-ai/dsh-client-ui-primitives'
import rowCss from './tool-row.module.css'
import './page.css'

const IDENTITY = (value) => value

/** Tool name -> leading icon. Unknown tools keep the generic agent glyph. */
const TOOL_ICONS = {
  bash: IconCodeOutlineRegular,
  pwsh: IconCodeOutlineRegular,
  shell: IconCodeOutlineRegular,
  terminal: IconCodeOutlineRegular,
  run_code: IconCodeOutlineRegular,
  workflow: IconCodeOutlineRegular,
  read: IconBrowseOutlineRegular,
  read_file: IconBrowseOutlineRegular,
  edit: IconEditOutlineRegular,
  edit_file: IconEditOutlineRegular,
  write: IconEditOutlineRegular,
  str_replace_editor: IconEditOutlineRegular,
  grep: IconSearchOutlineRegular,
  glob: IconSearchOutlineRegular,
  fs_search: IconSearchOutlineRegular,
  web_search: IconGlobeOutlineRegular,
  web_fetch: IconGlobeOutlineRegular
}

/** DSH prefixes some runtime tools (ops_bash); layouts key off the bare name. */
function baseTool(name) {
  return String(name || '').replace(/^ops_/i, '')
}

/** Category -> the row's leading label, as DSH prints it before the dot. */
const TOOL_LABELS = {
  read: 'display.tool.read',
  readImage: 'display.tool.read',
  write: 'display.tool.write',
  edit: 'display.tool.edit',
  search: 'display.tool.search',
  commands: 'display.tool.commands',
  code: 'display.tool.code',
  webSearch: 'display.tool.web',
  webFetch: 'display.tool.web',
  tools: 'display.toolFallback'
}

/** Tool name -> DSH activity category, in the order DSH classifies them. */
const CATEGORIES = [
  [/^(read)$/i, 'read'],
  [/^(read_image)$/i, 'readImage'],
  [/^(write)$/i, 'write'],
  [/^(edit|edit_file|str_replace_editor)$/i, 'edit'],
  [/^(grep|glob|fs_search)$/i, 'search'],
  [/^(bash|pwsh|shell|terminal)$/i, 'commands'],
  [/^(run_code|ptc|workflow)$/i, 'code'],
  [/^(web_search)$/i, 'webSearch'],
  [/^(web_fetch)$/i, 'webFetch']
]

/** Category -> catalog key; literals so the repository check can see every key. */
const ACT_KEYS = {
  read: 'display.act.read',
  readImage: 'display.act.readImage',
  write: 'display.act.write',
  edit: 'display.act.edit',
  search: 'display.act.search',
  commands: 'display.act.commands',
  code: 'display.act.code',
  webSearch: 'display.act.webSearch',
  webFetch: 'display.act.webFetch',
  tools: 'display.act.tools'
}

function categoryOf(tool) {
  const name = baseTool(tool)
  for (const [pattern, category] of CATEGORIES) if (pattern.test(name)) return category
  return 'tools'
}

/** "Read files, searched code and ran commands" — DSH's process-group title. */
function summarize(rows, t) {
  const counts = new Map()
  rows.forEach((row) => {
    const category = categoryOf(row.tool)
    counts.set(category, (counts.get(category) || 0) + 1)
  })
  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([category]) => t(ACT_KEYS[category] || ACT_KEYS.tools))
  if (parts.length === 0) return t('display.act.tools')
  if (parts.length === 1) return parts[0]
  if (parts.length === 2) return t('display.joinTwo', { first: parts[0], second: parts[1] })
  return t('display.more', { title: parts.slice(0, 2).join(t('display.comma')) })
}

const TERMINAL_TOOLS = /^(bash|pwsh|shell|terminal)$/i
const CODE_TOOLS = /^(run_code|ptc|workflow)$/i
const EDIT_TOOLS = /^(edit|edit_file|write|str_replace_editor)$/i
const READ_TOOLS = /^(read|read_file)$/i

/** Only the newest running row animates, mirroring DSH's single live operation. */
function runningId(steps) {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index]
    if (step && step.status === 'run') return String(step.id)
  }
  return ''
}

function parseArgs(raw) {
  if (!raw || typeof raw !== 'string') return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch (error) {
    return null
  }
}

/** Labels the DSH primitives need; every string comes from the dock catalogs. */
function makeLabels(t) {
  const shared = {
    copy: t('display.copy'),
    copied: t('display.copied'),
    collapseAria: t('display.collapse'),
    collapse: t('display.collapse'),
    expandAria: (hidden) => t('display.expandLines', { count: hidden }),
    expand: (hidden) => t('display.expandLines', { count: hidden })
  }
  const read = {
    ...shared,
    window: (shown, total) => t('display.readWindow', { shown: shown, total: total })
  }
  return {
    read: read,
    terminal: {
      ...shared,
      commandLine: (line) => t('display.commandLine', { line: line }),
      signal: (signal) => t('display.signal', { signal: signal }),
      exitCode: (code) => t('display.exitCode', { code: code }),
      noExitCode: t('display.noExitCode'),
      running: t('display.running'),
      failed: t('display.failed'),
      done: t('display.done'),
      noOutput: t('display.noOutput')
    },
    diff: shared
  }
}

/** Grammar hint from a path; unknown extensions fall back to plain monospace. */
function languageOf(path) {
  const name = String(path || '')
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/** "8s", "1m 20s", "1h 04m" — a short elapsed value, like DSH's turn header. */
function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return ''
  const total = Math.round(ms / 1000)
  if (total < 60) return total + 's'
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes < 60) return seconds ? minutes + 'm ' + String(seconds).padStart(2, '0') + 's' : minutes + 'm'
  const hours = Math.floor(minutes / 60)
  return hours + 'h ' + String(minutes % 60).padStart(2, '0') + 'm'
}

/** Milliseconds between the turn's start and its end (or now while running). */
function elapsedOf(turn, running, now) {
  if (!turn || !turn.startedAt) return 0
  const start = Date.parse(turn.startedAt)
  if (!Number.isFinite(start)) return 0
  const end = running || !turn.endedAt ? now : Date.parse(turn.endedAt)
  return Number.isFinite(end) ? Math.max(0, end - start) : 0
}

/** One tool call: title, one-line summary, optional metadata, expandable body. */
function ToolRow({ step, open, running, labels, detail, onToggle, t, subRows }) {
  const Icon = TOOL_ICONS[baseTool(step.tool).toLowerCase()] || IconAgentPresetOutlineRegular
  // DSH's row is "label · summary"; here the label names the kind of work, the
  // wire name says which tool actually ran, and the summary carries the telling
  // argument (path, command) or the model's intent.
  const title = h('span', { className: 'qd-tool-title' },
    h('span', null, t(TOOL_LABELS[categoryOf(step.tool)] || TOOL_LABELS.tools)),
    h('span', { className: 'qd-tool-name' }, String(step.tool || '').trim())
  )
  const intent = String(step.description || '').trim()
  const summary = String(step.command || '').trim() || intent
  const lines = step.lines && step.lines[0] && step.lines[1]
    ? t('display.lines', { from: step.lines[0], to: step.lines[1] })
    : ''
  const added = Number(step.delta && step.delta[0]) || 0
  const removed = Number(step.delta && step.delta[1]) || 0
  const diff = added || removed ? '+' + added + ' −' + removed : ''
  const expandable = String(step.id).indexOf('tool-') === 0

  const collapsed = h(Fragment, null,
    summary ? h('span', { className: rowCss.sep }) : null,
    summary ? h('span', { className: rowCss.summary }, summary) : null,
    lines ? h('span', { className: rowCss.summarySuffix }, lines) : null,
    diff ? h('span', { className: rowCss.diffStat }, diff) : null
  )

  return h('div', { className: 'qd-row', 'data-state': step.status || '' },
    h(DisclosureRow, {
      icon: h(Icon, null),
      title: title,
      open: open && expandable,
      running: running,
      expandable: expandable,
      expandOnRowClick: expandable,
      keepContentWhenOpen: true,
      onToggle: onToggle,
      rowClassName: rowCss.row,
      leadingClassName: rowCss.leading,
      titleClassName: rowCss.title,
      collapsedContent: collapsed
    }, open && expandable ? h(ToolBody, { step: step, detail: detail, labels: labels, t: t }) : null),
    subRows || null
  )
}

/** Expanded body: the card DSH renders for this kind of tool. */
function ToolBody({ step, detail, labels, t }) {
  if (!detail) return h('div', { className: 'qd-status' }, t('display.loading'))
  if (detail.error) return h('div', { className: 'qd-status qd-error' }, detail.error)

  const tool = baseTool(step.tool)
  const args = parseArgs(detail.args)
  const result = String(detail.result || '')
  const path = args && typeof args.file_path === 'string' ? args.file_path : ''

  if (EDIT_TOOLS.test(tool) && args) {
    const oldText = typeof args.old_string === 'string' ? args.old_string : null
    const newText = typeof args.new_string === 'string'
      ? args.new_string
      : typeof args.content === 'string' ? args.content : ''
    if (oldText !== null || newText) {
      return h('div', { className: 'qd-body' },
        h(DiffBlock, {
          diffs: [{ path: path || String(args.path || ''), oldText: oldText, newText: newText }],
          labels: labels.diff
        })
      )
    }
  }

  if (CODE_TOOLS.test(tool)) {
    const code = args && typeof args.code === 'string' ? args.code
      : args && typeof args.program === 'string' ? args.program : ''
    if (code) {
      return h('div', { className: 'qd-body' },
        h(CodeBlock, { code: code, lang: 'javascript' })
      )
    }
  }

  if (TERMINAL_TOOLS.test(tool)) {
    return h('div', { className: 'qd-body' },
      h(TerminalBlock, {
        command: args && typeof args.command === 'string' ? args.command : String(step.command || ''),
        cwd: args && typeof args.cwd === 'string' ? args.cwd : undefined,
        output: result,
        exitCode: step.status === 'fail' ? 1 : step.status === 'done' ? 0 : undefined,
        running: step.status === 'run',
        labels: labels.terminal
      })
    )
  }

  if (READ_TOOLS.test(tool)) {
    const from = step.lines && step.lines[0] ? step.lines[0] : Number(args && args.offset) || 1
    const text = result
      .replace(/\n?\((?:Showing lines|End of file|Output capped)[^\n]*\)\s*$/, '')
      .replace(/\n$/, '')
    const rows = text === '' ? [] : text.split('\n').map((line, index) => ({ number: from + index, text: line }))
    const total = step.lines && step.lines[1] ? step.lines[1] : rows.length
    return h('div', { className: 'qd-body' },
      h(ReadBlock, {
        label: path || String(args && args.path || ''),
        lines: rows,
        totalLines: total,
        lang: languageOf(path),
        labels: labels.read
      })
    )
  }

  return h('div', { className: 'qd-body' },
    h('pre', { className: 'qd-pre' }, result || (detail.args ? detail.args : ''))
  )
}

/** Reasoning row: one 24px line that expands to the full text. */
function ThinkRow({ text, open, streaming, onToggle, t }) {
  const oneLine = String(text || '').replace(/\s+/g, ' ').trim()
  const body = useRef(null)
  // A chain that keeps writing must keep its tail in view; the box is the only
  // place the newest words appear.
  useEffect(() => {
    const node = body.current
    // The body itself is the scroll container (max-height with overflow).
    if (!node || !open) return
    node.scrollTop = node.scrollHeight
  }, [text, open])
  return h('div', { className: 'qd-row' },
    h(DisclosureRow, {
      icon: h(IconThinkOutlineRegular, null),
      title: t('display.thinking'),
      open: open,
      running: streaming,
      expandable: true,
      expandOnRowClick: true,
      onToggle: onToggle,
      collapsedContent: h(Fragment, null,
        h('span', { className: 'qd-dot' }),
        h('span', { className: 'qd-summary' }, oneLine)
      )
    }, open ? h('div', { className: 'qd-think-body', ref: body }, text) : null)
  )
}

/** Assistant prose: DSH's own Markdown renderer, no card. */
function ProseRow({ text, streaming, labels }) {
  return h('div', { className: streaming ? 'qd-prose qd-prose-streaming' : 'qd-prose' },
    h(MarkdownText, { text: text, streaming: streaming, labels: labels })
  )
}

/** The turn control: DSH's process header with a step count and a duration. */
function TurnHeader({ turn, title, open, running, onToggle, t }) {
  const [now, setNow] = useState(() => Date.now())
  const number = turn ? turn.number : null
  useEffect(() => {
    if (!running) return undefined
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [running, number])

  const duration = formatDuration(elapsedOf(turn, running, now))

  return h('button', {
    type: 'button',
    className: 'qd-turn',
    'data-open': open || undefined,
    'aria-expanded': open,
    onClick: onToggle
  },
    h(IconChevronDownOutlineRegular, { className: 'qd-turn-chevron' }),
    h('span', { className: 'qd-turn-label' }, title),
    duration ? h('span', { className: 'qd-turn-meta' }, duration) : null
  )
}

/** Live stream: the assistant's unflushed thinking, tool drafts and prose. */
function LiveRows({ stream, t, labels }) {
  const thinking = stream && stream.thinking ? String(stream.thinking) : ''
  const text = stream && stream.text ? String(stream.text) : ''
  const tools = stream && Array.isArray(stream.tools) ? stream.tools : []
  if (!thinking && !text && !tools.length) return null

  const rows = []
  if (thinking) {
    rows.push(h(ThinkRow, {
      key: 'live-think', text: thinking, open: true, streaming: true,
      onToggle: () => {}, t: t
    }))
  }
  tools.forEach((tool, index) => {
    const name = String((tool && tool.name) || '') || t('display.toolFallback')
    const raw = tool && tool.args ? String(tool.args) : ''
    let summary = ''
    try {
      const parsed = JSON.parse(raw)
      summary = String((parsed && (parsed.command || parsed.file_path || parsed.path || parsed.pattern)) || '')
    } catch (error) {
      summary = raw.slice(0, 80)
    }
    const Icon = TOOL_ICONS[baseTool(name).toLowerCase()] || IconAgentPresetOutlineRegular
    rows.push(h('div', { className: 'qd-row', key: 'live-tool-' + index },
      h(DisclosureRow, {
        icon: h(Icon, null),
        title: name,
        open: false,
        running: true,
        expandable: false,
        onToggle: () => {},
        collapsedContent: summary
          ? h(Fragment, null,
            h('span', { className: rowCss.sep }),
            h('span', { className: rowCss.summary }, summary))
          : null
      })
    ))
  })
  if (text) rows.push(h(ProseRow, { key: 'live-say', text: text, streaming: true, labels: labels }))
  return h('div', { className: 'qd-live' }, rows)
}

function RowList({ steps, stream, turn, running, t, loadDetail, onGrowth, detailMode }) {
  const [openIds, setOpenIds] = useState(() => new Set())
  const [details, setDetails] = useState({})
  const [turnChoice, setTurnChoice] = useState(null)
  const seenTurn = useRef(null)
  const live = runningId(steps)

  if (seenTurn.current !== (turn ? turn.number : null)) {
    seenTurn.current = turn ? turn.number : null
    if (turnChoice !== null) setTurnChoice(null)
  }

  const requested = useRef(new Map())

  /** Load one row's detail once per (row, status): a result only exists after it settles. */
  const request = useCallback((id, status) => {
    const key = id + '@' + (status || '')
    if (requested.current.get(id) === key) return
    requested.current.set(id, key)
    loadDetail(id).then((detail) => {
      setDetails((prev) => ({ ...prev, [id]: detail || {} }))
    }).catch((error) => {
      requested.current.delete(id)
      setDetails((prev) => ({ ...prev, [id]: { error: String((error && error.message) || error) } }))
    })
  }, [loadDetail])

  const toggle = useCallback((id) => {
    setOpenIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    if (onGrowth) onGrowth()
  }, [onGrowth])

  // Every open row (auto-opened running rows included) loads its detail, and a
  // settled row refetches once so its result replaces the running view.
  /**
   * Whether a row is open right now.
   *  auto   - only the running row
   *  open   - every row
   *  closed - none
   * A manual toggle still wins inside auto for the row it touched.
   */
  const rowOpen = useCallback((step) => {
    const id = String(step.id)
    if (detailMode === 'open') return true
    if (detailMode === 'closed') return false
    return openIds.has(id) || step.status === 'run'
  }, [detailMode, openIds])

  const openSignature = useMemo(() => {
    const ids = [...openIds]
    steps.forEach((step) => {
      if (step.status === 'run' || detailMode === 'open') ids.push(String(step.id))
    })
    return ids.sort().join(',') + '|' + detailMode
  }, [openIds, steps, detailMode])

  useEffect(() => {
    const wanted = new Set(openIds)
    steps.forEach((step) => {
      if (step.status === 'run' || detailMode === 'open') wanted.add(String(step.id))
    })
    steps.forEach((step) => {
      const id = String(step.id)
      if (wanted.has(id)) request(id, step.status)
    })
  }, [openSignature, steps, openIds, request, detailMode])

  const labels = useMemo(() => makeLabels(t), [t])
  const markdownLabels = useMemo(() => ({
    code: { copyLabel: t('display.copy'), copiedLabel: t('display.copied') },
    footnotes: t('display.footnotes')
  }), [t])
  // Folded only stops rows from opening by themselves; the group still lists
  // them (opening it would leave an empty box otherwise).
  const turnOpen = detailMode === 'open' ? true
    : turnChoice === null ? Boolean(running) : turnChoice
  const toggleTurn = useCallback(() => {
    setTurnChoice((prev) => !(prev === null ? Boolean(running) : prev))
    if (onGrowth) onGrowth()
  }, [running, onGrowth])

  // Sub-calls name their parent call id; nest them the way the main window's
  // call tree does instead of leaving them as siblings.
  const ids = new Set(steps.map((step) => String(step.id)))
  const childrenOf = new Map()
  steps.forEach((step) => {
    if (!step.parent) return
    const parentId = 'tool-' + step.parent
    if (!ids.has(parentId)) return
    const list = childrenOf.get(parentId)
    if (list) list.push(step)
    else childrenOf.set(parentId, [step])
  })

  const renderRow = (step, depth) => {
    const id = String(step.id)
    const subRows = depth < 4 && childrenOf.has(id)
      ? h('div', { className: 'qd-subcalls' }, childrenOf.get(id).map((child) => renderRow(child, depth + 1)))
      : null
    return h(ToolRow, {
      key: id,
      step: step,
      open: rowOpen(step),
      running: id === live,
      labels: labels,
      detail: details[id],
      onToggle: () => toggle(id),
      t: t,
      subRows: subRows
    })
  }

  const toolRows = []
  const process = []
  const replies = []
  steps.forEach((step) => {
    const id = String(step.id)
    if (step.kind === 'say') {
      replies.push(h(ProseRow, { key: id, text: String(step.text || ''), labels: markdownLabels }))
      return
    }
    if (step.kind === 'think') {
      process.push(h(ThinkRow, {
        key: id, text: step.text, open: openIds.has(id), streaming: id === live,
        onToggle: () => toggle(id), t: t
      }))
      return
    }
    toolRows.push(step)
    if (step.parent && ids.has('tool-' + step.parent)) return
    process.push(renderRow(step, 0))
  })

  const summary = summarize(toolRows, t)

  const hasProcess = process.length > 0
  return h('div', { className: 'qd-flow' },
    hasProcess ? h(TurnHeader, {
      turn: turn, title: summary, open: turnOpen,
      running: Boolean(running), onToggle: toggleTurn, t: t
    }) : null,
    hasProcess && turnOpen ? h('div', { className: 'qd-process' }, process) : null,
    replies,
    h(LiveRows, { stream: stream, t: t, labels: markdownLabels })
  )
}

/** Create one island over a container element. */
function create(options) {
  const root = createRoot(options.root)
  return {
    render(state) {
      root.render(h(RowList, {
        steps: (state && state.steps) || [],
        stream: state && state.stream,
        turn: state && state.turn,
        running: Boolean(state && state.running),
        t: options.t || IDENTITY,
        loadDetail: options.loadDetail,
        onGrowth: options.onGrowth,
        detailMode: (state && state.detail) || 'auto'
      }))
    },
    unmount() {
      root.unmount()
    }
  }
}

window.QD = window.QD || {}
window.QD.render = { create: create }
window.QD.composer = { create: createComposer }
