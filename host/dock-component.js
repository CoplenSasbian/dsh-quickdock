/**
 * The dock component: everything that owns a window.
 *
 * The Host API (service component) is client-agnostic and works without it; this
 * component adds the Electron supervisor and the window-facing operations. It is mounted from the same Host object but has its own file and
 * lifecycle, so a headless deployment simply never mounts it.
 */

import { DockProcess } from './dock-process.js'

/**
 * Create the dock component.
 * @param {object} deps host services and state.
 * @returns {{enabled: boolean, dock: object|null, mount: Function, dispose: Function, summon: Function, setSupervisor: Function}} component.
 */
export function createDockComponent(deps) {
  const {
    config,
    state,
    dsh,
    locale,
    resolver,
    trace,
    tracePath,
    publish,
    pageUrl,
    onInactive,
    rootDir,
  } = deps

  let enabled = config.dock !== false
  let dock = null
  // A caller-supplied supervisor (tests, or a host that owns one already).
  let override = null

  /** Build the supervisor lazily: a headless host never touches Electron. */
  function ensure() {
    if (!enabled) return null
    if (override) return override
    if (dock) return dock
    dock = new DockProcess({
      state,
      config,
      rootDir,
      token: deps.token,
      pageUrl,
      resolver,
      logger: dsh.logger,
      trace,
      t: (key, params) => locale.t(key, params),
      publish,
      onInactive
    })
    dock.tracePath = tracePath
    return dock
  }

  return {
    get enabled() { return enabled },
    get dock() { return override || dock },

    /**
     * Use this supervisor instead of the lazily created one.
     * @param {object|null} supervisor supervisor to use, or null to restore.
     */
    setSupervisor(supervisor) {
      override = supervisor || null
    },

    /**
     * Mount the component.
     * @param {{dock?: boolean}} [options] allow the host to force it off.
     * @returns {boolean} whether the component is mounted.
     */
    mount(options) {
      enabled = options && typeof options.dock === 'boolean' ? options.dock !== false : enabled
      if (!enabled) {
        trace('dock component disabled: no window will be created')
        return false
      }
      ensure()
      return true
    },

    /** Tear the component down: the process goes with it. */
    dispose() {
      if (dock) dock.stop()
      dock = null
      enabled = false
    },

    /** Summon the windows (false when the component is disabled). */
    summon() {
      const supervisor = ensure()
      return supervisor ? supervisor.summon() !== false : false
    },

    /** Collapse the window into the floating ball. */
    collapse() {
      const supervisor = ensure()
      if (!supervisor) return false
      supervisor.collapse?.()
      return true
    },

    /** Bring the window to the foreground (queued while it is still starting). */
    focus() {
      const supervisor = ensure()
      if (!supervisor) return false
      supervisor.focus?.()
      return true
    }
  }
}
