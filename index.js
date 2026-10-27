/**
 * dsh-quickdock — Host 半
 *
 * 职责（DESIGN.md 第 3/4/9 节）：
 * - /quickdock 页面托管（webServer prefix 路由，内联 CSS/JS + 主题变量）
 * - /quickdock/api/*：state/task/select/settings/stop/answer/open-session/window
 * - 订阅 session/event 折成步骤流（只读，绝不写新事件类型）
 * - approval/request / user-questions/request waterfall 拦截（仅限 dock 绑定会话）
 * - Electron 三级回退解析 + spawn dock 进程（删除 ELECTRON_RUN_AS_NODE）
 * - 守护：1s/2s/4s 退避重拉，最多 5 次；dispose 终止
 *
 * 硬约束：
 * - 不 import 任何 @deepseek-ai/dsh-client-* 运行期包
 * - 只读 session/event；未知事件类型原样透传给页面折叠，不落库
 */
import { createRequire } from 'node:module'
import { randomBytes, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'
import Schema from '@deepseek-ai/schemastery'

const require = createRequire(import.meta.url)
const { StepFolder } = require('./runtime/step-folder.js')
const __dirname = dirname(fileURLToPath(import.meta.url))

export const name = 'dsh-quickdock'

/** 需要的 Host 服务：会话编排、审批、工作区、主题载体、Web 载体。 */
export const inject = ['webServer', 'connection']

export const Config = Schema.object({
  enabled: Schema.boolean().default(true),
  /**
   * 是否在插件激活时预启动 dock 进程。
   *
   * 默认 false = 按需创建：点「Dock」按钮时才拉起 Electron，窗口关闭后进程退出。
   * 设为 true 则保持常驻（窗口关闭仅隐藏，唤出无延迟）。
   *
   * 注意：此字段此前在代码里被读取却从未在 schema 中定义，导致 `config.autoLaunch`
   * 恒为 undefined、`!== false` 恒成立 —— 预启动实际上无法关闭。
   */
  autoLaunch: Schema.boolean().default(false),
  width: Schema.number().default(600),
  /** 输入窗口的固定高度（只有输入相关的 UI）。 */
  inputHeight: Schema.number().default(170),
  /** 展示窗口的固定高度（执行过程；内容超出在窗口内滚动，其余透明）。 */
  displayHeight: Schema.number().default(520),
  margin: Schema.number().default(16),
  rememberGeometry: Schema.boolean().default(true),
  alwaysOnTop: Schema.boolean().default(false),
  focusOnSummon: Schema.boolean().default(false),
  hideOnEscape: Schema.boolean().default(true),
  followBoundOnly: Schema.boolean().default(true),
  defaultWorkspaceId: Schema.string().default(''),
  agentPreset: Schema.string().default(''),
  submitMode: Schema.string().default('queue'),
  thinkMode: Schema.string().default('fold'),
  showTiming: Schema.boolean().default(true),
  maxSteps: Schema.number().default(200),
  theme: Schema.string().default('auto'),
  headerButton: Schema.boolean().default(true),
  headerButtonOrder: Schema.number().default(1010),
  approvalTimeoutMs: Schema.number().default(300000)
})

/* ============================== Electron 解析 ============================== */

let electronDownloadPromise = null

/**
 * 临时调试日志：把宿主侧的关键事件落到 %LOCALAPPDATA%\dsh-quickdock\host.log。
 * ctx.logger 的输出在 DSH 里不便实时查看，排查运行时问题时用它抓现场。
 */
/** 同一行被重复折进来时记一笔，便于确认是重复投放还是真的两条。 */
function onFoldMerge(id) {
  traceLog('fold: merged duplicate row ' + id)
}

function traceLog(msg) {
  try {
    const fs = require('node:fs')
    const dir = join(process.env.LOCALAPPDATA || process.env.TEMP || '.', 'dsh-quickdock')
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(join(dir, 'host.log'),
      '[' + new Date().toISOString() + '] ' + String(msg) + '\n')
  } catch {}
}

/**
 * Electron 目标版本。与 DSH 宿主内置版本保持一致（默认 44.7.0）。
 *
 * 历史教训：30.5.1 在部分 Windows 机器上以 STATUS_BREAKPOINT (0x80000003) 崩在
 * JS 执行之前（连空脚本都崩），且与是否 disableHardwareAcceleration 无关。
 * 44.7.0 经实测可正常创建 transparent 窗口。故默认对齐宿主版本。
 */
const ELECTRON_VERSION = process.env.DSH_QUICKDOCK_ELECTRON_VERSION ?? '44.7.0'

/**
 * Electron 二进制的根目录（本插件自管下载的落盘位置）。
 *
 * **为什么不放在 ~/.dsh/electron 或 node_modules 下：**
 * 实测同一份 Electron 44.7.0（SHA256 完全一致）在不同路径下表现不同：
 *
 *   %LOCALAPPDATA%\...                          → exit 0，窗口正常
 *   C:\qdroot / Documents\...                   → exit 0
 *   ~/.dsh/electron                             → STATUS_BREAKPOINT (0x80000003)
 *   Desktop\...                                 → STATUS_BREAKPOINT (0x80000003)
 *   node_modules\electron\dist（Desktop 下）     → STATUS_BREAKPOINT (0x80000003)
 *
 * 根因是第三方安全软件（本机为「联想版火绒安全」）对用户配置目录/桌面的注入防护：
 * Chromium 自检到代码段被篡改后主动 int 3 自杀。这不是文件损坏（哈希一致），
 * 也不是 Windows Defender 受控文件夹（已确认为关闭）。
 *
 * 因此在安全软件未知的任意机器上，**不能**靠路径猜，只能实测（见 canRunElectron）。
 * 这里只作为「自己下载时的首选落盘位置」。
 */
function electronRoot(ctx) {
  const localAppData = process.env.LOCALAPPDATA
    || (process.platform === 'win32' ? join(process.env.USERPROFILE ?? '', 'AppData', 'Local') : '')
  return join(String(localAppData), 'dsh-quickdock', 'electron')
}

/**
 * 当前平台下 Electron 可执行文件的文件名。
 *
 * ⚠️ 这里曾有个隐蔽的 bug：原实现写成
 *   if (process.platform !== 'win32' && !platform) platform = process.platform
 * 在 Windows 上 process.platform === 'win32'，条件不成立 → platform 保持 undefined
 * → 后面全部不匹配 → 在 Windows 上返回 'electron'（少了 .exe）
 * → 候选路径探测全部落空（candidates: (none)）。
 *
 * 现在直接用当前平台推导，需要指定平台时由参数覆盖。
 */
function exeNameFor(platform) {
  const target = platform || process.platform
  if (target === 'darwin') return 'Electron.app/Contents/MacOS/Electron'
  if (target === 'win32') return 'electron.exe'
  return 'electron'
}

/**
 * 候选路径（按优先级）。全部会被 canRunElectron 实测，不可用则跳过。
 *
 * ① DSH_QUICKDOCK_ELECTRON_PATH 显式指定（用户兜底开关，最高优先级）
 * ② npm 官方 electron 包的 dist —— 别人 `npm install` 本插件时自动获得的那份。
 *    注意 require('electron') 返回的是【字符串路径】而非 API（官方 index.js 行为），
 *    对 spawn 独立进程的用法刚好合适。
 * ③ 本插件自管下载的 %LOCALAPPDATA%\dsh-quickdock\electron\<version>
 * ④ 旧布局 ~/.dsh/electron
 */
function electronCandidatePaths(ctx) {
  const paths = []
  if (process.env.DSH_QUICKDOCK_ELECTRON_PATH) paths.push(process.env.DSH_QUICKDOCK_ELECTRON_PATH)
  try {
    const pkgDir = dirname(require.resolve('electron/package.json'))
    paths.push(join(pkgDir, 'dist', exeNameFor('win32')))
  } catch {}
  try {
    paths.push(join(electronRoot(ctx), ELECTRON_VERSION))
  } catch {}
  try {
    const home = ctx.root?.baseDir ?? process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')
    paths.push(join(String(home), 'electron'))
  } catch {}
  return paths.filter(Boolean)
}

function resolveToExe(p) {
  try {
    if (!p) return null
    if (existsSync(p) && require('node:fs').statSync(p).isFile()) return p
    if (existsSync(p) && require('node:fs').statSync(p).isDirectory()) {
      const exe = join(p, exeNameFor())
      if (existsSync(exe)) return exe
    }
    // 目录 + 平台子目录形态（如 ~/.dsh/electron/win32）
    const nested = join(p, exeNameFor())
    if (existsSync(nested)) return nested
  } catch {}
  return null
}

/** 把候选列表全部解析成具体的 exe 路径（去重，保持优先级）。 */
function electronCandidates(ctx) {
  const out = []
  for (const p of electronCandidatePaths(ctx)) {
    const exe = resolveToExe(p)
    if (exe && !out.includes(exe)) out.push(exe)
  }
  return out
}

/**
 * 健康探测：这个 exe 在当前环境里真的能起 Electron 吗？
 *
 * 三重校验，缺一不可：
 *  1. `electron --version` 必须返回 0 —— 否则是被安全软件拦崩了（含 0x80000003）
 *  2. 输出必须是 vN.N.N 形态 —— 纯 Node 也会输出版本号，单看退出码分不出来
 *  3. ELECTRON_RUN_AS_NODE 必须先删掉 —— 不删会退化成 Node 模式，探测失真
 *     （`node.exe`冒充也能打印 v22.x，所以还要配合 process.versions 特征不可行时，
 *       至少保证我们探测的是 Electron 自己的产物）
 */
function canRunElectron(exe) {
  try {
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.ELECTRON_NO_ATTACH_CONSOLE
    const result = spawnSync(exe, ['--version'], {
      env, windowsHide: true, timeout: 15000, encoding: 'utf8'
    })
    if (result.error) return false
    if (result.status !== 0) return false
    const out = String(result.stdout || '').trim()
    if (!/^v?\d+\.\d+\.\d+/.test(out)) return false
    // node.exe 冒充：版本号虽匹配，但它不是 Electron。
    // 用 Electron 专有开关区分区：--version 之外再问一次 Electron 特有的 ABI 信息。
    const probe = spawnSync(exe, ['--no-sandbox', '--version'], {
      env, windowsHide: true, timeout: 15000, encoding: 'utf8'
    })
    return !probe.error && probe.status === 0
  } catch {
    return false
  }
}

async function downloadElectron(ctx) {
  if (!electronDownloadPromise) {
    electronDownloadPromise = (async () => {
      const { download } = await import('@electron/get')
      // 注意：@electron-internal/extract-zip 只导出 extract（另有 default），没有 extractZip
      const mod = await import('@electron-internal/extract-zip')
      const extract = mod.extract ?? mod.default
      if (typeof extract !== 'function') throw new Error('extract-zip: no extract() export available')
      // 按版本落盘到 %LOCALAPPDATA%（见 electronRoot 注释：避开受保护路径）
      const target = join(electronRoot(ctx), ELECTRON_VERSION)
      const mirror = process.env.ELECTRON_MIRROR ?? 'https://npmmirror.com/mirrors/electron/'
      const zip = await download(ELECTRON_VERSION, { mirrorOptions: { mirror } })
      await extract(zip, { dir: target })
      electronDownloadPromise = null
      ctx.logger?.info('quickdock: Electron %s downloaded to %s', ELECTRON_VERSION, target)
      return join(target, 'electron.exe')
    })().catch((error) => {
      electronDownloadPromise = null
      throw error
    })
  }
  return electronDownloadPromise
}

/**
 * 选出真正能用的 Electron：逐个候选做健康探测，返回第一个能跑起来的。
 *
 * 为什么不直接取第一个存在的文件：安全软件拦截是**按路径**生效的，
 * 文件存在 ≠ 能启动。只有实测过才算数。
 */
/**
 * 通过 dock 的回环 HTTP 控制通道下发命令。
 *
 * 为什么不用 stdin 协议：Windows 上 Electron 主进程收不到 piped stdin
 * （DESIGN §3.3 记录过，实测 quit 命令根本收不到），所以 show/quit/attach 全部失效。
 * 改为 dock 监听 127.0.0.1 随机端口，宿主用 HTTP 调用。
 */
function controlRequest(port, token, message, timeoutMs = 3000) {
  return new Promise((resolve) => {
    if (!port) { resolve(false); return }
    const payload = Buffer.from(JSON.stringify(message))
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/control?t=' + encodeURIComponent(token),
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length }
    }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode === 200))
    })
    req.on('error', () => resolve(false))
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(false) })
    req.end(payload)
  })
}

