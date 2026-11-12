# VS Code ↔ DSH MCP pairing

How the VS Code extension (an MCP server over the editor's language features) and
QuickDock (a DSH host plugin) find each other and keep DSH's MCP tool list in
sync with the editor — with **no hand-edited configuration** on either side.

Status: the QuickDock side is implemented (`host/mcp-descriptor.js` for the
validation and liveness rules, `host/mcp-patch.js` for the splice and the atomic
write, `host/mcp-pairing.js` for the poller and its state machine). The VS Code
extension still has to follow the server contract below.

> **Superseded in part by [`DOCK-CONTEXT.md`](DOCK-CONTEXT.md).** The descriptor
> becomes a per-dock `docks\<id>.json` context, QuickDock registers the tools
> itself with a per-session `when` condition, and the profile's
> `@deepseek-ai/dsh-mcp-client` row is retired. This file stays as the history of
> the first contract; implement against `DOCK-CONTEXT.md`.

Related: the dock *view* already pairs automatically by port detection
(`?view=vscode`, see `API.md`). This document covers the other half: the MCP
server the editor exposes and how DSH learns about it.

## Scope

- One VS Code window (one extension host) → one MCP server → one DSH MCP entry.
- Pairing is automatic after a **one-time consent** in VS Code.
- Loopback only. No network, no remote, no multi-user.
- Non-goals: installing either side, editing the DSH UI, exposing DSH to VS Code,
  and any write access from the agent to the editor in v1 (read-only).

## Topology

```
VS Code extension host                      DSH process
┌──────────────────────────┐   state dir   ┌──────────────────────────────┐
│ MCP server :47920        │               │ QuickDock host               │
│  POST /mcp  (tools)      │◀──HTTP───────▶│  watches mcp.json            │
│  GET  /health            │   loopback    │  writes cordis.patch.yml     │
└──────────────────────────┘               │  @deepseek-ai/dsh-mcp-client │
        ▲ writes mcp.json                  └──────────────────────────────┘
        │                                            │ ~1 s live reload
        └──────────── %LOCALAPPDATA%\dsh-quickdock ──┘
```

The extension is the MCP **server**; DSH is the MCP **client**. The only new
pieces are the descriptor file and the one loader row QuickDock maintains.

## Discovery channel

### State directory

The same directory the extension already reads for port discovery
(`%LOCALAPPDATA%\dsh-quickdock`, or `DSH_QUICKDOCK_STATE_DIR` when set):

| File | Owner | Purpose |
|---|---|---|
| `config.json` | QuickDock | dock port (existing) |
| `host.log` | QuickDock | host log (existing) |
| `mcp.json` | VS Code extension | MCP descriptor (new) |

The directory is the trust boundary: it is user-private, and so is the ability to
write the profile patch. Anything able to write this directory can already
change DSH's configuration; `mcp.json` adds no privilege beyond that.

### `mcp.json`

Written atomically (`mcp.json.tmp` → rename), so a reader never sees half a file.

```json
{
  "apiVersion": 1,
  "kind": "dsh-vscode-mcp",
  "extension": { "id": "dsh.dsh-vsdock", "version": "0.3.0" },
  "editor": { "name": "Visual Studio Code", "version": "1.145.0" },
  "url": "http://127.0.0.1:47920/mcp",
  "healthUrl": "http://127.0.0.1:47920/health",
  "token": "b7Qm…32 bytes base64url…",
  "pid": 12345,
  "startedAt": "2026-11-08T13:56:00.000Z",
  "heartbeatAt": "2026-11-08T13:58:15.000Z",
  "workspaceFolders": ["C:\\Users\\futur\\Desktop\\dsh-vsdock"]
}
```

- `kind` keeps unrelated files out; `apiVersion` gates the shape.
- `token` is **stable per installation** (stored in the extension's global state,
  rotated by an explicit command). QuickDock copies it into the MCP entry, so a
  stable token means a stable entry. It appears only in this descriptor and in
  the patch row — never in a URL, never in a log.
- `heartbeatAt` is rewritten every 15 s; the file's mtime moves with it.
- The extension deletes the file on `deactivate`, but crashes are expected —
  QuickDock must never rely on that.

### Liveness

A descriptor is **live** when all of these hold:

1. `kind === "dsh-vscode-mcp"` and `apiVersion === 1`;
2. `url` parses as `http://127.0.0.1:<port>` (or `localhost`), port 1–65535;
3. `token` is a non-empty string, ≤ 200 chars;
4. `pid` is a positive integer and `process.kill(pid, 0)` succeeds
   (EPERM = alive, ESRCH = dead);
5. `heartbeatAt` parses and is within 90 s (allows clock skew);
6. `GET healthUrl` with the token returns `200` — best effort: a single failed
   probe is retried on the next poll; a probe that has failed continuously for
   10 s means "not live".

QuickDock polls `mcp.json` every 2 s. A missing file is a normal state (the
editor is closed), and a poll failure or an unreadable file is **not** a state
change; only a changed descriptor (or liveness verdict) triggers a rewrite.

### Consent

Pairing is gated by an explicit opt-in. The first implementation (extension
0.4.0) uses a setting, `dshVsdock.mcp`, which defaults to **off**; a one-time
dialog is an acceptable alternative when the setting becomes default-on.

- Enabling the setting is the consent record; QuickDock never asks again.
- Disabling it stops the server and removes `mcp.json`; QuickDock disables the row
  on its next poll.
- Unpairing never deletes the insert row — only the toggle changes.

The consent surface must state the security fact below (tools run outside DSH's
sandbox).

## QuickDock registration

### Desired state

QuickDock derives one of three desired states and writes only when the file
differs from what it wants:

| Descriptor | Desired |
|---|---|
| live | entry present, `disabled: false` |
| present but not live (stale, wrong pid, bad health) | entry present, `disabled: true` |
| absent or invalid | `disabled: true` when the insert row exists, otherwise write nothing |

The insert row is created the first time a **live** descriptor is seen and kept
afterwards; only the toggle changes at runtime. `disabled: true` is written as a
separate patch row, exactly like `dsh-mcp-manager-plus` does, so the insert row
stays the stable record. Without an insert row there is nothing to toggle, so a
non-live descriptor never conjures a row out of nothing.

### Patch rows

Insert row (created once, updated only when the URL or token changes):

```yaml
- insert:
    - id: mcp-dsh-vsdock
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: "dsh-vsdock"
        transport: "streamable-http"
        url: "http://127.0.0.1:47920/mcp"
        headers:
          Authorization: "Bearer <token>"
        failOnStartupError: false
```

`failOnStartupError: false` is a value choice, not a shape change: the row stays
valid when the editor is closed at DSH boot (the poller disables it on the next
tick), and a paired server that died must not fail composition.

Toggle row (always present once the insert row exists; `false` while live,
`true` otherwise):

```yaml
- id: mcp-dsh-vsdock
  disabled: false
```

The `name` and `config` shape are owned by `@deepseek-ai/dsh-mcp-client`, not by
QuickDock. If a future DSH changes them, the entry fails to compose; QuickDock
disables it and logs — it must not guess a new shape.

### Writing safely

The profile patch is a user file shared with `dsh-mcp-manager-plus` and the user:

- **Splice, don't re-serialize.** Find the top-level `- ` block whose `id` is
  `mcp-dsh-vsdock` (both the insert row and the toggle row) and replace, insert
  or delete only those lines. The header comment and every other row stay
  byte-for-byte identical. YAML re-serialization would drop comments and
  reformat the user's file.
- **Validate before committing.** The whole document must still parse as a
  top-level YAML array; the spliced block must be present and well-formed. On
  failure, leave the file untouched and log.
- **Atomic replace.** Write `cordis.patch.yml.tmp` in the same directory, then
  rename over the original; keep the last good file as `cordis.patch.yml.bak`.
- **Lock.** `cordis.patch.yml.lock` is created with `O_EXCL`; a live lock makes
  this tick yield (the 2 s poll retries), a lock older than 10 s is reclaimed for
  up to 3 attempts. The MCP manager already requires read-modify-write; the lock
  keeps both writers from interleaving.
- **Debounce.** The 2 s poll is the debounce; a write is skipped when the
  computed block text equals the current text.
- **Never repair.** If the file is unreadable or not an array, log and stop;
  do not "fix" someone else's YAML.

QuickDock owns the rows whose `id` is `mcp-dsh-vsdock`. Manual edits to those
rows are overwritten the next time the state changes; leave every other row
alone.

### Verification

After writing `disabled: false`, QuickDock checks within 5 s that
`configEditor.entries()` contains `mcp-dsh-vsdock`. Failure means the loader
rejected the row: log the reason (host.log) and set `disabled: true`, then retry
on the next live→state change rather than in a loop. Tool-level health is the
MCP client's own concern (visible in Settings → MCP 管理 when that plugin is
installed).

