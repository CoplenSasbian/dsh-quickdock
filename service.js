/**
 * Entry point: the Host API alone.
 *
 * `dsh-quickdock/service` serves routes, SSE, folds and interactions and owns no
 * window (no Electron). Pair it with `dsh-quickdock/dock` when the windows are
 * wanted; the combined entry `dsh-quickdock` (index.js) mounts both.
 */

import Schema from '@deepseek-ai/schemastery'
import { QuickDockHost } from './host/quickdock-host.js'
import { setHost } from './host/shared.js'
import { configSchema } from './host/config-schema.js'

export const name = 'dsh-quickdock (service)'

/** The Host serves its own loopback port; only the browser bridge needs DSH. */
export const inject = ['connection']

/** The service entry never mounts windows; the dock row does that. */
export const Config = Schema.object(configSchema)

/**
 * Activate the service component.
 * @param {object} ctx Cordis host context.
 * @param {object} config validated configuration.
 * @returns {object|undefined} the host, or undefined when disabled.
 */
export function apply(ctx, config) {
  if (!config.enabled) return undefined
  const host = new QuickDockHost(ctx, config)
  host.start({ service: true, dock: false })
  setHost(host)
  return host
}
