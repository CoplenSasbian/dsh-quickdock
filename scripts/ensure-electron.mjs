/**
 * Download Electron ahead of the first dock start.
 *
 * Usage: node scripts/ensure-electron.mjs [--version 44.7.0] [--force]
 *
 * Also callable from the Host. A failure only affects desktop mode: the web
 * form keeps working, and DSH_QUICKDOCK_ELECTRON_PATH can point at an existing
 * binary instead.
 */
import { existsSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_ELECTRON_VERSION, exeNameFor } from '../host/electron-resolver.js'

const VERSION = process.argv.includes('--version')
  ? process.argv[process.argv.indexOf('--version') + 1]
  : (process.env.DSH_QUICKDOCK_ELECTRON_VERSION ?? DEFAULT_ELECTRON_VERSION)
const FORCE = process.argv.includes('--force')

/** Target directory for the self-managed download (see host/electron-resolver.js). */
function targetRoot() {
  // An explicit override means the user manages the binary themselves.
  if (process.env.DSH_QUICKDOCK_ELECTRON_PATH) return null
  // %LOCALAPPDATA%/dsh-quickdock/electron/<version>: user configuration folders
  // are protected by injection guards on some machines, where Chromium aborts
  // with STATUS_BREAKPOINT before running any JS.
  const localAppData = process.env.LOCALAPPDATA
    || (platform() === 'win32' ? join(homedir(), 'AppData', 'Local') : join(homedir(), '.local', 'share'))
  return join(String(localAppData), 'dsh-quickdock', 'electron', VERSION)
}

async function main() {
  const root = targetRoot()
  if (!root) {
    console.log('DSH_QUICKDOCK_ELECTRON_PATH is set; skipping download.')
    return
  }
  const exe = join(root, exeNameFor(platform()))
  if (!FORCE && existsSync(exe)) {
    console.log('Electron already present: ' + exe)
    return
  }
  const { download } = await import('@electron/get')
  const { extract } = await import('@electron-internal/extract-zip')
  // Same order as the Host: explicit override, the China mirror, then GitHub.
  const mirrors = []
  if (process.env.ELECTRON_MIRROR) mirrors.push(process.env.ELECTRON_MIRROR)
  for (const mirror of ['https://npmmirror.com/mirrors/electron/', null]) {
    if (!mirrors.includes(mirror)) mirrors.push(mirror)
  }
  let lastError = null
  for (const mirror of mirrors) {
    try {
      console.log('Downloading Electron ' + VERSION + ' (~100MB from ' + (mirror ?? 'GitHub') + ')…')
      let received = 0
      let total = 0
      const zipPath = await download(VERSION, {
        ...(mirror ? { mirrorOptions: { mirror } } : {}),
        progressCallback: (progress) => {
          received = progress.received ?? received
          total = progress.total ?? total
          if (total > 0) {
            const percent = Math.round((received / total) * 100)
            const mb = (received / 1048576).toFixed(1)
            const mbTotal = (total / 1048576).toFixed(1)
            process.stdout.write('\r  ' + percent + '%  ' + mb + ' / ' + mbTotal + ' MB')
          }
        }
      })
      console.log('\nExtracting…')
      await extract(zipPath, { dir: root })
      lastError = null
      break
    } catch (error) {
      lastError = error
      console.log('\n  mirror failed (' + (mirror ?? 'GitHub') + '): ' + String(error?.message || error))
    }
  }
  if (lastError) throw lastError
  console.log('Done: ' + exe)
}

main().catch((error) => {
  console.error('Electron download failed: ' + String(error))
  console.error('Set DSH_QUICKDOCK_ELECTRON_PATH to an existing Electron binary to use desktop mode.')
  console.error('Web mode is unaffected.')
  process.exitCode = 1
})
