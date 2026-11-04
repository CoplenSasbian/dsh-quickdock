# Changelog

All notable changes to this project are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow SemVer.

## [Unreleased]

Work after the published beta: the dock trims are fixed, settings reach the open
window, and a resident disc no longer fights the window.

### Changed

- The dock always trims the shipped chrome: header action buttons, the
  plugins/automations/more rows, the account menu and the conversation tab strip.
  Restoring any of them is broken at dock size, so `trimHeaderActions`,
  `trimSidebarPanels`, `trimAccountMenu` and `trimTabs` are gone from
  `config.json` and from the settings page.

### Fixed

- `config-set` pushes ball icon, always-visible disc, edge snapping,
  collapse-on-close, first corner and always-on-top to the window that is already
  open; before, only `ballSize` was applied live.
- A resident disc parks on the configured corner while the window is open instead
  of covering the collapse button, collapsing works while a disc is visible, and
  clicking a resident disc no longer re-places an open window.

## [0.6.0-beta.1] - 2026-11-04

Configuration moves out of the Loader row into its own file and its own settings
page, and the window learns to collapse into a floating whale disc.

### Added

- `config.json` next to the host log: first run writes the whole template, and the
  file overrides the row config (precedence: file > row > schema default).
- A dedicated **QuickDock** page under Settings (`settings.section`) with 23 rows:
  window size and bounds, pin/geometry/focus/auto-launch, ball size and icon,
  edge snapping, collapse-on-close, first-appearance corner, header button and the
  dock-only trims.
- Floating disc: minimising (or closing, with `collapseOnClose`) hides the window
  and leaves a whale disc where the collapse button was clicked.
- The disc is dragged by polling the OS cursor (see Fixed) and snapped to the
  nearest screen edge when `snapToEdge` is on.
- Restoring the window reopens it around the disc, so the disc lands back on the
  button it replaced; the result is clamped into the work area.
- `ballIcon` (`whale` / `dot`), `ballAlwaysVisible`, `trimTabs` (hides the
  conversation tab strip).

### Changed

- The window-wide Settings row is gone: the plugin now owns a settings page
  instead of one line in General.
- `ballSize` is applied live: the disc is rebuilt at the new diameter and kept
  centred.

### Fixed

- The disc grew while dragged: renderer-reported pointer deltas fed window
  movement back into the pointer events. Dragging now polls
  `screen.getCursorScreenPoint()` and re-asserts the disc size on every move, so
  a held pointer cannot move or resize it.
- A disc press without travel is treated as a click and restores the window.
- Restoring used to leave the window at its old place even when the disc had been
  dragged across the screen.

## [0.5.0] - 2026-11-03

The dock window becomes a dock: one title bar drives everything, the sidebar only
exists when opened, and the window can be resized.

### Added

- Session title mirrored from the app into the dock title bar (`quickdock:title`).
- Title-bar "new session" button (`＋`), shown while the sidebar is collapsed.
- Title-bar handoff button (`⤴`): ask the main DSH window to show the session the
  dock is on (`POST /quickdock/api/handoff`, `GET` for the main window to poll).
- Resizable window with bounds: 360x420 to 900x1400 (`minWidth`, `minHeight`,
  `maxWidth`, `maxHeight`); the chosen size is remembered.
- A Dock bind now brings the window to the front and focuses it.

### Changed

- Collapsed sidebar is gone: no vertical strip, the conversation fills the window.
- Dock-only trimming: account menu, workspace opener / "open with" / overflow /
  right-sidebar buttons, plugins, automations, "more", view options and "add
  workspace" are hidden inside the dock; the main window is untouched.
- Header title row and its 76px fixed height collapse in the dock, so the tab
  strip sits directly under the title bar.
- Pin button moved next to the OS window buttons.

### Fixed

- First expand used to flash and close: the boot-time collapse loop now stops once
  the sidebar is collapsed and yields to the user's click.
- Removing the sidebar left the conversation at 0 width (the centre column is now
  pinned across all grid tracks instead of relying on grid-track order).
- Reloading the plugin left an orphaned Electron process holding the
  single-instance lock, so the next window could not start.

## [0.4.0] - 2026-11-03

The dock is now a window around DSH's own Web UI instead of a re-implementation.

### Added

- Frame shell page (`GET /quickdock?view=frame`) on a fixed loopback port: a
  draggable title bar with a sidebar toggle, pin and the OS close/minimise
  buttons, and the Web UI in an iframe (`/?token=…&dock=1`).
- The Dock button binds the session you are looking at; the shell forwards it to
  the app over `postMessage` (`quickdock:open-session`), so an already-open dock
  window follows the main window.
- Header menu: "Reset window size", "Reload the app" (reloads the iframe only)
  and "Restart the dock window".
