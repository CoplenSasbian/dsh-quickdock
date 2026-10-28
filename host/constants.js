/**
 * Shared constants for the Host half.
 *
 * Values that both the HTTP layer and the dock lifecycle depend on live here so
 * a change cannot drift between modules.
 */

/** Page route served to both dock windows. */
export const PAGE_PATH = '/quickdock'
/** Prefix for the page's JSON API. */
export const API_PREFIX = '/quickdock/api/'
/** Bridge route used by the browser Client half (cookie-authenticated). */
export const BRIDGE_PATH = '/api/quickdock'
/** HTML view names, also used as query values. */
export const VIEWS = Object.freeze({ input: 'input', display: 'display' })

/** Client protocol version reported by GET /quickdock/api/meta. */
export const API_VERSION = 1
/** How many sessions keep a folded turn history in memory (LRU when exceeded). */
export const MAX_TRACKED_SESSIONS = 8

/** A theme payload below this many tokens is treated as incomplete. */
export const MIN_THEME_TOKENS = 6

/** Stream folding limits: pages only render tails, so long tails are dropped. */
export const STREAM_LIMITS = Object.freeze({ thinking: 2000, text: 4000, args: 240 })
/** Token streams are coalesced to one state push per interval. */
export const STREAM_FLUSH_MS = 100
/** Session titles change slowly; an index refresh per event burst is waste. */
export const SESSION_INDEX_TTL_MS = 10_000
/** Idle SSE sockets are pinged to survive intermediate proxies. */
export const SSE_PING_MS = 20_000
/** Periodic session-index refresh while a dock page is connected. */
export const INDEX_TICKER_MS = 20_000
/** Delay before the model catalog is warmed up. */
export const CATALOG_WARMUP_MS = 1500
/** Restart backoff for a dock process that keeps crashing. */
export const DOCK_BACKOFF_MS = Object.freeze([1000, 2000, 4000, 8000, 16000])
/** Bound for a single buffered stdout line from the dock process. */
export const DOCK_STDOUT_LIMIT = 1024 * 1024
/** Bound for a JSON request body posted by the dock page. */
export const MAX_BODY_BYTES = 256 * 1024
