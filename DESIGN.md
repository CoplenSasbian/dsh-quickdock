# DSH QuickDock 设计文档（v12 · 定稿）

> 状态：**设计定稿 —— 14 项决策全部已定，可进入实现**
> **交互原型**：[`dock-prototype.html`](dock-prototype.html) —— 原型是视觉真相源，正文与它保持一致

> **2026-10 实现重构（v13）**：设计结论未变，落地结构做了规范化 ——
> 宿主半拆进 `host/`（适配器 / 观察者 / 命令表 / 策略表），页面脚本按
> `web/manifest.json` 顺序拆分（i18n、工具、执行过程、菜单、引导）；
> 全部界面文案迁入 `locale/*.json`（en / zh，可实时切换）；
> 源码注释统一为简洁英文。用法、目录与质量闸门见 [README.md](./README.md)。

---

## 1. 一句话目标

一个**常驻屏幕角落**的迷你窗口：输入面板 + 执行流程面板，中间透明隔开。
从 DSH 侧栏按钮唤出 → 敲一句「提交一下代码」→ 回车 → 输入面板收起，只显示这条指令的 agent 执行过程（读了哪个文件、跑了哪条命令、改了什么），全程占屏幕 3~4 指宽，不挡 IDE。
执行完可一键收起执行区，回到只有输入框的轻量状态。

**明确不做**：不显示你的提问原文、不显示历史对话、不替代主窗口。

---

## 2. 选型结论：为什么是 Electron

### 2.1 DSH 生态的先例

DSH 里已有成熟桌宠插件，做法一致：

