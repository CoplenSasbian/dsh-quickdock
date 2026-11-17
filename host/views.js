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
 * window, `view=vscode` / `view=intellij` / `view=visualstudio` for an editor
 * webview (VS Code, JetBrains, Visual Studio), `view=browser` for a plain tab.
 * `view=frame` is the name every shell URL used before variants existed and
 * still means `electron`.
 *
 * An editor view is more than chrome: the shell passes its name to the app as
 * `host`, and the app uses it to decide that a clicked file belongs to the
 * embedding editor (see `client.js` `EDITOR_HOSTS`). A name the app does not
 * know still renders, it just loses that hand-off.
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
