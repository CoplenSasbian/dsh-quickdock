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
  // This row stays *active* on purpose and mounts nothing: DSH serves a package's
  // client bundle (the header Dock button) for the entry named after the package,
  // and an entry that never activated serves nothing. The two components below do
  // the work, each with its own switch:
  //   quickdock-service - the Host API
  //   quickdock-dock    - the windows
  ctx.logger?.info?.('quickdock: package row active; components are quickdock-service and quickdock-dock')
  return { name: 'dsh-quickdock', components: ['quickdock-service', 'quickdock-dock'] }
}
