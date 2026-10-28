/**
 * Dock page API.
 *
 * Routes are data, not an if-chain: each entry is one command with a method, a
 * path and a handler. Adding an endpoint touches one line here.
 */

import { API_PREFIX, MAX_BODY_BYTES } from './constants.js'

/** Write a JSON response (no caching: state is pushed, never cached). */
export function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  })
  res.end(JSON.stringify(body))
}

/** Read and parse a JSON body; oversized or malformed input yields {}. */
export async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) break
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch (_) {
    return {}
  }
}

/**
 * Route table. `handle` receives the host facade plus the request context and
 * returns JSON data (thrown errors become a readable 400).
 */
const ROUTES = [
  {
    method: 'POST',
    path: 'task',
    handle: ({ app, body }) => app.postTask(body)
  },
  {
    method: 'POST',
    path: 'select',
    handle: ({ app, body }) => app.postSelect(body)
  },
  {
    method: 'POST',
    path: 'settings',
    handle: ({ app, body }) => app.postSettings(body)
  },
  {
    method: 'POST',
    path: 'stop',
    handle: ({ app }) => app.postStop()
  },
  {
    method: 'POST',
    path: 'bind',
    handle: ({ app, body }) => app.postBind(body)
  },
  {
    method: 'POST',
    path: 'answer',
    handle: ({ app, body }) => ({ ok: app.answer(body) })
  },
  {
    method: 'POST',
    path: 'theme',
    handle: ({ app, body }) => ({ ok: app.acceptTheme(body) })
  },
  {
    method: 'POST',
    path: 'locale',
    handle: ({ app, body }) => ({ ok: app.acceptLocale(body?.locale ?? body) })
  },
  {
    method: 'POST',
    path: 'window',
    handle: ({ app, body }) => app.postWindow(body)
  },
  {
    method: 'POST',
    path: 'open-session',
    handle: ({ app, body }) => app.postOpenSession(body)
  },
  {
    method: 'POST',
    path: 'open-in-dsh',
    handle: ({ app }) => app.openSessionInDsh()
  },
  {
    method: 'GET',
    path: 'meta',
    handle: ({ app }) => app.meta()
  },
  {
    method: 'GET',
    path: 'workspaces',
    handle: ({ app }) => app.listWorkspaces()
  },
  {
    method: 'GET',
    path: 'sessions',
    handle: ({ app, url }) => app.listSessions(url.searchParams.get('workspaceId') || '')
  },
  {
    method: 'GET',
    path: 'turns',
    handle: ({ app, url }) => app.listTurns(url.searchParams.get('sessionId') || '')
  },
  {
    method: 'GET',
    path: 'turn',
    handle: ({ app, url }) => app.turnDetail(
      url.searchParams.get('turn') ?? '',
      url.searchParams.get('sessionId') || ''
    )
  },
  {
    method: 'GET',
    path: 'state',
    handle: ({ app }) => app.snapshot()
  },
  {
    method: 'GET',
    path: 'catalogs',
    handle: async ({ app }) => {
      await app.refreshModels()
      return app.catalogs()
    }
  },
  {
    method: 'GET',
    path: 'step-detail',
    handle: ({ app, url }) => app.stepDetail(
      url.searchParams.get('id') || '',
      url.searchParams.get('sessionId') || ''
    )
  }
]

/**
 * Build the API handler.
 * @param {{app: object, token: string, trace: Function, logger: object}} deps
 *   app is the QuickDockHost instance (see host/quickdock-host.js).
 * @returns {{handle: (req: import('node:http').IncomingMessage,
 *                    res: import('node:http').ServerResponse, url: URL) => Promise<void>}}
 */
export function createApiRouter(deps) {
  const { app, token, trace, logger } = deps

  /**
   * Page authentication: Bearer for fetch, ?t= for EventSource (which cannot
   * set headers; without it /api/stream was always 401).
   */
  function authed(req, url) {
    if (req.headers.authorization === 'Bearer ' + token) return true
    const supplied = url?.searchParams?.get('t')
    return Boolean(supplied) && supplied === token
  }

  async function dispatch(req, res, url) {
    const path = url.pathname.slice(API_PREFIX.length)
    const body = req.method === 'POST' ? await readJsonBody(req) : null

    // Streams own their response object and must be handled before the table.
    if (req.method === 'GET' && path === 'stream') {
      app.openStateStream(req, res)
      return
    }
    if (req.method === 'GET' && path === 'bus') {
      app.openBusStream(req, res)
      return
    }
    const route = ROUTES.find((entry) => entry.method === req.method && entry.path === path)
    if (!route) {
      sendJson(res, 404, { error: app.t('host.notFound') })
      return
    }
    sendJson(res, 200, await route.handle({ app, url, body, req, res }))
  }

  return {
    async handle(req, res, url) {
      if (!authed(req, url)) {
        sendJson(res, 401, { error: app.t('host.unauthorized') })
        return
      }
      try {
        await dispatch(req, res, url)
      } catch (error) {
        // DSH turns thrown handler errors into an empty 400; keep the reason.
        const message = String(error?.message || error)
        trace('api ' + url.pathname + ' failed: ' + message + (error?.stack ? '\n' + error.stack : ''))
        logger?.warn?.('quickdock: %s failed: %s', url.pathname, message)
        sendJson(res, 400, { ok: false, error: message })
      }
    }
  }
}
