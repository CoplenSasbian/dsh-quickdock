/**
 * Append-only trace log for the Host half.
 *
 * DSH logger output is awkward to read while the dock is running, so runtime
 * diagnostics also go to %LOCALAPPDATA%/dsh-quickdock/host.log. Trace failures
 * are always swallowed: logging must never break the feature.
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Resolve the trace file path.
 *
 * `DSH_QUICKDOCK_STATE_DIR` moves the whole profile (config.json lives next to
 * this log) and is what the tests use to stay off the real installation.
 * @param {NodeJS.ProcessEnv} env process environment.
 * @returns {string} absolute log path.
 */
export function traceLogPath(env = process.env) {
  if (env.DSH_QUICKDOCK_STATE_DIR) return join(env.DSH_QUICKDOCK_STATE_DIR, 'host.log')
  const base = env.LOCALAPPDATA || env.TEMP || '.'
  return join(base, 'dsh-quickdock', 'host.log')
}

/**
 * Create a tracer bound to one log file.
 * @param {{env?: NodeJS.ProcessEnv, path?: string}} [options] override for tests.
 * @returns {(message: unknown) => void} writer that never throws.
 */
export function createTrace(options = {}) {
  const file = options.path || traceLogPath(options.env || process.env)
  return function trace(message) {
    try {
      mkdirSync(dirname(file), { recursive: true })
      appendFileSync(file, '[' + new Date().toISOString() + '] ' + String(message) + '\n')
    } catch (_) {
      /* tracing is best effort */
    }
  }
}
