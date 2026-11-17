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
| `intellij` | the same trimmed bar, for a JetBrains IDE webview (JCEF) | served by the Host's app proxy |
| `browser` | trimmed editor bar | embedded directly |
| `frame` | alias for `electron`, kept for URLs written before views existed | direct |

A client picks a view, never a transport. `electron` and `browser` are first-party
documents, where DSH's page authentication works as designed. `vscode` and
`intellij` are webviews: a third-party context for `127.0.0.1`, which never
carries DSH's `SameSite=Strict` cookie — so the Host serves the app from its own
loopback origin instead (see *App proxy*). The view's name is also what the app
is told it runs inside (`host` in the shell's context message), and that is what
makes a clicked path open in the embedding editor; a client that needs its own
name uses its own view rather than borrowing `vscode`. An unknown `view` is a
plain-text `400` listing the known ones.

## Endpoints

### `GET /quickdock?view=<view>`

The shell page: a draggable title bar and an iframe with the authenticated DSH
Web UI (`/?token=…&dock=1`, or the app proxy's root for `view=vscode` and
`view=intellij`).

An embedding client may add three parameters:

| Parameter | Meaning |
|---|---|
| `dock=<id>` | The dock id the shell registers and binds under (default: a random id kept in `sessionStorage`) |
| `mcp=0` \| `mcp=1` | Show the **editor-tools switch** in the bar, in that state. Only an IDE dock, which runs the MCP server itself, passes it; without it the button is not rendered at all |
| `workspace=<dir>` | A directory this dock edits, send once per root folder. The bar warns when the session on screen works outside all of them |

### `GET /quickdock/api/dock-target?dock=<id>`

Which session **that dock** should show, and whether its user asked for a
reload. Without `dock` the pre-context global binding answers (the Electron
window's compatibility path): `{ sessionId, seq, reloadSeq, workspace }`.

```json
{
  "sessionId": "session-…",
  "seq": 3,
  "reloadSeq": 1,
  "workspace": { "dock": "C:\\work\\proj", "session": "C:\\work\\proj", "matches": true }
}
```

`workspace` compares the directories a dock declared (`workspace` above) with the
one the session on screen belongs to. `matches: false` is what the bar's warning
icon is for: the dock registers tools per directory, so that session mounts none.
`matches: null` means "cannot tell" (nothing declared, or a session outside every
workspace) and nothing is shown.

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

### `GET /quickdock/api/file-events?since=<seq>&wait=<ms>`

What **DSH's own file tools** wrote, from a cursor. This is the feed an editor
reads to open a review diff for exactly the agent's changes:

```json
{
  "ok": true,
  "seq": 12,
  "events": [
    { "seq": 11, "path": "C:\\work\\proj\\src\\a.ts", "kind": "write", "at": 1763350000000 },
    { "seq": 12, "path": "C:\\work\\proj\\src\\old.ts", "kind": "delete", "at": 1763350000900 }
  ],
  "dropped": 0
}
```

- `since` — the last `seq` the caller saw; only newer events come back. Pass the
  answer's `seq` next time. Events are **not consumed**: two docks may follow the
  same feed.
- `wait` — long-poll budget in milliseconds (default 10 000, capped at 25 000):
  the answer is sent as soon as one event arrives, otherwise when the budget
  runs out. `wait=0` answers immediately.
- `path` — the path DSH displays for the file. For the local backend it is an
  absolute path; a remote backend may report a workspace-relative path or a URI,
  so a client resolves it against the directory it edits.
- `kind` — `write` (created, edited, moved to) or `delete`.
- `dropped` — events the bounded ring had already discarded before `since`, so a
  caller can tell "nothing happened" from "I was away too long".

The feed comes from DSH's filesystem service (`fs/observed`): only a mutation
that goes through it is reported. A build tool, a formatter or any other process
started from a shell writes to the disk directly and never appears here - which
is the point of the filter. `meta.capabilities` lists `file-events` when the Host
serves this route.

### `GET /quickdock/api/app-url`

The app itself, as a document a client can load **top level**:

```json
{ "ok": true, "url": "http://127.0.0.1:57128/?dock=1" }
```

This exists for an editor whose embedded browser cannot route input-method
commits into a subframe (JCEF: the caret blinks, the candidate window opens, the
character never arrives - English typing works). Such a client loads this URL
instead of `/quickdock?view=…`, so the app's composer is the browser's main frame,
and brings its own chrome. The URL is the app proxy's origin: the DSH token and
cookie never reach the client, exactly as for `view=vscode`. `meta.capabilities`
lists `app-url` when the Host serves it; a 404 means "keep using the shell page".

### `GET /quickdock/api/meta`

```json
{ "name": "dsh-quickdock", "apiVersion": 2, "components": { "service": true, "dock": true }, "capabilities": ["dock-target", "handoff", "app-proxy", "dock-contexts", "turn-attribution", "file-events", "app-url"], "views": ["electron", "vscode", "intellij", "browser"], "mcpBridge": { "enabled": true, "origin": "http://127.0.0.1:58935", "route": "/workspace-mcp", "tokenRequired": false }, "version": "0.6.0" }
```

`views` is the list a client may pass as `?view=`; `app-proxy` means the Host can
embed the app for a webview (`view=vscode`, `view=intellij`), so a client that
cannot carry cookies has a supported way in. A build older than a client's view
name simply does not list it, which is how a client knows to fall back (the
IntelliJ plugin asks for `intellij` and uses `vscode` when it is absent).

`mcpBridge` says where a dock's MCP endpoint is registered. The dock-side
shortcuts are on this listener, so a client needs only the object above and never
DSH's own port (see *Workspace MCP bridge*).

`dock-contexts` and `turn-attribution` mean the Host keeps one context per
connected dock and records which dock started the running turn of a session (see
[`DOCK-CONTEXT.md`](DOCK-CONTEXT.md)).

Dock tools are not part of this metadata: an IDE dock registers its MCP endpoint
per working directory (see [`MCP-BRIDGE.md`](MCP-BRIDGE.md)), and the tools only
reach sessions inside that directory.

## App proxy

`view=vscode` (and `view=intellij`) serves the DSH app from an ephemeral loopback
origin owned by the Host instead of embedding `127.0.0.1:<dsh port>` directly.

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
| app → shell | `{ type: 'quickdock:open-file', path }` | A path the user clicked; the shell hands it to the embedding editor |

## Shell ↔ embedding client messages

An IDE dock embeds the shell page in a webview, and the bar carries two controls
that belong to that client: the editor-tools switch and the workspace warning.
The client page relays both directions over `postMessage` (the shell's `window.parent`).

| Direction | Message | Meaning |
|---|---|---|
| shell → client | `{ type: 'quickdock:mcp-toggle' }` | The user clicked the bar's plug; flip the editor tools |
| client → shell | `{ type: 'quickdock:mcp-state', on, detail? }` | Current state for the bar: `on` decides the plug's highlight, `detail` goes in its tooltip |
| shell → client | `{ type: 'quickdock:open-file', path }` | A file the user clicked in the docked conversation: open it in this editor |

The warning icon is built from `dock-target`'s `workspace.matches`, not from a
message: it shows while the tools are on and the session on screen works outside
every `workspace=` directory the client declared (`API.md`, `GET /quickdock?view=`).

### A dock that cannot frame the app (top-level mode)

A browser that cannot commit input-method text into a subframe (JCEF: the caret
blinks, the candidate window opens, the character never arrives, English works)
loads the app through `GET /quickdock/api/app-url` and draws the bar itself. The
messages are the same table above; this is what such a bar must do, so two clients
cannot drift:

| element | state from | rule |
|---|---|---|
| title | `quickdock:title` | the app's session title; keep the last one |
| sidebar toggle | `quickdock:sidebar-state` | post `quickdock:toggle-sidebar`; highlight while expanded |
| new session | `quickdock:sidebar-state` | post `quickdock:new-session`; **hidden while the sidebar is expanded** - the sidebar carries its own button (this is the shell bar's CSS rule, not a second one) |
| editor tools | client-owned | icon shows on/off, tooltip carries the tool count |
| handoff | `quickdock:session` | `POST /quickdock/api/handoff` with that `sessionId`; disabled while it is empty |
| workspace warning | `GET /quickdock/api/dock-target` | show while `workspace.matches === false`, with an explanation in the tooltip |
| session follow | `dock-target` | poll about every 1.2 s: post `quickdock:open-session` when `sessionId` changes, reload on `reloadSeq` |

The Host page is not involved in that mode: the client also registers the dock
context itself (`POST /quickdock/api/dock-context`, `type: 'intellij'`), because
the shell page is what used to do it. Everything else - `dock-target`, `bind`,
`handoff`, `mcp-register` - is unchanged.

Today the VS Code extension takes the bar from the shell page and the IntelliJ
plugin implements the table above in Swing (`dock/DockToolbar.kt`,
`dock/DockIcons.kt`). A new editor should implement this table, not fork the shell
page: the shell page stays the path for windows and webviews that can type into a
frame, the table is the path for one that cannot.

## Browser bridge (DSH origin, cookie-authenticated)

`POST /api/quickdock` with `{ "action": … }`, used by the Client half:

| Action | Body | Result |
|---|---|---|
| `bind` | `{ sessionId, dock? }` | Binds one dock (or the legacy global binding) and summons the Electron window; returns dock status |
| `dock-contexts` | – | Every connected dock: id, type, binding, workspace, running turn owner |
| `dock-submission` | `{ dockId, sessionId, requestId }` | The dock's client reports an accepted prompt, so the turn it opens belongs to that dock |
| `summon` | – | Shows the window |
| `reset` | – | Restores the configured window size/position |
| `reload-dock` | – | Reloads the app inside the iframe |
| `restart` | – | Kills and respawns the window process |
| `status` | – | `{ running, starting, error, download, server }` |
| `apply-port` | `{ port }` | Persists, rebinds, reopens the window: `{ ok, port?, error?, server }` |
| `theme` / `locale` | `{ theme }` / `{ locale }` | Adopt what the browser reports |
| `web-url` | – | The shell page URL |

## Workspace MCP bridge

An editor dock brings tools by registering its MCP endpoint together with the
working directory it belongs to:

```
POST /workspace-mcp/register   { workspace, url, name?, headers? }
```

The route lives on DSH's Web origin, not on this listener. Only sessions whose
working directory is that directory or below it get the server's tools; see
[`MCP-BRIDGE.md`](MCP-BRIDGE.md) for the full interface and the
`/workspace-mcp/list` and `/workspace-mcp/doctor` diagnostics.

A dock that only knows this listener (an IDE extension) uses the mirrored calls,
which the Host forwards to the bridge with the origin and the configured
`mcpBridgeToken` added:

| Request | Purpose |
|---|---|
| `POST /quickdock/api/mcp-register` | Register or replace one dock's endpoint for one directory |
| `POST /quickdock/api/mcp-unregister` | Remove one `name`, or every registration of a directory |
| `GET /quickdock/api/mcp-list?workspace=` | Registrations for that directory, with their live sessions |
| `GET /quickdock/api/mcp-servers?workspace=` | What the docks in that directory published: name, url, build, tool names, and whether the bridge has them mounted. Read-only |

Bodies and answers are the bridge's own. Refusals keep the bridge's message and
come back as `400 { ok: false, error }`. Registrations live in memory in DSH, so a
dock polls `mcp-list` and registers again after a DSH restart.

This listener has no token (see *Address*), so a local process that can reach it
can register an endpoint — the same trust the rest of this API already assumes.
The bridge's own `mcpBridgeToken` still guards DSH's Web origin, and the Host
presents it on the dock's behalf; it is not a substitute for keeping this port on
loopback only.
