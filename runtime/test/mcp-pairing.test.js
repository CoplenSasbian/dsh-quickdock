'use strict';

/**
 * MCP pairing: the state machine from MCP-PAIRING.md.
 *
 * The controller reads a descriptor, asks a probe and writes at most one spliced
 * document per change. Clock, pid probe, health probe and the loader surface are
 * all injectable, so every transition is exercised without an editor or DSH.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { config, createContext } = require('./helpers');

const MODULE = pathToFileURL(path.join(__dirname, '..', '..', 'host', 'mcp-pairing.js')).href;
const SERVICE = pathToFileURL(path.join(__dirname, '..', '..', 'service.js')).href;

const NOW = Date.parse('2026-11-08T13:58:15.000Z');

/** A live descriptor, evaluated at NOW by the injected probes. */
function descriptor(overrides) {
  return Object.assign({
    apiVersion: 1,
    kind: 'dsh-vscode-mcp',
    extension: { id: 'dsh.dsh-vsdock', version: '0.3.0' },
    editor: { name: 'Visual Studio Code', version: '1.145.0' },
    url: 'http://127.0.0.1:47920/mcp',
    healthUrl: 'http://127.0.0.1:47920/health',
    token: 'tok',
    pid: 4321,
    heartbeatAt: new Date(NOW).toISOString(),
    workspaceFolders: []
  }, overrides || {});
}

/** A scratch state directory with a patch the pairing controller can edit. */
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-mcp-pairing-'));
  const patchFile = path.join(dir, 'cordis.patch.yml');
  const descriptorFile = path.join(dir, 'mcp.json');
  fs.writeFileSync(patchFile, '# patch layer\n[]\n');
  return {
    dir,
    patchFile,
    descriptorFile,
    write: (raw) => fs.writeFileSync(descriptorFile, JSON.stringify(raw, null, 2)),
    remove: () => fs.unlinkSync(descriptorFile),
    patch: () => fs.readFileSync(patchFile, 'utf8')
  };
}

/** Build a controller whose probes answer from the arguments. */
async function pairingFor(scratch, overrides) {
  const { McpPairing } = await import(MODULE);
  return new McpPairing(Object.assign({
    descriptorFile: scratch.descriptorFile,
    patchFile: scratch.patchFile,
    now: () => NOW,
    isAlive: () => true,
    probe: async () => true,
    trace: () => {},
    logger: { warn() {} },
    // Never schedule a poll: every test drives `tick()` itself.
    pollMs: 600000
  }, overrides || {}));
}

test('pairing: a live descriptor enables one row, a closed editor disables it', async () => {
  const scratch = fixture();
  const pairing = await pairingFor(scratch);
  scratch.write(descriptor());
  await pairing.tick();
  assert.match(scratch.patch(), /- insert:/);
  assert.match(scratch.patch(), /disabled: false/);
  assert.strictEqual(pairing.status().enabled, true);
  assert.strictEqual(pairing.status().state, 'live');

  scratch.remove();
  await pairing.tick();
  assert.match(scratch.patch(), /- insert:/, 'the row stays as the record');
  assert.match(scratch.patch(), /disabled: true/);
  assert.doesNotMatch(scratch.patch(), /disabled: false/);
  assert.strictEqual(pairing.status().enabled, false);
  assert.strictEqual(pairing.status().state, 'absent');
});

test('pairing: an invalid descriptor never writes a row', async () => {
  const scratch = fixture();
  const pairing = await pairingFor(scratch);
  scratch.write(descriptor({ url: 'http://10.0.0.5:47920/mcp' }));
  const before = scratch.patch();
  await pairing.tick();
  assert.strictEqual(scratch.patch(), before);
  assert.strictEqual(pairing.status().state, 'invalid');
  assert.strictEqual(pairing.status().code, 'url');
});

