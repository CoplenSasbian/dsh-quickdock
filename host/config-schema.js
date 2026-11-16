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
   * Serve the per-workspace MCP bridge.
   *
   * A dock registers its MCP endpoint with the working directory it belongs to
   * (`POST /workspace-mcp/register` on the DSH web origin); sessions inside that
   * directory mount the endpoint's tools, sessions elsewhere never see them.
   * A dock also reaches the same registry through this listener
   * (`/quickdock/api/mcp-register` and friends), which is how an IDE that knows
   * only the QuickDock port pairs. See MCP-BRIDGE.md. This is the same package -
   * one bundle, one install.
   */
  mcpBridge: Schema.boolean().default(true),
  /**
   * Shared secret for the bridge route.
   *
   * Empty keeps loopback-only access (default). Set to require
   * `x-workspace-mcp-token: <value>` (or `Authorization: Bearer <value>`) from
   * docks, which matters when DSH's web server is reachable from another host.
   */
  mcpBridgeToken: Schema.string().default(''),
  /** How long a register call waits for already-running sessions to settle (ms). */
  mcpBridgeWaitMs: Schema.number().default(15000),
  /**
   * Loopback port for the shell page and its API.
   *
   * The address is the whole handshake: there is no token, so any local client -
   * the dock window, an IDE extension - only needs
   * `http://127.0.0.1:<port>/quickdock?view=<electron|vscode|browser>` (see
   * host/views.js).
   * This is the deploy-time default; the value a user changes (Settings →
   * QuickDock, or config.json) wins over it. When the port is taken the Host logs
   * EADDRINUSE and keeps serving nothing new until it is moved. 0 disables the
   * listener (used by tests).
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
  windowControls: Schema.string().default('custom'),
  /** Diameter of the floating whale ball the window collapses into (24-160). */
  ballSize: Schema.number().default(64)
}
