'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { EventLog, eventMatcher } = require('../../host/event-log.js');

const ev = (seq, type, data) => ({ type, seq, time: 1000 + seq, data: data || {} });

test('every event type is retained verbatim', () => {
  const log = new EventLog();
  log.append('s1', ev(1, 'step/start', { turn: 1, step: 1 }));
  log.append('s1', ev(2, 'tool/ptc-dispatch', { subCallId: 'a:ptc:1' }));
  log.append('s1', ev(3, 'todo/write', { todos: [] }));
  const result = log.list('s1');
  assert.deepStrictEqual(result.events.map((row) => row.type), ['step/start', 'tool/ptc-dispatch', 'todo/write']);
  assert.deepStrictEqual(result.events[1].data, { subCallId: 'a:ptc:1' });
  assert.strictEqual(result.latestSeq, 3);
});

test('reading after a sequence number resumes where the client stopped', () => {
  const log = new EventLog();
  for (let seq = 1; seq <= 5; seq += 1) log.append('s1', ev(seq, 'assistant/message'));
  const result = log.list('s1', { from: 2, limit: 2 });
  assert.deepStrictEqual(result.events.map((row) => row.seq), [3, 4]);
});

test('the type filter keeps the client-side policy out of the Host', () => {
  const log = new EventLog();
  log.append('s1', ev(1, 'tool/call'));
  log.append('s1', ev(2, 'tool/result'));
  log.append('s1', ev(3, 'assistant/message'));
  log.append('s1', ev(4, 'todo/write'));
  assert.deepStrictEqual(log.list('s1', { type: 'tool/*' }).events.map((r) => r.seq), [1, 2]);
  assert.deepStrictEqual(log.list('s1', { type: 'todo/write,assistant/message' }).events.map((r) => r.seq), [3, 4]);
  assert.strictEqual(log.list('s1', { type: '*' }).events.length, 4);
  assert.strictEqual(eventMatcher(''), null);
});

test('the log is bounded by count and reports what it dropped', () => {
  const log = new EventLog({ maxEvents: 3 });
  for (let seq = 1; seq <= 5; seq += 1) log.append('s1', ev(seq, 'step/start'));
  const result = log.list('s1');
  assert.deepStrictEqual(result.events.map((row) => row.seq), [3, 4, 5]);
  assert.strictEqual(result.dropped, 2);
  assert.strictEqual(result.retained, 3);
});

test('the oldest session is evicted, and forget drops one log', () => {
  const log = new EventLog({ maxSessions: 2 });
  log.append('s1', ev(1, 'turn/start'));
  log.append('s2', ev(1, 'turn/start'));
  log.list('s1');
  log.append('s3', ev(1, 'turn/start'));
  assert.deepStrictEqual(log.list('s2').events, [], 'least recently used session is gone');
  assert.strictEqual(log.list('s1').events.length, 1);
  log.forget('s1');
  assert.strictEqual(log.list('s1').events.length, 0);
});
