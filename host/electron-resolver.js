/**
 * Electron binary resolution (three-level fallback).
 *
 *  1. DSH_QUICKDOCK_ELECTRON_PATH (explicit override)
 *  2. the electron package installed next to this plugin
 *  3. a self-managed download under %LOCALAPPDATA%/dsh-quickdock/electron
 *
 * Presence is not enough: security software can block a specific path, so every
 * candidate is probed and the successful launch arguments are remembered.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const DEFAULT_ELECTRON_VERSION = '44.7.0'

/** File name of the Electron executable for a platform. */
export function exeNameFor(platform) {
  const target = platform || process.platform
  if (target === 'darwin') return 'Electron.app/Contents/MacOS/Electron'
  if (target === 'win32') return 'electron.exe'
  return 'electron'
}

export class ElectronResolver {
  /**
   * @param {{env?: NodeJS.ProcessEnv, platform?: string, homeDir?: string,
   *          logger?: object, trace: Function, t: Function,
   *          requireResolve?: (specifier: string) => string}} deps
   */
  constructor(deps) {
    this.env = deps.env || process.env
    this.platform = deps.platform || process.platform
    this.homeDir = deps.homeDir || ''
    this.logger = deps.logger
    this.trace = deps.trace
    this.t = deps.t
    this.requireResolve = deps.requireResolve || null
    this.version = this.env.DSH_QUICKDOCK_ELECTRON_VERSION || DEFAULT_ELECTRON_VERSION
    this.downloading = null
  }

  /** Preferred download root (see DESIGN 3.1: avoid protected folders). */
  downloadRoot() {
    const local = this.env.LOCALAPPDATA
      || (this.platform === 'win32' ? join(this.env.USERPROFILE || '', 'AppData', 'Local') : '')
    return join(String(local), 'dsh-quickdock', 'electron')
  }

  /**
   * Candidate paths in priority order.
   *
   * The self-managed copy comes before the npm package on purpose: security
   * software on some Windows machines (e.g. Huorong) restricts Electron
   * binaries stored under user folders such as Desktop or ~/.dsh. The process
   * starts, then fails to write its profile (singleton lock / caches) and exits
   * 0 before loading the app. %LOCALAPPDATA% is the path verified to work.
   */
  candidates() {
    const list = []
    if (this.env.DSH_QUICKDOCK_ELECTRON_PATH) list.push(this.env.DSH_QUICKDOCK_ELECTRON_PATH)
    list.push(join(this.downloadRoot(), this.version))
    try {
      const pkg = this.requireResolve?.('electron/package.json')
      if (pkg) list.push(join(dirname(pkg), 'dist', exeNameFor(this.platform)))
    } catch (_) {
      /* the electron package is optional */
    }
    if (this.homeDir) list.push(join(String(this.homeDir), 'electron'))
    return list.filter(Boolean)
  }

  /** Resolve a candidate path (file, directory or nested platform folder). */
  resolvePath(candidate) {
    try {
      if (!candidate) return null
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
      if (existsSync(candidate) && statSync(candidate).isDirectory()) {
        const direct = join(candidate, exeNameFor(this.platform))
        if (existsSync(direct)) return direct
      }
      const nested = join(candidate, exeNameFor(this.platform))
      if (existsSync(nested)) return nested
    } catch (_) {
      /* unreadable path: not a candidate */
    }
    return null
  }

  /** Concrete executables, de-duplicated, in priority order. */
  executables() {
    const found = []
    for (const candidate of this.candidates()) {
      const exe = this.resolvePath(candidate)
      if (exe && !found.includes(exe)) found.push(exe)
    }
    return found
  }

