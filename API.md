# QuickDock API

QuickDock puts DSH's own Web UI in a small always-on-top window. There is no dock
data model to read: the window **is** the app, so anything a client needs about
sessions, runs or approvals comes from DSH itself.

What remains is the little the shell page has to ask the Host about.

## Address

```
http://127.0.0.1:<port>        port = user setting, default 47910
```

No token: the loopback address is the whole handshake. `port` is a user setting
(Settings → QuickDock, or `config.json`); the Host rebinds when it changes and the
old address keeps serving until the new one answers. `0` disables the listener.

The shell page takes one parameter, `?view=`, which says **which client is
looking at the page**. It decides two things at once: the chrome and how the DSH
app is embedded.

| `view` | Chrome | App |
|---|---|---|
| `electron` (default) | desktop window bar: drag, pin, collapse, close | embedded directly (`?token=…`) |
| `vscode` | trimmed editor bar; pin/collapse/close are not rendered | served by the Host's app proxy |
| `browser` | trimmed editor bar | embedded directly |
| `frame` | alias for `electron`, kept for URLs written before views existed | direct |

A client picks a view, never a transport. `electron` and `browser` are first-party
documents, where DSH's page authentication works as designed. `vscode` is a
webview: a third-party context for `127.0.0.1`, which never carries DSH's
`SameSite=Strict` cookie — so the Host serves the app from its own loopback origin
instead (see *App proxy*). An unknown `view` is a plain-text `400` listing the
known ones.

## Endpoints

### `GET /quickdock?view=<view>`

