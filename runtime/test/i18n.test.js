'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { createTranslator, format, loadCatalogs, normalizeLocale, resolveLocale } = require('../i18n');

const LOCALE_DIR = path.join(__dirname, '..', '..', 'locale');

test('normalizeLocale reduces tags to shipped languages', () => {
  assert.strictEqual(normalizeLocale('zh-CN'), 'zh');
  assert.strictEqual(normalizeLocale('EN_us'), 'en');
  assert.strictEqual(normalizeLocale('fr-FR'), '');
  assert.strictEqual(normalizeLocale(undefined), '');
});

test('resolveLocale walks candidates then falls back to English', () => {
  assert.strictEqual(resolveLocale(['auto', 'fr', 'zh-TW']), 'zh');
  assert.strictEqual(resolveLocale([], 'de'), 'en');
  assert.strictEqual(resolveLocale(['en'], 'zh'), 'en');
});

test('format fills placeholders and keeps unknown slots', () => {
  assert.strictEqual(format('{count} done', { count: 3 }), '3 done');
  assert.strictEqual(format('{a}-{b}', { a: 'x' }), 'x-{b}');
});

test('every shipped catalog translates the same key set', () => {
  const catalogs = loadCatalogs(LOCALE_DIR);
  const en = Object.keys(catalogs.en).sort();
  const zh = Object.keys(catalogs.zh).sort();
  assert.ok(en.length > 50, 'English catalog should be populated');
  assert.deepStrictEqual(zh, en);
});

test('translator prefers the active catalog and falls back to English', () => {
  const catalogs = {
    en: { 'a.one': 'one', 'a.two': 'two {n}', 'a.only.en': 'en only' },
    zh: { 'a.one': 'zh-one', 'a.two': 'zh-two {n}' },
  };
  const t = createTranslator({ directory: LOCALE_DIR, locale: 'zh' });
  assert.strictEqual(t.locale, 'zh');

  t.catalogs = catalogs;
  assert.strictEqual(t.t('a.one'), 'zh-one');
  assert.strictEqual(t.t('a.two', { n: 2 }), 'zh-two 2');
  assert.strictEqual(t.t('a.only.en'), 'en only', 'missing Chinese key falls back to English');
  assert.strictEqual(t.t('a.missing'), 'a.missing', 'unknown key is returned verbatim');

  t.setLocale('en');
  assert.strictEqual(t.t('a.one'), 'one');
  assert.strictEqual(t.setLocale('fr'), 'en', 'unsupported tag keeps the current locale');
});

test('catalog() merges English under the active locale', () => {
  const t = createTranslator({ directory: LOCALE_DIR, locale: 'zh' });
  const catalog = t.catalog();
  assert.ok(catalog['host.noSession'], 'English-only keys are still present');
  assert.strictEqual(catalog['status.idle'], t.t('status.idle'));
  assert.notStrictEqual(catalog['status.idle'], 'status.idle', 'the active catalog wins over the key');
});
