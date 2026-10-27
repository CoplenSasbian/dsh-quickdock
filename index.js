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
import { spawn, spawnSync } from 'node:child_process'
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
  /**
   * 两个窗口的内容宽度（输入窗口和展示窗口同宽，视觉上才是一"摞"）。
   * 600 在 1080p 上偏宽，480 既能放下四个功能键，又不占桌面。
   */
  width: Schema.number().default(480),
  /** 输入窗口的固定高度（只有输入相关的 UI）。 */
  inputHeight: Schema.number().default(172),
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

function traceLogPath() {
  return join(process.env.LOCALAPPDATA || process.env.TEMP || '.', 'dsh-quickdock', 'host.log')
}

function traceLog(msg) {
  try {
    const fs = require('node:fs')
    const file = traceLogPath()
    fs.mkdirSync(dirname(file), { recursive: true })
    fs.appendFileSync(file, '[' + new Date().toISOString() + '] ' + String(msg) + '\n')
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
 * 三重校验：
 *  1. 退出码必须是 0 —— 被安全软件拦崩时是 STATUS_BREAKPOINT (0x80000003 → 2147483651)
 *  2. 输出必须是 vN.N.N 形态 —— 纯 Node 也会输出版本号，单看退出码分不出来
 *  3. ELECTRON_RUN_AS_NODE 必须先删掉 —— 不删会退化成 Node 模式，探测失真
 *
 * ⚠️ 实测（本机，联想版火绒 + Electron 40/44）：
 *   `electron.exe --version`              → 2147483651，无输出
 *   `electron.exe --no-sandbox --version` → 0，输出 v40.10.2
 * 也就是说**不加 --no-sandbox 的探测会假阴性**，把唯一可用的 Electron 判死，
 * 然后退到「下载」分支 —— 而下载又需要 npm 依赖，最终表现为「点了按钮没反应」。
 * 所以两种启动方式都试，只要有一路成功就算可用，并**记下成功的那组参数**，
 * 后面真正 spawn 时照抄（否则探测能过、启动照样崩）。
 *
 * @returns 成功时返回要附加的启动参数（如 ['--no-sandbox']），失败返回 null
 */
function probeElectron(exe) {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_NO_ATTACH_CONSOLE
  const attempts = [['--no-sandbox', '--version'], ['--version']]
  for (const args of attempts) {
    try {
      const result = spawnSync(exe, args, { env, windowsHide: true, timeout: 15000, encoding: 'utf8' })
      if (result.error || result.status !== 0) continue
      const out = String(result.stdout || '').trim()
      if (!/^v?\d+\.\d+\.\d+/.test(out)) continue
      return args.slice(0, -1)   // 去掉 --version，只留启动参数
    } catch {}
  }
  return null
}

/** 兼容旧调用：只想知道能不能跑。 */
function canRunElectron(exe) {
  return probeElectron(exe) !== null
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
    const args = probeElectron(exe)
    traceLog('  probe ' + (args ? 'OK  ' : 'FAIL') + ' ' + exe + (args && args.length ? ' args=' + args.join(' ') : ''))
    if (args) {
      if (rejected.length) ctx.logger?.info('quickdock: skipped unusable Electron at %s', rejected.join(', '))
      return { exe, args }
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

/**
 * 找到一份真正能跑的 Electron。
 * @returns {Promise<{exe: string, args: string[]}|null>}
 */
async function resolveElectronPath(ctx) {
  const found = existingElectron(ctx)
  if (found) return found
  try {
    const downloaded = await downloadElectron(ctx)
    if (downloaded) {
      // 下载完必须再实测一次：下载成功不代表这份二进制在本机能启动
      // （实测有机器上 Electron 会以 STATUS_BREAKPOINT 崩在 JS 执行之前）。
      const args = probeElectron(downloaded)
      if (args) return { exe: downloaded, args }
      throw new Error('下载完成但仍无法启动（进程在 JS 执行前崩溃，通常是安全软件拦截）：' + downloaded)
    }
    return null
  } catch (error) {
    const reason = String(error && error.message || error)
    ctx.logger?.error('quickdock: Electron 不可用: ' + reason)
    traceLog('electron unavailable: ' + reason)
    // 依赖没装时 @electron/get 会报 "Cannot find package"，用户看到这句话没法行动。
    // 把可执行的下一步直接写进错误里。
    const hint = /Cannot find package|ERR_MODULE_NOT_FOUND/i.test(reason)
      ? '（本插件需要先 npm install：它用 @electron/get 下载 Electron。'
        + '也可以手动指定 DSH_QUICKDOCK_ELECTRON_PATH 指向一个 electron.exe）'
      : ''
    const err = new Error('Electron 不可用：' + reason + hint)
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
    /**
     * 会话索引：sessionId → { title, updatedAt, running, blank, cwd }。
     *
     * 为什么需要它：以前会话行直接从 `sessions.get(id)` 取标题，
     * 而**冷会话（没在当前进程里打开过）根本不在 sessions 里**，
     * 于是退化成把 sessionId 当标题显示 —— 菜单里就出现一堆 UUID。
     * sessionController.list() 是冷安全接口（不激活 Agent），
     * 连投影缓存里的 title 都会带回来，所以标题应该从它来。
     */
    sessionIndex: new Map(),
    sessionIndexAt: 0,
    /**
     * 正在流式输出的内容（当前 attempt）。
     *
     * session/event 只在消息**提交后**才有 assistant/message，
     * 所以光靠它，dock 上只能一条条"蹦"出来。真正的逐字输出走
     * agent/assistant-stream（进程内事件，带 text-delta / reasoning-delta）。
     * 结构：{ active, thinking, text, tools[], turn, step, startedAt }
     */
    stream: null,
    // error: 最近一次 dock 启动失败的原因（空字符串=无错误）。客户端据此显示提示。
    dock: { running: false, alwaysOnTop: config.alwaysOnTop, error: '' }
  }

  const sseClients = new Set()
  /**
   * 「在 DSH 主窗口打开会话」的命令总线。
   *
   * dock 是独立进程，碰不到浏览器里那个 SPA；而 client 半（浏览器插件）
   * 正好在 SPA 里，能调 ctx.uiWorkspace.openSession()。
   * 于是：dock → 宿主这一跳用 API，宿主 → 浏览器这一跳用一条轻量 SSE；
   * 只有这种"从不发起、只等待"的场景才需要长连接，所以单开一条总线，
   * 不与 dock 的状态流混在一起（那个每秒十几帧）。
   */
  const busClients = new Set()
  const broadcast = (event, data) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const res of sseClients) {
      try { res.write(payload) } catch {}
    }
  }

  const publish = () => broadcast('state', snapshot())

  function busBroadcast(payload) {
    const frame = 'event: command\ndata: ' + JSON.stringify(payload) + '\n\n'
    for (const res of busClients) {
      try { res.write(frame) } catch {}
    }
  }

  /** 让 DSH 主窗口切到当前绑定的会话。 */
  function openSessionInDsh(sessionId) {
    if (!sessionId) return { ok: false, error: '还没有绑定会话' }
    if (!busClients.size) return { ok: false, error: 'DSH 主窗口没有连上（插件是否启用？）' }
    busBroadcast({ type: 'open-session', sessionId })
    traceLog('open-in-dsh: ' + sessionId)
    return { ok: true }
  }

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

  /** 会话最近一次用户提问的时间（取不到返回 null，由调用方回落到创建时间）。 */
  function lastPromptAtOf(session) {
    if (!session) return null
    try {
      const meta = ctx.get('sessionProjections')?.snapshot(session, ['sessionListMetadata'])?.values?.sessionListMetadata
      return typeof meta?.lastPromptAt === 'number' ? meta.lastPromptAt : null
    } catch {
      return null
    }
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

  /**
   * 一个会话在列表里显示什么。
   *
   * 优先级：索引里的 title（session/list 的投影，冷会话也有）
   *        → 活动会话的投影 title
   *        → cwd 目录名
   *        → 「新会话」/「未命名会话」
   * **永远不要**退回 sessionId：那是最没用的一条信息。
   */
  function sessionTitle(id, live, meta) {
    const fromIndex = typeof meta?.title === 'string' ? meta.title.trim() : ''
    if (fromIndex) return fromIndex
    if (live) {
      const fromLive = sessionTitleOf(live)
      if (fromLive && fromLive !== live.id) return fromLive
    }
    const cwd = meta?.cwd || live?.header?.cwd || ''
    const base = cwd ? String(cwd).split(/[\\/]/).filter(Boolean).pop() : ''
    if (base) return base
    return meta?.blank === false ? '未命名会话' : '新会话'
  }

  /**
   * 刷新会话索引。
   *
   * sessionController.list() 只读已存 header 与投影缓存，不会激活任何 Agent，
   * 是拿「冷会话标题」的唯一正确入口。
   */
  async function refreshSessionIndex() {
    const controller = ctx.get('sessionController')
    if (!controller?.list) return
    try {
      const rows = await controller.list()
      if (!Array.isArray(rows)) return
      const next = new Map()
      for (const row of rows) {
        const id = String(row?.sessionId ?? '')
        if (!id) continue
        const values = row?.projections?.values ?? {}
        next.set(id, {
          title: typeof values.title === 'string' ? values.title.trim() : '',
          updatedAt: Number(row.updatedAt) || 0,
          running: row.running === true,
          blank: row.blank === true,
          cwd: typeof row.cwd === 'string' ? row.cwd : ''
        })
      }
      state.sessionIndex = next
      state.sessionIndexAt = Date.now()
      publish()
    } catch (error) {
      traceLog('session list failed: ' + String(error && error.message || error))
    }
  }

  /** 索引只用来拿"绑定会话的标题"，事件很密，按 10s 节流就够。 */
  let lastIndexRefreshAt = 0
  function maybeRefreshSessionIndex() {
    const now = Date.now()
    if (now - lastIndexRefreshAt < 10000) return
    lastIndexRefreshAt = now
    void refreshSessionIndex()
  }

  /* ---------- state 快照 ---------- */

  function snapshot() {
    // 页面不再展示会话列表（dock 只服务"当前绑定的那一个"），所以只下发工作区骨架。
    // 以前每个 session/event 都要把所有会话的投影快照一遍再整包推送 —— 纯浪费。
    const workspaces = []
    try {
      const registry = ctx.get('workspaceRegistry')
      if (registry) {
        for (const w of registry.list()) workspaces.push({ id: w.id, name: w.title, path: w.path })
      }
    } catch (error) {
      ctx.logger?.warn('quickdock: workspace listing failed: %s', String(error))
    }

    const liveSession = state.sessionId ? ctx.get('sessions').get(state.sessionId) : undefined
    // 绑定会话可能是"冷的"（DSH 里很久没打开），标题/时间从索引里取
    const boundMeta = state.sessionId ? state.sessionIndex.get(state.sessionId) : undefined
    const folder = state.sessionId ? state.folders.get(state.sessionId) : null
    const steps = folder ? folder.rows() : []

    let backgroundRunning = 0
    try { backgroundRunning = (ctx.get('agents')?.list?.() ?? []).filter((a) => a.status === 'running' && a.id !== state.sessionId).length } catch {}

    return {
      workspaceId: state.workspaceId,
      sessionId: state.sessionId,
      newSession: state.newSession,
      workspaces,
      session: state.sessionId
        ? {
            id: state.sessionId,
            title: sessionTitle(state.sessionId, liveSession, boundMeta),
            cwd: boundMeta?.cwd || liveSession?.header?.cwd || '',
            updatedAt: boundMeta?.updatedAt ?? lastPromptAtOf(liveSession) ?? (liveSession?.header?.createdAt ?? 0),
            // 活着的 Agent 才是此刻的事实，索引里的 running 只作兜底
            running: sessionRunning(state.sessionId) || Boolean(boundMeta?.running)
          }
        : null,
      // 'ask' = 正在等用户做决定（审批/提问）；页面据此切到「等待」形态
      status: state.interaction?.status === 'open'
        ? 'ask'
        : (sessionRunning(state.sessionId) ? 'running' : 'idle'),
      steps,
      // 正在逐字输出的内容（思考 + 正文 + 进行中的工具调用）
      stream: state.stream,
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

  /**
   * DSH alias token → dock 自己的变量名（DESIGN 7.2）。
   *
   * 前缀换成 --qd-* 不只是为了不撞名：dock 的 CSS 全部写的是 --qd-*，
   * 传过来却按 --dsw-* 名字落地的话，一套主题等于没接上（页面只能吃内置兜底色）。
   */
  const THEME_TOKEN_MAP = {
    '--dsw-alias-bg-base': '--qd-bg-base',
    '--dsw-alias-bg-layer-1': '--qd-bg-layer-1',
    '--dsw-alias-bg-layer-2': '--qd-bg-layer-2',
    '--dsw-alias-bg-overlay': '--qd-bg-overlay',
    '--dsw-alias-border-l1': '--qd-border-l1',
    '--dsw-alias-border-l2': '--qd-border-l2',
    '--dsw-alias-label-primary': '--qd-label-primary',
    '--dsw-alias-label-secondary': '--qd-label-secondary',
    '--dsw-alias-label-tertiary': '--qd-label-tertiary',
    '--dsw-alias-brand-primary': '--qd-brand-primary',
    '--dsw-alias-state-success-primary': '--qd-state-success',
    '--dsw-alias-state-error-primary': '--qd-state-error',
    '--dsw-alias-state-warn-primary': '--qd-state-warn',
    '--dsw-alias-state-idle-primary': '--qd-state-idle',
    '--dsw-alias-interactive-bg-hover': '--qd-interactive-hover',
    '--dsw-alias-interactive-bg-active': '--qd-interactive-active',
    '--dsw-alias-scrollbar-bg-l1': '--qd-scrollbar',
    '--dsw-alias-scrollbar-hover-l1': '--qd-scrollbar-hover',
    '--dsw-alias-separator-primary': '--qd-separator',
    '--dsw-alias-tooltip-bg': '--qd-tooltip-bg',
    '--dsw-alias-tooltip-key-bg': '--qd-tooltip-key-bg'
  }
  const THEME_TOKENS = Object.keys(THEME_TOKEN_MAP)

  /**
   * 当前主题。
   *
   * 主题是**浏览器端**的概念（dsh-client-ui-theme 在 Web 客户端里跑），
   * 宿主侧没有同名服务。所以由 client 半把 theme 快照 POST 过来（acceptTheme），
   * 存在 state.theme 里；这里只负责取。
   */
  function themePayload() {
    if (state.theme) return state.theme
    // 兜底：万一将来宿主侧真的挂了一个 theme 服务，也能直接用
    const themeSvc = ctx.get('theme')
    if (themeSvc?.getTheme) {
      try {
        const snap = themeSvc.getTheme()
        const tokens = {}
        for (const name of THEME_TOKENS) {
          const value = snap.active?.tokens?.[name]
          if (typeof value === 'string') tokens[name] = value
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

  /**
   * 接收 client 半推来的主题快照。
   *
   * 只收 21 个白名单 token（DESIGN 7.2）：多推的字段一律丢弃，
   * 页面不会因为一个陌生 token 变成半套配色。
   * @returns 是否被采纳（token 太少说明不是真主题，宁可用内置兜底色）
   */
  function acceptTheme(payload) {
    if (!payload || typeof payload !== 'object') return false
    const raw = payload.tokens && typeof payload.tokens === 'object' ? payload.tokens : {}
    const tokens = {}
    for (const [dsw, qd] of Object.entries(THEME_TOKEN_MAP)) {
      // 两种命名都接受：dsw（客户端原始快照）/ qd（已映射过的）
      const value = raw[qd] ?? raw[dsw]
      if (typeof value === 'string' && value.trim()) tokens[qd] = value.trim()
    }
    if (Object.keys(tokens).length < 6) return false
    const fonts = payload.fonts && typeof payload.fonts === 'object' ? payload.fonts : {}
    state.theme = {
      colorScheme: payload.colorScheme === 'light' ? 'light' : 'dark',
      tokens,
      fonts: {
        text: typeof fonts.text === 'string' ? fonts.text : '',
        code: typeof fonts.code === 'string' ? fonts.code : '',
        sizeText: Number(fonts.sizeText) || 12,
        sizeCode: Number(fonts.sizeCode) || 11
      }
    }
    // 页面首帧就有正确配色（不用等 SSE）
    broadcast('theme', state.theme)
    return true
  }

  function themeCss() {
    const payload = themePayload()
    if (!payload) return ''
    const rows = Object.entries(payload.tokens).map(([key, value]) => `  ${key}: ${value};`).join('\n')
    const fonts = []
    if (payload.fonts?.text) fonts.push(`  --qd-font-text: ${payload.fonts.text};`)
    if (payload.fonts?.code) fonts.push(`  --qd-font-code: ${payload.fonts.code};`)
    if (payload.fonts?.sizeText) fonts.push(`  --qd-font-size-text: ${payload.fonts.sizeText}px;`)
    if (payload.fonts?.sizeCode) fonts.push(`  --qd-font-size-code: ${payload.fonts.sizeCode}px;`)
    // 首屏就按真实配色画，避免先闪一下内置兜底色
    return `<style>:root{\n${rows}\n${fonts.join('\n')}\n}</style>`
  }

  // 宿主侧若将来挂了 theme 服务，也能直接同步（当前 DSH 的主题只在浏览器里）
  ctx.on('theme/change', (snap) => {
    acceptTheme({
      colorScheme: snap.active?.colorScheme,
      tokens: Object.fromEntries(THEME_TOKENS.map((name) => [name, snap.active?.tokens?.[name]])),
      fonts: {
        text: snap.fontFamilies?.text ?? '',
        code: snap.fontFamilies?.code ?? '',
        sizeText: snap.fontSizes?.text ?? 12,
        sizeCode: snap.fontSizes?.code ?? 11
      }
    })
  })

  /* ---------- session/event 订阅（只读折叠） ---------- */

  const onSessionEvent = (session, event) => {
    // 标题会随对话推进变化（DSH 自己起的标题），索引跟着刷（3s 节流）
    maybeRefreshSessionIndex()
    if (!state.sessionId || session.id !== state.sessionId) return
    if (event?.type === 'turn/start') clearStream()
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
    // running 状态进索引，别的会话的"运行中"标记也要准
    lastIndexRefreshAt = 0
    maybeRefreshSessionIndex()
    if (!state.sessionId || agent.id !== state.sessionId) return
    // Agent 不跑了还留着半截流内容会一直挂在页面上
    if (agent.status !== 'running') clearStream()
    publish()
  }
  ctx.on('agent/status', onAgentStatus)

  /* ---------- 流式输出（逐字） ---------- */

  /**
   * 订阅 agent/assistant-stream —— dock 的"实时感"全靠它。
   *
   * frame 只有三种：
   *   start  { attemptId, revision, turn, step }
   *   chunk  { index, time, chunk }   chunk ∈ block-start / text-delta / reasoning-delta
   *                                   / tool-call-delta / block-end / usage / finish
   *   end    { index, outcome }       committed（已落成 assistant/message）| abandoned
   *
   * 只做展示：不写任何事件、不参与会话状态。
   */
  const onAssistantStream = ({ agent, frame }) => {
    if (!state.sessionId || !frame) return
    // 事件由 agent 的 scoped dispatch 发出，正常都带 agent；
    // 万一没带（未来的实现变化），就当作"当前绑定会话"处理 ——
    // 子 Agent 的流会带自己的 agent.id，仍然会被过滤掉。
    const sessionId = agent?.id ?? agent?.session?.id ?? null
    if (sessionId && sessionId !== state.sessionId) return
    try {
      applyStreamFrame(frame)
    } catch (error) {
      traceLog('stream frame failed: ' + String(error && error.message || error))
    }
    scheduleStreamFlush()
  }
  ctx.on('agent/assistant-stream', onAssistantStream)

  function clearStream() {
    if (!state.stream) return
    state.stream = null
    scheduleStreamFlush()
  }

  /** 把一帧折进 state.stream（只保留最近 8k 字符，防止无限增长）。 */
  function applyStreamFrame(frame) {
    if (frame.type === 'start') {
      state.stream = {
        active: true,
        thinking: '',
        text: '',
        tools: [],
        turn: Number(frame.turn) || 0,
        step: Number(frame.step) || 0,
        startedAt: Date.now()
      }
      return
    }
    if (frame.type === 'end') {
      // committed：durable 的 assistant/message 马上就到，这里让位给它
      state.stream = null
      return
    }
    if (frame.type !== 'chunk') return

    if (!state.stream) {
      // 没收到 start（比如 dock 是在中途打开的）也要能显示
      state.stream = { active: true, thinking: '', text: '', tools: [], turn: 0, step: 0, startedAt: Date.now() }
    }
    const stream = state.stream
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
        if (tool.args.length > 240) tool.args = tool.args.slice(0, 240) + '…'
        break
      }
      default:
        break
    }

    // 页面只显示尾部，所以没必要把全文都发过去（SSE 每秒 10 次，长度就是带宽）
    if (stream.thinking.length > 2000) stream.thinking = stream.thinking.slice(-2000)
    if (stream.text.length > 4000) stream.text = stream.text.slice(-4000)
  }

  // token 洪流不能一帧一次 publish（SSE 会被打爆），合并成 ~12 次/秒
  let streamFlushTimer = null
  function scheduleStreamFlush() {
    if (streamFlushTimer) return
    streamFlushTimer = setTimeout(() => {
      streamFlushTimer = null
      publish()
    }, 100)
    if (streamFlushTimer.unref) streamFlushTimer.unref()
  }

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

  /**
   * 权限预设：DSH 的真实目录（permissionPresets.catalog()）。
   *
   * 这里**不写死枚举**（DESIGN 6.4）：部署可能增删预设，
   * 目录里的 options 才是唯一事实来源。
   */
  function refreshPermissions() {
    try {
      const presets = ctx.get('permissionPresets')
      if (!presets?.catalog) return
      const catalog = presets.catalog()
      const options = Array.isArray(catalog?.options) ? catalog.options : []
      if (!options.length) return
      state.catalogs.permissions = options.map((option) => ({
        value: String(option.value),
        name: String(option.name ?? option.value),
        description: option.description ? String(option.description) : ''
      }))
      // 当前值不可用时回落到部署默认预设，避免菜单里没有任何选中项
      const known = state.catalogs.permissions.some((o) => o.value === state.settings.permission)
      if (!known) {
        const fallback = catalog.defaultPreset
          || state.catalogs.permissions[0].value
        state.settings.permission = String(fallback)
      }
    } catch (error) {
      traceLog('permission catalog failed: ' + error)
    }
  }

  /** Agent 预设：agentPresets.list()（异步）。 */
  async function refreshAgents() {
    try {
      const registry = ctx.get('agentPresets')
      if (!registry?.list) return
      const rows = await registry.list()
      if (!Array.isArray(rows)) return
      state.catalogs.agents = rows.map((row) => ({
        id: String(row.id),
        name: String(row.name ?? row.id),
        description: row.description ? String(row.description) : ''
      }))
    } catch (error) {
      traceLog('agent preset catalog failed: ' + error)
    }
  }

  function refreshCatalogs() {
    refreshPermissions()
    void refreshAgents().then(publish, () => {})
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
            name: model.name ?? model.id,
            group: group.name ?? group.id,
            // 思考强度用 id 数组（页面按 id 显示中文标签）
            reasoning: (model.reasoning?.efforts ?? []).map((effort) => effort.id),
            reasoningDefault: model.reasoning?.defaultEffort ?? ''
          })
        }
      }
      state.catalogs.models = models
      if (!state.settings.model && catalog.default?.provider && catalog.default?.model) {
        state.settings.model = catalog.default.provider + '/' + catalog.default.model
        state.settings.reasoning = catalog.default.reasoningEffort ?? ''
      }
      publish()
    } catch (error) {
      ctx.logger?.warn('quickdock: model catalog failed: %s', String(error))
      traceLog('model catalog failed: ' + error)
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
    // markdown.js 先跑：它定义的 renderMarkdown 是 app.js（IIFE 内）用的全局函数
    try { js = readFileSync(join(__dirname, 'web', 'markdown.js'), 'utf8') } catch {}
    try { js += '\n' + readFileSync(join(__dirname, 'web', 'app.js'), 'utf8') } catch {}
    // 深浅模式写死在 HTML 里，首帧就是对的（不用等脚本跑完再切）
    const scheme = themePayload()?.colorScheme === 'light' ? 'light' : 'dark'
    // ⚠️ 一律用**替换函数**而不是字符串：String.replace 的替换串会把
    // $&、$'、$` 当成特殊模式。JS/CSS 源码里出现 "$'" 时，
    // 它会把标记之后的 HTML 整段插进脚本中间 —— 页面直接语法错误。
    const put = (value) => () => value
    return indexHtml
      .replace('data-theme="dark"', put('data-theme="' + scheme + '"'))
      .replace('<!--QD_THEME-->', put(themeCss()))
      .replace('<!--QD_STYLES-->', put('<style>' + css + '</style>'))
      .replace('<!--QD_SCRIPT-->', put('<script>' + js + '</script>'))
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

  /**
   * 页面鉴权。
   *
   * 两种方式都必须支持：
   *  - Authorization: Bearer <token>  —— fetch 走这条
   *  - ?t=<token>                     —— **EventSource 无法设置请求头**，
   *    SSE 只能把 token 放查询串。以前只认 header，导致 /api/stream 恒 401，
   *    页面永远收不到 state 推送（开着窗口但内容不更新）。
   */
  function authed(req, url) {
    if (req.headers.authorization === 'Bearer ' + token) return true
    const supplied = url?.searchParams?.get('t')
    return Boolean(supplied) && supplied === token
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
    // 有人打开 dock：先把会话标题索引刷新一遍，菜单里才是真标题
    void refreshSessionIndex()
  }

  async function handleApi(req, res, url) {
    if (!authed(req, url)) return json(res, 401, { error: 'unauthorized' })
    try {
      return await dispatchApi(req, res, url)
    } catch (error) {
      // ⚠️ DSH 的 webServer 会把**抛出的异常**变成一个空 body 的 400，
      // 页面上只看到「api task 400」，完全不知道为什么。
      // 所以这里必须自己接住：把原因写进 body，同时落一行 host.log。
      const message = String(error && error.message || error)
      traceLog('api ' + url.pathname + ' failed: ' + message
        + (error && error.stack ? '\n' + error.stack : ''))
      ctx.logger?.warn('quickdock: %s failed: %s', url.pathname, message)
      return json(res, 400, { ok: false, error: message })
    }
  }

  async function dispatchApi(req, res, url) {
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
    if (req.method === 'POST' && path === '/quickdock/api/settings') return json(res, 200, await postSettings(body))
    if (req.method === 'POST' && path === '/quickdock/api/stop') return json(res, 200, await postStop())
    if (req.method === 'POST' && path === '/quickdock/api/answer') return json(res, 200, { ok: answerInteraction(body) })
    if (req.method === 'POST' && path === '/quickdock/api/bind') return json(res, 200, postBind(body))
    if (req.method === 'POST' && path === '/quickdock/api/theme') return json(res, 200, { ok: acceptTheme(body) })
    if (req.method === 'POST' && path === '/quickdock/api/window') return json(res, 200, postWindow(body))
    if (req.method === 'POST' && path === '/quickdock/api/open-session') return json(res, 200, postOpenSession(body))
    if (req.method === 'GET' && path === '/quickdock/api/catalogs') {
      await refreshModels()
      return json(res, 200, state.catalogs)
    }
    // 命令总线（浏览器侧订阅，用来把"在 DSH 打开会话"推过去）
    if (req.method === 'GET' && path === '/quickdock/api/bus') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive'
      })
      res.write(': connected\n\n')
      busClients.add(res)
      // 空闲太久会被中间层掐断，定期 ping 一下
      const ping = setInterval(() => {
        try { res.write(': ping\n\n') } catch {}
      }, 20000)
      if (ping.unref) ping.unref()
      req.on('close', () => {
        clearInterval(ping)
        busClients.delete(res)
      })
      return
    }
    if (req.method === 'POST' && path === '/quickdock/api/open-in-dsh') {
      return json(res, 200, openSessionInDsh(state.sessionId))
    }

    // 某一行的展开细节（工具参数 / 输出全文）。按需取，不随 state 推送。
    if (req.method === 'GET' && path === '/quickdock/api/step-detail') {
      const id = url.searchParams.get('id') || ''
      const folder = state.sessionId ? state.folders.get(state.sessionId) : null
      const detail = folder?.detailOf?.(id) || null
      return json(res, 200, detail || { args: '', result: '' })
    }
    return json(res, 404, { error: 'not found' })
  }

  /** 会话当前会话对象（不存在返回 undefined）。 */
  function sessionOf(sessionId) {
    try { return ctx.get('sessions')?.get?.(sessionId) } catch { return undefined }
  }

  /**
   * 把 dock 里选的权限预设应用到会话。
   *
   * 必须走 permissionPresets.set(session, name)：它会同时落 preset 与
   * sandbox / approval 两个 knob 的持久事件，主窗口那边才是同步的。
   */
  function applyPermissionPreset(sessionId) {
    const name = state.settings.permission
    if (!sessionId || !name) return false
    try {
      const presets = ctx.get('permissionPresets')
      if (!presets?.set) return false
      const session = sessionOf(sessionId)
      if (!session) return false
      presets.set(session, name)
      return true
    } catch (error) {
      traceLog('permission set failed: ' + String(error && error.message || error))
      return false
    }
  }

  /** 把 dock 里选的模型 / 思考强度应用到会话。 */
  async function applyModelSelection(sessionId) {
    if (!sessionId || !state.settings.model) return false
    const [provider, model] = state.settings.model.split('/')
    if (!provider || !model) return false
    try {
      await ctx.get('sessionController').selectModel({
        sessionId,
        provider,
        model,
        ...(state.settings.reasoning ? { reasoningEffort: state.settings.reasoning } : {})
      })
      return true
    } catch (error) {
      ctx.logger?.warn('quickdock: selectModel failed: %s', String(error))
      traceLog('selectModel failed: ' + String(error && error.message || error))
      return false
    }
  }

  /**
   * 会话的权限 / 模型回读。
   *
   * 绑定到已有会话时，dock 里的功能键必须显示**那个会话的真实状态**，
   * 而不是 dock 自己的上次选择 —— 否则用户会看到「权限：完全」但会话其实是只读。
   */
  function syncSettingsFromSession(sessionId) {
    const session = sessionOf(sessionId)
    if (!session) return
    try {
      const preset = ctx.get('permissionPresets')?.current?.(session)
      if (typeof preset === 'string' && preset) state.settings.permission = preset
    } catch {}
    try {
      const selection = ctx.get('sessionProjections')?.stateOf?.(session, 'modelSelection')
      const active = selection?.pending ?? selection?.lastUsed
      if (active?.provider && active?.model) {
        state.settings.model = active.provider + '/' + active.model
        state.settings.reasoning = active.reasoningEffort ?? ''
      }
    } catch {}
  }

  async function postTask(body) {
    const text = String(body?.text ?? '').trim()
    if (!text) throw new Error('缺少消息内容')
    const controller = ctx.get('sessionController')
    if (!controller) throw new Error('sessionController 不可用（DSH 版本不匹配？）')

    const workspaceId = body.workspaceId || state.workspaceId
    const fork = body.fork === true
    let sessionId = body.sessionId || (state.newSession ? null : state.sessionId)

    if (fork && state.sessionId) {
      const forked = await controller.fork({ sessionId: state.sessionId })
      sessionId = forked.sessionId
      state.sessionId = sessionId
      state.newSession = false
    } else if (!sessionId) {
      const created = await controller.create({
        ...(workspaceId ? { workspaceId } : {}),
        ...(state.settings.agentPreset ? { agentPreset: state.settings.agentPreset } : {})
      })
      sessionId = created.sessionId
      state.sessionId = sessionId
      state.newSession = false
      if (!state.workspaceId) state.workspaceId = findWorkspaceIdForSession(sessionId) ?? workspaceId ?? null
      // 新会话：把 dock 里选好的权限预设落进去（create 不接受 preset 参数）
      applyPermissionPreset(sessionId)
    } else {
      // 复用已有会话：先把 dock 当前选择同步进去
      applyPermissionPreset(sessionId)
    }

    // 模型 / 思考强度（selectModel 失败不阻塞发送，但会记日志）
    await applyModelSelection(sessionId)

    if (!state.folders.has(sessionId)) state.folders.set(sessionId, new StepFolder(config.maxSteps, onFoldMerge))
    else state.folders.get(sessionId).reset()

    // ⚠️ prompt 的第二个参数是**必填的 AbortSignal**（实现第一行就是
    // signal.throwIfAborted()）。不传会抛 TypeError → webServer 返回空 400，
    // 页面只看到「发送失败」。来源（user-rpc）由宿主按调用方 principal 自己组装。
    const abort = new AbortController()
    try {
      await controller.prompt({
        sessionId,
        content: [{ type: 'text', text }],
        requestId: 'qd-' + randomUUID(),
        mode: config.submitMode === 'steer' ? 'steer' : 'queue',
        clientTimeZone: localTimeZone()
      }, abort.signal)
    } catch (error) {
      traceLog('prompt failed: ' + String(error && error.message || error))
      throw error
    }

    publish()
    return { sessionId }
  }

  /** 本机 IANA 时区（DSH 只接受 UTC 或 IANA 名称）。 */
  function localTimeZone() {
    try {
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
      return zone && typeof zone === 'string' ? zone : 'UTC'
    } catch {
      return 'UTC'
    }
  }

  function postSelect(body) {
    if (body.workspaceId !== undefined) state.workspaceId = body.workspaceId || null
    if (body.sessionId !== undefined) {
      state.sessionId = body.sessionId || null
      state.newSession = body.newSession === true || !body.sessionId
      // 绑定会话时工作区必须跟着会话走（现在可以跨工作区直接选会话了）
      if (state.sessionId) state.workspaceId = findWorkspaceIdForSession(state.sessionId) ?? state.workspaceId
    }
    if (body.newSession === true) {
      state.sessionId = null
      state.newSession = true
    }
    state.stream = null
    if (state.sessionId) {
      // 绑定已有会话：功能键回读该会话的真实权限/模型
      syncSettingsFromSession(state.sessionId)
      if (!state.folders.has(state.sessionId)) {
        state.folders.set(state.sessionId, new StepFolder(config.maxSteps, onFoldMerge))
      }
      state.interaction = null
    }
    publish()
    return { ok: true }
  }

  /**
   * 功能键写入。
   *
   * 只改 state 是不够的：用户点「完全权限」就是要那个会话立刻变成完全权限。
   * 会话已绑定时必须落到 DSH（permissionPresets.set / selectModel），
   * 未绑定时先记在 state 里，发送时随 create 一起应用。
   */
  async function postSettings(body) {
    const errors = []
    if (body.permission !== undefined) {
      state.settings.permission = String(body.permission)
      if (state.sessionId && !applyPermissionPreset(state.sessionId)) {
        errors.push('权限预设未能写入会话')
      }
    }
    if (body.model !== undefined) {
      state.settings.model = String(body.model)
      // 换模型时清掉思考强度：旧的 effort 可能不被新模型支持
      if (body.reasoning === undefined) state.settings.reasoning = ''
      if (state.sessionId && state.settings.model) {
        const ok = await applyModelSelection(state.sessionId)
        if (!ok) errors.push('模型选择未能写入会话')
      }
    }
    if (body.reasoning !== undefined) {
      state.settings.reasoning = String(body.reasoning)
      if (state.sessionId && state.settings.model) {
        const ok = await applyModelSelection(state.sessionId)
        if (!ok) errors.push('思考强度未能写入会话')
      }
    }
    if (body.agentPreset !== undefined) state.settings.agentPreset = String(body.agentPreset)
    publish()
    return errors.length ? { ok: false, error: errors.join('；') } : { ok: true }
  }

  async function postStop() {
    if (!state.sessionId) return { ok: false }
    try {
      state.stream = null
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
    state.interaction = null
    state.stream = null
    if (!state.folders.has(sessionId)) state.folders.set(sessionId, new StepFolder(config.maxSteps, onFoldMerge))
    // 绑定时回读该会话真实的权限/模型，功能键才是对的
    syncSettingsFromSession(sessionId)
    refreshPermissions()
    publish()
    // 「推到 Dock」= 用户明确想要桌面 dock。
    // 按需模式下 dock 此刻可能尚未启动（这正是预期状态），所以这里主动创建。
    // **不做任何降级**：失败时 dock.summon() 会写 state.dock.error，客户端据此提示。
    dock.summon()
    // dock 创建是异步的：notifyAttach 会在 dock 未 ready 时暂存，ready 后自动补发
    dock.notifyAttach(sessionId)
    return {
      ok: true,
      dockRunning: dock.alive,
      // 刚 spawn 时还没 ready：告诉客户端"在启动"，让它继续轮询而不是当成失败
      starting: dock.starting,
      error: state.dock.error || undefined
    }
  }

  function postWindow(body) {
    if (body.alwaysOnTop !== undefined) state.dock.alwaysOnTop = Boolean(body.alwaysOnTop)
    dock.applyWindow({ alwaysOnTop: state.dock.alwaysOnTop })
    // 必须 publish：两个窗口的 ⤒ 都是读 state.runtime.alwaysOnTop 来画选中态的
    publish()
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
    // stdout 行协议缓冲
    buffer: '',

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

    /** 进程活着并且已经自报 ready（拿到了控制通道端口）才算可用。 */
    get alive() {
      return Boolean(this.child) && this.controlPort > 0 && !this.stopping
    },

    /** 正在拉起（探测 Electron / spawn / 等 ready）。客户端据此继续轮询。 */
    get starting() {
      return !this.alive && (Boolean(this.child) || this.spawning) && !this.stopping
    },

    /** 向 dock 的回环控制通道下发一条命令。 */
    control(message, timeoutMs) {
      return controlRequest(this.controlPort, controlToken, message, timeoutMs)
    },

    /**
     * 拉起 dock 进程。
     *
     * 失败必须让用户看见：这里不吞异常，一律走 reportDockError 写到 state，
     * 否则表现就是「点了按钮没反应」，最难受也最难查。
     */
    async spawnDock() {
      if (this.child || this.spawning || this.stopping) return
      this.spawning = true
      try {
        const resolved = await resolveElectronPath(ctx)
        if (!resolved?.exe) throw new Error('未找到可用的 Electron 运行时')
        const exe = resolved.exe
        const env = this.env()
        // 关键：必须删除而不是置空。置空字符串会让 Electron 以 exit 134 自杀（DESIGN 3.3）
        delete env.ELECTRON_RUN_AS_NODE
        delete env.ELECTRON_NO_ATTACH_CONSOLE
        // 探测阶段记下的参数必须照抄：本机实测不加 --no-sandbox 会在 JS 执行前崩
        const argv = [...(resolved.args || []), join(__dirname, 'runtime', 'main.cjs')]
        const child = spawn(exe, argv, {
          cwd: __dirname,
          env,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe']
        })
        this.child = child
        this.controlPort = 0
        state.dock.running = true
        traceLog('spawn: ' + exe + ' ' + argv.join(' '))
        publish()

        // 三根管道都不能把 EPIPE 变成 uncaught（宿主退出时必然发生）
        for (const stream of [child.stdin, child.stdout, child.stderr]) {
          if (stream && typeof stream.on === 'function') stream.on('error', () => {})
        }

        // stdout 行协议：quickdock:{"type":"ready","controlPort":N}
        if (child.stdout) {
          child.stdout.setEncoding('utf8')
          child.stdout.on('data', (chunk) => {
            this.buffer += chunk
            if (this.buffer.length > 1024 * 1024) this.buffer = ''
            let newline
            while ((newline = this.buffer.indexOf('\n')) >= 0) {
              const line = this.buffer.slice(0, newline).replace(/\r$/, '').trim()
              this.buffer = this.buffer.slice(newline + 1)
              if (!line) continue
              if (!line.startsWith('quickdock:')) { traceLog('dock stdout: ' + line.slice(0, 400)); continue }
              let message
              try { message = JSON.parse(line.slice('quickdock:'.length)) } catch { continue }
              try { this.onStatus(message) } catch (error) { traceLog('status handler failed: ' + error) }
            }
          })
        }
        if (child.stderr) {
          child.stderr.setEncoding('utf8')
          child.stderr.on('data', (chunk) => {
            const text = String(chunk).trim()
            if (text) traceLog('dock stderr: ' + text.slice(0, 800))
          })
        }

        child.on('error', (error) => {
          reportDockError('dock 进程启动失败：' + String(error && error.message || error))
          if (this.child === child) {
            this.child = null
            this.controlPort = 0
            state.dock.running = false
            publish()
          }
        })

        child.on('exit', (code, signal) => {
          traceLog('dock exit code=' + code + ' signal=' + signal)
          if (this.child !== child) return
          this.child = null
          this.controlPort = 0
          this.buffer = ''
          state.dock.running = false
          publish()
          if (this.stopping) return
          // 按需模式下用户点 ✕ / Esc 是正常退出（code 0）—— 不重拉
          if (code === 0) { clearDockError(); return }
          this.scheduleRestart(code)
        })
      } catch (error) {
        reportDockError(String(error && error.message || error))
      } finally {
        this.spawning = false
      }
    },

    /** dock 自报状态（stdout 行协议）。 */
    onStatus(message) {
      const type = String(message?.type ?? '')
      if (type === 'ready') {
        this.controlPort = Number(message.controlPort) || 0
        this.restarts = 0
        clearDockError()
        state.dock.running = true
        traceLog('dock ready, controlPort=' + this.controlPort)
        publish()
        this.flushPending()
        return
      }
      if (type === 'error') reportDockError('dock: ' + String(message.message || '未知错误'))
    },

    /** dock ready 之后补发之前暂存的动作。 */
    flushPending() {
      if (!this.alive) return
      if (this.pendingAttach) {
        const sessionId = this.pendingAttach
        this.pendingAttach = ''
        void this.control({ type: 'attach', sessionId })
      }
      if (this.pendingShow) {
        this.pendingShow = false
        void this.control({ type: 'show' })
      }
    },

    /** 唤出 dock：没起来就拉起（拉起后 ready 时补 show）。 */
    summon() {
      this.stopping = false
      if (!this.child) {
        this.pendingShow = true
        void this.spawnDock()
        return
      }
      if (!this.alive) { this.pendingShow = true; return }
      void this.control({ type: 'show' }).then((ok) => {
        if (!ok) traceLog('summon: control show failed')
      })
    },

    /** 把某个会话推到 dock（dock 未 ready 时暂存）。 */
    notifyAttach(sessionId) {
      const id = String(sessionId || '')
      if (!id) return
      if (this.alive) { void this.control({ type: 'attach', sessionId: id }); return }
      this.pendingAttach = id
    },

    /** 窗口级设置（顶置开关）转发给 dock。 */
    applyWindow(patch) {
      if (!this.alive) return
      void this.control({ type: 'window', alwaysOnTop: Boolean(patch?.alwaysOnTop) })
    },

    /** 退出 dock（插件卸载 / 宿主退出时）。 */
    stop() {
      this.stopping = true
      if (this.timer) { clearTimeout(this.timer); this.timer = null }
      const child = this.child
      const port = this.controlPort
      this.child = null
      this.controlPort = 0
      this.buffer = ''
      state.dock.running = false
      if (!child) return
      // 先礼貌退出，1s 后兜底 kill（dock 自己也会探测宿主 PID）
      if (port) void controlRequest(port, controlToken, { type: 'quit' }, 800)
      const killer = setTimeout(() => {
        try {
          if (child.exitCode === null && !child.killed) child.kill()
        } catch {}
      }, 1000)
      if (killer.unref) killer.unref()
    },

    /** 崩溃后按退避重拉；次数用尽后把最后的原因留给用户看。 */
    scheduleRestart(code) {
      if (this.timer || this.stopping) return
      if (this.restarts >= this.backoff.length) {
        reportDockError('dock 进程反复退出（最后一次退出码 ' + code + '），已停止重试。'
          + '请看日志 ' + traceLogPath())
        return
      }
      const delay = this.backoff[this.restarts]
      this.restarts += 1
      reportDockError('dock 进程退出（退出码 ' + code + '），'
        + Math.round(delay / 1000) + 's 后重试（' + this.restarts + '/' + this.backoff.length + '）')
      this.timer = setTimeout(() => {
        this.timer = null
        void this.spawnDock()
      }, delay)
      if (this.timer.unref) this.timer.unref()
    }
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
          running: dock.alive,
          starting: dock.starting,
          error: state.dock.error || ''
        })
      }
      if (action === 'theme') {
        // client 半（浏览器）在启动和 theme/change 时推主题快照
        return Response.json({ ok: acceptTheme(body?.theme ?? body?.payload) })
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
  void refreshSessionIndex()
  // 有 dock 连着的时候每 8s 刷一次会话索引（标题/运行态/最近活跃）
  const indexTimer = setInterval(() => {
    if (!sseClients.size) return
    void refreshSessionIndex()
  }, 20000)
  // 定时刷新不该独自吊住事件循环（否则测试进程会永远退不出去）
  if (indexTimer.unref) indexTimer.unref()
  ctx.effect(() => () => clearInterval(indexTimer), 'quickdock: session index ticker')

  const catalogTimer = setTimeout(() => refreshModels(), 1500)
  ctx.effect(() => () => clearTimeout(catalogTimer), 'quickdock: catalog timer')

  ctx.logger?.info('quickdock: host half loaded')
}
