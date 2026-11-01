'use strict';

/**
 * History for a session the dock attached to mid-way: its fold has no rows and
 * the turn rows have to come from the session snapshot.
 *
 * The second test covers the long-session case: the fold lists every turn but
 * keeps only its newest `maxSteps` rows, so an older turn is "known" and still
 * has nothing to show. That is what made "load earlier turns" work once and then
 * return empty batches forever.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { config, createContext, invoke, pageUrl } = require('./helpers');
const { StepFolder } = require(path.join(__dirname, '..', 'step-folder.js'));

const HOST = pathToFileURL(path.join(__dirname, '..', '..', 'host', 'quickdock-host.js')).href;

async function tokenOf(fetchRoutes) {
  return new URL(await pageUrl(fetchRoutes)).searchParams.get('t');
}

/** One old turn as DSH stores it: turn start, a tool call and its result. */
const EVENTS = [
  { type: 'turn/start', seq: 1, time: '2026-10-28T10:00:00.000Z', data: { turn: 1 } },
  { type: 'tool/call', seq: 2, data: { callId: 'c1', name: 'read_file', arguments: '{"path":"a"}' } },
  { type: 'tool/result', seq: 3, data: { message: { toolCallId: 'c1', content: [{ type: 'text', text: 'a' }] } } },
  { type: 'turn/end', seq: 4, time: '2026-10-28T10:00:05.000Z', data: { turn: 1 } }
];

/**
 * A session long enough that the fold's retention window drops older rows.
 * @param {number} turns turn count.
 * @param {number} calls tool calls per turn (one row each).
 * @returns {object[]} events, oldest first.
 */
function longSession(turns, calls) {
  const events = [];
  let seq = 0;
  for (let turn = 1; turn <= turns; turn += 1) {
    events.push({ type: 'turn/start', seq: (seq += 1), time: '2026-10-28T10:00:00.000Z', data: { turn } });
    for (let call = 1; call <= calls; call += 1) {
      const callId = 'c' + turn + '-' + call;
      events.push({ type: 'tool/call', seq: (seq += 1), data: { callId, name: 'read_file', arguments: '{"path":"a"}' } });
      events.push({
        type: 'tool/result',
        seq: (seq += 1),
        data: { message: { toolCallId: callId, content: [{ type: 'text', text: 'a' }] } }
      });
    }
    events.push({ type: 'turn/end', seq: (seq += 1), data: { turn } });
  }
  return events;
}

/**
 * Wire a host around one session and return its authenticated GET helper.
 * @param {{id: string, eventsSnapshot: object[], outline?: object[]}} session mock session.
 * @param {object} [options] config overrides, plus `seed(app)` before the requests.
 * @returns {Promise<{get: Function, app: object}>} request helper and the host.
 */
async function harness(session, options) {
  const { QuickDockHost } = await import(HOST);
  const { ctx, routes, fetchRoutes, services } = createContext();
  services.sessions.get = (id) => (id === session.id ? session : undefined);
  services.workspaceRegistry.list = () => [
    { id: 'ws-demo', title: 'Demo', path: 'C:/demo', sessionIds: [session.id] }
  ];
  services.sessionProjections.snapshot = () => ({ values: { turnOutline: session.outline || [] } });
  const app = new QuickDockHost(ctx, config(options));
  app.start();
  app.state.sessionId = session.id;
  app.state.workspaceId = 'ws-demo';
  app.state.newSession = false;
  if (options && typeof options.seed === 'function') options.seed(app);
  const handler = routes.find((route) => route.path === '/quickdock').handler;
  const token = await tokenOf(fetchRoutes);
  const get = async (url) => JSON.parse((await invoke(handler,
    '/quickdock/api/' + url + (url.includes('?') ? '&' : '?') + 't=' + token, {})).body);
  return { app, get };
}

test('turn history: rows come from the snapshot when the fold has never seen the turn', async () => {
  const session = {
    id: 's-old',
    eventsSnapshot: EVENTS,
    outline: [{ turn: 1, seq: 1, prompt: 'old prompt', response: 'old answer' }]
  };
  const { get } = await harness(session);

  const detail = await get('turn?turn=1');
  assert.strictEqual(detail.observed, true, 'a turn from the log is readable');
  assert.deepStrictEqual(detail.steps.map((row) => row.id), ['tool-c1']);

  const turns = await get('turns');
  assert.deepStrictEqual(turns.turns.map((row) => row.turn), [1]);
});

test('turn history: an older turn is rebuilt instead of reading as empty', async () => {
  const events = longSession(12, 6);
  const session = { id: 's-long', eventsSnapshot: events };
  let folder = null;
  const { get } = await harness(session, {
    maxSteps: 20,
    seed: (app) => {
      // What the Host does when it attaches: fold the log once, keeping the
      // newest maxSteps rows. Every turn stays listed.
      folder = new StepFolder(20);
      folder.adoptHistory(events);
      app.state.folders.set('s-long', folder);
    }
  });

  assert.strictEqual(folder.hasTurn(2), true, 'the turn is listed');
  assert.strictEqual(folder.rows(2).length, 0, 'its rows were evicted by the retention window');

  const detail = await get('turn?turn=2');
  assert.strictEqual(detail.observed, true, 'the snapshot still has it');
  assert.deepStrictEqual(
    detail.steps.map((row) => row.id),
    ['tool-c2-1', 'tool-c2-2', 'tool-c2-3', 'tool-c2-4', 'tool-c2-5', 'tool-c2-6']
  );

  // Consecutive batches keep working: the reader can walk all the way back.
  for (const turn of [11, 9, 7, 5, 3, 1]) {
    const older = await get('turn?turn=' + turn);
    assert.strictEqual(older.observed, true, 'turn ' + turn + ' is readable');
    assert.strictEqual(older.steps.length, 6, 'turn ' + turn + ' keeps all its rows');
  }

  // The newest turn still answers from the live fold.
  const newest = await get('turn?turn=12');
  assert.strictEqual(newest.steps.length, 6);
  assert.strictEqual(folder.rows(12).length, 6);
});
