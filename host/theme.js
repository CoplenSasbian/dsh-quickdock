/**
 * Theme bridge: DSH alias tokens -> dock CSS variables.
 *
 * DSH themes live in the browser, so the Client half reads the resolved palette
 * and pushes it over the bridge. Only the whitelisted tokens below are
 * forwarded; anything else would leave the dock half-themed.
 */

import { MIN_THEME_TOKENS } from './constants.js'

/** DSH token -> dock variable (DESIGN 7.2). */
export const THEME_TOKEN_MAP = Object.freeze({
  '--dsw-alias-bg-base': '--qd-bg-base',
  '--dsw-alias-bg-layer-1': '--qd-bg-layer-1',
  '--dsw-alias-bg-layer-2': '--qd-bg-layer-2',
  '--dsw-alias-bg-overlay': '--qd-bg-overlay',
  '--dsw-alias-border-l1': '--qd-border-l1',
  '--dsw-alias-border-l2': '--qd-border-l2',
  '--dsw-alias-label-primary': '--qd-label-primary',
  '--dsw-alias-label-secondary': '--qd-label-secondary',
  '--dsw-alias-label-tertiary': '--qd-label-tertiary',
  '--dsw-alias-brand-primary': '--qd-brand-primary',
  '--dsw-alias-state-success-primary': '--qd-state-success',
  '--dsw-alias-state-error-primary': '--qd-state-error',
  '--dsw-alias-state-warn-primary': '--qd-state-warn',
  '--dsw-alias-state-idle-primary': '--qd-state-idle',
  '--dsw-alias-interactive-bg-hover': '--qd-interactive-hover',
  '--dsw-alias-interactive-bg-active': '--qd-interactive-active',
  '--dsw-alias-scrollbar-bg-l1': '--qd-scrollbar',
  '--dsw-alias-scrollbar-hover-l1': '--qd-scrollbar-hover',
  '--dsw-alias-separator-primary': '--qd-separator',
  '--dsw-alias-tooltip-bg': '--qd-tooltip-bg',
  '--dsw-alias-tooltip-key-bg': '--qd-tooltip-key-bg'
})

/** Whitelisted DSH token names. */
export const THEME_TOKENS = Object.freeze(Object.keys(THEME_TOKEN_MAP))

/**
 * Dock variables derived from a mapped token.
 *
 * DSH's brand accent is monochrome: it is the inverse of the base surface, so
 * text painted on brand must use the base surface colour. Deriving it keeps
 * the send button readable in both schemes without another DSH token.
 */
const DERIVED_TOKENS = Object.freeze({ '--qd-brand-fg': '--qd-bg-base' })

