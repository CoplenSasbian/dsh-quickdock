/**
 * The loader rows QuickDock owns in the profile patch (`cordis.patch.yml`).
 *
 * The file is shared with the user and with other managers, so it is edited by
 * splicing whole top-level entries: the header comment and every row QuickDock
 * does not own stay byte-for-byte identical. Re-serialising the YAML would drop
 * comments and reformat a file people edit by hand (see "Writing safely" in
 * MCP-PAIRING.md).
 *
 * The text functions are pure and exported for the unit tests; the two file
 * helpers at the bottom add the lock and the atomic replace.
 */

import {
  closeSync,
  copyFileSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync
} from 'node:fs'

/** Patch id of both rows QuickDock maintains. */
export const PATCH_ID = 'mcp-dsh-vsdock'
/** The plugin row the editor's MCP server is registered on. */
export const MCP_CLIENT_PACKAGE = '@deepseek-ai/dsh-mcp-client'
/** `serverName` in the client config; tools appear as `mcp__dsh-vsdock__*`. */
export const SERVER_NAME = 'dsh-vsdock'
/** A lock older than this belongs to a writer that died mid-write. */
export const LOCK_STALE_MS = 10_000

/** Quote a scalar for YAML double-quoted style. */
function quote(value) {
  return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

/** Strip matching quotes from an id scalar. */
function unquote(value) {
  const text = String(value).trim()
  if (text.length >= 2 && (text[0] === '"' || text[0] === "'") && text[text.length - 1] === text[0]) {
    return text.slice(1, -1)
  }
  return text
}

/**
 * The insert row for one live descriptor.
 *
 * `failOnStartupError: false` is deliberate: a paired editor comes and goes, and
 * a row that is enabled while the server is down must not fail DSH's own boot.
 * The liveness poll disables the row instead.
 * @param {{url: string, token: string}} entry live descriptor endpoint.
 * @returns {string} block text, no trailing newline.
 */
export function buildInsertBlock(entry) {
  return [
    '- insert:',
    '    - id: ' + PATCH_ID,
    '      name: "' + MCP_CLIENT_PACKAGE + '"',
    '      config:',
    '        serverName: "' + SERVER_NAME + '"',
    '        transport: "streamable-http"',
    '        url: ' + quote(entry.url),
    '        headers:',
    '          Authorization: ' + quote('Bearer ' + entry.token),
    '        failOnStartupError: false'
  ].join('\n')
}

/**
 * The toggle row. It is the stable record of "ours", so it stays in place and
 * only its `disabled` value changes at runtime.
 * @param {boolean} disabled desired value.
 * @returns {string} block text, no trailing newline.
 */
export function buildToggleBlock(disabled) {
  return ['- id: ' + PATCH_ID, '  disabled: ' + (disabled ? 'true' : 'false')].join('\n')
}

/**
 * Locate the top-level entries that matter.
 *
 * A top-level entry starts at a line whose first non-space character is `-`
 * in column 0; everything indented belongs to that entry. Our insert block is a
 * whole `- insert:` entry that holds exactly one row; a `- id: mcp-dsh-vsdock`
 * entry is the toggle row.
 * @param {string} text patch document.
 * @returns {{eol: string, lines: string[], insert: object|null, toggle: object|null, sharedInsert: object|null}}
 *   ranges are `{start, end}` with `end` exclusive.
 */
export function scanPatch(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  const starts = []
  for (let index = 0; index < lines.length; index += 1) {
    if (/^-(\s|$)/.test(lines[index])) starts.push(index)
  }
  const ranges = starts.map((start, index) => ({
    start,
    end: index + 1 < starts.length ? starts[index + 1] : lines.length
  }))
  let insert = null
  let toggle = null
  let sharedInsert = null
  for (const range of ranges) {
    const first = lines[range.start]
    if (/^-\s+insert:/.test(first)) {
      const ids = []
      for (let index = range.start + 1; index < range.end; index += 1) {
        const match = /^\s+-\s+id:\s*(.+)$/.exec(lines[index])
        if (match) ids.push(unquote(match[1]))
      }
      if (!ids.includes(PATCH_ID)) continue
      // A block that also holds someone else's rows is not ours to replace.
      if (ids.length === 1) insert = range
      else sharedInsert = range
      continue
    }
    const inline = /^-\s+id:\s*(.+)$/.exec(first)
    if (inline && unquote(inline[1]) === PATCH_ID) toggle = range
  }
  return { eol, lines, insert, toggle, sharedInsert }
}

/**
 * The block range without the blank lines that separate it from the next entry,
 * so a replacement keeps the file's spacing.
 */
function trimmedRange(lines, range) {
  let end = range.end
  while (end > range.start + 1 && lines[end - 1].trim() === '') end -= 1
  return { start: range.start, end }
}

/** Append a block, dropping a lone `[]` document so the result stays an array. */
function appendBlock(patch, blockLines) {
  const body = patch.lines.filter((line) => line.trim() !== '[]').join(patch.eol)
  const head = body.replace(/[ \t\r\n]+$/, '')
  return (head.length ? head + patch.eol + patch.eol : '') + blockLines.join(patch.eol) + patch.eol
}

/**
 * Insert or update the insert row.
 *
 * A `sharedInsert` document is returned untouched: replacing that block would
 * delete rows QuickDock does not own, and duplicating the id would confuse the
 * loader. The caller logs and leaves the file alone.
 * @param {string} text patch document.
 * @param {{url: string, token: string}} entry live descriptor endpoint.
 * @returns {string} the document, identical when nothing changed.
 */
export function withInsert(text, entry) {
  const patch = scanPatch(text)
  if (patch.sharedInsert) return text
  const block = buildInsertBlock(entry).split('\n')
  if (!patch.insert) return appendBlock(patch, block)
  const range = trimmedRange(patch.lines, patch.insert)
  const current = patch.lines.slice(range.start, range.end)
  if (current.join('\n') === block.join('\n')) return text
  return patch.lines.slice(0, range.start).concat(block, patch.lines.slice(range.end)).join(patch.eol)
}

/**
 * Create or update the toggle row.
 *
 * Without an insert row there is nothing to toggle, so nothing is created: a
 * non-live descriptor never conjures a row out of nothing.
 * @param {string} text patch document.
 * @param {boolean} disabled desired value.
 * @returns {string} the document, identical when nothing changed.
 */
export function withToggle(text, disabled) {
  const patch = scanPatch(text)
  const wanted = '  disabled: ' + (disabled ? 'true' : 'false')
  if (!patch.toggle) {
    if (!patch.insert) return text
    return appendBlock(patch, buildToggleBlock(disabled).split('\n'))
  }
  const range = trimmedRange(patch.lines, patch.toggle)
  const block = patch.lines.slice(range.start, range.end)
  let found = false
  const next = block.map((line) => {
    if (!/^\s*disabled:/.test(line)) return line
    found = true
    return wanted
  })
  if (!found) next.splice(1, 0, wanted)
  if (next.join('\n') === block.join('\n')) return text
  return patch.lines.slice(0, range.start).concat(next, patch.lines.slice(range.end)).join(patch.eol)
}

/**
 * Is the document still a top-level YAML array? Deliberately shallow: the point
 * is to refuse to commit a splice that broke the file, not to validate YAML.
 * @param {string} text patch document.
 * @returns {{ok: boolean, reason: string, entries: number}} verdict.
 */
export function validatePatch(text) {
  const lines = text.split(/\r?\n/)
  let entries = 0
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const bare = line.trim()
    if (bare === '' || bare.startsWith('#') || bare === '[]') continue
    // A top-level entry starts with `-` in column 0; indented lines continue it.
    if (/^-(\s|$)/.test(line)) {
      entries += 1
      continue
    }
    if (entries > 0 && /^\s/.test(line)) continue
    return { ok: false, reason: 'line ' + (index + 1) + ' is not a top-level entry', entries }
  }
  return { ok: true, reason: '', entries }
}

