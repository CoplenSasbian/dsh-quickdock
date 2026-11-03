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
export const API_VERSION = 1
/** A theme payload below this many tokens is treated as incomplete. */
export const MIN_THEME_TOKENS = 6
/** Bounds for a single buffered stdout line from the dock process. */
export const DOCK_STDOUT_LIMIT = 1024 * 1024
/** Restart backoff for a dock process that keeps crashing. */
export const DOCK_BACKOFF_MS = Object.freeze([1000, 2000, 4000, 8000, 16000])
