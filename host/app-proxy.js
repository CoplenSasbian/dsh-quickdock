/**
 * The app proxy: DSH's Web UI for clients that embed QuickDock in a webview.
 *
 * DSH hands out its page through a one-shot `?token=` URL and then authenticates
 * every later request with an httpOnly, `SameSite=Strict` cookie. A page inside
 * another application (an IDE webview) is a third-party context for `127.0.0.1`,
 * so that cookie is never stored or sent and the app lands on "web
 * authentication required" - even though the same URL opens fine in a browser
 * tab, where the page is the top-level document.
 *
 * This proxy makes the app same-origin with the shell page QuickDock already
 * serves: it adds the token on document requests, keeps the auth cookie on the
 * Host side, and forwards API calls and WebSockets untouched. The embedding
 * client never sees the token or the cookie.
 *
 * Only `view=vscode` uses it; `view=electron` and `view=browser` stay on the
 * direct URL, where the cookie works as designed.
 */

import { createServer, request as httpRequest } from 'node:http'
import { connect as netConnect } from 'node:net'

/** The auth cookie DSH mints on the token redirect. */
const AUTH_COOKIE = /^(dsh-auth-[^=]+=[^;]+)/
/** Request headers worth forwarding; hop-by-hop and cross-site hints are dropped. */
const FORWARDED_HEADERS = [
  'accept',
  'accept-language',
  'content-type',
  'content-length',
  'range',
  'if-none-match',
  'if-modified-since'
]

/**
 * Split the authenticated app URL into what the proxy needs.
 * @param {string} value the Web UI URL (token included).
 * @returns {{origin: string, token: string, dock: boolean}} upstream details.
 */
export function parseAppUrl(value) {
  const url = new URL(value)
  return {
    origin: url.origin,
    token: url.searchParams.get('token') || '',
    dock: url.searchParams.get('dock') === '1'
  }
}

/** Whether a request loads a document (and therefore needs the token). */
function isDocumentRequest(request) {
  const destination = request.headers['sec-fetch-dest']
  if (destination === 'document' || destination === 'iframe') return true
  return String(request.headers.accept ?? '').includes('text/html')
}

/** Headers forwarded to the app; the browser's cookie jar is not among them. */
function requestHeaders(request) {
  const forwarded = {}
  for (const key of FORWARDED_HEADERS) {
    const value = request.headers[key]
    if (value !== undefined) forwarded[key] = value
  }
  return forwarded
}

/** Remember the auth cookie an app response sets. */
function rememberCookie(response, state) {
  const raw = response.headers['set-cookie']
  const values = Array.isArray(raw) ? raw : raw ? [raw] : []
  for (const value of values) {
    const match = AUTH_COOKIE.exec(value)
    if (match) state.cookie = match[1]
  }
}

/**
 * Start the app proxy on an ephemeral loopback port.
 *
 * The listener is unreferenced: the Host's own listener (or DSH) keeps the
 * process alive, and a headless test that never disposes the proxy must still
 * exit.
 * @param {{upstreamUrl: string, trace?: Function}} input the authenticated app URL.
 * @returns {Promise<{origin: string, dispose: Function}>} the proxy once listening.
 */
