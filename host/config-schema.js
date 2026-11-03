/**
 * The config fields shared by the three entry points.
 *
 * `index.js` (both components), `service.js` and `dock.js` validate against this
 * object, so a knob added here appears everywhere.
 *
 * The dock is a window around DSH's own Web UI, so the knobs are about the window
 * (size, pinning, controls), not about rendering conversation content.
 */

import Schema from '@deepseek-ai/schemastery'

/** Raw field descriptors for Schema.object. */
export const configSchema = {
  enabled: Schema.boolean().default(true),
  /**
   * The Host half: the shell page, its listener and the browser bridge.
   * Turn it off only when another instance already serves the same port.
   */
  service: Schema.boolean().default(true),
  /**
   * Mount the window in *this* row as well.
   *
   * Off by default: the package's cordis.patch.yml inserts dsh-quickdock as one
   * row that mounts both components; the separate `dsh-quickdock/dock` entry
   * exists for installs that split them.
   */
  dock: Schema.boolean().default(false),
  /**
   * Start the dock together with the plugin.
   * Default false keeps the dock on demand: Electron starts on the first click
   * and exits with the window. True keeps it resident (close hides it).
   */
  autoLaunch: Schema.boolean().default(false),
  /**
   * Fetch the desktop runtime as soon as the plugin mounts (~100 MB, once).
   * On (default) keeps the first Dock click instant; off moves the download to
   * that click instead.
   */
  prefetchElectron: Schema.boolean().default(true),
  /** Content width of the dock window. */
  width: Schema.number().default(480),
  /** Content height of the dock window (the shell + the embedded app). */
  inputHeight: Schema.number().default(820),
  margin: Schema.number().default(16),
  rememberGeometry: Schema.boolean().default(true),
  alwaysOnTop: Schema.boolean().default(false),
  focusOnSummon: Schema.boolean().default(false),
  /** Fallback scheme before the Client half reports the theme: 'auto' | 'light' | 'dark'. */
  theme: Schema.string().default('auto'),
  /** 'auto' follows the DSH/browser language; 'en' and 'zh' force one. */
  locale: Schema.string().default('auto'),
  headerButton: Schema.boolean().default(true),
  headerButtonOrder: Schema.number().default(1010),
  /**
   * Fixed loopback port for the shell page and its API.
   *
   * The address is the whole handshake: there is no token, so any local client -
   * the dock window, an IDE extension - only needs `http://127.0.0.1:<port>`.
   * When something else already listens there the Host logs EADDRINUSE and this
   * is the one setting to change. 0 disables the listener (used by tests).
   */
  port: Schema.number().default(47910),
  /**
   * Let clicks through the transparent parts of the window.
   *
   * The shell page posts hit regions; a page that does not (an IDE webview) needs
   * it off or the whole window becomes unclickable.
   */
  clickThrough: Schema.boolean().default(true),
  /**
   * Window controls: 'custom' keeps the frameless dock look and the shell's own
   * buttons; 'system' lets the OS draw close/minimise/maximise over the page.
   */
  windowControls: Schema.string().default('custom')
}
