/**
 * Dock process supervisor.
 *
 * Owns the Electron child process, its loopback control channel and the restart
 * policy. Failures are reported to the page (never silently swallowed): the
 * user has to know why the button appeared to do nothing.
 */

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import http from 'node:http'
import { join } from 'node:path'

import { DOCK_BACKOFF_MS, DOCK_STDOUT_LIMIT } from './constants.js'

/**
 * Send one command to the dock's loopback control channel.
 * @returns {Promise<boolean>} whether the dock accepted it.
 */
export function controlRequest(port, token, message, timeoutMs = 3000) {
  return new Promise((resolve) => {
    if (!port) {
      resolve(false)
      return
    }
    const payload = Buffer.from(JSON.stringify(message))
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/control?t=' + encodeURIComponent(token),
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length }
    }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode === 200))
    })
    req.on('error', () => resolve(false))
    req.setTimeout(timeoutMs, () => {
      req.destroy()
      resolve(false)
    })
    req.end(payload)
  })
}

export class DockProcess {
  /**
   * @param {{state: object, config: object, statePath?: string, rootDir: string,
   *          token: string, pageUrl: () => string, resolver: object,
   *          logger: object, trace: Function, t: Function, publish: Function,
   *          spawn?: Function}} deps spawn is injectable for tests.
   */
  constructor(deps) {
    this.state = deps.state
    this.config = deps.config
    this.rootDir = deps.rootDir
    this.token = deps.token
    this.spawn = deps.spawn || spawn
    this.controlToken = randomBytes(32).toString('base64url')
    this.pageUrl = deps.pageUrl
    this.resolver = deps.resolver
    this.logger = deps.logger
    this.trace = deps.trace
    this.t = deps.t
    this.publish = deps.publish
    // Called when the dock stops being able to answer (hidden, closed, crashed).
    this.onInactive = typeof deps.onInactive === 'function' ? deps.onInactive : null

    this.child = null
    this.controlPort = 0
    // A summon that lands before the process is ready is replayed afterwards.
    this.pendingShow = false
    this.pendingAttach = ''
    this.spawning = false
    this.stopping = false
    this.restarts = 0
    this.backoff = DOCK_BACKOFF_MS
    this.timer = null
    this.buffer = ''
    /** Usable Electron candidates, best first (see ElectronResolver.usable). */
    this.candidates = null
    this.candidateIndex = 0
    /** True once the current child reported 'ready'. */
    this.ready = false
    /** Last stderr line, surfaced when a start fails before 'ready'. */
    this.lastStderr = ''
  }

  /** Running and ready (the control channel reported its port). */
  get alive() {
    return Boolean(this.child) && this.controlPort > 0 && !this.stopping
  }

  /** Being started (probing Electron / spawning / waiting for ready). */
  get starting() {
    return !this.alive && (Boolean(this.child) || this.spawning) && !this.stopping
  }

  /** Child environment: page URL, host pid, control token and window config. */
  env() {
    const env = Object.assign({}, process.env, {
      DSH_QUICKDOCK_URL: this.pageUrl(),
      DSH_QUICKDOCK_HOST_PID: String(process.pid),
      DSH_QUICKDOCK_CONTROL_TOKEN: this.controlToken,
      DSH_QUICKDOCK_CONFIG: JSON.stringify({
        width: this.config.width,
        inputHeight: this.config.inputHeight,
        displayHeight: this.config.displayHeight,
        margin: this.config.margin,
        alwaysOnTop: this.state.dock.alwaysOnTop,
        rememberGeometry: this.config.rememberGeometry,
        // On-demand mode: closing the window ends the process.
        exitOnClose: !this.config.autoLaunch
      })
    })
    // Must delete, not blank: an empty value makes Electron exit 134 (DESIGN 3.3).
    delete env.ELECTRON_RUN_AS_NODE
    delete env.ELECTRON_NO_ATTACH_CONSOLE
    return env
  }

  /** Send a command to the dock. */
  control(message, timeoutMs) {
    return controlRequest(this.controlPort, this.controlToken, message, timeoutMs)
  }

