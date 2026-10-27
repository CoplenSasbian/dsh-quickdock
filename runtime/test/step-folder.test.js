'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { StepFolder } = require('../step-folder.js');

const ev = (type, seq, data, time) => ({ type, seq, data: data || {}, time: time || '' });
const toolCall = (seq, callId, name, args) => ev('tool/call', seq, { callId, name, arguments: args });

test('tool/result 把对应行从 run 改成 done', () => {
  const folder = new StepFolder(200);
  folder.apply(ev('turn/start', 1));
  folder.apply(toolCall(2, 'c1', 'read_file', '{"path":"a.json","description":"读配置"}'));

  const [row] = folder.rows();
  assert.strictEqual(row.id, 'tool-c1');
  assert.strictEqual(row.status, 'run');
  assert.strictEqual(row.description, '读配置');

  folder.apply(ev('tool/result', 3, { message: { toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] } }));
  assert.strictEqual(folder.rows()[0].status, 'done');
});

test('tool/result 带 isError 时判为 fail', () => {
  const folder = new StepFolder(200);
  folder.apply(toolCall(1, 'c2', 'run_command', '{"command":"false"}'));
  folder.apply(ev('tool/result', 2, {
    message: { toolCallId: 'c2', content: [{ type: 'text', text: 'boom', isError: true }] },
  }));
  assert.strictEqual(folder.rows()[0].status, 'fail');
});

test('approval/decided 回填审批行状态', () => {
  const folder = new StepFolder(200);
  folder.apply(ev('approval/asked', 1, { id: 'a1', toolName: 'write_file', reason: '写文件' }));
  assert.strictEqual(folder.rows()[0].status, 'ask');

  folder.apply(ev('approval/decided', 2, { id: 'a1', outcome: 'allowed-once' }));
  assert.strictEqual(folder.rows()[0].status, 'done');
});

test('rows() 只返回最新一轮', () => {
  const folder = new StepFolder(200);
  folder.apply(ev('turn/start', 1));
  folder.apply(toolCall(2, 'x', 'read_file', '{}'));
  assert.deepStrictEqual(folder.rows().map((r) => r.id), ['tool-x']);

  folder.apply(ev('turn/start', 10));
  folder.apply(toolCall(11, 'y', 'read_file', '{}'));
  assert.deepStrictEqual(folder.rows().map((r) => r.id), ['tool-y']);
});

test('超过 maxSteps 时淘汰最旧的行', () => {
  const folder = new StepFolder(3);
  for (let i = 1; i <= 6; i++) folder.apply(toolCall(i, 'c' + i, 'read_file', '{}'));
  assert.deepStrictEqual(folder.rows().map((r) => r.id), ['tool-c4', 'tool-c5', 'tool-c6']);
});

test('assistant/message 折成 think 与 say 两种行', () => {
  const folder = new StepFolder(200);
  folder.apply(ev('turn/start', 1));
  folder.apply(ev('assistant/message', 2, {
    message: { content: [{ type: 'reasoning', text: '想一想' }, { type: 'text', text: '答复' }] },
  }));
  assert.deepStrictEqual(folder.rows().map((r) => r.kind), ['think', 'say']);
});

test('空白内容不产生行', () => {
  const folder = new StepFolder(200);
  folder.apply(ev('turn/start', 1));
  folder.apply(ev('assistant/message', 2, {
    message: { content: [{ type: 'reasoning', text: '   ' }, { type: 'text', text: '' }] },
  }));
  assert.strictEqual(folder.rows().length, 0);
});

test('参数不是合法 JSON 时保留原文', () => {
  const folder = new StepFolder(200);
  folder.apply(toolCall(1, 'c1', 'run_command', 'not-json'));
  const [row] = folder.rows();
  assert.strictEqual(row.command, 'not-json');
  assert.strictEqual(row.description, '');
});

const say = (seq, text, id) => ev('assistant/message', seq, {
  message: { id, content: [{ type: 'text', text }] },
});

test('同一事件重复投递不产生第二行', () => {
  const folder = new StepFolder(200);
  folder.apply(ev('turn/start', 1));
  folder.apply(say(2, '提取两个窗口的重复配置：'));
  folder.apply(say(2, '提取两个窗口的重复配置：'));
  assert.strictEqual(folder.rows().length, 1);
});

test('相同内容换一个 seq 再来也不产生第二行', () => {
  const folder = new StepFolder(200);
  folder.apply(ev('turn/start', 1));
  folder.apply(say(2, '提取两个窗口的重复配置：'));
  folder.apply(say(9, '提取两个窗口的重复配置：'));
  assert.strictEqual(folder.rows().length, 1);
});

test('带消息 id 的流式增量合并成一行并保留最新文本', () => {
  const folder = new StepFolder(200);
  folder.apply(ev('turn/start', 1));
  folder.apply(say(2, '提取', 'm1'));
  folder.apply(say(3, '提取两个窗口', 'm1'));
  folder.apply(say(4, '提取两个窗口的重复配置：', 'm1'));
  const rows = folder.rows();
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].text, '提取两个窗口的重复配置：');
});

test('不同内容仍然是分开的两行', () => {
  const folder = new StepFolder(200);
  folder.apply(ev('turn/start', 1));
  folder.apply(say(2, '第一句'));
  folder.apply(say(3, '第二句'));
  assert.strictEqual(folder.rows().length, 2);
});

test('同一个工具调用重复投递只保留一行', () => {
  const folder = new StepFolder(200);
  folder.apply(toolCall(1, 'c1', 'read_file', '{"path":"a"}'));
  folder.apply(toolCall(1, 'c1', 'read_file', '{"path":"a"}'));
  assert.strictEqual(folder.rows().length, 1);
});
