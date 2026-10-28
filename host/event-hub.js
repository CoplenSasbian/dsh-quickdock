/**
 * Server-sent-event hub (observer).
 *
 * Two independent streams share this plumbing:
 *  - state: dock page subscriptions (dock -> page)
 *  - bus:   browser commands (host -> DSH client plugin)
 * They stay separate because the state stream is chatty and the bus is rare.
 */

import { SSE_PING_MS } from './constants.js'

function frame(event, data) {
  return 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'
}

export class EventHub {
  /**
   * @param {{pingMs?: number, onStateClient?: () => void}} [deps]
   */
  constructor(deps = {}) {
    this.pingMs = deps.pingMs ?? SSE_PING_MS
    this.onStateClient = deps.onStateClient || null
    this.stateClients = new Set()
    this.busClients = new Set()
  }

  /** Connected dock pages. */
  get sseSize() {
    return this.stateClients.size
  }

  /** Connected browser clients (command bus). */
  get busSize() {
    return this.busClients.size
  }

  /** Write one event to every page. */
  broadcast(event, data) {
    const payload = frame(event, data)
    for (const res of this.stateClients) {
      try {
        res.write(payload)
      } catch (_) {
        /* a dead socket is removed by its close handler */
      }
    }
  }

  /** Push the current state snapshot. */
  publishState(snapshot) {
    this.broadcast('state', snapshot)
  }

  /** Push a theme payload. */
  publishTheme(payload) {
    this.broadcast('theme', payload)
  }

  /** Push a locale payload ({locale, messages}). */
  publishLocale(payload) {
    this.broadcast('locale', payload)
  }

  /** Send one command to the browser plugin; false when nobody listens. */
  sendCommand(command) {
    if (!this.busClients.size) return false
    const payload = frame('command', command)
    for (const res of this.busClients) {
      try {
        res.write(payload)
      } catch (_) {
        /* ignore */
      }
    }
    return true
  }

  /**
   * Attach a dock page to the state stream.
   * @param {import('node:http').IncomingMessage} req request.
   * @param {import('node:http').ServerResponse} res response.
   * @param {{state: object, theme: object|null, locale: object}} initial first payloads.
   */
  openStateStream(req, res, initial) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive'
    })
    res.write(': connected\n\n')
    this.stateClients.add(res)
    res.on('close', () => this.stateClients.delete(res))
    res.write(frame('state', initial.state))
    res.write(frame('theme', initial.theme || {}))
    res.write(frame('locale', initial.locale))
    this.onStateClient?.()
  }

  /** Attach the browser plugin to the command bus (with keep-alive pings). */
  openBusStream(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive'
    })
    res.write(': connected\n\n')
    this.busClients.add(res)
    const ping = setInterval(() => {
      try {
        res.write(': ping\n\n')
      } catch (_) {
        /* ignore */
      }
    }, this.pingMs)
    if (ping.unref) ping.unref()
    req.on('close', () => {
      clearInterval(ping)
      this.busClients.delete(res)
    })
  }

  /** Drop every subscriber (plugin dispose). */
  dispose() {
    for (const res of this.stateClients) {
      try {
        res.end()
      } catch (_) {
        /* ignore */
      }
    }
    for (const res of this.busClients) {
      try {
        res.end()
      } catch (_) {
        /* ignore */
      }
    }
    this.stateClients.clear()
    this.busClients.clear()
  }
}
