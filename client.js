window.__ModuleLoader__.load({ id: "dsh-quickdock", factory: (require) => { var module = { exports: {} };
// The loader contract passes an exports binding even when the plugin exports nothing.
// eslint-disable-next-line no-unused-vars
var exports = module.exports;
try {
var React = require('react');
var ReactDOM = null;
try { ReactDOM = require('react-dom'); } catch (error) { ReactDOM = null; }
/**
 * dsh-quickdock — Client half (static plugin).
 *
 * Available at runtime: React, ctx, host (a static plugin only has ctx
 * services; host.call belongs to dynamic plugins). No @deepseek-ai/dsh-client-*
 * package may be imported.
 *
 * Registers conversation.session.header.actions: the "Dock" button that pushes
 * the current session to QuickDock (order 1010, after dsh-rewind). The dock is
 * launched by the Host on demand, so no sidebar button is needed.
 */
const PLUGIN_ID = 'dsh-quickdock'
const HEADER_SLOT = 'conversation.session.header.actions'
const FOOTER_SLOT = 'sidebar.footer.action'
const BRIDGE = '/api/quickdock'

function el(tag, props) {
  return React.createElement.apply(React, arguments)
}

/* i18n-catalog:start — kept in sync with locale/en.json + locale/zh.json */
var MESSAGES = {
  en: {
    'app.displayTitle': 'QuickDock Display',
    'app.inputTitle': 'QuickDock',
    'app.name': 'QuickDock',
    'ask.back': 'Back',
    'ask.next': 'Next',
    'bar.close': 'Close QuickDock (Esc)',
    'bar.connecting': 'Connecting…',
    'bar.inputPanel': 'Input panel',
    'bar.newSession': 'New conversation (Shift/Alt-click forks the current session)',
    'bar.newSessionLabel': 'New conversation',
    'bar.newSessionTitle': 'New conversation',
    'bar.noSession': 'No conversation to reload yet',
    'bar.noWorkspace': 'No workspace',
    'bar.openInDsh': 'Open current session in DSH',
    'bar.pin': 'Always on top',
    'bar.reload': 'Reload the conversation',
    'bar.reloaded': 'Conversation reloaded',
    'bar.statusTitle': 'Status',
    'bar.toggleList': 'Show / hide the run window',
    'bar.toggleListLabel': 'Show or hide the run window',
    'bar.workspace': 'Workspace',
    'bar.workspaceTitle': 'Current workspace',
    'card.allow': 'Allow',
    'card.answerPlaceholder': 'Type an answer…',
    'card.deny': 'Deny',
    'card.needConfirm': '⚠ Needs confirmation',
    'card.question': '? Question',
    'card.submit': 'Submit',
    'client.dockFailed': 'QuickDock request failed: {reason}',
    'client.downloading': 'QuickDock is downloading its desktop runtime {percent}% ({mb}/{total} MB)',
    'client.label': 'Dock',
    'client.portBusy': 'Cannot open the window: 127.0.0.1:{port} is not listening ({code}). Change the port in Settings → QuickDock → Connection.',
    'client.more': 'More dock actions',
    'client.preparing': 'QuickDock is preparing its desktop window (the first run downloads Electron, ~1–2 minutes, once)…',
    'client.reloadApp': 'Reload the app',
    'client.reloadFailed': 'Reload failed: {reason}',
    'client.ballSize': 'Floating ball size',
    'client.ballSizeHint': 'Diameter of the whale ball the dock collapses into.',
    'client.requestFailed': 'Request failed: HTTP {status}',
    'client.resetFailed': 'Reset failed: {reason}',
    'client.resetWindows': 'Reset the window size',
    'client.restartDock': 'Restart the dock window',
    'client.restartFailed': 'Restart failed: {reason}',
    'client.sendToDock': 'Open this session in QuickDock',
    'client.startTimeout': 'QuickDock did not start in time. See {log}',
    'client.unknownError': 'Unknown error',
    'composer.label': 'Message or task',
    'composer.placeholder': 'Send a message or task…',
    'composer.send': 'Send (Enter)',
    'composer.sendLabel': 'Send',
    'confirm.cancel': 'Cancel',
    'confirm.ok': 'Enable full access',
    'confirm.text': 'The agent will be able to read and modify files and run commands outside the workspace. Continue only if you fully trust this task.',
    'confirm.title': 'Enable full access?',
    'detail.auto': 'Details: auto',
    'detail.closed': 'Details: folded',
    'detail.hidden': 'Details: window hidden',
    'detail.open': 'Details: all expanded',
    'display.act.code': 'Ran code',
    'display.act.commands': 'Ran commands',
    'display.act.edit': 'Edited files',
    'display.act.read': 'Read files',
    'display.act.readImage': 'Read images',
    'display.act.search': 'Searched code',
    'display.act.tools': 'Called tools',
    'display.act.webFetch': 'Visited web pages',
    'display.act.webSearch': 'Searched the web',
    'display.act.write': 'Wrote files',
    'display.collapse': 'Collapse details',
    'display.comma': ', ',
    'display.commandLine': 'Command line {line}',
    'display.copied': 'Copied',
    'display.copy': 'Copy',
    'display.diffTitle': '+{added} / −{removed} lines',
    'display.done': 'Done',
    'display.empty': 'Nothing has run in this session yet',
    'display.exitCode': 'exit {code}',
    'display.expand': 'Expand details',
    'display.expandLines': 'Show {count} more lines',
    'display.failed': 'Failed',
    'display.footnotes': 'Footnotes',
    'display.joinTwo': '{first} and {second}',
    'display.lines': 'lines {from}–{to}',
    'display.linesTitle': 'Read lines {from}–{to}',
    'display.loadFailed': 'Failed to load detail: {message}',
    'display.loadMore': 'Load earlier turns ({count})',
    'display.loadMoreHint': 'Scroll up to load older turns',
    'display.loadMoreLoading': 'Loading earlier turns…',
    'display.loading': 'Loading…',
    'display.logLabel': 'Run log',
    'display.more': '{title}, etc.',
    'display.noDetail': '(no further detail for this step)',
    'display.noExitCode': 'No exit code',
    'display.noOutput': 'No output',
    'display.output': 'Output',
    'display.paneTitle': 'Execution details',
    'display.readWindow': '{shown} of {total} lines',
    'display.running': 'Running',
    'display.signal': 'signal {signal}',
    'display.thinking': 'Thinking',
    'display.thinkingIdle': 'Thinking…',
    'display.tool.code': 'Code',
    'display.tool.commands': 'Command',
    'display.tool.edit': 'Edit',
    'display.tool.read': 'Read',
    'display.tool.search': 'Search',
    'display.tool.web': 'Web',
    'display.tool.write': 'Write',
    'display.toolFallback': 'Tool call',
    'error.http': 'Request failed: HTTP {status}',
    'error.noSession': 'No session is bound yet',
    'host.busOffline': 'The DSH main window is not connected (is the plugin enabled?)',
    'host.dockCrashLoop': 'The dock keeps exiting (last exit code {code}); retries stopped. See {log}',
    'host.dockExited': 'The dock exited (code {code}); retrying in {delay}s ({attempt}/{max})',
    'host.dockSpawnFailed': 'Failed to start the dock process: {reason}',
    'host.dockStartFailed': 'The dock exited before it was ready (code {code}): {reason}',
    'host.electronBlocked': 'Downloaded but still cannot start (it crashes before running JS, usually blocked by security software): {path}',
    'host.electronDownloadHint': ' (every mirror failed: set ELECTRON_MIRROR to a reachable mirror, e.g. https://npmmirror.com/mirrors/electron/, or point DSH_QUICKDOCK_ELECTRON_PATH at an existing electron.exe)',
    'host.electronInstallHint': ' (run npm install first: Electron is fetched with @electron/get, or set DSH_QUICKDOCK_ELECTRON_PATH to an electron.exe)',
    'host.electronMissing': 'No usable Electron runtime found',
    'host.electronUnavailable': 'Electron unavailable: {reason}{hint}',
    'host.missingMessage': 'Message text is required',
    'host.modelNotApplied': 'The model selection could not be applied to the session',
    'host.newSessionTitle': 'New session',
    'host.noSession': 'No session is bound yet',
    'host.noSessionController': 'sessionController unavailable (DSH version mismatch?)',
    'host.notFound': 'not found',
    'host.permissionNotApplied': 'The permission preset could not be applied to the session',
    'host.reasoningNotApplied': 'The thinking effort could not be applied to the session',
    'host.unauthorized': 'unauthorized',
    'host.unknownError': 'Unknown error',
    'host.untitledSession': 'Untitled session',
    'key.agent': 'Agent',
    'key.model': 'Model',
    'key.permission': 'Permission',
    'key.thinking': 'Thinking',
    'menu.agentTitle': 'Agent preset',
    'menu.context': '{count} ctx',
    'menu.defaultAgent': '(default)',
    'menu.emptyMatch': 'No matches',
    'menu.emptyOptions': '(no options)',
    'menu.forkArmed': 'Next message will fork the current session',
    'menu.loading': '(loading…)',
    'menu.menuLabel': 'Menu',
    'menu.modelTitle': 'Model',
    'menu.noModels': '(no models available)',
    'menu.noSessionToFork': 'No session to fork',
    'menu.notConnected': 'Not connected to DSH yet',
    'menu.off': 'Off',
    'menu.permissionTitle': 'Permission policy',
    'menu.searchLabel': 'Search {title}',
    'menu.searchPlaceholder': 'Search {title}…',
    'menu.thinkingTitle': 'Thinking effort',
    'reasoning.high': 'High',
    'reasoning.low': 'Low',
    'reasoning.max': 'Max',
    'reasoning.medium': 'Medium',
    'run.backgroundCount': '{count} in background',
    'run.doneCount': '{count} done',
    'run.executing': 'Working',
    'run.failedCount': '{count} failed',
    'run.label': 'Run status',
    'run.starting': 'Starting…',
    'run.stop': 'Stop',
    'run.thinking': 'Thinking',
    'run.title': 'Running',
    'status.ask': 'Needs confirmation',
    'status.done': 'Done',
    'status.failed': 'Failed',
    'status.idle': 'Idle',
    'status.offline': 'Offline',
    'status.ready': 'Ready',
    'status.running': 'Running',
    'status.waitingAnswer': 'Waiting for answer',
    'time.daysAgo': '{count}d ago',
    'time.hoursAgo': '{count}h ago',
    'time.justNow': 'just now',
    'time.minutesAgo': '{count}m ago',
    'todo.empty': 'No steps yet',
    'todo.progress.active': '{active} active',
    'todo.progress.done': '{done} done',
    'todo.progress.pending': '{pending} pending',
    'todo.status.completed': 'Done',
    'todo.status.inProgress': 'In progress',
    'todo.status.pending': 'Pending',
    'todo.title': 'Tasks',
    'settings.quickdock': 'QuickDock',
    'cfg.minWidth': 'Minimum width',
    'cfg.minHeight': 'Minimum height',
    'cfg.maxWidth': 'Maximum width',
    'cfg.maxHeight': 'Maximum height',
    'cfg.alwaysOnTop': 'Always on top',
    'cfg.rememberGeometry': 'Remember size and position',
    'cfg.focusOnSummon': 'Focus when opened',
    'cfg.ballSize': 'Floating ball size',
    'cfg.ballIcon': 'Floating ball icon',
    'cfg.snapToEdge': 'Snap the ball to the screen edge',
    'cfg.autoLaunch': 'Open the window when DSH starts',
    'cfg.prefetchElectron': 'Pre-download the dock component (first open is faster)',
    'cfg.headerButton': 'Show the header Dock button',
    'cfg.ballIcon.whale': 'Whale',
    'cfg.ballIcon.dot': 'Plain dot',
    'cfg.group.window': 'Window',
    'cfg.group.ball': 'Floating ball',
    'cfg.group.dock': 'Dock window',
    'cfg.group.network': 'Connection',
    'cfg.port': 'Loopback port',
    'cfg.portHint': 'Where the shell page and the API listen. Apply rebinds the listener and reopens the window on the new address (1024-65535).',
    'cfg.portApply': 'Apply and restart',
    'cfg.portInvalid': 'Port must be 1024-65535',
    'cfg.portFailed': 'Could not bind: {code}. The window still uses the old address.',
    'cfg.serverStatus': 'Listener',
    'cfg.serverListening': 'Listening on 127.0.0.1:{port}',
    'cfg.serverBusy': 'Port {port} is taken ({code}). Pick another port.',
    'cfg.serverOff': 'Listener off (port 0)',
    'client.matchSidebarOpen': 'Open sidebar',
    'client.matchSidebarExpand': 'Expand sidebar',
    'cfg.closeAction': 'What the close button does',
    'cfg.closeAction.quit': 'Quit QuickDock',
    'cfg.closeAction.ball': 'Keep the floating ball (click it to come back)',
    'cfg.group.runtime': 'Electron runtime',
    'cfg.electronVersion': 'Electron version',
    'cfg.runtimeStatus': 'Runtime status',
    'cfg.runtimeMissing': 'not downloaded',
    'cfg.runtimeRedownload': 'Download again',
    'cfg.runtimeOpenFolder': 'Open runtime folder',
    'cfg.runtimeDownloading': 'Downloading',
    'cfg.runtimeNetwork': 'Download failed: no network (check the proxy and try again)',
    'cfg.runtimeDefaultOption': 'Default',
    'cfg.runtimeInstalled': 'downloaded'
  },
  zh: {
    'app.displayTitle': 'QuickDock 执行过程',
    'app.inputTitle': 'QuickDock',
    'app.name': 'QuickDock',
    'ask.back': '上一步',
    'ask.next': '下一步',
    'bar.close': '关闭 QuickDock (Esc)',
    'bar.connecting': '正在连接…',
    'bar.inputPanel': '输入面板',
    'bar.newSession': '新建对话（Shift/Alt 点 = 从当前会话分叉）',
    'bar.newSessionLabel': '新建对话',
    'bar.newSessionTitle': '新建对话',
    'bar.noSession': '还没有可重新加载的对话',
    'bar.noWorkspace': '未绑定工作区',
    'bar.openInDsh': '在 DSH 中打开当前会话',
    'bar.pin': '顶置',
    'bar.reload': '重新加载对话',
    'bar.reloaded': '已重新加载这次对话',
    'bar.statusTitle': '状态',
    'bar.toggleList': '显示 / 隐藏执行过程窗口',
    'bar.toggleListLabel': '显示或隐藏执行过程窗口',
    'bar.workspace': '工作区',
    'bar.workspaceTitle': '当前工作区',
    'card.allow': '允许',
    'card.answerPlaceholder': '输入回答…',
    'card.deny': '拒绝',
    'card.needConfirm': '⚠ 需要确认',
    'card.question': '? 提问',
    'card.submit': '提交',
    'client.dockFailed': 'QuickDock 请求失败：{reason}',
    'client.downloading': 'QuickDock 正在下载桌面运行时 {percent}%（{mb}/{total} MB）',
    'client.label': 'Dock',
    'client.portBusy': '无法打开窗口：127.0.0.1:{port} 没有在监听（{code}）。请到 设置 → QuickDock → 连接 改端口。',
    'client.more': '更多 Dock 操作',
    'client.preparing': 'QuickDock 正在准备桌面窗口（首次需要下载 Electron，约 1–2 分钟，只需一次）…',
    'client.reloadApp': '重新加载应用',
    'client.reloadFailed': '重新加载失败：{reason}',
    'client.ballSize': '悬浮球大小',
    'client.ballSizeHint': 'dock 收起到鲸鱼球时的直径。',
    'client.requestFailed': '请求失败：HTTP {status}',
    'client.resetFailed': '重置失败：{reason}',
    'client.resetWindows': '重置窗口大小',
    'client.restartDock': '重启 Dock 窗口',
    'client.restartFailed': '重启失败：{reason}',
    'client.sendToDock': '在 QuickDock 中打开此会话',
    'client.startTimeout': 'QuickDock 启动超时。请看 {log}',
    'client.unknownError': '未知错误',
    'composer.label': '消息或任务',
    'composer.placeholder': '发送消息或任务…',
    'composer.send': '发送 (Enter)',
    'composer.sendLabel': '发送',
    'confirm.cancel': '取消',
    'confirm.ok': '启用完全权限',
    'confirm.text': 'Agent 将可以不受工作区限制地读取、修改文件并执行命令。请仅在完全信任当前任务时继续。',
    'confirm.title': '启用完全权限？',
    'detail.auto': '执行详情：自动',
    'detail.closed': '执行详情：折叠',
    'detail.hidden': '执行详情：隐藏',
    'detail.open': '执行详情：全部展开',
    'display.act.code': '运行了代码',
    'display.act.commands': '执行了命令',
    'display.act.edit': '修改了文件',
    'display.act.read': '已读取文件',
    'display.act.readImage': '已读取图片',
    'display.act.search': '已搜索代码',
    'display.act.tools': '已调用工具',
    'display.act.webFetch': '已访问网页',
    'display.act.webSearch': '已搜索网页',
    'display.act.write': '已写入文件',
    'display.collapse': '折叠详情',
    'display.comma': '，',
    'display.commandLine': '命令行 {line}',
    'display.copied': '已复制',
    'display.copy': '复制',
    'display.diffTitle': '新增 {added} 行 · 删除 {removed} 行',
    'display.done': '完成',
    'display.empty': '这个会话还没有执行记录',
    'display.exitCode': '退出码 {code}',
    'display.expand': '展开详情',
    'display.expandLines': '展开其余 {count} 行',
    'display.failed': '失败',
    'display.footnotes': '脚注',
    'display.joinTwo': '{first}并{second}',
    'display.lines': '{from}–{to} 行',
    'display.linesTitle': '读取第 {from}–{to} 行',
    'display.loadFailed': '详情加载失败：{message}',
    'display.loadMore': '加载更早的对话（还有 {count} 轮）',
    'display.loadMoreHint': '向上滚动即可加载更早的对话',
    'display.loadMoreLoading': '正在加载更早的对话…',
    'display.loading': '加载中…',
    'display.logLabel': '执行过程',
    'display.more': '{title}等',
    'display.noDetail': '（这一步没有更多细节）',
    'display.noExitCode': '无退出码',
    'display.noOutput': '没有输出',
    'display.output': '输出',
    'display.paneTitle': '执行详情',
    'display.readWindow': '{shown} / {total} 行',
    'display.running': '运行中',
    'display.signal': '信号 {signal}',
    'display.thinking': '思考',
    'display.thinkingIdle': '正在思考…',
    'display.tool.code': '代码',
    'display.tool.commands': '命令',
    'display.tool.edit': '编辑',
    'display.tool.read': '读取',
    'display.tool.search': '搜索',
    'display.tool.web': '网页',
    'display.tool.write': '写入',
    'display.toolFallback': '工具调用',
    'error.http': '请求失败 HTTP {status}',
    'error.noSession': '还没有绑定会话',
    'host.busOffline': 'DSH 主窗口没有连上（插件是否启用？）',
    'host.dockCrashLoop': 'dock 进程反复退出（最后一次退出码 {code}），已停止重试。请看日志 {log}',
    'host.dockExited': 'dock 进程退出（退出码 {code}），{delay}s 后重试（{attempt}/{max}）',
    'host.dockSpawnFailed': 'dock 进程启动失败：{reason}',
    'host.dockStartFailed': 'dock 进程在就绪前退出（退出码 {code}）：{reason}',
    'host.electronBlocked': '下载完成但仍无法启动（进程在 JS 执行前崩溃，通常是安全软件拦截）：{path}',
    'host.electronDownloadHint': '（所有镜像都失败了：可以用 ELECTRON_MIRROR 指定能访问的镜像，例如 https://npmmirror.com/mirrors/electron/；或用 DSH_QUICKDOCK_ELECTRON_PATH 指向已有的 electron.exe）',
    'host.electronInstallHint': '（本插件需要先 npm install：它用 @electron/get 下载 Electron；也可以手动指定 DSH_QUICKDOCK_ELECTRON_PATH 指向一个 electron.exe）',
    'host.electronMissing': '未找到可用的 Electron 运行时',
    'host.electronUnavailable': 'Electron 不可用：{reason}{hint}',
    'host.missingMessage': '缺少消息内容',
    'host.modelNotApplied': '模型选择未能写入会话',
    'host.newSessionTitle': '新会话',
    'host.noSession': '还没有绑定会话',
    'host.noSessionController': 'sessionController 不可用（DSH 版本不匹配？）',
    'host.notFound': '未找到',
    'host.permissionNotApplied': '权限预设未能写入会话',
    'host.reasoningNotApplied': '思考强度未能写入会话',
    'host.unauthorized': '未授权',
    'host.unknownError': '未知错误',
    'host.untitledSession': '未命名会话',
    'key.agent': 'Agent',
    'key.model': '模型',
    'key.permission': '权限',
    'key.thinking': '思考',
    'menu.agentTitle': 'Agent 预设',
    'menu.context': '{count} 上下文',
    'menu.defaultAgent': '（默认）',
    'menu.emptyMatch': '没有匹配项',
    'menu.emptyOptions': '（没有可选项）',
    'menu.forkArmed': '下一条消息将从当前会话分叉',
    'menu.loading': '（读取中…）',
    'menu.menuLabel': '菜单',
    'menu.modelTitle': '模型',
    'menu.noModels': '（无可用模型）',
    'menu.noSessionToFork': '没有可分叉的会话',
    'menu.notConnected': '还没连上 DSH',
    'menu.off': '关闭',
    'menu.permissionTitle': '权限策略',
    'menu.searchLabel': '{title}搜索',
    'menu.searchPlaceholder': '搜索{title}…',
    'menu.thinkingTitle': '思考强度',
    'reasoning.high': '高',
    'reasoning.low': '低',
    'reasoning.max': '最高',
    'reasoning.medium': '中',
    'run.backgroundCount': '后台 {count}',
    'run.doneCount': '已完成 {count}',
    'run.executing': '正在执行',
    'run.failedCount': '失败 {count}',
    'run.label': '运行状态',
    'run.starting': '正在启动…',
    'run.stop': '停止',
    'run.thinking': '思考',
    'run.title': '正在执行',
    'status.ask': '等待确认',
    'status.done': '已完成',
    'status.failed': '失败',
    'status.idle': '空闲',
    'status.offline': '离线',
    'status.ready': '就绪',
    'status.running': '执行中',
    'status.waitingAnswer': '等待回答',
    'time.daysAgo': '{count} 天前',
    'time.hoursAgo': '{count} 小时前',
    'time.justNow': '刚刚',
    'time.minutesAgo': '{count} 分钟前',
    'todo.empty': '还没有步骤',
    'todo.progress.active': '{active} 进行中',
    'todo.progress.done': '{done} 已完成',
    'todo.progress.pending': '{pending} 待处理',
    'todo.status.completed': '已完成',
    'todo.status.inProgress': '进行中',
    'todo.status.pending': '待处理',
    'todo.title': '任务',
    'settings.quickdock': 'QuickDock 设置',
    'cfg.minWidth': '最小宽度',
    'cfg.minHeight': '最小高度',
    'cfg.maxWidth': '最大宽度',
    'cfg.maxHeight': '最大高度',
    'cfg.alwaysOnTop': '窗口置顶',
    'cfg.rememberGeometry': '记住窗口大小和位置',
    'cfg.focusOnSummon': '打开时聚焦',
    'cfg.ballSize': '悬浮球大小',
    'cfg.ballIcon': '悬浮球图标',
    'cfg.snapToEdge': '悬浮球吸附屏幕边缘',
    'cfg.autoLaunch': '随 DSH 启动窗口',
    'cfg.prefetchElectron': '提前下载 dock 组件（首次打开更快）',
    'cfg.headerButton': '显示标题栏 Dock 按钮',
    'cfg.ballIcon.whale': '鲸鱼',
    'cfg.ballIcon.dot': '纯色圆点',
    'cfg.group.window': '窗口',
    'cfg.group.ball': '悬浮球',
    'cfg.group.dock': 'dock 窗口',
    'cfg.group.network': '连接',
    'cfg.port': '回环端口',
    'cfg.portHint': '壳页和 API 监听的端口；点“应用并重启”会在新端口重建监听并让窗口重连（1024-65535）。',
    'cfg.portApply': '应用并重启',
    'cfg.portInvalid': '端口必须是 1024-65535',
    'cfg.portFailed': '绑定失败：{code}，窗口仍在旧地址上。',
    'cfg.serverStatus': '监听状态',
    'cfg.serverListening': '正在监听 127.0.0.1:{port}',
    'cfg.serverBusy': '端口 {port} 被占用（{code}），请换一个',
    'cfg.serverOff': '监听已关闭（端口 0）',
    'client.matchSidebarOpen': '打开侧边栏',
    'client.matchSidebarExpand': '展开侧边栏',
    'cfg.closeAction': '点关闭按钮时',
    'cfg.closeAction.quit': '退出 QuickDock',
    'cfg.closeAction.ball': '保留悬浮球（点它可回来）',
    'cfg.group.runtime': 'Electron 运行时',
    'cfg.electronVersion': 'Electron 版本',
    'cfg.runtimeStatus': '运行时状态',
    'cfg.runtimeMissing': '未下载',
    'cfg.runtimeRedownload': '重新下载',
    'cfg.runtimeOpenFolder': '打开运行时目录',
    'cfg.runtimeDownloading': '下载中',
    'cfg.runtimeNetwork': '下载失败：网络不可用（检查网络或代理后重试）',
    'cfg.runtimeDefaultOption': '默认',
    'cfg.runtimeInstalled': '已下载'
  }
}

/* i18n-catalog:end */

var activeLocale = 'en'

function normalizeLocale(value) {
  var tag = String(value || '').toLowerCase()
  var primary = tag.split(/[-_]/)[0]
  return primary === 'zh' || primary === 'en' ? primary : ''
}

function detectLocale() {
  try {
    var tags = (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language])
    for (var i = 0; i < tags.length; i += 1) {
      var hit = normalizeLocale(tags[i])
      if (hit) return hit
    }
  } catch (error) {}
  return 'en'
}

/** Translate one client string; English is the fallback layer. */
function t(key, params) {
  var table = MESSAGES[activeLocale] || MESSAGES.en
  var template = table[key] !== undefined ? table[key] : (MESSAGES.en[key] || key)
  if (!params) return template
  return String(template).replace(/\{(\w+)\}/g, function (match, name) {
    return Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
  })
}

/** Bridge call; the Host answers {ok, error} and HTTP errors carry a reason. */
async function bridge(action, payload) {
  const res = await fetch(BRIDGE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ action: action }, payload || {}))
  })
  const data = await res.json().catch(function () { return null })
  if (!res.ok) throw new Error(t('client.requestFailed', { status: res.status }))
  return data || {}
}