The shell page: a draggable title bar and an iframe with the authenticated DSH
Web UI (`/?token=…&dock=1`, or the app proxy's root for `view=vscode`).

### `GET /quickdock/api/dock-target?dock=<id>`

Which session **that dock** should show, and whether its user asked for a
reload. Without `dock` the pre-context global binding answers (the Electron
window's compatibility path).

### `GET /quickdock/api/dock-contexts`

Every connected dock: id, type, client, tool state, workspace, binding, and the
running turn that dock started (`turn`: `{ turn, dockId, at }` or `null`). The
Client half's dock picker reads this.

### `POST /quickdock/api/dock-context`

A connecting dock registers or updates its context. Body:
`{ id, type, client?, tools?, workspace?, systemPrompt? }`; missing fields are
left alone. The shell page calls it on load with its own id and type.

### `DELETE /quickdock/api/dock-context?id=<id>`

Remove a context, its binding and its tools (a dock that closed).

### `POST /quickdock/api/bind?dock=<id>`

Bind one dock to a session: body `{ sessionId }`. Without `dock`, the legacy
global bind applies. Only the Electron window is summoned by a bind; other docks
poll their own target.
The shell polls this every 1.2 s.

```json
{ "sessionId": "session-…", "seq": 3, "reloadSeq": 1 }
```

- `seq` changes when the Dock button binds another session;
- `reloadSeq` changes when the user picks "Reload the app" in the header menu.

### `POST /quickdock/api/handoff`

The reverse of a bind: the dock asks the **main DSH window** to show its current
session. Body `{ "sessionId": "session-…" }`; the Host stores the request.

### `GET /quickdock/api/handoff`

What the main window polls (every 2 s) to notice a handoff.

```json
{ "sessionId": "session-…", "seq": 4 }
```

`seq` increments per request: when it moves, the Client half calls
`uiWorkspace.openSession(sessionId)` and focuses the window.

### `GET /quickdock/api/meta`

```json
{ "name": "dsh-quickdock", "apiVersion": 2, "components": { "service": true, "dock": true }, "capabilities": ["dock-target", "handoff", "app-proxy", "mcp-pairing", "dock-contexts", "turn-attribution"], "views": ["electron", "vscode", "browser"], "mcp": null, "version": "0.6.0" }
```

`views` is the list a client may pass as `?view=`; `app-proxy` means the Host can
embed the app for a webview (`view=vscode`), so a client that cannot carry
cookies has a supported way in.

`dock-contexts` and `turn-attribution` mean the Host keeps one context per
connected dock and records which dock started the running turn of a session (see
[`DOCK-CONTEXT.md`](DOCK-CONTEXT.md)).

`mcp-pairing` means the Host watches `mcp.json` for a paired editor (see
[`MCP-PAIRING.md`](MCP-PAIRING.md)). `mcp` is `null` when the watcher is off
(`mcpPairing: false`, or no profile patch to maintain), otherwise the last
verdict: `enabled`, `known`, `state`, `code`, `reason`, `health`,
`patchFile`, `descriptorFile`, `lastWriteAt`, `error`.

## App proxy

`view=vscode` serves the DSH app from an ephemeral loopback origin owned by the
Host instead of embedding `127.0.0.1:<dsh port>` directly.

Why: DSH hands out its page through a one-shot `?token=`, answers that with
`303 → ./` and an httpOnly, `SameSite=Strict` cookie, and authenticates every
later request with that cookie. A page embedded in another application is a
third-party context for `127.0.0.1`, so the cookie is never stored or sent and the
app stops at *“dsh web authentication required”* — the same URL works in a browser
tab only because there it is the top-level document.

The proxy adds the token on document requests, keeps the auth cookie on the Host
side (and retries with the token when the cookie goes stale), forwards API calls
and upgrades WebSockets, and drops `Set-Cookie` on the way out. The embedding
client never sees the token or the cookie. It listens on `127.0.0.1` only and is
started on the first embedded view; the URL is rendered into the shell page, so
clients do not need to know the proxy's port.

## Shell ↔ app messages

Both frames are on different origins, so `postMessage` is the whole channel.

| Direction | Message | Meaning |
|---|---|---|
| shell → app | `{ type: 'quickdock:context', dock: true, host: 'desktop' }` | This page runs inside the dock |
| shell → app | `{ type: 'quickdock:toggle-sidebar' }` | Title bar `☰` |
| shell → app | `{ type: 'quickdock:new-session' }` | Title bar `＋`, shown while the sidebar is collapsed |
| shell → app | `{ type: 'quickdock:open-session', sessionId }` | Follow the session the Dock button bound |
| app → shell | `{ type: 'quickdock:ready' }` | App booted; please send the target |
| app → shell | `{ type: 'quickdock:sidebar-state', expanded }` | Reflect the real sidebar state on the button |
| app → shell | `{ type: 'quickdock:title', title }` | Session title, mirrored into the dock title bar |
| app → shell | `{ type: 'quickdock:session', sessionId }` | Which session is on screen (enables the handoff button) |

## Browser bridge (DSH origin, cookie-authenticated)

`POST /api/quickdock` with `{ "action": … }`, used by the Client half:

| Action | Body | Result |
|---|---|---|
| `bind` | `{ sessionId, dock? }` | Binds one dock (or the legacy global binding) and summons the Electron window; returns dock status |
| `dock-contexts` | – | Every connected dock: id, type, binding, tools, workspace, running turn owner |
| `dock-submission` | `{ dockId, sessionId, requestId }` | The dock's client reports an accepted prompt, so the turn it opens belongs to that dock |
| `summon` | – | Shows the window |
| `reset` | – | Restores the configured window size/position |
| `reload-dock` | – | Reloads the app inside the iframe |
| `restart` | – | Kills and respawns the window process |
| `status` | – | `{ running, starting, error, download, server }` |
| `apply-port` | `{ port }` | Persists, rebinds, reopens the window: `{ ok, port?, error?, server }` |
| `theme` / `locale` | `{ theme }` / `{ locale }` | Adopt what the browser reports |
| `web-url` | – | The shell page URL |

## VS Code MCP pairing

The editor side of the same bridge is an MCP server owned by the VS Code
extension, registered by this Host as a `@deepseek-ai/dsh-mcp-client` row. The
descriptor (`mcp.json` in the state directory), liveness rules, the one-time
consent and the loader row are specified in
[`MCP-PAIRING.md`](MCP-PAIRING.md).
