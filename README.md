# dsh-quickdock

DeepSeek Harness（DSH）插件：常驻桌面角落的 QuickDock。

点 DSH 侧栏的 Dock 按钮，唤起两个无边框透明窗口：

- **输入窗口** — 工作区/会话选择 + 输入框 + 权限/模型等功能键
- **展示窗口** — 贴在输入窗口上边或下边，按行展示当前这一轮的执行过程（思考、工具调用、回复）

两个窗口都可以拖动，展示窗口实时跟随输入窗口移动，并在空间不足时自动翻到另一侧。

## 安装

```bash
npm install
```

`electron` 是可选依赖，首次启动时由 `scripts/ensure-electron.mjs` 下载到
`%LOCALAPPDATA%\dsh-quickdock\electron\<版本>\`（不放桌面或项目目录，避开杀软误报）。

在 DSH 配置里把它加进插件列表即可，条目见 `cordis.patch.yml`。

## 环境要求

- Windows 10/11
- Node.js 20+
- DSH ≥ 0.2.0

## 结构

```
index.js             宿主半：路由 / API / 事件折叠 / spawn dock 进程
client.js            客户端半：侧栏按钮
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
  styles.css         样式
scripts/
  ensure-electron.mjs  Electron 下载与校验
```

## 测试

```bash
cd runtime && node --test "test/**/*.test.js"
```

## 调试

宿主日志：`%LOCALAPPDATA%\dsh-quickdock\host.log`
窗口日志：`%LOCALAPPDATA%\dsh-quickdock\dock.log`

环境变量：

| 变量 | 作用 |
| --- | --- |
| `DSH_QUICKDOCK_DISABLE_GPU=1` | 关闭硬件加速（透明窗口异常时用） |
| `DSH_QUICKDOCK_NO_CLICK_THROUGH=1` | 关闭点击穿透 |
| `DSH_QUICKDOCK_GPU_SANDBOX=1` | 保留 GPU 沙箱 |

详细设计见 [DESIGN.md](./DESIGN.md)。
