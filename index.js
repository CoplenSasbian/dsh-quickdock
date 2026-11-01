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
  // The package row mounts the service and stays active. Two reasons, both
  // learned the hard way:
  //  - DSH serves a package's client bundle (the header Dock button) for the row
  //    named after the package, so this row must activate;
  //  - a row that mounted nothing left the Host unregistered at start-up, so the
  //    dock only worked after reloading the plugin.
  // The windows are their own inserted row (dsh-quickdock/dock) and switch
  // independently.
  const host = new QuickDockHost(ctx, config)
  host.start({ service: true, dock: config.dock === true })
  if (config.dock === true) host.prefetchElectron()
  setHost(host)
  return host
}
