# dsh-quickdock

DeepSeek Harness（DSH）插件：常驻屏幕角落的 QuickDock。

在 DSH 会话标题栏点 **Dock**，唤起两个无边框透明窗口：

- **输入窗口** —— 绑定的工作区/会话、输入框，以及四个功能键
  （权限、模型、思考强度、Agent 预设）
- **执行过程窗口** —— 贴在输入窗口上方或下方，按行展示当前这一轮
  （思考、工具调用、回复）

两个窗口都能拖动，执行过程窗口实时跟随。审批与结构化提问直接在 dock 里完成，
不必回主窗口。

界面为双语（英文 / 简体中文），跟随 DSH 语言。

## 环境要求

- Windows 10/11
- Node.js 20+
- DSH ≥ 0.2.0

## 安装

```bash
npm install
```

这一步不能跳过：宿主半需要 `@deepseek-ai/schemastery` 定义配置 schema，
并在需要桌面模式时用 `@electron/get` 下载 Electron。

第一次点 **Dock** 会下载 Electron（约 100 MB，走 npmmirror 镜像，只需一次），
落到 `%LOCALAPPDATA%\dsh-quickdock\electron\<版本>\`。想提前准备：

```bash
node scripts/ensure-electron.mjs
# 或者指定现成的 Electron
set DSH_QUICKDOCK_ELECTRON_PATH=D:\path\to\electron.exe
```

在 DSH profile 里挂上插件（条目见 `cordis.patch.yml`）：

```json
{ "dsh-quickdock": "link:D:/node/dsh-quickdock" }
```

## 用法要点

- **dock 显示哪个会话，只由 DSH 决定**：在会话标题栏点 **Dock**。
  dock 自己不切换会话。
- 标题行里的**工作区标签只读**：交代下一条消息发到哪个工作区。
- **↗** 在 DSH 主窗口打开当前会话（dock → 宿主 API → 命令总线 → client 半 →
  `ctx.uiWorkspace.openSession`）。
- **▤** 显示 / 隐藏执行过程窗口。隐藏是临时的（两小时后自动恢复）。
- **⤒** 两个窗口一起顶置，不会出现「面板钉住、列表被盖住」。
- **＋** 解除绑定并新建空白会话；**Shift/Alt + ＋** 从当前会话分叉（DESIGN D2）。
- 四个功能键都是下拉菜单。长列表（模型）自带搜索框、键盘导航，并把窗口
  **临时向上撑高**，而不是把列表裁成两三行。
- Agent 运行期间输入窗口切到运行态：已运行时长、当前动作、逐字正文和 **停止**。
  审批也在那里，直接给 **允许 / 拒绝**。

## 国际化

所有界面文案都在 `locale/en.json` 与 `locale/zh.json`（扁平点号键，占位符写作
`{name}`）。

- **语言解析顺序**：`config.locale`（`auto` | `en` | `zh`）优先；否则用 DSH
  client 半上报的语言（它跟随 DSH 的语言设置）；在此之前用操作系统语言。
- **dock 页面**收到 `window.__QD_I18N__ = { locale, messages }`（当前语言目录
  叠加在英文之上）以及本地化的 `<html lang>`。静态标记用 `data-i18n`、
  `data-i18n-title`、`data-i18n-aria-label`、`data-i18n-placeholder`；
  动态文案调用 `t('key')`。
- **切换语言是实时的**：宿主广播 `locale` SSE 事件，两个窗口无需刷新即可换文案。
- **client 半**：静态 client bundle 读不到文件，因此内嵌一份小目录
  （标记为 `i18n-catalog`）；`npm run check` 会校验它与 JSON 目录一致。
- **宿主错误信息**同样本地化，dock 不会中英混排。

新增语言：添加 `locale/<id>.json`，在 `runtime/i18n.js` 的
`SUPPORTED_LOCALES`（以及 client 内嵌目录）里登记，然后跑 `npm run check`。

## 目录结构

```
index.js               插件入口：name、inject、Config schema、apply()
host/                  宿主半（一个模块一个职责）
  quickdock-host.js    组合根：装配服务、路由、事件、定时器
  api.js               /quickdock/api/* 路由表
  bridge.js            /api/quickdock：供 client 半调用的动作表
  catalogs.js          权限 / 模型 / Agent 目录
  dsh.js               DSH 服务适配层（可选服务缺失也不抛错）
  dock-process.js      Electron 进程守护：spawn、控制通道、退避重启
  electron-resolver.js Electron 探测、解析与下载
  event-hub.js         SSE 中枢（页面状态流 + 浏览器命令总线）
  interactions.js      审批 / 提问 broker
  locale.js            语言控制器与页面目录
  page.js              把资源、主题、文案内联成单个 HTML
  session-index.js     会话标题仓库（含冷会话）
  snapshot.js          state 快照的唯一出处
  stream-buffer.js     逐字流折叠
  theme.js             DSH alias token → dock CSS 变量
  trace.js             host.log 写入
client.js              client 半：标题栏 Dock 按钮、主题/语言同步、命令总线
runtime/               Electron 主进程（CommonJS，无构建步骤）
  main.cjs             窗口、透明、点击穿透、菜单长高
  preload.js           带校验的 contextBridge API
  config.js            命令行 / 环境变量 / 内联 JSON 配置
  geometry.js          位置恢复与夹回屏幕
  step-folder.js       session/event → 行（策略表，有单测）
  protocol.js          宿主 ↔ dock 行协议
  window-store.js      防抖 + 原子写 window.json
  i18n.js              共享目录加载与翻译器
  test/                单元测试（node:test）与测试夹具
web/                   页面资源，由宿主按 manifest.json 顺序内联
  locale.js            页面 i18n 运行时（data-i18n + t）
  markdown.js          先转义再渲染的 Markdown
  util.js              DOM / 文本工具
  display.js           执行过程窗口视图（行、流式块、卡片）
  menu.js              下拉菜单（搜索、键盘、窗口长高）
  app.js               页面引导：SSE、渲染、功能键、命中区
  styles.css           样式（只引用主题变量）
locale/                en.json、zh.json 文案目录
scripts/               工具：测试、检查、冒烟、调试宿主、Electron
```

## 质量闸门

```bash
npm test        # 单元测试（node:test，单进程）
npm run check   # i18n 对齐、键引用、CJK/空白规范、web manifest
npm run smoke   # 起 mock 宿主，探页面、API 与语言切换
npm run verify  # 以上三项全跑
npm run lint    # ESLint（dev 依赖）
```

`scripts/check.mjs` 刻意零依赖：校验每个被引用的文案键都存在、两份目录键与占位符
一致、client 内嵌目录与 JSON 一致、CJK 只出现在 locale 文件里，以及源码保持
UTF-8 / LF、无制表符和行尾空格。

## 本地调试

```bash
node --import ./scripts/register-hook.mjs scripts/dev-harness.mjs
```

调试宿主提供假的 `ctx` 与假 DSH 服务，打印带 token 的页面地址，并提供
`/test/*` 辅助接口（查看调用、注入会话事件、触发审批、推送主题/语言）。

- `QD_PORT=45999` 固定端口
- `QD_NO_ELECTRON=1` 只验证 API 层，不拉起 Electron
- `&view=display` 用普通浏览器打开执行过程窗口
- `POST /test/locale {"locale":"zh"}` 切换 dock 语言

## 诊断

| 日志 | 内容 |
| --- | --- |
| `%LOCALAPPDATA%\dsh-quickdock\host.log` | Electron 候选与探测、spawn 参数、ready/退出码、API 失败 |
| `%LOCALAPPDATA%\dsh-quickdock\dock.log` | 窗口创建、几何、控制通道、收到的命令 |

宿主半不静默失败：失败原因会以提示条显示在页面上。

| 环境变量 | 作用 |
| --- | --- |
| `DSH_QUICKDOCK_ELECTRON_PATH` | 指定 Electron 可执行文件（跳过下载与探测） |
| `DSH_QUICKDOCK_ELECTRON_VERSION` | 要下载的版本（默认 44.7.0） |
| `DSH_QUICKDOCK_DISABLE_GPU=1` | 关硬件加速（透明窗口异常时用） |
| `DSH_QUICKDOCK_NO_CLICK_THROUGH=1` | 关闭点击穿透 |
| `DSH_QUICKDOCK_GPU_SANDBOX=1` | 保留 GPU 沙箱 |

### 常见故障

| 现象 | 原因 / 处理 |
| --- | --- |
| 点 Dock 后提示「Electron 不可用」 | 没跑 `npm install`，或安全软件拦了 Electron；按提示处理或设 `DSH_QUICKDOCK_ELECTRON_PATH` |
| 窗口出现但内容不更新 | SSE 401：EventSource 不能带请求头，`/api/stream` 必须同时接受 `?t=` |
| 权限/模型点了没反应 | 未绑定会话时先记在 state、发送时应用；已绑定会话立即写入 |
| 审批弹在 DSH 里、没弹在 dock 上 | 看 `host.log` 里有没有 `approval -> dock:`；窗口被藏起来时会主动交回 DSH |
| 下拉菜单只显示两三行 | 菜单会让窗口向上长高；顶着屏幕上沿时只能长到屏幕边（`dock.log`: `menu space:`） |
| 点 Dock 后进程刚起就退出、页面一直等到超时 | 探测能过的 Electron 仍可能被安全软件拦住、写不了用户目录（常见于项目在桌面时）。宿主优先用 `%LOCALAPPDATA%\dsh-quickdock\electron\<版本>`，失败会自动换下一个候选；全都不行时提示条会显示最后一行 stderr。必要时把 `DSH_QUICKDOCK_ELECTRON_PATH` 指到可用的 electron.exe |
| 首次点击要等一分钟 | 正在下载 Electron，界面会提示 |

设计细节见 [DESIGN.md](./DESIGN.md)（中文设计文档）与交互原型 `dock-prototype.html`。
