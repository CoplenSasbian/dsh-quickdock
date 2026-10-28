'use strict';

/**
 * Locale catalogs and translator, shared by the Host half and the Electron
 * runtime. Catalogs live in locale/<lang>.json as flat dotted keys; values may
 * carry {placeholder} slots. Lookup order is active locale -> English -> key.
 */

const fs = require('node:fs');
const path = require('node:path');

const FALLBACK_LOCALE = 'en';
const SUPPORTED_LOCALES = Object.freeze(['en', 'zh']);
const PLACEHOLDER = /\{(\w+)\}/g;

/**
 * Reduce a BCP 47 tag to a supported language id.
 * @param {unknown} value tag such as 'zh-CN', 'en_US' or 'EN'.
 * @returns {string} supported id, or '' when the language is not shipped.
 */
function normalizeLocale(value) {
  const tag = String(value == null ? '' : value).trim().toLowerCase();
  if (!tag) return '';
  const primary = tag.split(/[-_]/)[0];
  return SUPPORTED_LOCALES.includes(primary) ? primary : '';
}

/**
 * Pick the first supported candidate.
 * @param {unknown[]} values ordered preferences (config value, pushed locale, OS).
 * @param {string} [fallback] last resort language id.
 * @returns {string} a supported locale id.
 */
function resolveLocale(values, fallback) {
  for (const value of values || []) {
    const hit = normalizeLocale(value);
    if (hit) return hit;
  }
  return normalizeLocale(fallback) || FALLBACK_LOCALE;
}

/** Locale reported by the operating system, used when nothing else is known. */
function systemLocale() {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().locale;
  } catch (_) {
    return FALLBACK_LOCALE;
  }
}

/**
 * Read one catalog file. A missing or malformed catalog degrades to an empty
 * object: untranslated keys fall back to English, never to a crash.
 * @param {string} directory locale directory.
 * @param {string} locale normalized language id.
 * @returns {Record<string, string>} flat message map.
 */
function readCatalog(directory, locale) {
  try {
    const file = path.join(directory, locale + '.json');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const catalog = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string') catalog[key] = value;
    }
    return catalog;
  } catch (_) {
    return {};
  }
}

/**
 * Load every shipped catalog.
 * @param {string} directory locale directory.
 * @returns {Record<string, Record<string, string>>} catalogs keyed by locale id.
 */
function loadCatalogs(directory) {
  const catalogs = {};
  for (const locale of SUPPORTED_LOCALES) catalogs[locale] = readCatalog(directory, locale);
  return catalogs;
}

/**
 * Fill {placeholder} slots; unknown slots are left untouched so a missing
 * parameter is visible instead of silently blank.
 * @param {string} template message template.
 * @param {Record<string, unknown>} [params] slot values.
 * @returns {string} formatted message.
 */
function format(template, params) {
  if (!params) return template;
  return String(template).replace(PLACEHOLDER, (match, name) => (
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
  ));
}

/** Immutable-ish translator over one loaded catalog set. */
class Translator {
  /**
   * @param {Record<string, Record<string, string>>} catalogs catalogs by locale.
   * @param {string} [locale] requested locale, unresolved tags allowed.
   */
  constructor(catalogs, locale) {
    this.catalogs = catalogs || {};
    this.locale = resolveLocale([locale], FALLBACK_LOCALE);
  }

  /** Switch the active locale; unknown tags are ignored. */
  setLocale(locale) {
    const next = normalizeLocale(locale);
    if (next) this.locale = next;
    return this.locale;
  }

  /**
   * Active catalog merged over English, ready to inject into a page.
   * @returns {Record<string, string>} flat message map.
   */
  catalog() {
    return Object.assign({}, this.catalogs[FALLBACK_LOCALE] || {}, this.catalogs[this.locale] || {});
  }

  /**
   * Translate one key.
   * @param {string} key dotted message key.
   * @param {Record<string, unknown>} [params] placeholder values.
   * @returns {string} localized message, or the key when missing.
   */
  t(key, params) {
    const name = String(key);
    const active = this.catalogs[this.locale] || {};
    const template = active[name] ?? (this.catalogs[FALLBACK_LOCALE] || {})[name] ?? name;
    return format(template, params);
  }
}

/**
 * Build a translator from catalog files.
 * @param {{directory: string, locale?: string}} options locale directory and preference.
 * @returns {Translator} translator instance.
 */
function createTranslator(options) {
  const opts = options || {};
  return new Translator(loadCatalogs(opts.directory), opts.locale);
}

module.exports = {
  FALLBACK_LOCALE,
  SUPPORTED_LOCALES,
  Translator,
  createTranslator,
  format,
  loadCatalogs,
  normalizeLocale,
  resolveLocale,
  systemLocale
};
