/* QuickDock 页面逻辑。原生 JS、无依赖、无外部请求。
 * 一份脚本服务两个窗口：window.__QD_VIEW__ 为 'display' 时走展示窗口分支。
 * 通信：同源 /quickdock/api/*，Bearer token（URL ?t= 注入，sessionStorage 记忆）。
 * 事件：SSE state 全量 / theme 令牌。
 * 窗口：window.quickDock（Electron preload，可选）—— setInteractive / setHitRegions /
 *       setDragZones / setAlwaysOnTop / setDisplayEmpty / hide / getState。
 *       窗口位置完全由用户拖拽决定（拖动区见 DRAG_SELECTOR）。
 */
(function () {
  'use strict';

  /* ================= token ================= */
  var params = new URLSearchParams(location.search);
  var TOKEN = params.get('t') || sessionStorage.getItem('qd-token') || '';
  if (TOKEN) sessionStorage.setItem('qd-token', TOKEN);

  function api(path, body) {
    return fetch('/quickdock/api/' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? { Authorization: 'Bearer ' + TOKEN }
        : { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    }).then(function (r) {
      if (!r.ok) throw new Error('api ' + path + ' ' + r.status);
      return r.status === 204 ? null : r.json();
    });
  }

  /* ================= dom ================= */
  function $(id) { return document.getElementById(id); }

  // 两个视图共用同一个脚本：
  //  - 'input'  输入窗口：工作区/会话选择 + 输入框 + 功能键
  //  - 'display' 展示窗口：执行过程的块（思考/工具调用/回复…），块间透明
  var VIEW = window.__QD_VIEW__ === 'display' ? 'display' : 'input';
  var isDisplay = VIEW === 'display';

  var els = {
    panelA: $('panelA'),
    wsName: $('wsName'), sessName: $('sessName'), sessTitle: $('sessTitle'), sessMeta: $('sessMeta'),
    composer: $('composer'), sendBtn: $('sendBtn'), newBtn: $('newBtn'),
    permText: $('permText'), modelText: $('modelText'), thinkText: $('thinkText'), agentText: $('agentText'),
    agentBtn: $('agentBtn'), statusDot: $('statusDot'),
    menu: $('menu'), toast: $('toast'),
    confirm: $('confirm'), confirmOk: $('confirmOk'), confirmCancel: $('confirmCancel'),
    pinBtnA: $('pinBtnA'), hideBtnA: $('hideBtnA'),
    // 输入窗口的「运行态」面板（Agent 在跑时替换掉输入面板）
    runPanel: $('runPanel'), runDot: $('runDot'), runTitle: $('runTitle'),
    runElapsed: $('runElapsed'), runNow: $('runNow'), runSub: $('runSub'),
    stopBtnRun: $('stopBtnRun'), hideBtnR: $('hideBtnR'),
    // 展示窗口的面板容器
    blocks: $('blocks')
  };
  // 展示窗口没有输入窗口的那套 DOM，统一置空，渲染时按需判空
  if (isDisplay) {
    ['panelA', 'wsName', 'sessName', 'sessTitle', 'sessMeta', 'composer', 'sendBtn',
      'newBtn', 'permText', 'modelText', 'thinkText', 'agentText', 'agentBtn', 'statusDot',
      'menu', 'toast', 'confirm', 'confirmOk', 'confirmCancel',
      'pinBtnA', 'hideBtnA', 'runPanel', 'runDot', 'runTitle', 'runElapsed', 'runNow', 'runSub',
      'stopBtnRun', 'hideBtnR'
    ].forEach(function (k) { els[k] = null; });
  }

  var state = null;
  var theme = null;
  var connected = false;
  var pendingFork = false;
  var menuOwner = null;
  var menuActions = [];

  /* ================= theme ================= */
  var FALLBACK = {
    dark: { '--qd-bg-base': '#1b1b1c', '--qd-bg-layer-1': '#232324', '--qd-bg-layer-2': '#2a2a2b', '--qd-bg-overlay': '#232324', '--qd-border-l1': '#333335', '--qd-border-l2': '#3d3d40', '--qd-label-primary': '#e9e9ea', '--qd-label-secondary': '#9a9a9d', '--qd-label-tertiary': '#6b6b6e', '--qd-brand-primary': '#4d8eff', '--qd-state-success': '#3ecf8e', '--qd-state-error': '#f05252', '--qd-state-warn': '#f5a623', '--qd-state-idle': '#6b6b6e' },
    light: { '--qd-bg-base': '#ffffff', '--qd-bg-layer-1': '#f6f7f8', '--qd-bg-layer-2': '#f0f1f3', '--qd-bg-overlay': '#ffffff', '--qd-border-l1': '#e3e4e6', '--qd-border-l2': '#d0d1d4', '--qd-label-primary': '#1c1c1e', '--qd-label-secondary': '#5f6066', '--qd-label-tertiary': '#96989e', '--qd-brand-primary': '#2b6cf6', '--qd-state-success': '#17a673', '--qd-state-error': '#d93636', '--qd-state-warn': '#d98300', '--qd-state-idle': '#96989e' }
  };

  function applyTheme(payload) {
    if (!payload) return;
    theme = payload;
    var scheme = payload.colorScheme === 'light' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', scheme);
    var root = document.documentElement.style;
    var tokens = payload.tokens && Object.keys(payload.tokens).length ? payload.tokens : {};
    var fallback = FALLBACK[scheme];
    // 缺值宁可整体回落，也不要半套色（DESIGN 7.7）
    var missing = ['--qd-bg-base', '--qd-label-primary'].some(function (n) { return !tokens[n]; });
    var source = missing ? fallback : tokens;
    Object.keys(source).forEach(function (k) { root.setProperty(k, source[k]); });
    if (payload.fonts) {
      if (payload.fonts.text) root.setProperty('--qd-font-text', payload.fonts.text);
      if (payload.fonts.code) root.setProperty('--qd-font-code', payload.fonts.code);
      if (payload.fonts.sizeText) root.setProperty('--qd-font-size-text', payload.fonts.sizeText + 'px');
      if (payload.fonts.sizeCode) root.setProperty('--qd-font-size-code', payload.fonts.sizeCode + 'px');
    }
  }

  /* ================= helpers ================= */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function relTime(ts) {
    if (!ts) return '';
    var d = Date.now() - ts;
    if (d < 60e3) return '刚刚';
    if (d < 3600e3) return Math.floor(d / 60e3) + ' 分钟前';
    if (d < 86400e3) return Math.floor(d / 3600e3) + ' 小时前';
    return Math.floor(d / 86400e3) + ' 天前';
  }
  function toast(msg) {
    // 展示窗口没有 toast 元素（els.toast 为 null）——静默降级为 console
    if (!els.toast) { console.log('[QuickDock] ' + msg); return; }
    els.toast.textContent = msg;
    els.toast.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { els.toast.hidden = true; }, 4000);
  }

  /* ================= SSE ================= */
  var es = null;
  var esTimer = null;
  function connectStream() {
    if (!TOKEN) return;
    if (es) { try { es.close(); } catch (e) {} }
    es = new EventSource('/quickdock/api/stream?t=' + encodeURIComponent(TOKEN));
    es.addEventListener('state', function (ev) {
      try { applyState(JSON.parse(ev.data)); } catch (e) {}
    });
    es.addEventListener('theme', function (ev) {
      try { applyTheme(JSON.parse(ev.data)); } catch (e) {}
    });
    es.onerror = function () {
      connected = false;
      markOffline();
      if (esTimer) return;
      esTimer = setTimeout(function () { esTimer = null; connectStream(); }, 2000);
    };
    es.onopen = function () {
      if (!connected) {
        connected = true;
        api('state').then(applyState).catch(function () {});
      }
    };
  }

  function markOffline() {
    document.body.classList.add('offline');
  }

  /* ================= state render ================= */
  function currentWorkspace() {
    if (!state) return null;
    return state.workspaces.find(function (w) { return w.id === state.workspaceId; }) || null;
  }
  function findWorkspaceOfSession(sessionId) {
    if (!sessionId || !state) return null;
    for (var i = 0; i < state.workspaces.length; i++) {
      var w = state.workspaces[i];
      for (var j = 0; j < w.sessions.length; j++) {
        if (w.sessions[j].id === sessionId) return w;
      }
    }
    return null;
  }

  function applyState(next) {
    var first = !state;
    state = next;
    connected = true;
    document.body.classList.remove('offline');
    render(first);
  }

  function render(first) {
    if (isDisplay) { renderDisplay(); return; }
    var ws = currentWorkspace();
    var boundWs = state.sessionId ? findWorkspaceOfSession(state.sessionId) : null;
    var locked = Boolean(state.sessionId);
    var effWs = locked ? boundWs : ws;

    // 顶栏 pickers
    els.wsName.textContent = effWs ? effWs.name : (state.workspaceId ? '…' : '选择工作区');
    els.sessName.textContent = state.session ? state.session.title : '新对话';
    els.sessTitle.textContent = state.session ? state.session.title : '新对话';
    els.sessTitle.classList.toggle('blank', !state.session);
    els.sessMeta.textContent = state.session ? relTime(lastUpdated(effWs, state.session.id)) : '';
    els.newBtn.hidden = locked;

    // 功能键
    var perms = state.catalogs.permissions || [];
    var perm = perms.find(function (p) { return p.value === state.settings.permission; });
    els.permText.textContent = perm ? perm.name : (state.settings.permission || '权限');
    var models = state.catalogs.models || [];
    var model = models.find(function (m) { return m.id === state.settings.model; });
    els.modelText.textContent = model ? model.name : (state.settings.model ? state.settings.model.split('/')[1] : '模型');
    els.thinkText.textContent = state.settings.reasoning ? reasoningLabel(state.settings.reasoning) : '思考';
    els.agentBtn.classList.toggle('hidden', !(state.newSession && !locked));
    if (!els.agentBtn.classList.contains('hidden')) {
      var agents = state.catalogs.agents || [];
      var ag = agents.find(function (a) { return a.id === state.settings.agentPreset; });
      els.agentText.textContent = ag ? ag.name : (state.settings.agentPreset || 'Agent');
    }

    // 输入窗口只负责输入；执行过程交给独立的展示窗口。
    // 状态点放在标题条上，让人一眼看出 Agent 在跑/完成/失败。
    var status = state.status;
    if (els.statusDot) {
      els.statusDot.className = 'status-dot ' + ({
        running: 'running', done: 'done', error: 'error', ask: 'ask', idle: '', offline: 'offline'
      }[status] || '');
      els.statusDot.title = ({
        running: '正在执行', done: '已完成', error: '失败', ask: '等待确认', idle: '空闲', offline: '离线'
      }[status] || '空闲');
    }

    // 输入态 / 运行态 二选一：
    // Agent 干活的时候输入框、工作区、会话、模型、权限这些都没用，
    // 全部收起，换成「在跑什么 + 跑了多久 + 停止」。
    applyRunMode(status);

    updatePin();
  }

  /** 是否处于「Agent 正在忙」的状态（此时输入框没有意义）。 */
  function isBusy(status) {
    return status === 'running' || status === 'ask'
      || Boolean(state && state.interaction && state.interaction.status === 'open');
  }

  var runStartedAt = 0;
  var runTicker = null;
  var runLastStatus = '';

  /**
   * 切换输入窗口的两种形态，并刷新运行态里的信息。
   */
  function applyRunMode(status) {
    if (!els.runPanel) return;
    var busy = isBusy(status);
    els.panelA.classList.toggle('hidden', busy);
    els.runPanel.classList.toggle('hidden', !busy);
    // 面板换了 → 拖动区/命中区都变了，必须重报。
    // 不重报的话运行态下没有任何拖动区，窗口就拖不动了。
    scheduleHitReport();

    if (!busy) {
      if (runTicker) { clearInterval(runTicker); runTicker = null; }
      runStartedAt = 0;
      runLastStatus = status;
      return;
    }

    // 刚进入运行态：记下起点，之后按秒刷新时长
    if (!runStartedAt) runStartedAt = Date.now();
    if (!runTicker) {
      runTicker = setInterval(function () {
        if (!state || !isBusy(state.status)) return;
        updateRunInfo();
      }, 1000);
    }
    runLastStatus = status;
    updateRunInfo();
  }

  /** 刷新运行态面板上的时长 / 当前动作 / 步数。 */
  function updateRunInfo() {
    if (!els.runPanel || !state) return;
    var status = state.status;
    var inter = state.interaction;

    if (els.runDot) {
      els.runDot.className = 'status-dot ' + ({
        running: 'running', ask: 'ask', done: 'done', error: 'error'
      }[status] || '');
    }
    if (els.runTitle) {
      els.runTitle.textContent = inter && inter.status === 'open'
        ? (inter.kind === 'approval' ? '等待确认' : '等待回答')
        : status === 'ask' ? '等待回答'
        : status === 'running' ? '正在执行'
        : status === 'done' ? '已完成'
        : status === 'error' ? '执行失败'
        : '就绪';
    }
    if (els.runElapsed) {
      els.runElapsed.textContent = runStartedAt ? formatElapsed(Date.now() - runStartedAt) : '';
    }

    // 当前动作：取最新一条有内容的记录
    var steps = state.steps || [];
    var latest = '';
    for (var i = steps.length - 1; i >= 0; i--) {
      var s = steps[i];
      if (!s) continue;
      var text = s.kind === 'think' ? (s.text || '')
        : s.kind === 'say' ? (s.text || '')
        : (s.command || s.label || s.text || '');
      if (text) { latest = text; break; }
    }
    if (els.runNow) {
      els.runNow.textContent = latest || (status === 'running' ? '正在启动…' : '');
    }
    if (els.runSub) {
      var running = 0, done = 0, failed = 0;
      steps.forEach(function (s) {
        if (s.status === 'run') running++;
        else if (s.status === 'fail') failed++;
        else if (s.status === 'done') done++;
      });
      var bits = [];
      if (done) bits.push('已完成 ' + done);
      if (failed) bits.push('失败 ' + failed);
      if (state.backgroundRunning) bits.push('后台 ' + state.backgroundRunning);
      els.runSub.textContent = bits.join(' · ');
    }
  }

  function formatElapsed(ms) {
    var total = Math.max(0, Math.floor(ms / 1000));
    var m = Math.floor(total / 60);
    var s = total % 60;
    if (m >= 60) {
      var h = Math.floor(m / 60);
      return h + ':' + String(m % 60).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    }
    return m + ':' + String(s).padStart(2, '0');
  }

  /**
   * 展示窗口：每条记录渲染成一个独立的块，块与块之间**完全透明**。
   *
   * 窗口本身是固定高度的（config.displayHeight），内容超出就在窗口内滚动；
   * 没有内容时整个窗口隐藏（由宿主根据 state 决定）。
   */
  /** 按工具名推断动作类型，画出对应的小图标。 */
  function toolIcon(tool) {
    var t = String(tool || '').toLowerCase();
    if (!t) return '○';
    if (/image|screenshot|photo|vision/.test(t)) return '▦';
    if (/write|create|save|append|mkdir|touch|delete|remove|move|rename/.test(t)) return '✎';
    if (/edit|replace|patch|update|insert|modify/.test(t)) return '✐';
    if (/read|cat|view|open|load|show/.test(t)) return '▤';
    if (/grep|search|find|query|glob|match/.test(t)) return '⌕';
    if (/list|ls|dir|tree|walk/.test(t)) return '☰';
    if (/command|shell|bash|exec|terminal|run|spawn/.test(t)) return '›';
    if (/web|http|fetch|browser|url/.test(t)) return '⊕';
    if (/todo|plan|task|check/.test(t)) return '☑';
    if (/agent|subagent|delegate|spawn_agent/.test(t)) return '◎';
    return '⚙';
  }

  function renderDisplay() {
    var host = els.blocks;
    if (!host) return;

    // 重建前先记住滚动位置：跟随中→重建后贴底；用户翻上去了→保持原位置
    var sc0 = scrollHost();
    var prevTop = sc0 ? sc0.scrollTop : 0;
    var wasAuto = autoScroll;

    host.textContent = '';

    var steps = state.steps || [];
    var inter = state.interaction;
    var hasInter = Boolean(inter && inter.status === 'open');
    if (!steps.length && !hasInter) {
      // 没有内容 → 通知宿主隐藏展示窗口
      if (window.quickDock && window.quickDock.setDisplayEmpty) {
        try { window.quickDock.setDisplayEmpty(true); } catch (e) {}
      }
      return;
    }
    if (window.quickDock && window.quickDock.setDisplayEmpty) {
      try { window.quickDock.setDisplayEmpty(false); } catch (e) {}
    }

    // 只有**最后一条**处于 run 的才算是「正在执行」。
    // 会话被中断（重启/任务被杀）时步骤会一直停在 run 状态，
    // 全部照 run 渲染会同时出现一堆转圈，所以只让最后一条显示为进行中。
    var lastRun = -1;
    steps.forEach(function (s, i) { if (s && s.status === 'run') lastRun = i; });

    steps.forEach(function (s, i) {
      var block = document.createElement('div');
      block.className = 'drow';
      var isRunning = i === lastRun;
      if (s.kind === 'think') {
        block.appendChild(thinkBlock(s));
      } else if (s.kind === 'say') {
        var say = document.createElement('div');
        say.className = 'say' + (isRunning ? ' streaming' : '');
        say.textContent = s.text || '';
        block.appendChild(say);
      } else {
        var row = document.createElement('div');
        var state_ = isRunning ? 'run'
          : s.status === 'fail' ? 'fail'
          : s.status === 'done' ? 'done'
          : 'todo';
        row.className = 'step ' + state_;
        var icon = document.createElement('span');
        icon.className = 'step-icon';
        // 图标表达**动作类型**（命令/读/写/改/搜…），不随状态变；
        // 状态交给颜色（绿=完成、红=失败、蓝=进行中），正在跑时由 CSS 换成转圈。
        icon.textContent = isRunning ? '' : toolIcon(s.tool);

        // 前面放 description（人能读懂的摘要），后面跟原始 JSON（省略号截断）
        var primary = String(s.description || '').trim();
        var detail = String(s.command || '').trim();
        if (!primary) { primary = detail; detail = ''; }
        if (primary === detail) detail = '';

        var label = document.createElement('span');
        label.className = 'step-label';
        label.textContent = primary || s.label || s.text || '';
        if (primary || detail) label.title = (primary + ' ' + detail).trim();

        row.appendChild(icon);
        row.appendChild(label);
        if (detail) {
          var json = document.createElement('span');
          json.className = 'step-json';
          json.textContent = detail;
          row.appendChild(json);
        }
        var time = document.createElement('span');
        time.className = 'step-time';
        // 注意：配置在 state.config 里（不是全局 config —— 那个变量不存在，
        // 引用它会抛 ReferenceError 中断整个 forEach，导致内容区被清空却不填充）。
        var showTiming = !state.config || state.config.showTiming !== false;
        time.textContent = showTiming && s.time ? String(s.time).slice(11, 19) : '';
        row.appendChild(time);
        block.appendChild(row);
      }
      host.appendChild(block);
    });

    if (hasInter) {
      var card = buildInteractionCard(inter);
      if (card) {
        var wrap = document.createElement('div');
        wrap.className = 'drow';
        wrap.appendChild(card);
        host.appendChild(wrap);
      }
    }

    applyAutoScroll(prevTop, wasAuto);

    // 内容变化后必须重新上报命中区：
    // 空状态下 .blocks 高度是 0，collectRects 会跳过它 → 上报的是空数组，
    // 窗口就一直保持穿透（点不动、滚不了）。内容出现后要补报一次。
    scheduleHitReport();
  }

  /* ================= 展示窗口的自动滚动 ================= */
  // 默认贴到最新一条；用户手动往上翻就停住，翻回底部再恢复自动跟随。
  var autoScroll = true;
  var scrollGuard = false;

  function scrollHost() {
    return document.getElementById('blocks');
  }

  function isNearBottom(el, slack) {
    return el.scrollHeight - el.scrollTop - el.clientHeight <= (slack || 24);
  }

  /** 重建 DOM 后恢复滚动位置：跟随中→贴底，否则保持用户原来的位置。 */
  function applyAutoScroll(prevTop, wasAuto) {
    var sc = scrollHost();
    if (!sc) return;
    scrollGuard = true;
    if (wasAuto) sc.scrollTop = sc.scrollHeight;
    else sc.scrollTop = prevTop;
    // 下一帧再放开，避免上面这次赋值触发的 scroll 事件改写 autoScroll
    setTimeout(function () { scrollGuard = false; }, 0);
  }

  /** 绑定滚动容器（只在展示窗口、只绑一次）。 */
  function bindAutoScroll() {
    var sc = scrollHost();
    if (!sc || sc.__qdBound) return;
    sc.__qdBound = true;
    sc.addEventListener('scroll', function () {
      if (scrollGuard) return;
      // 用户滚到底 = 恢复跟随；滚上去 = 暂停跟随
      autoScroll = isNearBottom(sc, 24);
    }, { passive: true });
  }

  function lastUpdated(ws, sessionId) {
    if (!ws) return 0;
    var s = ws.sessions.find(function (x) { return x.id === sessionId; });
    return s ? s.updatedAt : 0;
  }

  var REASONING_LABELS = { low: '低', medium: '中', high: '高', max: '最高' };
  function reasoningLabel(id) { return REASONING_LABELS[id] || id; }

  function thinkBlock(s) {
    var box = document.createElement('div');
    box.className = 'think';
    var head = document.createElement('button');
    head.className = 'think-head';
    head.type = 'button';
    var icon = document.createElement('span');
    icon.className = 'th-icon'; icon.textContent = '✦';
    var preview = document.createElement('span');
    preview.className = 'th-preview';
    var one = String(s.text || '').replace(/\s+/g, ' ').trim();
    preview.textContent = one.length > 42 ? one.slice(0, 42) + '…' : one;
    var chev = document.createElement('span');
    chev.className = 'th-chev'; chev.textContent = '▶';
    head.appendChild(icon); head.appendChild(preview); head.appendChild(chev);
    var body = document.createElement('div');
    body.className = 'think-body';
    body.textContent = s.text || '';
    head.addEventListener('click', function () {
      box.classList.toggle('open');
      // 展开会改变高度：命中区要重报，跟随中就重新贴底
      scheduleHitReport();
      var sc = scrollHost();
      if (sc && autoScroll) sc.scrollTop = sc.scrollHeight;
    });
    box.appendChild(head); box.appendChild(body);
    return box;
  }

  /**
   * 构建交互卡片（审批 / 提问）。
   * 返回元素而不是直接塞进容器 —— 展示窗口用它。
   */
  function buildInteractionCard(inter) {
    if (!inter || inter.status !== 'open') return null;
    if (inter.kind === 'approval') {
      var card = document.createElement('div');
      card.className = 'card approval';
      card.appendChild(cardHead('⚠ 需要确认', inter.toolName || ''));
      var body = document.createElement('div');
      body.className = 'card-body';
      var cmd = document.createElement('div');
      cmd.className = 'cmd';
      cmd.textContent = inter.reason || inter.callId || '';
      body.appendChild(cmd);
      body.appendChild(cardActions([
        { label: '允许', cls: 'primary', value: 'allow' },
        { label: '拒绝', cls: 'danger', value: 'deny' }
      ], inter.id));
      card.appendChild(body);
      var foot = document.createElement('div');
      foot.className = 'card-foot';
      foot.textContent = '此决定会记入会话日志 · 仅本次有效';
      card.appendChild(foot);
      return card;
    } else if (inter.kind === 'question') {
      var qcard = document.createElement('div');
      qcard.className = 'card question';
      qcard.appendChild(cardHead('? 提问', ''));
      var qbody = document.createElement('div');
      qbody.className = 'card-body';
      (inter.questions || []).forEach(function (q) {
        var qd = document.createElement('div');
        qd.className = 'card-q';
        qd.textContent = q.question || q.header || '';
        qbody.appendChild(qd);
        if (q.options && q.options.length) {
          var opts = document.createElement('div');
          opts.className = 'opts';
          q.options.forEach(function (o, idx) {
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'opt';
            var key = document.createElement('span');
            key.className = 'opt-key'; key.textContent = String(idx + 1);
            var text = document.createElement('span');
            text.className = 'opt-text';
            text.textContent = o.label;
            if (o.description) {
              var sm = document.createElement('small');
              sm.textContent = o.description;
              text.appendChild(sm);
            }
            b.appendChild(key); b.appendChild(text);
            b.addEventListener('click', function () {
              api('answer', { id: inter.id, answers: [{ id: q.id, selected: [o.label] }] }).catch(toastErr);
              markAnswered();
            });
            opts.appendChild(b);
          });
          qbody.appendChild(opts);
        } else {
          var input = document.createElement('textarea');
          input.className = 'answer-input';
          input.placeholder = '输入回答…';
          var ok = document.createElement('button');
          ok.type = 'button';
          ok.className = 'card-btn primary';
          ok.textContent = '提交';
          ok.addEventListener('click', function () {
            var v = input.value.trim();
            if (!v) return;
            api('answer', { id: inter.id, answers: [{ id: q.id, selected: [v] }] }).catch(toastErr);
            markAnswered();
          });
          qbody.appendChild(input); qbody.appendChild(ok);
        }
      });
      qcard.appendChild(qbody);
      return qcard;
    }
    return null;
  }

  function cardHead(text, tag) {
    var head = document.createElement('div');
    head.className = 'card-head';
    head.textContent = text;
    if (tag) {
      var t = document.createElement('span');
      t.className = 'ch-tag';
      t.textContent = tag;
      head.appendChild(t);
    }
    return head;
  }
  function cardActions(items, id) {
    var row = document.createElement('div');
    row.className = 'card-actions';
    items.forEach(function (it) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'card-btn ' + (it.cls || '');
      b.textContent = it.label;
      b.addEventListener('click', function () {
        api('answer', { id: id, outcome: it.value }).catch(toastErr);
        markAnswered();
      });
      row.appendChild(b);
    });
    return row;
  }
  function markAnswered() {
    if (state.interaction) state.interaction.status = 'answered';
    render();
  }
  function toastErr(e) { toast(String(e && e.message || e)); }

  /** 同步顶置按钮的选中态。 */
  function updatePin() {
    if (!els.pinBtnA) return;
    var pinned = Boolean(state.runtime && state.runtime.alwaysOnTop);
    els.pinBtnA.classList.toggle('on', pinned);
    els.pinBtnA.setAttribute('aria-pressed', pinned ? 'true' : 'false');
  }

  /* ================= menu ================= */
  function closeMenu() {
    if (els.menu) els.menu.classList.remove('open');
    menuOwner = null;
    menuActions = [];
  }
  function openMenu(owner, title, items) {
    if (menuOwner === owner) { closeMenu(); return; }
    menuOwner = owner;
    menuActions = items;
    els.menu.textContent = '';
    if (title) {
      var t = document.createElement('div');
      t.className = 'menu-title';
      t.textContent = title;
      els.menu.appendChild(t);
    }
    items.forEach(function (it) {
      if (it.sep) {
        var sep = document.createElement('div');
        sep.className = 'menu-sep';
        els.menu.appendChild(sep);
        return;
      }
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'menu-item' + (it.sel ? ' sel' : '');
      var main = document.createElement('span');
      main.className = 'mi-main';
      var name = document.createElement('span');
      name.className = 'mi-name';
      name.textContent = it.name;
      main.appendChild(name);
      if (it.sub) {
        var sub = document.createElement('span');
        sub.className = 'mi-sub';
        sub.textContent = it.sub;
        main.appendChild(sub);
      }
      var check = document.createElement('span');
      check.className = 'mi-check';
      check.textContent = it.sel ? '✓' : '';
      b.appendChild(main); b.appendChild(check);
      if (it.disabled) b.disabled = true;
      b.addEventListener('click', function (ev) {
        ev.stopPropagation();
        closeMenu();
        it.onPick();
      });
      els.menu.appendChild(b);
    });
    // 锁定宽度到面板内（DESIGN：绝不超出窗口）
    els.menu.style.width = '344px';
    els.menu.style.left = '8px';
    var anchor = owner.getBoundingClientRect ? owner : null;
    if (anchor) {
      var r = anchor.getBoundingClientRect();
      els.menu.style.top = Math.min(r.bottom + 4, window.innerHeight - 60) + 'px';
    } else {
      els.menu.style.top = '40px';
    }
    els.menu.classList.add('open');
  }

  document.addEventListener('click', function (ev) {
    if (!els.menu) return;
    if (!els.menu.classList.contains('open')) return;
    if (els.menu.contains(ev.target)) return;
    closeMenu();
  });

  /* ================= pickers & fkeys ================= */
  // 以下到「danger confirm」结束都是**输入窗口专属**的交互绑定。
  // 展示窗口没有这些元素（els.* 为 null），整段跳过。
  if (!isDisplay) {

  $('wsPicker').addEventListener('click', function (ev) {
    ev.stopPropagation();
    if (state.sessionId) { // 绑定态置灰（DESIGN 2.5）
      toast('已绑定会话，点「＋ 新对话」解除');
      return;
    }
    var items = (state.workspaces || []).map(function (w) {
      return { name: w.name, sub: w.path, sel: w.id === state.workspaceId, onPick: function () {
        api('select', { workspaceId: w.id }).catch(toastErr);
      } };
    });
    openMenu(ev.currentTarget, '工作区', items.length ? items : [{ name: '（无工作区）', disabled: true }]);
  });

  $('sessPicker').addEventListener('click', function (ev) {
    ev.stopPropagation();
    var ws = state.sessionId ? findWorkspaceOfSession(state.sessionId) : currentWorkspace();
    if (!ws) { openMenu(ev.currentTarget, '会话', [{ name: '先选择工作区', disabled: true }]); return; }
    var items = [{ name: '新对话', sel: state.newSession && !state.sessionId, onPick: function () {
      api('select', { newSession: true }).catch(toastErr);
    } }, { sep: true }];
    (ws.sessions || []).forEach(function (s) {
      items.push({
        name: s.title || s.id,
        sub: (s.running ? '● 运行中 · ' : '') + relTime(s.updatedAt),
        sel: s.id === state.sessionId,
        onPick: function () { api('select', { sessionId: s.id, newSession: false }).catch(toastErr); }
      });
    });
    openMenu(ev.currentTarget, ws.name + ' 的会话', items);
  });

  $('permBtn').addEventListener('click', function (ev) {
    ev.stopPropagation();
    var items = (state.catalogs.permissions || []).map(function (p) {
      return {
        name: p.name, sub: p.description || '', sel: p.value === state.settings.permission,
        onPick: function () {
          if (p.value === 'danger-full-access') confirmDanger(function () {
            api('settings', { permission: p.value }).catch(toastErr);
          });
          else api('settings', { permission: p.value }).catch(toastErr);
        }
      };
    });
    openMenu(ev.currentTarget, '权限策略', items);
  });

  $('modelBtn').addEventListener('click', function (ev) {
    ev.stopPropagation();
    api('catalogs').then(function (catalogs) {
      state.catalogs = catalogs;
      var items = (catalogs.models || []).map(function (m) {
        return {
          name: m.name, sub: m.context ? m.context.toLocaleString() + ' ctx' : '', sel: m.id === state.settings.model,
          onPick: function () { api('settings', { model: m.id, reasoning: '' }).catch(toastErr); }
        };
      });
      openMenu(ev.currentTarget, '模型', items.length ? items : [{ name: '（无可用模型）', disabled: true }]);
    }).catch(toastErr);
  });

  $('thinkBtn').addEventListener('click', function (ev) {
    ev.stopPropagation();
    var efforts = [];
    var model = (state.catalogs.models || []).find(function (m) { return m.id === state.settings.model; });
    (model && model.reasoning && model.reasoning.length ? model.reasoning : ['low', 'high', 'max']).forEach(function (r) {
      efforts.push({
        name: reasoningLabel(r), sel: r === state.settings.reasoning,
        onPick: function () { api('settings', { reasoning: r }).catch(toastErr); }
      });
    });
    efforts.push({ name: '关闭', sel: !state.settings.reasoning, onPick: function () { api('settings', { reasoning: '' }).catch(toastErr); } });
    openMenu(ev.currentTarget, '思考强度', efforts);
  });

  els.agentBtn.addEventListener('click', function (ev) {
    ev.stopPropagation();
    var items = (state.catalogs.agents || []).map(function (a) {
      return { name: a.name, sel: a.id === state.settings.agentPreset, onPick: function () {
        api('settings', { agentPreset: a.id }).catch(toastErr);
      } };
    });
    openMenu(ev.currentTarget, 'Agent 预设', items.length ? items : [{ name: '（默认）', sel: true, onPick: function () { api('settings', { agentPreset: '' }).catch(toastErr); } }]);
  });

  /* ================= composer & buttons ================= */
  els.composer.addEventListener('input', function () {
    els.sendBtn.disabled = !els.composer.value.trim();
    // 高度由 flex 撑满，无需测量
  });
  els.composer.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); send(); }
  });
  els.sendBtn.addEventListener('click', send);

  function send() {
    var text = els.composer.value.trim();
    if (!text) return;
    els.composer.value = '';
    els.sendBtn.disabled = true;
    var body = { text: text, fork: pendingFork };
    if (!state.sessionId) body.workspaceId = state.workspaceId || undefined;
    api('task', body).then(function () {
      pendingFork = false;
    }).catch(function (e) {
      toastErr(e);
      els.composer.value = text;
      els.sendBtn.disabled = false;
    });
  }

  els.newBtn.addEventListener('click', function (ev) {
    ev.stopPropagation();
    if (ev.shiftKey || ev.altKey) {
      // 从当前会话分叉（DESIGN D2）
      if (!state.sessionId) { toast('没有可分叉的会话'); return; }
      pendingFork = true;
      toast('下一条消息将从当前会话分叉');
    } else {
      api('select', { newSession: true }).catch(toastErr);
    }
  });

  /** 安全绑定：元素不存在时跳过，避免脚本中断。 */
  function on(el, event, handler) {
    if (el && el.addEventListener) el.addEventListener(event, handler);
  }

  on(els.stopBtnRun, 'click', function () {
    api('stop', {}).catch(toastErr);
  });

  function togglePin() {
    var next = !(state.runtime && state.runtime.alwaysOnTop);
    api('window', { alwaysOnTop: next }).catch(toastErr);
    if (window.quickDock && window.quickDock.setAlwaysOnTop) window.quickDock.setAlwaysOnTop(next);
  }
  on(els.pinBtnA, 'click', togglePin);

  on(els.hideBtnA, 'click', hide);
  on(els.hideBtnR, 'click', hide);
  function hide() {
    if (window.quickDock && window.quickDock.hide) window.quickDock.hide();
  }

  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') {
      // 展示窗口没有确认框和菜单（els.* 为 null）
      if (els.confirm && !els.confirm.hidden) { els.confirm.hidden = true; return; }
      if (els.menu && els.menu.classList.contains('open')) { closeMenu(); return; }
      hide();
    }
    // 数字键快选（选择题）
    var inter = state && state.interaction;
    if (inter && inter.status === 'open' && inter.kind === 'question' && /^[0-9]$/.test(ev.key) && document.activeElement.tagName !== 'TEXTAREA') {
      var q = (inter.questions || [])[0];
      var idx = Number(ev.key) - 1;
      if (q && q.options && q.options[idx]) {
        api('answer', { id: inter.id, answers: [{ id: q.id, selected: [q.options[idx].label] }] }).catch(toastErr);
        markAnswered();
      }
    }
  });

  /* ================= danger confirm ================= */
  var confirmCb = null;
  function confirmDanger(cb) {
    confirmCb = cb;
    els.confirm.hidden = false;
  }
  els.confirmOk.addEventListener('click', function () {
    els.confirm.hidden = true;
    if (confirmCb) { confirmCb(); confirmCb = null; }
  });
  els.confirmCancel.addEventListener('click', function () {
    els.confirm.hidden = true;
    confirmCb = null;
  });

  } // end if (!isDisplay) —— 输入窗口专属绑定到此结束

  /* ================= 点击穿透（异形命中区） ================= */
  // 窗口默认是 OS 级穿透（setIgnoreMouseEvents），靠 forward 把鼠标事件转发进来。
  // 页面把「可交互区域」矩形报告给主进程，主进程用光标位置判断何时取消穿透。
  //
  // 拖动条必须在可交互区域内：主进程取消穿透后，-webkit-app-region: drag 才能生效。
  var DRAG_SELECTOR = '.bar, .sess-head, .exec-head, .run-head';
  var hitReportTimer = null;

  function collectRects(selector) {
    var rects = [];
    var nodes = document.querySelectorAll(selector);
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.hidden || el.classList.contains('hidden')) continue;
      var r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      rects.push({ x: r.left, y: r.top, width: r.width, height: r.height });
    }
    return rects;
  }

  function reportHitRegions() {
    var qd = window.quickDock;
    if (!qd) return;
    if (isDisplay) {
      // 展示窗口：**块本身**可交互（这样能滚轮滚动、能展开思考块），
      // 块与块之间的空隙保持透明且穿透 —— 正是「每个模块一个块，中间透明」。
      if (qd.setHitRegions) {
        try { qd.setHitRegions(collectRects('.blocks')); } catch (e) {}
      }
      if (qd.setDragZones) {
        try { qd.setDragZones([]); } catch (e) {}
      }
      return;
    }
    // 可交互区：面板 + 菜单 + 提示 + 弹层
    if (qd.setHitRegions) {
      try { qd.setHitRegions(collectRects('.panel, .menu, .toast, .modal-backdrop')); } catch (e) {}
    }
    // 拖动区：标题条。主进程据此在光标悬停时取消穿透，让 drag 生效。
    if (qd.setDragZones) {
      try { qd.setDragZones(collectRects(DRAG_SELECTOR)); } catch (e) {}
    }
  }

  function scheduleHitReport() {
    clearTimeout(hitReportTimer);
    hitReportTimer = setTimeout(reportHitRegions, 50);
  }

  document.addEventListener('mousemove', function (ev) {
    var qd = window.quickDock;
    if (!qd || !qd.setInteractive) return;
    if (isDisplay) {
      var dhit = ev.target && ev.target.closest && ev.target.closest('.blocks');
      qd.setInteractive(Boolean(dhit));
      return;
    }
    var hit = ev.target && ev.target.closest && ev.target.closest('.panel, .menu, .toast, .modal-backdrop, ' + DRAG_SELECTOR);
    // 拖动条上保持可交互：穿透状态下 ev.target 未必可靠，
    // 但在拖动条上必须 true，否则窗口会被重新穿透，拖动失效。
    var overDrag = ev.target && ev.target.closest && ev.target.closest(DRAG_SELECTOR);
    qd.setInteractive(Boolean(hit) || Boolean(overDrag));
  });

  // 尺寸/布局变化后重新上报命中区
  window.addEventListener('resize', scheduleHitReport);
  if (window.ResizeObserver) {
    try { new ResizeObserver(scheduleHitReport).observe(document.body); } catch (e) {}
  }
  scheduleHitReport();

  /* ================= boot ================= */
  if (TOKEN) {
    api('state').then(applyState).catch(function (e) { toastErr(e); markOffline(); });
    connectStream();
  } else {
    markOffline();
  }
  if (!isDisplay && els.sendBtn) els.sendBtn.disabled = true;

  /**
   * 展示窗口：跟随主进程的「贴上/贴下」切换内容对齐方向。
   *
   * 贴在上方时内容从底部往上生长（紧贴输入窗口，不会在中间留空隙）；
   * 贴在下方时从顶部往下生长。窗口本身尺寸始终不变。
   */
  if (isDisplay) {
    function applyAbove(value) {
      document.body.classList.toggle('above', Boolean(value));
    }
    // 自动滚动：绑定滚动容器，首次进来先贴底
    bindAutoScroll();
    var scInit = scrollHost();
    if (scInit) scInit.scrollTop = scInit.scrollHeight;

    var qd = window.quickDock;
    if (qd) {
      if (qd.onStateChanged) {
        qd.onStateChanged(function (s) { if (s) applyAbove(s.displayAbove); });
      }
      if (qd.getState) {
        try { qd.getState().then(function (s) { if (s) applyAbove(s.displayAbove); }).catch(function () {}); } catch (e) {}
      }
    }
  }
})();
