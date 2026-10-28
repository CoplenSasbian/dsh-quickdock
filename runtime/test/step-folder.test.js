'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { StepFolder, lineDiffStats, parseReadRange } = require('../step-folder.js');

const ev = (type, seq, data, time) => ({ type, seq, data: data || {}, time: time || '' });
const toolCall = (seq, callId, name, args) => ev('tool/call', seq, { callId, name, arguments: args });

test('tool/result flips the row from run to done', () => {
  const folder = new StepFolder(200);
  folder.apply(ev('turn/start', 1));
  folder.apply(toolCall(2, 'c1', 'read_file', '{"path":"a.json","description":"read config"}'));

  const [row] = folder.rows();
  assert.strictEqual(row.id, 'tool-c1');
  assert.strictEqual(row.status, 'run');
  assert.strictEqual(row.description, 'read config');

  folder.apply(ev('tool/result', 3, { message: { toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] } }));
  assert.strictEqual(folder.rows()[0].status, 'done');
});

test('tool rows keep their expand detail, row payload stays lean', () => {
  const folder = new StepFolder(200);
  folder.apply(toolCall(1, 'c9', 'bash', '{"command":"npm test","description":"run tests"}'));

  const detail = folder.detailOf('tool-c9');
  assert.ok(detail, 'detail should exist');
  assert.match(detail.args, /npm test/);
  assert.strictEqual(detail.result, '');

  // Detail never enters the row: every state push carries rows.
  assert.strictEqual(folder.rows()[0].detail, undefined);

  folder.apply(ev('tool/result', 2, {
    message: { toolCallId: 'c9', content: [
      { type: 'text', text: 'first part' },
      { type: 'text', text: 'second part' },
    ] },
  }));
  const after = folder.detailOf('tool-c9');
  assert.strictEqual(after.result, 'first part\nsecond part', 'multiple text blocks are joined');
  assert.strictEqual(folder.detailOf('tool-missing'), null);
});

test('tool/result with isError marks the row failed', () => {
  const folder = new StepFolder(200);
  folder.apply(toolCall(1, 'c2', 'run_command', '{"command":"false"}'));
  folder.apply(ev('tool/result', 2, {
    message: { toolCallId: 'c2', content: [{ type: 'text', text: 'boom', isError: true }] },
  }));
  assert.strictEqual(folder.rows()[0].status, 'fail');
});

test('approval/decided updates the approval row', () => {
  const folder = new StepFolder(200);
  folder.apply(ev('approval/asked', 1, { id: 'a1', toolName: 'write_file', reason: 'write file' }));
  assert.strictEqual(folder.rows()[0].status, 'ask');

  folder.apply(ev('approval/decided', 2, { id: 'a1', outcome: 'allowed-once' }));
  assert.strictEqual(folder.rows()[0].status, 'done');
});

test('rows() returns the latest turn only', () => {
  const folder = new StepFolder(200);
  folder.apply(ev('turn/start', 1));
  folder.apply(toolCall(2, 'x', 'read_file', '{}'));
  assert.deepStrictEqual(folder.rows().map((r) => r.id), ['tool-x']);

  folder.apply(ev('turn/start', 10));
  folder.apply(toolCall(11, 'y', 'read_file', '{}'));
  assert.deepStrictEqual(folder.rows().map((r) => r.id), ['tool-y']);
});

test('turns are retained: an older turn stays readable after the next starts', () => {
  const folder = new StepFolder(200);
  folder.apply(ev('turn/start', 1, { turn: 1 }));
  folder.apply(toolCall(2, 'a', 'read_file', '{}'));
  folder.apply(ev('turn/end', 3, { turn: 1 }, '2026-10-28T10:00:05.000Z'));
  folder.apply(ev('turn/start', 10, { turn: 2 }));
  folder.apply(toolCall(11, 'b', 'bash', '{}'));

  assert.deepStrictEqual(folder.rows().map((r) => r.id), ['tool-b'], 'default stays the newest turn');
  assert.deepStrictEqual(folder.rows(1).map((r) => r.id), ['tool-a'], 'the older turn is still there');
  assert.strictEqual(folder.latestTurn(), 2);
  assert.strictEqual(folder.turnCount, 2);
  assert.deepStrictEqual(folder.turnList().map((t) => t.rows), [1, 1]);
  assert.strictEqual(folder.turnList()[0].endedAt, '2026-10-28T10:00:05.000Z');
});

