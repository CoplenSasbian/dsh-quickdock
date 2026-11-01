/**
 * Entry point: the windows.
 *
 * `dsh-quickdock/dock` attaches the window component to the service started by
 * `dsh-quickdock/service`. Enabling or disabling it in DSH's plugin list is
 * exactly enabling or disabling the dock.
 */

import Schema from '@deepseek-ai/schemastery'
import { getHost } from './host/shared.js'
import { configSchema } from './host/config-schema.js'

export const name = 'dsh-quickdock (dock)'

/** Nothing is registered here: the service owns the HTTP surface. */
export const inject = []

export const Config = Schema.object(configSchema)

/**
 * Attach the window component to the running service.
 * @param {object} ctx Cordis host context.
 * @param {object} config validated configuration.
 * @returns {object|undefined} the host, or undefined when it cannot mount.
 */
export function apply(ctx, config) {
  if (!config.enabled) return undefined
  const host = getHost()
  if (!host) {
    ctx.logger?.warn?.('quickdock: the dock entry needs dsh-quickdock/service enabled; no dock was mounted')
    return undefined
  }
  host.mountDock()
  return host
}