function existingElectron(ctx) {
  const candidates = electronCandidates(ctx)
  traceLog('candidates: ' + (candidates.length ? candidates.join(' | ') : '(none)'))
  const rejected = []
  for (const exe of candidates) {
    const ok = canRunElectron(exe)
    traceLog('  probe ' + (ok ? 'OK  ' : 'FAIL') + ' ' + exe)
    if (ok) {
      if (rejected.length) ctx.logger?.info('quickdock: skipped unusable Electron at %s', rejected.join(', '))
      return exe
    }
    rejected.push(exe)
  }
  if (rejected.length) {
    ctx.logger?.warn(
      'quickdock: no usable Electron among %d candidate(s) (%s); they may be blocked by security software',
      rejected.length, rejected.join(', ')
    )
  }
  return null
}

async function resolveElectronPath(ctx) {
  const found = existingElectron(ctx)
  if (found) return found
  try {
    const downloaded = await downloadElectron(ctx)
    if (downloaded) {
      // 下载完必须再实测一次：下载成功不代表这份二进制在本机能启动
      // （实测有机器上 Electron 会以 STATUS_BREAKPOINT 崩在 JS 执行之前）。
      if (canRunElectron(downloaded)) return downloaded
      throw new Error('下载完成但仍无法启动（进程在 JS 执行前崩溃，通常是安全软件拦截）：' + downloaded)
    }
    return null
  } catch (error) {
    ctx.logger?.error('quickdock: Electron 不可用: ' + String(error && error.message || error))
    traceLog('electron unavailable: ' + String(error && error.message || error))
    // 把原因带出去，让上层能明确告知用户
    const err = new Error(String(error && error.message || error))
    err.electronUnavailable = true
    throw err
  }
}