test('pairing: a dead writer disables the row and its descriptor is removed', async () => {
  const scratch = fixture();
  let alive = true;
  const pairing = await pairingFor(scratch, { isAlive: () => alive });
  scratch.write(descriptor());
  await pairing.tick();
  assert.match(scratch.patch(), /disabled: false/);

  alive = false;
  await pairing.tick();
  assert.strictEqual(pairing.status().code, 'pid-dead');
  assert.match(scratch.patch(), /disabled: true/);
  assert.doesNotMatch(scratch.patch(), /disabled: false/);
  // The file the dead process left behind is gone as well.
  assert.strictEqual(fs.existsSync(scratch.descriptorFile), false);
});

test('pairing: a failing health probe toggles only after the 10 s grace window', async () => {
  const scratch = fixture();
  let clock = NOW;
  let healthy = true;
  const pairing = await pairingFor(scratch, {
    now: () => clock,
    probe: async () => healthy
  });
  scratch.write(descriptor());
  await pairing.tick();
  assert.strictEqual(pairing.status().enabled, true);

  healthy = false;
  await pairing.tick();
  assert.strictEqual(pairing.status().enabled, true, 'one failed probe changes nothing');

  clock = NOW + 5000;
  await pairing.tick();
  assert.strictEqual(pairing.status().enabled, true, 'still inside the grace window');

  clock = NOW + 11000;
  await pairing.tick();
  assert.strictEqual(pairing.status().enabled, false);
  assert.match(scratch.patch(), /disabled: true/);
  assert.strictEqual(pairing.status().health, 'failed');
});

test('pairing: a row the loader did not compose is disabled and not retried', async () => {
  const scratch = fixture();
  const pairing = await pairingFor(scratch, {
    configEditor: { entries: () => [] },
    verifyDelayMs: 0
  });
  scratch.write(descriptor());
  await pairing.tick();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.strictEqual(pairing.status().enabled, false);
  assert.match(scratch.patch(), /disabled: true/);
  assert.match(pairing.status().error, /did not compose/);

  // The next poll must not flip it back on while the endpoint is unchanged.
  await pairing.tick();
  assert.strictEqual(pairing.status().enabled, false);
  assert.match(scratch.patch(), /disabled: true/);
});

test('pairing: a confirmed compose is remembered per endpoint', async () => {
  const scratch = fixture();
  let calls = 0;
  const pairing = await pairingFor(scratch, {
    configEditor: {
      entries: () => {
        calls += 1;
        return [{ options: { id: 'mcp-dsh-vsdock' } }];
      }
    },
    verifyDelayMs: 0
  });
  scratch.write(descriptor());
  await pairing.tick();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.strictEqual(calls, 1);
  assert.strictEqual(pairing.status().enabled, true);
  await pairing.tick();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.strictEqual(calls, 1, 'verified once per endpoint');
});

test('pairing: a shared insert block is never rewritten', async () => {
  const scratch = fixture();
  const shared = [
    '# patch layer',
    '- insert:',
    '    - id: someone-else',
    '      name: "dsh-other"',
    '    - id: mcp-dsh-vsdock',
    '      name: "@deepseek-ai/dsh-mcp-client"'
  ].join('\n') + '\n';
  fs.writeFileSync(scratch.patchFile, shared);
  const pairing = await pairingFor(scratch);
  scratch.write(descriptor());
  await pairing.tick();
  assert.strictEqual(scratch.patch(), shared);
  assert.match(pairing.status().error, /other rows/);
});

test('pairing: the profile patch is resolved without guessing the directory', async () => {
  const { profilePatchPath } = await import(MODULE);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-mcp-profile-'));
  const patch = path.join(dir, 'cordis.patch.yml');
  fs.writeFileSync(patch, '[]\n');
  assert.strictEqual(profilePatchPath({ env: { DSH_QUICKDOCK_PATCH_FILE: patch } }), patch);
  assert.strictEqual(profilePatchPath({ env: { DSH_PROFILE_DIR: dir } }), patch);

  const home = path.join(dir, 'home');
  const profileDir = path.join(home, 'profiles', 'web');
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), '[]\n');
  assert.strictEqual(
    profilePatchPath({ env: { DSH_HOME: home, DSH_PROFILE: 'web' } }),
    path.join(profileDir, 'cordis.patch.yml')
  );
  assert.strictEqual(profilePatchPath({ env: {} }), '');
});

