/* eslint-disable */
/**
 * 极简 Markdown 渲染（正文用）。
 *
 * 硬规矩：**先整体转义，再按规则拼 HTML**。模型输出里的任何
 * script 标签、img onerror 之类的写法，都只会变成可见文本，不存在注入面。
 *
 * 支持：围栏代码块、标题、分隔线、引用、有序/无序列表（含缩进）、表格、
 *      行内代码、粗体、斜体、删除线、链接。
 * 流式过程不用它 —— 半截的代码围栏或不闭合的 ** 渲染出来只会更乱。
 */

var MD_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

function mdEscape(text) {
  return String(text == null ? '' : text).replace(/[&<>"]/g, function (ch) { return MD_ESCAPES[ch]; });
}

function mdInline(escaped) {
  // 先把行内代码抠出来，免得里面的 * _ 被当成强调
  var codes = [];
  var text = escaped.replace(/`([^`\n]+)`/g, function (_, code) {
    codes.push(code);
    return '\u0000' + (codes.length - 1) + '\u0000';
  });

  text = text
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)\u0000]+[^\s<.,;:!?)\u0000])/g,
      '$1<a href="$2" target="_blank" rel="noreferrer noopener">$2</a>');

  return text.replace(/\u0000(\d+)\u0000/g, function (_, index) {
    return '<code class="md-code">' + codes[Number(index)] + '</code>';
  });
}

function mdIsBlockStart(line) {
  return /^\s*(```|~~~)/.test(line)
    || /^#{1,6}\s+/.test(line)
    || /^\s*>/.test(line)
    || /^\s*([-*+]|\d+[.)])\s+/.test(line)
    || /^\s*(---+|\*\*\*+|___+)\s*$/.test(line)
    || /^\s*\|/.test(line);
}

function mdSplitRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(function (cell) {
    return cell.trim();
  });
}

function mdTable(lines, start) {
  var header = mdSplitRow(lines[start]);
  var index = start + 2;
  var rows = [];
  while (index < lines.length && /^\s*\|/.test(lines[index])) {
    rows.push(mdSplitRow(lines[index]));
    index += 1;
  }
  var html = '<table class="md-table"><thead><tr>';
  header.forEach(function (cell) { html += '<th>' + mdInline(mdEscape(cell)) + '</th>'; });
  html += '</tr></thead><tbody>';
  rows.forEach(function (row) {
    html += '<tr>';
    header.forEach(function (_, column) {
      html += '<td>' + mdInline(mdEscape(row[column] || '')) + '</td>';
    });
    html += '</tr>';
  });
  return { html: html + '</tbody></table>', next: index };
}

function mdList(lines, start) {
  var baseIndent = -1;
  var ordered = false;
  var items = [];
  var index = start;
  while (index < lines.length) {
    var match = lines[index].match(/^([ \t]*)([-*+]|\d+[.)])\s+(.*)$/);
    if (!match) break;
    var indent = match[1].replace(/\t/g, '  ').length;
    if (baseIndent < 0) {
      baseIndent = indent;
      ordered = /^\d/.test(match[2]);
    }
    if (indent < baseIndent) break;
    items.push({ indent: indent, text: match[3] });
    index += 1;
  }
  var tag = ordered ? 'ol' : 'ul';
  var html = '<' + tag + ' class="md-list">';
  items.forEach(function (item) {
    // 缩进只做视觉层级：两级够用，嵌套 <ul> 反而容易把布局搞乱
    var depth = Math.min(2, Math.floor((item.indent - baseIndent) / 2));
    html += '<li class="md-li md-li-' + depth + '">' + mdInline(mdEscape(item.text)) + '</li>';
  });
  return { html: html + '</' + tag + '>', next: index };
}

function renderMarkdown(source) {
  var lines = String(source == null ? '' : source).replace(/\r\n?/g, '\n').split('\n');
  var out = [];
  var index = 0;

  while (index < lines.length) {
    var line = lines[index];

    // 围栏代码块
    var fence = line.match(/^\s*(```+|~~~+)\s*([\w+#.-]*)\s*$/);
    if (fence) {
      var marker = fence[1].charAt(0);
      var language = fence[2];
      var buffer = [];
      index += 1;
      var closing = new RegExp('^\\s*' + marker + '{3,}\\s*$');
      while (index < lines.length && !closing.test(lines[index])) {
        buffer.push(lines[index]);
        index += 1;
      }
      index += 1;
      out.push('<pre class="md-pre">'
        + (language ? '<span class="md-lang">' + mdEscape(language) + '</span>' : '')
        + '<code>' + mdEscape(buffer.join('\n')) + '</code></pre>');
      continue;
    }

    if (!line.trim()) { index += 1; continue; }

    var heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      var level = heading[1].length;
      out.push('<h' + level + ' class="md-h">' + mdInline(mdEscape(heading[2].trim())) + '</h' + level + '>');
      index += 1;
      continue;
    }

    if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) {
      out.push('<hr class="md-hr">');
      index += 1;
      continue;
    }

    if (/^\s*>/.test(line)) {
      var quote = [];
      while (index < lines.length && /^\s*>/.test(lines[index])) {
        quote.push(lines[index].replace(/^\s*>\s?/, ''));
        index += 1;
      }
      out.push('<blockquote class="md-quote">'
        + mdInline(mdEscape(quote.join('\n')).replace(/\n/g, '<br>')) + '</blockquote>');
      continue;
    }

    if (/^\s*\|/.test(line) && index + 1 < lines.length
      && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(lines[index + 1])) {
      var table = mdTable(lines, index);
      out.push(table.html);
      index = table.next;
      continue;
    }

    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      var list = mdList(lines, index);
      out.push(list.html);
      index = list.next;
      continue;
    }

    var paragraph = [];
    while (index < lines.length && lines[index].trim()
      && !(paragraph.length && mdIsBlockStart(lines[index]))) {
      paragraph.push(lines[index]);
      index += 1;
    }
    out.push('<p class="md-p">'
      + mdInline(mdEscape(paragraph.join('\n')).replace(/\n/g, '<br>')) + '</p>');
  }

  return out.join('');
}