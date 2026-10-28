# Changelog

All notable changes to this project are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow SemVer.

## [Unreleased]

### Changed

- Run-log rows are reconciled by id instead of being rebuilt whenever a step
  changes status, so a finishing tool no longer replays the list entry
  animation and loses the scroll position.
- Tool details and folded thinking now expand and collapse with a short height
  and fade transition instead of swapping `display`. A detail that is open only
  because its tool is running closes smoothly when the call finishes, while a
  row the user opened stays open.

### Fixed

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
