# dsh-quickdock

DeepSeek Harness（DSH）插件：常驻桌面角落的 QuickDock。

点 DSH 会话标题栏的 **Dock** 按钮，唤起两个无边框透明窗口：

- **输入窗口** — 工作区/会话选择 + 输入框 + 权限/模型/思考/Agent 等功能键
- **展示窗口** — 贴在输入窗口上边或下边，按行展示当前这一轮的执行过程（思考、工具调用、回复）

两个窗口都可以拖动，展示窗口实时跟随输入窗口移动，并在空间不足时自动翻到另一侧。
审批与结构化提问会以卡片形式出现在展示窗口里，不用回主窗口。

## 环境要求

- Windows 10/11
- Node.js 20+
- DSH ≥ 0.2.0

## 安装

```bash
npm install
```

这一步**不能跳过**：宿主半用 `@electron/get` + `@electron-internal/extract-zip`
在需要时下载 Electron，用 `@deepseek-ai/schemastery` 定义配置 schema。

第一次点 Dock 时会下载 Electron（约 100MB，走 npmmirror 镜像，只需一次），
落到 `%LOCALAPPDATA%\dsh-quickdock\electron\<版本>\`（不放桌面或项目目录，避开杀软误报）。
想跳过下载可以提前跑：

```bash
node scripts/ensure-electron.mjs
# 或者直接指定现成的 Electron
set DSH_QUICKDOCK_ELECTRON_PATH=D:\path\to\electron.exe
```

在 DSH 侧把它加进 profile 的 bundle 列表即可，条目见 `cordis.patch.yml`：

```json
{ "dsh-quickdock": "link:D:/node/dsh-quickdock" }
```

## 用法要点

- **dock 显示哪个会话，只由 DSH 决定**：在 DSH 里点某个会话标题栏的 **Dock** 才绑定过去。
  dock 里不提供会话/工作区切换 —— 那件事 DSH 侧栏本来就做得更好。
- 标题行里的**工作区标签是只读的**，只用来交代"这条消息会发到哪个工作区"（不占额外一行）。
  想换会话：回 DSH，点另一个会话的 Dock。
- 标题行右侧的 **↗**：**在 DSH 主窗口里打开当前会话**（两个窗口都有）。
  链路是 dock → 宿主 API → 宿主 SSE 总线 → client 半（浏览器插件）
  → `ctx.uiWorkspace.openSession(sessionId)`，所以是立即可见、不用切窗口。
- 标题行右侧的 **▤**：显示 / 隐藏执行过程窗口（两个窗口共享这个状态，
  2 小时后自动恢复显示，免得忘记点回来）。执行过程窗口自己也带这条工具条
  （状态 + ↗ + ⤒ + ▤），内容再长也不会被滚走。
- 两个窗口**层级联动**：点任意一个，另一个会被提到同一层，
  不会出现"输入窗口升到最前、执行过程还压在别的应用后面"的错位。
- 标题行右侧的 **＋**：解除绑定、留在当前工作区，下一条消息会在该工作区新建会话。
- Shift/Alt + 点 **＋** = 从当前会话分叉（DESIGN D2）。

## 实时流式

执行期间输入窗口会切到「运行态」：状态点、已运行时长、当前动作、已完成/失败计数，
以及**正在逐字输出的内容**（思考阶段紫色、正文白色、带闪动光标）。

展示窗口在步骤列表末尾追加一个流式块：上面是思考链（紫），下面是正文，逐字增长。
消息一旦落库，这个临时块立刻消失，换成正式的步骤行 —— 不会出现两份。

数据来自 `agent/assistant-stream`（进程内事件，含 `reasoning-delta` / `text-delta` /
`tool-call-delta`），不是 `session/event`：后者只在消息**提交后**才有内容，
光靠它只能一条条"蹦"出来。推送按 100ms 合并，页面按"结构签名"决定是否重建 DOM，
所以逐字刷新时不会闪、也不会打断滚动。

**工具行同理**：执行中自动展开（显示格式化后的完整参数），拿到结果后自动折叠成一行，
点一下可再展开看「参数 + 输出」。详情不随 state 推送（逐字流会把包撑大），
展开时才按行 id 向宿主取：`GET /quickdock/api/step-detail?id=tool-…`。

### 正文的 Markdown

最终回复按 Markdown 渲染（`web/markdown.js`，零依赖，约 180 行）：
标题、列表、代码块、引用、表格、行内代码、粗斜体、删除线、链接都能出。
**流式阶段仍然是纯文本** —— 半截的代码围栏或不闭合的 `**` 渲染出来只会更乱，
落库后再整段转成 Markdown。

安全做法是先整体转义再拼 HTML，所以模型输出里的 `<script>`、`<img onerror>`
只会显示成文字；链接只接受 `http(s)`，点击由主进程交给系统浏览器打开。

## 第一次验证「按钮到底能不能用」

1. 重启 DSH（或让 profile 重新加载插件）。
2. 打开任意会话，点标题栏的 **Dock**。
3. 1–2 秒后屏幕右下角出现输入窗口；展示窗口在它上方，没有内容时隐藏。

出问题时按顺序看这两份日志（都会自建目录）：

| 日志 | 说明 |
| --- | --- |
| `%LOCALAPPDATA%\dsh-quickdock\host.log` | 宿主半：Electron 候选路径、探测结果、spawn 参数、ready、退出码 |
| `%LOCALAPPDATA%\dsh-quickdock\dock.log` | Electron 侧：窗口创建、几何、控制通道端口、收到的命令 |

宿主半**不静默失败**：起点在 `host.log`，界面右下角也会弹出带原因的提示。

## 宿主半接了什么

| DSH 能力 | 用法 |
| --- | --- |
| 页面托管 | `ctx.webServer.register({ kind:'prefix', path:'/quickdock' })` |
| 浏览器入口 | `ctx.connection.fetch.register({ path:'/api/quickdock' })`（bind / summon / status / theme / web-url） |
| 任务提交 | `sessionController.create | fork` → `selectModel` → `prompt` |
| 权限预设 | `permissionPresets.catalog()` 取目录，`permissionPresets.set(session, name)` 真写进会话 |
| 模型 / 思考强度 | `sessionController.modelCatalog()` 取目录，`selectModel({ reasoningEffort })` 落库 |
| Agent 预设 | `agentPresets.list()`，新建会话时作为 `agentPreset` 传给 `create` |
| 工作区 / 会话 | `workspaceRegistry.list()`、`sessions.get()`、`agents.get()` |
| 步骤流 | 只读订阅 `session/event`，折成展示行；`GET /quickdock/api/stream` SSE 推送 |
| 审批 / 提问 | waterfall 拦截 `approval/request` / `user-questions/request`，仅限 dock 绑定会话 |
| 主题 | 主题只存在于浏览器端，由 **client 半** 把 21 个 alias token POST 给宿主，宿主映射成 `--qd-*` 并广播 |
| 打开会话 | `GET /quickdock/api/bus`（宿主 → 浏览器的 SSE 命令总线），client 半订阅后调 `ctx.uiWorkspace.openSession()` |

**硬约束**：只读 `session/event`，绝不写新事件类型（DSH 规定未知类型会让会话无法重开）。

## 结构

```
index.js             宿主半：路由 / API / 事件折叠 / spawn dock 进程
client.js            客户端半：标题栏 Dock 按钮 + 主题同步
runtime/
  main.cjs           Electron 主进程：窗口创建、点击穿透、拖拽跟随
  preload.js         IPC 桥
  config.js          启动参数解析
  geometry.js        窗口几何（位置恢复、夹回屏幕）
  step-folder.js     把 session/event 折成展示行（纯逻辑，有单测）
  window-store.js    窗口位置落盘
  protocol.js        宿主 ↔ dock 的行协议