### Implementation

| Path | Responsibility |
|---|---|
| `host/mcp-descriptor.js` | read `mcp.json`, apply the liveness rules above, probe the pid |
| `host/mcp-patch.js` | splice the two rows, validate the document, lock and replace atomically |
| `host/mcp-pairing.js` | the 2 s poll, the health grace window, the desired-state write, compose verification |

The watcher starts with the Host half (the service row) and stops with it. The
`mcpPairing` setting (default `true`; `config.json` or the Loader row) turns it
off entirely: no poll, no write. `GET /quickdock/api/meta` reports the last
verdict under `mcp`, so a client can show why the row is off.

A tick writes nothing unless the document it would write differs, and the patch
is only read when a descriptor is present: QuickDock never creates the file,
never repairs it and leaves it alone when it cannot be parsed as an array.

### Teardown

Disable, keep the insert row. Uninstalling QuickDock leaves the rows in place —
profile patch rows are user data, same rule `dsh-mcp-manager-plus` follows. Set
`mcpPairing: false` first when the rows should stay frozen but the poller should
not run.

## MCP server contract

### Address and auth

```
POST /mcp        streamable HTTP (MCP)
GET  /mcp        SSE stream (SDK-managed)
DELETE /mcp      session teardown (SDK-managed)
GET  /health     {"ok":true,"version":"0.3.0","tools":7}
```

