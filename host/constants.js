/**
 * Shared constants for the Host half.
 *
 * Values that both the HTTP layer and the window lifecycle depend on live here so
 * a change cannot drift between modules.
 */

/** Page route served to the dock window (the frame shell). */
export const PAGE_PATH = '/quickdock'
/** Prefix for the shell's JSON API. */
export const API_PREFIX = '/quickdock/api/'
/** Bridge route used by the browser Client half (cookie-authenticated). */
export const BRIDGE_PATH = '/api/quickdock'
/** Loopback address the shell page and its API listen on. */
export const BIND_HOST = '127.0.0.1'
/** Port used when the config does not set one. */
export const DEFAULT_PORT = 47910
/** Client protocol version reported by GET /quickdock/api/meta. */
export const API_VERSION = 2
/** Shell page variants, selected with `?view=<name>` (see host/views.js). */
export const VIEWS = Object.freeze({
  /** The desktop window: drag bar, pin, collapse, close; the app is embedded directly. */
  electron: { app: 'direct' },
  /** An IDE webview: trimmed bar, no window controls; the app comes through the app proxy. */
  vscode: { app: 'proxy' },
  /** A plain browser tab: trimmed bar, the app is embedded directly. */
  browser: { app: 'direct' }
})
/** The default view, and the name older shell URLs used. */
export const DEFAULT_VIEW = 'electron'
/** Names kept working for existing links. */
export const VIEW_ALIASES = Object.freeze({ frame: 'electron' })
/** A theme payload below this many tokens is treated as incomplete. */
export const MIN_THEME_TOKENS = 6
/**
 * Fixed window bounds.
 *
 * These used to be four settings of their own. Four rows for a value nobody
 * tunes - and a resize handle already says what fits - so they are constants
 * now: a floor the layout survives and a ceiling a floating window wants.
 */
export const WINDOW_BOUNDS = Object.freeze({
  minWidth: 360,
  minHeight: 420,
  maxWidth: 900,
  maxHeight: 1400
})
/** Bounds for a single buffered stdout line from the dock process. */
export const DOCK_STDOUT_LIMIT = 1024 * 1024
/** Restart backoff for a dock process that keeps crashing. */
export const DOCK_BACKOFF_MS = Object.freeze([1000, 2000, 4000, 8000, 16000])