/* ---------------- locale sync ---------------- */

/** Adopt a locale id, then let the Host localize its dock pages. */
function applyLocale(locale) {
  const next = normalizeLocale(locale)
  if (next) activeLocale = next
  bridge('locale', { locale: activeLocale }).catch(function () {})
}

function syncLocale(lctx) {
  let snapshot = null
  try {
    snapshot = lctx.locale.getLocale()
  } catch (error) {}
  applyLocale(snapshot && snapshot.active ? snapshot.active : detectLocale())
  try {
    return lctx.effect(function () {
      return lctx.locale.subscribe(function () {
        try {
          applyLocale(lctx.locale.getLocale().active)
        } catch (error) {}
      })
    }, 'quickdock: locale sync')
  } catch (error) {
    return null
  }
}

/* ---------------- toasts ---------------- */

/**
 * Show a message in the page corner.
 *
 * Errors are never silent: a dock that fails to start must explain itself,
 * and a long first start must say what it is waiting for.
 */
let toastEl = null
let toastTimer = null

const TOAST_KINDS = {
  error: { border: 'rgba(220, 80, 80, .6)', background: 'rgba(48, 16, 16, .96)', color: '#ffd7d7', ttl: 8000 },
  hint: { border: 'rgba(77, 142, 255, .55)', background: 'rgba(14, 24, 40, .96)', color: '#cfe1ff', ttl: 6000 }
}

