/**
 * The VS Code -> QuickDock MCP descriptor (`mcp.json`).
 *
 * The editor extension is the MCP **server** and owns the file; QuickDock is the
 * **client** and only reads it. Everything here is pure: the clock and the pid
 * probe are arguments, so the rules of MCP-PAIRING.md can be unit-tested without
 * a live editor, a socket or a process table.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** `kind` keeps unrelated files out of the state directory. */
export const DESCRIPTOR_KIND = 'dsh-vscode-mcp'
/** Shape version: a newer one is ignored rather than half-applied. */
export const DESCRIPTOR_API_VERSION = 1
/** A heartbeat older than this means the writer stopped (90 s allows clock skew). */
export const HEARTBEAT_MAX_AGE_MS = 90_000
/** The token is a capability, not a document: keep it short enough to reason about. */
export const TOKEN_MAX_LENGTH = 200

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/**
 * Path of the descriptor: next to the host log, i.e. in the QuickDock state
 * directory that `DSH_QUICKDOCK_STATE_DIR` moves.
 * @param {string} logPath host log path.
 * @returns {string} path to `mcp.json`.
 */
export function descriptorPath(logPath) {
  return join(dirname(logPath), 'mcp.json')
}

/**
 * Parse a loopback `http://` URL with an explicit port.
 *
 * `https` is rejected on purpose: the descriptor is a local capability, and a
 * loopback server has no certificate story worth pretending about. Credentials
 * in the URL are rejected because the token belongs in the descriptor and the
 * patch row, never in a URL that could end up in a log.
 * @param {unknown} value candidate URL.
 * @returns {URL|null} parsed URL, or null when it is not a usable loopback endpoint.
 */
export function loopbackHttpUrl(value) {
  let url
  try {
    url = new URL(String(value))
  } catch (_) {
    return null
  }
  if (url.protocol !== 'http:') return null
  if (!LOOPBACK_HOSTS.has(url.hostname)) return null
  // `URL` hides the default port; a descriptor always names one.
  if (!url.port) return null
  const port = Number(url.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  if (url.username || url.password) return null
  return url
}

/**
 * Is a pid alive? `EPERM` means "there, but not ours", which still counts.
 * @param {unknown} pid process id from the descriptor.
 * @returns {boolean} liveness.
 */
export function isProcessAlive(pid) {
  const id = Number(pid)
  if (!Number.isInteger(id) || id <= 0) return false
  try {
    process.kill(id, 0)
    return true
  } catch (error) {
    return Boolean(error && error.code === 'EPERM')
  }
}

/**
 * Structural validation: everything that can be judged without probing.
 * @param {unknown} raw parsed descriptor.
 * @returns {{ok: boolean, reason: string, code: string, value?: object}} verdict.
 */
export function normalize(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, code: 'shape', reason: 'the descriptor is not an object' }
  }
  if (raw.kind !== DESCRIPTOR_KIND) {
    return { ok: false, code: 'kind', reason: 'kind is not "' + DESCRIPTOR_KIND + '"' }
  }
  if (raw.apiVersion !== DESCRIPTOR_API_VERSION) {
    return { ok: false, code: 'apiVersion', reason: 'unsupported apiVersion ' + JSON.stringify(raw.apiVersion) }
  }
  const url = loopbackHttpUrl(raw.url)
  if (!url) {
    return { ok: false, code: 'url', reason: 'url is not a loopback http URL with a port' }
  }
  const healthUrl = raw.healthUrl === undefined ? new URL('/health', url.origin) : loopbackHttpUrl(raw.healthUrl)
  if (!healthUrl) {
    return { ok: false, code: 'healthUrl', reason: 'healthUrl is not a loopback http URL' }
  }
  const token = raw.token
  if (typeof token !== 'string' || token.length === 0 || token.length > TOKEN_MAX_LENGTH) {
    return { ok: false, code: 'token', reason: 'token is missing, empty or too long' }
  }
  // The token is embedded in a YAML scalar: whitespace and control characters
  // cannot appear in the base64url token the contract asks for.
  if (!/^[\x21-\x7e]+$/.test(token)) {
    return { ok: false, code: 'token', reason: 'token is not a printable single-line value' }
  }
  const pid = raw.pid
  if (!Number.isInteger(pid) || pid <= 0) {
    return { ok: false, code: 'pid', reason: 'pid is not a positive integer' }
  }
  const heartbeat = Date.parse(String(raw.heartbeatAt === undefined ? '' : raw.heartbeatAt))
  if (!Number.isFinite(heartbeat)) {
    return { ok: false, code: 'heartbeat', reason: 'heartbeatAt is not a timestamp' }
  }
  return {
    ok: true,
    code: 'ok',
    reason: '',
    value: {
      url: url.href,
      healthUrl: healthUrl.href,
      token,
      pid,
      heartbeat,
      // Everything the patch row does not need is kept for diagnostics only.
      extensionId: typeof raw.extension === 'object' && raw.extension ? String(raw.extension.id || '') : '',
      editorName: typeof raw.editor === 'object' && raw.editor ? String(raw.editor.name || '') : ''
    }
  }
}

/**
 * Full liveness verdict, including the two runtime facts: the writer is alive and
 * the heartbeat is fresh.
 * @param {unknown} raw parsed descriptor.
 * @param {{now?: number, isAlive?: (pid: number) => boolean}} [options] probe overrides.
 * @returns {{state: 'live'|'stale'|'invalid', code: string, reason: string, value?: object}} verdict.
 */
export function evaluate(raw, options = {}) {
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now()
  const isAlive = typeof options.isAlive === 'function' ? options.isAlive : isProcessAlive
  const shape = normalize(raw)
  if (!shape.ok) return { state: 'invalid', code: shape.code, reason: shape.reason }
  const value = shape.value
  if (!isAlive(value.pid)) {
    return { state: 'stale', code: 'pid-dead', reason: 'pid ' + value.pid + ' is not running', value }
  }
  const age = now - value.heartbeat
  if (age > HEARTBEAT_MAX_AGE_MS) {
    return { state: 'stale', code: 'heartbeat-stale', reason: 'heartbeat is ' + Math.round(age / 1000) + 's old', value }
  }
  if (age < -HEARTBEAT_MAX_AGE_MS) {
    return { state: 'stale', code: 'heartbeat-future', reason: 'heartbeat is in the future', value }
  }
  return { state: 'live', code: 'live', reason: '', value }
}

/**
 * Read and judge the descriptor.
 *
 * A missing file is a normal state (the editor is closed), not an error: the
 * caller disables its rows without logging a failure.
 * @param {string} file path from {@link descriptorPath}.
 * @param {{now?: number, isAlive?: (pid: number) => boolean}} [options] probe overrides.
 * @returns {{state: 'absent'|'invalid'|'stale'|'live', code: string, reason: string, value?: object}} verdict.
 */
export function readDescriptor(file, options = {}) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return { state: 'absent', code: 'missing', reason: 'no descriptor' }
    return {
      state: 'invalid',
      code: 'unreadable',
      reason: 'cannot read the descriptor (' + String((error && error.code) || 'error') + ')'
    }
  }
  let raw
  try {
    raw = JSON.parse(text)
  } catch (_) {
    return { state: 'invalid', code: 'json', reason: 'the descriptor is not valid JSON' }
  }
  return evaluate(raw, options)
}
