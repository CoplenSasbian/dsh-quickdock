#!/usr/bin/env node
/**
 * Zero-dependency repository checks.
 *
 * Enforced (fails the build):
 *  1. every locale key used by code/HTML exists in both catalogs
 *  2. catalogs carry the same keys and the same {placeholders}
 *  3. the Client bundle's embedded catalog matches locale/*.json
 *  4. no CJK outside locale files, docs and the marked Client catalog
 *  5. UTF-8 + LF + final newline + no tabs/trailing spaces in source
 *  6. web/manifest.json lists existing assets in a valid order
 *
 * Deliberately dependency-free: `npm test` must work in a fresh checkout.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE_EXT = new Set(['.js', '.cjs', '.mjs', '.css', '.html', '.json', '.yml', '.yaml'])
const TEXT_EXT = new Set([...SOURCE_EXT, '.svg', '.txt'])
const SKIP_DIRS = new Set(['node_modules', '.git', 'tmp', '.electron-test'])
// The prototype and the packed default app are artifacts, kept as-is.
const SKIP_FILES = new Set(['dock-prototype.html', 'default_app_test.asar'])
const DYNAMIC_PREFIXES = ['reasoning.']

const problems = []
const warnings = []
const fail = (file, message) => problems.push(file + ': ' + message)
const warn = (file, message) => warnings.push(file + ': ' + message)

function walk(dir) {
  const files = []
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) files.push(...walk(full))
    else files.push(full)
  }
  return files
}

const files = walk(ROOT).map((full) => ({ full, rel: relative(ROOT, full).replaceAll('\\', '/') }))
const source = files.filter((file) => SOURCE_EXT.has(extname(file.full)) && !SKIP_FILES.has(file.rel))
// Test files may use fake keys, so key usage is scanned on product sources only.
const productSource = source.filter((file) => !file.rel.startsWith('runtime/test/'))
const locales = ['en', 'zh']

/* 1/2. catalog parity and placeholders */
const catalogs = {}
for (const locale of locales) {
  const file = files.find((entry) => entry.rel === 'locale/' + locale + '.json')
  if (!file) {
    fail('locale/' + locale + '.json', 'missing catalog')
    continue
  }
  try {
    catalogs[locale] = JSON.parse(readFileSync(file.full, 'utf8'))
  } catch (error) {
    fail(file.rel, 'invalid JSON (' + error.message + ')')
  }
}
const enKeys = Object.keys(catalogs.en || {}).sort()
const zhKeys = Object.keys(catalogs.zh || {}).sort()
if (enKeys.length !== zhKeys.length) {
  fail('locale', 'catalog key count differs (en ' + enKeys.length + ', zh ' + zhKeys.length + ')')
}
for (const key of enKeys) if (!(key in (catalogs.zh || {}))) fail('locale/zh.json', 'missing key "' + key + '"')
for (const key of zhKeys) if (!(key in (catalogs.en || {}))) fail('locale/en.json', 'extra key "' + key + '"')

const placeholders = (value) => new Set([...String(value).matchAll(/\{(\w+)\}/g)].map((match) => match[1]))
for (const key of enKeys) {
  const a = [...placeholders(catalogs.en[key])].sort().join(',')
  const b = [...placeholders((catalogs.zh || {})[key] ?? '')].sort().join(',')
  if (a !== b) fail('locale', 'placeholder mismatch for "' + key + '" (en {' + a + '}, zh {' + b + '})')
}