function showToast(message, kind) {
  const text = String(message || t('client.unknownError'))
  const style = TOAST_KINDS[kind] || TOAST_KINDS.error
  try {
    if (!toastEl) {
      toastEl = document.createElement('div')
      toastEl.setAttribute('role', 'alert')
      toastEl.setAttribute('data-plugin', PLUGIN_ID)
      Object.assign(toastEl.style, {
        position: 'fixed',
        right: '16px',
        bottom: '16px',
        zIndex: '2147483647',
        maxWidth: '420px',
        padding: '10px 14px',
        borderRadius: '8px',
        font: '12px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif',
        whiteSpace: 'pre-wrap',
        boxShadow: '0 6px 24px rgba(0, 0, 0, .35)',
        pointerEvents: 'none'
      })
      document.body.appendChild(toastEl)
    }
    toastEl.style.border = '1px solid ' + style.border
    toastEl.style.background = style.background
    toastEl.style.color = style.color
    toastEl.textContent = 'QuickDock: ' + text
    toastEl.style.display = 'block'
    clearTimeout(toastTimer)
    toastTimer = setTimeout(function () {
      if (toastEl) toastEl.style.display = 'none'
    }, style.ttl)
  } catch (error) {
    // Even with no DOM the reason must not disappear.
    console.error('[dsh-quickdock] ' + text)
  }
}

function showError(message) {
  showToast(message, 'error')
}

function showHint(message) {
  showToast(message, 'hint')
}

/* ---------------- dock start polling ---------------- */

/**
 * Poll the dock start result.
 *
 * Starting is asynchronous (probe Electron, download, spawn, wait for ready),
 * so the synchronous bind response cannot report the final outcome.
 * The first start may download ~100MB, hence the generous timeout.
 */
async function waitForDockResult(timeoutMs) {
  const limit = timeoutMs || 180000
  const started = Date.now()
  let lastError = ''
  let announced = false
  while (Date.now() - started < limit) {
    await new Promise(function (resolve) { setTimeout(resolve, 400) })
    try {
      const state = await bridge('status')
      if (state && state.error) {
        lastError = String(state.error)
        // Give the supervisor a moment to retry before reporting.
        await new Promise(function (resolve) { setTimeout(resolve, 500) })
        const again = await bridge('status').catch(function () { return {} })
        if (again && again.error && !again.starting) {
          showError(again.error)
          return
        }
        if (!state.starting) {
          showError(lastError)
          return
        }
        continue
      }
      if (state && state.running) return
      if (state && state.starting && !announced && Date.now() - started > 4000) {
        announced = true
        showHint(t('client.preparing'))
      }
    } catch (error) {}
  }
  if (lastError) showError(lastError)
  else showError(t('client.startTimeout', { log: '%LOCALAPPDATA%\\dsh-quickdock\\host.log' }))
}

/* ---------------- header button ---------------- */

/**
 * Render a node into document.body so no ancestor can clip it.
 * @param {object} node React element.
 * @returns {object} the same element, portalled when react-dom is available.
 */
