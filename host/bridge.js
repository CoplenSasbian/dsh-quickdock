/**
 * Browser bridge (`/api/quickdock`).
 *
 * The static Client half has no `host.call`, so it talks to the Host through a
 * cookie-authenticated connection.fetch route. Actions are a lookup table for
 * the same reason the API is: one command per line, no branching soup.
 */

/**
 * @param {{app: object}} deps app is the QuickDockHost instance.
 * @returns {(request: Request) => Promise<Response>} fetch handler.
 */
export function createBridgeHandler(deps) {
  const { app } = deps

  const actions = {
    bind(body) {
      const sessionId = String(body?.sessionId ?? '')
      if (!sessionId) return { status: 400, body: { ok: false, error: 'sessionId required' } }
      return { body: app.postBind({ sessionId }) }
    },
    summon() {
      app.dock.summon()
      return { body: { ok: true, error: app.state.dock.error || undefined } }
    },
    status() {
      // The Client polls this because dock start-up is asynchronous.
      return {
        body: {
          ok: true,
          running: app.dock.alive,
          starting: app.dock.starting,
          error: app.state.dock.error || ''
        }
      }
    },
    theme(body) {
      return { body: { ok: app.acceptTheme(body?.theme ?? body?.payload) } }
    },
    locale(body) {
      return { body: { ok: app.acceptLocale(body?.locale), locale: app.locale.locale } }
    },
    'web-url'() {
      return { body: { ok: true, url: app.pageUrl() } }
    }
  }

  return async function bridge(request) {
    let body = {}
    try {
      body = await request.json()
    } catch (_) {
      body = {}
    }
    const action = String(body?.action ?? '')
    const entry = actions[action]
    if (!entry) return Response.json({ ok: false, error: 'unknown action' }, { status: 400 })
    const result = entry(body)
    return Response.json(result.body, result.status ? { status: result.status } : undefined)
  }
}
