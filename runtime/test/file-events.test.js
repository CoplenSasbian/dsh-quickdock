'use strict';

/**
 * The file-events feed: what DSH's own file tools wrote, for a dock to review.
 *
 * The feed is the review contract's whole point - a build tool's own output never
 * reaches it - so these tests pin the sequence, the ring's bound, the long-poll
 * behaviour and the subscription itself. Nothing here touches a filesystem.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MODULE = pathToFileURL(path.join(__dirname, '..', '..', 'host', 'file-events.js')).href;
const API_MODULE = pathToFileURL(path.join(__dirname, '..', '..', 'host', 'api.js')).href;

let FileEvents;
let createApiRouter;

test.before(async () => {
  ({ FileEvents } = await import(MODULE));
  ({ createApiRouter } = await import(API_MODULE));
});

/** A host context that records listeners, like the Cordis one. */
function fakeContext() {
  const listeners = new Map();
  return {
    listeners,
    on(event, handler) {
      listeners.set(event, handler);
      return () => listeners.delete(event);
    },
    emit(event, ...args) {
      const handler = listeners.get(event);
      if (handler) handler(...args);
    }
  };
}

/** One target/observation pair as the filesystem service reports it. */
const present = { targetKey: 'k', displayPath: 'C:\\work\\proj\\src\\a.ts' };

test('file events: a write is recorded with a sequence and a kind', () => {
  const events = new FileEvents();
  events.observe(present, { kind: 'present', version: 'v1' });
  const answer = events.since(0);
  assert.equal(answer.ok, true);
  assert.equal(answer.seq, 1);
  assert.equal(answer.events.length, 1);
  assert.equal(answer.events[0].seq, 1);
  assert.equal(answer.events[0].path, 'C:\\work\\proj\\src\\a.ts');
  assert.equal(answer.events[0].kind, 'write');
  assert.equal(typeof answer.events[0].at, 'number');
});

test('file events: a delete is recorded, and a target without a path is not', () => {
  const events = new FileEvents();
  events.observe(present, { kind: 'absent' });
  events.observe({ displayPath: '   ' }, { kind: 'present' });
  events.observe(undefined, { kind: 'present' });
  const answer = events.since(0);
  assert.equal(answer.seq, 1);
  assert.deepEqual(answer.events.map((event) => event.kind), ['delete']);
});

test('file events: a cursor returns only what came after it', () => {
  const events = new FileEvents();
  events.record('a', 'write');
  events.record('b', 'write');
  events.record('c', 'delete');
  assert.deepEqual(events.since(1).events.map((event) => event.path), ['b', 'c']);
  assert.deepEqual(events.since(3).events, []);
  // A cursor past the end (a restart) is not a reason to throw.
  assert.deepEqual(events.since(99).events, []);
  assert.equal(events.since(99).seq, 3);
});

test('file events: the ring drops the oldest and says how many were lost', () => {
  const events = new FileEvents({ limit: 2 });
  events.record('a', 'write');
  events.record('b', 'write');
  events.record('c', 'write');
  const answer = events.since(0);
  assert.deepEqual(answer.events.map((event) => event.path), ['b', 'c']);
  assert.equal(answer.dropped, 1);
  // A cursor inside the retained window has lost nothing.
  assert.equal(events.since(1).dropped, 0);
});

test('file events: a poll without news waits, and wakes on the next write', async () => {
  const events = new FileEvents();
  const startedAt = Date.now();
  const pending = events.wait(0, 5000);
  setTimeout(() => events.record('late', 'write'), 30);
  const answer = await pending;
  assert.deepEqual(answer.events.map((event) => event.path), ['late']);
  assert.ok(Date.now() - startedAt < 1000, 'the write must wake the poll, not the timeout');
});

test('file events: a poll with no write answers at the end of its budget', async () => {
  const events = new FileEvents();
  const startedAt = Date.now();
  const answer = await events.wait(0, 40);
  assert.deepEqual(answer.events, []);
  assert.ok(Date.now() - startedAt >= 30, 'the poll must wait out its budget');
});

test('file events: a poll behind the ring answers at once instead of sleeping', async () => {
  const events = new FileEvents({ limit: 1 });
  events.record('a', 'write');
  events.record('b', 'write');
  const startedAt = Date.now();
  const answer = await events.wait(0, 5000);
  assert.equal(answer.dropped, 1);
  assert.ok(Date.now() - startedAt < 1000);
});

test('file events: subscribing follows fs/observed and detaches cleanly', () => {
  const events = new FileEvents();
  const ctx = fakeContext();
  const detach = events.attach(ctx);
  ctx.emit('fs/observed', present, { kind: 'present', version: 'v1' }, {});
  assert.equal(events.since(0).events.length, 1);
  detach();
  assert.equal(ctx.listeners.has('fs/observed'), false);
  // A context without subscriptions must not brake the plugin.
  assert.equal(typeof events.attach(undefined), 'function');
});

test('file events: the dock API route answers with the snapshot', async () => {
  const events = new FileEvents();
  events.record('C:\\work\\proj\\src\\a.ts', 'write');
  const app = {
    fileEventsSince: (since, wait) => events.wait(since, wait),
    t: (key) => key
  };
  const router = createApiRouter({ app, trace: () => {}, logger: null });
  const answer = await new Promise((resolve) => {
    const url = new URL('http://127.0.0.1/quickdock/api/file-events?since=0&wait=0');
    const req = { method: 'GET' };
    const res = {
      writeHead: () => {},
      end: (text) => resolve(JSON.parse(text))
    };
    router.handle(req, res, url);
  });
  assert.equal(answer.ok, true);
  assert.equal(answer.events[0].path, 'C:\\work\\proj\\src\\a.ts');
});
