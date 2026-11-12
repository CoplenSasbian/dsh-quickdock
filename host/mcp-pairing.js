/**
 * MCP pairing: keep DSH's MCP client row in step with the editor's descriptor.
 *
 * The VS Code extension owns `mcp.json`; this controller polls it every 2 s and
 * applies one of three desired states to the profile patch:
 *
 *   live descriptor        -> insert row present, `disabled: false`
 *   present but not live   -> insert row present, `disabled: true`
 *   absent or invalid      -> disable when the insert row exists, otherwise nothing
 *
 * The rules, the consent story and the security model are specified in
 * MCP-PAIRING.md; this file is the QuickDock implementation of them. Writes go
 * through `mcp-patch.js`, which splices instead of re-serialising and refuses to
 * commit a document it cannot still read as a top-level array.
 */

import { existsSync, unlinkSync } from 'node:fs'
import { get } from 'node:http'
import { join } from 'node:path'

import { isProcessAlive, readDescriptor } from './mcp-descriptor.js'
import {
  PATCH_ID,
  SERVER_NAME,
  readPatch,
  scanPatch,
  withInsert,
  withToggle,
  writePatch
} from './mcp-patch.js'

/** How often the descriptor is polled. */
export const DEFAULT_POLL_MS = 2000
/** Health probe budget: loopback answers instantly or not at all. */
export const HEALTH_TIMEOUT_MS = 2000
/** A probe that keeps failing this long means "not live" (one failure does not). */
export const HEALTH_GRACE_MS = 10_000
/** How long the loader gets to compose the row before the write is called failed. */
export const VERIFY_DELAY_MS = 2500

/**
 * Resolve the patch file of the DSH profile this process belongs to.
 *
 * `DSH_QUICKDOCK_PATCH_FILE` is the explicit override (tests, unusual installs),
 * `DSH_PROFILE_DIR` is what a profile-launched Harness exports, and the
 * `$DSH_HOME/profiles/<profile>` layout is the fallback.
 * @param {{env?: NodeJS.ProcessEnv, homeDir?: string, profile?: string}} [options] overrides.
 * @returns {string} absolute patch path, or '' when the profile is unknown.
 */
export function profilePatchPath(options = {}) {
  const env = options.env || process.env
  if (env.DSH_QUICKDOCK_PATCH_FILE) return env.DSH_QUICKDOCK_PATCH_FILE
  const candidates = []
  if (env.DSH_PROFILE_DIR) candidates.push(join(env.DSH_PROFILE_DIR, 'cordis.patch.yml'))
  const home = env.DSH_HOME || options.homeDir || ''
  const profile = env.DSH_PROFILE || options.profile || ''
  if (home && profile) candidates.push(join(home, 'profiles', profile, 'cordis.patch.yml'))
  if (options.homeDir) candidates.push(join(options.homeDir, 'cordis.patch.yml'))
  // Never guess: a path that does not exist would make every write fail.
  return candidates.find((file) => existsSync(file)) || ''
}

/**
 * Ask the MCP server's health endpoint whether it is up.
 *
 * One request, no redirects (a redirect is a failure: the descriptor promised
 * loopback), bearer token only in the header. Never rejects.
 * @param {{healthUrl: string, token: string}} descriptor live endpoint.
 * @param {{timeoutMs?: number}} [options] timeout override.
 * @returns {Promise<boolean>} whether the endpoint answered 200.
 */
export function probeHealth(descriptor, options = {}) {
  return new Promise((resolve) => {
    const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : HEALTH_TIMEOUT_MS
    let settled = false
    const finish = (ok) => {
      if (settled) return
      settled = true
      resolve(ok)
    }
    let request
    try {
      request = get(new URL(descriptor.healthUrl), {
        headers: { authorization: 'Bearer ' + descriptor.token, accept: 'application/json' },
        timeout: timeoutMs
      }, (response) => {
        response.resume()
        response.on('end', () => finish(response.statusCode === 200))
        response.on('error', () => finish(false))
      })
    } catch (_) {
      finish(false)
      return
    }
    request.on('timeout', () => {
      request.destroy()
      finish(false)
    })
    request.on('error', () => finish(false))
  })
}

