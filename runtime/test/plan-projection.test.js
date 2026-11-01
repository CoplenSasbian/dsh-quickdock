'use strict';

/**
 * The plan comes from DSH's own projection.
 *
 * dsh-tool-todo registers 'todos' on ctx.sessionProjections: wire value is the
 * whole list or null, and it goes null at every turn/start. The dock used to
 * echo its own fold, so it kept showing a list the main window had dropped.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { config, createContext } = require('./helpers');
const HOST = pathToFileURL(path.join(__dirname, '..', '..', 'host', 'quickdock-host.js')).href;

/** Boot a host with a session whose projection answers the given value. */
async function boot(projectionValue, events) {
  const { QuickDockHost } = await import(HOST);
  const { ctx, services } = createContext();
  services.sessions.get = (id) => ({
    id,
    eventsSnapshot: events || [
      { type: 'turn/start', seq: 1, time: '2026-11-01T00:00:00.000Z', data: { turn: 1 } },
      { type: 'todo/write', seq: 2, data: { todos: [{ content: 'old step', status: 'pending' }] } }
    ]
  });
  if (projectionValue !== 'absent') {
    services.sessionProjections = {
      snapshot: (session, keys) => ({
        values: keys.includes('todos') ? { todos: projectionValue } : {}
      }),
      stateOf: () => undefined
    };
  }
  const app = new QuickDockHost(ctx, config());
  app.start();
  app.postBind({ sessionId: 's-plan' });
  return app;
}

test('plan: the projection wins over the fold', async () => {
  const app = await boot([{ content: 'from projection', status: 'completed' }]);
  const snapshot = app.snapshot();
  assert.deepStrictEqual(snapshot.todos.map((row) => row.content), ['from projection']);
  assert.strictEqual(app.readPlan('s-plan').source, 'projection');
});

test('plan: a cleared projection clears the dock too', async () => {
  const app = await boot(null);
  assert.deepStrictEqual(app.snapshot().todos, [], 'turn/start cleared it in DSH, so here as well');
  assert.deepStrictEqual(app.readPlan('s-plan').todos, []);
});

test('plan: without a projection the fold still answers', async () => {
  const app = await boot('absent');
  const snapshot = app.snapshot();
  assert.deepStrictEqual(snapshot.todos.map((row) => row.content), ['old step']);
});