web/
  index.html         输入窗口
  display.html       展示窗口
  app.js             两个窗口共用的页面逻辑
  styles.css         样式（末尾是视觉打磨覆盖层）
scripts/
  ensure-electron.mjs  Electron 下载与校验
  dev-harness.mjs      本地调试宿主：假 ctx + 假 DSH 服务，把宿主半真跑起来
```

## 测试

```bash
cd runtime && node --test "test/**/*.test.js"
```

`test/host.test.js` 覆盖宿主半的装配、页面/接口鉴权、token 与主题采纳规则；
`test/step-folder.test.js` 等覆盖折叠与几何等纯逻辑。

## 本地调试（不启动完整 DSH）

```bash
node --import ./scripts/register-hook.mjs scripts/dev-harness.mjs
```

它会用假的 `ctx` 与假 DSH 服务把 `index.js` 跑起来，打印带 token 的页面地址，
并提供 `/test/*` 辅助接口（查看 mock 调用、注入会话事件、触发审批请求、推主题）。

- `QD_PORT=45999` 固定端口
- `QD_NO_ELECTRON=1` 只验证 API 层，不 spawn Electron
- 页面直接开浏览器也能看：`<地址>&view=display` 是展示窗口

## 调试

宿主日志：`%LOCALAPPDATA%\dsh-quickdock\host.log`
窗口日志：`%LOCALAPPDATA%\dsh-quickdock\dock.log`

环境变量：

| 变量 | 作用 |
| --- | --- |
| `DSH_QUICKDOCK_ELECTRON_PATH` | 指定 Electron 可执行文件（跳过下载与探测） |
| `DSH_QUICKDOCK_ELECTRON_VERSION` | 指定要下载的 Electron 版本（默认 44.7.0） |
| `DSH_QUICKDOCK_DISABLE_GPU=1` | 关闭硬件加速（透明窗口异常时用） |
| `DSH_QUICKDOCK_NO_CLICK_THROUGH=1` | 关闭点击穿透 |
| `DSH_QUICKDOCK_GPU_SANDBOX=1` | 保留 GPU 沙箱 |

### 常见故障

| 现象 | 原因 / 处理 |
| --- | --- |
| 点 Dock 后提示「Electron 不可用」 | 没跑 `npm install`，或安全软件拦了 Electron 启动；按提示装依赖或设 `DSH_QUICKDOCK_ELECTRON_PATH` |
| 窗口出现但内容不更新 | SSE 401：`/quickdock/api/stream` 只认 Bearer 头，而 EventSource 不能带头，所以必须同时接受 `?t=` |
| 权限/模型点了没反应 | 会话未绑定时会先记在 state，发送时才随 `create` 落下；绑定已有会话会回读真实值 |
| 首次点击要等一两分钟 | 正在下载 Electron，界面会提示；之后是秒开 |

详细设计见 [DESIGN.md](./DESIGN.md)。
