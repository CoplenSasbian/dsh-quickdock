# dsh-quickdock

A DeepSeek Harness (DSH) plugin that puts **DSH's own Web UI** in a small
always-on-top window.

Click **Dock** in a session header and an Electron window opens on that
conversation. The window is the real app — conversations, tool cards, approvals,
model/permission controls — so it can never drift from the main window.

```
DSH main window [Dock] ──► Host binds the session ──► Electron window
                                                       │
                                          shell page localhost:47910 (title bar + iframe)
                                                       │
                                          iframe ──► DSH Web UI (?dock=1)
```

## What you get

- **The app itself**: no re-implemented conversation UI; new DSH features appear
  in the dock automatically;
- **Follows the conversation**: Dock binds the session you are looking at and the
  window navigates to it;
- **Title bar**: drag the window, toggle the sidebar (expands over the whole
  window, collapses when you pick a session), pin on top, OS close/minimise;
- **Stable loopback port, no token**: `http://127.0.0.1:47910` by default (change
  it in Settings → QuickDock when taken), and the shell page says which client is
  looking at it: `?view=electron` for the window, `?view=vscode` for an IDE
  webview (trimmed chrome, the app served through the Host's app proxy) or
  `?view=browser` for a plain tab;
- Bilingual (English / 简体中文), following DSH's language.

## Requirements

- Windows 10/11
- Node.js 20+
- DSH ≥ 0.2.0

## Install

```bash
npm install
```

The Host half needs `@deepseek-ai/schemastery` for the config schema; the window
needs Electron.

The first **Dock** click downloads Electron (~100 MB, mirror, once) into
`%LOCALAPPDATA%\dsh-quickdock\electron\<version>\`. To prepare it up front:

```bash
node scripts/ensure-electron.mjs
# or point at an existing binary
set DSH_QUICKDOCK_ELECTRON_PATH=D:\path\to\electron.exe
```

Install it in DSH (local package from the plugin page, or):

```bash
dsh plugin install C:\path\to\dsh-quickdock
```

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `port` | `47910` | Loopback port for the shell page and API. Edit it under Settings → QuickDock → Connection and press **Apply and restart**: the listener rebinds, the window reopens on the new address. `0` disables the listener |
| `windowControls` | `custom` | `system` uses the OS close/minimise buttons (recommended) |
| `clickThrough` | `true` | Set `false` when embedding a foreign page |
| `width` / `inputHeight` | `480` / `820` | Dock window size |
| `alwaysOnTop` | `false` | Start pinned (the 📌 button toggles it any time) |
| `autoLaunch` | `false` | Open with the plugin instead of on the first click |
| `prefetchElectron` | `true` | Prepare Electron at mount so the first click is instant |
| `rememberGeometry` | `true` | Remember the window position |
| `ballSize` | `64` | Diameter of the floating whale ball the window collapses into (24–160) |
| `headerButton` / `headerButtonOrder` | `true` / `1010` | Header Dock button |
| `mcpPairing` | `true` | Register the paired editor's MCP server: poll `mcp.json` and keep the `mcp-dsh-vsdock` row enabled while it is live (see `MCP-PAIRING.md`). Off leaves the profile patch untouched |

## Development

```bash
npm test          # unit tests
npm run check     # repository checks (locale keys, encoding)
npm run lint      # eslint
```

Logs: `%LOCALAPPDATA%\dsh-quickdock\host.log` (Host) and `dock.log` (window).

## Layout

```
index.js / service.js / dock.js   entry points (one row mounts both components)
client.js                         header button, download badge, dock-mode shims
host/                             listener, shell page, bridge, Electron supervisor, MCP pairing
runtime/                          Electron process (window, system controls, preload)
locale/                           English / Chinese catalogs
API.md                            contract and postMessage message table
MCP-PAIRING.md                    VS Code MCP server: discovery, consent, loader row
DOCK-CONTEXT.md                   per-dock context: identity, tools, binding
DESIGN.md                         architecture notes
```

## License

MIT
