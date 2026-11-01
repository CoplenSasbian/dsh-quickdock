# dsh-quickdock

A DeepSeek Harness (DSH) plugin: QuickDock, a dock that stays in a corner of the screen.

Click **Dock** in a DSH session header and one frameless, transparent window
appears (`layout: unified`, the default; `split` restores the older two-window
arrangement). From top to bottom:

- **Execution pane** — the session as rows (prompts, reasoning, tool calls,
  replies), scrolling with the wheel like any page
- **Task strip** — the agent's plan and goal, exactly while it has one
- **Composer** — the bound workspace/session and four function keys
  (permission, model, thinking effort, agent preset)

The window can be dragged. Approvals and structured questions are answered in
the dock, without going back to the main window.

The UI is bilingual (English / Simplified Chinese) and follows the DSH language.

## Requirements

- Windows 10/11
- Node.js 20+
- DSH >= 0.2.0

## Install

```bash
npm install
```

Do not skip this step: the Host half needs `@deepseek-ai/schemastery` for the
config schema, and downloads Electron with `@electron/get` when desktop mode is
requested.

The first **Dock** click downloads Electron (~100 MB, npmmirror, once) into
`%LOCALAPPDATA%\dsh-quickdock\electron\<version>\`. To prepare it ahead of time:

```bash
node scripts/ensure-electron.mjs
# or point at an existing binary
set DSH_QUICKDOCK_ELECTRON_PATH=D:\path\to\electron.exe
```

Register the plugin in the DSH profile (see `cordis.patch.yml`):

```json
{ "dsh-quickdock": "link:D:/node/dsh-quickdock" }
```

## Usage

- **Which session the dock shows is decided in DSH**: click **Dock** on a session
  header. The dock does not switch sessions on its own.
- The **workspace chip** in the title bar is read-only context: it says where the
  next message goes.
- **↗** opens the bound session in the DSH main window (dock -> Host API -> command
  bus -> Client half -> `ctx.uiWorkspace.openSession`).
- **▤** cycles how the docked window's details are folded: auto (the current
  activity expands - reasoning, or the running tool - and collapses once it
  settles), expanded (everything stays open), folded (the rows stay listed but
  no body opens), hidden (the docked window is not shown at all).
- **⟳** reloads the docked pane: its page re-reads the state and the history,
  which is the cure for a first read that raced the Host.
- **Dock ▾** (the split button) opens the dock menu: close the dock window,
  restart the service (also drops the cached page assets, so `web/*` edits are
  picked up without reloading the plugin), reset the window size, restart the
  dock window.
- **⤒** keeps the window above other windows.
- **The dock follows the DSH theme live**: light/dark switches and every
  `--dsw-*` palette change are read from the main window's computed styles and
  pushed over SSE, so both windows repaint without a reload.
- **＋** unbinds and starts a blank conversation; **Shift/Alt + ＋** forks the current
  session (DESIGN D2).
- The function keys are dropdown menus. Long lists (models) get a search field, arrow
  navigation and a window that temporarily grows upwards instead of clipping the list.
- While the agent runs, the input window switches to a run panel: elapsed time,
  current action, live text and a **Stop** button. Approvals appear there too, with
  **Allow / Deny**.

## Components

The plugin mounts two components that can be enabled separately:

| Component | Config | What it brings |
|---|---|---|
| **service** | `service: true` (default) | the Host API: routes, SSE, folds, interactions, session index, catalogs. No Electron. |
| **dock** | `dock: true` (default) | the windows: Electron supervisor, page renderer, window commands, runtime download. |

Two ways to switch them:

**One entry, two flags** (what a plain install gets):

```json
{ "dsh-quickdock": { "config": { "dock": false } } }
```

**Two rows in DSH's plugin list** — the package ships its own `cordis.patch.yml`
the way `dsh-ops` does, so the components appear as separate entries with their
own switches:

| Row | Entry | What it does |
|---|---|---|
| `quickdock-service` | `dsh-quickdock/service` | the **service**: routes, SSE, folds, interactions. No Electron. |
| `quickdock-dock` | `dsh-quickdock/dock` | the **windows**, attached to that service. |

```yaml
# shipped by the package (do not copy; override only to change the config)
- insert:
    - id: quickdock-service
      name: dsh-quickdock/service
      config: {}
    - id: quickdock-dock
      name: dsh-quickdock/dock
      config: {}
```

The package's own row (`dsh-quickdock`) mounts nothing: the two components above
are what run, so the plugin page lists them side by side.

Disable the dock row for a headless API server; disable the service row to take
QuickDock out (the dock row then logs `needs dsh-quickdock/service` and stays
inert). Both rows share one Host instance, so switching the dock off keeps the API
running and switching the service off leaves the dock row inert (it logs
`needs dsh-quickdock/service`).

That is a headless server: IDE plugins and scripts get every route of
[API.md](API.md) while nothing spawns Electron. `GET api/meta` reports what is
mounted:

```json
{ "components": { "service": true, "dock": false } }
```

`dock` implies `service` (the pages read the API), so `{ service: false, dock: true }`
mounts nothing and logs that. Turning the service off is only useful when another
instance already serves the same origin. With both off the plugin is inert.

## Window layout

`config.layout` decides how many Electron windows the dock uses:

| Layout | Windows | Contents |
|---|---|---|
| `unified` (default) | one | execution pane on top (`displayHeight`, 520), task strip, composer at the bottom |
| `split` | two | the execution pane is its own window, parked above or below the input window |

The unified window is sized from its parts: the page reports
`displayHeight + task strip + composer + the real gaps`, the runtime clamps that
to the work area, and the execution pane (`)flex: 1 1 auto`, min 120px) absorbs
the difference - so shrinking the screen never clips the composer.

| Key | Default | Meaning |
|---|---|---|
| `layout` | `unified` | one window with three panes, or `split` (two windows) |
| `displayHeight` | `520` | requested height of the execution pane (it shrinks when the screen is short) |
| `todoWindow` | `false` | give the task strip its own window |
| `todoHeight` | `180` | height of that window |

`todoWindow: true` additionally gives the task strip its own window
(`todoHeight`, 180) between the other two. It is off by default: the strip fits
above the composer, and one window is one geometry to get right.

## Client API

The Host half is a client-agnostic service; the dock UI is only one client.
IDE plugins can use the same API to **switch workspace/session** and read
**every turn**, which the dock UI intentionally does not expose:

```http
GET  /quickdock/api/meta          # capability manifest + apiVersion
GET  /quickdock/api/workspaces
GET  /quickdock/api/sessions?workspaceId=<id>
POST /quickdock/api/select        # { workspaceId?, sessionId?, newSession? }
GET  /quickdock/api/turns?sessionId=<id>   # whole-log turn outline
GET  /quickdock/api/turn?turn=<n>          # folded rows of one turn
GET  /quickdock/api/plan          # { todos, goal, source } - DSH's own projections
GET  /quickdock/api/state         # steps = newest turn (what the dock renders)
GET  /quickdock/api/events        # every session event, verbatim (clients filter)
```

All routes take `Authorization: Bearer <token>` (or `?t=<token>` for SSE). The
full contract — state snapshot, multi-turn retention, interaction rules, errors —
lives in [API.md](API.md).

**The Host passes events through, it does not pre-filter.** `state.steps` is the
dock's folded view, but `GET events` (and `stream?events=1`) carries every
session event verbatim — `tool/ptc-dispatch`, `todo/write`, `job/*`,
`workspace/changes`, whatever the session emits. A client decides what to draw;
an IDE plugin can build its own view without asking for new Host code.

## Internationalization

All UI strings live in `locale/en.json` and `locale/zh.json` (flat dotted keys,
`{placeholder}` slots).

- **Language resolution**: `config.locale` (`auto` | `en` | `zh`) wins; otherwise the
  language reported by the DSH Client half (it follows the DSH locale service); until
  then the operating system locale is used.
- **Dock pages** receive `window.__QD_I18N__ = { locale, messages }` (active catalog
  merged over English) and a localized `<html lang>`. Static markup uses
  `data-i18n`, `data-i18n-title`, `data-i18n-aria-label`, `data-i18n-placeholder`;
  dynamic text calls `t('key')`.
- **Language switching is live**: the Host broadcasts a `locale` SSE event; both windows
  re-label themselves without a reload.
- **Client half**: a small embedded catalog (marked `i18n-catalog`) is used because a
  static client bundle cannot read files; `npm run check` verifies it matches the JSON
  catalogs.
- **Host errors** are localized too, so the dock never mixes languages.
- **Hardcoded markup text fails the build**: `npm run check` rejects a
  `title` / `placeholder` / `aria-label` in `web/*.html` that has no matching
  `data-i18n-*` attribute (`QuickDock` as a brand is exempt). The catalogs are
  also verified for key parity, placeholder parity and unknown keys.

Adding a language: add `locale/<id>.json`, extend `SUPPORTED_LOCALES` in
`runtime/i18n.js` (and the client catalog), then run `npm run check`.

## The docked window is a conversation

The execution window renders the whole session, not the newest turn: one fold
per turn (DSH's shape), the prompt as a right-aligned bubble above each fold,
replies outside their fold,
live rows only under the running one. Older turns are read through
`/turns` + `/turn?turn=N` the first time a session is opened and then kept, so
nothing is cleared when a turn ends.

## Task list and goal

The strip above the composer is **DSH's own TodoPanel**, not a look-alike: the
markup, metrics and wording come from `dsh-client-ui-conversation`
(`TodoPanel.module.css`) - a menu-toned panel, a header row (checklist icon,
title, summary, chevron) and 8px-gapped rows with a 16px status glyph.

- **Data** comes from DSH's `todos` projection (`dsh-tool-todo`), which goes
  `null` at every `turn/start`. The Host's own fold is only a fallback for
  builds that do not register the projection, so the dock can never show a plan
  the main window has already dropped.
- **No plan, no strip**: with no steps there is no card at all (no placeholder,
  no reserved height). It reappears on the next `todo/write`.
- **Summary** uses DSH's own wording: `2 done · 1 active · 1 pending` /
  `2 已完成 · 1 进行中 · 1 待处理` (keys `todo.progress.*`).
- **Collapsible**: the header is a button; the chevron follows the state
  (`▾`/`▸`), `aria-expanded` follows too, and the choice is remembered in
  `localStorage` (`qd.todoOpen`). Collapsed keeps the header and the goal line.
- **Goal line**: one `◎ <objective>` row under the header, read from the
  `goal` projection (`dsh-goal`). Hidden when there is no goal.

## Questions

The agent's questions are answered in the input window, never in the docked one
(that window can be hidden, and a pending question must not disappear with it).
The card replaces the composer while a request is open and walks it one question
at a time - options or free text, Back/Next, a "2 / 4" counter - and only the
last step sends every collected answer in a single `/answer` call.

## Composer rendering

The dock is a single window: a title bar and the composer. While the agent works the bar
grows a stop button; the composer never moves, so typing stays possible.

The composer is a render island (`web/render/src/composer.js`). Its layout and metrics are
copied from DSH's own composer (ui-conversation `InputBar.module.css`): one card surface
(`--dsw-specific-input-major`, panel radius, soft elevation), the text at 14px/24px, then a
row of borderless 28px selects with a 34px round primary button on the right. The page
keeps the behaviour (submit, menus, drafts) behind a small imperative handle.

The send button is QuickDock's own: a fixed brand blue fill with a fixed white
glyph. Theme tokens were tried first (`--dsw-alias-button-info-fill` with
`--dsw-alias-label-primary-foreground`) but a theme that resolves both to white
paints an invisible arrow, so the colour no longer depends on the palette.
A theme change still restyles everything around it.

Artifacts are committed, so installing the plugin needs no build:

```bash
npm run build:render   # rebuild web/render/bundle.js + bundle.css after editing src/
```

The island reads the DSH palette directly, because the Host forwards every `--dsw-*` token
and not only the ones its own stylesheet uses.

## Project layout

```
index.js               plugin entry: name, inject, Config schema, apply()
host/                  Host half (one responsibility per module)
  quickdock-host.js    composition root: wires services, routes, events, timers
  api.js               route table for /quickdock/api/*
  bridge.js            /api/quickdock actions for the Client half
  catalogs.js          permission / model / agent catalogs
  dsh.js               adapter over DSH services (optional services stay safe)
  dock-component.js    the dock component: supervisor + page renderer, its own mount/dispose
  dock-process.js      Electron supervisor: spawn, control channel, backoff restart
  electron-resolver.js Electron discovery, probing and download
  event-hub.js         SSE hub (page state stream + browser command bus)
  interactions.js      approval / question broker (delegates when the dock is gone)
  locale.js            locale controller and page catalog
  page.js              inlines assets, theme, catalog into one HTML document
  session-index.js     session title repository (cold sessions included)
  snapshot.js          the single state snapshot definition (newest turn)
  stream-buffer.js     live assistant stream folding
  theme.js             DSH alias tokens -> dock CSS variables
  trace.js             host.log writer
  version.js           git hash + package version, so a stale process is visible
client.js              Client half: header Dock button, theme/locale sync, command bus
runtime/               Electron main process (CommonJS, no build step)
  main.cjs             windows, transparency, click-through, menu growth
  preload.js           validated contextBridge API
  config.js            flags / env / inline JSON config
  geometry.js          position restore and clamping
  step-folder.js       session/event -> rows (strategy table, unit tested)
  protocol.js          host <-> dock line protocol
  window-store.js      debounced atomic window.json
  i18n.js              shared catalog loader / translator
  config.js            layout (unified/split), displayHeight, todoWindow, todoHeight
  test/                unit tests (node:test) and fixtures
web/                   page assets, inlined by the Host (manifest.json order)
  locale.js            page i18n runtime (data-i18n + t)
  markdown.js          escaping-first Markdown renderer
  util.js              DOM/text helpers
  display.js           run window view (island mount, live block, cards)
  menu.js              dropdown menu (search, keyboard, window growth)
  app.js               page bootstrap: SSE, render, pickers, hit regions
  styles.css           dock styles (theme variables only)
  render/              run window render island (see below)
    src/entry.js       steps -> DSH web UI primitive rows (React)
    bundle.js/.css     built artifact, committed and inlined by the Host
locale/                en.json, zh.json message catalogs
scripts/               tooling: tests, checks, smoke test, dev harness, Electron
```

## Quality gates

```bash
npm test        # unit tests (node:test, one process)
npm run check   # i18n parity, key usage, CJK/whitespace rules, web manifest
npm run smoke   # start the mock Host and probe page, API and locale switching
npm run verify  # all three
npm run lint    # ESLint (dev dependency)
```

`scripts/check.mjs` is dependency-free on purpose: it enforces that every referenced
locale key exists, that both catalogs share keys and placeholders, that the Client
catalog matches the JSON files, that no CJK text leaks outside the locale files,
that `web/*.html` carries no hardcoded `title`/`placeholder`/`aria-label`, and
that sources stay UTF-8/LF without tabs or trailing whitespace.

## Local development

```bash
node --import ./scripts/register-hook.mjs scripts/dev-harness.mjs
```

The harness provides a mock `ctx` and mock DSH services, prints the tokenized page
URL and exposes `/test/*` helpers (inspect calls, inject session events, trigger
approvals, push theme/locale).

- `QD_PORT=45999` fixed port
- `QD_NO_ELECTRON=1` API layer only, no Electron
- `&view=display` renders the run window in a normal browser
- `POST /test/locale {"locale":"zh"}` switches the dock language

## Diagnostics

| Log | Contents |
| --- | --- |
| `%LOCALAPPDATA%\dsh-quickdock\host.log` | Electron candidates and probes, spawn arguments, ready/exit codes, API failures, accepted theme palettes |
| `%LOCALAPPDATA%\dsh-quickdock\dock.log` | window creation, geometry, control channel, received commands |

The Host half never fails silently: the page shows the reason as a toast.

Lines worth knowing:

| Line | Log | Means |
|---|---|---|
| `host half loaded: version=… commit=…` | host.log | which build is running; if the hash is not your HEAD, reload the plugin |
| `event types: tool/call(312) …` | host.log | the session's event inventory, once per bind |
| `seed history(…): events=N folded=N rows=N` | host.log | history folded at bind; `seed history failed:` means it threw |
| `page: plan from api: todos=N source=…` | dock.log | where the plan came from: `projection`, `fold` or `empty` |
| `page: send button: bg=… color=…` | dock.log | the composer button's resolved colours |
| `unified layout: one window…` | dock.log | no second Electron window is created |
| `task window disabled (todoWindow=false)` | dock.log | the strip lives in the input window |
| `content height: A -> B` | dock.log | the window resized to the page's report |

The task strip prints the running commit in its header, so a stale window is
visible without opening a log.

| Variable | Effect |
| --- | --- |
| `DSH_QUICKDOCK_ELECTRON_PATH` | use this Electron binary (skips download and probing) |
| `DSH_QUICKDOCK_ELECTRON_VERSION` | version to download (default 44.7.0) |
| `DSH_QUICKDOCK_DISABLE_GPU=1` | software rendering (transparent-window issues) |
| `DSH_QUICKDOCK_NO_CLICK_THROUGH=1` | disable click-through |
| `DSH_QUICKDOCK_GPU_SANDBOX=1` | keep the GPU sandbox |

### Common problems

| Symptom | Cause / fix |
| --- | --- |
| "Electron unavailable" after clicking Dock | `npm install` was skipped or security software blocks Electron; follow the hint or set `DSH_QUICKDOCK_ELECTRON_PATH` |
| Window opens but never updates | SSE 401: EventSource cannot send headers, so `/api/stream` must accept `?t=` as well |
| Permission/model clicks do nothing | unbound sessions keep the setting in state and apply it on create; bound sessions are updated immediately |
| Approval appears in DSH, not the dock | check `host.log` for `approval -> dock:`; a hidden dock intentionally delegates |
| Menu shows only two rows | the window grows upward for menus; at the screen edge it can only grow to the edge (`dock.log`: `menu space:`) |
| Dock exits right after starting, page times out | The probed Electron may still be blocked from writing its profile (security software, binaries under the project folder). The supervisor prefers `%LOCALAPPDATA%\dsh-quickdock\electron\<version>` and falls back to the next candidate; if none runs, the toast shows the last stderr line. Point `DSH_QUICKDOCK_ELECTRON_PATH` at a known-good binary if needed |
| First click takes a minute | Electron is downloading; the page shows a hint |

Design details: [DESIGN.md](./DESIGN.md) (Chinese design document and the interaction
prototype `dock-prototype.html`).