/**
 * Read the patch file.
 * @param {string} file absolute path.
 * @returns {{ok: boolean, text: string, missing: boolean, error: string}} result.
 */
export function readPatch(file) {
  try {
    return { ok: true, text: readFileSync(file, 'utf8'), missing: false, error: '' }
  } catch (error) {
    return {
      ok: false,
      text: '',
      missing: Boolean(error && error.code === 'ENOENT'),
      error: String((error && error.code) || error)
    }
  }
}

/**
 * Take the writer lock. A live lock means another writer is mid-splice, so this
 * attempt yields; a stale one (a dead writer) is reclaimed.
 * @param {string} lockFile lock path.
 * @returns {number|null} open file descriptor, or null when the lock is held.
 */
function acquireLock(lockFile) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const fd = openSync(lockFile, 'wx')
      try { writeSync(fd, String(process.pid)) } catch (_) { /* the fd is the lock */ }
      return fd
    } catch (error) {
      if (!error || error.code !== 'EEXIST') return null
      let stale = false
      try {
        stale = Date.now() - statSync(lockFile).mtimeMs > LOCK_STALE_MS
      } catch (_) {
        continue
      }
      if (!stale) return null
      try { unlinkSync(lockFile) } catch (_) { /* another writer won the race */ }
    }
  }
  return null
}

/**
 * Replace the patch file atomically, keeping the last good copy as `.bak`.
 *
 * The document is re-validated here, right before the rename: a splice bug must
 * leave the user's file untouched rather than produce a half-written profile.
 * @param {string} file absolute path.
 * @param {string} text complete new document.
 * @returns {{ok: boolean, error: string}} result.
 */
export function writePatch(file, text) {
  const check = validatePatch(text)
  if (!check.ok) return { ok: false, error: 'refusing to write: ' + check.reason }
  const lockFile = file + '.lock'
  const fd = acquireLock(lockFile)
  if (fd === null) return { ok: false, error: 'locked' }
  try {
    const temp = file + '.tmp'
    writeFileSync(temp, text, 'utf8')
    try { copyFileSync(file, file + '.bak') } catch (_) { /* first write: no previous file */ }
    renameSync(temp, file)
    return { ok: true, error: '' }
  } catch (error) {
    return { ok: false, error: String((error && error.code) || error) }
  } finally {
    try { closeSync(fd) } catch (_) { /* already closed */ }
    try { unlinkSync(lockFile) } catch (_) { /* another writer reclaimed it */ }
  }
}
