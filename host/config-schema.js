/**
 * The config fields shared by the three entry points.
 *
 * `index.js` (both components), `service.js` and `dock.js` validate against this
 * object, so a knob added here appears everywhere.
 */

import Schema from '@deepseek-ai/schemastery'

/** Raw field descriptors for Schema.object. */
export const configSchema = {

  enabled: Schema.boolean().default(true),
  /**
   * The Host API: routes, SSE, folds, interactions, session index.
   * Turn it off only when another instance already serves the same origin.
   */
  service: Schema.boolean().default(true),
  /**
   * Mount the windows in *this* row as well.
   *
   * Off by default: the package's cordis.patch.yml inserts dsh-quickdock/dock as
   * its own row, so DSH owns that switch. Set it to true for a single-entry
   * install where no component row is inserted.
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
  /** Content width shared by both windows (input + run). */
  width: Schema.number().default(480),
  /** Fixed height of the input window. */
  inputHeight: Schema.number().default(172),
  /** Fixed height of the run window (content scrolls inside it). */
  displayHeight: Schema.number().default(520),
  todoHeight: Schema.number().default(180),
  todoWindow: Schema.boolean().default(false),
  layout: Schema.string().default('unified'),
  margin: Schema.number().default(16),
  rememberGeometry: Schema.boolean().default(true),
  alwaysOnTop: Schema.boolean().default(false),
  focusOnSummon: Schema.boolean().default(false),
  hideOnEscape: Schema.boolean().default(true),
  followBoundOnly: Schema.boolean().default(true),
  defaultWorkspaceId: Schema.string().default(''),
  agentPreset: Schema.string().default(''),
  /** 'queue' (default) or 'steer' while the agent is running. */
  submitMode: Schema.string().default('queue'),
  thinkMode: Schema.string().default('fold'),
  showTiming: Schema.boolean().default(true),
  maxSteps: Schema.number().default(200),
  /** Fallback scheme before the Client half reports the theme: 'auto' | 'light' | 'dark'. */
  theme: Schema.string().default('auto'),
  /** 'auto' follows the DSH/browser language; 'en' and 'zh' force one. */
  locale: Schema.string().default('auto'),
  headerButton: Schema.boolean().default(true),
  headerButtonOrder: Schema.number().default(1010),
  approvalTimeoutMs: Schema.number().default(300000)
}