test('a replayed or stale turn/start does not reopen a turn', () => {
  const folder = new StepFolder(200);
  folder.apply(ev('turn/start', 5, { turn: 3 }));
  folder.apply(toolCall(6, 'a', 'read_file', '{}'));
  folder.apply(ev('turn/start', 5, { turn: 3 }));
  folder.apply(ev('turn/start', 4, { turn: 2 }));

  assert.strictEqual(folder.turnCount, 1);
  assert.strictEqual(folder.latestTurn(), 3);
  assert.deepStrictEqual(folder.rows().map((r) => r.id), ['tool-a']);
});

test('oldest rows are evicted beyond maxSteps', () => {
  const folder = new StepFolder(3);
  for (let i = 1; i <= 6; i++) folder.apply(toolCall(i, 'c' + i, 'read_file', '{}'));
  assert.deepStrictEqual(folder.rows().map((r) => r.id), ['tool-c4', 'tool-c5', 'tool-c6']);
});

test('assistant/message folds into think and say rows', () => {
  const folder = new StepFolder(200);
  folder.apply(ev('turn/start', 1));
  folder.apply(ev('assistant/message', 2, {
    message: { content: [{ type: 'reasoning', text: 'thinking' }, { type: 'text', text: 'answer' }] },
  }));
  assert.deepStrictEqual(folder.rows().map((r) => r.kind), ['think', 'say']);
});

test('blank content produces no row', () => {
  const folder = new StepFolder(200);
  folder.apply(ev('turn/start', 1));
  folder.apply(ev('assistant/message', 2, {
    message: { content: [{ type: 'reasoning', text: '   ' }, { type: 'text', text: '' }] },
  }));
  assert.strictEqual(folder.rows().length, 0);
});

test('invalid JSON arguments are kept verbatim', () => {
  const folder = new StepFolder(200);
  folder.apply(toolCall(1, 'c1', 'run_command', 'not-json'));
  const [row] = folder.rows();
  assert.strictEqual(row.command, 'not-json');
  assert.strictEqual(row.description, '');
});

test('row summary keeps one useful value, never raw JSON', () => {
  const folder = new StepFolder(200);
  folder.apply(toolCall(1, 'a', 'bash', '{"description":"run tests","command":"npm test -- --watch=false"}'));
  folder.apply(toolCall(2, 'b', 'read', '{"file_path":"C:/work/proj/web/app.js","offset":10}'));
  folder.apply(toolCall(3, 'c', 'grep', '{"pattern":"step-json","path":"web"}'));
  folder.apply(toolCall(4, 'd', 'mystery', '{"foo":"bar","n":1}'));
  folder.apply(toolCall(5, 'e', 'bash', '{"description":"description only"}'));
  const [bash, read, grep, mystery, descOnly] = folder.rows();
  assert.strictEqual(bash.command, 'npm test -- --watch=false');
  assert.strictEqual(read.command, '…/proj/web/app.js', 'long paths keep three segments');
  assert.strictEqual(grep.command, 'step-json in web');
  assert.strictEqual(mystery.command, 'foo=bar n=1', 'unknown fields fall back to key=value');
  assert.strictEqual(descOnly.command, '', 'a lone description produces no subtitle');
  for (const row of folder.rows()) assert.ok(!row.command.includes('{"'), 'no JSON blobs may be rendered');
});

test('row summary collapses newlines and truncates', () => {
  const folder = new StepFolder(200);
  folder.apply(toolCall(1, 'a', 'bash', JSON.stringify({ command: 'echo 1\necho 2' })));
  folder.apply(toolCall(2, 'b', 'bash', JSON.stringify({ command: 'x'.repeat(400) })));
  const [one, long] = folder.rows();
  assert.strictEqual(one.command, 'echo 1 echo 2');
  assert.ok(long.command.length <= 140, 'summary is length-capped');
  assert.ok(long.command.endsWith('…'));
});

const say = (seq, text, id) => ev('assistant/message', seq, {
  message: { id, content: [{ type: 'text', text }] },
});

test('a replayed event does not add a second row', () => {
  const folder = new StepFolder(200);
  folder.apply(ev('turn/start', 1));
  folder.apply(say(2, 'Extract the duplicated window config:'));
  folder.apply(say(2, 'Extract the duplicated window config:'));
  assert.strictEqual(folder.rows().length, 1);
});

