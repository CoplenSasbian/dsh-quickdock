/* Page i18n runtime.
 *
 * The Host injects window.__QD_I18N__ = { locale, messages } with the active
 * catalog merged over English, so a missing translation never prints a key.
 * Static markup carries data-i18n* attributes; dynamic strings call t().
 */
(function () {
  'use strict';

  var payload = window.__QD_I18N__ || { locale: 'en', messages: {} };
  var messages = payload.messages && typeof payload.messages === 'object' ? payload.messages : {};

  function has(value) {
    return Object.prototype.hasOwnProperty.call(messages, value);
  }

  /**
   * Translate a key, filling {name} placeholders.
   * @param {string} key dotted message key.
   * @param {object} [params] placeholder values.
   * @returns {string} message, or the key when unknown.
   */
  function t(key, params) {
    var template = has(key) ? messages[key] : key;
    if (!params) return template;
    return String(template).replace(/\{(\w+)\}/g, function (match, name) {
      return Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match;
    });
  }

  /** Replace every translated attribute/text under a root element. */
  function apply(root) {
    var scope = root || document;
    var nodes = scope.querySelectorAll('[data-i18n]');
    for (var i = 0; i < nodes.length; i += 1) {
      nodes[i].textContent = t(nodes[i].getAttribute('data-i18n'));
    }
    var titled = scope.querySelectorAll('[data-i18n-title]');
    for (var j = 0; j < titled.length; j += 1) {
      titled[j].setAttribute('title', t(titled[j].getAttribute('data-i18n-title')));
    }
    var labelled = scope.querySelectorAll('[data-i18n-aria-label]');
    for (var k = 0; k < labelled.length; k += 1) {
      labelled[k].setAttribute('aria-label', t(labelled[k].getAttribute('data-i18n-aria-label')));
    }
    var placeholders = scope.querySelectorAll('[data-i18n-placeholder]');
    for (var m = 0; m < placeholders.length; m += 1) {
      placeholders[m].setAttribute('placeholder', t(placeholders[m].getAttribute('data-i18n-placeholder')));
    }
  }

  /** Adopt a new payload (locale changed live over SSE). */
  function setPayload(next) {
    if (!next || typeof next !== 'object' || !next.messages) return false;
    payload = next;
    messages = next.messages;
    document.documentElement.lang = next.locale === 'zh' ? 'zh-CN' : 'en';
    apply(document);
    return true;
  }

  function locale() {
    return payload.locale || 'en';
  }

  window.QD = window.QD || {};
  window.QD.i18n = { t: t, apply: apply, setPayload: setPayload, locale: locale };

  // Static labels are translated before app.js renders anything dynamic.
  apply(document);
})();