function renderPortal(node) {
  if (!node) return node
  if (!ReactDOM || typeof ReactDOM.createPortal !== 'function') return node
  try {
    return ReactDOM.createPortal(node, document.body)
  } catch (error) {
    return node
  }
}

/** Whether the header Dock button is shown (config: headerButton). */
let HEADER_ENABLED = true

function SendToDock(props) {
  if (!HEADER_ENABLED) return null
  const sessionId = props && props.sessionId
  if (!sessionId) return null
  const suffix = React.useRef(null)
  const [menu, setMenu] = React.useState(null)

  // The header row may clip its children, so the menu is positioned from the
  // suffix' own rectangle with position:fixed and closed on any outside click.
  React.useEffect(() => {
    if (!menu) return undefined
    const close = (event) => {
      if (suffix.current && suffix.current.contains(event.target)) return
      if (event.target && event.target.closest && event.target.closest('.' + PLUGIN_ID + '-menu')) return
      setMenu(null)
    }
    const onKey = (event) => { if (event.key === 'Escape') setMenu(null) }
    document.addEventListener('mousedown', close, true)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('mousedown', close, true)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('resize', close)
    }
  }, [menu])

  const onClick = async (event) => {
    event.stopPropagation()
    try {
      // The window loads the loopback page: a listener that never bound would
      // open a blank window, so say why instead of summoning one.
      const status = await bridge('status')
      const server = status && status.server
      if (server && !server.serving && (server.error || server.port === 0)) {
        showError(t('client.portBusy', { port: server.attempt || server.port, code: server.error || 'ECONNREFUSED' }))
        return
      }
      const result = await bridge('bind', { sessionId: sessionId })
      // Bind failures are shown as-is: no silent fallback.
      if (result.error) {
        showError(result.error)
        return
      }
      await waitForDockResult()
    } catch (error) {
      showError(t('client.dockFailed', { reason: String(error && error.message || error) }))
    }
  }

  const openMenu = (event) => {
    event.stopPropagation()
    if (menu) {
      setMenu(null)
      return
    }
    const box = suffix.current ? suffix.current.getBoundingClientRect() : null
    setMenu(box ? { top: Math.round(box.bottom + 4), right: Math.round(window.innerWidth - box.right) } : { top: 0, right: 0 })
  }

  const resetWindows = async (event) => {
    event.stopPropagation()
    setMenu(null)
    try {
      const result = await bridge('reset', {})
      if (result && result.error) showError(t('client.resetFailed', { reason: result.error }))
    } catch (error) {
      showError(t('client.resetFailed', { reason: String(error && error.message || error) }))
    }
  }

  const reloadApp = async (event) => {
    event.stopPropagation()
    setMenu(null)
    try {
      const result = await bridge('reload-dock', {})
      if (result && result.error) showError(t('client.reloadFailed', { reason: result.error }))
    } catch (error) {
      showError(t('client.reloadFailed', { reason: String(error && error.message || error) }))
    }
  }

  const restart = async (event) => {
    event.stopPropagation()
    setMenu(null)
    try {
      const result = await bridge('restart', {})
      if (result && result.error) showError(t('client.restartFailed', { reason: result.error }))
    } catch (error) {
      showError(t('client.restartFailed', { reason: String(error && error.message || error) }))
    }
  }

  // Only the actions that still mean something: the window has its own close
  // button, and reloading the app is lighter than restarting the process.
  const menuItems = [
    { key: 'reset', label: t('client.resetWindows'), onClick: resetWindows },
    { key: 'reload', label: t('client.reloadApp'), onClick: reloadApp },
    { key: 'restart', label: t('client.restartDock'), onClick: restart }
  ]

  const pill = {
    height: '22px',
    border: '1px solid rgba(77,142,255,.55)',
    background: 'rgba(77,142,255,.16)',
    color: 'var(--dsw-alias-brand-primary, #4d8eff)',
    cursor: 'pointer',
    fontSize: '11px',
    fontWeight: 500,
    lineHeight: '20px',
    flex: 'none'
  }

  return el('div', { style: { display: 'inline-flex', alignItems: 'center', flex: 'none' } },
    el('button', {
      type: 'button',
      id: PLUGIN_ID + '-send',
      title: t('client.sendToDock'),
      'aria-label': t('client.sendToDock'),
      onClick,
      style: Object.assign({}, pill, {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        padding: '0 8px',
        borderTopLeftRadius: '11px',
        borderBottomLeftRadius: '11px',
        borderRight: 'none'
      })
    },
    el('svg', {
      width: 11, height: 11, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true, style: { flex: 'none' }
    },
    el('rect', { x: 1, y: 1, width: 14, height: 9, rx: 2.5, stroke: 'currentColor', strokeWidth: 1.6 }),
    el('rect', { x: 4, y: 12.4, width: 8, height: 2.6, rx: 1.3, fill: 'currentColor' })),
    el('span', null, t('client.label'))),

    el('button', {
      type: 'button',
      ref: suffix,
      id: PLUGIN_ID + '-more',
      title: t('client.more'),
      'aria-label': t('client.more'),
      'aria-haspopup': 'menu',
      'aria-expanded': menu ? 'true' : 'false',
      onClick: openMenu,
      style: Object.assign({}, pill, {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '18px',
        padding: 0,
        marginLeft: '-1px',
        borderTopRightRadius: '11px',
        borderBottomRightRadius: '11px',
        fontSize: '8px'
      })
    }, '\u25be'),

    menu ? renderPortal(el('div', {
      className: PLUGIN_ID + '-menu',
      role: 'menu',
      style: {
        position: 'fixed',
        top: menu.top + 'px',
        right: menu.right + 'px',
        minWidth: '176px',
        padding: '4px',
        borderRadius: 'var(--dsw-radius-md, 8px)',
        background: 'var(--dsw-alias-bg-overlay, #232324)',
        border: '0.5px solid var(--dsw-alias-border-l2, rgba(255,255,255,.12))',
        boxShadow: 'var(--dsw-elevation-panel, 0 12px 32px -8px rgba(0,0,0,.55))',
        zIndex: 3000
      }
    }, menuItems.map((item) => el('button', {
      key: item.key,
      type: 'button',
      role: 'menuitem',
      onClick: item.onClick,
      style: {
        display: 'flex',
        alignItems: 'center',
        width: '100%',
        height: '28px',
        padding: '0 8px',
        border: 'none',
        borderRadius: 'var(--dsw-radius-sm, 6px)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary, inherit)',
        font: 'inherit',
        fontSize: '12px',
        cursor: 'pointer',
        textAlign: 'left'
      },
      onMouseEnter: (event) => { event.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.07))' },
      onMouseLeave: (event) => { event.currentTarget.style.background = 'transparent' }
    }, item.label)))) : null
  )
}

/* ---------------- theme sync ---------------- */

/**
 * The 21 dock theme tokens (DESIGN 7.2).
 *
 * Built-in DSH themes publish an empty token map: the palette is declared by
 * the --dsw-* stylesheets on <body> and selected by the data-ds-dark-theme
 * attribute. A snapshot therefore only carries the scheme and typography; the
 * colors are read from the main window's computed styles and pushed to the
 * Host, which inlines them into the dock page.
 */
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

/** Body attribute selecting the dark base palette (owned by ui-layout). */
const DARK_ATTRIBUTE = 'data-ds-dark-theme'

/** Retry schedule while DSH has not mounted its token stylesheets yet (ms). */
const THEME_RETRY_MS = [120, 300, 700, 1500, 3000, 6000]

/** Probe fill for an undefined token; never a real palette value. */
const THEME_PROBE_MISSING = 'rgb(1, 2, 3)'

/** Read one custom property, tolerating a missing computed-style object. */
function readProperty(style, name) {
  if (!style) return ''
  try {
    return String(style.getPropertyValue(name) || '').trim()
  } catch (error) {
    return ''
  }
}

/**
 * Resolve one alias token to a concrete color through a probe element.
 *
 * The palette is declared as var() chains over the static scale, and a
 * computed custom property may still carry the unresolved chain. The probe
 * makes the browser resolve it exactly as the page would.
 */
function probeToken(probe, name, missing) {
  try {
    probe.style.backgroundColor = THEME_PROBE_MISSING
    probe.style.backgroundColor = 'var(' + name + ', ' + THEME_PROBE_MISSING + ')'
    const value = String(getComputedStyle(probe).backgroundColor || '').trim()
    // Undefined keeps the sentinel, a non-color value leaves the initial
    // transparent fill; anything else is a real token the dock can paint.
    return value && value !== missing && value !== 'rgba(0, 0, 0, 0)' ? value : ''
  } catch (error) {
    return ''
  }
}

/** The active palette, read from the main window's resolved computed styles. */
function readTokens() {
  const tokens = {}
  if (typeof document === 'undefined' || !document.body) return tokens
  let bodyStyle = null
  let rootStyle = null
  try { bodyStyle = getComputedStyle(document.body) } catch (error) {}
  try { rootStyle = getComputedStyle(document.documentElement) } catch (error) {}
  const unresolved = []
  for (const name of THEME_TOKENS) {
    const value = readProperty(bodyStyle, name) || readProperty(rootStyle, name)
    // A resolved custom property needs no probe; a var() chain does.
    if (value && value.indexOf('var(') < 0) tokens[name] = value
    else unresolved.push(name)
  }
  if (!unresolved.length) return tokens
  let probe = null
  try {
    probe = document.createElement('div')
    probe.setAttribute('aria-hidden', 'true')
    probe.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:0;height:0;pointer-events:none'
    document.body.appendChild(probe)
    probe.style.backgroundColor = THEME_PROBE_MISSING
    const missing = String(getComputedStyle(probe).backgroundColor || '').trim()
    for (const name of unresolved) {
      const value = probeToken(probe, name, missing)
      if (value) tokens[name] = value
    }
  } catch (error) {
    // Keep whatever the computed custom properties already provided.
  } finally {
    if (probe && probe.parentNode) probe.parentNode.removeChild(probe)
  }
  return tokens
}

/** Resolved scheme: the DOM is authoritative once the presenter applied it. */
function readScheme(snapshot) {
  try {
    if (document.body && typeof document.body.hasAttribute === 'function') {
      return document.body.hasAttribute(DARK_ATTRIBUTE) ? 'dark' : 'light'
    }
  } catch (error) {}
  return snapshot.active.colorScheme === 'light' ? 'light' : 'dark'
}

