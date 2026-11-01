/**
 * Which build is actually running.
 *
 * Every "I fixed it and nothing changed" in this project came down to a stale
 * process: the host caches page assets, the dock is its own process and the
 * plugin stays loaded for days. A version string makes that a fact instead of a
 * guess - it is logged at start-up, published in the state and shown by the
 * pages.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Short git hash of the checkout, or '' when git is unavailable. */
function gitHash(rootDir) {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: rootDir,
      encoding: 'utf8',
      timeout: 2000,
      windowsHide: true
    }).trim()
  } catch (_) {
    return ''
  }
}

/**
 * Describe this build.
 * @param {string} rootDir plugin root.
 * @returns {{hash: string, startedAt: string, pkg: string}} version info.
 */
export function readVersion(rootDir) {
  let pkg = ''
  try {
    pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8')).version || ''
  } catch (_) {
    pkg = ''
  }
  return {
    hash: gitHash(rootDir),
    // Load time stands in for the build: the host half is re-imported on reload.
    startedAt: new Date().toISOString(),
    pkg
  }
}
