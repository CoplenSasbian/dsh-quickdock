'use strict';

/**
 * History for a session the dock attached to mid-way: its fold has no rows and
 * the turn rows have to come from the session snapshot.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { config, createContext, invoke, pageUrl } = require('./helpers');

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

test('turn history: rows come from the snapshot when the fold has never seen the turn', async () => {
  const { QuickDockHost } = await import(HOST);
  const { ctx, routes, fetchRoutes, services } = createContext();
  // The session exists and carries its events, but the dock has no folder for it.
  services.sessions.get = (id) => (id === 's-old' ? { id: 's-old', eventsSnapshot: EVENTS } : undefined);
  services.workspaceRegistry.list = () => [
    { id: 'ws-demo', title: 'Demo', path: 'C:/demo', sessionIds: ['s-old'] }
  ];
  services.sessionProjections.snapshot = () => ({
    values: { turnOutline: [{ turn: 1, seq: 1, prompt: 'old prompt', response: 'old answer' }] }
  });

  const app = new QuickDockHost(ctx, config());
  app.start();
  app.state.sessionId = 's-old';
  app.state.workspaceId = 'ws-demo';
  app.state.newSession = false;

  const handler = routes.find((route) => route.path === '/quickdock').handler;
  const token = await tokenOf(fetchRoutes);
  const get = async (url) => JSON.parse((await invoke(handler,
    '/quickdock/api/' + url + (url.includes('?') ? '&' : '?') + 't=' + token, {})).body);

  const detail = await get('turn?turn=1');
  assert.strictEqual(detail.observed, true, 'a turn from the log is readable');
  assert.deepStrictEqual(detail.steps.map((row) => row.id), ['tool-c1']);

  const turns = await get('turns');
  assert.deepStrictEqual(turns.turns.map((row) => row.turn), [1]);
});
