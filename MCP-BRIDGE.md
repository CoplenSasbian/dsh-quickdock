# Workspace MCP bridge

Routes MCP servers by working directory instead of by profile. It is a Host
module of this same bundle (`host/workspace-mcp.js`), mounted by the
`dsh-quickdock` row — no second package and no second patch row.

A dock — the VS Code extension, a companion app, any local process that already
exposes its features through a Model Context Protocol server — tells QuickDock
which directory the server belongs to. Sessions whose working directory is that
directory, or any directory below it, get that server's tools
(`mcp__<name>__<tool>`). Sessions elsewhere never see them, and the profile's
global MCP fleet is unaffected.

This replaces the retired file-based pairing (`mcp.json` + a global
`@deepseek-ai/dsh-mcp-client` profile row): a dock needs no profile patch and no
DSH restart, and its tools are scoped to the directory it edits instead of the
whole profile.

## HTTP interface

Served on DSH's own Web origin (the URL of the running GUI, for example
`http://127.0.0.1:58935`).

| Request | Purpose |
|---|---|
| `POST /workspace-mcp/register` | Register or replace one MCP endpoint for one directory |
| `POST /workspace-mcp/unregister` | Remove one `name`, or every registration of a directory |
| `GET /workspace-mcp/list` | Registrations and their live sessions (`?workspace=` narrows) |
| `GET /workspace-mcp/health` | Liveness probe |
| `GET /workspace-mcp/doctor` | Diagnostics: MCP client resolution, sessions, mounts |

Register body:

```json
{
  "workspace": "C:\\work\\proj",
  "url": "http://127.0.0.1:47920/mcp",
  "name": "vscode",
  "headers": { "Authorization": "Bearer local-token" },
  "transport": "streamable-http",
  "waitMs": 15000
}
```

- `workspace` (required) — absolute directory; sessions at or below it match.
- `url` (required for `streamable-http`) — the MCP endpoint. `transport:
  "stdio"` instead takes `command`, optional `args`, `env`, `cwd`.
- `name` — namespace for tool names, `[A-Za-z0-9_-]{1,32}`. Derived from the
  endpoint when omitted, so pass it for stable tool names across restarts.
- `headers` — extra request headers for the endpoint.
- `version`, `tools` — optional *self-description* a dock posts through QuickDock
  (`POST /quickdock/api/mcp-register`). The Host keeps them so the dock's tool
  panel can say which build serves which tools; they are **stripped** before the
  body reaches `/workspace-mcp/register`, which knows url/name/headers only.
- `waitMs` — how long the response may wait for already-running sessions to
  settle on this server (default 15 s, capped at 60 s).

The response lists the registration and, per affected live session, its
connection state (`connected`, `failed`, or `connecting` when the budget ran
out). Registering the same `name` in the same directory replaces the endpoint and
remounts it; `POST /workspace-mcp/unregister` with only `workspace` removes every
registration of that directory.

Registrations are in memory: a dock registers again after the Host restarts.

## Model-facing tool

The same management surface is available to agents as the `workspace_mcp` tool
(`action: list | register | unregister`), so a session can inspect or adjust the
registry without curl.

## Pairing without DSH's address

An IDE extension knows QuickDock's loopback port (its shell page) but not DSH's
Web origin, and it must not hold the bridge token. So the same three calls are
mirrored on the dock's own listener, and the Host forwards them with the origin
and `mcpBridgeToken` added:

| Request on the dock listener | Forwards to |
|---|---|
| `POST /quickdock/api/mcp-register` | `POST /workspace-mcp/register` |
| `POST /quickdock/api/mcp-unregister` | `POST /workspace-mcp/unregister` |
| `GET /quickdock/api/mcp-list?workspace=` | `GET /workspace-mcp/list?workspace=` |

Bodies and answers are unchanged; a refusal keeps the bridge's message and comes
back as `400 { ok: false, error }`. `GET /quickdock/api/meta` reports
`mcpBridge: { enabled, origin, route, tokenRequired }` for diagnostics (it is also
what a client uses to notice that the bridge is switched off: `enabled: false`).

Registrations are in memory in DSH. A dock therefore polls `mcp-list` for the
directory it edits and registers again when its server is missing or has another
`url` — that is how the tools come back after a DSH restart without remounting
sessions that are already connected.

## Matching and lifecycle

- A session is evaluated when it is created and whenever the registry changes;
  live sessions are reconciled immediately, including on unregister.
- The most specific registered directory wins a `name` collision, so a nested
  workspace can override a parent.
- Sessions outside every registered directory mount nothing.
- `agent/created` listeners are not delayed by the connection: registrations
  exist immediately and the server's tools appear as soon as its first tool
  synchronization completes.

## Configuration

Set these on the `dsh-quickdock` row when you need them:

| Field | Default | Meaning |
|---|---|---|
| `mcpBridge` | `true` | Serve the bridge routes and mount dock tools |
| `mcpBridgeToken` | `''` | When set, requests must present `x-workspace-mcp-token: <token>` or `Authorization: Bearer <token>`. Empty accepts loopback requests only. |
| `mcpBridgeWaitMs` | `15000` | Default `waitMs` for a register call |
| `startupTimeoutMs` | `30000` | Per-connection budget handed to the MCP client (bridge default) |
| `maxSessionsPerServer` | `32` | Guard against mounting one server into unbounded sessions (bridge default) |

## Limitations

- Registrations are not persisted; the dock owns their lifetime.
- The dock-side shortcut routes inherit the dock listener's trust: they are
  loopback-only and carry no token, so anything on this machine that can reach
  that port can register an endpoint. `mcpBridgeToken` protects DSH's Web origin,
  not the dock listener.
- The bridge mounts the shipped `@deepseek-ai/dsh-mcp-client`, resolved from the
  running installation, so it needs a DSH installation that ships that package.
- Tool names are fixed by `name`: changing it publishes new tools.
- No OAuth flow; a server that answers with an authorization challenge shows up
  as a failed connection.
