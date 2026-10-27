window.__ModuleLoader__.load({ id: "dsh-quickdock", factory: (require) => { var module = { exports: {} }; var exports = module.exports;
try {
var React = require('react');
/**
 * dsh-quickdock — Client 半（静态插件）
 *
 * 运行期可用符号：React、ctx、host（静态半只有 ctx 服务；host.call 属动态插件）。
 * 不 import 任何 @deepseek-ai/dsh-client-* 包。
 *
 * 注册插槽 conversation.session.header.actions：
 * 会话标题栏「⧉」按钮 —— 把当前会话推到 QuickDock（优先级 1010，排在 dsh-rewind 之后）。
 * dock 的唤出由宿主 autoLaunch 常驻，无需侧栏按钮。
 */
const PLUGIN_ID = 'dsh-quickdock'
const HEADER_SLOT = 'conversation.session.header.actions'

function el(tag, props) {
  return React.createElement.apply(React, arguments)
}

/* ---------------- 错误提示 ---------------- */

/**
 * 轮询 dock 启动结果。
 *
 * dock 启动是异步的（宿主要先探测 Electron、下载、spawn、等 ready），
 * bind 的同步返回拿不到最终结果。失败信息由宿主写入 status.error，
 * 这里轮询几秒把失败原因取回来 —— 失败必须让用户看见，不能静默。
 */
async function waitForDockResult(timeoutMs) {
  // 首次唤出可能要下载 Electron（约 100MB，几分钟），所以给足时间；
  // 但一旦久等就要明确告诉用户「在准备什么」，不能让人对着无反应的按钮发呆。
  const limit = timeoutMs || 180000
  const started = Date.now()
  let lastError = ''
  let announced = false
  while (Date.now() - started < limit) {
    await new Promise(function (r) { setTimeout(r, 400) })
    try {
      const res = await fetch('/api/quickdock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'status' })
      })
      if (!res.ok) continue
      const st = await res.json().catch(function () { return {} })
      if (st && st.error) {
        lastError = String(st.error)
        // 错误可能重复上报，等一会儿看是否稳定
        await new Promise(function (r) { setTimeout(r, 500) })
        try {
          const res2 = await fetch('/api/quickdock', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'status' })
          })
          const st2 = await res2.json().catch(function () { return {} })
          // 还在重试（宿主会自动退避重拉）就先别报错
          if (st2 && st2.error && !st2.starting) return showError(st2.error)
        } catch (e) {}
        if (!st.starting) return showError(lastError)
        continue
      }
      if (st && st.running) return
      if (st && st.starting && !announced && Date.now() - started > 4000) {
        announced = true
        showHint('QuickDock 正在准备桌面窗口（首次需要下载 Electron，约 1–2 分钟，只需一次）…')
      }
    } catch (e) {}
  }
  if (lastError) showError(lastError)
  else showError('QuickDock 启动超时。请看 %LOCALAPPDATA%\\dsh-quickdock\\host.log')
}

/**
 * 显示一条错误提示（DOM toast）。
 *
 * 设计原则：**错误必须让用户看见**。宿主失败时不静默降级、不假装成功，
 * 而是在按钮旁边明确提示原因。
 */
let toastEl = null
let toastTimer = null

const TOAST_KINDS = {
  error: { border: 'rgba(220, 80, 80, .6)', background: 'rgba(48, 16, 16, .96)', color: '#ffd7d7', ttl: 8000 },
  hint: { border: 'rgba(77, 142, 255, .55)', background: 'rgba(14, 24, 40, .96)', color: '#cfe1ff', ttl: 6000 }
}

/**
 * 在页面右下角显示一条提示。
 *
 * 设计原则：**状态必须让用户看见**。宿主失败时不静默降级、不假装成功；
 * 需要等待（例如首次下载 Electron）也要说清楚在等什么。
 */
