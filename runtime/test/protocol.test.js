'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { HostProtocol, writeStatus } = require('../protocol');

test('host protocol handles split lines and filters unknown commands', () => {
  const input = new EventEmitter();
  const messages = [];
  const protocol = new HostProtocol(input, (message) => messages.push(message));
  input.emit('data', Buffer.from('log line\nquickdock:{"type":"show"}\nquickdock:{"type":"attach","sessionId":"abc'));
  input.emit('data', Buffer.from('"}\nquickdock:{"type":"evil"}\n'));
  assert.deepEqual(messages, [{ type: 'show' }, { type: 'attach', sessionId: 'abc' }]);
  protocol.dispose();
});

test('status is newline-delimited and tolerates a closed pipe', () => {
  const lines = [];
  const stream = { writable: true, write: (line) => lines.push(line) };
  writeStatus(stream, 'ready', { pid: 42 });
  assert.equal(lines[0], 'quickdock:{"type":"ready","pid":42}\n');
  assert.equal(writeStatus({ destroyed: true }, 'closed'), false);
});