- Bound to `127.0.0.1` only.
- Every request carries `Authorization: Bearer <token>`; anything else is `401`
  with an empty body.
- Port: `dshVsdock.mcpPort`, default **47920**. A busy port is an error shown to
  the user — the extension must not silently pick another port, because the
  entry in DSH records the URL.
- No token in the URL. The descriptor and the patch row are the only places the
  token appears; neither is logged.

### Protocol

MCP `2025-06-18` (the SDK default). One server per editor window. Tools are
stateless; sessions are per-connection.

### Tool set (v1, read-only)

Names are stable and prefixed to avoid collisions with DSH's own tools.

| Tool | Input | Returns |
|---|---|---|
| `vscode_workspace_folders` | — | roots, active file, language |
| `vscode_selection` | — | active file, cursor, selection text (≤ 4 KB) |
| `vscode_diagnostics` | `path?`, `scope` (`file`/`workspace`), `limit?` | counts by severity + ≤ 50 items per file, ≤ 200 total |
| `vscode_symbols` | `path`, `depth?` | document outline (≤ 200 nodes, depth ≤ 3) |
| `vscode_search_symbols` | `query`, `limit?` | ≤ 50 hits |
| `vscode_read_file` | `path`, `startLine?`, `endLine?` | text (≤ 2000 lines / 256 KB), `dirty` flag for unsaved buffers |
| `vscode_open` | `path`, `line?`, `column?` | ok (navigation only, never edits) |

Rules for every tool:

- Results stay bounded; truncation is explicit and carries the path so the model
  can ask for more.
- Paths are absolute; line/column are 1-based.
- No writes in v1. If write tools arrive later they are opt-in and do not reuse
  the read token.
- Planned but not in v1: `vscode_definition`, `vscode_references`,
  `vscode_hover`, `vscode_git_status`.

## State machine

