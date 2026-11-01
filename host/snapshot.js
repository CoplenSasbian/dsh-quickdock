/**
 * State snapshot builder.
 *
 * The dock page renders from a single immutable-looking JSON object pushed over
 * SSE, so every field it needs is assembled here and nowhere else.
 */

/**
 * @param {{config: object, state: object, dsh: object, index: object,
 *          hub: object, stream: object}} deps
 * @returns {() => object} snapshot producer.
 */
export function createSnapshotBuilder(deps) {
  const { config, state, dsh, index, hub, stream, goal } = deps

  return function snapshot() {
    const workspaces = dsh.workspaces().map((row) => ({ id: row.id, name: row.name, path: row.path }))
    const liveSession = dsh.session(state.sessionId)
    const meta = index.meta(state.sessionId)
    const folder = state.sessionId ? state.folders.get(state.sessionId) : null
    const latestTurn = folder ? folder.latestTurn() : null
    const running = dsh.agentStatus(state.sessionId) === 'running'
    const backgroundRunning = dsh
      .runningAgents()
      .filter((agent) => agent?.status === 'running' && agent.id !== state.sessionId).length

    return {
      workspaceId: state.workspaceId,
      sessionId: state.sessionId,
      newSession: state.newSession,
      workspaces,
      session: state.sessionId
        ? {
            id: state.sessionId,
            title: index.title(state.sessionId, liveSession),
            cwd: meta?.cwd || liveSession?.header?.cwd || '',
            updatedAt: meta?.updatedAt ?? index.lastPromptAt(liveSession) ?? (liveSession?.header?.createdAt ?? 0),
            // A live agent is the current truth; the index flag is the fallback.
            running: running || Boolean(meta?.running)
          }
        : null,
      // 'ask' switches the input window into its waiting form.
      status: state.interaction?.status === 'open' ? 'ask' : (running ? 'running' : 'idle'),
      // The dock renders the latest turn only; other clients read the retained
      // turns through GET /quickdock/api/turns and /turn.
      steps: folder ? folder.rows() : [],
      // The agent's task list (todo_write), newest wins. Empty when it has none.
      todos: folder && Array.isArray(folder.todos) ? folder.todos : [],
      // Visible only when the host can read one; the card hides the line otherwise.
      goal: typeof goal === 'function' ? goal() : null,
      // The run window renders the turn as a DSH process block: the header shows
      // how many steps it holds and how long it took, so the timing travels with it.
      turn: latestTurn === null ? null : {
        number: latestTurn,
        count: folder.turnCount,
        steps: folder.rows().length,
        startedAt: folder.turns[folder.turns.length - 1].time || '',
        endedAt: folder.turns[folder.turns.length - 1].endedAt || ''
      },
      stream: stream.current(),
      interaction: state.interaction,
      settings: Object.assign({}, state.settings),
      catalogs: Object.assign({}, state.catalogs),
      locale: state.locale,
      config: {
        width: config.width,
        margin: config.margin,
        hideOnEscape: config.hideOnEscape,
        followBoundOnly: config.followBoundOnly,
        thinkMode: config.thinkMode,
        showTiming: config.showTiming,
        submitMode: config.submitMode
      },
      runtime: Object.assign({}, state.dock, { sse: hub.sseSize }),
      backgroundRunning
    }
  }
}
