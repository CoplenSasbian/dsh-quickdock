/**
 * Dock page renderer.
 *
 * Both windows are single documents served by the Host: CSS, theme variables,
 * locale messages and page scripts are inlined so the page makes no extra
 * requests and has its final colors and language on the first paint.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { VIEWS } from './constants.js'
import { htmlLang } from './locale.js'
import { themeCss } from './theme.js'

/**
 * Serialize a value into an inline script without breaking out of <script>.
 * @param {unknown} value JSON value.
 * @returns {string} safe JSON literal.
 */
function scriptJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

export class PageRenderer {
  /**
   * @param {{rootDir: string, theme: object, locale: object,
   *          trace?: (message: unknown) => void}} deps
   */
  constructor(deps) {
    this.webDir = join(deps.rootDir, 'web')
    this.theme = deps.theme
    this.locale = deps.locale
    this.trace = deps.trace || (() => {})
    this.assets = null
  }

  /** Read the web asset manifest and every listed file once. */
  #load() {
    if (this.assets) return this.assets
    const manifest = JSON.parse(readFileSync(join(this.webDir, 'manifest.json'), 'utf8'))
    const read = (name) => {
      try {
        return readFileSync(join(this.webDir, name), 'utf8')
      } catch (error) {
        this.trace('page asset missing: ' + name + ' (' + error + ')')
        return ''
      }
    }
    this.assets = {
      styles: (manifest.styles || []).map(read).join('\n'),
      scripts: (manifest.scripts || []).map(read).join('\n'),
      html: {
        [VIEWS.input]: read('index.html'),
        [VIEWS.display]: read('display.html')
      }
    }
    return this.assets
  }

  /**
   * Render one view.
   * @param {'input'|'display'} view which window to render.
   * @returns {string} complete HTML document.
   */
  render(view) {
    const assets = this.#load()
    const html = assets.html[view] || assets.html[VIEWS.input]
    const locale = this.locale.locale
    const shell = {
      lang: htmlLang(locale),
      scheme: this.theme.colorScheme(),
      theme: themeCss(this.theme.current()),
      i18n: '<script>window.__QD_I18N__ = ' + scriptJson(this.locale.snapshot()) + ';</script>'
    }
    // Replacement functions keep '$&' / "$'" in the sources literal.
    const put = (value) => () => value
    return html
      .replace('<!--QD_THEME-->', put(shell.theme))
      .replace('<!--QD_I18N-->', put(shell.i18n))
      .replace('<!--QD_STYLES-->', put('<style>' + assets.styles + '</style>'))
      .replace('<!--QD_SCRIPT-->', put('<script>' + assets.scripts + '</script>'))
      .replace(/<html[^>]*>/, put('<html lang="' + shell.lang + '" data-theme="' + shell.scheme + '">'))
  }
}
