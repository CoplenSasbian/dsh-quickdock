# dsh-quickdock 快速停靠窗

**把 DSH 放进一个始终置顶的小窗口** —— 在会话头部点 **Dock**，DSH 自己的对话就在那儿打开，
钉在你正在忙的东西上面。

窗口里就是真正的应用：对话、工具卡片、审批、模型与权限控制。它不会和主窗口走偏，
因为它*就是*主窗口的 Web UI 装进了一个框。

## 提供什么

- **给当前会话一个停靠窗。** Dock 会绑定你正在看的会话，窗口跟着它走。DSH 以后的新功能会自动
  出现在停靠窗里 —— 没有任何重写的界面。
- **一个能长期开着的框。** 拖动移动，切换侧边栏（在整个窗口上展开），置顶，收成一个小球，
  或用系统的关闭/最小化按钮。
- **一个页面，四种客户端。** 同一个外壳页面服务于桌面窗口（`view=electron`）、编辑器的 webview
  ——VS Code 用 `view=vscode`，JetBrains IDE 用 `view=intellij`，都是精简标题栏、经插件自己的
  app proxy 提供——以及浏览器标签（`view=browser`）。
- **真正的编辑器停靠。** 配合 **DSH Dock for VS Code** 扩展或 **DSH Dock for JetBrains IDEs**
  插件，同一页面能放进编辑器的侧边栏；在停靠窗的对话里点文件路径会在编辑器里打开，而不是停靠窗
  自带的预览面板，同时编辑器把工作区开放给 DSH 的 agent 读取（可选写入）。
- **工具面板。** 标题栏的列表按钮会显示这个 dock 发布了哪些 MCP 服务器、版本与工具名，
  以及 DSH 当前是否已挂载。
- **中英双语**，跟随 DSH 的语言设置。

## 前置条件

- Windows 10/11，DSH 0.2.0 或更新（桌面版或 `dsh web`）。
- 约 100 MB 磁盘空间用于窗口运行时（Electron），只需下载一次。

## 安装

在 DSH 的插件页（**设置 → 插件**）安装 `dsh-quickdock` —— 输入包名，或从本地文件夹安装。

在终端里，给桌面应用不管理的 profile 安装：

```bash
dsh plugin --profile web add dsh-quickdock
# 或者从检出目录 / tgz：
dsh plugin install C:\path\to\dsh-quickdock
```

**desktop** profile 由桌面应用自己管理，`dsh plugin --profile desktop …` 会拒绝执行，
请在插件页里装。

## 第一次运行

1. 打开 DSH，在会话头部点 **Dock**。
2. 第一次点会下载窗口运行时（约 100 MB）到
   `%LOCALAPPDATA%\dsh-quickdock\electron\<版本>\`，之后是即时的。想提前准备，或指定已有的
   可执行文件：

   ```bash
   node scripts/ensure-electron.mjs
   set DSH_QUICKDOCK_ELECTRON_PATH=D:\path\to\electron.exe
   ```

3. 窗口在你停靠的会话上打开。可以置顶、拖动、收成小球 —— 位置会被记住。

## 设置

**DSH → 设置 → QuickDock**

| 字段 | 默认 | 作用 |
|---|---|---|
| `port` | `47910` | 外壳页面和 API 的回环端口。端口被占时改这里并点 **Apply and restart**。填 `0` 关闭监听 |
| `windowControls` | `custom` | `system` 使用系统的关闭/最小化按钮（推荐） |
| `clickThrough` | `true` | 框内空白区域的点击会穿透；嵌入外部页面时关掉 |
| `width` / `inputHeight` | `480` / `820` | 窗口尺寸 |
| `alwaysOnTop` | `false` | 启动即置顶（置顶按钮随时可切换） |
| `autoLaunch` | `false` | 随插件打开窗口，而不是等第一次点 Dock |
| `prefetchElectron` | `true` | 启动时预取运行时，让第一次点击即时 |
| `rememberGeometry` | `true` | 记住窗口位置 |
| `ballSize` | `64` | 收成的悬浮球直径（24–160） |
| `headerButton` / `headerButtonOrder` | `true` / `1010` | 会话头部的 Dock 按钮 |
| `mcpBridge` / `mcpBridgeToken` | `true` / `''` | 提供按工作区的 MCP 桥，供编辑器 dock 注册。token 为空时只接受回环调用 |

## 常见问题

| 你看到 | 怎么办 |
|---|---|
| 窗口空白或一直停在加载 | 看 `%LOCALAPPDATA%\dsh-quickdock\dock.log`；插件更新通常能修好旧窗口 |
| 第一次点 Dock 要等很久 | 正在下载运行时：检查代理，或把 `DSH_QUICKDOCK_ELECTRON_PATH` 指向已有的 `electron.exe` |
| DSH 日志里出现 “Port already in use” | `47910` 被别的程序占用：在 设置 → QuickDock → 连接 里换端口并点 **Apply and restart** |
| VS Code 里 dock 一直不出现 | 两边端口要一致（VS Code 设置 `dshVsdock.port`）；见 DSH Dock 扩展的 README |
| 会话里看不到编辑器工具 | 该会话的目录不在编辑器打开的文件夹里 —— 停靠窗标题栏会出现琥珀三角；列表按钮能看到挂载情况 |
| 更新之后一切不工作 | 重启 DSH：Host 那一半是启动时加载的 |

## 隐私

- 全程回环：外壳页面、插件 API 和工作区 MCP 桥都只监听 `127.0.0.1`，数据不出本机。
- 桥把目录映射到 MCP 端点：工作目录在该目录内的会话才挂载这些工具，其余会话看不到。
- `mcpBridgeToken` 为空时只接受回环调用；若端口可能被非本机访问，请设 token。

## 更多

- [CHANGELOG](CHANGELOG.md) —— 每个版本改了什么。
- 给其他客户端作者的契约：[API.md](API.md)、[MCP-BRIDGE.md](MCP-BRIDGE.md)、
  [DOCK-CONTEXT.md](DOCK-CONTEXT.md)、[DESIGN.md](DESIGN.md)。

## 许可

MIT
