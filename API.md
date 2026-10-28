# QuickDock client API (v1)

The Host half is a client-agnostic service: the dock UI is **one** client. IDE
plugins (VS Code, JetBrains, editors) can drive the same API to bind any
workspace/session, send prompts, follow the live turn and read earlier turns.

Two things the dock UI deliberately does **not** do are backend capabilities:

| Capability | Dock UI | API |
|---|---|---|
| Switch workspace / session | read-only chip | `POST select` |
| Show more than the newest turn | newest turn only | `GET turns`, `GET turn` |

In other words: the dock not rendering history is a UI choice, not an API limit.

## Transport and authentication

- Base URL: the DSH web-server origin plus `/quickdock/api/` (for example
  `http://127.0.0.1:54321/quickdock/api/state`).
- Auth: `Authorization: Bearer <token>`, or `?t=<token>` where headers cannot be
  set (EventSource/SSE). Requests without it get `401 { "error": ... }`.
- The token is created per Host process. The dock receives the full URL through
  `DSH_QUICKDOCK_URL`; another client must be handed the origin and token by its
  Host-side integration.
- Bodies are JSON. Handler errors return `400 { "ok": false, "error": "..." }`.

## Discovery

```http
GET /quickdock/api/meta
```

```json
{
  "name": "dsh-quickdock",
  "apiVersion": 1,
  "capabilities": ["state", "stream", "workspaces", "sessions", "select", "bind", "task",
                    "stop", "turns", "turn", "step-detail", "catalogs", "settings", "answer",
                    "theme", "locale"],
  "turns": { "latestInState": true, "history": "turns+turn", "retention": "maxSteps" },
  "interactions": { "approvals": "claim-and-delegate", "questions": "claim-and-delegate" }
}
```

`apiVersion` only changes for breaking changes; new fields and new routes are
additive.

## Read endpoints

| Route | Result |
|---|---|
| `GET state` | Full state snapshot (see below). |
| `GET workspaces` | `{ workspaceId, workspaces: [{ id, name, path, sessionCount }] }`. |
| `GET sessions?workspaceId=<id>` | `{ workspaceId, sessions: [{ sessionId, title, cwd, updatedAt, running, blank }] }`. Omit the workspace to list every indexed session. |
| `GET turns?sessionId=<id>` | `{ sessionId, outline, turns: [{ turn, seq, prompt, response, rows, startedAt, endedAt }] }`; defaults to the bound session. |
| `GET turn?turn=<n>&sessionId=<id>` | `{ sessionId, turn, observed, steps }`; omitting `turn` reads the newest one, omitting `sessionId` uses the bound session. |
| `GET step-detail?id=<rowId>&sessionId=<id>` | `{ args, result }` for one expandable row (bound session by default). |
| `GET catalogs` | Permission / model / reasoning / agent catalogs (may refresh models first). |
| `GET stream` | SSE: initial `state`, `theme`, `locale` frames, then updates. |
| `GET bus` | SSE used by the dock for "open session in DSH" commands. |

### State snapshot

`steps` is always the **newest turn** (what the dock renders). `turn` describes
it; the rest of the history is read through `turns`/`turn`.

```json
{
  "workspaceId": "ws-1",
  "sessionId": "s-1",
  "newSession": false,
  "workspaces": [{ "id": "ws-1", "name": "dsh-quickdock", "path": "D:/code/dock" }],
  "session": { "id": "s-1", "title": "...", "cwd": "...", "updatedAt": 0, "running": true },
  "status": "running",
  "steps": [ ... rows of the newest turn ... ],
  "turn": { "number": 4, "count": 4 },
  "stream": { "thinking": "...", "text": "...", "tools": [] },
  "interaction": null,
  "settings": { "permission": "workspace-write", "model": "", "reasoning": "", "agentPreset": "" },
  "catalogs": { ... },
  "locale": "en",
  "config": { ... },
  "runtime": { "running": true, "visible": true, ... },
  "backgroundRunning": 0
}
```

### Row shape

`steps` rows are the same objects the dock renders:

