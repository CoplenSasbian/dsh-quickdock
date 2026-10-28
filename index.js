/**
 * dsh-quickdock — Host half.
 *
 * Responsibilities live in host/: page + API hosting, session event folding,
 * approval interception, Electron resolution and dock supervision. This module
 * only declares the plugin contract (name, injected services, config schema).
 *
 * Hard rules:
 *  - never import a @deepseek-ai/dsh-client-* runtime package
 *  - read session/event only; no new event types are written
 */
import Schema from '@deepseek-ai/schemastery'

import { QuickDockHost } from './host/quickdock-host.js'

export const name = 'dsh-quickdock'

/** Required host services: HTTP hosting and the browser connection bridge. */
export const inject = ['webServer', 'connection']

export const Config = Schema.object({
  enabled: Schema.boolean().default(true),
  /**
   * Start the dock together with the plugin.
   * Default false keeps the dock on demand: Electron starts on the first click
   * and exits with the window. True keeps it resident (close hides it).
   */
  autoLaunch: Schema.boolean().default(false),
  /** Content width shared by both windows (input + run). */
  width: Schema.number().default(480),
  /** Fixed height of the input window. */
  inputHeight: Schema.number().default(172),
  /** Fixed height of the run window (content scrolls inside it). */
  displayHeight: Schema.number().default(520),
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
})

/**
 * Activate the plugin.
 * @param {object} ctx Cordis host context.
 * @param {object} config validated configuration.
 */
export function apply(ctx, config) {
  if (!config.enabled) return
  new QuickDockHost(ctx, config).start()
}