export class McpPairing {
  /**
   * @param {object} options
   * @param {string} options.descriptorFile absolute `mcp.json` path.
   * @param {string} options.patchFile absolute profile patch path.
   * @param {(message: string) => void} [options.trace] host trace sink.
   * @param {object} [options.logger] DSH logger.
   * @param {object} [options.configEditor] loader surface, used to verify a write.
   * @param {() => number} [options.now] clock override for tests.
   * @param {(descriptor: object) => Promise<boolean>} [options.probe] health probe override.
   * @param {(pid: number) => boolean} [options.isAlive] pid probe override.
   * @param {number} [options.pollMs] poll interval override.
   * @param {number} [options.healthGraceMs] health grace override.
   * @param {number} [options.verifyDelayMs] compose verification delay override.
   */
  constructor(options = {}) {
    this.descriptorFile = options.descriptorFile || ''
    this.patchFile = options.patchFile || ''
    this.trace = typeof options.trace === 'function' ? options.trace : () => {}
    this.logger = options.logger
    this.configEditor = options.configEditor
    this.now = typeof options.now === 'function' ? options.now : () => Date.now()
    this.probe = typeof options.probe === 'function' ? options.probe : probeHealth
    this.isAlive = typeof options.isAlive === 'function' ? options.isAlive : isProcessAlive
    this.pollMs = Number(options.pollMs) > 0 ? Number(options.pollMs) : DEFAULT_POLL_MS
    this.healthGraceMs = Number(options.healthGraceMs) >= 0 ? Number(options.healthGraceMs) : HEALTH_GRACE_MS
    this.verifyDelayMs = Number(options.verifyDelayMs) >= 0 ? Number(options.verifyDelayMs) : VERIFY_DELAY_MS

    this.timer = null
    this.verifyTimer = null
    this.running = false
    this.ticking = false
    /** Start of the current uninterrupted health failure, 0 when healthy. */
    this.healthFailSince = 0
    /** Endpoint the failing window belongs to: a new endpoint starts clean. */
    this.activeSignature = ''
    /** Last descriptor verdict, shown by `status()`. */
    this.verdict = { state: 'absent', code: 'missing', reason: 'not polled yet' }
    /** Last health probe verdict: 'unknown' | 'ok' | 'pending' | 'failed'. */
    this.health = 'unknown'
    /** What the rows say right now (null: never written, or unknown). */
    this.enabled = null
    this.lastWriteAt = 0
    this.lastError = ''
    this.lastLogged = ''
    this.lastTransition = ''
    /** Endpoint signature the loader rejected; not re-enabled until it changes. */
    this.failedSignature = ''
    /** Endpoint signature whose compose was confirmed. */
    this.verifiedSignature = ''
    /** Pid whose stale descriptor was already deleted. */
    this.deletedPid = 0
  }

  /** Begin polling. Idempotent; a missing path disables the controller. */
  start() {
    if (this.running) return this
    if (!this.descriptorFile || !this.patchFile) {
      this.trace('mcp pairing: no descriptor or patch path; not watching')
      return this
    }
    this.running = true
    void this.tick()
    this.timer = setInterval(() => { void this.tick() }, this.pollMs)
    this.timer.unref?.()
    return this
  }