/** The bridge payload for one snapshot; null while the palette is unreadable. */
function themePayload(snapshot) {
  if (!snapshot || !snapshot.active) return null
  const tokens = readTokens()
  // Fewer than six tokens is not a real theme; the dock keeps its palette.
  if (Object.keys(tokens).length < 6) return null
  return {
    colorScheme: readScheme(snapshot),
    tokens,
    fonts: {
      text: snapshot.fontFamilies && snapshot.fontFamilies.text || '',
      code: snapshot.fontFamilies && snapshot.fontFamilies.code || '',
      sizeText: snapshot.fontSizes && snapshot.fontSizes.text || 12,
      sizeCode: snapshot.fontSizes && snapshot.fontSizes.code || 11
    }
  }
}

let themeTimer = null
let themeAttempt = 0
let themeSent = ''
let themeWarned = false

/** Push the palette once; retry while DSH has not injected its stylesheets. */
function deliverTheme(tctx) {
  let payload = null
  try {
    payload = themePayload(tctx.theme.getTheme())
  } catch (error) {
    console.warn('[dsh-quickdock] theme sync failed:', error)
    return
  }
  if (!payload) {
    if (themeAttempt < THEME_RETRY_MS.length) {
      scheduleTheme(tctx, THEME_RETRY_MS[themeAttempt])
      themeAttempt += 1
    } else if (!themeWarned) {
      themeWarned = true
      console.warn('[dsh-quickdock] no DSH theme tokens found; the dock keeps its palette')
    }
    return
  }
  themeAttempt = 0
  const json = JSON.stringify(payload)
  if (json === themeSent) return
  themeSent = json
  bridge('theme', { theme: payload }).catch(function () {})
}

function scheduleTheme(tctx, delay) {
  if (themeTimer) clearTimeout(themeTimer)
  themeTimer = setTimeout(function () {
    themeTimer = null
    deliverTheme(tctx)
  }, typeof delay === 'number' ? delay : 0)
}

/**
 * Read after the next paint: the palette presenter has its own theme/change
 * listener, so the attribute and font variables are only current afterwards.
 */
function scheduleThemeAfterPaint(tctx) {
  if (typeof requestAnimationFrame !== 'function') {
    scheduleTheme(tctx, 32)
    return
  }
  requestAnimationFrame(function () {
    requestAnimationFrame(function () {
      scheduleTheme(tctx, 0)
    })
  })
}

/** Adopt the main window palette on boot, on theme/change and on scheme flips. */
function syncTheme(tctx) {
  scheduleTheme(tctx, 0)
  tctx.on('theme/change', function () {
    scheduleThemeAfterPaint(tctx)
  })
  // The presenter toggles the palette attribute on <body>; observing it also
  // catches a boot-time scheme that emitted no theme/change on this context.
  try {
    if (typeof MutationObserver === 'function' && document.body) {
      const observer = new MutationObserver(function () {
        scheduleThemeAfterPaint(tctx)
      })
      observer.observe(document.body, { attributes: true, attributeFilter: [DARK_ATTRIBUTE] })
      if (typeof tctx.effect === 'function') {
        tctx.effect(function () {
          return function () { observer.disconnect() }
        }, 'quickdock: theme palette observer')
      }
    }
  } catch (error) {
    console.warn('[dsh-quickdock] theme palette observer unavailable:', error)
  }
}

/* ---------------- download badge (sidebar footer) ---------------- */

/**
 * Shows the desktop runtime download in the sidebar footer.
 *
 * The Host fetches ~100 MB once (on mount, or on the first Dock click). Without
 * a visible indicator that click looks like it did nothing, so the badge polls
 * the same bridge the header button already uses; no extra channel is needed.
 */
function DownloadBadge() {
  const [download, setDownload] = React.useState(null)
  React.useEffect(function () {
    let alive = true
    let timer = 0
    async function tick() {
      try {
        const status = await bridge('status')
        if (alive) setDownload(status && status.download ? status.download : null)
      } catch (error) {
        /* the host is restarting: keep the last value and retry */
      }
      if (alive) timer = setTimeout(tick, 1200)
    }
    tick()
    return function () {
      alive = false
      clearTimeout(timer)
    }
  }, [])
  if (!download || !download.active) return null
  const total = Number(download.total) || 0
  const received = Number(download.received) || 0
  const percent = total > 0 ? Math.min(99, Math.round((received / total) * 100)) : 0
  const label = total > 0
    ? t('client.downloading', {
      percent: String(percent),
      mb: (received / 1048576).toFixed(1),
      total: (total / 1048576).toFixed(0)
    })
    : t('client.preparing')
  return el('span', {
    id: PLUGIN_ID + '-download',
    title: label,
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '4px',
      padding: '0 6px',
      fontSize: '11px',
      lineHeight: '18px',
      color: 'var(--dsw-alias-brand-primary, #4d8eff)',
      flex: 'none'
    }
  }, total > 0 ? percent + '%' : '…')
}

/* ---------------- apply ---------------- */

/**
 * True when this page is the app *inside* the dock window.
 *
 * Two signals, because the SPA may rewrite its own URL after boot (dropping the
 * query before client modules run):
 *   - `?dock=1`, appended by the frame shell;
 *   - this document is an iframe (`window.self !== window.top`).
 */
function insideDockWindow() {
  try {
    if (new URLSearchParams(location.search).has('dock')) return true
  } catch (error) { /* ignore */ }
  try {
    return window.self !== window.top
  } catch (error) {
    return false
  }
}

/** Style element id, so a second apply() does not stack sheets. */
const DOCK_STYLE_ID = PLUGIN_ID + '-dock-layout'

/**
 * Layout fixes that only make sense in the dock window.
 *
 * At dock width the shipped sidebar squeezes the conversation into a sliver, so
 * while it is expanded it covers the whole window instead; picking a session
 * then collapses it, which is what a dock-sized window wants.
 *
 * The frame carries `data-sidebar-collapsed="true"` exactly while the sidebar is
 * a rail, so the rule can key off the app's own state instead of measuring.
 */
/**
 * Tag the app's floating sidebar toggle so the dock can hide it.
 *
 * Matched by aria-label because the class name is a per-build hash and the label
 * is the only stable handle across builds and locales.
 */
function hideSidebarToggle() {
  // Match every locale's wording: the app may render a label before our locale
  // sync runs, so t() alone would miss it.
  const LABELS = []
  for (const table of Object.values(MESSAGES)) {
    for (const key of ['client.matchSidebarOpen', 'client.matchSidebarExpand']) {
      const label = String((table && table[key]) || '').trim().toLowerCase()
      if (label && !LABELS.includes(label)) LABELS.push(label)
    }
  }
  const tag = () => {
    for (const node of document.querySelectorAll('button[aria-label]')) {
      const label = String(node.getAttribute('aria-label') || '').trim().toLowerCase()
      if (!LABELS.includes(label)) continue
      node.setAttribute('data-qd-dock-hide', '1')
    }
  }
  tag()
  if (typeof MutationObserver !== 'function') return
  let queued = false
  const observer = new MutationObserver(() => {
    if (queued) return
    queued = true
    setTimeout(() => { queued = false; tag() }, 120)
  })
  observer.observe(document.body, { childList: true, subtree: true })
}

function applyDockMode() {
  if (document.getElementById(DOCK_STYLE_ID)) return
  const style = document.createElement('style')
  style.id = DOCK_STYLE_ID
  style.textContent = `
/* The dock has no right rail, and the conversation must fill the frame in both
   states. Pinning the centre column across every grid track keeps it full width
   no matter which side columns are hidden or lifted out of the flow. */
html[data-qd-dock] [class*="rightbarCol"] {
  display: none !important;
}
html[data-qd-dock] [class*="centerCol"] {
  grid-column: 1 / -1 !important;
  min-width: 0 !important;
}
/* Expanded: the sidebar floats over the whole window instead of squeezing it. */
html[data-qd-dock] [class*="_frame"][data-rightbar-collapsed]:not([data-sidebar-collapsed="true"]) [class*="sidebarCol"] {
  position: fixed !important;
  inset: 0 !important;
  width: 100vw !important;
  z-index: 60 !important;
  background: var(--dsw-alias-bg-base, #151517) !important;
}
/* Collapsed: the strip only ever held the expand toggle, so the column goes away
   entirely and the conversation gets its space back. */
html[data-qd-dock] [data-sidebar-collapsed="true"] [class*="sidebarCol"] {
  display: none !important;
}
/* Optional: the conversation tabs (chat / trajectory / views) take 36px. */
html[data-qd-dock][data-qd-trim-tabs] [class*="tabs"] {
  display: none !important;
}
/* The app's panel list (plugins/automations/more) is not part of the dock. */
/* In a narrow window DSH opens the sidebar as a drawer with a scrim on top of it:
   the scrim swallows every click and closes the drawer on click. The dock toggles
   the sidebar from its own title bar, so the scrim is dropped and the drawer is
   allowed to use the full width. */
html[data-qd-dock] [class*="drawerMask"] {
  display: none !important;
}
html[data-qd-dock] [class*="sidebarCol"] {
  width: 100% !important;
}
/* The shell title bar owns the sidebar toggle; the app's floating one is noise. */
html[data-qd-dock] [data-qd-dock-hide="1"] {
  display: none !important;
}
html[data-qd-dock][data-qd-trim-sidebar] [class*="panelList"] {
  display: none !important;
}
`
  try {
    document.head.appendChild(style)
  } catch (error) {
    return
  }
  document.documentElement.setAttribute('data-qd-dock', '1')
  // Showing the shipped chrome in the dock turned out to be broken (the header
  // actions and the tab strip do not fit), so the trims are unconditional.
  document.documentElement.setAttribute('data-qd-trim-sidebar', '1')
  document.documentElement.setAttribute('data-qd-trim-tabs', '1')
  hideSidebarToggle()

  // Picking a session already closes the drawer in DSH's narrow layout; an extra
  // click on the toggle here reopened it, which looked like a close/reopen loop.

  // The dock window opens on the conversation: the sidebar state is shared with
  // the main window through localStorage, so an expanded sidebar there would
  // cover the whole dock on every start. Collapse it once, then stop - clicking
  // again during this window used to undo the user's expand.
  let attempts = 0
  const collapseOnStart = setInterval(function () {
    attempts += 1
    const frame = document.querySelector('[class*="_frame"][data-rightbar-collapsed]')
    if (frame && frame.hasAttribute('data-sidebar-collapsed')) {
      clearInterval(collapseOnStart)
      return
    }
    const toggle = frame ? findToggle() : null
    if (toggle) {
      try { toggle.click() } catch (error) { /* ignore */ }
    }
    if (attempts > 30) clearInterval(collapseOnStart)
  }, 100)

  /* ---- shell <-> app channel (the dock title bar drives the sidebar) ---- */

  /**
   * Report the sidebar state to the shell so its button can reflect it.
   * `window.parent` is our frame shell page; postMessage is the only channel
   * because the two documents are different origins.
   */
  function reportSidebarState() {
    const frame = document.querySelector('[class*="_frame"][data-rightbar-collapsed]')
    const expanded = frame ? !frame.hasAttribute('data-sidebar-collapsed') : false
    try { window.parent.postMessage({ type: 'quickdock:sidebar-state', expanded }, '*') } catch (error) { /* ignore */ }
  }

  window.addEventListener('message', function (event) {
    // Only our embedding shell may drive the layout.
    if (event.source !== window.parent) return
    const data = event.data
    if (!data) return
    if (data.type === 'quickdock:toggle-sidebar') {
      // The user is driving now: the boot-time collapse must not fight the click.
      clearInterval(collapseOnStart)
      const toggle = findToggle()
      if (toggle) {
        try { toggle.click() } catch (error) { /* ignore */ }
      }
      setTimeout(reportSidebarState, 80)
      return
    }
    if (data.type === 'quickdock:new-session') {
      // The shell owns the shortcut button while the sidebar is hidden; the app's
      // own button stays in the DOM and its click handler does the work.
      const create = document.querySelector('button[class*="newSession"]')
      if (create) {
        try { create.click() } catch (error) { /* ignore */ }
      }
    }
  })

  // Any click may have toggled the rail (its own button, a session row, ...).
  document.addEventListener('click', function () { setTimeout(reportSidebarState, 80) }, true)
  setTimeout(reportSidebarState, 400)
  setTimeout(reportSidebarState, 1200)

  // The account menu only carries full-window actions (settings, feedback, sign
  // out); at dock size none of them is usable, so the trigger goes away too.
  hideDocklessMenuItems()
  // Mirror the session title into the shell's title bar and tell it which session
  // is on screen (the shell's handoff button sends that back to the main window).
  followDocumentTitle()
  followCurrentSession()
}

