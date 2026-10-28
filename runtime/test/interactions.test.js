'use strict';

/**
 * Interaction broker: when the dock can no longer answer, a pending approval
 * must be handed back to DSH instead of waiting for the timeout, otherwise the
 * user has no dialog left anywhere to allow the call.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MODULE = pathToFileURL(path.join(__dirname, '..', '..', 'host', 'interactions.js')).href;

async function createBroker() {
  const { InteractionBroker } = await import(MODULE);
  const state = { interaction: null };
  let publishes = 0;
  const broker = new InteractionBroker({
    state,
    timeoutMs: 600000,
    publish: () => { publishes += 1; },
    summon: () => {},
    trace: () => {}
  });
  return { broker, state, publishes: () => publishes };
}

test('reset hands a pending approval back to DSH', async () => {
  const { DELEGATE } = await import(MODULE);
  const { broker, state } = await createBroker();
  const pending = broker.ask({ kind: 'approval', toolName: 'bash', reason: 'escalate sandbox' });
  assert.strictEqual(state.interaction.kind, 'approval');

  broker.reset();
  assert.strictEqual(await pending, DELEGATE, 'the listener must call next()');
  assert.strictEqual(state.interaction, null, 'the stale card is cleared');
});

test('reset without a pending request is a no-op', async () => {
  const { broker, state } = await createBroker();
  broker.reset();
  assert.strictEqual(state.interaction, null);
});

test('an answer still resolves the pending approval', async () => {
  const { broker, state } = await createBroker();
  const pending = broker.ask({ kind: 'approval', toolName: 'bash', reason: 'x' });
  const accepted = broker.answer({ id: state.interaction.id, outcome: 'allow' });
  assert.strictEqual(accepted, true);
  assert.strictEqual(await pending, true);
  assert.strictEqual(state.interaction, null);
});
