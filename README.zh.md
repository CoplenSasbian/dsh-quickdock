# dsh-quickdock

DeepSeek Harness（DSH）插件：把 **DSH 自己的 Web UI** 装进一个常驻小窗，浮在其他窗口之上。

在会话标题栏点 **Dock**，Electron 窗口打开当前这个对话；窗口里是完整的 DSH 界面
（对话、工具卡片、审批、模型/权限切换），所以它的行为和主窗口永远一致。

```
主窗口 [Dock] ──► Host 绑定会话 ──► Electron 窗口
                                      │
                          外壳页 localhost:47910（标题栏 + iframe）
                                      │
                          iframe ──► DSH Web UI（?dock=1）
```

## 特性

- **就是 DSH 本身**：不再自绘对话界面，跟随 DSH 版本，新功能自动出现；
- **跟着对话走**：点 Dock 时绑定的是你正在看的会话，dock 窗口会切过去；
- **标题栏**：拖拽移动、侧栏开关（展开时铺满整窗，选会话后自动收起）、置顶、
  系统关闭/最小化按钮；
- **无鉴权、端口可改**：默认 `http://127.0.0.1:47910`（设置 → QuickDock 里可改），
  其他本地客户端（IDE 的 webview）也能直接加载；
- 双语界面跟随 DSH 语言。

## 环境要求

- Windows 10/11
- Node.js 20+
- DSH ≥ 0.2.0

## 安装

```bash
npm install
```

宿主半需要 `@deepseek-ai/schemastery` 定义配置 schema；桌面窗口需要 Electron。

第一次点 **Dock** 会下载 Electron（约 100 MB，走 npmmirror 镜像，只需一次），
落到 `%LOCALAPPDATA%\dsh-quickdock\electron\<版本>\`。想提前准备：

```bash
node scripts/ensure-electron.mjs
# 或者指定现成的 Electron
set DSH_QUICKDOCK_ELECTRON_PATH=D:\path\to\electron.exe
```

在 DSH 里安装（插件管理页选本地包，或）：

```bash
dsh plugin install C:\path\to\dsh-quickdock
```

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `port` | `47910` | 壳页与 API 的回环端口。在 设置 → QuickDock → 连接 里改，点 **应用并重启**：监听重新绑定、窗口在新地址重开；`0` 关闭监听 |
| `windowControls` | `custom` | `system` = 用系统关闭/最小化按钮（推荐） |
| `clickThrough` | `true` | 嵌入外部页面时应设 `false` |
| `width` / `inputHeight` | `480` / `820` | dock 窗口尺寸 |
| `alwaysOnTop` | `false` | 默认置顶与否（标题栏 📌 可随时切换） |
| `autoLaunch` | `false` | 随插件启动窗口；关闭时点 Dock 才启动 |
| `prefetchElectron` | `true` | 挂载时就准备 Electron，首次点击不用等 |
| `rememberGeometry` | `true` | 记住窗口位置 |
| `ballSize` | `64` | 收起的悬浮鲸鱼球直径（24–160） |
| `headerButton` / `headerButtonOrder` | `true` / `1010` | 表头 Dock 按钮 |

## 开发

```bash
npm test          # 单元测试
npm run check     # 仓库检查（locale/key/编码）
npm run lint      # eslint
```

日志：`%LOCALAPPDATA%\dsh-quickdock\host.log`（宿主）与 `dock.log`（窗口）。

## 目录

```
index.js / service.js / dock.js   入口（一行挂两个组件）
client.js                         表头按钮、下载徽标、dock 模式适配
host/                             监听、外壳页、bridge、Electron 监督
runtime/                          Electron 进程（窗口、系统按钮、preload）
locale/                           中英文案
API.md                            对外契约与 postMessage 消息表
DESIGN.md                         架构说明
```

## 许可

MIT
