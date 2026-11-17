# dsh-quickdock

**把 DSH 放进一个小巧的置顶窗口——也是所有编辑器 dock 的宿主。**

在会话标题栏点 **Dock**，DSH 自己的对话就会在一个置顶小窗里打开，压在你正在做的事情上面。
这个窗口就是真正的应用（对话、工具卡片、审批、模型与权限控制），所以不会和主窗口分叉。
VS Code、JetBrains 和 Visual Studio 的 dock 嵌入的也是同一个页面。

## 功能

- **当前会话的 dock。** Dock 绑定你正在看的会话，窗口跟着它走；新功能自动出现，因为没有
  另写一份界面。
- **能长期开着的窗口。** 拖动、置顶、把侧边栏展开到整个窗口、收成一个小球，或者用系统自带的
  关闭/最小化按钮。
- **一个页面，五种客户端。** 同一个壳页服务桌面窗口（`view=electron`）、VS Code
  （`view=vscode`）、JetBrains（`view=intellij`）、Visual Studio（`view=visualstudio`）和
  普通浏览器标签（`view=browser`）；编辑器视图会精简标题栏并通过回环代理提供。
- **编辑器 dock。** 装上 DSH Dock 的扩展或插件（VS Code、JetBrains、Visual Studio）后，
  页面就放在编辑器侧边面板里；点对话里的路径会在编辑器中打开，agent 也能用上在编辑器里
  运行的工具。
- **按目录的 MCP 桥。** 编辑器工具按工作目录注册，只有工作目录在其中的会话才会挂载；别的
  目录里的构建也不会带进工具。
- **工具面板。** 标题栏的「列表」按钮显示这个 dock 发布了哪些 MCP server、版本与工具名，
  以及 DSH 当前是否已挂载。
- **跟随 DSH 语言**的中英文界面。

## 三个项目怎么配合

本仓库是**宿主**：提供对话页面与 MCP 桥，编辑器 dock 都是它的客户端。在 DSH 里装好
它，这些客户端都能用；它们都依赖本插件，也可以同时连接（工具命名空间不同）。

| 项目 | 运行在 | 是什么 |
|---|---|---|
| [dsh-quickdock](https://github.com/CoplenSasbian/dsh-quickdock) | DSH | 宿主：把对话作为回环页面提供出来，并提供编辑器 dock 注册工具的 MCP 桥。**每个编辑器 dock 都依赖它。** |
| [DSH Dock for VS Code](https://github.com/CoplenSasbian/dsh-vsdock) | VS Code | 同一页面放进辅助侧边栏，外加 VS Code 编辑器工具。 |
| [DSH Dock for JetBrains IDEs](https://github.com/CoplenSasbian/dsh-intellijdock) | IntelliJ IDEA、CLion、PyCharm、WebStorm、GoLand 等 | 同一页面放进工具窗口，外加 JetBrains 编辑器工具。 |
| [DSH Dock for Visual Studio](https://github.com/CoplenSasbian/dsh-visualstudio) | Visual Studio 2026 | 同一页面放进工具窗口（编辑器工具部分还在做）。 |

## 环境要求

- Windows 10/11，DSH 0.2.0 或更新（桌面版或 `dsh web`）。
- 约 100 MB 磁盘用于窗口运行时（Electron），只需下载一次。
- 使用任一编辑器 dock 需要 **dsh-quickdock 0.6.0+**，且监听地址 `127.0.0.1:47910` 可达。

## 安装

在 DSH 里打开 **设置 → 插件**，安装 `dsh-quickdock`（按包名或从本地目录）。桌面 profile 由
应用自己管理，从插件页安装即可。

## 许可

MIT，见 [LICENSE](LICENSE)。
