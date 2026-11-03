# QuickDock — design

## What it is

A small always-on-top window around **DSH's own Web UI**, opened from a session
header and pinned over other apps. The plugin does not re-implement the dock UI:
the window embeds the real app, so sessions, runs, approvals and settings are
always the current DSH build.

```
DSH main window ──[Dock button]──► Host binds the session ──► Electron window
                                                              │
                                              shell page (localhost:47910)
                                                              │
                                              iframe ─► DSH Web UI (?dock=1)
```

## Why a shell page

A foreign page cannot be dragged, styled or driven from outside: `-webkit-app-region`
has to come from its own document, and a cross-origin frame cannot be reached by
DOM. So the window loads a **shell page we serve**, which owns the title bar and
puts the app in an iframe. Everything between the two frames is `postMessage`:

| Direction | Message |
|---|---|
| shell → app | `quickdock:context`, `quickdock:toggle-sidebar`, `quickdock:open-session` |
| app → shell | `quickdock:ready`, `quickdock:sidebar-state` |

The app's `client.js` half recognises the dock window by `?dock=1` **or** by being
an iframe (the SPA strips its query after boot), and then: skips the header
button, and applies the dock-only layout rules.

## Components

| Path | Responsibility |
|---|---|
| `index.js` / `service.js` / `dock.js` | entry points; one row mounts both components |
| `host/quickdock-host.js` | listener, shell page, targets, dock lifecycle |
| `host/page.js` | the shell HTML (title bar + iframe + message script) |
| `host/api.js` | `dock-target`, `meta` |
| `host/bridge.js` | `/api/quickdock` actions for the Client half |
| `host/dock-*.js` | Electron supervisor (spawn, control channel, geometry) |
| `runtime/main.cjs` | the Electron process: window, system controls, preload |
| `client.js` | header button, download badge, theme/locale sync, dock-mode shims |

## Dock-only layout rules (`client.js`)

At dock width the shipped sidebar would squeeze the conversation, so:

- while expanded it covers the whole window (`position: fixed; width: 100vw`);
- picking a session collapses it again;
- the window opens on the conversation even if the main window left the sidebar
  expanded (state is shared through `localStorage`).

The selectors key off the app's own state (`data-sidebar-collapsed` on the frame),
and are scoped to `html[data-qd-dock]`, so the normal window is untouched.

## Window

- fixed loopback port (default 47910), **no token**: the address is the handshake;
- `windowControls: 'system'` draws the OS close/minimise over the title bar
  (`titleBarStyle: hidden` + `titleBarOverlay`, `thickFrame` for the native border);
- `clickThrough: false` because the embedded app posts no hit regions;
- `rememberGeometry`, `alwaysOnTop`, `focusOnSummon` behave as before.

## Non-goals

- Re-rendering conversation content inside the plugin (DSH already does it better).
- Being a second DSH client for IDEs: an IDE can embed the same shell URL in a
  webview; the Host contract is already the smallest one that supports that.