function stringValue(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

/** Add derived variables to a mapped token table. */
function deriveTokens(tokens) {
  for (const [target, source] of Object.entries(DERIVED_TOKENS)) {
    if (tokens[source] && !tokens[target]) tokens[target] = tokens[source]
  }
  return tokens
}

/** Whether two payloads describe the same palette. */
function samePayload(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Normalize an incoming theme payload.
 * @param {unknown} payload bridge payload (dsw or already-mapped token names).
 * @returns {{colorScheme: string, tokens: Record<string,string>, fonts: object}|null}
 */
export function normalizeTheme(payload) {
  if (!payload || typeof payload !== 'object') return null
  const raw = payload.tokens && typeof payload.tokens === 'object' ? payload.tokens : {}
  const tokens = {}
  for (const [dsw, qd] of Object.entries(THEME_TOKEN_MAP)) {
    const value = stringValue(raw[qd]) || stringValue(raw[dsw])
    if (value) tokens[qd] = value
  }
  deriveTokens(tokens)
  if (Object.keys(tokens).length < MIN_THEME_TOKENS) return null
  const fonts = payload.fonts && typeof payload.fonts === 'object' ? payload.fonts : {}
  return {
    colorScheme: payload.colorScheme === 'light' ? 'light' : 'dark',
    tokens,
    fonts: {
      text: typeof fonts.text === 'string' ? fonts.text : '',
      code: typeof fonts.code === 'string' ? fonts.code : '',
      sizeText: Number(fonts.sizeText) || 12,
      sizeCode: Number(fonts.sizeCode) || 11
    }
  }
}

/**
 * Normalize a DSH ThemeSnapshot (host theme service or theme/change event).
 * @param {object} snapshot DSH theme snapshot.
 * @returns {object|null} normalized payload.
 */
export function themeFromSnapshot(snapshot) {
  if (!snapshot?.active) return null
  const source = snapshot.active.tokens || {}
  const tokens = {}
  for (const [dsw, qd] of Object.entries(THEME_TOKEN_MAP)) {
    const value = stringValue(source[dsw])
    if (value) tokens[qd] = value
  }
  deriveTokens(tokens)
  if (Object.keys(tokens).length < MIN_THEME_TOKENS) return null
  return {
    colorScheme: snapshot.active.colorScheme === 'light' ? 'light' : 'dark',
    tokens,
    fonts: {
      text: snapshot.fontFamilies?.text ?? '',
      code: snapshot.fontFamilies?.code ?? '',
      sizeText: snapshot.fontSizes?.text ?? 12,
      sizeCode: snapshot.fontSizes?.code ?? 11
    }
  }
}

/**
 * Inline style block for the first paint (avoids a fallback-color flash).
 *
 * The selector must outrank the dock's own light palette, which is declared as
 * html[data-theme="light"] in styles.css: same specificity, emitted later, so
 * the DSH values win before the first frame.
 */
export function themeCss(payload) {
  if (!payload) return ''
  const rows = Object.entries(payload.tokens).map(([key, value]) => '  ' + key + ': ' + value + ';').join('\n')
  const fonts = []
  if (payload.fonts?.text) fonts.push('  --qd-font-text: ' + payload.fonts.text + ';')
  if (payload.fonts?.code) fonts.push('  --qd-font-code: ' + payload.fonts.code + ';')
  if (payload.fonts?.sizeText) fonts.push('  --qd-font-size-text: ' + payload.fonts.sizeText + 'px;')
  if (payload.fonts?.sizeCode) fonts.push('  --qd-font-size-code: ' + payload.fonts.sizeCode + 'px;')
  return '<style>html[data-theme]{\n' + rows + '\n' + fonts.join('\n') + '\n}</style>'
}

export class ThemeStore {
  /**
   * @param {{getSnapshot?: () => object, onChange?: (payload: object) => void,
   *          fallback?: string}} [deps] fallback is 'light'|'dark' before DSH reports
   *   the theme; 'auto' (or anything else) keeps the built-in dark palette.
   */
  constructor(deps = {}) {
    this.payload = null
    this.getSnapshot = deps.getSnapshot || null
    this.onChange = deps.onChange || null
    this.fallback = deps.fallback === 'light' || deps.fallback === 'dark' ? deps.fallback : ''
  }

  /** Current theme payload, or null while no usable theme is known. */
  current() {
    if (this.payload) return this.payload
    if (!this.getSnapshot) return null
    return themeFromSnapshot(this.getSnapshot())
  }

  /**
   * Adopt a payload pushed by the Client half.
   * @returns {boolean} whether it was usable.
   */
  accept(payload) {
    const normalized = normalizeTheme(payload)
    if (!normalized) return false
    // An identical palette (font-only or duplicate push) must not spam SSE.
    if (this.payload && samePayload(this.payload, normalized)) return true
    this.payload = normalized
    this.onChange?.(normalized)
    return true
  }

  /** Adopt a DSH ThemeSnapshot (host theme service / theme change event). */
  acceptSnapshot(snapshot) {
    const normalized = themeFromSnapshot(snapshot)
    if (!normalized) return false
    if (this.payload && samePayload(this.payload, normalized)) return true
    this.payload = normalized
    this.onChange?.(normalized)
    return true
  }

  /** CSS block for the first paint. */
  css() {
    return themeCss(this.current())
  }

  /** Color scheme id used for <html data-theme>. */
  colorScheme() {
    const current = this.current()
    if (current) return current.colorScheme === 'light' ? 'light' : 'dark'
    return this.fallback || 'dark'
  }
}