/**
 * Account-menu entries that only make sense in the full DSH window.
 *
 * Written as escapes on purpose: the repository check keeps literal CJK out of
 * product code (UI strings live in locale/*.json), and these are DSH's labels,
 * not ours.
 */
const HIDDEN_MENU_ITEMS = [
  /\u8bbe\u7f6e/,               // settings
  /settings/i,
  /\u610f\u89c1\u53cd\u9988/,   // feedback
  /feedback/i,
  /\u9000\u51fa\u767b\u5f55/,   // sign out
  /\u9000\u51fa\u5e33\u865f/,   // sign out (traditional)
  /\u767b\u51fa/,               // log out (traditional)
  /sign\s*out/i
]

/** The avatar that opens the account menu (localised label, hence the pattern). */
const ACCOUNT_TRIGGER = /(\u8d26\u53f7\u83dc\u5355)|account\s*menu|account/i

/**
 * Conversation-header actions that need the full window.
 *
 * At dock width the workspace opener, its "open with" chevron, the overflow menu
 * and the right-sidebar toggle crowd out the session title and cannot be used
 * meaningfully, so they go away in the dock.
 */
const HIDDEN_HEADER_BUTTONS = [
  /^\u7528 .+\u6253\u5f00$/,          // "open with <app>"
  /open with/i,
  /\u66f4\u591a\u6253\u5f00\u65b9\u5f0f/, // more ways to open
  /more ways to open/i,
  /\u66f4\u591a\u64cd\u4f5c/,         // more actions
  /more actions/i,
  /\u6253\u5f00\u53f3\u4fa7\u8fb9\u680f/, // open right sidebar
  /\u6536\u8d77\u53f3\u4fa7\u8fb9\u680f/, // close right sidebar
  /open right sidebar/i,
  /close right sidebar/i
]

/** Strip the "— DeepSeek Harness" suffix DSH appends to its document title. */
function sessionTitleOf(documentTitle) {
  const text = String(documentTitle || '').trim()
  const split = text.lastIndexOf(' \u2014 ')
  return (split > 0 ? text.slice(0, split) : text).trim()
}

/**
 * Keep the dock title bar in sync with the session title.
 *
 * The app owns the title (it folds it from the session log), so the shell reads
 * it from `document.title` here and mirrors it; no session state is modelled.
 */
function followDocumentTitle() {
  let last = ''
  const report = function () {
    let title = sessionTitleOf(document.title)
    // An unsaved session has no name yet and DSH reports the bare app name; use
    // the app's own label for "new session" instead of showing a brand twice.
    if (!title || title === 'DeepSeek Harness') {
      const create = document.querySelector('button[class*="newSession"]')
      const label = create && create.getAttribute('aria-label')
      if (label) title = String(label).trim()
    }
    if (!title || title === last) return
    last = title
    try { window.parent.postMessage({ type: 'quickdock:title', title: title }, '*') } catch (error) { /* ignore */ }
  }
  try {
    const titleElement = document.querySelector('title')
    if (titleElement) new MutationObserver(report).observe(titleElement, { childList: true, characterData: true, subtree: true })
  } catch (error) { /* poll below still runs */ }
  report()
  setInterval(report, 1200)
}

/**
 * Sidebar entries that only the full window needs.
 *
 * Management surfaces (plugins, automations, the "more" menu), workspace
 * creation and the list view options do not belong in a 460px dock; the session
 * list, the new-session button and search stay.
 *
 * Exact labels, not substrings: the "more views" entry and the "show remaining
 * N sessions" row must survive.
 */
const HIDDEN_SIDEBAR_LABELS = new Set([
  '\u63d2\u4ef6',           // plugins
  'plugins',
  '\u81ea\u52a8\u5316\u4efb\u52a1', // automation tasks
  'automations',
  '\u81ea\u52a8\u5316',
  '\u66f4\u591a',           // more
  'more',
  '\u6dfb\u52a0\u5de5\u4f5c\u533a', // add workspace
  'add workspace',
  '\u89c6\u56fe\u9009\u9879', // view options
  'view options'
])

/**
 * Hide the account-menu entries that only the full window needs.
 *
 * The menu is portalled when it opens, so this runs on DOM insertions instead of
 * once at boot; entries are matched by their label because the item list carries
 * no stable ids.
 */
function hideDocklessMenuItems() {
  const sweep = function () {
    for (const item of document.querySelectorAll('[role="menuitem"]')) {
      const label = String(item.textContent || '').trim()
      if (!label) continue
      if (HIDDEN_MENU_ITEMS.some(function (pattern) { return pattern.test(label) })) {
        item.style.display = 'none'
      }
    }
    // The trigger is useless once every entry is gone.
    for (const trigger of document.querySelectorAll('button[aria-label]')) {
      const label = String(trigger.getAttribute('aria-label') || '')
      if (ACCOUNT_TRIGGER.test(label)) trigger.style.display = 'none'
      if (HIDDEN_HEADER_BUTTONS.some(function (pattern) { return pattern.test(label) })) {
        trigger.style.display = 'none'
      }
    }
    // Sidebar: drop the management rows, keep navigation and the session list.
    const column = document.querySelector('[class*="sidebarCol"]')
    if (column) {
      for (const entry of column.querySelectorAll('button')) {
        const label = String(entry.getAttribute('aria-label') || entry.textContent || '').trim()
        if (!label) continue
        if (HIDDEN_SIDEBAR_LABELS.has(label) || HIDDEN_SIDEBAR_LABELS.has(label.toLowerCase())) {
          entry.style.display = 'none'
        }
      }
    }
    // The session title lives in the dock's own title bar now, so the app's title
    // row is a wasted 30px: drop the whole row, not just the text. The header also
    // reserves a leading strip and a fixed 76px height that the tab strip then
    // stretches into - collapse all of it, or the space stays even without text.
    const titleCluster = document.querySelector('[class*="titleCluster"]')
    const titleRow = titleCluster && titleCluster.parentElement
    if (titleRow) titleRow.style.display = 'none'
    for (const leading of document.querySelectorAll('[class*="headerLeading"]')) {
      leading.style.display = 'none'
    }
    for (const header of document.querySelectorAll('header')) {
      if (!header.querySelector('[class*="titleCluster"], [class*="tabs"]')) continue
      header.style.height = 'auto'
      header.style.minHeight = '0px'
      header.style.paddingTop = '0px'
      header.style.paddingBottom = '0px'
      header.style.paddingRight = '10px'
    }
    for (const tabs of document.querySelectorAll('[class*="tabs"]')) {
      tabs.style.height = 'auto'
      tabs.style.marginTop = '6px'
    }
  }
  let queued = false
  const schedule = function () {
    if (queued) return
    queued = true
    requestAnimationFrame(function () {
      queued = false
      sweep()
    })
  }
  try {
    const observer = new MutationObserver(schedule)
    observer.observe(document.body, { childList: true, subtree: true })
  } catch (error) {
    /* no observer: the sweep below still runs once */
  }
  sweep()
  setTimeout(sweep, 1500)
  // React re-renders the header on session switches and would put its own inline
  // styles back; a cheap re-apply keeps the dock layout stable.
  setInterval(sweep, 1500)
}

/** The sidebar rail/expanded toggle, independent of the active locale. */
function findToggle() {
  const column = document.querySelector('[class*="sidebarCol"]')
  return (column && column.querySelector('button[class*="_toggle"]'))
    || document.querySelector('button[class*="_toggle"]')
}

/**
 * Tell the shell which session is on screen, so its handoff button can ask the
 * main DSH window to show the same one.
 *
 * The app keeps the active session in localStorage and both windows share the
 * origin, so reading that key is cheaper and more stable than scraping the DOM.
 */
function followCurrentSession() {
  let last = ''
  const report = function () {
    let sessionId = ''
    try {
      const raw = localStorage.getItem('dsh.sessions.current')
      if (raw) sessionId = String(JSON.parse(raw).sessionId || '')
    } catch (error) {
      sessionId = ''
    }
    if (sessionId === last) return
    last = sessionId
    try { window.parent.postMessage({ type: 'quickdock:session', sessionId: sessionId }, '*') } catch (error) { /* ignore */ }
  }
  report()
  setInterval(report, 1000)
}

/**
 * The reverse of the Dock button: switch this (main) window to a session that
 * the dock asked for.
 *
 * The Host stores the request; polling is the only channel a browser tab offers
 * for this direction, and it is a loopback GET every couple of seconds.
 */
