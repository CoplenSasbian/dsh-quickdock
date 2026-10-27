'use strict';

/**
 * web/markdown.js 的单元测试。
 *
 * 它是浏览器侧的全局脚本（不 export），所以这里用 vm 在干净上下文里跑一遍，
 * 再把 renderMarkdown 取出来测。重点两条：
 *   1. 任何原始 HTML 都只当文本（安全）
 *   2. 该转的 Markdown 真的转出来了
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

test('renderMarkdown 可用', () => {
  assert.strictEqual(typeof renderMarkdown, 'function');
});

test('原始 HTML 只当文本，不会产生元素', () => {
  const html = renderMarkdown('<img src=x onerror=alert(1)> <script>alert(2)</script>');
  assert.ok(!html.includes('<img'), '不应输出 img 标签: ' + html);
  assert.ok(!html.includes('<script'), '不应输出 script 标签: ' + html);
  assert.ok(html.includes('&lt;img'), '应被转义: ' + html);
});

test('链接只接受 http(s)，且带 target=_blank', () => {
  const html = renderMarkdown('[a](https://example.com) [b](javascript:alert(1))');
  assert.ok(html.includes('href="https://example.com" target="_blank"'), html);
  assert.ok(!html.includes('href="javascript'), html);
});

test('标题 / 列表 / 行内格式', () => {
  assert.ok(renderMarkdown('## 标题').includes('<h2 class="md-h">标题</h2>'));
  assert.ok(renderMarkdown('- 一\n- 二').includes('<ul class="md-list"><li class="md-li md-li-0">一</li>'));
  assert.ok(renderMarkdown('1. 一\n2. 二').includes('<ol class="md-list">'));

  const inline = renderMarkdown('**粗** *斜* ' + TICK + '码' + TICK);
  assert.ok(inline.includes('<strong>粗</strong>'), inline);
  assert.ok(inline.includes('<em>斜</em>'), inline);
  assert.ok(inline.includes('<code class="md-code">码</code>'), inline);
});

test('围栏代码块原样保留，内部不再解析', () => {
  const source = FENCE + 'js\nconst a = "**x**"\n' + FENCE;
  const html = renderMarkdown(source);
  assert.ok(html.includes('<pre class="md-pre">'), html);
  assert.ok(html.includes('<span class="md-lang">js</span>'), html);
  assert.ok(html.includes('**x**'), '代码块内不应被解析成 strong: ' + html);
  assert.ok(!html.includes('<strong>'), html);
});

test('表格', () => {
  const html = renderMarkdown('| 项 | 状态 |\n| --- | --- |\n| 标题 | 支持 |');
  assert.ok(html.includes('<table class="md-table">'), html);
  assert.ok(html.includes('<th>项</th>'), html);
  assert.ok(html.includes('<td>支持</td>'), html);
});

test('换行转成 br，空行分段', () => {
  assert.ok(renderMarkdown('一\n二').includes('一<br>二'));
  assert.ok(renderMarkdown('一\n\n二').includes('<p class="md-p">一</p><p class="md-p">二</p>'));
});