- Dock-only layout rules: at dock width the expanded sidebar covers the whole
  window and collapses when a session is picked.

### Changed

- `port` (default `47910`) replaces the random DSH web-server origin; there is no
  token any more - the address is the handshake.
- `windowControls: system` draws the OS window buttons over the title bar,
  including a native border and shadow; `minimizable` is enabled.
- The dock window is opaque (`transparent: false`) because it hosts a foreign page.

### Removed

- The self-drawn dock UI (`web/`), its render layer and build script.
- The Host-side fold engine (`step-folded`, stream buffer, event log, interaction
  broker, session index, catalogs) - the app renders all of that itself now.
- The dock API (`/api/state`, `/stream`, `/turns`, `/task`, `/answer`, …); only
  `dock-target` and `meta` remain. See `API.md`.
- The command bus and the "open this session in DSH" bridge action.

## [Unreleased]

### Added

- `npm run clean-dsh-cookies`: removes the Desktop app's stale per-launch
  `dsh-auth-*` cookies. Frequent restarts (one random Host port per launch)
  eventually push the Cookie header past the 16 KB request limit, which shows
  up as `desktop welcome: Web authentication failed` and DSH refusing to open.
- A client-agnostic Host API for IDE plugins: `GET /api/meta` (capability manifest with
  `apiVersion`), `GET /api/workspaces`, `GET /api/sessions`, `GET /api/turns` and
  `GET /api/turn`. The dock UI keeps its read-only workspace chip and newest-turn
  rendering, while the backend supports switching and every turn. See `API.md`.
- Turns are retained instead of being reset on each prompt (`POST task` appends a turn):
  `state.steps` stays the newest turn while older turns remain readable, and up to
  8 sessions keep folded history in memory.

### Changed

- The ⟳ "Reload the conversation" button does something now: in the unified
  layout it reloads the docked pane (fresh state and turn history, which also
  restarts a stuck history loader), in the split layout it reloads the run window
  as before, and both layouts re-read the state. With nothing bound it says so
  instead of pretending.
- "Load earlier turns" now shows what it is doing: the pill turns into a disabled
  `Loading earlier turns…` with a spinner while the batch is in flight, and back
  with the new count when it lands. The batch is still inserted above the reader
  and the scroll offset grows with it, so the content being read does not move.
- Approvals are answered only in the input window's run panel; the run-list window
  no longer renders a second Allow/Deny card (questions keep their card, and a
  hidden list is no longer force-shown for an approval).
- The running row no longer paints a tinted background or a 2px brand bar: the
  spinner and the shimmering label are the only running indicators, and the row
  keeps the same margins as every other row (the two now-unused fill tokens are
  removed).
- Run-log rows are reconciled by id instead of being rebuilt whenever a step
  changes status, so a finishing tool no longer replays the list entry
  animation and loses the scroll position.
- Tool details and folded thinking now expand and collapse with a short height
  and fade transition instead of swapping `display`. A detail that is open only
  because its tool is running closes smoothly when the call finishes, while a
  row the user opened stays open.

### Fixed

- A new conversation keeps its send button on the composer row. The agent option
  adds a fourth function key, the row wrapped, and `↑` dropped onto a line of its
  own. The row no longer wraps: the keys shrink and ellipsize instead, the
  thinking effort keeps its width (it is one word), and the agent preset gives way
  first so the permission and model names stay readable.
- Permission, model and reasoning changed in DSH itself now reach the dock. They
  live on the session (DSH writes them there), and the dock only ever wrote its
  own copy, so it kept showing a stale value until the session was re-bound. The
  Host now follows the session projection feed and re-reads the session's values
  on every bound-session event, with a four-second fallback ticker while a page
  is open for anything the feed does not announce.
- "Detail mode: hidden" now hides the execution pane in the unified layout. The
  mode only closed the separate run window, which does not exist when both live in
  one window, so choosing it did nothing; the pane now collapses (and the window
  shrinks with it), the mode is applied before the first paint, and the display
  page no longer re-shows itself after the input page hid it.
- "Load earlier turns" keeps working past the first batch. The fold keeps only its
  newest `maxSteps` rows, so every older turn stayed listed while its rows were
  gone, and each batch after the first came back empty (`observed: true, steps: 0`).
  `GET turn` now answers from the fold only while the retention window never
  touched the turn; otherwise it rebuilds that one turn from the session log,
  replaying just up to the turn's end so the window cannot evict it again.
- The header Dock button is back after the bundle patch was emptied: DSH builds the
  page's client-module roster from the rows a bundle declares and resolves the
  client bundle from the row named after the package, so a patch of `[]` mounted
  nothing - no Host API, no client module, no button. `cordis.patch.yml` declares
  the `dsh-quickdock` row again, and `runtime/test/bundle-patch.test.js` pins that
  row, the client manifest and the module id together.