/* ============================== 宿主服务 ============================== */

export function apply(ctx, config) {
  if (!config.enabled) return

  const token = randomBytes(32).toString('base64url')
  // HTTP 控制通道的独立 token：dock 侧用它鉴权回环请求，与页面 token 分开
  const controlToken = randomBytes(32).toString('base64url')
  const state = {
    workspaceId: config.defaultWorkspaceId || null,
    sessionId: null,
    newSession: true,
    fork: false,
    steps: new Map(),
    folders: new Map(),
    interaction: null,
    interactionQueue: [],
    theme: null,
    settings: {
      permission: 'workspace-write',
      model: '',
      reasoning: '',
      agentPreset: config.agentPreset || ''
    },
    catalogs: { permissions: [], models: [], reasoning: [], agents: [] },
    // error: 最近一次 dock 启动失败的原因（空字符串=无错误）。客户端据此显示提示。
    dock: { running: false, alwaysOnTop: config.alwaysOnTop, error: '' }
  }

  const sseClients = new Set()
  const broadcast = (event, data) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const res of sseClients) {
      try { res.write(payload) } catch {}
    }
  }

  const publish = () => broadcast('state', snapshot())

  /**
   * 上报 dock 启动失败：写入 state（客户端据此显示 toast）+ 记 error 级日志。
   *
   * 设计原则：**不做静默降级**。Electron 起不来就是错误，必须让用户看见，
   * 否则会退化成"点了没反应"这种最难排查的现象。
   */
  function reportDockError(message) {
    const text = String(message || '未知错误')
    state.dock.error = text
    state.dock.running = false
    // 用模板字符串而非 printf 占位符：错误信息必须原样可读，
    // 不能依赖 logger 是否支持 %s 格式化。
    ctx.logger?.error('quickdock: ' + text)
    traceLog('ERROR: ' + text)
    publish()
  }

  function clearDockError() {
    if (!state.dock.error) return
    state.dock.error = ''
    publish()
  }

  /* ---------- 会话归属 ---------- */

  function findWorkspaceIdForSession(sessionId) {
    try {
      const registry = ctx.get('workspaceRegistry')
      if (!registry) return null
      for (const w of registry.list()) {
        if (w.sessionIds.includes(sessionId)) return w.id
      }
    } catch {}
    return null
  }

  function sessionTitleOf(session) {
    try {
      const snap = ctx.get('sessionProjections')?.snapshot(session, ['title', 'sessionListMetadata'])
      const title = snap?.values?.title
      if (typeof title === 'string' && title.trim()) return title.trim()
      return session.header?.cwd ? (session.header.cwd.split(/[\\/]/).pop() || session.id) : session.id
    } catch {
      return session.id
    }
  }

  function sessionRunning(sessionId) {
    try { return ctx.get('agents')?.get(sessionId)?.status === 'running' } catch { return false }
  }

  /* ---------- state 快照 ---------- */

  function snapshot() {
    const workspaces = []
    try {
      const registry = ctx.get('workspaceRegistry')
      if (registry) {
        for (const w of registry.list()) {
          const sessions = w.sessionIds
            .map((id) => {
              const live = ctx.get('sessions').get(id)
              return {
                id,
                title: live ? sessionTitleOf(live) : id,
                cwd: live?.header?.cwd ?? '',
                running: sessionRunning(id),
                updatedAt: live ? Math.max(live.header?.createdAt ?? 0, 0) : 0
              }
            })
            .filter(Boolean)
          sessions.sort((a, b) => b.updatedAt - a.updatedAt)
          workspaces.push({ id: w.id, name: w.title, path: w.path, sessions })
        }
      }
    } catch (error) {
      ctx.logger?.warn('quickdock: workspace listing failed: %s', String(error))
    }

    const liveSession = state.sessionId ? ctx.get('sessions').get(state.sessionId) : undefined
    const folder = state.sessionId ? state.folders.get(state.sessionId) : null
    const steps = folder ? folder.rows() : []

    let backgroundRunning = 0
    try { backgroundRunning = (ctx.get('agents')?.list?.() ?? []).filter((a) => a.status === 'running' && a.id !== state.sessionId).length } catch {}

    return {
      workspaceId: state.workspaceId,
      sessionId: state.sessionId,
      newSession: state.newSession,
      workspaces,
      session: liveSession
        ? { id: liveSession.id, title: sessionTitleOf(liveSession), cwd: liveSession.header?.cwd ?? '' }
        : null,
      status: liveSession ? (sessionRunning(liveSession.id) ? 'running' : 'idle') : 'idle',
      steps,
      interaction: state.interaction,
      settings: { ...state.settings },
      catalogs: { ...state.catalogs },
      config: {
        width: config.width,
        margin: config.margin,
        hideOnEscape: config.hideOnEscape,
        followBoundOnly: config.followBoundOnly,
        thinkMode: config.thinkMode,
        showTiming: config.showTiming,
        submitMode: config.submitMode
      },
      runtime: { ...state.dock, sse: sseClients.size },
      backgroundRunning
    }
  }

  /* ---------- 主题同步（21 token，第 7 节） ---------- */

  const THEME_TOKENS = [
    '--dsw-alias-bg-base', '--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-2', '--dsw-alias-bg-overlay',
    '--dsw-alias-border-l1', '--dsw-alias-border-l2',
    '--dsw-alias-label-primary', '--dsw-alias-label-secondary', '--dsw-alias-label-tertiary',
    '--dsw-alias-brand-primary',
    '--dsw-alias-state-success-primary', '--dsw-alias-state-error-primary', '--dsw-alias-state-warn-primary', '--dsw-alias-state-idle-primary',
    '--dsw-alias-interactive-bg-hover', '--dsw-alias-interactive-bg-active',
    '--dsw-alias-scrollbar-bg-l1', '--dsw-alias-scrollbar-hover-l1',
    '--dsw-alias-separator-primary', '--dsw-alias-tooltip-bg', '--dsw-alias-tooltip-key-bg'
  ]

  function themePayload() {
  // 1) 有 theme 服务（未来宿主侧挂载）就直接用
  const themeSvc = ctx.get('theme')
  if (themeSvc?.getTheme) {
    try {
      const snap = themeSvc.getTheme()
      const tokens = {}
      for (const name of THEME_TOKENS) {
        const v = snap.active?.tokens?.[name]
        if (typeof v === 'string') tokens[name] = v
      }
      if (Object.keys(tokens).length >= 10) {
        return {
          colorScheme: snap.active?.colorScheme ?? 'dark',
          tokens,
          fonts: {
            text: snap.fontFamilies?.text ?? '',
            code: snap.fontFamilies?.code ?? '',
            sizeText: snap.fontSizes?.text ?? 12,
            sizeCode: snap.fontSizes?.code ?? 11
          }
        }
      }
    } catch {}
  }
  return null
}

