# dsh-quickdock

**DSH in a small always-on-top window — and the dock host every editor plugs into.**

Click **Dock** in a session header and DSH's own conversation opens in a small window pinned
over whatever else you are doing. The window is the real app — conversations, tool cards,
approvals, model and permission controls — so it never drifts from the main window. The same
page is what the VS Code and JetBrains docks embed.

## Features

- **A dock for the session you are in.** Dock binds the session you are looking at and the
  window follows it; new DSH features show up automatically because nothing is re-implemented.
- **A window you can live with.** Drag it, pin it on top, expand the sidebar over the whole
  window, collapse it to a small floating ball, or use the OS close/minimise buttons.
- **One page, four clients.** The same shell page serves the desktop window
  (`view=electron`), VS Code (`view=vscode`), JetBrains (`view=intellij`) and a plain browser
  tab (`view=browser`), with the editor views trimmed and served through a loopback proxy.
- **Editor docks.** With the DSH Dock extension or plugin, the page sits in the editor's side
  panel; a path clicked in the conversation opens in the editor, and the agent gets tools that
  run there.
- **A per-workspace MCP bridge.** Editor tools are registered per working directory, so only
  sessions working inside that folder mount them — and a build elsewhere brings no tools in.
- **A tool panel.** The list button in the title bar shows which MCP servers this dock
  published, their build and tool names, and whether DSH has them mounted right now.
- **Bilingual**, following DSH's language.

## How the three fit together

This repository is the **host half**: it serves the conversation and the bridge, and the two
editor docks are its clients. Install it in DSH and both docks work; the editor docks require
it, and can be connected at the same time (their tool namespaces differ).

| Project | Runs in | What it is |
|---|---|---|
| [dsh-quickdock](https://github.com/CoplenSasbian/dsh-quickdock) | DSH | The host half: serves the conversation as a loopback page and the MCP bridge the editor docks register with. **Required by both editor docks.** |
| [DSH Dock for VS Code](https://github.com/CoplenSasbian/dsh-vsdock) | VS Code | The same page in the secondary side bar, plus VS Code editor tools. |
| [DSH Dock for JetBrains IDEs](https://github.com/CoplenSasbian/dsh-intellijdock) | IntelliJ IDEA, CLion, PyCharm, WebStorm, GoLand, … | The same page in a tool window, plus JetBrains editor tools. |

## Requirements

- Windows 10/11 and DSH 0.2.0 or newer (desktop app or `dsh web`).
- About 100 MB of disk for the window's runtime (Electron), downloaded once.
- For either editor dock: **dsh-quickdock 0.6.0 or newer**, with its listener reachable on
  `127.0.0.1:47910`.

## Install

In DSH: **Settings → Plugins** → install `dsh-quickdock` — from the package name or from a
local folder. The desktop profile is managed by the app, so the plugin page is the way in.

## License

MIT — see [LICENSE](LICENSE).