  /**
   * Probe one executable.
   *
   * Both `--no-sandbox` and the plain launch are tried: on machines with
   * security software the sandboxed probe crashes before JS runs (exit
   * 0x80000003), while `--no-sandbox` succeeds. The winning arguments are
   * reused by the real spawn, because a probe that passes with different flags
   * still proves nothing.
   *
   * @returns {string[]|null} extra launch arguments, or null when unusable.
   */
  probe(exe) {
    const env = Object.assign({}, this.env)
    delete env.ELECTRON_RUN_AS_NODE
    delete env.ELECTRON_NO_ATTACH_CONSOLE
    const attempts = [['--no-sandbox', '--version'], ['--version']]
    for (const args of attempts) {
      try {
        const result = spawnSync(exe, args, { env, windowsHide: true, timeout: 15000, encoding: 'utf8' })
        if (result.error || result.status !== 0) continue
        if (!/^v?\d+\.\d+\.\d+/.test(String(result.stdout || '').trim())) continue
        return args.slice(0, -1)
      } catch (_) {
        /* try the next launch form */
      }
    }
    return null
  }

  /**
   * Every candidate that actually starts, in priority order.
   *
   * A passing probe is necessary but not sufficient: a binary can start and
   * still be unable to write its profile. The supervisor therefore keeps the
   * whole list and moves to the next entry when a start fails before 'ready'.
   */
  usable() {
    const executables = this.executables()
    this.trace('candidates: ' + (executables.length ? executables.join(' | ') : '(none)'))
    const usable = []
    const rejected = []
    for (const exe of executables) {
      const args = this.probe(exe)
      this.trace('  probe ' + (args ? 'OK  ' : 'FAIL') + ' ' + exe + (args?.length ? ' args=' + args.join(' ') : ''))
      if (args) usable.push({ exe, args })
      else rejected.push(exe)
    }
    if (rejected.length) {
      this.logger?.warn?.(
        'quickdock: skipped %d unusable Electron candidate(s) (%s); they may be blocked by security software',
        rejected.length, rejected.join(', ')
      )
    }
    return usable
  }

  /** Download Electron once (in-process: a spawned helper would inherit the host exe). */
  async download() {
    if (this.downloading) return this.downloading
    this.downloading = (async () => {
      const { download } = await import('@electron/get')
      // extract-zip only exports extract (plus a default), not extractZip.
      const mod = await import('@electron-internal/extract-zip')
      const extract = mod.extract ?? mod.default
      if (typeof extract !== 'function') throw new Error('extract-zip: no extract() export available')
      const target = join(this.downloadRoot(), this.version)
      const mirror = this.env.ELECTRON_MIRROR ?? 'https://npmmirror.com/mirrors/electron/'
      const zip = await download(this.version, { mirrorOptions: { mirror } })
      await extract(zip, { dir: target })
      this.logger?.info?.('quickdock: Electron %s downloaded to %s', this.version, target)
      return join(target, exeNameFor(this.platform))
    })().finally(() => {
      this.downloading = null
    })
    return this.downloading
  }

  /**
   * Resolve runnable Electron candidates, downloading one when none exists.
   * @returns {Promise<{exe: string, args: string[]}[]>} candidates in priority order.
   * @throws {Error} localized error with `electronUnavailable` set.
   */
  async resolve() {
    const found = this.usable()
    if (found.length) return found
    try {
      const downloaded = await this.download()
      if (!downloaded) return []
      // A successful download does not prove the binary starts on this machine.
      const args = this.probe(downloaded)
      if (args) return [{ exe: downloaded, args }]
      throw new Error(this.t('host.electronBlocked', { path: downloaded }))
    } catch (error) {
      const reason = String(error?.message || error)
      this.logger?.error?.('quickdock: Electron unavailable: ' + reason)
      this.trace('electron unavailable: ' + reason)
      // A missing dependency message is not actionable on its own.
      const hint = /Cannot find package|ERR_MODULE_NOT_FOUND/i.test(reason)
        ? this.t('host.electronInstallHint')
        : ''
      const wrapped = new Error(this.t('host.electronUnavailable', { reason, hint }))
      wrapped.electronUnavailable = true
      throw wrapped
    }
  }

  /** Read a version file from a dist folder (used by ensure-electron). */
  static readVersion(distDir) {
    try {
      const raw = JSON.parse(readFileSync(join(distDir, 'package.json'), 'utf8'))
      return String(raw.version || '')
    } catch (_) {
      return ''
    }
  }
}
