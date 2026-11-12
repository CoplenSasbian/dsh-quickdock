'use strict';

/**
 * Which dock started the running turn.
 *
 * The binding a DockContext holds says which session a dock shows; attribution
 * has to come from the client that submitted the prompt. These tests pin down
 * the registry (expectation -> claim -> turn lifecycle) and the host wiring that
 * feeds it from the agent loop and the durable session feed.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { config, createContext } = require('./helpers');

const OWNERS = pathToFileURL(path.join(__dirname, '..', '..', 'host', 'turn-owners.js')).href;
const SERVICE = pathToFileURL(path.join(__dirname, '..', '..', 'service.js')).href;

const NOW = Date.parse('2026-11-09T09:00:00.000Z');

/** The scoped agent shape the loop events carry. */
function agent(sessionId) {
  return { id: sessionId, session: { id: sessionId } };
}

/** A durable user message: its source carries the client submission identity. */
function userMessage(requestId) {
  return { source: { kind: 'user', rpcId: requestId } };
}

async function start() {
  const { apply } = await import(SERVICE);
  const { ctx, fetchRoutes, emit } = createContext();
  const app = apply(ctx, config());
  return { app, ctx, fetchRoutes, emit };
}

test('turn owners: the submission identity becomes the turn owner', async () => {
  const { TurnOwners } = await import(OWNERS);
  const owners = new TurnOwners({ now: () => NOW });
  assert.strictEqual(owners.expect({ dockId: 'dock-a', sessionId: 's1', requestId: 'r1' }), true);
  assert.strictEqual(owners.expect({ dockId: '', sessionId: 's1', requestId: 'r1' }), false);
  assert.strictEqual(owners.dockFor('s1', 'r1'), 'dock-a');

  owners.begin('s1', 1);
  assert.strictEqual(owners.ownerOf('s1'), '');
  owners.claim({ sessionId: 's1', turn: 1, requestId: 'r1' });
  assert.strictEqual(owners.ownerOf('s1'), 'dock-a');
  assert.deepStrictEqual(owners.currentOf('s1'), { turn: 1, dockId: 'dock-a', at: NOW });

  owners.end('s1', 1);
  assert.strictEqual(owners.ownerOf('s1'), '');
  assert.strictEqual(owners.lastOf('s1').dockId, 'dock-a');
});

test('turn owners: an unexpected turn has no owner', async () => {
  const { TurnOwners } = await import(OWNERS);
  const owners = new TurnOwners({ now: () => NOW });
  owners.begin('s1', 1);
  owners.claim({ sessionId: 's1', turn: 1, requestId: 'main-window' });
  assert.strictEqual(owners.ownerOf('s1'), '');
});

test('turn owners: steering from another dock does not steal the turn', async () => {
  const { TurnOwners } = await import(OWNERS);
  const owners = new TurnOwners({ now: () => NOW });
  owners.expect({ dockId: 'dock-a', sessionId: 's1', requestId: 'r1' });
  owners.expect({ dockId: 'dock-b', sessionId: 's1', requestId: 'r2' });
  owners.expect({ dockId: 'dock-b', sessionId: 's1', requestId: 'r3' });
  owners.begin('s1', 1);
  owners.claim({ sessionId: 's1', turn: 1, requestId: 'r1' });
  owners.claim({ sessionId: 's1', turn: 1, requestId: 'r2' });
  assert.strictEqual(owners.ownerOf('s1'), 'dock-a', 'the initiator owns the turn');

  // A queued prompt opens its own turn and is attributed to its own dock.
  owners.end('s1', 1);
  owners.begin('s1', 2);
  owners.claim({ sessionId: 's1', turn: 2, requestId: 'r3' });
  assert.strictEqual(owners.ownerOf('s1'), 'dock-b');
});

test('turn owners: a cancelled message drops its expectation', async () => {
  const { TurnOwners } = await import(OWNERS);
  const owners = new TurnOwners({ now: () => NOW });
  owners.expect({ dockId: 'dock-a', sessionId: 's1', requestId: 'r1' });
  owners.forget({ sessionId: 's1', requestId: 'r1' });
  owners.begin('s1', 1);
  owners.claim({ sessionId: 's1', turn: 1, requestId: 'r1' });
  assert.strictEqual(owners.ownerOf('s1'), '');
});

test('turn owners: expectations expire instead of leaking forever', async () => {
  const { TurnOwners } = await import(OWNERS);
  let clock = NOW;
  const owners = new TurnOwners({ now: () => clock, expectationTtlMs: 1000 });
  owners.expect({ dockId: 'dock-a', sessionId: 's1', requestId: 'r1' });
  clock += 500;
  owners.sweep();
  assert.strictEqual(owners.dockFor('s1', 'r1'), 'dock-a');
  clock += 1000;
  owners.sweep();
  assert.strictEqual(owners.dockFor('s1', 'r1'), '');
});

