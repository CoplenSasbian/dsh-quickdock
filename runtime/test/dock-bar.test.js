'use strict';

/**
 * The dock bar's two client-owned controls.
 *
 * An IDE dock runs the editor-tools server itself, so the shell only hosts its
 * switch; and because those tools are registered per directory, a session that
 * works somewhere else gets a warning icon instead of silently having no tools.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { config, createContext, invoke } = require('./helpers');

const SERVICE = pathToFileURL(path.join(__dirname, '..', '..', 'service.js')).href;

/** Apply the service entry and return the host plus a JSON caller. */
async function start(overrides) {
  const { apply } = await import(SERVICE);
  const { ctx, services } = createContext();
  const app = apply(ctx, config(overrides));
  const call = (url, body, method) => invoke(
    (req, res) => app.handleHttp(req, res),
    url,
    {},
    body === undefined ? undefined : JSON.stringify(body),
    method
  );
  return { app, services, call, json: (result) => JSON.parse(result.body) };
}

test('bar: the editor-tools toggle only appears when the client asks for it', async () => {
  const { call } = await start();
  const plain = await call('/quickdock?view=vscode');
  assert.match(plain.body, /data-action="mcp" title="Editor tools" hidden>/, 'no toggle for a client that runs no server');

  const asked = await call('/quickdock?view=vscode&mcp=1');
  assert.match(asked.body, /data-action="mcp" title="Editor tools">/);
  assert.match(asked.body, /data-warn="workspace"/, 'the mismatch icon is part of the bar');
  assert.match(asked.body, /quickdock:mcp-toggle/);
  assert.match(asked.body, /quickdock:mcp-state/);
});

test('bar: the desktop window never gets the editor-tools toggle', async () => {
  const { call } = await start();
  const page = await call('/quickdock?view=electron&mcp=1');
  // The window has no embedding client; the toggle belongs to an IDE dock only.
  assert.match(page.body, /data-action="mcp" title="Editor tools" hidden>/);
  assert.match(page.body, /data-action="mcp-info"[^>]*hidden>/, 'and no tool panel button either');
});

test('bar: an editor dock gets the button that opens the tool panel', async () => {
  const { call } = await start();
  const page = await call('/quickdock?view=vscode&mcp=1');
  assert.match(page.body, /data-action="mcp-info" title="Editor tools connected to this dock">/);
  assert.match(page.body, /data-panel="mcp" hidden>/, 'the panel starts closed');
  assert.match(page.body, /quickdock\/api\/mcp-servers/, 'and reads the published servers');
});

test('workspace: dock-target compares the shown session with the dock’s folder', async () => {
  const { app, services, call, json } = await start();
  services.workspaceRegistry.list = () => [
    { id: 'w-1', title: 'proj', path: 'C:\\Work\\Proj', sessionIds: ['s-1'] },
    { id: 'w-2', title: 'other', path: 'D:\\Elsewhere', sessionIds: ['s-2'] }
  ];
  app.postDockContext({ id: 'vscode-1', type: 'vscode', workspace: { path: 'C:\\work\\proj', paths: ['C:\\work\\proj'] } });
  app.postBind({ sessionId: 's-1' }, 'vscode-1');

  const inside = json(await call('/quickdock/api/dock-target?dock=vscode-1'));
  assert.deepStrictEqual(inside.workspace, {
    dock: 'C:\\work\\proj',
    session: 'C:\\Work\\Proj',
    matches: true
  });

  app.postBind({ sessionId: 's-2' }, 'vscode-1');
  const outside = json(await call('/quickdock/api/dock-target?dock=vscode-1'));
  assert.strictEqual(outside.workspace.matches, false, 'a session in another workspace is flagged');
  assert.strictEqual(outside.workspace.session, 'D:\\Elsewhere');
});

test('workspace: a session nobody knows is “cannot tell”, not a mismatch', async () => {
  const { app, call, json } = await start();
  app.postDockContext({ id: 'vscode-1', type: 'vscode', workspace: { path: 'C:\\work' } });
  app.postBind({ sessionId: 's-unknown' }, 'vscode-1');
  const target = json(await call('/quickdock/api/dock-target?dock=vscode-1'));
  assert.deepStrictEqual(target.workspace, { dock: 'C:\\work', session: null, matches: null });
});
