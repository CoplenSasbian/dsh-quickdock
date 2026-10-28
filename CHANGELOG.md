# Changelog

All notable changes to this project are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow SemVer.

## [Unreleased]

### Added

- A client-agnostic Host API for IDE plugins: `GET /api/meta` (capability manifest with
  `apiVersion`), `GET /api/workspaces`, `GET /api/sessions`, `GET /api/turns` and
  `GET /api/turn`. The dock UI keeps its read-only workspace chip and newest-turn
  rendering, while the backend supports switching and every turn. See `API.md`.
- Turns are retained instead of being reset on each prompt (`POST task` appends a turn):
  `state.steps` stays the newest turn while older turns remain readable, and up to
  8 sessions keep folded history in memory.

### Changed

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