function themeCss() {
    const payload = themePayload()
    if (!payload) return ''
    const rows = Object.entries(payload.tokens).map(([k, v]) => `  ${k}: ${v};`).join('\n')
    return `:root{\n${rows}\n  --qd-font-text: ${payload.fonts.text};\n  --qd-font-code: ${payload.fonts.code};\n  --qd-font-size-text: ${payload.fonts.sizeText}px;\n  --qd-font-size-code: ${payload.fonts.sizeCode}px;\n}\n`
  }

  ctx.on('theme/change', (snap) => {
    if (!sseClients.size) return
    const payload = {
      colorScheme: snap.active?.colorScheme ?? 'dark',
      tokens: Object.fromEntries(THEME_TOKENS.map((n) => [n, snap.active?.tokens?.[n]]).filter(([, v]) => typeof v === 'string')),
      fonts: {
        text: snap.fontFamilies?.text ?? '',
        code: snap.fontFamilies?.code ?? '',
        sizeText: snap.fontSizes?.text ?? 12,
        sizeCode: snap.fontSizes?.code ?? 11
      }
    }
    broadcast('theme', payload)
  })

  /* ---------- session/event 订阅（只读折叠） ---------- */

  const onSessionEvent = (session, event) => {
    if (!state.sessionId || session.id !== state.sessionId) return
    let folder = state.folders.get(session.id)
    if (!folder) {
      folder = new StepFolder(config.maxSteps, onFoldMerge)
      state.folders.set(session.id, folder)
    }
    folder.apply(event)
    publish()
  }
  ctx.on('session/event', onSessionEvent)

  const onAgentStatus = ({ agent }) => {
    if (!state.sessionId || agent.id !== state.sessionId) return
    publish()
  }
  ctx.on('agent/status', onAgentStatus)

  /* ---------- 审批与提问（waterfall 拦截） ---------- */

  function wantsInteraction(sessionId) {
    if (state.followBoundOnly !== false && state.sessionId && sessionId !== state.sessionId) return false
    return sessionId === state.sessionId || state.sessionId === null
  }

  ctx.on('approval/request', async function (req, next) {
    const sessionId = req.agent?.id
    if (!sessionId || !state.sessionId || sessionId !== state.sessionId) return next()
    const decision = await askDock({
      kind: 'approval',
      toolName: req.toolName,
      reason: req.reason ?? '',
      callId: req.callId ?? ''
    }, req.signal)
    if (decision === null) return 'cancelled'
    return decision ? 'allowed-once' : 'rejected'
  })

  ctx.on('user-questions/request', async function (request, next) {
    const sessionId = request.agent?.id
    if (!sessionId || !state.sessionId || sessionId !== state.sessionId) return next()
    const answer = await askDock({
      kind: 'question',
      questions: request.questions ?? []
    }, request.signal)
    if (answer === null) return { pending: true }
    return answer
  })

  function askDock(payload, signal) {
    return new Promise((resolve) => {
      const id = 'q-' + randomUUID()
      const timeout = setTimeout(() => finish(null), config.approvalTimeoutMs)
      const onAbort = () => finish(null)
      const interaction = { ...payload, id, status: 'open' }
      state.interaction = interaction
      publish()

      function finish(result) {
        clearTimeout(timeout)
        signal?.removeEventListener?.('abort', onAbort)
        if (state.interaction?.id === id) state.interaction = null
        publish()
        resolve(result)
      }
      signal?.addEventListener?.('abort', onAbort, { once: true })

      state.pendingAnswer = (result) => finish(result)
    })
  }

  function answerInteraction(body) {
    const pending = state.pendingAnswer
    if (!pending || !state.interaction || state.interaction.id !== body.id) return false
    if (state.interaction.kind === 'approval') {
      pending(body.outcome === 'allow')
    } else {
      pending({ answers: body.answers ?? [] })
    }
    return true
  }

  /* ---------- catalog 同步 ---------- */

  function refreshCatalogs() {
    try {
      const presets = ctx.get('permissionPresets')
      if (presets) state.catalogs.permissions = presets.catalog().options
    } catch {}
    try {
      state.catalogs.models = ctx.remote
        ? []
        : []
    } catch {}
    publish()
  }

  // model catalog 走 sessionController.modelCatalog()，异步刷新
  async function refreshModels() {
    try {
      const controller = ctx.get('sessionController')
      if (!controller?.modelCatalog) return
      const catalog = await controller.modelCatalog()
      const models = []
      for (const group of catalog.groups ?? []) {
        for (const model of group.models ?? []) {
          models.push({
            id: group.id + '/' + model.id,
            name: model.label ?? model.id,
            context: model.contextWindow ?? null,
            reasoning: model.reasoning?.efforts ?? []
          })
        }
      }
      state.catalogs.models = models
      publish()
    } catch (error) {
      ctx.logger?.warn('quickdock: model catalog failed: %s', String(error))
    }
  }

  /* ---------- 页面服务 ---------- */

  /**
   * 渲染 dock 页面。
   * view='display' → 展示窗口页面（执行过程的块，块间透明）
   * 其它 → 输入窗口页面
   */
  function htmlPage(view) {
    const file = view === 'display' ? 'display.html' : 'index.html'
    const indexHtml = readFileSync(join(__dirname, 'web', file), 'utf8')
    const css = readFileSync(join(__dirname, 'web', 'styles.css'), 'utf8')
    let js = ''
    try { js = readFileSync(join(__dirname, 'web', 'app.js'), 'utf8') } catch {}
    return indexHtml
      .replace('<!--QD_THEME-->', '<style>' + themeCss() + '</style>')
      .replace('<!--QD_STYLES-->', '<style>' + css + '</style>')
      .replace('<!--QD_SCRIPT-->', '<script>' + js + '</script>')
  }

  function json(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(body))
  }

  async function readBody(req) {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    if (!chunks.length) return {}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }

  function authed(req) {
    return req.headers.authorization === 'Bearer ' + token
  }

  function sse(res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive'
    })
    res.write(': connected\n\n')
    sseClients.add(res)
    res.on('close', () => sseClients.delete(res))
  }

  async function handleApi(req, res, url) {
    if (!authed(req)) return json(res, 401, { error: 'unauthorized' })
    const path = url.pathname
    const body = req.method === 'POST' ? await readBody(req).catch(() => ({})) : null

    if (req.method === 'GET' && path === '/quickdock/api/state') {
      return json(res, 200, snapshot())
    }
    if (req.method === 'GET' && path === '/quickdock/api/stream') {
      sse(res)
      res.write(`event: state\ndata: ${JSON.stringify(snapshot())}\n\n`)
      res.write(`event: theme\ndata: ${JSON.stringify(themePayload() ?? {})}\n\n`)
      return
    }
    if (req.method === 'POST' && path === '/quickdock/api/task') return json(res, 200, await postTask(body))
    if (req.method === 'POST' && path === '/quickdock/api/select') return json(res, 200, postSelect(body))
    if (req.method === 'POST' && path === '/quickdock/api/settings') return json(res, 200, postSettings(body))
    if (req.method === 'POST' && path === '/quickdock/api/stop') return json(res, 200, await postStop())
    if (req.method === 'POST' && path === '/quickdock/api/answer') return json(res, 200, { ok: answerInteraction(body) })
    if (req.method === 'POST' && path === '/quickdock/api/bind') return json(res, 200, postBind(body))
    if (req.method === 'POST' && path === '/quickdock/api/window') return json(res, 200, postWindow(body))
    if (req.method === 'POST' && path === '/quickdock/api/open-session') return json(res, 200, postOpenSession(body))
    if (req.method === 'GET' && path === '/quickdock/api/catalogs') {
      await refreshModels()
      return json(res, 200, state.catalogs)
    }
    return json(res, 404, { error: 'not found' })
  }

  async function postTask(body) {
    const text = String(body?.text ?? '').trim()
    if (!text) throw new Error('text required')
    const workspaceId = body.workspaceId || state.workspaceId
    const fork = body.fork === true
    let sessionId = body.sessionId || (state.newSession ? null : state.sessionId)

    if (fork && state.sessionId) {
      const forked = await ctx.get('sessionController').fork({ sessionId: state.sessionId })
      sessionId = forked.sessionId
      state.sessionId = sessionId
      state.newSession = false
    } else if (!sessionId) {
      const created = await ctx.get('sessionController').create({
        ...(workspaceId ? { workspaceId } : {}),
        ...(state.settings.agentPreset ? { agentPreset: state.settings.agentPreset } : {})
      })
      sessionId = created.sessionId
      state.sessionId = sessionId
      state.newSession = false
      if (!state.workspaceId) state.workspaceId = findWorkspaceIdForSession(sessionId) ?? workspaceId ?? null
    }

    // 模型/推理选择：会话存在时先 selectModel
    if (state.settings.model) {
      const [provider, model] = state.settings.model.split('/')
      if (provider && model) {
        try {
          await ctx.get('sessionController').selectModel({
            sessionId,
            provider,
            model,
            ...(state.settings.reasoning ? { reasoningEffort: state.settings.reasoning } : {})
          })
        } catch (error) {
          ctx.logger?.warn('quickdock: selectModel failed: %s', String(error))
        }
      }
    }

    if (!state.folders.has(sessionId)) state.folders.set(sessionId, new StepFolder(config.maxSteps, onFoldMerge))
    else state.folders.get(sessionId).reset()

    await ctx.get('sessionController').prompt({
      sessionId,
      content: [{ type: 'text', text }],
      requestId: 'qd-' + randomUUID(),
      mode: config.submitMode === 'steer' ? 'steer' : 'queue',
      clientTimeZone: 'Etc/GMT-8'
    }, { kind: 'user-rpc', surface: 'quickdock', client: 'quickdock' })

    publish()
    return { sessionId }
  }

  function postSelect(body) {
    if (body.workspaceId !== undefined) state.workspaceId = body.workspaceId || null
    if (body.sessionId !== undefined) {
      state.sessionId = body.sessionId || null
      state.newSession = body.newSession === true || !body.sessionId
      if (!state.workspaceId && state.sessionId) state.workspaceId = findWorkspaceIdForSession(state.sessionId)
    }
    if (body.newSession === true) {
      state.sessionId = null
      state.newSession = true
    }
    publish()
    return { ok: true }
  }

  function postSettings(body) {
    if (body.permission) state.settings.permission = String(body.permission)
    if (body.model !== undefined) state.settings.model = String(body.model)
    if (body.reasoning !== undefined) state.settings.reasoning = String(body.reasoning)
    if (body.agentPreset !== undefined) state.settings.agentPreset = String(body.agentPreset)
    publish()
    return { ok: true }
  }

  async function postStop() {
    if (!state.sessionId) return { ok: false }
    try {
      await ctx.get('sessionController').cancel({ sessionId: state.sessionId })
    } catch (error) {
      ctx.logger?.warn('quickdock: cancel failed: %s', String(error))
      return { ok: false, error: String(error) }
    }
    publish()
    return { ok: true }
  }

  function postBind(body) {
    const sessionId = String(body?.sessionId ?? '')
    if (!sessionId) return { ok: false }
    state.sessionId = sessionId
    state.newSession = false
    state.workspaceId = findWorkspaceIdForSession(sessionId) ?? state.workspaceId
    if (!state.folders.has(sessionId)) state.folders.set(sessionId, new StepFolder(config.maxSteps, onFoldMerge))
    publish()
    // 「推到 Dock」= 用户明确想要桌面 dock。
    // 按需模式下 dock 此刻可能尚未启动（这正是预期状态），所以这里主动创建。
    // **不做任何降级**：失败时 dock.summon() 会写 state.dock.error，客户端据此提示。
    dock.summon()
    // dock 创建是异步的：notifyAttach 会在 dock 未 ready 时暂存，ready 后自动补发
    dock.notifyAttach(sessionId)
    const dockUp = Boolean(dock.child)
    return { ok: true, dockRunning: dockUp, error: state.dock.error || undefined }
  }

  function postWindow(body) {
    if (body.alwaysOnTop !== undefined) state.dock.alwaysOnTop = Boolean(body.alwaysOnTop)
    dock.applyWindow({ alwaysOnTop: state.dock.alwaysOnTop })
    return { ok: true, ...state.dock }
  }

  function postOpenSession(body) {
    const sessionId = String(body?.sessionId ?? '')
    if (!sessionId) return { ok: false }
    // dsh:// 只支持 open，不支持定位 session；Host 写"待打开"标记，主窗口读一次。
    // v1 简化：把会话切到 dock 绑定，用户可在主窗口手动选择。
    state.sessionId = sessionId
    publish()
    return { ok: true }
  }

  /* ---------- dock 进程管理 ---------- */

  const dock = {
    child: null,
    // dock 的 HTTP 控制通道端口（dock ready 时上报）
    controlPort: 0,
    // 唤出请求早于 dock ready 到达时暂存，ready 后补发
    pendingShow: false,
    // 需要送达 dock 的会话 id（dock 尚未 ready 时暂存）
    pendingAttach: '',
    // 启动流程进行中（防并发重复 spawn）
    spawning: false,
    hostPid: process.pid,
    restarts: 0,
    backoff: [1000, 2000, 4000, 8000, 16000],
    timer: null,

    env() {
      const origin = ctx.webServer.getOrigin()
      const url = origin + '/quickdock?t=' + token
      return {
        ...process.env,
        DSH_QUICKDOCK_URL: url,
        DSH_QUICKDOCK_HOST_PID: String(process.pid),
        // HTTP 控制通道的一次性 token（dock 侧据此鉴权，只接受回环请求）
        DSH_QUICKDOCK_CONTROL_TOKEN: controlToken,
        DSH_QUICKDOCK_CONFIG: JSON.stringify({
          width: config.width,
          // 输入窗口 / 展示窗口各自的固定高度（两个独立窗口）
          inputHeight: config.inputHeight,
          displayHeight: config.displayHeight,
          margin: config.margin,
          alwaysOnTop: state.dock.alwaysOnTop,
          rememberGeometry: config.rememberGeometry,
          // 按需模式（autoLaunch=false）：窗口关闭 → dock 进程退出 → 下次点击重建
          exitOnClose: !config.autoLaunch
        })
      }
    },


      }

  ctx.effect(() => () => dock.stop(), 'quickdock: dock lifecycle')

  /**
   * 启动策略：
   * - autoLaunch=false（默认）：按需创建。点「Dock」按钮才拉起 Electron；
   *   窗口关闭后 dock 进程退出，下次点击重建。没有任何常驻定时器。
   * - autoLaunch=true：保持旧行为，激活即预热，窗口关闭仅隐藏。
   *
   * 旧实现里有个 30s 的 setInterval 重试定时器，会在 dock 没起来时反复拉起
   * （配合「启动即预启动」等于无条件常驻占资源）。按需模式下已完全移除。
   */
  if (config.autoLaunch) {
    const launchTimer = setTimeout(() => dock.spawnDock(), 500)
    ctx.effect(() => () => clearTimeout(launchTimer), 'quickdock: launch timer')
    // 仅常驻模式下需要守护重拉：dock 意外退出后补回来
    const retryTimer = setInterval(() => { if (!dock.child && !dock.stopping) dock.spawnDock() }, 30000)
    ctx.effect(() => () => clearInterval(retryTimer), 'quickdock: dock retry timer')
  }

  /* ---------- Remote 服务（供主窗口客户端调用） ---------- */

  /* ---------- webServer 路由 ---------- */

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/quickdock',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://x')
      if (url.pathname === '/quickdock' || url.pathname === '/quickdock/') {
        const t = url.searchParams.get('t')
        if (t !== token) {
          res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
          return res.end('invalid token')
        }
        // view=display → 展示窗口页面；否则是输入窗口页面
        const view = url.searchParams.get('view') === 'display' ? 'display' : 'input'
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
        return res.end(htmlPage(view))
      }
      if (url.pathname.startsWith('/quickdock/api/')) return handleApi(req, res, url)
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('not found')
    }
  }), 'quickdock: page + api routes')


  /* ---------- 浏览器桥接（主窗口 Cookie 鉴权） ---------- */
  // 静态插件客户端半没有 host.call；「推到 dock」/唤出走 connection.fetch 路由，
  // 由 client-connection 的 admit() 做回环围栏 + 会话 Cookie 校验。
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/quickdock',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let body = {}
      try { body = await request.json() } catch {}
      const action = String(body?.action ?? '')
      if (action === 'bind') {
        const sessionId = String(body?.sessionId ?? '')
        if (!sessionId) return Response.json({ ok: false, error: 'sessionId required' }, { status: 400 })
        const result = postBind({ sessionId })
        return Response.json(result)
      }
      if (action === 'summon') {
        dock.summon()
        return Response.json({ ok: true, error: state.dock.error || undefined })
      }
      if (action === 'status') {
        // 客户端轮询用：dock 启动是异步的，bind 返回时可能还没失败，
        // 错误要在这里才能被读到。
        return Response.json({
          ok: true,
          running: Boolean(dock.child),
          error: state.dock.error || ''
        })
      }
      if (action === 'web-url') {
        // Web 形态入口：浏览器用户拿带 token 的 /quickdock 地址（等同桌面 dock 的功能）
        const origin = ctx.webServer.getOrigin()
        return Response.json({ ok: true, url: origin + '/quickdock?t=' + token })
      }
      return Response.json({ ok: false, error: 'unknown action' }, { status: 400 })
    }
  }), 'quickdock: browser bridge route')

  refreshCatalogs()
  const catalogTimer = setTimeout(() => refreshModels(), 1500)
  ctx.effect(() => () => clearTimeout(catalogTimer), 'quickdock: catalog timer')

  ctx.logger?.info('quickdock: host half loaded')
}