test('host: a claimed prompt attributes the turn and the tool predicate', async () => {
  const { app, emit } = await start();
  assert.deepStrictEqual(
    app.recordDockSubmission({ dockId: 'dock-a', sessionId: 's1', requestId: 'r1' }),
    { ok: true }
  );
  emit('session/event', { id: 's1' }, { type: 'turn/start', data: { turn: 1 } });
  emit('agent/inbox/claimed', { agent: agent('s1'), message: userMessage('r1'), turn: 1 });

  assert.strictEqual(app.turnOwnerOf('s1'), 'dock-a');
  assert.strictEqual(app.toolPredicate('dock-a')({ agent: agent('s1') }), true);
  assert.strictEqual(app.toolPredicate('dock-b')({ agent: agent('s1') }), false);
  assert.strictEqual(app.toolPredicate('dock-a')({ agent: agent('s2') }), false);

  emit('session/event', { id: 's1' }, { type: 'turn/end', data: { turn: 1 } });
  assert.strictEqual(app.turnOwnerOf('s1'), '');
  assert.strictEqual(app.toolPredicate('dock-a')({ agent: agent('s1') }), false);
});

test('host: a prompt from the main window gets no dock tools', async () => {
  const { app, emit } = await start();
  emit('session/event', { id: 's1' }, { type: 'turn/start', data: { turn: 1 } });
  emit('agent/inbox/claimed', { agent: agent('s1'), message: userMessage('elsewhere'), turn: 1 });
  assert.strictEqual(app.turnOwnerOf('s1'), '');
  assert.strictEqual(app.toolPredicate('dock-a')({ agent: agent('s1') }), false);
});

test('host: the durable feed attributes a turn whose claim was missed', async () => {
  const { app, emit } = await start();
  app.recordDockSubmission({ dockId: 'dock-a', sessionId: 's1', requestId: 'r1' });
  emit('session/event', { id: 's1' }, { type: 'turn/start', data: { turn: 1 } });
  emit('session/event', { id: 's1' }, { type: 'user/message', data: { source: { kind: 'user', rpcId: 'r1' } } });
  assert.strictEqual(app.turnOwnerOf('s1'), 'dock-a');
});

test('host: going idle closes the running turn', async () => {
  const { app, emit } = await start();
  app.recordDockSubmission({ dockId: 'dock-a', sessionId: 's1', requestId: 'r1' });
  emit('agent/inbox/claimed', { agent: agent('s1'), message: userMessage('r1'), turn: 1 });
  assert.strictEqual(app.turnOwnerOf('s1'), 'dock-a');
  emit('agent/status', { agent: agent('s1'), status: 'idle' });
  assert.strictEqual(app.turnOwnerOf('s1'), '');
});

test('host: an invalid submission is refused', async () => {
  const { app } = await start();
  assert.strictEqual(app.recordDockSubmission({ dockId: 'dock-a', sessionId: 's1' }).ok, false);
  assert.strictEqual(app.recordDockSubmission({}).ok, false);
  assert.strictEqual(app.recordDockSubmission({ dockId: 'dock-a', sessionId: 's1', requestId: 'r1' }).ok, true);
});

test('host: dock-contexts reports which dock owns the shown session turn', async () => {
  const { app, emit } = await start();
  app.postDockContext({ id: 'dock-a', type: 'browser' });
  app.postBind({ sessionId: 's1' }, 'dock-a');
  app.recordDockSubmission({ dockId: 'dock-a', sessionId: 's1', requestId: 'r1' });
  emit('session/event', { id: 's1' }, { type: 'turn/start', data: { turn: 3 } });
  emit('agent/inbox/claimed', { agent: agent('s1'), message: userMessage('r1'), turn: 3 });

  const info = app.dockContextsInfo();
  const dock = info.docks.find((entry) => entry.id === 'dock-a');
  assert.strictEqual(dock.turn.turn, 3);
  assert.strictEqual(dock.turn.dockId, 'dock-a');
  const turn = app.turnInfo('s1');
  assert.strictEqual(turn.owner, 'dock-a');
  assert.strictEqual(turn.current.turn, 3);
  assert.strictEqual(turn.last.dockId, 'dock-a');
});

test('host: the bridge accepts a dock submission', async () => {
  const { app, fetchRoutes } = await start();
  const route = fetchRoutes.get('/api/quickdock');
  const response = await route.fetch(new Request('http://x/api/quickdock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'dock-submission', dockId: 'dock-a', sessionId: 's1', requestId: 'r1' })
  }));
  const body = await response.json();
  assert.deepStrictEqual(body, { ok: true });
  assert.strictEqual(app.turnOwners.dockFor('s1', 'r1'), 'dock-a');
});