/* Used keys: t('...') calls and data-i18n attributes. */
const used = new Map()
const KEY_PATTERNS = [
  /\bt\(\s*'([a-zA-Z][\w.]*)'/g,
  /\bt\(\s*"([a-zA-Z][\w.]*)"/g,
  /data-i18n(?:-title|-aria-label|-placeholder)?="([a-zA-Z][\w.]*)"/g
]
for (const file of productSource) {
  const text = readFileSync(file.full, 'utf8')
  for (const pattern of KEY_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const key = match[1]
      if (!used.has(key)) used.set(key, new Set())
      used.get(key).add(file.rel)
    }
  }
}
for (const [key, where] of used) {
  if (!(key in (catalogs.en || {}))) fail([...where][0], 'unknown locale key "' + key + '"')
}
// Keys may also be referenced as literals (lookup tables, option lists).
const literalKeys = new Set()
for (const file of productSource) {
  const text = readFileSync(file.full, 'utf8')
  for (const match of text.matchAll(/'([a-zA-Z][\w.]*)'|"([a-zA-Z][\w.]*)"/g)) {
    literalKeys.add(match[1] || match[2])
  }
}
for (const key of enKeys) {
  if (used.has(key) || literalKeys.has(key)) continue
  if (DYNAMIC_PREFIXES.some((prefix) => key.startsWith(prefix))) continue
  warn('locale/en.json', 'unused key "' + key + '"')
}

/* 3. Client bundle catalog must mirror the JSON files. */
const clientFile = files.find((entry) => entry.rel === 'client.js')
if (!clientFile) {
  fail('client.js', 'missing')
} else {
  const text = readFileSync(clientFile.full, 'utf8')
  const start = text.indexOf('/* i18n-catalog:start')
  const end = text.indexOf('/* i18n-catalog:end')
  if (start < 0 || end < 0) {
    fail('client.js', 'missing the i18n-catalog markers')
  } else {
    const region = text.slice(start, end)
    for (const locale of locales) {
      const parts = region.split(new RegExp(locale + ':\\s*\\{'))
      const block = parts[1]
      if (!block) {
        fail('client.js', 'missing ' + locale + ' catalog block')
        continue
      }
      const body = block.split(/\n\s*\}/)[0]
      for (const match of body.matchAll(/'([\w.]+)':\s*'((?:[^'\\]|\\.)*)'/g)) {
        const key = match[1]
        const value = match[2].replace(/\\'/g, "'").replace(/\\\\/g, '\\')
        const expected = (catalogs[locale] || {})[key]
        if (expected === undefined) {
          fail('client.js', locale + ' key "' + key + '" is not in locale/' + locale + '.json')
        } else if (expected !== value) {
          fail('client.js', locale + ' text differs from locale/' + locale + '.json for "' + key + '"')
        }
      }
    }
    for (const key of enKeys.filter((name) => name.startsWith('client.'))) {
      if (!region.includes("'" + key + "'")) warn('client.js', 'client key "' + key + '" is not embedded')
    }
  }
}

/* 4. CJK only in locale files, docs and the marked client catalog. */
const CJK = /[\u3400-\u9fff]/
const DOC_EXT = new Set(['.md'])
for (const file of files) {
  if (!TEXT_EXT.has(extname(file.full))) continue
  if (SKIP_FILES.has(file.rel)) continue
  if (DOC_EXT.has(extname(file.full))) continue
  if (file.rel.startsWith('locale/') && file.rel.endsWith('.json')) continue
  const text = readFileSync(file.full, 'utf8')
  if (!CJK.test(text)) continue
  if (file.rel === 'client.js') {
    const start = text.indexOf('/* i18n-catalog:start')
    const end = text.indexOf('/* i18n-catalog:end')
    const stripped = start >= 0 && end > start ? text.slice(0, start) + text.slice(end) : text
    if (CJK.test(stripped)) fail(file.rel, 'CJK text outside the i18n catalog region')
    continue
  }
  fail(file.rel, 'CJK text found (UI strings belong in locale/*.json)')
}

/* 5. Encoding and whitespace. */
for (const file of source) {
  const text = readFileSync(file.full, 'utf8')
  if (text.charCodeAt(0) === 0xfeff) fail(file.rel, 'UTF-8 BOM')
  if (text.includes('\r')) fail(file.rel, 'CRLF line endings (use LF)')
  if (text.includes('\t')) fail(file.rel, 'tab indentation (use two spaces)')
  if (!text.endsWith('\n')) fail(file.rel, 'missing final newline')
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    if (/[ \t]+$/.test(lines[index])) fail(file.rel + ':' + (index + 1), 'trailing whitespace')
  }
}

/* 6. Web asset manifest. */
const manifestFile = files.find((entry) => entry.rel === 'web/manifest.json')
if (!manifestFile) {
  fail('web/manifest.json', 'missing')
} else {
  try {
    const manifest = JSON.parse(readFileSync(manifestFile.full, 'utf8'))
    const webDir = join(ROOT, 'web')
    for (const asset of [...(manifest.styles || []), ...(manifest.scripts || [])]) {
      try {
        statSync(join(webDir, asset))
      } catch (_) {
        fail('web/manifest.json', 'asset not found: ' + asset)
      }
    }
    const scripts = manifest.scripts || []
    if (scripts[0] !== 'locale.js') fail('web/manifest.json', 'locale.js must load first')
    if (scripts[scripts.length - 1] !== 'app.js') fail('web/manifest.json', 'app.js must load last')
  } catch (error) {
    fail('web/manifest.json', 'invalid JSON (' + error.message + ')')
  }
}

/* Report */
for (const message of warnings) console.warn('warn  ' + message)
for (const message of problems) console.error('error ' + message)
console.log(problems.length
  ? problems.length + ' problem(s), ' + warnings.length + ' warning(s)'
  : 'all checks passed (' + warnings.length + ' warning(s))')
process.exitCode = problems.length ? 1 : 0
