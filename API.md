# QuickDock API

QuickDock puts DSH's own Web UI in a small always-on-top window. There is no dock
data model to read: the window **is** the app, so anything a client needs about
sessions, runs or approvals comes from DSH itself.

What remains is the little the shell page has to ask the Host about.

## Address

```
http://127.0.0.1:<port>        port = plugin config, default 47910
```

No token: the fixed loopback address is the whole handshake. Change `port` when
something else already listens there (the Host logs `EADDRINUSE`).

## Endpoints

### `GET /quickdock?view=frame`

The shell page: a draggable title bar (sidebar toggle, pin, OS window controls)
and an iframe with the authenticated DSH Web UI (`/?token=…&dock=1`).

### `GET /quickdock/api/dock-target`

Which session the window should show, and whether the user asked for a reload.
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
{ "name": "dsh-quickdock", "apiVersion": 1, "components": { "service": true, "dock": true }, "capabilities": ["dock-target", "handoff"], "version": "0.5.0" }
```

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
| `bind` | `{ sessionId }` | Binds and summons; returns dock status |
| `summon` | – | Shows the window |
| `reset` | – | Restores the configured window size/position |
| `reload-dock` | – | Reloads the app inside the iframe |
| `restart` | – | Kills and respawns the window process |
| `status` | – | `{ running, starting, error, download }` |
| `theme` / `locale` | `{ theme }` / `{ locale }` | Adopt what the browser reports |
| `web-url` | – | The shell page URL |
