#!/usr/bin/env node
/**
 * Build the run window's render island.
 *
 * The island draws rows with the DSH web UI primitives, so the sources under
 * web/render/src are bundled once and committed: the Host inlines the artifacts
 * like every other page asset, and the plugin keeps working without a build
 * step at install time.
 *
 * Usage: node scripts/build-render.mjs
 */
import { readFile, writeFile, rm } from 'node:fs/promises'
import { rollup } from 'rollup'
import { minify } from 'terser'
import resolve from '@rollup/plugin-node-resolve'
import commonjs from '@rollup/plugin-commonjs'
import replace from '@rollup/plugin-replace'
import postcss from 'rollup-plugin-postcss'

/** The brand-glyph barrel is not drawn here; use the empty stand-in instead. */
const stubSimpleIcons = {
  name: 'stub-simple-icons',
  resolveId(source) {
    if (source !== 'simple-icons') return null
    return new URL('../web/render/src/simple-icons.stub.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
  }
}

/**
 * Keep shiki's grammar barrel out of the page bundle: only the three grammars
 * the primitives pre-warm (json / shellscript / typescript) are kept, and the
 * markdown/math stack is replaced by the empty module because the island
 * renders no prose math.
 */
const STUBBED = new Set(['shiki'])
const stubMarkdownStack = {
  name: 'stub-markdown-stack',
  resolveId(source) {
    if (STUBBED.has(source)) return '\0empty-module'
    if (source.includes('@shikijs/langs') && !/@shikijs\/langs\/(json|shellscript|typescript)$/.test(source)) {
      return '\0empty-module'
    }
    return null
  },
  load(id) {
    if (id !== '\0empty-module') return null
    return 'export const bundledLanguages = {}\nexport const bundledThemes = {}\nexport const renderToString = () => ""\nexport default {}\n'
  }
}

const plugins = [
  stubSimpleIcons,
  stubMarkdownStack,
  replace({ preventAssignment: true, 'process.env.NODE_ENV': '"production"' }),
  postcss({ modules: { generateScopedName: '[name]_[local]' }, extract: 'bundle.css' }),
  resolve({ browser: true, extensions: ['.js', '.jsx', '.mjs', '.cjs'] }),
  commonjs()
]

const bundle = await rollup({ input: 'web/render/src/entry.js', plugins, onwarn: () => {} })
await bundle.write({ file: 'web/render/bundle.raw.js', format: 'iife', inlineDynamicImports: true })
await bundle.close()

const raw = await readFile('web/render/bundle.raw.js', 'utf8')
const minified = await minify(raw, { compress: true, mangle: true, format: { comments: false } })
await writeFile('web/render/bundle.js', minified.code)
await rm('web/render/bundle.raw.js')

// KaTeX's @font-face rules are useless here: the page is inline-only, so the
// fonts cannot load and every render would log a CSP violation.
let css = await readFile('web/render/bundle.css', 'utf8')
css = css.replace(/@font-face\{[^}]*\}/g, '')
await writeFile('web/render/bundle.css', css)
console.log('render island built: bundle.js ' + minified.code.length + ' B, bundle.css ' + css.length + ' B')