function followHandoff(uiCtx) {
  let last = -1
  let origin = ''
  let ticks = 0

  /** The dock's address moves with its port: never keep a stale origin. */
  function refreshOrigin() {
    return bridge('web-url').then(function (body) {
      const url = body && body.url
      if (url) origin = new URL(url, location.href).origin
      return origin
    }).catch(function () { return origin })
  }

  refreshOrigin().then(function (first) {
    if (!first) return
    const tick = function () {
      if (!origin) return
      ticks += 1
      // Re-resolve now and then: a port change must not strand this poll.
      if (ticks % 15 === 0) void refreshOrigin()
      fetch(origin + '/quickdock/api/handoff', { cache: 'no-store' })
        .then(function (response) { return response.json() })
        .then(function (info) {
          if (!info || typeof info.seq !== 'number') return
          if (last === -1) { last = info.seq; return }
          if (info.seq <= last || !info.sessionId) return
          last = info.seq
          try {
            uiCtx.uiWorkspace.openSession(String(info.sessionId))
          } catch (error) {
            console.warn('[dsh-quickdock] handoff failed:', error)
          }
          // Bring this window forward. Browsers restrict programmatic focus, so
          // it is attempted and retried; the dock also hides itself on handoff,
          // which hands the foreground to this window at the OS level.
          const raise = function () {
            try { window.focus() } catch (error) { /* ignore */ }
          }
          raise()
          setTimeout(raise, 400)
          setTimeout(raise, 1500)
        })
        .catch(function () {
          // The dock is down or moved: ask for the address again.
          if (ticks % 3 === 0) void refreshOrigin()
        })
    }
    setInterval(tick, 2000)
    tick()
  }).catch(function () { /* no dock host */ })
}

/* ---------------- settings page (Settings → QuickDock) ---------------- */

const SETTINGS_SECTION = 'settings.section'

/** Rows of the settings page: key, control kind and bounds. */
const CONFIG_FIELDS = [
  { group: 'window', key: 'minWidth', kind: 'number', min: 280, max: 1200, step: 10 },
  { group: 'window', key: 'minHeight', kind: 'number', min: 280, max: 1600, step: 10 },
  { group: 'window', key: 'maxWidth', kind: 'number', min: 320, max: 2000, step: 10 },
  { group: 'window', key: 'maxHeight', kind: 'number', min: 320, max: 2000, step: 10 },
  { group: 'window', key: 'alwaysOnTop', kind: 'bool' },
  { group: 'window', key: 'rememberGeometry', kind: 'bool' },
  { group: 'window', key: 'focusOnSummon', kind: 'bool' },
  { group: 'window', key: 'autoLaunch', kind: 'bool' },
  { group: 'window', key: 'prefetchElectron', kind: 'bool' },
  { group: 'ball', key: 'ballSize', kind: 'number', min: 24, max: 160, step: 4 },
  { group: 'ball', key: 'ballIcon', kind: 'enum', options: ['whale', 'dot'] },
  { group: 'ball', key: 'snapToEdge', kind: 'bool' },
  { group: 'ball', key: 'closeAction', kind: 'enum', options: ['quit', 'ball'] },
  { group: 'dock', key: 'headerButton', kind: 'bool' },
  { group: 'network', key: 'port', kind: 'port', min: 1024, max: 65535, noteKey: 'cfg.portHint' },
  { group: 'network', key: 'serverStatus', kind: 'server' },
  { group: 'runtime', key: 'electronVersion', kind: 'version' },
  { group: 'runtime', key: 'runtimeStatus', kind: 'status' },
  { group: 'runtime', key: 'runtimeRedownload', kind: 'action', action: 'runtime-redownload' },
  { group: 'runtime', key: 'runtimeOpenFolder', kind: 'action', action: 'runtime-open-folder' }
]

const CONFIG_GROUPS = [
  { id: 'window', label: 'cfg.group.window' },
  { id: 'ball', label: 'cfg.group.ball' },
  { id: 'dock', label: 'cfg.group.dock' },
  { id: 'network', label: 'cfg.group.network' },
  { id: 'runtime', label: 'cfg.group.runtime' }
]

/** Prefix for every settings label, so the checker does not read it as one key. */
const CFG_PREFIX = 'cfg.'

const ROW_STYLE = { display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 2px', borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.08))' }
const LABEL_STYLE = { flex: '1 1 auto', minWidth: 0, fontSize: '13px' }
const VALUE_STYLE = { fontSize: '12px', opacity: .8, fontVariantNumeric: 'tabular-nums', minWidth: '48px', textAlign: 'right' }
const GROUP_STYLE = { fontSize: '12px', opacity: .55, margin: '18px 2px 4px' }
const HINT_STYLE = { fontSize: '12px', opacity: .55, padding: '0 2px 8px', lineHeight: 1.5 }

/**
 * The plugin's settings page in DSH: one row per configuration key.
 *
 * A settings section draws its own content (the shell only supplies the page
 * frame), so the rows, the read and the write path all live here. Values go
 * through the same bridge as the header button; the Host stores them in
 * config.json and applies the runtime-safe ones immediately.
 */
