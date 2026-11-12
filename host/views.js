/**
 * The shell page variants, selected with `?view=<name>`.
 *
 * One parameter decides two things that always travel together:
 *
 * - the chrome (a desktop window bar with pin/collapse/close, or the trimmed
 *   editor bar a webview gets), and
 * - how the DSH app is embedded (directly when the page is a first-party,
 *   same-site document, or through the Host's app proxy when the client is an
 *   embedded webview that cannot carry DSH's `SameSite=Strict` cookie).
 *
 * Clients pick a view, never a transport: `view=electron` for the desktop
 * window, `view=vscode` for an IDE webview, `view=browser` for a plain tab.
 * `view=frame` is the name every shell URL used before variants existed and
 * still means `electron`.
 */

import { DEFAULT_VIEW, VIEWS, VIEW_ALIASES } from './constants.js'

/**
 * Normalize a `view` query value.
 * @param {unknown} value raw query value (may be null).
 * @returns {string|undefined} a known view name, or undefined when unknown.
 */
export function normalizeView(value) {
  const raw = String(value ?? '').trim().toLowerCase()
  if (!raw) return DEFAULT_VIEW
  const name = VIEW_ALIASES[raw] || raw
  return Object.prototype.hasOwnProperty.call(VIEWS, name) ? name : undefined
}

/**
 * How the app is embedded for a view.
 * @param {string} view normalized view name.
 * @returns {'direct'|'proxy'} the transport.
 */
export function viewTransport(view) {
  return VIEWS[view]?.app || 'direct'
}

/** The view names a client may ask for, in the order the contract lists them. */
export function viewNames() {
  return Object.keys(VIEWS)
}