- An approval claimed by the dock is handed back to DSH when the dock hides, closes
  or crashes: the pending request resolves through `next()` so DSH's own dialog
  takes over instead of waiting for the five-minute approval timeout. A stale
  visible flag can no longer make a restarted/crashed dock claim requests either.
- The run window's transparent area no longer first appears as an opaque block: a
  hidden window is never armed click-through, the style is cleared before a window
  is shown, and arming waits for the first composited frame (with one repeat as a
  self-heal).
- Auto-follow no longer stops once the list grows past the viewport: follow mode is
  decided only by real gestures (wheel, touch, scrollbar drag, keys in the list).
  Layout shifts, the scrollbar appearing and programmatic writes can no longer
  pause it, and a non-gesture scroll while following re-pins to the newest row.
- The run-log list no longer changes width when a thinking or tool row pushes the
  content across the scrollbar threshold: the gutter is always reserved
  (`overflow-y: scroll` + `scrollbar-gutter: stable`), and both native size
  corrections use the same width reference, so the window cannot flutter by a
  rounded pixel on every state push.
- Tool rows keep the description intact: the code/value field is the flexible part
  (flex-basis 0, shrinks to 24px first) instead of the title being truncated while
  the field keeps its width.
- A folded thinking row ellipsizes at the right edge; the summary is no longer
  sliced to 42 characters in JS, so CSS draws the ellipsis where the row ends.
- Theme sync was effectively dead: DSH's built-in light/dark snapshots publish an
  empty token map (the palette lives in the `--dsw-*` stylesheets on `body`), so the
  dock always kept its own colours. The Client half now reads the resolved computed
  styles, follows `theme/change` and the `data-ds-dark-theme` flip, and pushes the
  palette over the bridge; both dock windows repaint without a reload.
- The first-paint palette block uses `html[data-theme]` so DSH values win over the
  dock's own light palette, a new palette retracts variables the previous one
  supplied, and text on the brand accent follows the base surface colour (DSH's
  accent is monochrome, so white-on-white was unreadable in dark mode).
- A tool that finishes while its detail is open refreshes that detail with the
  call result before it collapses, so reopening the row never shows stale args.
- The four function-key dropdowns closed themselves before they could be seen:
  the composer island does not stop click propagation, so the document's
  outside-click handler processed the same click that opened the menu (the menu
  opens in a microtask, before the click finishes bubbling). The menu now ignores
  the click that opened it.

## [0.3.0] - 2026-10-28

### Added

- Internationalization: `locale/en.json` and `locale/zh.json` catalogs, live language
  switching over SSE, `config.locale` (`auto` | `en` | `zh`), DSH locale-service
  integration in the Client half, and localized Host errors.
- Zero-dependency quality gates: `scripts/check.mjs` (catalog parity, key usage,
  embedded Client catalog, CJK/whitespace rules, asset manifest) and
  `scripts/smoke.mjs` (mock Host: page, API, locale switching).
- `scripts/run-tests.mjs`: runs the whole suite in one process, so tests work on hosts
  where spawning test workers is blocked.
- ESLint flat config, EditorConfig, shared test fixtures, CHANGELOG.

### Changed

- The Host half is split into `host/` modules behind a composition root:
  adapter for DSH services, SSE event hub, interaction broker, catalog service,
  session index repository, dock supervisor, page renderer, command-table API router.
- Page scripts are split under `web/` (i18n, utils, display view, menu, bootstrap) and
  inlined in `web/manifest.json` order.
- Session event folding uses a strategy table instead of a switch statement.
- All source comments are concise English; all user-facing text moved to catalogs.
- `scripts/ensure-electron.mjs` reuses the resolver constants instead of duplicating
  the Electron version.

### Fixed

- Dock start-up could fail silently after `npm install` provided a second Electron:
  the resolver now prefers the self-managed `%LOCALAPPDATA%` copy, because security
  software blocks Electron binaries under user folders (Desktop, `~/.dsh`) from writing
  their profile (singleton lock / cache: access denied, exit 0).
- The dock supervisor now advances to the next Electron candidate when the process
  exits before `ready`, and surfaces the last stderr line (`host.dockStartFailed`)
  instead of leaving the page to time out.
- `locale/` was git-ignored, so translations could never be committed.
- A duplicate menu-close call and an unused running counter in the page bootstrap.
- Theme completeness helper was dead code; removed with its constant.

## [0.2.0] - 2026-10-27

- Dual transparent windows, click-through hit regions, live assistant stream,
  in-place approvals, markdown replies, per-monitor geometry memory.
