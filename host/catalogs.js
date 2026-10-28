/**
 * Catalog service: permission presets, model list and agent presets.
 *
 * DSH owns all three catalogs; the dock only mirrors them. Nothing here may
 * hard-code an option list (a deployment can add or remove presets).
 */

function text(value, fallback = '') {
  return value === null || value === undefined ? fallback : String(value)
}

function modelContext(model) {
  const value = model?.contextWindow ?? model?.context ?? model?.maxContext ?? 0
  const count = Number(value)
  return Number.isFinite(count) && count > 0 ? count : 0
}

export class CatalogService {
  /**
   * @param {{state: object, dsh: object, t: Function,
   *          trace: (message: unknown) => void,
   *          logger: object, publish: () => void}} deps
   */
  constructor(deps) {
    this.state = deps.state
    this.dsh = deps.dsh
    this.t = deps.t
    this.trace = deps.trace
    this.logger = deps.logger
    this.publish = deps.publish
  }

  /** Permission presets currently offered by this deployment. */
  refreshPermissions() {
    try {
      const presets = this.dsh.permissionPresets
      const catalog = presets?.catalog?.()
      const options = Array.isArray(catalog?.options) ? catalog.options : []
      if (!options.length) return
      this.state.catalogs.permissions = options.map((option) => ({
        value: text(option.value),
        name: text(option.name, text(option.value)),
        description: text(option.description)
      }))
      // Fall back to the deployment default so a menu always has a selection.
      const known = this.state.catalogs.permissions.some((option) => option.value === this.state.settings.permission)
      if (!known) {
        this.state.settings.permission = text(catalog.defaultPreset || this.state.catalogs.permissions[0].value)
      }
    } catch (error) {
      this.trace('permission catalog failed: ' + error)
    }
  }

  /** Agent presets (async: the registry may read from disk). */
  async refreshAgents() {
    try {
      const registry = this.dsh.agentPresets
      if (!registry?.list) return
      const rows = await registry.list()
      if (!Array.isArray(rows)) return
      this.state.catalogs.agents = rows.map((row) => ({
        id: text(row.id),
        name: text(row.name, text(row.id)),
        description: text(row.description)
      }))
    } catch (error) {
      this.trace('agent preset catalog failed: ' + error)
    }
  }

  /** Refresh every catalog and notify pages. */
  refreshAll() {
    this.refreshPermissions()
    void this.refreshAgents().then(this.publish, () => {})
    this.publish()
  }

  /** Model catalog: provider groups flattened into a menu-ready list. */
  async refreshModels() {
    try {
      const controller = this.dsh.sessionController
      if (!controller?.modelCatalog) return
      const catalog = await controller.modelCatalog()
      const models = []
      for (const group of catalog.groups ?? []) {
        for (const model of group.models ?? []) {
          const efforts = model.reasoning?.efforts ?? []
          const reasoningNames = {}
          for (const effort of efforts) {
            if (effort?.id) reasoningNames[effort.id] = text(effort.name, text(effort.id))
          }
          models.push({
            id: group.id + '/' + model.id,
            name: text(model.name, text(model.id)),
            group: text(group.name, text(group.id)),
            // Reasoning efforts travel as ids; the page localizes unknown ids.
            reasoning: efforts.map((effort) => text(effort.id)).filter(Boolean),
            reasoningNames,
            reasoningDefault: text(model.reasoning?.defaultEffort),
            context: modelContext(model)
          })
        }
      }
      this.state.catalogs.models = models
      if (!this.state.settings.model && catalog.default?.provider && catalog.default?.model) {
        this.state.settings.model = catalog.default.provider + '/' + catalog.default.model
        this.state.settings.reasoning = text(catalog.default.reasoningEffort)
      }
      this.publish()
    } catch (error) {
      this.logger?.warn?.('quickdock: model catalog failed: %s', String(error))
      this.trace('model catalog failed: ' + error)
    }
  }

  /** Session object for a bound session (undefined when cold). */
  #session(sessionId) {
    return this.dsh.session(sessionId)
  }

  /**
   * Apply the selected permission preset to a session.
   *
   * permissionPresets.set() writes the preset plus both knobs as durable
   * events, which is what keeps the main window in sync.
   */
  applyPermissionPreset(sessionId) {
    const name = this.state.settings.permission
    if (!sessionId || !name) return false
    try {
      const presets = this.dsh.permissionPresets
      if (!presets?.set) return false
      const session = this.#session(sessionId)
      if (!session) return false
      presets.set(session, name)
      return true
    } catch (error) {
      this.trace('permission set failed: ' + String(error?.message || error))
      return false
    }
  }

  /** Apply the selected model and reasoning effort to a session. */
  async applyModelSelection(sessionId) {
    const selected = this.state.settings.model
    if (!sessionId || !selected) return false
    const split = selected.indexOf('/')
    if (split <= 0) return false
    const provider = selected.slice(0, split)
    const model = selected.slice(split + 1)
    try {
      await this.dsh.sessionController.selectModel({
        sessionId,
        provider,
        model,
        ...(this.state.settings.reasoning ? { reasoningEffort: this.state.settings.reasoning } : {})
      })
      return true
    } catch (error) {
      this.logger?.warn?.('quickdock: selectModel failed: %s', String(error))
      this.trace('selectModel failed: ' + String(error?.message || error))
      return false
    }
  }

  /**
   * Read the session's real permission/model back into the dock settings.
   *
   * Binding an existing session must show that session's state, not the dock's
   * last selection (otherwise "full access" is displayed for a read-only run).
   */
  syncSettingsFromSession(sessionId) {
    const session = this.#session(sessionId)
    if (!session) return
    try {
      const preset = this.dsh.permissionPresets?.current?.(session)
      if (typeof preset === 'string' && preset) this.state.settings.permission = preset
    } catch (_) {
      /* optional */
    }
    try {
      const selection = this.dsh.projectionState(session, 'modelSelection')
      const active = selection?.pending ?? selection?.lastUsed
      if (active?.provider && active?.model) {
        this.state.settings.model = active.provider + '/' + active.model
        this.state.settings.reasoning = text(active.reasoningEffort)
      }
    } catch (_) {
      /* optional */
    }
  }
}

export { text as catalogText }