test('the same content under another seq still merges', () => {
  const folder = new StepFolder(200);
  folder.apply(ev('turn/start', 1));
  folder.apply(say(2, 'Extract the duplicated window config:'));
  folder.apply(say(9, 'Extract the duplicated window config:'));
  assert.strictEqual(folder.rows().length, 1);
});

test('streaming deltas with a message id merge into one row', () => {
  const folder = new StepFolder(200);
  folder.apply(ev('turn/start', 1));
  folder.apply(say(2, 'Extract', 'm1'));
  folder.apply(say(3, 'Extract the duplicated', 'm1'));
  folder.apply(say(4, 'Extract the duplicated window config:', 'm1'));
  const rows = folder.rows();
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].text, 'Extract the duplicated window config:');
});

test('different content stays on separate rows', () => {
  const folder = new StepFolder(200);
  folder.apply(ev('turn/start', 1));
  folder.apply(say(2, 'first sentence'));
  folder.apply(say(3, 'second sentence'));
  assert.strictEqual(folder.rows().length, 2);
});

test('a replayed tool call keeps a single row', () => {
  const folder = new StepFolder(200);
  folder.apply(toolCall(1, 'c1', 'read_file', '{"path":"a"}'));
  folder.apply(toolCall(1, 'c1', 'read_file', '{"path":"a"}'));
  assert.strictEqual(folder.rows().length, 1);
});

test('line diff counts added and removed lines', () => {
  assert.deepStrictEqual(lineDiffStats('a\nb\nc', 'a\nB\nc\nd'), [2, 1], 'one changed, one added');
  assert.deepStrictEqual(lineDiffStats('', 'a\nb'), [2, 0], 'pure addition');
  assert.deepStrictEqual(lineDiffStats('a\nb', ''), [0, 2], 'pure removal');
  assert.deepStrictEqual(lineDiffStats('a\nb', 'a\nb'), [0, 0], 'unchanged');
});

test('read range is parsed from the result footer', () => {
  assert.deepStrictEqual(parseReadRange('(Showing lines 10-29 of 100. Use offset=30 to continue.)', 10), [10, 29]);
  assert.deepStrictEqual(parseReadRange('(Output capped. Showing lines 1-500. Use offset=501 to continue.)', 1), [1, 500]);
  assert.deepStrictEqual(parseReadRange('(End of file - total 14 lines)', 10), [10, 14], 'EOF starts at the requested offset');
  assert.strictEqual(parseReadRange('output without a footer', 1), null);
});

test('tool rows carry line metadata: edit delta, read range', () => {
  const folder = new StepFolder(200);
  folder.apply(toolCall(1, 'e1', 'edit', JSON.stringify({
    file_path: 'a.js', old_string: 'a\nb\nc', new_string: 'a\nB\nc\nd',
  })));
  folder.apply(toolCall(2, 'r1', 'read', JSON.stringify({ file_path: 'a.js', offset: 10, limit: 20 })));
  folder.apply(ev('tool/result', 3, {
    message: { toolCallId: 'r1', content: [{ type: 'text', text: '10: x\n\n(Showing lines 10-13 of 100. Use offset=14 to continue.)' }] },
  }));
  const [editRow, readRow] = folder.rows();
  assert.deepStrictEqual(editRow.delta, [2, 1]);
  assert.deepStrictEqual(readRow.lines, [10, 13]);
  assert.deepStrictEqual(readRow.delta, undefined, 'read rows have no delta');
});

test('edit meta.diffs overrides the argument estimate', () => {
  const folder = new StepFolder(200);
  folder.apply(toolCall(1, 'e1', 'edit', JSON.stringify({
    file_path: 'a.js', old_string: 'a', new_string: 'a\nb',
  })));
  assert.deepStrictEqual(folder.rows()[0].delta, [1, 0], 'arguments provide the first estimate');
  folder.apply(ev('tool/result', 2, {
    meta: { diffs: [{ path: 'a.js', oldText: 'a\nc', newText: 'a\nB\nD' }] },
    message: { toolCallId: 'e1', content: [{ type: 'text', text: 'ok' }] },
  }));
  assert.deepStrictEqual(folder.rows()[0].delta, [2, 1], 'real hunks from the whole file');
});
