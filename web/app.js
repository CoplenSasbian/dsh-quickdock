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
  // The <title> is static markup; the localized variant comes from the catalog.
  var titleKey = isDisplay ? 'app.displayTitle' : 'app.inputTitle';
  var localizedTitle = t(titleKey);
  document.title = localizedTitle === titleKey ? 'QuickDock' : localizedTitle;

  var els = {
    panelA: U.$('panelA'),
    wsName: U.$('wsName'), sessTitle: U.$('sessTitle'), sessMeta: U.$('sessMeta'),
    composer: U.$('composer'), sendBtn: U.$('sendBtn'), newBtn: U.$('newBtn'),
    permText: U.$('permText'), modelText: U.$('modelText'), thinkText: U.$('thinkText'),
    agentText: U.$('agentText'), agentBtn: U.$('agentBtn'), statusDot: U.$('statusDot'),
    menu: U.$('menu'), toast: U.$('toast'),
    confirm: U.$('confirm'), confirmOk: U.$('confirmOk'), confirmCancel: U.$('confirmCancel'),
    pinBtnA: U.$('pinBtnA'), hideBtnA: U.$('hideBtnA'), listBtn: U.$('listBtn'), openBtn: U.$('openBtn'),
    drows: U.$('drows'),
    runPanel: U.$('runPanel'), runDot: U.$('runDot'), runTitle: U.$('runTitle'),
    runElapsed: U.$('runElapsed'), runAction: U.$('runAction'), runNow: U.$('runNow'), runSub: U.$('runSub'),
    stopBtnRun: U.$('stopBtnRun'), hideBtnR: U.$('hideBtnR'),
    openBtnR: U.$('openBtnR'), listBtnR: U.$('listBtnR'), pinBtnR: U.$('pinBtnR'),
    runApproval: U.$('runApproval'), runApprovalTool: U.$('runApprovalTool'),
    runApprovalReason: U.$('runApprovalReason'), runAllow: U.$('runAllow'), runDeny: U.$('runDeny')
  };
  if (isDisplay) {
    // The display window only has the row container and the toast.
    ['panelA', 'wsName', 'sessTitle', 'sessMeta', 'composer', 'sendBtn', 'newBtn',
      'permText', 'modelText', 'thinkText', 'agentText', 'agentBtn', 'statusDot', 'menu',
      'confirm', 'confirmOk', 'confirmCancel', 'pinBtnA', 'hideBtnA', 'listBtn', 'openBtn',
      'runPanel', 'runDot', 'runTitle', 'runElapsed', 'runAction', 'runNow', 'runSub',
      'stopBtnRun', 'hideBtnR', 'openBtnR', 'listBtnR', 'pinBtnR', 'runApproval',
      'runApprovalTool', 'runApprovalReason', 'runAllow', 'runDeny'].forEach(function (key) {
      els[key] = null;
    });
  } else {
    els.drows = null;
  }

  /* --------------------------------- state --------------------------------- */

  var state = null;
  var connected = false;
  var pendingFork = false;
  var displayView = null;

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
        if (displayView) {
          displayView.invalidate();
          displayView.render(state);
        }
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

  /* ------------------------------ list visibility ------------------------------ */

  // Two independent renderer processes share this through storage events only.
  var LIST_KEY = 'qd-list-hidden';
  var LIST_TTL = 2 * 60 * 60 * 1000; // hiding is temporary: it expires
  var listHidden = readListHidden();

  function readListHidden() {
    try {
      var raw = localStorage.getItem(LIST_KEY);
      if (!raw) return false;
      var saved = JSON.parse(raw);
      if (!saved || saved.hidden !== true) return false;
      if (!Number.isFinite(saved.at) || Date.now() - saved.at > LIST_TTL) return false;
      return true;
    } catch (error) {
      return false;
    }
  }

  function writeListHidden(value) {
    listHidden = Boolean(value);
    try {
      localStorage.setItem(LIST_KEY, JSON.stringify({ hidden: listHidden, at: Date.now() }));
    } catch (error) {
      /* storage may be unavailable */
    }
  }

  function syncListButton() {
    [els.listBtn, els.listBtnR].forEach(function (button) {
      if (!button) return;
      button.classList.toggle('off', listHidden);
      button.setAttribute('aria-pressed', listHidden ? 'false' : 'true');
      button.title = listHidden ? t('list.show') : t('list.hide');
    });
  }

  window.addEventListener('storage', function (event) {
    if (event.key !== LIST_KEY) return;
    listHidden = readListHidden();
    syncListButton();
    if (isDisplay) {
      if (displayView) displayView.render(state);
    } else {
      refreshDisplayVisibility();
    }
  });

  /** Input window: decide whether the run window should be visible. */
  function refreshDisplayVisibility() {
    var steps = (state && state.steps) || [];
    var interaction = state && state.interaction;
    var hasInter = Boolean(interaction && interaction.status === 'open');
    var stream = state && state.stream;
    var hasContent = Boolean(steps.length || hasInter
      || (stream && (stream.text || stream.thinking || (stream.tools && stream.tools.length))));
    var quickDock = window.quickDock;
    if (!quickDock || !quickDock.setDisplayEmpty) return;
    try {
      // Approvals are answered in this window's run panel; a hidden list stays hidden.
      quickDock.setDisplayEmpty(listHidden || !hasContent);
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

    var permission = (state.catalogs.permissions || []).find(function (option) {
      return option.value === state.settings.permission;
    });
    els.permText.textContent = permission ? permission.name : (state.settings.permission || t('key.permission'));

    var model = currentModel();
    els.modelText.textContent = model
      ? model.name
      : (state.settings.model ? state.settings.model.split('/')[1] : t('key.model'));
    els.thinkText.textContent = state.settings.reasoning ? reasoningLabel(state.settings.reasoning) : t('key.thinking');
    els.agentBtn.classList.toggle('hidden', !state.newSession);
    if (!els.agentBtn.classList.contains('hidden')) {
      var preset = (state.catalogs.agents || []).find(function (agent) {
        return agent.id === state.settings.agentPreset;
      });
      els.agentText.textContent = preset ? preset.name : (state.settings.agentPreset || t('key.agent'));
    }

    var status = state.status;
    if (els.statusDot) {
      els.statusDot.className = 'status-dot ' + ({
        running: 'running', done: 'done', error: 'error', ask: 'ask', idle: '', offline: 'offline'
      }[status] || '');
      els.statusDot.title = statusTitle(status);
    }

    // Input form vs run panel: while the agent works the form has no use.
    applyRunMode(status);
    updatePin();
  }

  var STATUS_KEYS = {
    running: 'status.running', done: 'status.done', error: 'status.failed',
    ask: 'status.ask', idle: 'status.idle', offline: 'status.offline'
  };

  function statusTitle(status) {
    return t(STATUS_KEYS[status] || 'status.idle');
  }

  /** Whether the agent is busy (the composer would be meaningless). */
  function isBusy(status) {
    return status === 'running' || status === 'ask'
      || Boolean(state && state.interaction && state.interaction.status === 'open');
  }

  var runStartedAt = 0;
  var runTicker = null;

  function applyRunMode(status) {
    if (!els.runPanel) return;
    var busy = isBusy(status);
    els.panelA.classList.toggle('hidden', busy);
    els.runPanel.classList.toggle('hidden', !busy);
    // The panel decides dragging/hit regions: re-report after switching.
    scheduleHitReport();
    syncListButton();

    if (!busy) {
      if (runTicker) {
        clearInterval(runTicker);
        runTicker = null;
      }
      runStartedAt = 0;
      return;
    }
    if (!runStartedAt) runStartedAt = Date.now();
    if (!runTicker) {
      runTicker = setInterval(function () {
        if (!state || !isBusy(state.status)) return;
        updateRunInfo();
      }, 1000);
    }
    updateRunInfo();
  }

  /** Refresh elapsed time, current action and step counts of the run panel. */
  function updateRunInfo() {
    if (!els.runPanel || !state) return;
    var status = state.status;
    var interaction = state.interaction;

    if (els.runDot) {
      els.runDot.className = 'status-dot ' + ({
        running: 'running', ask: 'ask', done: 'done', error: 'error'
      }[status] || '');
    }
    if (els.runTitle) {
      var title = 'status.ready';
      if (interaction && interaction.status === 'open') {
        title = interaction.kind === 'approval' ? 'status.ask' : 'status.waitingAnswer';
      } else if (status === 'ask') {
        title = 'status.waitingAnswer';
      } else if (status === 'running') {
        title = 'status.running';
      } else if (status === 'done') {
        title = 'status.done';
      } else if (status === 'error') {
        title = 'status.failed';
      }
      els.runTitle.textContent = t(title);
    }
    if (els.runElapsed) {
      els.runElapsed.textContent = runStartedAt ? U.formatElapsed(Date.now() - runStartedAt) : '';
    }

    var stream = state.stream;
    var steps = state.steps || [];

    // 1) What is running now: the live tool call, else the last tool row.
    var action = '';
    if (stream && stream.tools && stream.tools.length) {
      var tool = stream.tools[stream.tools.length - 1];
      action = (tool.name || t('display.toolFallback')) + '  ' + U.compactArgs(tool.args);
    }
    if (!action) {
      for (var index = steps.length - 1; index >= 0; index -= 1) {
        var step = steps[index];
        if (step && step.kind === 'tool') {
          action = (step.tool || t('display.toolFallback')) + '  ' + U.compactArgs(step.command);
          break;
        }
      }
    }
    if (els.runAction) {
      var shownAction = U.shortText(action, 150);
      if (els.runAction.textContent !== shownAction) els.runAction.textContent = shownAction;
      els.runAction.hidden = !shownAction;
    }

    // 2) What is being written now: live stream first, committed row second.
    var live = stream ? (stream.text || stream.thinking || '') : '';
    var latest = '';
    for (var back = steps.length - 1; back >= 0; back -= 1) {
      var row = steps[back];
      if (!row) continue;
      var text = row.kind === 'think' ? (row.text || '')
        : row.kind === 'say' ? (row.text || '')
          : (row.description || '');
      if (text) {
        latest = text;
        break;
      }
    }
    var body = U.shortText(live, 400) || U.shortText(latest, 400);
    if (els.runNow) {
      var shown = body || (status === 'running' ? t('run.starting') : '');
      if (els.runNow.textContent !== shown) els.runNow.textContent = shown;
      els.runNow.classList.toggle('streaming', Boolean(live));
      // Purple only while thinking, so "thinking" and "talking" differ.
      els.runNow.classList.toggle('thinking', Boolean(stream && stream.thinking && !stream.text));
      if (els.runNow.scrollHeight > els.runNow.clientHeight) {
        els.runNow.scrollTop = els.runNow.scrollHeight;
      }
    }
    if (els.runSub) {
      var done = 0;
      var failed = 0;
      steps.forEach(function (row) {
        if (row.status === 'fail') failed += 1;
        else if (row.status === 'done') done += 1;
      });
      var bits = [];
      if (done) bits.push(t('run.doneCount', { count: done }));
      if (failed) bits.push(t('run.failedCount', { count: failed }));
      if (state.backgroundRunning) bits.push(t('run.backgroundCount', { count: state.backgroundRunning }));
      els.runSub.textContent = bits.join(' · ');
    }

    // 3) Approval block: answer without leaving the input window.
    if (els.runApproval) {
      var approval = interaction && interaction.status === 'open' && interaction.kind === 'approval'
        ? interaction
        : null;
      els.runApproval.hidden = !approval;
      if (approval) {
        var reason = approvalText(approval);
        els.runApprovalTool.textContent = approval.toolName ? String(approval.toolName) : '';
        els.runApprovalReason.textContent = reason;
        els.runApprovalReason.hidden = !reason;
        els.runApprovalReason.title = reason;
      }
    }
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
    [els.pinBtnA, els.pinBtnR].forEach(function (button) {
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

  /* ------------------------------ display window ------------------------------ */

  if (isDisplay && els.drows) {
    displayView = window.QD.display.create({
      root: els.drows,
      api: api,
      getState: function () {
        return state;
      },
      isListHidden: function () {
        return listHidden;
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

  if (!isDisplay) {
    U.on(U.$('permBtn'), 'click', function (event) {
      event.stopPropagation();
      // The anchor must be read synchronously: currentTarget is null later.
      var owner = event.currentTarget;
      if (!requireState()) return;
      openPermissionMenu(owner);
    });

    U.on(U.$('modelBtn'), 'click', function (event) {
      event.stopPropagation();
      var owner = event.currentTarget;
      if (!requireState()) return;
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
    });

    U.on(U.$('thinkBtn'), 'click', function (event) {
      event.stopPropagation();
      var owner = event.currentTarget;
      if (!requireState()) return;
      openThinkingMenu(owner);
    });

    U.on(els.agentBtn, 'click', function (event) {
      event.stopPropagation();
      var owner = event.currentTarget;
      if (!requireState()) return;
      openAgentMenu(owner);
    });
  }

  /* ------------------------------- composer ------------------------------- */

  function send() {
    var text = els.composer.value.trim();
    if (!text) return;
    els.composer.value = '';
    els.sendBtn.disabled = true;
    var body = { text: text, fork: pendingFork };
    if (!state.sessionId) body.workspaceId = state.workspaceId || undefined;
    api('task', body).then(function () {
      pendingFork = false;
    }).catch(function (error) {
      toastError(error);
      els.composer.value = text;
      els.sendBtn.disabled = false;
    });
  }

  if (!isDisplay) {
    U.on(els.composer, 'input', function () {
      els.sendBtn.disabled = !els.composer.value.trim();
    });
    U.on(els.composer, 'keydown', function (event) {
      if (event.key !== 'Enter' || event.shiftKey) return;
      event.preventDefault();
      send();
    });
    U.on(els.sendBtn, 'click', send);

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
  U.on(els.openBtnR, 'click', function (event) {
    event.stopPropagation();
    openInDsh();
  });
  U.on(els.pinBtnA, 'click', function (event) {
    event.stopPropagation();
    togglePin();
  });
  U.on(els.pinBtnR, 'click', function (event) {
    event.stopPropagation();
    togglePin();
  });
  U.on(els.listBtn, 'click', function (event) {
    event.stopPropagation();
    writeListHidden(!listHidden);
    syncListButton();
    refreshDisplayVisibility();
  });
  U.on(els.listBtnR, 'click', function (event) {
    event.stopPropagation();
    writeListHidden(!listHidden);
    syncListButton();
    refreshDisplayVisibility();
  });
  U.on(els.hideBtnA, 'click', hideWindow);
  U.on(els.hideBtnR, 'click', hideWindow);

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

  if (!isDisplay) {
    if (els.sendBtn) els.sendBtn.disabled = true;
    syncListButton();
  }

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
