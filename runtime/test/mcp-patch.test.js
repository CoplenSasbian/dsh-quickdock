'use strict';

/**
 * The loader rows QuickDock maintains.
 *
 * The file belongs to the user and to other managers, so the only acceptable
 * edit is a splice: our two rows change, everything else stays byte-for-byte
 * identical. These tests pin that down, plus the lock and the atomic replace.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MODULE = pathToFileURL(path.join(__dirname, '..', '..', 'host', 'mcp-patch.js')).href;

const HEADER = '# Your patch layer for this dsh profile.\n# A comment that must survive every write.\n';
const USER_ROW = [
  '- id: ui-chat',
  '  name: "@deepseek-ai/dsh-client-ui-chat"',
  '  config:',
  '    transcriptView: standard'
].join('\n') + '\n';

/** A patch with only the header and the empty-array marker. */
function emptyPatch() {
  return HEADER + '[]\n';
}

/** A patch the user already edited. */
function userPatch() {
  return HEADER + USER_ROW;
}

test('patch: inserting into an empty array keeps the header and drops the marker', async () => {
  const { withInsert, validatePatch } = await import(MODULE);
  const text = withInsert(emptyPatch(), { url: 'http://127.0.0.1:47920/mcp', token: 'tok' });
  assert.match(text, /^# Your patch layer/m);
  assert.match(text, /# A comment that must survive every write\./);
  assert.doesNotMatch(text, /^\[\]$/m);
  assert.strictEqual(validatePatch(text).ok, true);
  assert.match(text, /- insert:\n {4}- id: mcp-dsh-vsdock/);
  assert.match(text, /name: "@deepseek-ai\/dsh-mcp-client"/);
  assert.match(text, /url: "http:\/\/127\.0\.0\.1:47920\/mcp"/);
  assert.match(text, /Authorization: "Bearer tok"/);
  assert.match(text, /failOnStartupError: false/);
  assert.match(text, /serverName: "dsh-vsdock"/);
});

test('patch: an existing user row is left byte-for-byte identical', async () => {
  const { withInsert, withToggle } = await import(MODULE);
  let text = withInsert(userPatch(), { url: 'http://127.0.0.1:47920/mcp', token: 'tok' });
  text = withToggle(text, false);
  assert.ok(text.startsWith(HEADER + USER_ROW), 'everything before the insert stays untouched');
  assert.strictEqual(text.match(/- id: mcp-dsh-vsdock/g).length, 2, 'one nested insert id and one toggle id');
  assert.match(text, /- id: mcp-dsh-vsdock\n {2}disabled: false/);
});

test('patch: a changed endpoint replaces the row instead of adding another', async () => {
  const { withInsert } = await import(MODULE);
  const first = withInsert(emptyPatch(), { url: 'http://127.0.0.1:47920/mcp', token: 'one' });
  const second = withInsert(first, { url: 'http://127.0.0.1:47920/mcp', token: 'two' });
  assert.strictEqual(second.match(/- insert:/g).length, 1);
  assert.strictEqual(second.match(/Authorization:/g).length, 1);
  assert.match(second, /Bearer two/);
  assert.doesNotMatch(second, /Bearer one/);
});

test('patch: an unchanged endpoint produces the same text', async () => {
  const { withInsert, withToggle } = await import(MODULE);
  const text = withInsert(emptyPatch(), { url: 'http://127.0.0.1:47920/mcp', token: 'tok' });
  assert.strictEqual(withInsert(text, { url: 'http://127.0.0.1:47920/mcp', token: 'tok' }), text);
  const enabled = withToggle(text, false);
  assert.strictEqual(withToggle(enabled, false), enabled);
  assert.notStrictEqual(withToggle(enabled, true), enabled);
});

test('patch: the toggle row is created once and only its value changes', async () => {
  const { withInsert, withToggle } = await import(MODULE);
  const inserted = withInsert(emptyPatch(), { url: 'http://127.0.0.1:47920/mcp', token: 'tok' });
  const enabled = withToggle(inserted, false);
  const disabled = withToggle(enabled, true);
  assert.strictEqual(disabled.match(/- id: mcp-dsh-vsdock/g).length, 2);
  assert.match(disabled, /- id: mcp-dsh-vsdock\n {2}disabled: true/);
  assert.doesNotMatch(disabled, /disabled: false/);
});

test('patch: nothing is created when the insert row is absent', async () => {
  const { withToggle } = await import(MODULE);
  const text = withToggle(userPatch(), true);
  assert.strictEqual(text, userPatch(), 'a non-live descriptor never conjures a row');
});

test('patch: a shared insert block is never rewritten', async () => {
  const { withInsert, scanPatch } = await import(MODULE);
  const shared = [
    '- insert:',
    '    - id: someone-else',
    '      name: "dsh-other"',
    '    - id: mcp-dsh-vsdock',
    '      name: "@deepseek-ai/dsh-mcp-client"'
  ].join('\n') + '\n';
  const scan = scanPatch(shared);
  assert.strictEqual(scan.insert, null);
  assert.ok(scan.sharedInsert, 'flagged for the caller to leave alone');
  assert.strictEqual(withInsert(shared, { url: 'http://127.0.0.1:47920/mcp', token: 'tok' }), shared);
});

test('patch: CRLF files keep their line endings', async () => {
  const { withInsert } = await import(MODULE);
  const text = (HEADER + '[]\n').replace(/\n/g, '\r\n');
  const next = withInsert(text, { url: 'http://127.0.0.1:47920/mcp', token: 'tok' });
  assert.ok(next.includes('\r\n'));
  assert.doesNotMatch(next.replace(/\r\n/g, ''), /\n/, 'no bare LF crept in');
});

test('patch: a document that is not a top-level array is refused', async () => {
  const { validatePatch } = await import(MODULE);
  assert.strictEqual(validatePatch(emptyPatch()).ok, true);
  assert.strictEqual(validatePatch('  - id: x\n').ok, false);
  assert.strictEqual(validatePatch('id: x\n').ok, false);
});

test('patch: the write is atomic and keeps the last good copy', async () => {
  const { writePatch, readPatch } = await import(MODULE);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-mcp-patch-'));
  const file = path.join(dir, 'cordis.patch.yml');
  fs.writeFileSync(file, emptyPatch());
  const next = emptyPatch() + '- id: mcp-dsh-vsdock\n  disabled: true\n';
  assert.deepStrictEqual(writePatch(file, next), { ok: true, error: '' });
  assert.strictEqual(readPatch(file).text, next);
  assert.strictEqual(fs.readFileSync(file + '.bak', 'utf8'), emptyPatch());
  assert.strictEqual(fs.existsSync(file + '.tmp'), false);
  assert.strictEqual(fs.existsSync(file + '.lock'), false);
});

test('patch: a held lock yields instead of interleaving', async () => {
  const { writePatch } = await import(MODULE);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-mcp-lock-'));
  const file = path.join(dir, 'cordis.patch.yml');
  const text = emptyPatch();
  fs.writeFileSync(file, text);
  fs.writeFileSync(file + '.lock', 'someone');
  const result = writePatch(file, text + '- id: x\n');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error, 'locked');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), text, 'the file is untouched');
});

test('patch: an invalid document never reaches the file', async () => {
  const { writePatch } = await import(MODULE);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-mcp-invalid-'));
  const file = path.join(dir, 'cordis.patch.yml');
  const text = emptyPatch();
  fs.writeFileSync(file, text);
  const result = writePatch(file, 'not: an array\n');
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /refusing to write/);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), text);
});