| 项目 | 方案 | 关键实现 |
|---|---|---|
| [dsh-pet](https://github.com/PC2005-cloud/dsh-pet)（最成熟） | **自下载 Electron** 到 `$DSH_HOME/electron`（`@electron/get` + npmmirror 镜像） | `runtime/electron-helper/main.js` 是独立 Electron 主进程 |
| [kun-pet-desktop](https://github.com/anticipate218/kun-pet-desktop) | `devDependencies: electron` | 标准 Electron 应用 |
| [workbuddy-pet](https://github.com/Hetu-108/workbuddy-pet) | Electron 透明置顶窗 | — |

**桌宠类项目清一色用 Electron**——因为透明、置顶、点击穿透这些能力只有 Chromium 系稳定。

### 2.2 异形窗口的能力边界

实测确认（读窗口内容自身的 alpha 通道）：

| 需求 | Electron |
|---|---|
| 矩形圆角窗口 | ✅ |
| **真·异形/透明**（背景透出桌面） | ✅ **实测角落 alpha=0** |
| 点击穿透（不规则命中区） | ✅ `setIgnoreMouseEvents` |
| 全局热键 | ✅ 内置 `globalShortcut` |

**代价**：内存约 300MB working set（含 GPU 进程；与 DSH 主窗口共享 Chromium 代码页，实际增量更低）。

**结论**：选 Electron，省去兼容性担心。桌宠怎么做的，我们就怎么做。

### 2.3 能否复用 DSH 的输入框 / 对话组件？

**不能直接复用组件，但不需要。**

#### ① 组件不能当库 import

客户端插件运行时只暴露 5 个符号：`React`、`ctx`、`host`、`styles`、`console`。
官方明确禁止：**"Do not `require('@deepseek-ai/dsh-client-ui-primitives')` or load any other Harness Client package as a module"**。

#### ② 正确思路：复用协议，不复用组件

[dsh-remote](https://github.com/mrRisega/dsh-remote) 已验证这条路：

```
手机 PWA → relay-router ──WS隧道──→ bridge(电脑) ──HTTP/WS全量透传──→ 127.0.0.1:3080 (dsh web)
```

它把 `dsh web` 的 HTTP + WebSocket **全量透明代理**，手机加载的是官方前端页面本体。
所以"两端 UI 同步"是**天然的**——跑同一个前端、连同一个 Host。

它踩过并写进注释的坑，对我们直接有用：
- 必须**剥掉** `Origin` / `Sec-Fetch-*` / `Cookie` / `Referer`，否则过不了 dsh web 的信任围栏
- 必须带上插件换来的 **Harness 会话 Cookie**，否则 401 白页
- 上游端口**不能写死 3080**（Desktop 默认 43120，还会 +1），要动态发现
- WS 要抬高 `maxPayload`（默认 100MiB 不够，大上传会 1009 断连）

#### ③ 我们的方案：dock 做"遥控器 + 跳转"

这消解了"一个 Session 只能有一个输入框"的约束——**因为 dock 不需要和主窗口同时编辑**：

| 交互 | 实现 |
|---|---|
| dock 里输入消息/任务 | 走 `prompt` 接口，创建/复用一个 Session |
| dock 显示执行流程 | 订阅该 Session 事件流，折成步骤行 |
| **点 `⧉` → 在 DSH 打开** | `ctx.uiWorkspace.openSession(sessionId)` |
| 主窗口里能看到实时执行 | ✅ **天然如此**，因为是同一个 Session |
| 需要审批 | **dock 内直接完成**（见 2.6） |

**核心洞察：dock 和主窗口操作的是同一个 Session，所以"两边同步"是免费的，不需要任何同步机制。**

#### ④ 深链限制

`dsh://` 协议**只支持 `dsh://open`**（唤起主窗口），**不支持定位到具体 session**：

```js
// main.js L13060
if (url === "dsh://open" || url === "dsh://open/") focusPrimaryWindow();
```

所以独立窗口点 `⧉` 只能：`dsh://open` 唤起主窗口 + Host 侧写"待打开 session"标记，让主窗口启动时读一次。

---

### 2.4 功能：从 DSH 里把当前 Session「推到 dock」

**插槽：`conversation.session.header.actions`**（会话标题栏旁）

| 事实 | 值 |
|---|---|
| 类型 | `list`（**增量**，不会覆盖别人） |
| 作用域 | `session` |
| 现有占用者 | `agent-team`(-20)、`agent-preset`(-10)、`subagent-catalog`(10)、`job-list`(20)、**`dsh-rewind`(1000)** |
| `replaceRisk` | **none** ✅ |
| 注册参数 | `{ id, order?, label? }` |

`dsh-rewind` 已经在这里加了按钮，说明这是**社区插件实际在用的扩展点**。

**可用 props**：
```js
sessionId: SessionId          // ← 当前会话，直接拿来推给 dock
useSession: SessionSnapshotSelector
useSessions: UseSessions
useWorkspaces: SnapshotSelectorHook<WorkspaceSnapshot>
```

实现：

```js
ctx.slots.register({
  name: 'conversation.session.header.actions',
  id: 'quickdock-send-to-dock',
  order: 1010,          // 排在 dsh-rewind 后面
}, function SendToDock({ sessionId }) {
  return React.createElement('button', {
    title: '在 QuickDock 中打开',
    onClick: () => host.call('dock.attach', { sessionId }),
  }, '⧉')
})
```

---

### 2.5 功能：工作空间用下拉框选

数据源已确认：

| 能力 | 来源 |
|---|---|
| 工作空间列表 | `useWorkspaces`（`SnapshotSelectorHook<WorkspaceSnapshot>`） |
| 已有下拉框可参考 | `conversation.hero.workspace` 的 `ownerProps`：`{ open, anchorRef, selectedId, onPick, onClose }` |
| 新建会话时指定 | `sessions.create({ workspaceId, cwd, agentPreset })` |
| 打开已有工作空间 | `uiWorkspace.openWorkspace(workspaceId, beforeOpen, options)` |

下拉框行为：
- 列出所有 Workspace（`useWorkspaces` 快照）
- 记住上次选择（写 `window.json`）
- 选择后，下一条指令就发到那个工作空间（新建 Session 时带 `workspaceId`）
- 若当前 dock 已绑定某个 session（从"推到 dock"进来），下拉框显示该 session 所属空间并**置灰**（不能中途换空间），旁边给一个"新建"按钮解除绑定

---

### 2.6 审批 / 提问能集成到 dock 里吗？—— **能，不必回主窗口**

我原来把 D6 设成"只显示黄点，去主窗口处理"，那是偷懒。查证后确认：**两个通道都是 waterfall 事件，插件可以自己给出答案。**

#### ① 工具审批：`approval/request`

```
'approval/request'(this: Scoped<Agent>, req: ApprovalRequestEvent,
                   next: () => Promise<ApprovalOutcome>) => Promise<ApprovalOutcome>
```

- **waterfall 模式**：返回一个 outcome 就**认领**这个请求；调 `next()` 才交给后面的 answerer
- `ApprovalOutcome` = `'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`
- **`'allowed-once'` 是唯一的授权值**（不是"永久允许"）
- 请求带 `agent`、`toolName`、`callId`、`reason`、`displayReason`（多语言）、`signal`
- **scope-filtered**：agent-scoped 监听器只收到该 agent 的请求

关键约束（来自服务描述）：

> The request requires **an open turn** because the audit pair must be enclosed by the durable log's commit/replay boundary; an idle ask rejects before appending anything.

**这正好匹配我们的场景**：dock 提交的任务本身就在一个开着的 turn 里，所以拦截是合法的。
另外：**任何决定都会被记入 session 日志**（ask/outcome 成对），不是插件自己偷偷放行。

#### ② 结构化提问：`user-questions/request`

```
'user-questions/request'(this: Scoped<Agent>, request: AskUserQuestionRequestEvent,
                         next: () => Promise<AskUserQuestionAnswer>) => Promise<AskUserQuestionAnswer>
```

- 同样是 waterfall，返回 answer 就认领
- `AskUserQuestionItem` 自带 **`options[]`（label + description）** 和 `multiSelect`
- 答案结构：`{ answers: [{ id, selected: string[], custom? }] }`

**这意味着 dock 里可以直接渲染选项按钮**，不需要跳转。

#### ③ 因此 dock 内的交互

| 情况 | dock 里的表现 |
|---|---|
| 工具需要审批 | 展开一张卡片：`bash  git push` + 原因 + **[允许一次] [拒绝]** |
| agent 问选择题 | 展开选项按钮（`options` 直接映射成按钮） |
| agent 问自由文本 | 展开输入框 |
| 计划审核（`intent.kind === 'plan-review'`） | 显示计划摘要 + `approve` 按钮 |

**用户不用回主窗口。** 主窗口那边照旧也会显示（因为事件是同一个），两边都能答，先答的生效。

#### ④ 实现要点

```js
// Host 侧：拦截 dock 所属 session 的审批
ctx.on('approval/request', async (req, next) => {
  const sessionId = req.agent.id
  if (!dock.sessions.has(sessionId)) return next()      // 不是 dock 的任务 → 交给原流程

  const decision = await dock.ask({
    kind: 'approval',
    toolName: req.toolName,
    reason: req.reason ?? req.displayReason?.[locale],
    callId: req.callId,
  }, req.signal)                                        // ← 把 signal 传下去，取消时能同步

  if (decision === null) return 'cancelled'             // 用户取消 / dock 断开
  return decision ? 'allowed-once' : 'rejected'
})
```

**必须处理的边界**：
1. **dock 窗口关掉时** → 返回 `'cancelled'`（不能挂死）。用 `req.signal` 的 abort 同步。
2. **超时** → 配置 `approvalTimeoutMs`（默认 5 分钟），超时返回 `'cancelled'`。
3. **多个请求并发** → dock 里排队显示（一次只答一个，答完自动下一个）。
4. **不是 dock 发起的 session** → 一律 `next()`，绝不干扰主窗口的审批。
5. **`'unavailable'` 的语义**：answerer 缺失/抛错时框架会 fail closed，我们要保证自己的异常也走这条路，而不是静默放行。

#### ⑤ 安全性

这是**授权操作**，必须严格：
- 只有 dock 当前绑定的那个 session 的请求才会被接管
- 卡片必须显示**完整命令**（不能只显示工具名），用户看清才能点
- 默认**不提供**"总是允许"，只有 `allowed-once`（符合框架语义）
- 不做"自动允许"配置项（避免用户图省事把安全边界关掉）

---

## 3. 架构

```
┌──────────────────────────────────────────────────────────────┐
│  DSH Host 进程（Node，:62135）                                │
│  └ dsh-quickdock 插件（Host 侧）                              │
│      · /quickdock 页面 + /api/* 接口                          │
│      · session/event → 步骤折叠                               │
│      · 解析 Electron 路径（三级回退）                          │
│      · spawn dock 进程（删掉 ELECTRON_RUN_AS_NODE）            │
│      · 守护：退避重启 + 熔断                                   │
└───────────────────────────┬──────────────────────────────────┘
                            │ spawn（stdio 管道 + 环境变量注入）
                            ▼
┌──────────────────────────────────────────────────────────────┐
│  dock 进程（Electron 主进程，纯 JS）                           │
│  · transparent + frame:false + alwaysOnTop + skipTaskbar      │
│  · setIgnoreMouseEvents(forward) —— 异形命中区                │
│  · 无全局热键（v1）；由 DSH 侧栏按钮唤起                          │
│  · 6 锚点 + 多屏几何（screen API）                             │
│  · 几何记忆 → %LOCALAPPDATA%\dsh-quickdock\window.json        │
│  · 加载 http://127.0.0.1:<port>/quickdock?t=<token>           │
│  · 宿主存活探测（kill(pid,0)）→ 宿主没了就退                    │
└──────────────────────────────────────────────────────────────┘
```

### 3.1 Electron 从哪来（候选链 + 运行时兜底）

```
① 显式配置 / 环境变量（DSH_QUICKDOCK_ELECTRON_PATH）
② %LOCALAPPDATA%\dsh-quickdock\electron\<版本>\electron.exe（自己下载落地）
③ 本机 electron npm 包（node_modules/electron/dist）
④ ~/.dsh/electron（旧布局）
   └ 全都不可用 → 进程内异步下载（@electron/get + npmmirror 镜像）
```

**为什么自管目录排在 npm 包前面（2026-10-28 实测）**：
npm 包一般落在项目目录（本机在桌面）。同一份 Electron 44.7.0（文件大小/版本一致）从桌面启动时，
Chromium 在写用户数据目录的阶段就被拦下：

```
ERROR:process_singleton_win.cc(318) Lock file can not be created: 拒绝访问 (0x5)
ERROR:persistent_cache_sandboxed_file_factory.cc(153) ... 拒绝访问 (0x5)
→ exit code 0（还没执行到 main.cjs，dock.log 一行都没有）
```

而 `%LOCALAPPDATA%\dsh-quickdock\electron\44.7.0\electron.exe` 同一版本可正常运行。
这与 3.3「安全软件按路径拦截」是同一类问题，只是从 `STATUS_BREAKPOINT` 变成了写权限拒绝。
所以：**自管目录优先**，npm 包只作为后备。

**运行时还有第二次兜底**：probe 通过 ≠ 能启动。dock 如果在 `ready` 之前退出，
`host/dock-process.js` 会换候选列表里的下一个重试；全部失败时把最后一行 stderr
显示给用户（`host.dockStartFailed`），而不是让页面干等到超时。

**关键设计（dsh-pet 验证过的）**：
- 下载**不 spawn 子进程**，在宿主进程内做 —— 因为 `process.execPath` 在 Electron 宿主里指向宿主 exe，spawn 会崩
- 下载用 `@electron/get`（自带 SHA256 校验、镜像、缓存复用），解压用 `@electron-internal/extract-zip`（纯 Node + native，跨平台，不依赖系统 unzip）
- 这两个包**动态 import**（`await import(...)`），避免只想用 Web 模式的用户因为原生模块加载失败而整个插件挂掉
- 落盘 `$DSH_HOME/electron/`，同一版本只下一次
- 下载失败**只影响桌面模式**，Web 形态不受影响

### 3.2 依赖清单

```json
{
  "dependencies": {
    "@electron/get": "^5.1.0",
    "@electron-internal/extract-zip": "^1.0.5"
  }
}
```

**不需要**把 `electron` 列为依赖 —— 运行时按三级回退解析。

### 3.3 dsh-pet 踩过的坑（全部照搬）

这些是它代码注释里明确记录的：

| 坑 | 现象 | dsh-pet 的解法 |
|---|---|---|
| **`ELECTRON_RUN_AS_NODE` 继承** | 子进程以纯 Node 启动，`require('electron')` MODULE_NOT_FOUND，秒退 | spawn 前 `delete env.ELECTRON_RUN_AS_NODE`。**注意：置空字符串会 abort（exit 134），必须删除** |
| **Windows 透明窗黑边/内容丢失** | 拖拽时窗口四周黑边，大透明窗盖小透明窗时后者内容丢失 | `app.disableHardwareAcceleration()`（仅 Windows） |
| **GPU 进程沙箱崩溃** | 装了虚拟显示器（ToDesk/远程桌面）时，`STATUS_BREAKPOINT` 反复崩 | `--disable-gpu-sandbox`（可用 `DSH_QUICKDOCK_GPU_SANDBOX=1` 保留沙箱） |
| **任务栏按钮复活** | 合盖/唤醒、显示器拓扑变化后，任务栏冒出 Electron 图标 | `setSkipTaskbar(true)` 调两次（间隔 0ms），并在 `show`/`resume`/`unlock-screen` 时重申 |
| **被遮挡时停止渲染** | 窗口被其他窗口盖住后 Chromium 暂停渲染，表现为"消失" | `webContents.setBackgroundThrottling(false)` |
| **`ready-to-show` 不触发** | `paintWhenInitiallyHidden:false` 时首帧可能不产出，窗口永远隐藏 | `did-finish-load` 后 400ms 兜底 `showInactive()` |
| **宿主退出留僵尸** | 宿主没了但 dock 还赖着 | ① stdout/stderr 的 EPIPE 守卫；② 每 2s `kill(hostPid, 0)`，ESRCH 即退 |
| **stdin 不可用** | Electron 主进程在 Windows 上收不到 piped stdin | 请求走 stdout，应答走**本地 HTTP 回调**（127.0.0.1 随机端口） |
| **应用名回落** | 不设 `app.setName()` 时 userData 落到 `%APPDATA%\Electron`，与他人混用 | ready 前 `app.setName('dsh-quickdock')` |
| **单实例** | 两个 dock 进程抢同一 userData | `app.requestSingleInstanceLock()`，第二个直接退出 |

### 3.4 几何与多屏

```js
const { screen } = require('electron')
const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
const wa = display.workArea        // 已扣除任务栏
// 6 锚点：topLeft / topRight / bottomLeft / bottomRight / topCenter / bottomCenter
```

- 用 `workArea` 而非 `bounds`，自动避开任务栏
- 监听 `display-metrics-changed` / `display-added` / `display-removed`，防抖 300ms 后重算
- 记住上次所在显示器的 `id`，多屏时优先回到那块

### 3.5 点击穿透（异形必需）

```js
// 默认整窗穿透，鼠标移动仍转发进页面做命中判定
win.setIgnoreMouseEvents(true, { forward: true })

// 页面在光标进出可视区域时，通过 IPC 翻转
ipcMain.on('dock:set-interactive', (_e, interactive) => {
  win.setIgnoreMouseEvents(!interactive, { forward: true })
})
```

**dsh-pet 的补充教训**：`forward` 钩子在 Windows 上可能静默失效，所以它另加了一条**主进程轮询兜底**（每 60ms 用 `screen.getCursorScreenPoint()` 独立判定）。我们照做。

### 3.6 宿主 ↔ dock 通信

dsh-pet 需要双向协议，因为宿主主动推送数据。**我们的场景更简单**：

```
dock → Host：HTTP fetch（带 Bearer token），读 /quickdock/api/*
Host → dock：SSE 流（EventSource）
```

只有"推到 dock"按钮那一下需要 Host → dock 主动通知，用一条极简 stdout 行协议即可：

```
Host 写 stdout:  "quickdock:{"type":"attach","sessionId":"..."}\n"
dock 读 stdout，其余行当日志
```

---

## 4. 组件与职责

### 4.1 `dsh-quickdock`（DSH bundle，Host 侧）

| 职责 | 实现要点 |
|---|---|
| 托管页面 | `ctx.webServer.register({ kind:'prefix', path:'/quickdock' })` |
| 任务提交 | `POST /quickdock/api/task` → 建 Session（带 workspaceId）→ 投 prompt |
| 会话绑定 | `POST /quickdock/api/bind` `{ sessionId }` ← 供「推到 dock」按钮调用 |
| 步骤流 | 订阅 `session/event` 折成有序步骤；`GET /quickdock/api/stream` SSE |
| 停止 | `POST /quickdock/api/stop` |
| 拉起 dock | `ctx.subprocess.spawn`，**env 删除 `ELECTRON_RUN_AS_NODE`** |
| 鉴权 | 32 字节随机 token，仅内存，argv 传给 dock，校验 `Bearer` |
| 配置 | 全部进 `Config`（第 8 节） |

**硬约束**：只读 `session/event`，绝不写新事件类型（DSH 规定未知类型会让 Session 无法重开）。

### 4.2 `dsh-quickdock`（DSH bundle，Client 侧）

| 职责 | 实现要点 |
|---|---|
| 「推到 dock」按钮 | 注册到 `conversation.session.header.actions`，`{ id:'quickdock-send-to-dock', order:1010 }` |
| 按钮行为 | `host.call('dock.attach', { sessionId })` → Host 转发给 dock 进程 |
| 可选：右键菜单项 | 注册到 `sidebar.workspaces.session.menu.item`（配置开关） |
| 图标 | 复用 bundle 的 `icon.svg`，尺寸 16px，跟随主题色 |

**注意**：Client 侧只有 `React`/`ctx`/`host`/`styles`/`console`，不能 import 任何 Harness 包——按钮要用原生 `button` 元素 + 主题令牌自绘。

### 4.3 dock 进程（Electron 主进程）

| 职责 | API |
|---|---|
| 窗口 | `BrowserWindow({ transparent:true, frame:false, skipTaskbar:true, hasShadow:false, alwaysOnTop: false })` |
| 顶置开关 | `setAlwaysOnTop(flag, 'screen-saver')` —— **默认 `false`**，由用户点「⤒」切换，状态存 `window.json`。**两个窗口一起钉**（只钉输入窗口的话列表会被别的应用盖住） |
| 跨虚拟桌面 | `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })` |
| 6 锚点 | `screen.getDisplayNearestPoint` + `workArea` |
| 唤出 | 无全局热键（v1）；由 Host 通过管道通知 `show()` |
| 不抢焦点 | `showInactive()` |
| 点击穿透 | `setIgnoreMouseEvents(true, { forward: true })` + 轮询兜底 |
| 记忆 | `%LOCALAPPDATA%\dsh-quickdock\window.json`（见第 10 节任务） |
| 断线 | Host 不可达显示"DSH 未运行"，2s 重试；宿主 PID 消失则退出 |

**尺寸**：宽 **360px** 固定，高度自适应（最小 280、最大 560）。宽度取 360 是为了在同一行放下 4 个功能键（权限 / 模型 / 思考深度 / Agent）而不挤。
**内存**：约 300~370MB working set（实测 367MB，含 GPU 进程；与 DSH 主窗口共享 Chromium 代码页，实际增量更低）。

**单实例锁**：`app.requestSingleInstanceLock()`，第二个实例直接退出并把已有窗口唤到前台。

### 4.4 页面 `/quickdock`（HTML + 原生 JS）

单文档、内联 CSS/JS、零外部请求。自带主题变量。

---

## 5. 进入 dock 的路径

> **v1 不绑全局热键**，改为在 **DSH 主界面内激活**。热键留到后续版本再加。

```
路径 A：从 DSH 侧栏唤出 → 新建（默认）
  侧栏底部「QuickDock」按钮 → dock 窗口浮出（顶栏显示工作区下拉）
  → 输入「发送消息或任务…」+ Enter
  → POST /quickdock/api/task { text, workspaceId }
  → 新建 Session → prompt 入队
  （若配置允许，可勾「从当前会话分叉」）

路径 B：DSH 里点按钮 → 绑定现有会话
  DSH 会话标题栏点「⧉」→ host.call('dock.attach', { sessionId })
  → Host 通知 dock 进程 → dock 切到该 Session
  → 之后在 dock 里发的指令都进这个 Session
  → 主窗口立刻能看到（同一个 Session，天然同步，无需任何同步机制）
```

### 5.1 唤出入口（替代全局热键）

插槽 **`sidebar.footer.action`**（侧栏底部，设置按钮旁）：

| 事实 | 值 |
|---|---|
| 类型 | `list`（增量） |
| 作用域 | `root` |
| 现有占用者 | `cordis-panel` ✅ 已有先例 |
| `replaceRisk` | **none** |
| props | `{ wide: boolean }`（侧栏展开/56px 轨道两态） |

- 展开态：图标 + 「QuickDock」文字
- 收起态（`wide: false`）：只显示图标
- 点击行为：dock 已运行则**呼到前台**（`show()`），未运行则拉起进程

**为什么不用托盘图标**：托盘要额外管理生命周期，且用户不容易发现。侧栏按钮和设置并列，位置固定、一眼可见。

**热键留待后续**：`globalShortcut` 的实现不难（dsh-pet 已用），但需要处理与其他软件冲突、用户自定义、失败降级。v1 先用显式入口把功能跑通。

### 5.2 dock 收起后怎么再打开

| 方式 | 说明 |
|---|---|
| 侧栏「QuickDock」按钮 | 主入口，始终可用 |
| 任务跑完自动…… | ❌ 不做（按你的意见） |
| 全局热键 | v1 不做 |

dock 窗口的 `✕` 是**隐藏窗口**（`hide()`），不是退出进程 —— 所以侧栏按钮能瞬间唤回，不用等 Electron 重新启动。

**dock 进程只在两种情况下退出**：DSH 退出，或用户从侧栏按钮的右键菜单选「退出 QuickDock」。

---

## 6. 界面设计

> **可直接交互的原型**：[`dock-prototype.html`](dock-prototype.html)，用浏览器打开即可。本章描述与它一致。

### 6.1 结构：两个独立面板，中间透明隔开

```
┌──────────────────────────────┐
│ 📁 dsh-quickdock  💬 会话  ⤢⤒✕ │  面板 A 顶栏 36px
├──────────────────────────────┤
│ QuickDock 设计文档  2 分钟前 ＋ │  会话标题行
├──────────────────────────────┤
│ ┌──────────────────────────┐ │
│ │ 发送消息或任务…           │ │  输入框（min 54px，可长到 100px）
│ └──────────────────────────┘ │
│ 🔒工作区内修改 ◈GLM-5.3 ✦高 ↑ │  功能键行
└──────────────────────────────┘
        ← 8px 真透明（透出 IDE）
┌──────────────────────────────┐
│ ● QuickDock 设计文档   ⧉⤒✕   │  面板 B 顶栏 34px
├──────────────────────────────┤
│ ✓ 读取 package.json    1.2s  │
│ ✓ bash  git status     0.3s  │
│ ✦ 思考 先看 package…    ▶    │  折叠，点开看全文
│ 正在按顺序处理：先补 CHANGELOG… │  输出
│ ◉ 编辑 CHANGELOG.md          │  ← 运行中：转圈 + 呼吸底 + 流动高光
├──────────────────────────────┤
│ 正在执行 4/5  ━━━━━  ■停止   │  状态条 + 停止
└──────────────────────────────┘
```

> 功能键里的 `🔒工作区内修改` 是默认值，实际从 `permissionPresets.catalog()` 动态渲染（见 6.4）。
> 新建对话时会多出一个 `◎` Agent 预设键（见 6.4）。

### 6.2 两种面板组合

| 场景 | 面板 A（输入） | 面板 B（执行） | 间隔 |
|---|---|---|---|
| 空闲 / 新对话 | 显示 | 隐藏 | — |
| **执行中** | **隐藏** | 显示（含停止） | — |
| 完成 / 失败 | 显示 | 显示 | 8px 透明 |
| 审批 / 选择题 | 隐藏 | 显示（含卡片） | — |
| **用户手动收起执行区** | 显示 | **隐藏** | — |

**执行时收起整个输入面板**，只保留执行流程和一个停止按钮 —— 这是"不打断 IDE"的关键。

**执行面板可手动关闭**：点执行区标题栏的 `✕`，面板 B 收起、只剩输入面板。**注意这不等于"新建对话"** —— 当前会话保持不变（标题、模型、权限都保留），只是不再看执行过程。适合任务跑完后清屏，避免长期占地方。

### 6.3 顶栏与会话切换

- **`📁 工作区`** → 下拉列出所有 Workspace（带路径）
- **`💬 会话`** → 下拉列出**该工作区**的会话（标题 + 相对时间）
- 选中工作区后自动落到它的第一个会话
- **`＋ 新对话`** → 标题行右侧，新建后标题变灰斜体「新对话」

#### 新建对话的两种模式（D2）

点「＋ 新对话」时可选：

| 模式 | 行为 | 实现 |
|---|---|---|
| **全新**（默认） | 空白会话，无上下文 | `sessions.create({ workspaceId })` |
| **从当前会话分叉** | 继承当前会话的完整历史，之后各自独立 | `sessions.fork({ sessionId })` |

- 「分叉」入口：点击「＋ 新对话」旁边的小箭头，或长按
- 仅在**已绑定某个有历史的会话**时可分叉；空白会话或无会话时该选项置灰
- 分叉后的新会话标题继承原会话并递增（DSH 的 `increaseTitle` 行为）
- **fork 是 DSH 自带能力**，不是我们实现的：`sessions.fork()` 在 Host 侧复制事件前缀，两边完全独立

> 为什么需要：dock 常用来"接着当前上下文做下一件事"。强制新建会丢掉上下文，而直接复用同一会话又会让历史越滚越长。fork 正好卡在中间。

### 6.4 功能键（用词必须与 DSH 一致）

| 键 | 显示 | 展开内容 |
|---|---|---|
| 🔒 权限 | `仅可查看` / `工作区内修改` / `完全权限` | 见下方「权限枚举」 |
| ◈ 模型 | 模型名 | 模型列表（名称 + 上下文长度） |
| ✦ 思考强度 | `低` / `高` / `最高` | DSH 原文为「思考强度」 |
| ◎ Agent | 预设名 | **只有「新对话」时出现** |

> **Agent 预设只在新建对话时可设**：已有会话的 agent 在创建时就确定了，不可更换。所以选定/绑定一个已有 Session 后，这个功能键**必须隐藏**（不是置灰）。这是 DSH 的语义约束，不是 UI 取舍。
>
> DSH 原文用「思考强度」而非「思考深度」，dock 跟随。

#### 权限枚举：**动态获取，不得写死**

权限**不是固定三项**，而是由 `permissionPresets.catalog()` 在运行时返回：

```ts
catalog(): PermissionCatalog
// PermissionCatalog = { options: PresetOption[], defaultOptions: PresetOption[], defaultPreset: string }
// PresetOption = { value, name, description? }
```

**所以 dock 必须调用 `catalog()` 渲染下拉，不能硬编码。** 当前默认组合（`@deepseek-ai/dsh-bundle-base` 的 patch）是：

| value | DSH 中文显示名 | sandbox | approval |
|---|---|---|---|
| `read-only` | **仅可查看** | `read-only` | `ask` |
| `workspace-write` | **工作区内修改** | `workspace-write` | `ask` |
| `danger-full-access` | **完全权限** | `danger-full-access` | `never` |

注意：
- 这是**默认组合**，profile 可自定义其它预设（`presets` 配置项），所以要按 `catalog()` 返回渲染。
- `current(session)` 返回 `'custom'`（`CUSTOM_PRESET`）表示当前旋钮组合不匹配任何预设，dock 要能显示这种状态。
- 切到「完全权限」时 DSH 会弹确认框（`确认启用完全权限？` + 「我已了解风险，并愿意继续」）。**dock 必须复刻这个确认**，不能静默切换。

#### 下拉菜单：矮窗口也要放得下长列表

输入窗口只有 `inputHeight` 那么高（默认 172px），而模型目录可能有几十项。
只靠「窗口内滚动」的话菜单会被裁成两三行 —— 这正是"模型下拉点开像坏了"的典型观感。
所以菜单有三层保障：

1. **搜索**：可选项 ≥ 8 时自动出现搜索框（权限 3 项这种短菜单不加，免得拥挤）。
   输入即过滤，匹配名称 / 副标题 / 分组名；标题与搜索框固定，只有列表滚动。
2. **键盘**：↑/↓、Home/End、Enter、Esc；打开时高亮落在当前选中项并滚进视野，
   这样长列表打开就能看到"我现在是哪个模型"。
3. **窗口按需长高**：放不下时页面调 `window.quickDock.setMenuSpace(extra)`，
   主进程把输入窗口**向上**撑开（**底边固定**，用户拖出来的位置不变；
   屏幕上方空间不够就按实际可用量截断），菜单关掉后 `setMenuSpace(0)` 收回。
   撑高期间页面给 `#dock` 钉住原高度并贴底（`body.menu-expanded`），
   上方多出来的区域保持透明 + 点击穿透，面板本身一像素都不动。

几何细节（见 `runtime/main.cjs` 的 `setMenuSpace`）：

- 只长高、不挪底边：新 y = 原底边 − 新高度；收回时按**当前**底边反推，
  所以菜单开着时拖动窗口也不会错位。
- 临时高度**不落盘**：`remember()` 在展开状态下记原始尺寸与位置，
  否则下次启动会是个 400px 高的空面板。
- 展示窗口贴在输入窗口上方，输入窗口长高时要跟着上移（`placeDisplayWindow`）。

### 6.5 审批卡片用词（与 DSH 一致）

| 位置 | 用词 |
|---|---|
| 标题 | `需要确认` |
| 主按钮 | `允许` |
| 次按钮 | `拒绝` |

> DSH 里 `ApprovalOutcome` 只有 `'allowed-once'`（仅本次），没有"总是允许"。dock 也不提供"总是允许"，与框架语义一致。
> 「询问 / 自动」是**审批策略**（`ApprovalPolicy: 'ask' | 'never'`），属权限预设的一部分，不单独暴露给用户。

#### 审批在哪儿答：两个窗口都能答，而且必须看得见

- **输入窗口**：运行态标题行下面直接长一块 `run-approval`（⚠ 需要确认 + 工具名 + 文案 +
  允许 / 拒绝）。用户平时盯的就是这个窗口，不能让他为了点一个按钮去别的窗口找。
- **展示窗口**：确认卡片照旧追加在步骤列表末尾；审批期间 `applyDisplayVisibility(force)`
  会**无视 `listHidden`** 强制露出来 —— 否则用户之前用 ▤ 藏了列表，就彻底没有落点。
- **接管条件**：同会话 + dock 进程在 + 窗口可见。任一条不满足就 `next()`，交回 DSH 自己的确认框；
  否则用户把窗口藏起来时，DSH 会干等 `approvalTimeoutMs`（默认 5 分钟）才超时。
- **waterfall 顺序**：`approval/request` / `user-questions/request` 的监听器必须
  `ctx.on(..., { prepend: true })`。DSH 自带审批 UI 比 profile 插件注册得早，
  不插队首的话事件先被它答掉，dock 永远收不到（表现为「权限授权没有展示」）。
- **文案**：优先 `request.displayReason.zh`（sandbox 升级时是
  「允许本次操作使用 danger-full-access 权限：…」），没有才退回 `reason`。

### 6.6 思考与输出

按 D3 采用**折叠**：思考压成一行紫色摘要，点击展开全文（限高 150px 内部滚动）；输出正常显示不加强边框。

**展开/收起是动画的，列表不重建**：工具行详情与思考全文用 `0fr → 1fr` 的网格行做高度过渡，配合 0.26s 淡入淡出；收起结束后才 `visibility:hidden`，内容不闪。行按 id 复用 DOM，状态变化只更新节点，所以「运行中自动展开、结束自动收起」不会让整张列表重播入场动画。用户手动展开的行保持展开；只有运行中自动展开时才跟随列表贴底，手动展开不抢滚动位置。

### 6.7 状态

| 状态 | 状态点 | 面板 A | 面板 B 底部 |
|---|---|---|---|
| 空闲 | 灰 | 显示 | 隐藏 |
| 运行中 | 蓝脉冲 | 隐藏 | 进度 + **停止** |
| 完成 | 绿 | 显示 | 完成摘要（无停止） |
| 失败 | 红 | 显示 | 失败原因 |
| 需要确认 | 黄 | 隐藏 | 审批卡片 |
| 断线 | 灰虚 | 禁用 | `DSH 未运行`，2s 重试 |

> 多任务：按 D14，只跟随当前绑定会话；其他会话在后台跑，状态栏提示 `另有 1 个任务运行中`。

#### 运行中步骤的动效标识

当前正在执行的那一行（`.step.run`）有四层动效叠加，周期刻意错开避免同步脉动：

| 层 | 效果 | 周期 |
|---|---|---|
| 图标 | CSS 画的圆环，品牌色顶边旋转 | 0.8s |
| 整行底色 | 品牌色淡底呼吸 | 2s |
| 左侧竖条 | 2px 品牌色，透明度脉动 | 1.4s |
| 文字 | 渐变高光从左扫过**字形本身** | 2.2s |

**文字高光的实现约束（踩过的坑）**：
用 `background-clip: text` + `text-fill-color: transparent` 让渐变成为文字填充。此时
`background-position` 的百分比是相对「背景图比元素大出的部分」计算的，**取值范围必须保证可见窗口始终落在渐变图内部**：

```
元素宽 W，背景宽 2W（background-size: 200%）
position p% → 可见窗口（背景坐标）= [W·p/100, W·p/100 + W]
要求 0 ≤ W·p/100 且 W·p/100 + W ≤ 2W  ⇒  0 ≤ p ≤ 100
```

越界（如写 `150%` / `-50%`）会让可见区落在图像外 = 透明，**文字整段消失**。

**`prefers-reduced-motion` 下必须还原文字色**：否则关闭动画后 `text-fill-color: transparent` 会让字直接不见。

### 6.8 明确不做

聊天气泡、头像、Markdown 富文本渲染、思考全文常驻展示。

---

## 7. 主题同步（与 DSH 保持一致）

dock 是**独立进程**，拿不到 DSH 页面的 CSS 变量。所以必须由 Host 把主题值传给 dock 页面。

### 7.1 能拿到什么

`ctx.theme.getTheme()` 返回 `ThemeSnapshot`：

```ts
ThemeSnapshot = {
  preference: 'light' | 'dark' | 'system',
  fontSizes:    { text, code, terminal },        // px
  fontFamilies: { text, code, terminal },
  active: { id, colorScheme: 'light'|'dark', tokens: Record<string,string> },
  themes: [...],
  revision: number
}
```

**结论：能拿到完整 token，但只该传一部分。** 整个 alias 层有 **120 个 token**（`--dsw-alias-*`），其中大量是 markdown、diff、onboarding、settings 卡片等 dock 用不到的。

### 7.2 dock 实际需要的 token（21 个）

| 用途 | token | 用在哪 |
|---|---|---|
| **背景** | `--dsw-alias-bg-base` | 面板底 |
| | `--dsw-alias-bg-layer-1` | 输入框背景 |
| | `--dsw-alias-bg-layer-2` | 卡片/下拉背景 |
| | `--dsw-alias-bg-overlay` | 浮层菜单 |
| **边框** | `--dsw-alias-border-l1` | 面板边框 |
| | `--dsw-alias-border-l2` | 输入框/卡片边框 |
| **文字** | `--dsw-alias-label-primary` | 主文本 |
| | `--dsw-alias-label-secondary` | 次文本（步骤标签、耗时） |
| | `--dsw-alias-label-tertiary` | 三级（占位符、时间戳） |
| **品牌** | `--dsw-alias-brand-primary` | 发送按钮、运行中状态点 |
| **状态** | `--dsw-alias-state-success-primary` | 完成态点、步骤 ✓ |
| | `--dsw-alias-state-error-primary` | 失败态点、步骤 ✕ |
| | `--dsw-alias-state-warn-primary` | 审批卡片 |
| | `--dsw-alias-state-idle-primary` | 空闲态点 |
| **交互** | `--dsw-alias-interactive-bg-hover` | 按钮/菜单项 hover |
| | `--dsw-alias-interactive-bg-active` | 按钮按下 |
| **滚动条** | `--dsw-alias-scrollbar-bg-l1` | 步骤流滚动条 |
| | `--dsw-alias-scrollbar-hover-l1` | 滚动条 hover |
| **其他** | `--dsw-alias-separator-primary` | 分隔线 |
| | `--dsw-alias-tooltip-bg` | 悬浮提示背景 |
| | `--dsw-alias-tooltip-key-bg` | 提示快捷键底色 |

**共 21 个**，是全量的 **17.5%**。其余近百个不传。

> 另外 `--dsw-specific-sidebar-fill` 可选传，用于输入面板顶栏与 DSH 侧栏同色。

#### 非主题变量（dock 自有，不来自 DSH）

这些是 dock 自己的语义层，按 `colorScheme` 在深浅两套间切换，**不由 Host 注入**：

| 变量 | 用途 |
|---|---|
| `--qd-fill-subtle` / `-weak` / `-soft` / `-mid` / `-strong` | 卡片底、hover 层的半透明填充（深色白色叠加 / 浅色黑色叠加） |
| `--qd-run-row-bg` / `-bg-hi` | 运行中整行呼吸底色（两个状态） |
| `--qd-run-ring-track` | 运行中转圈环的轨道色 |
| `--qd-run-shine-strong` | 文字流动高光的峰值色 |

> 这层不传的原因是：它们表达的是「叠加透明度」，DSH 的 token 里没有对应项，且必须随深浅模式反转（白色叠加 ↔ 黑色叠加）。dock 自己维护更稳。

### 7.3 怎么传

Host 侧在 `/quickdock` 页面注入 `<style>`（服务端渲染，dock 无需额外请求）：

```html
<style>
  :root {
    --qd-bg-base: #1b1b1c;
    --qd-bg-layer-1: #232324;
    /* … 共 21 个 */
  }
</style>
```

- 前缀用 `--qd-*` 而非 `--dsw-*`，避免与 dock 自身变量撞名
- dock 的 CSS 全部引用 `var(--qd-*)`
- **首屏即有值**，不会闪白

### 7.4 深浅模式

`active.colorScheme` 给出 `'light'` 或 `'dark'`，写进 `<html data-theme="dark">`。
`preference` 为 `'system'` 时，Host 已按 OS 解析成实际 `colorScheme`，dock 不重复判断。

### 7.5 监听切换

`theme/change` 携带新快照。Host 监听后通过 **SSE 推送**给 dock：

```
event: theme
data: { "colorScheme": "light", "tokens": { "--qd-bg-base": "#fff", ... } }
```

dock 收到后重写 `:root` 变量，**无需刷新页面**。

### 7.6 字体

`fontSizes` / `fontFamilies` 一并传：

| role | 用途 |
|---|---|
| `text` | 步骤标签、输出正文 |
| `code` | 命令、路径（等宽） |
| `terminal` | **不传**（dock 无终端） |

字体族可能本身就是字体栈字符串，直接串到 `--qd-font-*`。

### 7.7 兜底

任一 token 取不到时，dock 用内置的浅/深两套默认值（就是原型那套色，按 `colorScheme` 二选一）。
**不允许因为缺 token 导致不可读** —— 宁可整体回落默认主题，也不要半套色。

---

## 8. 配置项

```yaml
- id: quickdock
  name: dsh-quickdock
  config:
    enabled: true
    # 窗口
    anchor: bottomRight        # topLeft|topRight|bottomLeft|bottomRight|topCenter|bottomCenter
    width: 360                 # 固定宽度，容纳 4 个功能键
    maxHeight: 560             # 高度自适应，封顶
    margin: 16
    rememberGeometry: true
    alwaysOnTop: false         # 默认不置顶；用户点「⤒」开启，选择被记住
    focusOnSummon: false       # 呼出不抢焦点
    hideOnEscape: true
    hotkey: null               # v1 不绑；后续版本支持
    autoLaunch: true
    # 会话
    sessionMode: new           # new=默认新建（可选切已有）；bind=固定绑定某个
    followBoundOnly: true      # 只跟随当前绑定会话的任务，其他会话后台跑不显示
    defaultWorkspaceId: null   # 下拉框的默认选项；null=上次使用的
    agentPreset: null
    model: null
    submitMode: queue          # queue=排队 / steer=插话
    # 展示
    thinkMode: fold            # fold=折叠(默认) / full=全展示 / min=极简
    showTiming: true
    showTokenUsage: false
    maxSteps: 200
    # 主题
    themeSync: true            # 跟随 DSH 主题（21 个 token + 字体）
    themeFallback: auto        # auto=按 colorScheme 用内置默认；light|dark=强制
    # 入口
    headerButton: true         # 在会话标题栏显示「推到 dock」按钮
    headerButtonOrder: 1010
    sessionMenu: false         # 是否也在会话右键菜单里加一项
```

---

## 9. 安全、生命周期、限制

**安全**
- 接口只绑回环 + `Bearer` token（仅内存 + argv）
- dock 不做远程访问
- 插件不新增 agent 工具，指令走与主窗口相同通路，权限策略完全继承

**生命周期**
- DSH 启动 → 插件激活 → spawn dock → 常驻角落
- DSH 退出 → dispose → 终止 dock
- dock 被手动杀掉 → 1s/2s/4s 退避重拉（最多 5 次）

**已知限制**
1. **内存约 300MB**（Electron 固有代价，含 GPU 进程；与 DSH 主窗口共享 Chromium 代码页，实际增量更低）。
2. **首次运行需下载 Electron**（~100MB，走 npmmirror）。离线环境需预置 `$DSH_HOME/electron/` 或设 `DSH_QUICKDOCK_ELECTRON_PATH`。
3. 插件更新后需**重启 DSH** 加载新 Host JS。
4. `dsh://` 深链只支持 `dsh://open`，**不支持定位到具体 session**。独立窗口点 `⧉` 需配合 Host 侧"待打开"标记让主窗口读取。
5. 独立窗口不在 DSH 客户端运行时内，拿不到插槽 props 和主题令牌 → 输入框与步骤流需自建（视觉对齐 DSH，但不是同一份代码）。
6. 一个 Session 只有一个 Lexical 编辑器：dock 与主窗口**不能同时编辑**同一会话。dock 作为"另一个入口"没问题（同一时刻只有一个在输入）。
7. v1 只做 Windows。macOS/Linux 需各自验证 Electron 下载路径与窗口行为。

---

## 10. 决策状态

### 已定

| # | 决定 | 结论 |
|---|---|---|
| D1 | 窗口技术栈 | **Electron**，实现对齐 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet) |
| D2 | 新建会话 | 支持 DSH 自带的 **fork**（从当前会话分叉），新建时可选 |
| D3 | 思考/输出 | **折叠**：思考压成一行紫色摘要，点击展开（限高 150px）；输出正常显示 |
| D4 | 尺寸 | 宽 **360px**，高度自适应（最小 280 / 最大 560），右下角，边距 16 |
| D5 | 唤出方式 | **v1 不绑全局热键**，从 DSH 侧栏「QuickDock」按钮激活。热键留到后续版本 |
| D6 | 审批与提问 | **dock 内直接完成**（审批卡片 / 选择题 / 自由文本），用词对齐 DSH：`需要确认` `允许` `拒绝` |
| D7 | 视觉 | 跟随 DSH 主题，圆角 12，不透明深色 |
| D8 | 跟随主窗口 | **不跟随**，只显示 dock 自己的会话（与 D14 一致） |
| D9 | dock 形态 | **独立窗口**（Electron 真顶置）。**但顶置不是默认开启**，需用户点「⤒」按钮 |
| D10 | 会话语义 | **默认新建 + 可选已有**；从「推到 dock」进来则直接绑定 |
| D11 | 工作空间 | 顶部**下拉框**，列出所有 Workspace，记住上次选择 |
| D12 | 推到 dock 按钮 | `conversation.session.header.actions`，`order: 1010`（排在 `dsh-rewind` 之后） |
| D13 | 窗口形态 | **圆角矩形卡片** 360px，圆角 12px，不透明 |
| D14 | 多任务并发 | `followBoundOnly`：**只跟随当前绑定会话**，其他后台跑不显示 |

> **D9 补充**：窗口默认**不置顶**。用户点标题栏的「⤒」才开启顶置，再点关闭。这个选择要记忆（存 `window.json`），但**首次安装默认 `false`**。

> **D5 补充**：唤出入口是 `sidebar.footer.action`（侧栏底部，设置旁），`cordis-panel` 已有先例。dock 的 `✕` 是 `hide()` 而非退出进程，所以按钮能瞬间唤回。

### 待定

**无。** 14 项决策全部确定。

### 已列为正式任务（必须实现）

| 任务 | 要求 |
|---|---|
| **窗口位置记忆的持久化格式** | 存 `%LOCALAPPDATA%\dsh-quickdock\window.json`，含 `anchor` / `x` / `y` / `width` / `height` / `displayId` / `alwaysOnTop`。启动时读取，越界（如显示器拔掉）则回落到主屏右下角。 |
| **首次安装 Electron 下载提示** | 下载 ~100MB，走 npmmirror 镜像。控制台输出进度（比例 + 已下载/总量）。失败时给出明确原因 + 可设置的 `DSH_QUICKDOCK_ELECTRON_PATH`，且**只影响桌面模式**，Web 形态照常可用。 |
| **侧栏唤出入口** | 注册到 `sidebar.footer.action`，展开态显示图标+文字，收起态只显示图标。dock 未运行则拉起，已运行则 `show()` 到前台。右键菜单提供「退出 QuickDock」。 |
| **主题同步** | 从 `ctx.theme.getTheme()` 取 **21 个 alias token** + `colorScheme` + `text`/`code` 字体，注入 `/quickdock` 为 `--qd-*` 变量；监听 `theme/change` 经 SSE 推送更新。缺值回落内置浅/深两套默认色。详见第 7 节。 |

### 待定（不阻塞开发，实现时顺手决定）

- 断线重连的退避参数
- 卸载时是否清理 `$DSH_HOME/electron`

---

## 11. 目录结构

```
dsh-quickdock/
├─ DESIGN.md                 ← 本文档
├─ package.json              ← bundle 清单
├─ cordis.patch.yml
├─ index.js                  ← Host 插件：路由/折叠/Electron 解析/拉起/守护
├─ client.js                 ← Client 插件：会话标题栏「推到 dock」按钮
├─ locale/{en,zh}.json
├─ icon.svg
├─ scripts/
│  └─ ensure-electron.mjs    ← 首次运行下载 Electron（照 dsh-pet）
├─ web/
│  ├─ index.html
│  └─ app.js
└─ dock/                     ← dock 进程（Electron 主进程）
   ├─ main.js                ← 窗口/锚点/穿透/记忆（~350 行）
   ├─ preload.js
   └─ package.json           ← 无 electron 依赖（运行时解析）
```

**安装**：`plugin_manager install_bundle` 指向本目录。
首次激活时检查 `$DSH_HOME/electron/electron.exe`，没有则后台下载（约 100MB，走 npmmirror，控制台显示进度）。

---

## 12. 分阶段实施

| 阶段 | 内容 | 验收 | 预估 |
|---|---|---|---|
| **P0** | Host 插件骨架 + `/quickdock` 页面 + 假数据 **+ 主题注入** | 浏览器打开看到 6 状态界面；深浅两种主题都正确 | 0.5 天 |
| **P1** | 真实数据：建 Session、投 prompt、折叠、SSE、fork | 浏览器里发指令，步骤流实时跟跑 | 1 天 |
| **P2** | Electron 解析 + dock 进程：窗口/锚点/穿透/记忆/侧栏唤出 | 侧栏点击 → 角落浮出 → 跑完 → 收起 | 1.5 天 |
| **P3** | Client 侧：「推到 dock」按钮 + 侧栏入口 | DSH 里点按钮 → dock 切到该会话；主窗口同步可见 | 0.5 天 |
| **P4** | 打磨：小条、跳主窗口、停止、断线、多屏、错误态、主题热切换 | 手测清单全过 | 1 天 |

合计约 **4.5 个工作日**（Electron 解析/下载/守护占 0.5 天，主题注入并入 P0）。

---

## 13. 实现时要现验的点（诚实列出）

1. **Host 内部创建 Agent 投递 prompt 的入口**：`agentLoop.createAgent` / `sessions.prepare+enter+announce` + `agent.followup()` 都可能，但 `@Remote` 装饰的方法从 Host 内部调可能绕不过 peer 校验。需用 `cordis_inspect_query` 逐字段确认。**这是 P1 的第一件事。**
2. **Electron 下载在离线/受限网络下的降级**：`@electron/get` 失败时要给出清晰提示，并让 Web 形态继续可用。需测镜像不可达时的行为。
3. **`app.setName()` 时机**：必须在任何 `app.getPath('userData')` 之前，否则 userData 会落到 `%APPDATA%\Electron`。dsh-pet 明确踩过，照做并验证。
4. **`showInactive()` 是否真的不抢焦点**：Windows 上需实测；若仍抢焦点，改用 `SetWindowPos` + `SWP_NOACTIVATE`。
5. **透明窗口与 `disableHardwareAcceleration` 的取舍**：关硬件加速修了黑边，但可能影响渲染性能。需在圆角卡片形态下测是否必须关。

---

## 14. 参考实现

- [dsh-pet](https://github.com/PC2005-cloud/dsh-pet) — DSH 插件 + 自下载 Electron（**主要参考**）
- [kun-pet-desktop](https://github.com/anticipate218/kun-pet-desktop) — 标准 Electron 应用
- [workbuddy-pet](https://github.com/Hetu-108/workbuddy-pet) — Electron 透明置顶窗
- [dsh-remote](https://github.com/mrRisega/dsh-remote) — HTTP/WS 全量透传（协议层参考）
