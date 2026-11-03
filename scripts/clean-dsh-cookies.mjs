#!/usr/bin/env node
/**
 * Remove the DSH desktop app's stale launch cookies.
 *
 * The Desktop Host binds a random loopback port on every launch and mints one
 * `dsh-auth-*` cookie per authority. The app never prunes the old ones, so the
 * Cookie header grows with every restart until it crosses Node's 16 KB request
 * header limit. The Host then answers the launch URL with
 * `HTTP/1.1 431 Request Header Fields Too Large`, the Electron shell reports
 * `desktop welcome: Web authentication failed`, and DSH stops opening.
 *
 * The cookies are per-launch credentials: the next start mints a fresh one, so
 * deleting all of them is safe. Quit DSH before running this.
 *
 * Usage: node scripts/clean-dsh-cookies.mjs [--dry-run]
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

const DRY = process.argv.includes('--dry-run')

/** The Electron user-data directory DSH Desktop uses. */
function cookiesPath() {
  const appData = process.env.APPDATA ||
    (process.platform === 'darwin'
      ? join(process.env.HOME || '', 'Library', 'Application Support')
      : join(process.env.HOME || '', '.config'))
  return process.env.DSH_DESKTOP_COOKIES ||
    join(appData, '@deepseek-ai', 'dsh-desktop', 'Network', 'Cookies')
}

const file = cookiesPath()
if (!existsSync(file)) {
  console.log('no cookie store at ' + file + '; nothing to clean')
  process.exit(0)
}

let DatabaseSync
try {
  ({ DatabaseSync } = await import('node:sqlite'))
} catch (_) {
  console.error('node:sqlite is unavailable; run this with Node 22.5 or newer')
  process.exit(1)
}

let db
try {
  db = new DatabaseSync(file, { readOnly: DRY })
} catch (error) {
  console.error('cannot open ' + file + ': ' + (error?.message || error))
  console.error('quit DSH (including the tray) and run this again')
  process.exit(1)
}

try {
  const count = (sql) => db.prepare(sql).get().n
  const before = count("select count(*) as n from Cookies where name like 'dsh-auth-%'")
  console.log('dsh-auth cookies in ' + file + ': ' + before)
  if (before === 0) {
    console.log('nothing to clean')
  } else if (DRY) {
    console.log('dry run: would delete ' + before)
  } else {
    db.exec('begin immediate')
    const info = db.prepare("delete from Cookies where name like 'dsh-auth-%'").run()
    db.exec('commit')
    console.log('deleted ' + info.changes + '; DSH will mint a fresh cookie on the next start')
  }
} finally {
  db.close()
}