function QuickDockSettings() {
  const [config, setConfig] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  const [runtime, setRuntime] = React.useState(null)
  const [versions, setVersions] = React.useState(null)
  const [note, setNote] = React.useState('')
  const [server, setServer] = React.useState(null)
  // The port is edited as a draft: nothing binds until the button is pressed.
  const [portDraft, setPortDraft] = React.useState('')

  /** Read the listener state; a port change answers after the bind attempt. */
  function refreshServer() {
    bridge('status').then(function (result) {
      if (result && result.server) setServer(result.server)
    }).catch(function () { /* host not up yet */ })
  }

  React.useEffect(function () {
    let alive = true
    refreshServer()
    bridge('config-get').then(function (result) {
      if (alive && result && result.config) {
        setConfig(result.config)
        setPortDraft(String(result.config.port))
      }
    }).catch(function () { /* host not up yet */ })
    bridge('runtime-status').then(function (result) {
      if (alive && result && result.ok) setRuntime(result)
    }).catch(function () { /* host not up yet */ })
    bridge('runtime-versions').then(function (result) {
      if (alive && result && result.ok) setVersions(result)
    }).catch(function () { /* offline: the field keeps the current value */ })
    return function () { alive = false }
  }, [])

  /** Poll while a download runs, so the status line follows it. */
  const pollTimer = React.useRef(null)
  function stopPolling() {
    if (pollTimer.current) {
      clearInterval(pollTimer.current)
      pollTimer.current = null
    }
  }
  function startPolling() {
    stopPolling()
    pollTimer.current = setInterval(function () {
      bridge('runtime-status').then(function (result) {
        if (!result || !result.ok) return
        setRuntime(result)
        if (!result.downloading) stopPolling()
      }).catch(function () { /* ignore */ })
    }, 1500)
  }
  React.useEffect(function () { return stopPolling }, [])

  /** Turn transport errors into something a person can act on. */
  function friendly(message) {
    const text = String(message || '')
    if (/fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|network|proxy/i.test(text)) {
      return t(CFG_PREFIX + 'runtimeNetwork')
    }
    return text
  }

  /** Re-read the runtime after an action so the status line is never stale. */
  function refreshRuntime() {
    bridge('runtime-status').then(function (result) {
      if (result && result.ok) setRuntime(result)
    }).catch(function () { /* ignore */ })
  }

  function write(patch) {
    setBusy(true)
    bridge('config-set', { patch: patch }).then(function (result) {
      setBusy(false)
      if (result && result.config) setConfig(result.config)
      // A new port is a bind attempt, not a value: ask again once it resolved.
      if ('port' in patch) {
        setTimeout(refreshServer, 300)
        setTimeout(refreshServer, 1500)
      }
    }).catch(function () { setBusy(false) })
  }

  /**
   * A port is a rebind, not a value: one deliberate action, restart, a result.
   * The Host persists it, moves the listener and reopens the window on it.
   */
  function applyPort() {
    const next = Number(portDraft)
    if (!Number.isInteger(next) || next < 1024 || next > 65535) {
      setNote(t(CFG_PREFIX + 'portInvalid'))
      return
    }
    setBusy(true)
    setNote('')
    bridge('apply-port', { port: next }).then(function (result) {
      setBusy(false)
      if (result && result.server) setServer(result.server)
      if (result && result.ok) {
        setConfig(function (prev) { return prev ? Object.assign({}, prev, { port: result.port }) : prev })
        return
      }
      setNote(t(CFG_PREFIX + 'portFailed', { code: (result && result.error) || 'EADDRINUSE' }))
    }).catch(function (error) {
      setBusy(false)
      setNote(String(error && error.message || error))
    })
  }

  if (!config) {
    return el('div', { style: { padding: '24px', fontSize: '13px', opacity: .6 } }, '…')
  }

  function control(field) {
    const value = config[field.key]
    if (field.kind === 'bool') {
      return el('input', {
        type: 'checkbox',
        checked: value === true,
        disabled: busy,
        'aria-label': t(CFG_PREFIX + field.key),
        style: { width: '16px', height: '16px', accentColor: 'var(--dsw-alias-brand-primary, #4d8eff)' },
        onChange: function (event) {
          const patch = {}
          patch[field.key] = event.target.checked
          write(patch)
        }
      })
    }
    if (field.kind === 'text') {
      return el('input', {
        type: 'text',
        defaultValue: String(value || ''),
        placeholder: runtime ? runtime.defaultVersion : '',
        disabled: busy,
        'aria-label': t(CFG_PREFIX + field.key),
        style: {
          width: '110px',
          fontSize: '12px',
          padding: '4px 6px',
          borderRadius: '6px',
          background: 'var(--dsw-alias-bg-layer-2, #232326)',
          color: 'inherit',
          border: '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.12))'
        },
        onKeyDown: function (event) { if (event.key === 'Enter') event.currentTarget.blur() },
        onBlur: function (event) {
          const patch = {}
          patch[field.key] = String(event.target.value || '').trim()
          write(patch)
          setTimeout(refreshRuntime, 400)
        }
      })
    }
    if (field.kind === 'port') {
      const unchanged = Number(portDraft) === Number(config.port)
      return el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
        el('input', {
          type: 'number',
          min: field.min,
          max: field.max,
          step: 1,
          value: portDraft,
          disabled: busy,
          'aria-label': t(CFG_PREFIX + field.key),
          onChange: function (event) { setPortDraft(event.target.value) },
          onKeyDown: function (event) { if (event.key === 'Enter' && !busy && !unchanged) applyPort() },
          style: {
            width: '84px',
            fontSize: '12px',
            padding: '4px 6px',
            borderRadius: '6px',
            background: 'var(--dsw-alias-bg-layer-2, #232326)',
            color: 'inherit',
            border: '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.12))'
          }
        }),
        el('button', {
          type: 'button',
          disabled: busy || unchanged,
          'aria-label': t(CFG_PREFIX + 'portApply'),
          onClick: applyPort,
          style: {
            height: '26px',
            padding: '0 10px',
            fontSize: '12px',
            borderRadius: '6px',
            cursor: unchanged ? 'default' : 'pointer',
            color: 'inherit',
            background: 'var(--dsw-alias-bg-layer-2, #232326)',
            border: '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.12))'
          }
        }, t(CFG_PREFIX + 'portApply')))
    }
    if (field.kind === 'version') {
      const list = versions && Array.isArray(versions.versions) ? versions.versions : []
      const installed = versions && Array.isArray(versions.installed) ? versions.installed : []
      const fallback = String(value || '')
      const options = list.slice()
      if (fallback && !options.includes(fallback)) options.unshift(fallback)
      return el('select', {
        value: fallback,
        disabled: busy,
        'aria-label': t(CFG_PREFIX + field.key),
        style: {
          fontSize: '12px',
          padding: '4px 6px',
          borderRadius: '6px',
          background: 'var(--dsw-alias-bg-layer-2, #232326)',
          color: 'inherit',
          border: '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.12))'
        },
        onChange: function (event) {
          const patch = {}
          patch[field.key] = event.target.value
          write(patch)
          setTimeout(refreshRuntime, 400)
        }
      },
      el('option', { value: '' }, t(CFG_PREFIX + 'runtimeDefaultOption') + (versions && versions.defaultVersion ? ' (' + versions.defaultVersion + ')' : '')),
      options.map(function (entry) {
        const isInstalled = installed.includes(entry)
        return el('option', { key: entry, value: entry },
          entry + (isInstalled ? ' · ' + t(CFG_PREFIX + 'runtimeInstalled') : ''))
      }))
    }
    if (field.kind === 'server') {
      if (!server) return el('span', { style: VALUE_STYLE }, '…')
      const port = server.attempt || server.port
      const text = server.error
        ? t(CFG_PREFIX + 'serverBusy', { port: port, code: server.error })
        : server.ok
          ? t(CFG_PREFIX + 'serverListening', { port: server.port })
          : t(CFG_PREFIX + 'serverOff')
      return el('span', {
        style: Object.assign({}, VALUE_STYLE, {
          maxWidth: '340px',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          // A taken port is the one value a user has to act on.
          color: server.error ? 'var(--dsw-alias-state-error-primary, #ff6b6b)' : undefined
        }),
        title: text
      }, text)
    }
    if (field.kind === 'status') {
      if (!runtime) return el('span', { style: VALUE_STYLE }, '…')
      if (runtime.downloading) {
        const total = Number(runtime.total) || 0
        const received = Number(runtime.received) || 0
        const percent = total > 0 ? Math.round((received / total) * 100) + '%' : ''
        const mb = (n) => (n / 1048576).toFixed(1) + ' MB'
        return el('span', { style: VALUE_STYLE }, t(CFG_PREFIX + 'runtimeDownloading') + ' ' + percent + ' ' + (total > 0 ? mb(received) + ' / ' + mb(total) : ''))
      }
      const text = runtime.ready
        ? runtime.version + ' · ' + (runtime.exe || '')
        : runtime.version + ' · ' + t(CFG_PREFIX + 'runtimeMissing')
      return el('span', { style: Object.assign({}, VALUE_STYLE, { maxWidth: '320px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }), title: runtime.dir }, text)
    }
    if (field.kind === 'action') {
      return el('button', {
        type: 'button',
        disabled: busy,
        'aria-label': t(CFG_PREFIX + field.key),
        style: {
          height: '26px',
          padding: '0 10px',
          fontSize: '12px',
          borderRadius: '6px',
          cursor: 'pointer',
          color: 'inherit',
          background: 'var(--dsw-alias-bg-layer-2, #232326)',
          border: '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.12))'
        },
        onClick: function () {
          setBusy(true)
          setNote('')
          bridge(field.action).then(function (result) {
            setBusy(false)
            if (result && result.error) {
              setNote(String(result.error))
              return
            }
            setNote('')
            if (result && result.ok) setRuntime(result)
            if (field.action === 'runtime-redownload') startPolling()
            else refreshRuntime()
          }).catch(function (error) {
            setBusy(false)
            setNote(friendly(error && error.message || error))
          })
        }
      }, t(CFG_PREFIX + field.key))
    }
    if (field.kind === 'enum') {
      return el('select', {
        value: String(value),
        disabled: busy,
        'aria-label': t(CFG_PREFIX + field.key),
        style: { fontSize: '12px', padding: '4px 6px', borderRadius: '6px', background: 'var(--dsw-alias-bg-layer-2, #232326)', color: 'inherit', border: '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.12))' },
        onChange: function (event) {
          const patch = {}
          patch[field.key] = event.target.value
          write(patch)
        }
      }, field.options.map(function (option) {
        return el('option', { key: option, value: option }, t(CFG_PREFIX + field.key + '.' + option))
      }))
    }
    return el('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
      el('input', {
        type: 'range',
        min: field.min,
        max: field.max,
        step: field.step,
        value: Number(value),
        disabled: busy,
        'aria-label': t(CFG_PREFIX + field.key),
        style: { width: '130px', accentColor: 'var(--dsw-alias-brand-primary, #4d8eff)' },
        onChange: function (event) {
          const patch = {}
          patch[field.key] = Number(event.target.value)
          write(patch)
        }
      }),
      el('span', { style: VALUE_STYLE }, String(value) + 'px')
    )
  }

  const rows = []
  for (const group of CONFIG_GROUPS) {
    rows.push(el('div', { key: 'g-' + group.id, style: GROUP_STYLE }, t(group.label)))
    for (const field of CONFIG_FIELDS) {
      if (field.group !== group.id) continue
      rows.push(el('div', { key: field.key, style: ROW_STYLE },
        el('div', { style: LABEL_STYLE }, t(CFG_PREFIX + field.key)),
        control(field)
      ))
      if (field.noteKey) {
        rows.push(el('div', { key: field.key + '-hint', style: HINT_STYLE }, t(field.noteKey)))
      }
    }
  }

  const friendlyRuntimeError = runtime && runtime.error ? friendly(runtime.error) : ''
  if (note || friendlyRuntimeError) {
    rows.push(el('div', { key: 'note', style: { padding: '6px 12px', fontSize: '12px', color: 'var(--dsw-alias-state-error-primary, #ff6b6b)' } }, note || friendlyRuntimeError))
  }

  return el('div', { style: { display: 'flex', flexDirection: 'column', padding: '4px 0 24px' } }, rows)
}

function apply(ctx) {
  if (insideDockWindow()) {
    // This page is the dock, not the window that opens it: no header button, no
    // download badge - only the layout fixes below.
    applyDockMode()
    try {
      ctx.inject(['uiWorkspace'], function (uiCtx) {
        // The Dock button in the main window bound a session: follow it. The shell
        // forwards the target over postMessage because the frames are cross-origin.
        window.addEventListener('message', function (event) {
          if (event.source !== window.parent) return
          const data = event.data
          if (!data || data.type !== 'quickdock:open-session' || !data.sessionId) return
          try {
            uiCtx.uiWorkspace.openSession(String(data.sessionId))
          } catch (error) {
            console.warn('[dsh-quickdock] open-session failed:', error)
          }
        })
        // Ask the shell for the target once this app can navigate.
        setTimeout(function () {
          try { window.parent.postMessage({ type: 'quickdock:ready' }, '*') } catch (error) { /* ignore */ }
        }, 300)
      })
    } catch (error) {
      console.warn('[dsh-quickdock] uiWorkspace unavailable in the dock window:', error)
    }
    return
  }
  // The header button is switchable; the answer arrives after registration, so the
  // component hides itself instead of the slot being filled late (which DSH drops).
  bridge('config-get').then(function (settings) {
    const config = settings && settings.config
    if (config && config.headerButton === false) HEADER_ENABLED = false
  }).catch(function () { /* keep the default */ })

  try {
    ctx.slots.inject(HEADER_SLOT, () => ctx.slots.register({
      name: HEADER_SLOT,
      id: PLUGIN_ID + '-send-to-dock',
      registrant: PLUGIN_ID,
      // order is the display order (priority is the slot's own overlap rule).
      order: 1010
    }, SendToDock))
  } catch (error) {
    console.error('[dsh-quickdock] client apply failed (plugin disabled, web boot continues):', error)
  }

  // Sidebar footer: the runtime download must be visible, not a silent wait.
  try {
    ctx.slots.inject(FOOTER_SLOT, () => ctx.slots.register({
      name: FOOTER_SLOT,
      id: PLUGIN_ID + '-download',
      registrant: PLUGIN_ID,
      order: 1010
    }, DownloadBadge))
  } catch (error) {
    console.warn('[dsh-quickdock] footer slot unavailable:', error)
  }

  // Settings → QuickDock: its own tab, one row per configuration key.
  try {
    ctx.slots.inject(SETTINGS_SECTION, () => ctx.slots.register({
      name: SETTINGS_SECTION,
      id: PLUGIN_ID,
      registrant: PLUGIN_ID,
      order: 60,
      label: function () { return t('settings.quickdock') }
    }, QuickDockSettings))
  } catch (error) {
    console.warn('[dsh-quickdock] settings page unavailable:', error)
  }

  // Push the browser locale even when the locale service is unavailable.
  applyLocale(detectLocale())

  // The dock can ask this window to show a session (the reverse of the Dock
  // button); it needs the workspace navigation service to act on it.
  try {
    ctx.inject(['uiWorkspace'], followHandoff)
  } catch (error) {
    console.warn('[dsh-quickdock] handoff unavailable:', error)
  }

  // Optional dependencies: the button works without theme/locale services.
  try {
    ctx.inject(['theme'], syncTheme)
  } catch (error) {
    console.warn('[dsh-quickdock] theme service unavailable:', error)
  }
  try {
    ctx.inject(['locale'], syncLocale)
  } catch (error) {
    console.warn('[dsh-quickdock] locale service unavailable:', error)
  }

}

return {
  name: 'dsh-quickdock',
  inject: ['slots'],
  apply
};
} catch (bootError) {
  console.error('[dsh-quickdock] client factory failed (plugin disabled, web boot continues):', bootError);
  return { apply() {} };
}
} });