  /** Stop polling. The rows are left exactly as they are. */
  stop() {
    this.running = false
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this.verifyTimer) {
      clearTimeout(this.verifyTimer)
      this.verifyTimer = null
    }
    return this
  }

  /** One evaluation, exposed for tests and for an explicit refresh. */
  async tick() {
    if (this.ticking) return
    this.ticking = true
    try {
      await this.#run()
    } catch (error) {
      this.#fail('poll failed: ' + String((error && error.message) || error))
    } finally {
      this.ticking = false
    }
  }

  /** What the settings page or a diagnostic endpoint can show. */
  status() {
    return {
      enabled: this.enabled === true,
      known: this.enabled !== null,
      state: this.verdict.state,
      code: this.verdict.code,
      reason: this.verdict.reason,
      health: this.health,
      serverName: SERVER_NAME,
      patchId: PATCH_ID,
      descriptorFile: this.descriptorFile,
      patchFile: this.patchFile,
      lastWriteAt: this.lastWriteAt,
      error: this.lastError
    }
  }

  /* ------------------------------ the state machine ------------------------------ */

  async #run() {
    const verdict = readDescriptor(this.descriptorFile, { now: this.now(), isAlive: this.isAlive })
    this.verdict = verdict
    this.health = 'unknown'
    this.#transition(verdict.state + '/' + verdict.code)
    if (verdict.state === 'absent') return this.#applyNotLive('the descriptor is gone')
    if (verdict.state === 'invalid') {
      this.#log('mcp pairing: descriptor rejected: ' + verdict.reason)
      return this.#applyNotLive(verdict.reason)
    }
    if (verdict.state === 'stale') {
      this.#log('mcp pairing: descriptor is not live: ' + verdict.reason)
      if (verdict.code === 'pid-dead') this.#deleteStale(verdict)
      return this.#applyNotLive(verdict.reason)
    }
    // A different endpoint starts its own health window.
    const signature = this.#signature(verdict.value)
    if (signature !== this.activeSignature) {
      this.activeSignature = signature
      this.healthFailSince = 0
    }
    const health = await this.#health(verdict.value)
    // During the grace window the current rows stay as they are: a single failed
    // probe must not toggle the row, and a server starting up gets its ~10 s.
    if (health === 'pending') return
    if (health === 'failed') {
      this.#log('mcp pairing: the health check keeps failing; disabling the row')
      return this.#applyNotLive('health check failed')
    }
    return this.#applyLive(verdict.value)
  }

  /**
   * Classify the health probe, remembering when the failures started.
   * @param {{healthUrl: string, token: string}} descriptor live endpoint.
   * @returns {Promise<'ok'|'pending'|'failed'>} verdict for this tick.
   */
  async #health(descriptor) {
    let ok = false
    try {
      ok = Boolean(await this.probe(descriptor))
    } catch (_) {
      ok = false
    }
    if (ok) {
      this.healthFailSince = 0
      this.health = 'ok'
      return 'ok'
    }
    if (!this.healthFailSince) this.healthFailSince = this.now()
    if (this.now() - this.healthFailSince < this.healthGraceMs) {
      this.health = 'pending'
      return 'pending'
    }
    this.health = 'failed'
    return 'failed'
  }

  /**
   * The descriptor is usable: make sure the row exists, points at this endpoint
   * and is enabled.
   * @param {object} value validated descriptor.
   */
  #applyLive(value) {
    if (!this.patchFile) return
    const signature = this.#signature(value)
    if (this.failedSignature && this.failedSignature === signature) {
      // The loader already rejected this exact row: stay disabled until it changes.
      this.#toggle(true, 'disabled (the loader rejected this row)')
      return
    }
    const current = readPatch(this.patchFile)
    if (!current.ok) {
      this.#fail('cannot read ' + this.patchFile + ' (' + current.error + ')')
      return
    }
    if (scanPatch(current.text).sharedInsert) {
      this.#fail('the insert block also holds other rows; leaving ' + this.patchFile + ' alone')
      return
    }
    let next = withInsert(current.text, { url: value.url, token: value.token })
    next = withToggle(next, false)
    if (next === current.text) {
      this.enabled = true
      if (!this.failedSignature) this.lastError = ''
      this.#verify(value)
      return
    }
    if (!this.#commit(next, 'enabled ' + SERVER_NAME + ' at ' + value.url)) return
    this.enabled = true
    if (!this.failedSignature) this.lastError = ''
    this.#verify(value)
  }

  /** The descriptor is not live: disable the row when it exists, never create one. */
  #applyNotLive(reason) {
    if (!this.patchFile) return
    const current = readPatch(this.patchFile)
    // A missing or unreadable patch is not ours to repair: log once and stop.
    if (!current.ok) {
      if (!current.missing) this.#fail('cannot read ' + this.patchFile + ' (' + current.error + ')')
      return
    }
    if (!scanPatch(current.text).insert) return
    this.#toggle(true, 'disabled (' + reason + ')')
  }

  /** Write `disabled` on the toggle row, creating it when the insert row exists. */
  #toggle(disabled, why) {
    if (!this.patchFile) return
    const current = readPatch(this.patchFile)
    if (!current.ok) return
    if (!scanPatch(current.text).insert) return
    const next = withToggle(current.text, disabled)
    if (next === current.text) {
      this.enabled = !disabled
      return
    }
    if (this.#commit(next, why)) this.enabled = !disabled
  }

  /**
   * Commit one spliced document.
   * @param {string} next complete new document.
   * @param {string} why short trace reason.
   * @returns {boolean} whether the file now holds the document.
   */
  #commit(next, why) {
    const result = writePatch(this.patchFile, next)
    if (!result.ok) {
      this.#fail('write failed: ' + result.error)
      return false
    }
    this.lastWriteAt = this.now()
    this.trace('mcp pairing: ' + why)
    return true
  }

  /**
   * Ask the loader whether it composed the row, once per endpoint.
   *
   * A missing entry is the only evidence available that the row shape was
   * rejected (the client's own schema owns that shape, see MCP-PAIRING.md), so a
   * failure disables the row instead of retrying in a loop.
   * @param {object} value validated descriptor.
   */
  #verify(value) {
    if (!this.configEditor || typeof this.configEditor.entries !== 'function') return
    const signature = this.#signature(value)
    if (this.verifiedSignature === signature) return
    if (this.verifyTimer) return
    this.verifyTimer = setTimeout(() => {
      this.verifyTimer = null
      let composed = false
      try {
        const entries = this.configEditor.entries() || []
        composed = entries.some((entry) => JSON.stringify(entry).includes(PATCH_ID))
      } catch (_) {
        // An inspection failure is not evidence of rejection.
        return
      }
      if (composed) {
        this.verifiedSignature = signature
        this.failedSignature = ''
        return
      }
      this.failedSignature = signature
      this.#fail('the loader did not compose ' + PATCH_ID + '; disabling it')
      this.#toggle(true, 'disabled (the loader did not compose the row)')
    }, this.verifyDelayMs)
    this.verifyTimer.unref?.()
  }

  /** The descriptor's identity: re-enable only after the endpoint itself changes. */
  #signature(value) {
    return value.url + '\n' + value.token
  }

  /**
   * Remove a descriptor whose writer is gone (VS Code killed, not closed).
   * Best effort: the extension owns the file, and a live one is never touched.
   * @param {{value?: object}} verdict stale verdict.
   */
  #deleteStale(verdict) {
    const pid = verdict.value ? Number(verdict.value.pid) : 0
    if (!pid || this.deletedPid === pid) return
    this.deletedPid = pid
    try {
      unlinkSync(this.descriptorFile)
      this.trace('mcp pairing: removed the stale descriptor (pid ' + pid + ' is gone)')
    } catch (_) {
      /* another writer may have replaced it: never fatal */
    }
  }

  /* --------------------------------- diagnostics --------------------------------- */

  #transition(label) {
    if (label === this.lastTransition) return
    this.lastTransition = label
    this.trace('mcp pairing: descriptor ' + label)
  }

  #log(message) {
    if (message === this.lastLogged) return
    this.lastLogged = message
    this.trace(message)
    this.logger?.warn?.('quickdock: %s', message)
  }

  #fail(message) {
    this.lastError = message
    this.#log('mcp pairing: ' + message)
  }
}