export function startAppProxy(input) {
  const upstream = parseAppUrl(input.upstreamUrl)
  const trace = input.trace || (() => {})
  const state = { cookie: '' }

  const handler = (request, response) => {
    forward(request, response).catch((error) => {
      const message = String(error?.message || error)
      trace('app proxy: request failed: ' + message)
      if (!response.headersSent) response.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end('QuickDock app proxy: ' + message)
    })
  }

  /** One upstream round trip; the caller owns the pipeline. */
  function requestUpstream(request, target, headers) {
    return new Promise((resolve, reject) => {
      const outgoing = httpRequest(
        {
          hostname: target.hostname,
          port: target.port || 80,
          path: target.pathname + target.search,
          method: request.method,
          headers
        },
        resolve
      )
      outgoing.on('error', reject)
      request.pipe(outgoing)
    })
  }

  async function forward(request, response) {
    const target = new URL(request.url ?? '/', upstream.origin)
    const document = isDocumentRequest(request)

    /** Build the upstream request for the current cookie state. */
    const prepare = (withCookie) => {
      const next = new URL(request.url ?? '/', upstream.origin)
      if (document) {
        // The token unlocks the page; once the cookie is held it is not needed,
        // and re-sending it would only trigger another redirect.
        if (!withCookie && upstream.token) next.searchParams.set('token', upstream.token)
        if (upstream.dock && !next.searchParams.has('dock')) next.searchParams.set('dock', '1')
      }
      const headers = requestHeaders(request)
      if (withCookie && state.cookie) headers.cookie = state.cookie
      return { target: next, headers }
    }

    const first = prepare(Boolean(state.cookie))
    let upstreamResponse = await requestUpstream(request, first.target, first.headers)

    // A stale cookie (DSH restarted with a new signing key) must not wedge the
    // page: drop it and take the token path again.
    if (upstreamResponse.statusCode === 401 && state.cookie && request.method === 'GET') {
      state.cookie = ''
      upstreamResponse.resume()
      const retry = prepare(false)
      upstreamResponse = await requestUpstream(request, retry.target, retry.headers)
    }
    rememberCookie(upstreamResponse, state)

    const headers = { ...upstreamResponse.headers }
    // Cookies are the problem this proxy exists to sidestep; they stay upstream.
    delete headers['set-cookie']
    delete headers['transfer-encoding']
    delete headers['connection']
    const location = headers.location
    if (typeof location === 'string') {
      try {
        const resolved = new URL(location, target)
        if (resolved.origin === upstream.origin) headers.location = resolved.pathname + resolved.search
      } catch (_) {
        /* keep the header as served */
      }
    }

    response.writeHead(upstreamResponse.statusCode ?? 502, headers)
    upstreamResponse.pipe(response)
  }

  /**
   * Forward a WebSocket upgrade to the app.
   *
   * The app keeps its realtime channel on `/api/remote.mux`; the browser sends
   * `Origin` as the proxy, which a loopback server may reject, so the header is
   * rewritten to the app's own origin.
   */
  function tunnelUpgrade(request, socket, head) {
    const target = new URL(request.url ?? '/', upstream.origin)
    const outgoing = netConnect(Number(target.port) || 80, target.hostname, () => {
      const lines = [`${request.method ?? 'GET'} ${request.url ?? '/'} HTTP/1.1`]
      let hadCookie = false
      for (let index = 0; index < request.rawHeaders.length; index += 2) {
        const name = request.rawHeaders[index]
        const value = request.rawHeaders[index + 1]
        if (/^host$/i.test(name)) lines.push(`Host: ${target.host}`)
        else if (/^origin$/i.test(name) || /^referer$/i.test(name)) lines.push(`${name}: ${upstream.origin}/`)
        else if (/^cookie$/i.test(name)) {
          hadCookie = true
          lines.push(`Cookie: ${state.cookie || value}`)
        } else lines.push(`${name}: ${value}`)
      }
      if (!hadCookie && state.cookie) lines.push(`Cookie: ${state.cookie}`)
      outgoing.write(lines.join('\r\n') + '\r\n\r\n')
      if (head.length > 0) outgoing.write(head)
      outgoing.pipe(socket)
      socket.pipe(outgoing)
    })
    outgoing.on('error', () => socket.destroy())
    socket.on('error', () => outgoing.destroy())
  }

  const server = createServer(handler)
  server.on('upgrade', (request, socket, head) => tunnelUpgrade(request, socket, head))

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = address && typeof address === 'object' ? address.port : 0
      server.unref?.()
      const origin = 'http://127.0.0.1:' + port
      trace('app proxy listening on ' + origin + ' -> ' + upstream.origin)
      resolve({
        origin,
        dispose: () => {
          try {
            server.closeAllConnections?.()
            server.close()
          } catch (_) {
            /* already closed */
          }
        }
      })
    })
  })
}