  /**
   * The dock can no longer present an interaction: clear the stale visibility and
   * let the Host hand a claimed approval back to DSH, so the user is never left
   * with no dialog to answer (the alternative is a silent 5 minute timeout).
   */
  #inactive() {
    this.state.dock.visible = false
    try {
      this.onInactive?.()
    } catch (error) {
      this.trace('onInactive failed: ' + error)
    }
  }

  /** Report a dock failure to the page and the log. */
  reportError(message) {
    const text = String(message || this.t('host.unknownError'))
    this.state.dock.error = text
    this.state.dock.running = false
    this.#inactive()
    this.logger?.error?.('quickdock: ' + text)
    this.trace('ERROR: ' + text)
    this.publish()
  }

  clearError() {
    if (!this.state.dock.error) return
    this.state.dock.error = ''
    this.publish()
  }

  /** Start the dock process (idempotent). */
  async spawnDock() {
    if (this.child || this.spawning || this.stopping) return
    this.spawning = true
    try {
      if (!this.candidates) this.candidates = await this.resolver.resolve()
      const candidate = this.candidates[this.candidateIndex]
      if (!candidate?.exe) throw new Error(this.t('host.electronMissing'))
      const argv = [...(candidate.args || []), join(this.rootDir, 'runtime', 'main.cjs')]
      const child = this.spawn(candidate.exe, argv, {
        cwd: this.rootDir,
        env: this.env(),
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      })
      this.child = child
      this.controlPort = 0
      this.ready = false
      this.lastStderr = ''
      this.state.dock.running = true
      this.trace('spawn[' + (this.candidateIndex + 1) + '/' + this.candidates.length + ']: '
        + candidate.exe + ' ' + argv.join(' '))
      this.publish()

      // Every pipe must swallow EPIPE: the host exiting is a normal event.
      for (const stream of [child.stdin, child.stdout, child.stderr]) {
        if (stream && typeof stream.on === 'function') stream.on('error', () => {})
      }
      this.#pipeStdout(child)
      this.#pipeStderr(child)

      child.on('error', (error) => {
        this.reportError(this.t('host.dockSpawnFailed', { reason: String(error?.message || error) }))
        if (this.child === child) {
          this.child = null
          this.controlPort = 0
          this.state.dock.running = false
          this.#inactive()
          this.publish()
        }
      })

      child.on('exit', (code, signal) => {
        this.trace('dock exit code=' + code + ' signal=' + signal)
        if (this.child !== child) return
        const neverReady = !this.ready
        this.child = null
        this.controlPort = 0
        this.ready = false
        this.buffer = ''
        this.state.dock.running = false
        this.#inactive()
        this.publish()
        if (this.stopping) return

        // Exiting before 'ready' is a start failure, not the user closing the
        // window: a probed binary can still be blocked from writing its profile
        // (security software). Try the next candidate before giving up.
        if (neverReady) {
          if (this.candidates && this.candidateIndex + 1 < this.candidates.length) {
            this.candidateIndex += 1
            this.trace('start failed before ready, next candidate: ' + this.candidates[this.candidateIndex].exe)
            void this.spawnDock()
            return
          }
          const reason = this.lastStderr || ('exit ' + code)
          this.reportError(this.t('host.dockStartFailed', { code, reason }))
          // Allow a later summon to retry from the best candidate again.
          this.candidates = null
          this.candidateIndex = 0
          return
        }
        // Code 0 in on-demand mode is the user closing the window.
        if (code === 0) {
          this.clearError()
          return
        }
        this.scheduleRestart(code)
      })
    } catch (error) {
      this.reportError(String(error?.message || error))
    } finally {
      this.spawning = false
    }
  }

  /** Line protocol on stdout: quickdock:{"type":"ready","controlPort":N}. */
  #pipeStdout(child) {
    if (!child.stdout) return
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      this.buffer += chunk
      if (this.buffer.length > DOCK_STDOUT_LIMIT) this.buffer = ''
      let newline
      while ((newline = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, newline).replace(/\r$/, '').trim()
        this.buffer = this.buffer.slice(newline + 1)
        if (!line) continue
        if (!line.startsWith('quickdock:')) {
          this.trace('dock stdout: ' + line.slice(0, 400))
          continue
        }
        let message
        try {
          message = JSON.parse(line.slice('quickdock:'.length))
        } catch (_) {
          continue
        }
        try {
          this.onStatus(message)
        } catch (error) {
          this.trace('status handler failed: ' + error)
        }
      }
    })
  }

  #pipeStderr(child) {
    if (!child.stderr) return
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      const text = String(chunk).trim()
      if (!text) return
      // Keep the last line: Chromium reports the real blocker there.
      this.lastStderr = text.split('\n').filter(Boolean).pop().slice(0, 500)
      this.trace('dock stderr: ' + text.slice(0, 800))
    })
  }

  /** Apply a status line reported by the dock. */
  onStatus(message) {
    const type = String(message?.type ?? '')
    if (type === 'ready') {
      this.controlPort = Number(message.controlPort) || 0
      this.ready = true
      this.lastStderr = ''
      this.restarts = 0
      this.clearError()
      this.state.dock.running = true
      this.trace('dock ready, controlPort=' + this.controlPort)
      this.publish()
      this.flushPending()
      return
    }
    if (type === 'error') this.reportError('dock: ' + String(message.message || this.t('host.unknownError')))
    // Approvals need a visible window: a hidden dock must delegate back to DSH.
    if (type === 'shown') {
      this.state.dock.visible = true
      return
    }
    if (type === 'hidden' || type === 'closed') {
      this.#inactive()
      this.publish()
    }
  }

  /** Replay the actions queued before the process was ready. */
  flushPending() {
    if (!this.alive) return
    if (this.pendingAttach) {
      const sessionId = this.pendingAttach
      this.pendingAttach = ''
      void this.control({ type: 'attach', sessionId })
    }
    if (this.pendingShow) {
      this.pendingShow = false
      void this.control({ type: 'show' })
    }
  }

  /** Raise the dock, starting it when necessary. */
  summon() {
    this.stopping = false
    if (!this.child) {
      // A fresh summon re-evaluates Electron candidates from the best one.
      this.candidates = null
      this.candidateIndex = 0
      this.pendingShow = true
      void this.spawnDock()
      return
    }
    if (!this.alive) {
      this.pendingShow = true
      return
    }
    void this.control({ type: 'show' }).then((ok) => {
      if (!ok) this.trace('summon: control show failed')
    })
  }

  /** Push a session to the dock (queued until ready). */
  notifyAttach(sessionId) {
    const id = String(sessionId || '')
    if (!id) return
    if (this.alive) {
      void this.control({ type: 'attach', sessionId: id })
      return
    }
    this.pendingAttach = id
  }

  /** Forward window-level settings (always-on-top). */
  applyWindow(patch) {
    if (!this.alive) return
    void this.control({ type: 'window', alwaysOnTop: Boolean(patch?.alwaysOnTop) })
  }

  /** Stop the dock (plugin dispose / host shutdown). */
  stop() {
    this.stopping = true
    this.candidates = null
    this.candidateIndex = 0
    this.ready = false
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const child = this.child
    const port = this.controlPort
    this.child = null
    this.controlPort = 0
    this.buffer = ''
    this.state.dock.running = false
    this.#inactive()
    if (!child) return
    if (port) void controlRequest(port, this.controlToken, { type: 'quit' }, 800)
    const killer = setTimeout(() => {
      try {
        if (child.exitCode === null && !child.killed) child.kill()
      } catch (_) {
        /* already gone */
      }
    }, 1000)
    if (killer.unref) killer.unref()
  }

  /** Restart with backoff; after the last attempt the reason stays on screen. */
  scheduleRestart(code) {
    if (this.timer || this.stopping) return
    const max = this.backoff.length
    if (this.restarts >= max) {
      this.reportError(this.t('host.dockCrashLoop', { code, log: this.tracePath || 'host.log' }))
      return
    }
    const delay = this.backoff[this.restarts]
    this.restarts += 1
    this.reportError(this.t('host.dockExited', {
      code,
      delay: Math.round(delay / 1000),
      attempt: this.restarts,
      max
    }))
    this.timer = setTimeout(() => {
      this.timer = null
      void this.spawnDock()
    }, delay)
    if (this.timer.unref) this.timer.unref()
  }
}
