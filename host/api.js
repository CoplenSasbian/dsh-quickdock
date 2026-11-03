/**
 * The dock API: two read-only endpoints.
 *
 * The dock window is the DSH Web UI itself (in an iframe), so there is no dock
 * data model to expose any more - the app talks to DSH directly. What remains is
 * the little the shell has to ask the Host about: which session the window should
 * show, and whether the user asked for a reload.
 */

import { sendJson } from './http.js'

const ROUTES = [
  {
    method: 'GET',
    path: 'dock-target',
    handle: ({ app }) => app.dockTargetInfo()
  },
  {
    // The reverse direction: the dock asks the main DSH window to show a session.
    // The main window's Client half polls this and switches when `seq` moves.
    method: 'GET',
    path: 'handoff',
    handle: ({ app }) => app.handoffInfo()
  },
  {
    method: 'GET',
    path: 'meta',
    handle: ({ app }) => app.meta()
  }
]

/**
 * Build the API handler.
 * @param {{app: object, trace: Function, logger: object}} deps
 * @returns {{handle: Function}}
 */
export function createApiRouter(deps) {
  const { app, trace, logger } = deps

  return {
    async handle(req, res, url) {
      const path = url.pathname.slice('/quickdock/api/'.length)
      const route = ROUTES.find((entry) => entry.method === req.method && entry.path === path)
      if (!route) {
        sendJson(res, 404, { error: app.t('host.notFound') })
        return
      }
      try {
        sendJson(res, 200, await route.handle({ app, url, req, res }))
      } catch (error) {
        const message = String(error?.message || error)
        trace('api ' + url.pathname + ' failed: ' + message)
        logger?.warn?.('quickdock: %s failed: %s', url.pathname, message)
        sendJson(res, 400, { ok: false, error: message })
      }
    }
  }
}
