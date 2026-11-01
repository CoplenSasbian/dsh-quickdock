/* QuickDock page bootstrap.
 *
 * One script serves both windows: window.__QD_VIEW__ selects the input window
 * (composer, function keys, run panel) or the display window (step list).
 *
 * Transport: same-origin /quickdock/api/* with a Bearer token (from ?t=,
 * remembered per session), SSE for state / theme / locale payloads, and the
 * optional window.quickDock preload bridge for click-through and window control.
 */
(function () {
  'use strict';

  var U = window.QD.util;
  var i18n = window.QD.i18n;
  var t = i18n.t;

  /* ------------------------------- transport ------------------------------- */

  var params = new URLSearchParams(location.search);
  var TOKEN = params.get('t') || sessionStorage.getItem('qd-token') || '';
  if (TOKEN) sessionStorage.setItem('qd-token', TOKEN);

  /** Call one API endpoint; the Host puts the reason in the body on failure. */
  function api(path, body) {
    return fetch('/quickdock/api/' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? { Authorization: 'Bearer ' + TOKEN }
        : { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    }).then(function (response) {
      return response.json().catch(function () { return null; }).then(function (data) {
        if (data && data.ok === false && data.error) throw new Error(String(data.error));
        if (!response.ok) {
          throw new Error(data && data.error ? String(data.error) : t('error.http', { status: response.status }));
        }
        return data;
      });
    });
  }

  /* ---------------------------------- dom ---------------------------------- */

  var VIEW = window.__QD_VIEW__ === 'display' ? 'display' : 'input';
  var isDisplay = VIEW === 'display';
  var displayView = null;
  // The <title> is static markup; the localized variant comes from the catalog.
  var titleKey = isDisplay ? 'app.displayTitle' : 'app.inputTitle';
  var localizedTitle = t(titleKey);
  document.title = localizedTitle === titleKey ? 'QuickDock' : localizedTitle;

  var els = {
    panelA: U.$('panelA'),
    wsName: U.$('wsName'), sessTitle: U.$('sessTitle'), sessMeta: U.$('sessMeta'),
    composerHost: U.$('composerHost'), newBtn: U.$('newBtn'),
    statusDot: U.$('statusDot'),
    menu: U.$('menu'), toast: U.$('toast'),
    confirm: U.$('confirm'), confirmOk: U.$('confirmOk'), confirmCancel: U.$('confirmCancel'),
    pinBtnA: U.$('pinBtnA'), hideBtnA: U.$('hideBtnA'), listBtn: U.$('listBtn'), openBtn: U.$('openBtn'),
    drows: U.$('drows'),
    stopBtnRun: U.$('stopBtnRun'),
    runLine: U.$('runLine'), runDot: U.$('runDot'), runLineLabel: U.$('runLineLabel'),
    runLineName: U.$('runLineName'), runLineArgs: U.$('runLineArgs'),
    runApproval: U.$('runApproval'), runApprovalTool: U.$('runApprovalTool'),
    runApprovalReason: U.$('runApprovalReason'), runAllow: U.$('runAllow'), runDeny: U.$('runDeny')
  };
  if (isDisplay) {
    // The display window only has the row container and the toast.
    ['panelA', 'wsName', 'sessTitle', 'sessMeta', 'composerHost', 'newBtn',
      'statusDot', 'menu',
      'confirm', 'confirmOk', 'confirmCancel', 'pinBtnA', 'hideBtnA', 'listBtn', 'openBtn',
      'stopBtnRun', 'runApproval',
      'runApprovalTool', 'runApprovalReason', 'runAllow', 'runDeny'].forEach(function (key) {
      els[key] = null;
    });
  } else {
    els.drows = null;
  }

  /* -------------------------------- composer ------------------------------- */

  /**
   * The composer is a DSH render island; the page keeps the behaviour and gets
   * a small imperative handle back.
   * @type {{setValue: Function, getValue: Function, clear: Function,
   *         focus: Function, setMarks: Function, setDisabled: Function}|null}
   */
  var composer = null;
  if (!isDisplay && els.composerHost && window.QD && window.QD.composer) {
    composer = window.QD.composer.create({
      host: els.composerHost,
      placeholder: t('composer.placeholder'),
      label: t('composer.label'),
      sendTitle: t('composer.send'),
      onSubmit: function (text) { send(text); },
      onOpenMenu: function (kind, anchor) { openKeyMenu(kind, anchor); }
    });
  }

  /* --------------------------------- state --------------------------------- */

  var state = null;
  var connected = false;
  var pendingFork = false;

  /* --------------------------------- theme --------------------------------- */

  var FALLBACK = {
    dark: {
      '--qd-bg-base': '#1b1b1c', '--qd-bg-layer-1': '#232324', '--qd-bg-layer-2': '#2a2a2b',
      '--qd-bg-overlay': '#232324', '--qd-border-l1': '#333335', '--qd-border-l2': '#3d3d40',
      '--qd-label-primary': '#e9e9ea', '--qd-label-secondary': '#9a9a9d', '--qd-label-tertiary': '#6b6b6e',
      '--qd-brand-primary': '#4d8eff', '--qd-state-success': '#3ecf8e', '--qd-state-error': '#f05252',
      '--qd-state-warn': '#f5a623', '--qd-state-idle': '#6b6b6e'
    },
    light: {
      '--qd-bg-base': '#ffffff', '--qd-bg-layer-1': '#f6f7f8', '--qd-bg-layer-2': '#f0f1f3',
      '--qd-bg-overlay': '#ffffff', '--qd-border-l1': '#e3e4e6', '--qd-border-l2': '#d0d1d4',
      '--qd-label-primary': '#1c1c1e', '--qd-label-secondary': '#5f6066', '--qd-label-tertiary': '#96989e',
      '--qd-brand-primary': '#2b6cf6', '--qd-state-success': '#17a673', '--qd-state-error': '#d93636',
      '--qd-state-warn': '#d98300', '--qd-state-idle': '#96989e'
    }
  };

  var appliedTokenKeys = [];

  function applyTheme(payload) {
    // The Host sends an empty frame until the Client half reports a palette;
    // keep the first-paint scheme instead of forcing the fallback one.
    if (!payload || !payload.tokens) return;
    var scheme = payload.colorScheme === 'light' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', scheme);
    var root = document.documentElement.style;
    var tokens = payload.tokens || {};
    // A partial theme would look broken: fall back to the built-in palette.
    var incomplete = !tokens['--qd-bg-base'] || !tokens['--qd-label-primary'];
    var source = incomplete ? FALLBACK[scheme] : tokens;
    var next = Object.keys(source);
    // Drop variables only the previous palette supplied, so the stylesheet's
    // own light/dark values take over again instead of going stale.
    appliedTokenKeys.forEach(function (key) {
      if (next.indexOf(key) < 0) root.removeProperty(key);
    });
    next.forEach(function (key) {
      root.setProperty(key, source[key]);
    });
    appliedTokenKeys = next;
    if (payload.fonts) {
      if (payload.fonts.text) root.setProperty('--qd-font-text', payload.fonts.text);
      if (payload.fonts.code) root.setProperty('--qd-font-code', payload.fonts.code);
      if (payload.fonts.sizeText) root.setProperty('--qd-font-size-text', payload.fonts.sizeText + 'px');
      if (payload.fonts.sizeCode) root.setProperty('--qd-font-size-code', payload.fonts.sizeCode + 'px');
    }
  }

  /* --------------------------------- toast --------------------------------- */

  function toast(message) {
    if (!els.toast) {
      console.log('[QuickDock] ' + message);
      return;
    }
    els.toast.textContent = message;
    els.toast.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () {
      els.toast.hidden = true;
    }, 4000);
  }

  function toastError(error) {
    toast(String(error && error.message || error));
  }

  /* ---------------------------------- SSE ---------------------------------- */

  var source = null;
  var reconnectTimer = null;

  function connectStream() {
    if (!TOKEN) return;
    if (source) {
      try {
        source.close();
      } catch (error) {
        /* ignore */
      }
    }
    source = new EventSource('/quickdock/api/stream?t=' + encodeURIComponent(TOKEN));
    source.addEventListener('state', function (event) {
      try {
        applyState(JSON.parse(event.data));
      } catch (error) {
        /* malformed frame: keep the last state */
      }
    });
    source.addEventListener('theme', function (event) {
      try {
        applyTheme(JSON.parse(event.data));
      } catch (error) {
        /* ignore */
      }
    });
    source.addEventListener('locale', function (event) {
      try {
        var payload = JSON.parse(event.data);
        if (!i18n.setPayload(payload)) return;
        if (menu && menu.isOpen()) menu.close();
        render();
      } catch (error) {
        /* ignore */
      }
    });
    source.onerror = function () {
      connected = false;
      markOffline();
      if (reconnectTimer) return;
      reconnectTimer = setTimeout(function () {
        reconnectTimer = null;
        connectStream();
      }, 2000);
    };
    source.onopen = function () {
      if (connected) return;
      connected = true;
      api('state').then(applyState).catch(function () {});
    };
  }

  function markOffline() {
    document.body.classList.add('offline');
  }

  function applyState(next) {
    if (!next) return;
    state = next;
    connected = true;
    document.body.classList.remove('offline');
    render();
  }

  /* ------------------------------ window height ------------------------------ */

  var reportedHeight = 0;

  /**
   * Keep the window exactly as tall as the panel.
   *
   * The composer grows with the text and the detail line appears with a call, so
   * a fixed height either clips the composer or leaves a band of nothing. The
   * panel is therefore sized by its content and this reports that height to the
   * runtime, which keeps the bottom edge fixed.
   */
  function syncWindowHeight() {
    var panel = els.panelA;
    var quickDock = window.quickDock;
    if (!panel || !quickDock || !quickDock.setContentHeight) return;
    // .stack pads 10px top and bottom around the panel.
    var height = Math.ceil(panel.getBoundingClientRect().height) + 20;
    // Before the first render the panel is a stub: reporting it would shrink the
    // window to the clamp and flash.
    if (height < 160 || Math.abs(height - reportedHeight) < 2) return;
    reportedHeight = height;
    try {
      var pending = quickDock.setContentHeight(height);
      if (pending && typeof pending.catch === 'function') pending.catch(function () {});
    } catch (error) {
      /* the bridge is optional outside Electron */
    }
  }

  if (window.ResizeObserver && els.panelA) {
    new window.ResizeObserver(function () { syncWindowHeight(); }).observe(els.panelA);
  }

  /* ------------------------------ detail mode ------------------------------ */

  /**
   * How the execution detail line behaves. One button cycles the modes:
   *  - auto:   shown while a tool runs, hidden once the turn settles
   *  - open:   always shown, so the last call stays readable after it finished
   *  - closed: never shown
   */
  var DETAIL_KEY = 'qd-detail-mode';
  var DETAIL_MODES = ['auto', 'open', 'closed', 'hidden'];
  var DETAIL_LABELS = {
    auto: 'detail.auto',
    open: 'detail.open',
    closed: 'detail.closed',
    hidden: 'detail.hidden'
  };
  var detailMode = readDetailMode();

  function readDetailMode() {
    try {
      var saved = localStorage.getItem(DETAIL_KEY);
      return DETAIL_MODES.indexOf(saved) >= 0 ? saved : 'auto';
    } catch (error) {
      return 'auto';
    }
  }

  function writeDetailMode(value) {
    detailMode = DETAIL_MODES.indexOf(value) >= 0 ? value : 'auto';
    try {
      localStorage.setItem(DETAIL_KEY, detailMode);
    } catch (error) {
      /* storage may be unavailable */
    }
  }

  /** Reflect the mode on the button and re-render the line it controls. */
  function syncListButton() {
    var button = els.listBtn;
    if (button) {
      var closed = detailMode === 'closed';
      button.classList.toggle('off', closed);
      button.setAttribute('aria-pressed', closed ? 'false' : 'true');
      var label = t(DETAIL_LABELS[detailMode]);
      button.title = label;
      button.setAttribute('aria-label', label);
    }
    renderRunLine();
    refreshDisplayVisibility();
  }

  window.addEventListener('storage', function (event) {
    if (event.key !== DETAIL_KEY) return;
    detailMode = readDetailMode();
    syncListButton();
  });

  /**
   * Show or hide the docked execution window.
   * The button decides what it does:
   *  auto   - open while a turn runs, closed once it settles
   *  open   - keep it whenever there is anything to show
   *  closed - never
   */
  function refreshDisplayVisibility() {
    var steps = (state && state.steps) || [];
    var interaction = state && state.interaction;
    var hasInter = Boolean(interaction && interaction.status === 'open');
    var stream = state && state.stream;
    var hasContent = Boolean(steps.length || hasInter
      || (stream && (stream.text || stream.thinking || (stream.tools && stream.tools.length))));
    var busy = Boolean(state && isBusy(state.status));
    // Only "hidden" closes the window; the other modes decide how the rows
    // inside it are folded, which the docked page handles itself.
    var show = detailMode !== 'hidden' && (hasContent || busy);
    var quickDock = window.quickDock;
    if (!quickDock || !quickDock.setDisplayEmpty) return;
    try {
      quickDock.setDisplayEmpty(!show);
    } catch (error) {
      /* IPC is optional outside Electron */
    }
  }

  /* -------------------------------- rendering -------------------------------- */

  function currentWorkspace() {
    if (!state) return null;
    return state.workspaces.find(function (row) {
      return row.id === state.workspaceId;
    }) || null;
  }

  var REASONING_IDS = ['low', 'medium', 'high', 'max'];

  function currentModel() {
    var models = (state && state.catalogs.models) || [];
    return models.find(function (model) {
      return model.id === state.settings.model;
    }) || null;
  }

  /** Localized label for a reasoning effort id. */
  function reasoningLabel(id) {
    if (!id) return '';
    var model = currentModel();
    var named = model && model.reasoningNames && model.reasoningNames[id];
    if (named) return named;
    var key = 'reasoning.' + id;
    var translated = t(key);
    return translated === key ? id : translated;
  }

  function render() {
    if (!state) return;
    if (isDisplay) {
      if (displayView) displayView.render(state);
      return;
    }
    var workspace = currentWorkspace();

    els.wsName.textContent = workspace ? workspace.name : t('bar.noWorkspace');
    els.sessTitle.textContent = state.session ? state.session.title : t('bar.newSessionTitle');
    els.sessTitle.classList.toggle('blank', !state.session);
    els.sessMeta.textContent = state.session ? U.relTime(state.session.updatedAt || 0) : '';

    if (composer) {
      var permission = (state.catalogs.permissions || []).find(function (option) {
        return option.value === state.settings.permission;
      });
      var model = currentModel();
      var preset = (state.catalogs.agents || []).find(function (agent) {
        return agent.id === state.settings.agentPreset;
      });
      composer.setMarks({
        permission: permission ? permission.name : (state.settings.permission || t('key.permission')),
        model: model ? model.name : (state.settings.model ? state.settings.model.split('/')[1] : t('key.model')),
        thinking: state.settings.reasoning ? reasoningLabel(state.settings.reasoning) : t('key.thinking'),
        agent: preset ? preset.name : (state.settings.agentPreset || t('key.agent')),
        agentVisible: Boolean(state.newSession)
      });
    }


    applyRunMode(state.status);
    updatePin();
    refreshDisplayVisibility();
  }

  /** Whether the agent is busy (the composer would be meaningless). */
  function isBusy(status) {
    return status === 'running' || status === 'ask'
      || Boolean(state && state.interaction && state.interaction.status === 'open');
  }

  /**
   * While the agent works the bar grows a stop button; the composer never moves.
   * @param {string} status agent status.
   */
  function applyRunMode(status) {
    var busy = isBusy(status);
    if (els.stopBtnRun) els.stopBtnRun.classList.toggle('hidden', !busy);
    renderRunLine();
    renderApproval();
    // The panel decides dragging/hit regions: re-report after the bar changes.
    scheduleHitReport();
    syncListButton();
  }

  /** Tool name -> the label DSH prints before the dot. */
  var TOOL_LABELS = [
    [/^(read)$/i, 'display.tool.read'],
    [/^(read_image)$/i, 'display.tool.read'],
    [/^(write)$/i, 'display.tool.write'],
    [/^(edit|edit_file|str_replace_editor)$/i, 'display.tool.edit'],
    [/^(grep|glob|fs_search)$/i, 'display.tool.search'],
    [/^(bash|pwsh|shell|terminal)$/i, 'display.tool.commands'],
    [/^(run_code|ptc|workflow)$/i, 'display.tool.code'],
    [/^(web_search|web_fetch)$/i, 'display.tool.web']
  ];

  /**
   * Label for one tool name; the DSH rule is the bare name, so the ops_ prefix
   * some runtimes add is stripped before matching.
   * @param {string} name raw tool name.
   * @returns {{label: string, known: boolean}} localized label and whether the
   *   name matched a known kind (unknown tools keep their name in the line).
   */
  function toolLabel(name) {
    var bare = String(name || '').replace(/^ops_/i, '');
    for (var index = 0; index < TOOL_LABELS.length; index += 1) {
      if (TOOL_LABELS[index][0].test(bare)) {
        return { label: t(TOOL_LABELS[index][1]), known: true };
      }
    }
    return { label: t('display.toolFallback'), known: false };
  }

  /**
   * One line naming what the agent is doing right now.
   *
   * Shape: dot - label - text - stop. The dot and the stop button live in this
   * bar instead of the title bar, so the title keeps only the session.
   * Priority: live reasoning, then the running tool, then "working".
   */
  function renderRunLine() {
    if (!els.runLine || !state) return;
    var running = state.status === 'running';
    if (!running) {
      els.runLine.classList.add('hidden');
      return;
    }
    els.runLine.classList.remove('hidden');

    var stream = state.stream || {};
    var thinking = lastThinkingLine(stream.thinking);
    if (els.runDot) els.runDot.className = 'rl-dot' + (thinking ? ' thinking' : ' running');

    if (thinking) {
      els.runLineLabel.textContent = t('run.thinking');
      els.runLineName.hidden = true;
      els.runLineArgs.hidden = false;
      els.runLineArgs.textContent = thinking;
      return;
    }

    var current = null;
    var index = 0;
    if (stream.tools && stream.tools.length) {
      current = stream.tools[stream.tools.length - 1];
    }
    if (!current) {
      var steps = state.steps || [];
      for (index = steps.length - 1; index >= 0; index -= 1) {
        var step = steps[index];
        if (step && step.kind === 'tool' && step.status === 'run') {
          current = step;
          break;
        }
      }
    }
    if (!current) {
      els.runLineLabel.textContent = t('run.executing');
      els.runLineName.hidden = true;
      els.runLineArgs.hidden = true;
      return;
    }

    var name = String(current.name || current.tool || '');
    var label = toolLabel(name);
    // Live stream drafts carry raw arguments; folded rows carry either a
    // summary or the JSON tail the Host keeps for unnamed tools.
    var args = current.args !== undefined && current.args !== null && typeof current.args === 'object'
      ? U.compactArgs(current.args)
      : (current.command || current.args || current.description || '');
    els.runLineLabel.textContent = label.label;
    // Always say which tool ran: bash and pwsh, grep and glob share a label.
    els.runLineName.hidden = !name;
    els.runLineName.textContent = name;
    els.runLineArgs.hidden = !args;
    els.runLineArgs.textContent = String(args || '');
  }

  /**
   * Last meaningful line of the reasoning stream.
   * @param {string} text accumulated thinking text.
   * @returns {string} one short line, empty when there is nothing to say.
   */
  function lastThinkingLine(text) {
    var source = String(text || '');
    if (!source) return '';
    var parts = source.split(/\n+/);
    for (var index = parts.length - 1; index >= 0; index -= 1) {
      // Stream deltas are fragments: drop the punctuation a tail can start with
      // so the line does not read "... , so the title...".
      var line = parts[index].trim().replace(/^[,.;:!?)\]]+\s*/, '');
      if (line) return U.shortText(line, 90);
    }
    return '';
  }

  /** Show the pending approval, if one is waiting for an answer. */
  function renderApproval() {
    if (!els.runApproval || !state) return;
    var interaction = state.interaction;
    var approval = interaction && interaction.status === 'open' && interaction.kind === 'approval'
      ? interaction
      : null;
    els.runApproval.hidden = !approval;
    if (!approval) return;
    var reason = approvalText(approval);
    els.runApprovalTool.textContent = approval.toolName ? String(approval.toolName) : '';
    els.runApprovalReason.textContent = reason;
    els.runApprovalReason.hidden = !reason;
    els.runApprovalReason.title = reason;
  }

  /** Approval text: current locale first, then Chinese, then the raw reason. */
  function approvalText(interaction) {
    var localized = interaction && interaction.displayReason;
    if (localized && typeof localized === 'object') {
      var picked = localized[i18n.locale()] || localized.zh || localized.en;
      if (typeof picked === 'string' && picked.trim()) return picked.trim();
    }
    if (typeof localized === 'string' && localized.trim()) return localized.trim();
    return String((interaction && (interaction.reason || interaction.callId)) || '');
  }

  function updatePin() {
    var pinned = Boolean(state && state.runtime && state.runtime.alwaysOnTop);
    [els.pinBtnA].forEach(function (button) {
      if (!button) return;
      button.classList.toggle('on', pinned);
      button.setAttribute('aria-pressed', pinned ? 'true' : 'false');
    });
  }

  /* ---------------------------------- menu ---------------------------------- */

  var menu = null;
  if (els.menu) {
    menu = window.QD.menu.create({
      menuEl: els.menu,
      getPanel: function () {
        return els.panelA && !els.panelA.classList.contains('hidden') ? els.panelA : null;
      },
      t: t,
      onLayout: function () {
        scheduleHitReport();
      }
    });
  }

  if (isDisplay && els.drows) {
    displayView = window.QD.display.create({
      root: els.drows,
      api: api,
      getState: function () {
        return state;
      },
      // The docked window is shown/hidden by setDisplayEmpty; there is no
      // separate list flag any more.
      isListHidden: function () {
        return false;
      },
      scheduleHitReport: function () {
        scheduleHitReport();
      },
      toastError: toastError,
      onAnswered: function () {
        scheduleHitReport();
      }
    });
  }

  /* --------------------------- function-key menus --------------------------- */

  function requireState() {
    if (state) return true;
    toast(t('menu.notConnected'));
    return false;
  }

  /** Turn a list of options into menu entries with a "picked" marker. */
  function selectItems(rows, selected, onPick) {
    return rows.map(function (row) {
      return {
        name: row.name,
        sub: row.sub || '',
        group: row.group || '',
        sel: row.value === selected,
        onPick: function () {
          onPick(row.value);
        }
      };
    });
  }

  function openPermissionMenu(owner) {
    var rows = (state.catalogs.permissions || []).map(function (option) {
      return { name: option.name, sub: option.description || '', value: option.value };
    });
    menu.open(owner, t('menu.permissionTitle'), selectItems(rows, state.settings.permission, function (value) {
      // Full access is irreversible for the turn and prompts like DSH does.
      if (value === 'danger-full-access') {
        confirmDanger(function () {
          api('settings', { permission: value }).catch(toastError);
        });
        return;
      }
      api('settings', { permission: value }).catch(toastError);
    }));
  }

  function modelMenuItems() {
    return (state.catalogs.models || []).map(function (model) {
      return {
        name: model.name,
        sub: model.context ? t('menu.context', { count: model.context.toLocaleString() }) : '',
        group: model.group || '',
        sel: model.id === state.settings.model,
        onPick: function () {
          api('settings', { model: model.id, reasoning: '' }).catch(toastError);
        }
      };
    });
  }

  function openModelMenu(owner, catalogs) {
    if (!state) return;
    if (catalogs && Array.isArray(catalogs.models)) {
      state.catalogs = catalogs;
      render();
    }
    var items = modelMenuItems();
    menu.open(owner, t('menu.modelTitle'), items.length
      ? items
      : [{ name: state.catalogs.models.length ? t('menu.loading') : t('menu.noModels'), disabled: true }]);
  }

  function openThinkingMenu(owner) {
    var model = currentModel();
    var ids = model && model.reasoning && model.reasoning.length ? model.reasoning : REASONING_IDS;
    var items = ids.map(function (id) {
      return {
        name: reasoningLabel(id),
        sel: id === state.settings.reasoning,
        onPick: function () {
          api('settings', { reasoning: id }).catch(toastError);
        }
      };
    });
    items.push({
      name: t('menu.off'),
      sel: !state.settings.reasoning,
      onPick: function () {
        api('settings', { reasoning: '' }).catch(toastError);
      }
    });
    menu.open(owner, t('menu.thinkingTitle'), items);
  }

  function openAgentMenu(owner) {
    var items = (state.catalogs.agents || []).map(function (agent) {
      return {
        name: agent.name,
        sub: agent.description || '',
        sel: agent.id === state.settings.agentPreset,
        onPick: function () {
          api('settings', { agentPreset: agent.id }).catch(toastError);
        }
      };
    });
    if (!items.length) {
      items = [{
        name: t('menu.defaultAgent'),
        sel: true,
        onPick: function () {
          api('settings', { agentPreset: '' }).catch(toastError);
        }
      }];
    }
    menu.open(owner, t('menu.agentTitle'), items);
  }

  /**
   * Open one function-key menu.
   * @param {string} kind 'permission' | 'model' | 'thinking' | 'agent'.
   * @param {HTMLElement} owner anchor element supplied by the composer island.
   */
  function openKeyMenu(kind, owner) {
    if (!requireState()) return;
    if (kind === 'permission') { openPermissionMenu(owner); return; }
    if (kind === 'thinking') { openThinkingMenu(owner); return; }
    if (kind === 'agent') { openAgentMenu(owner); return; }
    if (kind !== 'model') return;
    var items = modelMenuItems();
    if (!items.length) {
      api('catalogs').then(function (catalogs) {
        openModelMenu(owner, catalogs);
      }).catch(toastError);
      return;
    }
    menu.open(owner, t('menu.modelTitle'), items);
    // Refresh the catalog in the background for the next open.
    api('catalogs').then(function (catalogs) {
      if (catalogs && Array.isArray(catalogs.models)) state.catalogs = catalogs;
    }).catch(function () {});
  }

  /* ------------------------------- composer ------------------------------- */

  /**
   * Send one message; the composer island calls this on Enter and on the button.
   * @param {string} [draft] text the island already read from its input.
   */
  function send(draft) {
    var text = String(draft || (composer ? composer.getValue() : '')).trim();
    if (!text) return;
    if (composer) composer.clear();
    var body = { text: text, fork: pendingFork };
    if (!state.sessionId) body.workspaceId = state.workspaceId || undefined;
    api('task', body).then(function () {
      pendingFork = false;
    }).catch(function (error) {
      toastError(error);
      if (composer) composer.setValue(text);
    });
  }

  if (!isDisplay) {

    U.on(els.newBtn, 'click', function (event) {
      event.stopPropagation();
      if (event.shiftKey || event.altKey) {
        // Fork: inherit the current history, then diverge (DESIGN D2).
        if (!state.sessionId) {
          toast(t('menu.noSessionToFork'));
          return;
        }
        pendingFork = true;
        toast(t('menu.forkArmed'));
        return;
      }
      api('select', { newSession: true }).catch(toastError);
    });

    U.on(els.stopBtnRun, 'click', function () {
      api('stop', {}).catch(toastError);
    });

    U.on(els.runAllow, 'click', function (event) {
      event.stopPropagation();
      answerApproval('allow');
    });
    U.on(els.runDeny, 'click', function (event) {
      event.stopPropagation();
      answerApproval('deny');
    });
  }

  /** Answer the open approval in place (input window block). */
  function answerApproval(outcome) {
    var interaction = state && state.interaction;
    if (!interaction || interaction.status !== 'open') return;
    api('answer', { id: interaction.id, outcome: outcome }).catch(toastError);
    interaction.status = 'answered';
    render();
  }

  /* ------------------------------ shared buttons ------------------------------ */

  function openInDsh() {
    if (!state || !state.sessionId) {
      toast(t('error.noSession'));
      return;
    }
    api('open-in-dsh', {}).catch(toastError);
  }

  function togglePin() {
    var next = !(state && state.runtime && state.runtime.alwaysOnTop);
    api('window', { alwaysOnTop: next }).catch(toastError);
    if (window.quickDock && window.quickDock.setAlwaysOnTop) window.quickDock.setAlwaysOnTop(next);
  }

  function hideWindow() {
    if (window.quickDock && window.quickDock.hide) window.quickDock.hide();
  }

  U.on(els.openBtn, 'click', function (event) {
    event.stopPropagation();
    openInDsh();
  });
  U.on(els.pinBtnA, 'click', function (event) {
    event.stopPropagation();
    togglePin();
  });
  U.on(els.listBtn, 'click', function (event) {
    event.stopPropagation();
    writeDetailMode(DETAIL_MODES[(DETAIL_MODES.indexOf(detailMode) + 1) % DETAIL_MODES.length]);
    syncListButton();
  });
  U.on(els.hideBtnA, 'click', hideWindow);

  /* -------------------------------- confirm -------------------------------- */

  var confirmCallback = null;

  function confirmDanger(callback) {
    confirmCallback = callback;
    els.confirm.hidden = false;
  }

  U.on(els.confirmOk, 'click', function () {
    els.confirm.hidden = true;
    if (confirmCallback) {
      var callback = confirmCallback;
      confirmCallback = null;
      callback();
    }
  });
  U.on(els.confirmCancel, 'click', function () {
    els.confirm.hidden = true;
    confirmCallback = null;
  });

  /* -------------------------------- keyboard -------------------------------- */

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') {
      if (els.confirm && !els.confirm.hidden) {
        els.confirm.hidden = true;
        return;
      }
      if (menu && menu.isOpen()) {
        menu.close();
        return;
      }
      hideWindow();
    }
    // Number keys answer a single-choice question, unless the user is typing.
    var interaction = state && state.interaction;
    var typing = document.activeElement && /^(TEXTAREA|INPUT)$/.test(document.activeElement.tagName);
    if (!interaction || interaction.status !== 'open' || interaction.kind !== 'question') return;
    if (!/^[0-9]$/.test(event.key) || typing || (menu && menu.isOpen())) return;
    var question = (interaction.questions || [])[0];
    var choice = Number(event.key) - 1;
    if (!question || !question.options || !question.options[choice]) return;
    api('answer', {
      id: interaction.id,
      answers: [{ id: question.id, selected: [question.options[choice].label] }]
    }).catch(toastError);
    interaction.status = 'answered';
    render();
  });

  /* ------------------------------ click-through ------------------------------ */
  // The window is click-through by default; the page reports which rectangles
  // are interactive and the Host toggles hit-testing from the cursor position.

  var DRAG_SELECTOR = '.bar, .sess-head, .exec-head, .run-head';
  var hitReportTimer = null;

  function collectRects(selector) {
    var rects = [];
    var nodes = document.querySelectorAll(selector);
    for (var i = 0; i < nodes.length; i += 1) {
      var node = nodes[i];
      if (node.hidden || node.classList.contains('hidden')) continue;
      var rect = node.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      rects.push({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
    }
    return rects;
  }

  function reportHitRegions() {
    var quickDock = window.quickDock;
    if (!quickDock) return;
    if (isDisplay) {
      // The display window is interactive only where content sits, so the gaps
      // between rows stay transparent and click-through.
      if (quickDock.setHitRegions) {
        try {
          quickDock.setHitRegions(collectRects('.blocks'));
        } catch (error) {
          /* ignore */
        }
      }
      if (quickDock.setDragZones) {
        try {
          quickDock.setDragZones([]);
        } catch (error) {
          /* ignore */
        }
      }
      return;
    }
    if (quickDock.setHitRegions) {
      try {
        quickDock.setHitRegions(collectRects('.panel, .menu, .toast, .modal-backdrop'));
      } catch (error) {
        /* ignore */
      }
    }
    if (quickDock.setDragZones) {
      try {
        quickDock.setDragZones(collectRects(DRAG_SELECTOR));
      } catch (error) {
        /* ignore */
      }
    }
  }

  function scheduleHitReport() {
    clearTimeout(hitReportTimer);
    hitReportTimer = setTimeout(reportHitRegions, 50);
  }

  document.addEventListener('mousemove', function (event) {
    var quickDock = window.quickDock;
    if (!quickDock || !quickDock.setInteractive) return;
    var target = event.target && event.target.closest;
    if (isDisplay) {
      quickDock.setInteractive(Boolean(target && target.call(event.target, '.blocks')));
      return;
    }
    var inside = target && target.call(event.target, '.panel, .menu, .toast, .modal-backdrop, ' + DRAG_SELECTOR);
    // Drag bars must stay interactive even while the window is click-through.
    var overDrag = target && target.call(event.target, DRAG_SELECTOR);
    quickDock.setInteractive(Boolean(inside) || Boolean(overDrag));
  });

  window.addEventListener('resize', scheduleHitReport);
  if (window.ResizeObserver) {
    try {
      var sizeObserver = new ResizeObserver(scheduleHitReport);
      // #blocks hugs its content: detail rows grow/shrink it while their
      // transition runs or their content finishes loading.
      sizeObserver.observe(document.body);
      var blocksEl = document.getElementById('blocks');
      if (blocksEl) sizeObserver.observe(blocksEl);
    } catch (error) {
      /* ignore */
    }
  }
  scheduleHitReport();

  /* ---------------------------------- boot ---------------------------------- */

  if (TOKEN) {
    api('state').then(applyState).catch(function (error) {
      toastError(error);
      markOffline();
    });
    connectStream();
  } else {
    markOffline();
  }

  if (!isDisplay) syncListButton();

  if (isDisplay && displayView) {
    // Content grows towards the input window depending on which side it sits.
    displayView.bindAutoScroll();
    displayView.initialScroll();
    var applyAbove = function (value) {
      document.body.classList.toggle('above', Boolean(value));
    };
    var quickDock = window.quickDock;
    if (quickDock) {
      if (quickDock.onStateChanged) {
        quickDock.onStateChanged(function (next) {
          if (next) applyAbove(next.displayAbove);
        });
      }
      if (quickDock.getState) {
        try {
          quickDock.getState().then(function (next) {
            if (next) applyAbove(next.displayAbove);
          }).catch(function () {});
        } catch (error) {
          /* ignore */
        }
      }
    }
  }
})();
