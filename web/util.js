/* Shared page helpers: DOM building, text compaction and formatting.
 *
 * Pure functions only. Both dock windows use them; keeping them here is what
 * lets display.js and app.js stay focused on rendering.
 */
(function () {
  'use strict';

  var i18n = window.QD.i18n;

  /** Element by id. */
  function $(id) {
    return document.getElementById(id);
  }

  /** Create an element with an optional class and text. */
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  /** Relative time label for the session header. */
  function relTime(stamp) {
    if (!stamp) return '';
    var delta = Date.now() - stamp;
    if (delta < 60e3) return i18n.t('time.justNow');
    if (delta < 3600e3) return i18n.t('time.minutesAgo', { count: Math.floor(delta / 60e3) });
    if (delta < 86400e3) return i18n.t('time.hoursAgo', { count: Math.floor(delta / 3600e3) });
    return i18n.t('time.daysAgo', { count: Math.floor(delta / 86400e3) });
  }

  /** m:ss / h:mm:ss elapsed label. */
  function formatElapsed(ms) {
    var total = Math.max(0, Math.floor(ms / 1000));
    var minutes = Math.floor(total / 60);
    var seconds = total % 60;
    if (minutes >= 60) {
      var hours = Math.floor(minutes / 60);
      return hours + ':' + String(minutes % 60).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
    }
    return minutes + ':' + String(seconds).padStart(2, '0');
  }

  /** Collapse whitespace and keep only the tail (fixed-height rows). */
  function shortText(text, limit) {
    var value = String(text || '').replace(/\s+/g, ' ').trim();
    if (!value) return '';
    return value.length > limit ? '…' + value.slice(-limit) : value;
  }

  /** Keep the last N path segments so a file name always stays visible. */
  function tailSegments(path, count) {
    var text = String(path || '').trim();
    var parts = text.split(/[\\/]+/).filter(Boolean);
    if (parts.length <= count) return text;
    return '…/' + parts.slice(-count).join('/');
  }

  /** Glyph that expresses the kind of action a tool performs. */
  function toolIcon(tool) {
    var name = String(tool || '').toLowerCase();
    if (!name) return '○';
    if (/image|screenshot|photo|vision/.test(name)) return '▦';
    if (/write|create|save|append|mkdir|touch|delete|remove|move|rename/.test(name)) return '✎';
    if (/edit|replace|patch|update|insert|modify/.test(name)) return '✐';
    if (/read|cat|view|open|load|show/.test(name)) return '▤';
    if (/grep|search|find|query|glob|match/.test(name)) return '⌕';
    if (/list|ls|dir|tree|walk/.test(name)) return '☰';
    if (/command|shell|bash|exec|terminal|run|spawn/.test(name)) return '›';
    if (/web|http|fetch|browser|url/.test(name)) return '⊕';
    if (/todo|plan|task|check/.test(name)) return '☑';
    if (/agent|subagent|delegate|spawn_agent/.test(name)) return '◎';
    return '⚙';
  }

  function stringifyValue(value) {
    try {
      return JSON.stringify(value, null, 2);
    } catch (error) {
      return String(value);
    }
  }

  /** Pretty-print arguments; streaming/truncated JSON is returned verbatim. */
  function prettyArgs(raw) {
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch (error) {
      return raw;
    }
  }

  /**
   * Pick the most useful argument value (command / description / path / query).
   * Streaming arguments may be incomplete, so a regex fallback reads the first
   * known field out of half-written JSON.
   */
  function compactArgs(raw) {
    var text = String(raw || '').trim();
    if (!text) return '';
    var parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      parsed = null;
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      var keys = ['command', 'cmd', 'pattern', 'query', 'url', 'file_path', 'path', 'file',
        'prompt', 'text', 'description'];
      for (var i = 0; i < keys.length; i += 1) {
        var value = parsed[keys[i]];
        if (typeof value === 'string' && value.trim()) return value.trim();
      }
      return text;
    }
    var partial = text.match(/"(command|description|file_path|path|query|pattern|url|text)"\s*:\s*"((?:[^"\\]|\\.)*)"?/);
    if (partial) {
      return partial[2]
        .replace(/\\[nrt]/g, ' ')
        .replace(/\\(["\\/])/g, '$1')
        .replace(/\s+/g, ' ')
        .trim();
    }
    return text;
  }

  /** A tool row subtitle: summary text or a compacted argument. */
  function rowSub(raw) {
    var text = String(raw || '').trim();
    if (!text) return '';
    var head = text.charAt(0);
    return head === '{' || head === '[' ? compactArgs(text) : text;
  }

  /** Near-bottom test used by the auto-scroll logic. */
  function isNearBottom(node, slack) {
    return node.scrollHeight - node.scrollTop - node.clientHeight <= (slack || 24);
  }

  /** Bind a listener only when the element exists. */
  function on(node, event, handler) {
    if (node && node.addEventListener) node.addEventListener(event, handler);
  }

  window.QD.util = {
    $: $,
    el: el,
    relTime: relTime,
    formatElapsed: formatElapsed,
    shortText: shortText,
    tailSegments: tailSegments,
    toolIcon: toolIcon,
    stringifyValue: stringifyValue,
    prettyArgs: prettyArgs,
    compactArgs: compactArgs,
    rowSub: rowSub,
    isNearBottom: isNearBottom,
    on: on
  };
})();
