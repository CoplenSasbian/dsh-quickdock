/* DSH-parity render island.
 *
 * The dock's run window draws its rows with the same components the DSH web UI
 * uses (@deepseek-ai/dsh-client-ui-primitives, MIT), so typography, spacing,
 * dots, chevrons and the expanded cards match the main window instead of being
 * re-implemented here.
 *
 * The island owns rows only: the live stream block, the interaction card and
 * the scroll/follow behaviour stay in display.js.
 */
import {
  createElement as h, Fragment, useCallback, useEffect, useMemo, useRef, useState
} from 'react'
import { createRoot } from 'react-dom/client'
import {
  DisclosureRow, TerminalBlock, DiffBlock,
  IconAgentPresetOutlineRegular, IconBrowseOutlineRegular, IconCodeOutlineRegular,
  IconEditOutlineRegular, IconGlobeOutlineRegular, IconSearchOutlineRegular,
  IconThinkOutlineRegular
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

const TERMINAL_TOOLS = /^(bash|pwsh|shell|terminal|run_code)$/i
const EDIT_TOOLS = /^(edit|edit_file|write|str_replace_editor)$/i

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

/** Labels the DSH primitives need; all of them come from the dock catalogs. */
function makeLabels(t) {
  const terminal = {
    commandLine: (line) => t('display.commandLine', { line: line }),
    signal: (signal) => t('display.signal', { signal: signal }),
    exitCode: (code) => t('display.exitCode', { code: code }),
    noExitCode: t('display.noExitCode'),
    running: t('display.running'),
    failed: t('display.failed'),
    done: t('display.done'),
    copy: t('display.copy'),
    copied: t('display.copied'),
    noOutput: t('display.noOutput'),
    collapseAria: t('display.collapse'),
    collapse: t('display.collapse'),
    expandAria: (hidden) => t('display.expandLines', { count: hidden }),
    expand: (hidden) => t('display.expandLines', { count: hidden })
  }
  const diff = {
    copy: t('display.copy'),
    copied: t('display.copied'),
    collapseAria: t('display.collapse'),
    collapse: t('display.collapse'),
    expandAria: (hidden) => t('display.expandLines', { count: hidden }),
    expand: (hidden) => t('display.expandLines', { count: hidden })
  }
  return { terminal, diff }
}

/** One tool call: title, one-line summary, optional metadata, expandable body. */
function ToolRow({ step, open, running, labels, detail, onToggle, t }) {
  const Icon = TOOL_ICONS[String(step.tool || '').toLowerCase()] || IconAgentPresetOutlineRegular
  const title = String(step.description || '').trim() || String(step.tool || '') || t('display.toolFallback')
  const summary = String(step.command || '').trim()
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
    }, open && expandable ? h(ToolBody, { step: step, detail: detail, labels: labels, t: t }) : null)
  )
}

/** Expanded body: the card DSH renders for this kind of tool. */
function ToolBody({ step, detail, labels, t }) {
  if (!detail) {
    return h('div', { className: 'qd-status' }, t('display.loading'))
  }
  if (detail.error) {
    return h('div', { className: 'qd-status qd-error' }, detail.error)
  }
  const tool = String(step.tool || '')
  const args = parseArgs(detail.args)
  const result = String(detail.result || '')
  const path = args && typeof args.file_path === 'string' ? args.file_path : ''

  if (EDIT_TOOLS.test(tool) && args) {
    const oldText = typeof args.old_string === 'string' ? args.old_string : null
    const newText = typeof args.new_string === 'string' ? args.new_string : typeof args.content === 'string' ? args.content : ''
    if (oldText !== null || newText) {
      return h('div', { className: 'qd-body' },
        h(DiffBlock, {
          diffs: [{ path: path || String(args.path || ''), oldText: oldText, newText: newText }],
          labels: labels.diff
        })
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

  const text = result || (detail.args ? detail.args : '')
  return h('div', { className: 'qd-body' },
    h('pre', { className: 'qd-pre' }, text)
  )
}

/** Reasoning row: one 24px line that expands to the full text. */
function ThinkRow({ step, open, onToggle, t }) {
  const text = String(step.text || '')
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return h('div', { className: 'qd-row' },
    h(DisclosureRow, {
      icon: h(IconThinkOutlineRegular, null),
      title: t('display.thinking'),
      open: open,
      expandable: true,
      expandOnRowClick: true,
      onToggle: onToggle,
      collapsedContent: h(Fragment, null,
        h('span', { className: 'qd-dot' }),
        h('span', { className: 'qd-summary' }, oneLine)
      )
    }, open ? h('div', { className: 'qd-think-body' }, text) : null)
  )
}

/** Assistant prose: rendered Markdown, no card. */
function SayRow({ html }) {
  return h('div', { className: 'qd-prose', dangerouslySetInnerHTML: { __html: html } })
}

function RowList({ steps, t, markdown, loadDetail, onGrowth }) {
  const [openIds, setOpenIds] = useState(() => new Set())
  const [details, setDetails] = useState({})
  const pending = useRef(new Set())
  const live = runningId(steps)

  const request = useCallback((id) => {
    if (pending.current.has(id)) return
    pending.current.add(id)
    loadDetail(id).then((detail) => {
      pending.current.delete(id)
      setDetails((prev) => ({ ...prev, [id]: detail || {} }))
    }).catch((error) => {
      pending.current.delete(id)
      setDetails((prev) => ({ ...prev, [id]: { error: String((error && error.message) || error) } }))
    })
  }, [loadDetail])

  const toggle = useCallback((id) => {
    setOpenIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else {
        next.add(id)
        request(id)
      }
      return next
    })
    if (onGrowth) onGrowth()
  }, [request, onGrowth])

  // A running tool opens itself once its detail is requested, like the old dock.
  useEffect(() => {
    if (!live) return
    request(live)
  }, [live, request])

  const labels = useMemo(() => makeLabels(t), [t])

  return h('div', { className: 'qd-flow' },
    steps.map((step) => {
      const id = String(step.id)
      if (step.kind === 'think') {
        return h(ThinkRow, { key: id, step: step, open: openIds.has(id), onToggle: () => toggle(id), t: t })
      }
      if (step.kind === 'say') {
        return h(SayRow, { key: id, html: markdown(String(step.text || '')) })
      }
      const autoOpen = step.status === 'run'
      const open = openIds.has(id) || autoOpen
      return h(ToolRow, {
        key: id,
        step: step,
        open: open,
        running: id === live,
        labels: labels,
        detail: details[id],
        onToggle: () => toggle(id),
        t: t
      })
    })
  )
}

/** Create one island over a container element. */
function create(options) {
  const root = createRoot(options.root)
  return {
    render(steps, context) {
      root.render(h(RowList, {
        steps: steps || [],
        t: options.t || IDENTITY,
        markdown: options.markdown || IDENTITY,
        loadDetail: options.loadDetail,
        onGrowth: options.onGrowth
      }))
    },
    unmount() {
      root.unmount()
    }
  }
}

window.QD = window.QD || {}
window.QD.render = { create: create }
