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

import { configSchema } from './host/config-schema.js'
import { QuickDockHost } from './host/quickdock-host.js'
import { setHost } from './host/shared.js'

export const name = 'dsh-quickdock'

/** Required host services: HTTP hosting and the browser connection bridge. */
export const inject = ['webServer', 'connection']

export const Config = Schema.object(configSchema)

/**
 * Activate the plugin.
 * @param {object} ctx Cordis host context.
 * @param {object} config validated configuration.
 */
export function apply(ctx, config) {
  if (!config.enabled) return undefined
  const host = new QuickDockHost(ctx, config)
  // Both components from this one row: the API and the windows. A subpath row
  // (dsh-quickdock/dock) was tried for a separate switch, but DSH's client-module
  // scan then lost the package's bundle and the header Dock button with it.
  host.start()
  host.prefetchElectron()
  setHost(host)
  return host
}