| Field | Meaning |
|---|---|
| `id` | Stable row id (also the `step-detail` key). |
| `kind` | `tool` (tool call, approval row), `think` (reasoning), `say` (assistant text). |
| `tool` | Tool name for `tool` rows. |
| `description` | Human title of the tool call (empty when the call has none). |
| `command` | One-line summary of the arguments (command, path, pattern…). |
| `status` | `run` \| `done` \| `fail` \| `ask`. |
| `text` | Assistant text or reasoning body, or a truncated tool result. |
| `time` | ISO timestamp of the event. |
| `lines`, `delta` | Optional read range `[from,to]` / edit `[added,removed]` badges. |

Full tool arguments and results are never in the state frame; fetch them with
`step-detail`.

## Minimal client

```text
POST /quickdock/api/select  { "workspaceId": "ws-1", "sessionId": "s-1" }
POST /quickdock/api/task    { "text": "fix the failing test" }
GET  /quickdock/api/stream          -> SSE; state.steps is the newest turn
GET  /quickdock/api/turns?sessionId=s-1
GET  /quickdock/api/turn?sessionId=s-1&turn=3
```

## Write endpoints

| Route | Body | Result |
|---|---|---|
| `POST select` | `{ workspaceId?, sessionId?, newSession? }` | `{ ok, workspaceId, sessionId, newSession }`. Switches the bound workspace/session without summoning the dock. |
| `POST bind` | `{ sessionId }` | `{ ok, dockRunning, starting, error? }`. Binds **and** raises the dock (header-button path). |
| `POST task` | `{ text, sessionId?, workspaceId?, fork? }` | `{ sessionId }`. Prompts the bound/existing session (a new turn) or creates/forks one; an explicit `sessionId` is bound first so its events reach the stream. |
| `POST stop` | – | `{ ok }`. Cancels the running turn of the bound session. |
| `POST answer` | `{ id, outcome? } \| { id, answers? }` | `true` when an interaction was waiting. |
| `POST settings` | `{ permission?, model?, reasoning?, agentPreset? }` | `{ ok, error? }`. |
| `POST theme` / `POST locale` | palette / locale id | Used by the DSH client half; not needed by API clients. |
| `POST open-in-dsh` / `POST open-session` | – | Dock command bus (open the bound session in DSH). |

### Switching

`POST select` is the backend capability the dock UI does not expose:

```http
POST /quickdock/api/select?t=<token>
{ "workspaceId": "ws-2", "sessionId": "s-9" }
```

`sessionId: null` starts a blank conversation, `newSession: true` clears the
binding without touching the workspace. The call is silent: it does not raise or
restart the dock.

The binding is **Host-wide**, not per client: every client that follows
`GET state` / `GET stream` — including the dock — sees the switch. Read-only
inspection of another session does not need a switch: `turns` and `turn` accept
`sessionId` directly.

## Multi-turn model

- A turn opens on DSH's `turn/start` event; its number comes from
  `data.turn`. Rows are attributed to a turn by event sequence
  (`[turn.seq, nextTurn.seq)`).
- Rows are retained per session up to `config.maxSteps` (200 by default) and
  the Host tracks up to 8 sessions (the oldest folder is evicted).
- `GET turns` merges two sources:
  - DSH's `turnOutline` projection: prompt/response previews and boundary
    sequence for **every** turn in the log, including turns that happened before
    this Host attached.
  - Locally folded turns: `rows > 0` only for turns observed while attached.
- `GET turn?turn=N` returns the folded rows of that turn; `observed: false`
  means the turn exists in the log but its rows were never folded (or were
  evicted by `maxSteps`).
- `POST task` on an existing session appends a turn; it does not clear earlier
  turns (the dock simply renders the newest one).

## Interactions (approvals and questions)

When an approval or question targets the bound session **and** the dock input
window is visible, the Host claims it and waits for `POST answer`. Otherwise it
delegates to DSH's own UI. If the dock disappears while a request is claimed, the
Host hands the request back to DSH (the client must not assume it keeps the
claim). A client that renders its own approval UI should mirror the same rule:
claim only while the UI is actually visible.

## Errors

```json
{ "ok": false, "error": "Session not bound" }
```

Unknown routes return `404`; unauthenticated requests return `401`.
