'use strict';

/**
 * Goal + task list: both come from the event feed, not from a host service.
 */

const test = require('node:test');
const assert = require('node:assert');
const { StepFolder } = require('../step-folder.js');

test('goal: captured from a goal tool result', () => {
  const folder = new StepFolder(200);
  folder.apply({ type: 'turn/start', seq: 1, data: { turn: 1 }, time: '2026-11-01T00:00:00Z' });
  folder.apply({ type: 'tool/call', seq: 2, data: { callId: 'g1', name: 'create_goal', arguments: '{"objective":"seed goal"}' } });
  folder.apply({
    type: 'tool/result',
    seq: 3,
    data: {
      message: {
        toolCallId: 'g1',
        content: [{ type: 'text', text: JSON.stringify({ goal: { id: 'goal-1', objective: 'show the goal', phase: 'active' }, activation: 'armed' }) }]
      }
    }
  });
  assert.deepStrictEqual(folder.goal, { objective: 'show the goal', phase: 'active' });
});

test('goal: a cleared goal result removes it', () => {
  const folder = new StepFolder(200);
  folder.goal = { objective: 'old', phase: 'active' };
  folder.apply({ type: 'turn/start', seq: 1, data: { turn: 1 }, time: '2026-11-01T00:00:00Z' });
  folder.apply({ type: 'tool/call', seq: 2, data: { callId: 'g2', name: 'get_goal', arguments: '{}' } });
  folder.apply({
    type: 'tool/result',
    seq: 3,
    data: { message: { toolCallId: 'g2', content: [{ type: 'text', text: '{"goal":null}' }] } }
  });
  assert.strictEqual(folder.goal, null);
});

test('todos: todo/write replaces the list', () => {
  const folder = new StepFolder(200);
  folder.apply({ type: 'turn/start', seq: 1, data: { turn: 1 }, time: '2026-11-01T00:00:00Z' });
  folder.apply({ type: 'todo/write', seq: 2, data: { todos: [{ content: 'a', status: 'pending' }] } });
  folder.apply({ type: 'todo/write', seq: 3, data: { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }] } });
  assert.deepStrictEqual(folder.todos, [
    { content: 'a', status: 'completed' },
    { content: 'b', status: 'in_progress' }
  ]);
});

test('seed: goal and plan come from history', () => {
  const folder = new StepFolder(200);
  const events = [
    { type: 'turn/start', seq: 1, data: { turn: 1 }, time: '2026-11-01T00:00:00Z' },
    { type: 'todo/write', seq: 2, data: { todos: [{ content: 'a', status: 'pending' }, { content: 'b', status: 'completed' }] } },
    { type: 'tool/call', seq: 3, data: { callId: 'g9', name: 'get_goal', arguments: '{}' } },
    { type: 'tool/result', seq: 4, data: { message: { toolCallId: 'g9', content: [{ type: 'text', text: '{"goal":{"objective":"seed goal","phase":"active"}}' }] } } }
  ];
  assert.strictEqual(folder.seedFromHistory(events), true);
  assert.deepStrictEqual(folder.goal, { objective: 'seed goal', phase: 'active' });
  assert.deepStrictEqual(folder.todos.map((row) => row.status), ['pending', 'completed']);
  assert.strictEqual(folder.rows(1).length, 0, 'seeding must not fabricate rows');
});

test('goal: captured from a PTC dispatch (tools run inside run_code)', () => {
  const folder = new StepFolder(200);
  folder.apply({ type: 'turn/start', seq: 1, data: { turn: 1 }, time: '2026-11-01T00:00:00Z' });
  folder.apply({
    type: 'tool/ptc-dispatch',
    seq: 2,
    data: {
      name: 'get_goal',
      subCallId: 'p1',
      content: [{ type: 'text', text: JSON.stringify({ goal: { objective: 'ptc goal', phase: 'active' } }) }]
    }
  });
  assert.deepStrictEqual(folder.goal, { objective: 'ptc goal', phase: 'active' });
});

test('seed: the goal is found when history used a PTC dispatch', () => {
  const folder = new StepFolder(200);
  const events = [
    { type: 'turn/start', seq: 1, data: { turn: 1 }, time: '2026-11-01T00:00:00Z' },
    { type: 'tool/ptc-dispatch', seq: 2, data: { name: 'get_goal', subCallId: 'p2', content: [{ type: 'text', text: '{"goal":{"objective":"history ptc"}}' }] } }
  ];
  folder.seedFromHistory(events);
  assert.strictEqual(folder.goal && folder.goal.objective, 'history ptc');
});
