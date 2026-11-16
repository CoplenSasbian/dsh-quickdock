/**
 * dsh-quickdock — Host half.
 *
 * Responsibilities live in host/: the shell page and its listener, the session
 * target the window follows, Electron resolution and window supervision. This
 * module only declares the plugin contract (name, injected services, config
 * schema).
 *
 * Hard rules:
 *  - never import a @deepseek-ai/dsh-client-* runtime package
 *  - the dock content is DSH's own Web UI; do not model sessions here
 */
import Schema from '@deepseek-ai/schemastery'

import { configSchema } from './host/config-schema.js'
import { QuickDockHost } from './host/quickdock-host.js'
import { setHost } from './host/shared.js'
// Same package, same bundle: the workspace-scoped MCP bridge mounts as a child
// plugin of this row instead of shipping a second package.
import * as workspaceMcp from './host/workspace-mcp.js'

export const name = 'dsh-quickdock'

/**
 * Required host services: the browser connection bridge. The dock page and its
 * API have their own loopback listener (config.port), so DSH's web server is no
 * longer needed.
 */
export const inject = ['connection']

export const Config = Schema.object(configSchema)

/**
 * Activate the plugin.
 * @param {object} ctx Cordis host context.
 * @param {object} config validated configuration.
 */
export function apply(ctx, config) {
  if (!config.enabled) return undefined
  if (config.mcpBridge) {
    // Per-workspace MCP registration (`POST /workspace-mcp/register`) so a dock
    // can hand DSH tools that only apply to the directory it is editing.
    ctx.plugin(workspaceMcp, {
      token: config.mcpBridgeToken || null,
      waitForSessionsMs: config.mcpBridgeWaitMs,
    })
  }
  const host = new QuickDockHost(ctx, config)
  // One row mounts both components again. DSH builds its client-module roster
  // from the bundle rows, and an inserted subpath row (dsh-quickdock/dock) is not
  // a package specifier - the header Dock button disappeared with it.
  host.start()
  host.prefetchElectron()
  setHost(host)
  return host
}