| `mcp.json` | QuickDock | DSH |
|---|---|---|
| absent | `disabled: true` if the insert row exists, otherwise nothing | no tools |
| live | `disabled: false` | tools appear within ~1 s |
| stale / pid dead / health failing | `disabled: true` | tools removed |
| invalid (kind, apiVersion, url, token) | `disabled: true` + log | no tools |
| port busy in VS Code (no descriptor) | `disabled: true` on the next liveness check | tools removed; VS Code shows the error |

Transitions are driven by the 2 s poll; the loader's own compose happens about a
second after the file changes, so "open VS Code → tools usable" is ~3 s.

## Failure handling

| Cause | Observable | Action |
|---|---|---|
| VS Code closed normally | `mcp.json` deleted | disable |
| VS Code killed | pid dead / heartbeat stale | disable, delete the stale file |
| MCP server crashed, extension alive | health probe fails twice | disable, keep the descriptor |
| Wrong token | health 401 | treat as not live, log |
| Port taken at VS Code start | no descriptor (the extension deletes a stale one before retrying) | QuickDock disables on the next liveness check |
| Loader rejects the row | `configEditor.entries()` misses the id | disable, log, retry on next change |
| Two DSH profiles running | both register the same server | allowed; one row per profile |

## Security model

- Trust boundary: the user's own directory ACL plus the loopback interface.
- **MCP tools run in the VS Code extension host, outside DSH's sandbox.** They can
  reach anything VS Code can, including paths outside the DSH workspace root. The
  first-time consent says so; v1 is read-only to keep the blast radius small.
- The token is a capability: it is not logged, not put in URLs, and it is masked
  by the MCP manager's credential masking when that plugin displays the entry.
- QuickDock refuses descriptors whose `url` is not loopback, and never follows a
  redirect from the health probe.

## Versioning and compatibility

- `apiVersion: 1` in the descriptor; unknown fields are ignored; a future
  `apiVersion: 2` is ignored with a log entry (half-applying a newer shape is
  worse than not pairing).
- The patch row shape belongs to `@deepseek-ai/dsh-mcp-client`. Compatibility is
  verified by outcome (the loader composes the entry; the MCP client connects),
  not by guessing versions.
- The extension may ship newer tool sets without changing the descriptor; DSH
  re-reads the tool list when the MCP client reconnects.

## Testing

Unit (no DSH needed):

- descriptor validation: each rejection rule, plus a valid one;
- splice: append, replace, remove, header preserved, other rows untouched;
- atomic write and lock behavior (parallel writer, stale lock);
- state machine: absent → live → stale → live; invalid → no write.

Integration (dev DSH + dev VS Code):

- open/close VS Code → tools appear/disappear within ~3 s;
- kill the extension host → tools disappear, QuickDock removes the stale
  descriptor;
- DSH restart with VS Code open → tools reappear after boot;
- wrong token → entry disabled, no tools;
- port 47920 busy → clear VS Code error, entry disabled on the next check;
- two profiles → both get the entry;
- `dsh-mcp-manager-plus` installed → the entry shows up, and editing it manually
  is overwritten on the next state change (documented behavior).

## Alternatives considered

- **Loopback register route on QuickDock** (`POST /quickdock/api/mcp`): lower
  latency and no shared file, but adds an authenticated route and a second
  discovery mechanism. Revisit if 2 s polling proves too slow.
- **DSH host plugin registers tools directly** (`ctx.tools.register`): works only
  inside DSH and still needs a bridge to the editor; it re-implements MCP without
  the cross-client benefit.
- **VS Code `--add-mcp`**: makes VS Code an MCP *client*; wrong direction.

## Open questions

- Write tools (`vscode_apply_edit`, `vscode_rename`) — opt-in, separate token?
- Token rotation UX: command only, or automatic on extension update?
- Multi-root VS Code workspaces: one MCP server may serve all roots, but a DSH
  workspace is one path. The tool set exposes all roots; the DSH workspace stays
  the user's choice.
- Should the MCP manager mark `id: mcp-dsh-vsdock` as managed/read-only so a
  manual edit cannot silently diverge?