function showToast(message, kind) {
  const text = String(message || '未知错误')
  const style = TOAST_KINDS[kind] || TOAST_KINDS.error
  try {
    if (!toastEl) {
      toastEl = document.createElement('div')
      toastEl.setAttribute('role', 'alert')
      toastEl.setAttribute('data-plugin', PLUGIN_ID)
      Object.assign(toastEl.style, {
        position: 'fixed',
        right: '16px',
        bottom: '16px',
        zIndex: '2147483647',
        maxWidth: '420px',
        padding: '10px 14px',
        borderRadius: '8px',
        font: '12px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif',
        whiteSpace: 'pre-wrap',
        boxShadow: '0 6px 24px rgba(0, 0, 0, .35)',
        pointerEvents: 'none',
      })
      document.body.appendChild(toastEl)
    }
    toastEl.style.border = '1px solid ' + style.border
    toastEl.style.background = style.background
    toastEl.style.color = style.color
    toastEl.textContent = 'QuickDock: ' + text
    toastEl.style.display = 'block'
    clearTimeout(toastTimer)
    toastTimer = setTimeout(function () {
      if (toastEl) toastEl.style.display = 'none'
    }, style.ttl)
  } catch (error) {
    // 连 DOM 都不可用时，至少不要静默吞掉
    console.error('[dsh-quickdock] ' + text)
  }
}

function showError(message) { showToast(message, 'error') }
function showHint(message) { showToast(message, 'hint') }

/* ---------------- 会话标题栏「推到 dock」 ---------------- */

function SendToDock(props) {
  const sessionId = props?.sessionId
  if (!sessionId) return null
  const onClick = async (event) => {
    event.stopPropagation()
    try {
      const res = await fetch('/api/quickdock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'bind', sessionId })
      })
      if (!res.ok) {
        showError('[dsh-quickdock] 请求失败：HTTP ' + res.status)
        return
      }
      const result = await res.json().catch(() => ({}))
      // 失败必须让用户看见，不做任何兜底
      if (result.error) {
        showError(result.error)
        return
      }
      // dock 启动是异步的：bind 返回时可能还没失败。
      // 轮询几次拿到真正的结果 —— 失败必须让用户看见。
      await waitForDockResult()
    } catch (error) {
      showError('QuickDock 请求失败：' + String(error && error.message || error))
    }
  }
  return el('button', {
    type: 'button',
    id: PLUGIN_ID + '-send',
    title: '在 QuickDock 中打开此会话',
    onClick,
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '4px',
      height: '22px',
      padding: '0 8px',
      border: '1px solid rgba(77,142,255,.55)',
      background: 'rgba(77,142,255,.16)',
      color: 'var(--dsw-alias-brand-primary, #4d8eff)',
      cursor: 'pointer',
      borderRadius: '11px',
      fontSize: '11px',
      fontWeight: 500,
      lineHeight: '20px',
      flex: 'none'
    }
  },
  el('svg', {
    width: 11, height: 11, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true, style: { flex: 'none' }
  },
  el('rect', { x: 1, y: 1, width: 14, height: 9, rx: 2.5, stroke: 'currentColor', strokeWidth: 1.6 }),
  el('rect', { x: 4, y: 12.4, width: 8, height: 2.6, rx: 1.3, fill: 'currentColor' })),
  el('span', null, 'Dock'))
}

/* ---------------- 主题同步 ---------------- */

/**
 * dock 用到的 21 个主题 token（DESIGN 7.2）。
 *
 * 主题只存在于**浏览器**（dsh-client-ui-theme 在 Web 客户端里跑），
 * dock 是一个独立 Electron 窗口，拿不到这些 CSS 变量。
 * 所以这里把快照推给宿主，宿主再通过 SSE 分发给 dock 页面。
 */
const THEME_TOKENS = [
  '--dsw-alias-bg-base', '--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-2', '--dsw-alias-bg-overlay',
  '--dsw-alias-border-l1', '--dsw-alias-border-l2',
  '--dsw-alias-label-primary', '--dsw-alias-label-secondary', '--dsw-alias-label-tertiary',
  '--dsw-alias-brand-primary',
  '--dsw-alias-state-success-primary', '--dsw-alias-state-error-primary', '--dsw-alias-state-warn-primary', '--dsw-alias-state-idle-primary',
  '--dsw-alias-interactive-bg-hover', '--dsw-alias-interactive-bg-active',
  '--dsw-alias-scrollbar-bg-l1', '--dsw-alias-scrollbar-hover-l1',
  '--dsw-alias-separator-primary', '--dsw-alias-tooltip-bg', '--dsw-alias-tooltip-key-bg'
]

