# dsh-quickdock

**DSH in a small always-on-top window** — click **Dock** in a session header and
DSH's own conversation opens right there, pinned over whatever else you are doing.

The window is the real app: conversations, tool cards, approvals, model and
permission controls. It never drifts from the main window, because it *is* the
main window's Web UI in a frame.

## What you get

- **A dock for the conversation you are in.** Dock binds the session you are
  looking at and the window follows it. New DSH features appear in the dock
  automatically — nothing is re-implemented.
- **A frame you can live with.** Drag to move, toggle the sidebar (it expands
  over the whole window), pin on top, collapse to a small floating ball, or use
  the OS close/minimise buttons.
- **One page, four clients.** The same shell page serves the desktop window
  (`view=electron`), an editor webview — `view=vscode` for VS Code,
  `view=intellij` for JetBrains, both with a trimmed chrome and served through the
  plugin's app proxy — and a plain browser tab (`view=browser`).
- **A real editor dock.** With the **DSH Dock for VS Code** extension or the
  **DSH Dock for JetBrains IDEs** plugin the same page sits in the editor's side
  panel; a path clicked in the docked conversation opens in the editor instead of
  the dock's own preview, and the editor gives DSH's agent read (and optionally
  write) access to your workspace.
- **A tool panel.** The list button in the title bar shows which MCP servers this
  dock published, their build and tool names, and whether DSH has them mounted
  right now.
- **Bilingual**, following DSH's language.

## Requirements

- Windows 10/11, DSH 0.2.0 or newer (desktop app or `dsh web`).
- About 100 MB of disk for the window's runtime (Electron), downloaded once.

## Install

From DSH's plugin page (**Settings → Plugins**), install `dsh-quickdock` — either
from its package name or from a local folder.

From a terminal, for a profile the desktop app does not manage:

```bash
dsh plugin --profile web add dsh-quickdock
# or, from a checkout / tarball:
dsh plugin install C:\path\to\dsh-quickdock
```

The **desktop** profile is managed by the app itself; `dsh plugin --profile
desktop …` refuses to run, so use the plugin page there.

## First run

1. Open DSH and click **Dock** in a session header.
2. The first click downloads the window runtime (~100 MB) into
   `%LOCALAPPDATA%\dsh-quickdock\electron\<version>\`; later opens are instant. To
   prepare it in advance, or to use an existing binary:

   ```bash
   node scripts/ensure-electron.mjs
   set DSH_QUICKDOCK_ELECTRON_PATH=D:\path\to\electron.exe
   ```

3. The window opens on the session you docked. Pin it, drag it, collapse it to the
   ball — the geometry is remembered.

## Settings

**DSH → Settings → QuickDock**

| Field | Default | What it does |
|---|---|---|
| `port` | `47910` | Loopback port for the shell page and its API. Change it when taken and press **Apply and restart**. `0` turns the listener off |
| `windowControls` | `custom` | `system` draws the OS close/minimise buttons (recommended) |
| `clickThrough` | `true` | Clicks pass through the frame's empty areas; turn off when embedding a foreign page |
| `width` / `inputHeight` | `480` / `820` | Window size |
| `alwaysOnTop` | `false` | Start pinned (the pin button toggles it any time) |
| `autoLaunch` | `false` | Open the window with the plugin instead of on the first Dock click |
| `prefetchElectron` | `true` | Prepare the runtime at startup so the first click is instant |
| `rememberGeometry` | `true` | Remember where the window was |
| `ballSize` | `64` | Diameter of the floating ball the window collapses into (24–160) |
| `headerButton` / `headerButtonOrder` | `true` / `1010` | The Dock button in the session header |
| `mcpBridge` / `mcpBridgeToken` | `true` / `''` | Serve the per-workspace MCP bridge that editor docks register with. An empty token accepts loopback callers only |

## Troubleshooting

| You see | What to do |
|---|---|
| Window is blank, or stays on the loading screen | Open `%LOCALAPPDATA%\dsh-quickdock\dock.log`; a plugin update usually fixes a stale window |
| The first Dock click takes minutes | The runtime is downloading: check your proxy, or set `DSH_QUICKDOCK_ELECTRON_PATH` to an existing `electron.exe` |
| “Port already in use” in DSH's log | Another program has `47910`: change the port under Settings → QuickDock → Connection and press **Apply and restart** |
| The dock never appears in VS Code | The port must match on both sides (VS Code setting `dshVsdock.port`); see the DSH Dock extension's README |
| Editor tools do not show up in a session | That session's folder is not one the editor has open — the dock's title bar shows an amber triangle; the list button shows what is mounted |
| Nothing works after an update | Restart DSH: the Host half is loaded at startup |

## Privacy

- Everything is loopback: the shell page, the plugin's API and the workspace MCP
  bridge listen on `127.0.0.1` only. Nothing leaves your machine.
- The bridge maps a directory to an MCP endpoint: a session whose working
  directory is inside that directory mounts the tools, and nothing else does.
- With `mcpBridgeToken` empty, only loopback callers are accepted; set a token if
  something non-local can reach the port.

## More

- [CHANGELOG](CHANGELOG.md) — what changed in each version.
- Contracts, for anyone writing another client: [API.md](API.md),
  [MCP-BRIDGE.md](MCP-BRIDGE.md), [DOCK-CONTEXT.md](DOCK-CONTEXT.md),
  [DESIGN.md](DESIGN.md).

## License

MIT
