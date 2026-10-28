/**
 * Host-side locale controller.
 *
 * The DSH locale is a browser concept (the client plugin owns the preference),
 * so the Client half pushes it over the bridge exactly like the theme. Until
 * then the configured value or the operating system decides.
 */

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { Translator, loadCatalogs, normalizeLocale, resolveLocale, systemLocale } = require('../runtime/i18n.js')

const LOCALE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'locale')

/** Language tag used for the served <html lang> attribute. */
export function htmlLang(locale) {
  return locale === 'zh' ? 'zh-CN' : 'en'
}

export class LocaleController {
  /**
   * @param {{preference?: string, onChange?: (locale: string) => void}} [options]
   *   preference comes from plugin config ('auto' or a language id).
   */
  constructor(options = {}) {
    this.preference = options.preference || 'auto'
    this.onChange = options.onChange || null
    this.explicit = normalizeLocale(this.preference)
    this.pushed = ''
    this.translator = new Translator(loadCatalogs(LOCALE_DIR), this.#initialLocale())
  }

  #initialLocale() {
    if (this.explicit) return this.explicit
    return resolveLocale([systemLocale()], 'en')
  }

  /** Active language id. */
  get locale() {
    return this.translator.locale
  }

  /** Translate one key with the active catalog. */
  t(key, params) {
    return this.translator.t(key, params)
  }

  /** Active catalog merged over English, injected into the dock page. */
  messages() {
    return this.translator.catalog()
  }

  /** Payload pushed to dock pages over SSE. */
  snapshot() {
    return { locale: this.locale, messages: this.messages() }
  }

  /**
   * Adopt the locale reported by the Client half.
   * @param {unknown} value language tag from the browser.
   * @returns {boolean} whether the active locale changed.
   */
  accept(value) {
    const next = normalizeLocale(value)
    if (!next) return false
    // An explicit configuration always wins over the browser report.
    if (this.explicit && this.explicit !== next) return false
    this.pushed = next
    this.#apply(next)
    return true
  }

  #apply(next) {
    const before = this.locale
    this.translator.setLocale(next)
    const changed = this.locale !== before
    if (changed) this.onChange?.(this.locale)
    return changed
  }
}