test('host: mounting the service exposes the pairing state in meta', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-mcp-meta-'));
  const patchFile = path.join(dir, 'cordis.patch.yml');
  fs.writeFileSync(patchFile, '# patch layer\n[]\n');
  const previous = process.env.DSH_QUICKDOCK_PATCH_FILE;
  process.env.DSH_QUICKDOCK_PATCH_FILE = patchFile;
  try {
    const { apply } = await import(SERVICE);
    const { ctx } = createContext();
    const app = apply(ctx, config({ mcpPairing: true }));
    const meta = app.meta();
    assert.ok(meta.capabilities.includes('mcp-pairing'));
    assert.strictEqual(meta.mcp.patchFile, patchFile);
    assert.strictEqual(meta.mcp.patchId, 'mcp-dsh-vsdock');
  } finally {
    if (previous === undefined) delete process.env.DSH_QUICKDOCK_PATCH_FILE;
    else process.env.DSH_QUICKDOCK_PATCH_FILE = previous;
  }
});

test('host: a live descriptor enables the row end to end', async () => {
  // A private state directory: the descriptor lives next to host.log, exactly
  // where the VS Code extension writes it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-mcp-e2e-'));
  const patchFile = path.join(dir, 'cordis.patch.yml');
  fs.writeFileSync(patchFile, '# patch layer\n- id: ui-chat\n  name: x\n[]\n');
  // The template would otherwise write the default port and bind it.
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ port: 0 }));

  const server = http.createServer((request, response) => {
    response.writeHead(request.headers.authorization === 'Bearer e2e' ? 200 : 401, {
      'content-type': 'application/json'
    });
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  fs.writeFileSync(path.join(dir, 'mcp.json'), JSON.stringify({
    apiVersion: 1,
    kind: 'dsh-vscode-mcp',
    url: 'http://127.0.0.1:' + port + '/mcp',
    healthUrl: 'http://127.0.0.1:' + port + '/health',
    token: 'e2e',
    pid: process.pid,
    heartbeatAt: new Date().toISOString()
  }));

  const previousState = process.env.DSH_QUICKDOCK_STATE_DIR;
  const previousPatch = process.env.DSH_QUICKDOCK_PATCH_FILE;
  process.env.DSH_QUICKDOCK_STATE_DIR = dir;
  process.env.DSH_QUICKDOCK_PATCH_FILE = patchFile;
  let app;
  try {
    const { apply } = await import(SERVICE);
    const { ctx } = createContext();
    app = apply(ctx, config({ mcpPairing: true }));
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !fs.readFileSync(patchFile, 'utf8').includes('disabled: false')) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const text = fs.readFileSync(patchFile, 'utf8');
    assert.match(text, /- id: ui-chat\n {2}name: x/, 'the user row survives the splice');
    assert.match(text, /serverName: "dsh-vsdock"/);
    assert.match(text, /Authorization: "Bearer e2e"/);
    assert.match(text, /disabled: false/);
    assert.strictEqual(app.meta().mcp.enabled, true);
  } finally {
    app?.mcpPairing?.stop();
    await new Promise((resolve) => server.close(resolve));
    if (previousState === undefined) delete process.env.DSH_QUICKDOCK_STATE_DIR;
    else process.env.DSH_QUICKDOCK_STATE_DIR = previousState;
    if (previousPatch === undefined) delete process.env.DSH_QUICKDOCK_PATCH_FILE;
    else process.env.DSH_QUICKDOCK_PATCH_FILE = previousPatch;
  }
});