function themePayload(snapshot) {
  if (!snapshot || !snapshot.active) return null
  const source = snapshot.active.tokens || {}
  const tokens = {}
  for (const name of THEME_TOKENS) {
    const value = source[name]
    if (typeof value === 'string' && value) tokens[name] = value
  }
  if (Object.keys(tokens).length < 6) return null
  return {
    colorScheme: snapshot.active.colorScheme === 'light' ? 'light' : 'dark',
    tokens,
    fonts: {
      text: snapshot.fontFamilies?.text ?? '',
      code: snapshot.fontFamilies?.code ?? '',
      sizeText: snapshot.fontSizes?.text ?? 12,
      sizeCode: snapshot.fontSizes?.code ?? 11
    }
  }
}

function pushTheme(payload) {
  if (!payload) return
  fetch('/api/quickdock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'theme', theme: payload })
  }).catch(function () {})
}

/** 主题变了就同步给 dock（失败静默：主题不该影响任何功能）。 */
function syncTheme(tctx) {
  try {
    pushTheme(themePayload(tctx.theme.getTheme()))
  } catch (error) {
    console.warn('[dsh-quickdock] theme sync failed:', error)
  }
  tctx.on('theme/change', function (snapshot) {
    try {
      pushTheme(themePayload(snapshot))
    } catch (error) {
      console.warn('[dsh-quickdock] theme sync failed:', error)
    }
  })
}


/* ---------------- 命令总线：在 DSH 主窗口打开会话 ---------------- */

/**
 * dock 是独立进程，改不了浏览器里的 SPA；这边是浏览器插件，能调
 * ctx.uiWorkspace.openSession()，所以由宿主转发一条命令过来。
 *
 * 用 SSE 而不是轮询：这条总线只在"点按钮的那一下"有数据，但没有它
 * 就只能靠定时问，反应会慢半拍。断了自动重连（3s）。
 */
function connectCommandBus(onCommand) {
  var source = null
  var retry = null
  var stopped = false

  function schedule() {
    if (stopped || retry) return
    retry = setTimeout(function () { retry = null; open() }, 3000)
  }

  function open() {
    if (stopped) return
    fetch('/api/quickdock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'web-url' })
    }).then(function (res) { return res.json() }).then(function (body) {
      var token = ''
      try { token = new URL(body && body.url, location.href).searchParams.get('t') || '' } catch (e) {}
      if (!token) throw new Error('bus token unavailable')
      if (stopped) return
      source = new EventSource('/quickdock/api/bus?t=' + encodeURIComponent(token))
      source.addEventListener('command', function (event) {
        var command = null
        try { command = JSON.parse(event.data) } catch (e) {}
        if (command && command.type === 'open-session' && command.sessionId) {
          try { onCommand(command.sessionId) } catch (error) {
            console.error('[dsh-quickdock] open-session failed:', error)
          }
        }
      })
      source.onerror = function () {
        try { source.close() } catch (e) {}
        source = null
        schedule()
      }
    }).catch(function () { schedule() })
  }

  open()
  return function stop() {
    stopped = true
    if (retry) clearTimeout(retry)
    if (source) {
      try { source.close() } catch (e) {}
    }
  }
}

function apply(ctx) {
  try {
    ctx.slots.inject(HEADER_SLOT, () => ctx.slots.register({
      name: HEADER_SLOT,
      id: PLUGIN_ID + '-send-to-dock',
      registrant: PLUGIN_ID,
      // order 才是显示顺序（priority 是插槽内部的重叠优先级，传了也会被覆盖）
      order: 1010
    }, SendToDock))
  } catch (error) {
    console.error('[dsh-quickdock] client apply failed (plugin disabled, web boot continues):', error)
  }
  // theme 是可选依赖：没有它按钮照样能用，只是 dock 用内置兜底色
  try {
    ctx.inject(['theme'], syncTheme)
  } catch (error) {
    console.warn('[dsh-quickdock] theme service unavailable:', error)
  }
  // 「在 DSH 打开会话」的接收端（可选依赖：没有 uiWorkspace 就只是没这个功能）
  try {
    ctx.inject(['uiWorkspace'], function (uiCtx) {
      var stop = connectCommandBus(function (sessionId) {
        uiCtx.uiWorkspace.openSession(sessionId)
        try { window.focus() } catch (error) {}
      })
      uiCtx.effect(function () { return stop }, 'quickdock: command bus')
    })
  } catch (error) {
    console.warn('[dsh-quickdock] uiWorkspace unavailable:', error)
  }
}
return {
  name: 'dsh-quickdock',
  inject: ['slots'],
  apply
};
} catch (bootError) {
  console.error('[dsh-quickdock] client factory failed (plugin disabled, web boot continues):', bootError);
  return { apply() {} };
}
} });
