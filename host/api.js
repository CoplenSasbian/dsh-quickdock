/**
 * The dock API: the little the shell (and a connecting dock) has to ask the
 * Host about — which session a dock shows, which docks are connected, and the
 * context a client registers when it connects.
 *
 * The dock window is the DSH Web UI itself (in an iframe), so there is still no
 * dock data model beyond `DockContext` (see `DOCK-CONTEXT.md`).
 */

import { sendJson } from './http.js'

/** Read a JSON body; an empty body is an empty object. */
async function readBody(req) {
  const limit = 64 * 1024
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text.trim()) return {}
  const parsed = JSON.parse(text)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('body must be an object')
  return parsed
}

const ROUTES = [
  {
    method: 'GET',
    path: 'dock-target',
    // Per-dock binding; no dock falls back to the pre-context global binding.
    handle: ({ app, url }) => app.dockTargetInfo(url.searchParams.get('dock') || '')
  },
  {
    // Every connected dock, for the Client half's dock menu.
    method: 'GET',
    path: 'dock-contexts',
    handle: ({ app }) => app.dockContextsInfo()
  },
  {
    // A connecting dock registers/updates its context: id, type, tools, workspace.
    method: 'POST',
    path: 'dock-context',
    handle: async ({ app, req }) => app.postDockContext(await readBody(req))
  },
  {
    // Closed dock: remove the context, its binding and its tools.
    method: 'DELETE',
    path: 'dock-context',
    handle: ({ app, url }) => app.deleteDockContext(url.searchParams.get('id') || '')
  },
  {
    // The shell or an IDE binds its own dock to a session.
    method: 'POST',
    path: 'bind',
    handle: async ({ app, req, url }) =>
      app.postBind(await readBody(req), url.searchParams.get('dock') || '')
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
