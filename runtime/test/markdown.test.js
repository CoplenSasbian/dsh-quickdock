'use strict';

/**
 * web/markdown.js unit tests.
 *
 * The file is a browser global (no exports), so it runs inside a vm context and
 * renderMarkdown is read back. Two things matter:
 *   1. raw HTML stays text (safety)
 *   2. real Markdown is actually converted
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const FILE = path.join(__dirname, '..', '..', 'web', 'markdown.js');
const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(FILE, 'utf8'), sandbox);
const renderMarkdown = sandbox.renderMarkdown;

const TICK = String.fromCharCode(96);
const FENCE = TICK + TICK + TICK;

test('renderMarkdown is available', () => {
  assert.strictEqual(typeof renderMarkdown, 'function');
});

test('raw HTML stays text and creates no element', () => {
  const html = renderMarkdown('<img src=x onerror=alert(1)> <script>alert(2)</script>');
  assert.ok(!html.includes('<img'), 'no img tag may be emitted: ' + html);
  assert.ok(!html.includes('<script'), 'no script tag may be emitted: ' + html);
  assert.ok(html.includes('&lt;img'), 'must be escaped: ' + html);
});

test('links accept http(s) only and open in a new tab', () => {
  const html = renderMarkdown('[a](https://example.com) [b](javascript:alert(1))');
  assert.ok(html.includes('href="https://example.com" target="_blank"'), html);
  assert.ok(!html.includes('href="javascript'), html);
});

test('headings, lists and inline formatting', () => {
  assert.ok(renderMarkdown('## Title').includes('<h2 class="md-h">Title</h2>'));
  assert.ok(renderMarkdown('- one\n- two').includes('<ul class="md-list"><li class="md-li md-li-0">one</li>'));
  assert.ok(renderMarkdown('1. one\n2. two').includes('<ol class="md-list">'));

  const inline = renderMarkdown('**bold** *italic* ' + TICK + 'code' + TICK);
  assert.ok(inline.includes('<strong>bold</strong>'), inline);
  assert.ok(inline.includes('<em>italic</em>'), inline);
  assert.ok(inline.includes('<code class="md-code">code</code>'), inline);
});

test('fenced code is kept verbatim', () => {
  const source = FENCE + 'js\nconst a = "**x**"\n' + FENCE;
  const html = renderMarkdown(source);
  assert.ok(html.includes('<pre class="md-pre">'), html);
  assert.ok(html.includes('<span class="md-lang">js</span>'), html);
  assert.ok(html.includes('**x**'), 'code content must not become strong: ' + html);
  assert.ok(!html.includes('<strong>'), html);
});

test('tables', () => {
  const html = renderMarkdown('| item | state |\n| --- | --- |\n| title | supported |');
  assert.ok(html.includes('<table class="md-table">'), html);
  assert.ok(html.includes('<th>item</th>'), html);
  assert.ok(html.includes('<td>supported</td>'), html);
});

test('newlines become br, blank lines split paragraphs', () => {
  assert.ok(renderMarkdown('one\ntwo').includes('one<br>two'));
  assert.ok(renderMarkdown('one\n\ntwo').includes('<p class="md-p">one</p><p class="md-p">two</p>'));
});
