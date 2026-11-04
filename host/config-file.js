/**
 * The plugin's own configuration file.
 *
 * The Loader row config (cordis.patch.yml) is the deploy-time default: it says how
 * the plugin was installed. Everything a *user* may change while running lives in
 * `config.json` next to the host log, so the values survive plugin upgrades and can
 * be edited by hand or from DSH's Settings page.
 *
 * Precedence: config.json > row config > schema default.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Documented defaults; also the template written on first run. */
export const DEFAULT_CONFIG = Object.freeze({
  // Window
  width: 460,
  height: 820,
  minWidth: 360,
  minHeight: 420,
  maxWidth: 900,
  maxHeight: 1400,
  alwaysOnTop: false,
  rememberGeometry: true,
  focusOnSummon: false,
  // Floating ball
  ballSize: 64,
  ballIcon: 'whale',
  ballAlwaysVisible: false,
  snapToEdge: true,
  // Window behaviour
  collapseOnClose: false,
  // Start-up
  autoLaunch: false,
  prefetchElectron: true,
  // DSH integration
  headerButton: true,
  headerButtonOrder: 1010
})

/** Numeric bounds applied to every stored value. */
const RANGES = {
  width: [320, 1200],
  height: [320, 1600],
  minWidth: [280, 1200],
  minHeight: [280, 1600],
  maxWidth: [320, 2000],
  maxHeight: [320, 2000],
  ballSize: [24, 160],
  headerButtonOrder: [0, 10000]
}

/** Keys with a fixed value set instead of a number range. */
const ENUMS = {
  ballIcon: ['whale', 'dot']
}

/**
 * Configuration file path for this install.
 * @param {string} logPath host log path (same directory).
 * @returns {string} path to `config.json`.
 */
export function configPath(logPath) {
  return join(dirname(logPath), 'config.json')
}

/**
 * Write the commented template when the file does not exist yet, so the settings
 * are discoverable instead of living in memory only.
 * @param {string} file path from {@link configPath}.
 * @returns {Record<string, unknown>} the stored values (empty on a fresh write).
 */
export function writeTemplateIfMissing(file) {
  const current = readConfig(file)
  if (Object.keys(current).length > 0) return current
  try {
    const exists = readFileSync(file, 'utf8')
    if (exists.trim().length > 0) return current
  } catch (_) { /* missing: write it */ }
  writeConfig(file, DEFAULT_CONFIG)
  return {}
}

/**
 * Read the stored configuration.
 * @param {string} file path from {@link configPath}.
 * @returns {Record<string, unknown>} stored keys only (never throws).
 */
export function readConfig(file) {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return sanitize(value)
  } catch (_) {
    return {}
  }
}

/**
 * Write a file the user can edit: first run writes the whole template.
 * @param {string} file path from {@link configPath}.
 * @param {Record<string, unknown>} values configuration to persist.
 * @returns {Record<string, unknown>} what was written.
 */
export function writeConfig(file, values) {
  const next = sanitize(values)
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(next, null, 2) + '\n', 'utf8')
  } catch (_) {
    /* read-only profile: the values still apply for this session */
  }
  return next
}

/**
 * Clamp a stored value into its documented bounds.
 * @param {string} key configuration key.
 * @param {unknown} value raw value.
 * @returns {unknown} sanitized value.
 */
export function sanitizeValue(key, value) {
  if (!(key in DEFAULT_CONFIG)) return undefined
  const fallback = DEFAULT_CONFIG[key]
  if (typeof fallback === 'boolean') return value === true || value === false ? value : undefined
  if (ENUMS[key]) return ENUMS[key].includes(value) ? value : undefined
  if (typeof fallback === 'number') {
    const number = Number(value)
    if (!Number.isFinite(number)) return undefined
    const range = RANGES[key]
    const clamped = range ? Math.min(range[1], Math.max(range[0], number)) : number
    return Math.round(clamped)
  }
  return undefined
}

/**
 * Drop unknown keys and clamp the known ones.
 * @param {Record<string, unknown>} values raw configuration.
 * @returns {Record<string, unknown>} sanitized copy.
 */
export function sanitize(values) {
  const out = {}
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    const clean = sanitizeValue(key, values ? values[key] : undefined)
    if (clean !== undefined) out[key] = clean
  }
  return out
}

/**
 * Merge the layers for one key.
 * @param {Record<string, unknown>} file values from config.json.
 * @param {object} row the Loader row config.
 * @param {string} key configuration key.
 * @returns {unknown} effective value.
 */
export function resolveValue(file, row, key) {
  const stored = sanitizeValue(key, file ? file[key] : undefined)
  if (stored !== undefined) return stored
  const legacy = row ? sanitizeValue(key, row[key]) : undefined
  if (legacy !== undefined) return legacy
  // The row still uses the schema names for the window size.
  if (key === 'height' && row) {
    const legacyHeight = sanitizeValue('height', row.inputHeight)
    if (legacyHeight !== undefined) return legacyHeight
  }
  return DEFAULT_CONFIG[key]
}
