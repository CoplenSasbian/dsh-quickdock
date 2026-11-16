/**
 * Dock-side MCP pairing.
 *
 * The workspace MCP bridge (`host/workspace-mcp.js`) is served on DSH's own Web
 * origin, which a dock would otherwise have to discover, carry a token for and
 * reach on a second port. Instead a dock talks to this Host's loopback listener —
 * the address it already knows from its shell page — and the Host forwards the
 * call:
 *
 *   POST /quickdock/api/mcp-register    { workspace, url, name?, headers?, waitMs? }
 *   POST /quickdock/api/mcp-unregister  { workspace, name? }
 *   GET  /quickdock/api/mcp-list?workspace=<absolute directory>
 *
 * The bodies are the bridge's own (`MCP-BRIDGE.md`), so a dock that later talks
 * to DSH directly needs no second contract. Registration is in memory on both
 * sides: the dock owns its lifetime and re-registers after a DSH restart.
 *
 * @module dsh-quickdock/host/dock-mcp
 */

import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

/** Route prefix the bridge registers on the DSH Web origin. */
export const BRIDGE_ROUTE = '/workspace-mcp'

/** Budget for a bridge call that does not wait for live sessions (ms). */
const DEFAULT_TIMEOUT_MS = 10_000

/** Never let a forwarded call outlive the listener's own patience (ms). */
const MAX_TIMEOUT_MS = 90_000

/** A bridge answer is a few KB of JSON; anything bigger is not a bridge. */
const MAX_BODY_BYTES = 1024 * 1024

/**
 * The `scheme://host:port` part of a URL.
 * @param {string | null | undefined} base advertised URL or origin.
 * @returns {string|null} the origin, or null when there is nothing usable.
 */
export function bridgeOrigin(base) {
  if (typeof base !== 'string' || base.length === 0) return null
  try {
    const parsed = new URL(base)
    return parsed.origin === 'null' ? null : parsed.origin
  } catch (_) {
    return null
  }
}

/**
 * Build a JSON client for the workspace MCP bridge.
 *
 * A non-2xx answer is an error, not a value: the bridge reports every rejected
 * registration as `{ ok: false, error }`, and a dock has nothing to do with a
 * half-answer.
 * @param {object} options resolved transport details.
 * @param {string} options.origin DSH Web origin.
 * @param {string} [options.token] shared secret, when `mcpBridgeToken` is set.
 * @param {(line: string) => void} [options.trace] diagnostic sink.
 * @returns {{origin: string|null, register: Function, unregister: Function, list: Function}} the call surface.
 */
export function createBridgeClient(options) {
  const origin = bridgeOrigin(options.origin)
  const token = typeof options.token === 'string' && options.token.length > 0 ? options.token : ''
  const trace = typeof options.trace === 'function' ? options.trace : () => {}

  /**
   * Send one request and read one JSON answer.
   * @param {'GET'|'POST'} method HTTP method.
   * @param {string} action bridge action (`register`, `unregister`, `list`, …).
   * @param {object|null} body request body for POST.
   * @param {object} [query] query parameters.
   * @param {number} [timeoutMs] per-call budget.
   * @returns {Promise<object>} parsed answer.
   */
  function call(method, action, body, query, timeoutMs) {
    if (!origin) {
      throw new Error('the DSH Web UI has no origin, so the workspace MCP bridge cannot be reached')
    }
    const suffix = action ? '/' + action : ''
    const url = new URL(origin + BRIDGE_ROUTE + suffix)
    for (const [name, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(name, String(value))
    }
    const payload = body === undefined || body === null ? null : Buffer.from(JSON.stringify(body), 'utf8')
    const headers = { accept: 'application/json' }
    if (payload) {
      headers['content-type'] = 'application/json'
      headers['content-length'] = String(payload.length)
    }
    if (token) headers['x-workspace-mcp-token'] = token
    const budget = Math.min(MAX_TIMEOUT_MS, Math.max(1_000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS))
    const transport = url.protocol === 'https:' ? httpsRequest : httpRequest

    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (error, value) => {
        if (settled) return
        settled = true
        if (error) reject(error)
        else resolve(value)
      }
      // Transport failures carry no context of their own; a dock's log should say
      // which bridge call died and why the connection did.
      const fail = (error) => finish(new Error(
        'workspace-mcp ' + (action || 'health') + ' failed: ' + String((error && (error.code || error.message)) || error)
      ))
      const request = transport(url, { method, headers, timeout: budget }, (response) => {
        const chunks = []
        let size = 0
        response.on('data', (chunk) => {
          size += chunk.length
          if (size <= MAX_BODY_BYTES) chunks.push(Buffer.from(chunk))
        })
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8').trim()
          let answer = null
          try {
            answer = text.length === 0 ? null : JSON.parse(text)
          } catch (_) {
            answer = null
          }
          const status = Number(response.statusCode) || 0
          if (status < 200 || status >= 300) {
            const reason = answer && typeof answer.error === 'string' ? answer.error : 'HTTP ' + status
            finish(new Error('workspace-mcp ' + (action || 'health') + ' failed: ' + reason))
            return
          }
          finish(null, answer)
        })
        response.on('error', fail)
      })
      request.on('timeout', () => {
        request.destroy(new Error('timed out after ' + budget + ' ms'))
      })
      request.on('error', fail)
      if (payload) request.write(payload)
      request.end()
    })
  }

  return {
    origin,
    token,

    /**
     * Register or replace one MCP endpoint for one directory.
     * @param {object} body `{ workspace, url, name?, headers?, waitMs? }`.
     * @returns {Promise<object>} the bridge's answer.
     */
    register(body) {
      const source = body && typeof body === 'object' ? body : {}
      // The bridge knows url/name/headers only. What a dock says about its own
      // build and tools (see registerDockMcp) stays in the Host and is forwarded
      // stripped, so a newer dock cannot upset an older bridge.
      const forwarded = {}
      for (const key of ['workspace', 'url', 'name', 'headers', 'waitMs']) {
        if (source[key] !== undefined) forwarded[key] = source[key]
      }
      const wait = Number.isFinite(forwarded.waitMs) ? Number(forwarded.waitMs) : 0
      trace('dock-mcp: register ' + String(forwarded.name) + ' for ' + String(forwarded.workspace))
      return call('POST', 'register', forwarded, undefined, Math.max(DEFAULT_TIMEOUT_MS, wait + 15_000))
    },

    /**
     * Remove one name, or every registration of one directory.
     * @param {object} body `{ workspace, name? }`.
     * @returns {Promise<object>} the bridge's answer.
     */
    unregister(body) {
      trace('dock-mcp: unregister ' + String(body && body.name) + ' for ' + String(body && body.workspace))
      return call('POST', 'unregister', body)
    },

    /**
     * Read the registrations, optionally narrowed to one directory.
     * @param {string} [workspace] absolute directory.
     * @returns {Promise<object>} the bridge's answer.
     */
    list(workspace) {
      return call('GET', 'list', null, { workspace })
    }
  }
}
