window.__ModuleLoader__.load({ id: "dsh-quickdock", factory: (require) => { var module = { exports: {} };
// The loader contract passes an exports binding even when the plugin exports nothing.
// eslint-disable-next-line no-unused-vars
var exports = module.exports;
try {
var React = require('react');
/**
 * dsh-quickdock — Client half (static plugin).
 *
 * Available at runtime: React, ctx, host (a static plugin only has ctx
 * services; host.call belongs to dynamic plugins). No @deepseek-ai/dsh-client-*
 * package may be imported.
 *
 * Registers conversation.session.header.actions: the "Dock" button that pushes
 * the current session to QuickDock (order 1010, after dsh-rewind). The dock is
 * launched by the Host on demand, so no sidebar button is needed.
 */
const PLUGIN_ID = 'dsh-quickdock'
const HEADER_SLOT = 'conversation.session.header.actions'
const FOOTER_SLOT = 'sidebar.footer.action'
const BRIDGE = '/api/quickdock'

function el(tag, props) {
  return React.createElement.apply(React, arguments)
}

/* i18n-catalog:start — kept in sync with locale/en.json + locale/zh.json */
var MESSAGES = {
  en: {
    'client.sendToDock': 'Open this session in QuickDock',
    'client.label': 'Dock',
    'client.unknownError': 'Unknown error',
    'client.startTimeout': 'QuickDock did not start in time. See {log}',
    'client.preparing': 'QuickDock is preparing its desktop window (the first run downloads Electron, ~1–2 minutes, once)…',
    'client.requestFailed': 'Request failed: HTTP {status}',
    'client.dockFailed': 'QuickDock request failed: {reason}',
    'client.downloading': 'QuickDock is downloading its desktop runtime {percent}% ({mb}/{total} MB)',
    'client.more': 'More dock actions',
    'client.reloadApp': 'Reload the app',
    'client.reloadFailed': 'Reload failed: {reason}',
    'client.restartDock': 'Restart the dock window',
    'client.restartFailed': 'Restart failed: {reason}',
    'client.resetWindows': 'Reset the window size',
    'client.resetFailed': 'Reset failed: {reason}'
  },
  zh: {
    'client.sendToDock': '在 QuickDock 中打开此会话',
    'client.label': 'Dock',
    'client.unknownError': '未知错误',
    'client.startTimeout': 'QuickDock 启动超时。请看 {log}',
    'client.preparing': 'QuickDock 正在准备桌面窗口（首次需要下载 Electron，约 1–2 分钟，只需一次）…',
    'client.requestFailed': '请求失败：HTTP {status}',
    'client.dockFailed': 'QuickDock 请求失败：{reason}',
    'client.downloading': 'QuickDock 正在下载桌面运行时 {percent}%（{mb}/{total} MB）',
    'client.more': '更多 Dock 操作',
    'client.reloadApp': '重新加载应用',
    'client.reloadFailed': '重新加载失败：{reason}',
    'client.restartDock': '重启 Dock 窗口',
    'client.restartFailed': '重启失败：{reason}',
    'client.resetWindows': '重置窗口大小',
    'client.resetFailed': '重置失败：{reason}'
  }
};
/* i18n-catalog:end */

var activeLocale = 'en'

function normalizeLocale(value) {
  var tag = String(value || '').toLowerCase()
  var primary = tag.split(/[-_]/)[0]
  return primary === 'zh' || primary === 'en' ? primary : ''
}

function detectLocale() {
  try {
    var tags = (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language])
    for (var i = 0; i < tags.length; i += 1) {
      var hit = normalizeLocale(tags[i])
      if (hit) return hit
    }
  } catch (error) {}
  return 'en'
}

/** Translate one client string; English is the fallback layer. */
function t(key, params) {
  var table = MESSAGES[activeLocale] || MESSAGES.en
  var template = table[key] !== undefined ? table[key] : (MESSAGES.en[key] || key)
  if (!params) return template
  return String(template).replace(/\{(\w+)\}/g, function (match, name) {
    return Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
  })
}

/** Bridge call; the Host answers {ok, error} and HTTP errors carry a reason. */
async function bridge(action, payload) {
  const res = await fetch(BRIDGE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ action: action }, payload || {}))
  })
  const data = await res.json().catch(function () { return null })
  if (!res.ok) throw new Error(t('client.requestFailed', { status: res.status }))
  return data || {}
}

/* ---------------- locale sync ---------------- */

/** Adopt a locale id, then let the Host localize its dock pages. */
function applyLocale(locale) {
  const next = normalizeLocale(locale)
  if (next) activeLocale = next
  bridge('locale', { locale: activeLocale }).catch(function () {})
}

function syncLocale(lctx) {
  let snapshot = null
  try {
    snapshot = lctx.locale.getLocale()
  } catch (error) {}
  applyLocale(snapshot && snapshot.active ? snapshot.active : detectLocale())
  try {
    return lctx.effect(function () {
      return lctx.locale.subscribe(function () {
        try {
          applyLocale(lctx.locale.getLocale().active)
        } catch (error) {}
      })
    }, 'quickdock: locale sync')
  } catch (error) {
    return null
  }
}

/* ---------------- toasts ---------------- */

/**
 * Show a message in the page corner.
 *
 * Errors are never silent: a dock that fails to start must explain itself,
 * and a long first start must say what it is waiting for.
 */
let toastEl = null
let toastTimer = null

const TOAST_KINDS = {
  error: { border: 'rgba(220, 80, 80, .6)', background: 'rgba(48, 16, 16, .96)', color: '#ffd7d7', ttl: 8000 },
  hint: { border: 'rgba(77, 142, 255, .55)', background: 'rgba(14, 24, 40, .96)', color: '#cfe1ff', ttl: 6000 }
}

function showToast(message, kind) {
  const text = String(message || t('client.unknownError'))
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
        pointerEvents: 'none'
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
    // Even with no DOM the reason must not disappear.
    console.error('[dsh-quickdock] ' + text)
  }
}

function showError(message) {
  showToast(message, 'error')
}

function showHint(message) {
  showToast(message, 'hint')
}

/* ---------------- dock start polling ---------------- */

/**
 * Poll the dock start result.
 *
 * Starting is asynchronous (probe Electron, download, spawn, wait for ready),
 * so the synchronous bind response cannot report the final outcome.
 * The first start may download ~100MB, hence the generous timeout.
 */
async function waitForDockResult(timeoutMs) {
  const limit = timeoutMs || 180000
  const started = Date.now()
  let lastError = ''
  let announced = false
  while (Date.now() - started < limit) {
    await new Promise(function (resolve) { setTimeout(resolve, 400) })
    try {
      const state = await bridge('status')
      if (state && state.error) {
        lastError = String(state.error)
        // Give the supervisor a moment to retry before reporting.
        await new Promise(function (resolve) { setTimeout(resolve, 500) })
        const again = await bridge('status').catch(function () { return {} })
        if (again && again.error && !again.starting) {
          showError(again.error)
          return
        }
        if (!state.starting) {
          showError(lastError)
          return
        }
        continue
      }
      if (state && state.running) return
      if (state && state.starting && !announced && Date.now() - started > 4000) {
        announced = true
        showHint(t('client.preparing'))
      }
    } catch (error) {}
  }
  if (lastError) showError(lastError)
  else showError(t('client.startTimeout', { log: '%LOCALAPPDATA%\\dsh-quickdock\\host.log' }))
}

/* ---------------- header button ---------------- */

function SendToDock(props) {
  const sessionId = props && props.sessionId
  if (!sessionId) return null
  const suffix = React.useRef(null)
  const [menu, setMenu] = React.useState(null)

  // The header row may clip its children, so the menu is positioned from the
  // suffix' own rectangle with position:fixed and closed on any outside click.
  React.useEffect(() => {
    if (!menu) return undefined
    const close = (event) => {
      if (suffix.current && suffix.current.contains(event.target)) return
      if (event.target && event.target.closest && event.target.closest('.' + PLUGIN_ID + '-menu')) return
      setMenu(null)
    }
    const onKey = (event) => { if (event.key === 'Escape') setMenu(null) }
    document.addEventListener('mousedown', close, true)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('mousedown', close, true)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('resize', close)
    }
  }, [menu])

  const onClick = async (event) => {
    event.stopPropagation()
    try {
      const result = await bridge('bind', { sessionId: sessionId })
      // Bind failures are shown as-is: no silent fallback.
      if (result.error) {
        showError(result.error)
        return
      }
      await waitForDockResult()
    } catch (error) {
      showError(t('client.dockFailed', { reason: String(error && error.message || error) }))
    }
  }

  const openMenu = (event) => {
    event.stopPropagation()
    if (menu) {
      setMenu(null)
      return
    }
    const box = suffix.current ? suffix.current.getBoundingClientRect() : null
    setMenu(box ? { top: Math.round(box.bottom + 4), right: Math.round(window.innerWidth - box.right) } : { top: 0, right: 0 })
  }

  const resetWindows = async (event) => {
    event.stopPropagation()
    setMenu(null)
    try {
      const result = await bridge('reset', {})
      if (result && result.error) showError(t('client.resetFailed', { reason: result.error }))
    } catch (error) {
      showError(t('client.resetFailed', { reason: String(error && error.message || error) }))
    }
  }

  const reloadApp = async (event) => {
    event.stopPropagation()
    setMenu(null)
    try {
      const result = await bridge('reload-dock', {})
      if (result && result.error) showError(t('client.reloadFailed', { reason: result.error }))
    } catch (error) {
      showError(t('client.reloadFailed', { reason: String(error && error.message || error) }))
    }
  }

  const restart = async (event) => {
    event.stopPropagation()
    setMenu(null)
    try {
      const result = await bridge('restart', {})
      if (result && result.error) showError(t('client.restartFailed', { reason: result.error }))
    } catch (error) {
      showError(t('client.restartFailed', { reason: String(error && error.message || error) }))
    }
  }

  // Only the actions that still mean something: the window has its own close
  // button, and reloading the app is lighter than restarting the process.
  const menuItems = [
    { key: 'reset', label: t('client.resetWindows'), onClick: resetWindows },
    { key: 'reload', label: t('client.reloadApp'), onClick: reloadApp },
    { key: 'restart', label: t('client.restartDock'), onClick: restart }
  ]

  const pill = {
    height: '22px',
    border: '1px solid rgba(77,142,255,.55)',
    background: 'rgba(77,142,255,.16)',
    color: 'var(--dsw-alias-brand-primary, #4d8eff)',
    cursor: 'pointer',
    fontSize: '11px',
    fontWeight: 500,
    lineHeight: '20px',
    flex: 'none'
  }

  return el('div', { style: { display: 'inline-flex', alignItems: 'center', flex: 'none' } },
    el('button', {
      type: 'button',
      id: PLUGIN_ID + '-send',
      title: t('client.sendToDock'),
      'aria-label': t('client.sendToDock'),
      onClick,
      style: Object.assign({}, pill, {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        padding: '0 8px',
        borderTopLeftRadius: '11px',
        borderBottomLeftRadius: '11px',
        borderRight: 'none'
      })
    },
    el('svg', {
      width: 11, height: 11, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true, style: { flex: 'none' }
    },
    el('rect', { x: 1, y: 1, width: 14, height: 9, rx: 2.5, stroke: 'currentColor', strokeWidth: 1.6 }),
    el('rect', { x: 4, y: 12.4, width: 8, height: 2.6, rx: 1.3, fill: 'currentColor' })),
    el('span', null, t('client.label'))),

    el('button', {
      type: 'button',
      ref: suffix,
      id: PLUGIN_ID + '-more',
      title: t('client.more'),
      'aria-label': t('client.more'),
      'aria-haspopup': 'menu',
      'aria-expanded': menu ? 'true' : 'false',
      onClick: openMenu,
      style: Object.assign({}, pill, {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '18px',
        padding: 0,
        marginLeft: '-1px',
        borderTopRightRadius: '11px',
        borderBottomRightRadius: '11px',
        fontSize: '8px'
      })
    }, '\u25be'),

    menu ? el('div', {
      className: PLUGIN_ID + '-menu',
      role: 'menu',
      style: {
        position: 'fixed',
        top: menu.top + 'px',
        right: menu.right + 'px',
        minWidth: '176px',
        padding: '4px',
        borderRadius: 'var(--dsw-radius-md, 8px)',
        background: 'var(--dsw-alias-bg-overlay, #232324)',
        border: '0.5px solid var(--dsw-alias-border-l2, rgba(255,255,255,.12))',
        boxShadow: 'var(--dsw-elevation-panel, 0 12px 32px -8px rgba(0,0,0,.55))',
        zIndex: 3000
      }
    }, menuItems.map((item) => el('button', {
      key: item.key,
      type: 'button',
      role: 'menuitem',
      onClick: item.onClick,
      style: {
        display: 'flex',
        alignItems: 'center',
        width: '100%',
        height: '28px',
        padding: '0 8px',
        border: 'none',
        borderRadius: 'var(--dsw-radius-sm, 6px)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary, inherit)',
        font: 'inherit',
        fontSize: '12px',
        cursor: 'pointer',
        textAlign: 'left'
      },
      onMouseEnter: (event) => { event.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.07))' },
      onMouseLeave: (event) => { event.currentTarget.style.background = 'transparent' }
    }, item.label))) : null
  )
}

/* ---------------- theme sync ---------------- */

/**
 * The 21 dock theme tokens (DESIGN 7.2).
 *
 * Built-in DSH themes publish an empty token map: the palette is declared by
 * the --dsw-* stylesheets on <body> and selected by the data-ds-dark-theme
 * attribute. A snapshot therefore only carries the scheme and typography; the
 * colors are read from the main window's computed styles and pushed to the
 * Host, which inlines them into the dock page.
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

/** Body attribute selecting the dark base palette (owned by ui-layout). */
const DARK_ATTRIBUTE = 'data-ds-dark-theme'

/** Retry schedule while DSH has not mounted its token stylesheets yet (ms). */
const THEME_RETRY_MS = [120, 300, 700, 1500, 3000, 6000]

/** Probe fill for an undefined token; never a real palette value. */
const THEME_PROBE_MISSING = 'rgb(1, 2, 3)'

/** Read one custom property, tolerating a missing computed-style object. */
function readProperty(style, name) {
  if (!style) return ''
  try {
    return String(style.getPropertyValue(name) || '').trim()
  } catch (error) {
    return ''
  }
}

/**
 * Resolve one alias token to a concrete color through a probe element.
 *
 * The palette is declared as var() chains over the static scale, and a
 * computed custom property may still carry the unresolved chain. The probe
 * makes the browser resolve it exactly as the page would.
 */
function probeToken(probe, name, missing) {
  try {
    probe.style.backgroundColor = THEME_PROBE_MISSING
    probe.style.backgroundColor = 'var(' + name + ', ' + THEME_PROBE_MISSING + ')'
    const value = String(getComputedStyle(probe).backgroundColor || '').trim()
    // Undefined keeps the sentinel, a non-color value leaves the initial
    // transparent fill; anything else is a real token the dock can paint.
    return value && value !== missing && value !== 'rgba(0, 0, 0, 0)' ? value : ''
  } catch (error) {
    return ''
  }
}

/** The active palette, read from the main window's resolved computed styles. */
function readTokens() {
  const tokens = {}
  if (typeof document === 'undefined' || !document.body) return tokens
  let bodyStyle = null
  let rootStyle = null
  try { bodyStyle = getComputedStyle(document.body) } catch (error) {}
  try { rootStyle = getComputedStyle(document.documentElement) } catch (error) {}
  const unresolved = []
  for (const name of THEME_TOKENS) {
    const value = readProperty(bodyStyle, name) || readProperty(rootStyle, name)
    // A resolved custom property needs no probe; a var() chain does.
    if (value && value.indexOf('var(') < 0) tokens[name] = value
    else unresolved.push(name)
  }
  if (!unresolved.length) return tokens
  let probe = null
  try {
    probe = document.createElement('div')
    probe.setAttribute('aria-hidden', 'true')
    probe.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:0;height:0;pointer-events:none'
    document.body.appendChild(probe)
    probe.style.backgroundColor = THEME_PROBE_MISSING
    const missing = String(getComputedStyle(probe).backgroundColor || '').trim()
    for (const name of unresolved) {
      const value = probeToken(probe, name, missing)
      if (value) tokens[name] = value
    }
  } catch (error) {
    // Keep whatever the computed custom properties already provided.
  } finally {
    if (probe && probe.parentNode) probe.parentNode.removeChild(probe)
  }
  return tokens
}

/** Resolved scheme: the DOM is authoritative once the presenter applied it. */
function readScheme(snapshot) {
  try {
    if (document.body && typeof document.body.hasAttribute === 'function') {
      return document.body.hasAttribute(DARK_ATTRIBUTE) ? 'dark' : 'light'
    }
  } catch (error) {}
  return snapshot.active.colorScheme === 'light' ? 'light' : 'dark'
}

/** The bridge payload for one snapshot; null while the palette is unreadable. */
function themePayload(snapshot) {
  if (!snapshot || !snapshot.active) return null
  const tokens = readTokens()
  // Fewer than six tokens is not a real theme; the dock keeps its palette.
  if (Object.keys(tokens).length < 6) return null
  return {
    colorScheme: readScheme(snapshot),
    tokens,
    fonts: {
      text: snapshot.fontFamilies && snapshot.fontFamilies.text || '',
      code: snapshot.fontFamilies && snapshot.fontFamilies.code || '',
      sizeText: snapshot.fontSizes && snapshot.fontSizes.text || 12,
      sizeCode: snapshot.fontSizes && snapshot.fontSizes.code || 11
    }
  }
}

let themeTimer = null
let themeAttempt = 0
let themeSent = ''
let themeWarned = false

/** Push the palette once; retry while DSH has not injected its stylesheets. */
function deliverTheme(tctx) {
  let payload = null
  try {
    payload = themePayload(tctx.theme.getTheme())
  } catch (error) {
    console.warn('[dsh-quickdock] theme sync failed:', error)
    return
  }
  if (!payload) {
    if (themeAttempt < THEME_RETRY_MS.length) {
      scheduleTheme(tctx, THEME_RETRY_MS[themeAttempt])
      themeAttempt += 1
    } else if (!themeWarned) {
      themeWarned = true
      console.warn('[dsh-quickdock] no DSH theme tokens found; the dock keeps its palette')
    }
    return
  }
  themeAttempt = 0
  const json = JSON.stringify(payload)
  if (json === themeSent) return
  themeSent = json
  bridge('theme', { theme: payload }).catch(function () {})
}

function scheduleTheme(tctx, delay) {
  if (themeTimer) clearTimeout(themeTimer)
  themeTimer = setTimeout(function () {
    themeTimer = null
    deliverTheme(tctx)
  }, typeof delay === 'number' ? delay : 0)
}

/**
 * Read after the next paint: the palette presenter has its own theme/change
 * listener, so the attribute and font variables are only current afterwards.
 */
function scheduleThemeAfterPaint(tctx) {
  if (typeof requestAnimationFrame !== 'function') {
    scheduleTheme(tctx, 32)
    return
  }
  requestAnimationFrame(function () {
    requestAnimationFrame(function () {
      scheduleTheme(tctx, 0)
    })
  })
}

/** Adopt the main window palette on boot, on theme/change and on scheme flips. */
function syncTheme(tctx) {
  scheduleTheme(tctx, 0)
  tctx.on('theme/change', function () {
    scheduleThemeAfterPaint(tctx)
  })
  // The presenter toggles the palette attribute on <body>; observing it also
  // catches a boot-time scheme that emitted no theme/change on this context.
  try {
    if (typeof MutationObserver === 'function' && document.body) {
      const observer = new MutationObserver(function () {
        scheduleThemeAfterPaint(tctx)
      })
      observer.observe(document.body, { attributes: true, attributeFilter: [DARK_ATTRIBUTE] })
      if (typeof tctx.effect === 'function') {
        tctx.effect(function () {
          return function () { observer.disconnect() }
        }, 'quickdock: theme palette observer')
      }
    }
  } catch (error) {
    console.warn('[dsh-quickdock] theme palette observer unavailable:', error)
  }
}

/* ---------------- download badge (sidebar footer) ---------------- */

/**
 * Shows the desktop runtime download in the sidebar footer.
 *
 * The Host fetches ~100 MB once (on mount, or on the first Dock click). Without
 * a visible indicator that click looks like it did nothing, so the badge polls
 * the same bridge the header button already uses; no extra channel is needed.
 */
function DownloadBadge() {
  const [download, setDownload] = React.useState(null)
  React.useEffect(function () {
    let alive = true
    let timer = 0
    async function tick() {
      try {
        const status = await bridge('status')
        if (alive) setDownload(status && status.download ? status.download : null)
      } catch (error) {
        /* the host is restarting: keep the last value and retry */
      }
      if (alive) timer = setTimeout(tick, 1200)
    }
    tick()
    return function () {
      alive = false
      clearTimeout(timer)
    }
  }, [])
  if (!download || !download.active) return null
  const total = Number(download.total) || 0
  const received = Number(download.received) || 0
  const percent = total > 0 ? Math.min(99, Math.round((received / total) * 100)) : 0
  const label = total > 0
    ? t('client.downloading', {
      percent: String(percent),
      mb: (received / 1048576).toFixed(1),
      total: (total / 1048576).toFixed(0)
    })
    : t('client.preparing')
  return el('span', {
    id: PLUGIN_ID + '-download',
    title: label,
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '4px',
      padding: '0 6px',
      fontSize: '11px',
      lineHeight: '18px',
      color: 'var(--dsw-alias-brand-primary, #4d8eff)',
      flex: 'none'
    }
  }, total > 0 ? percent + '%' : '…')
}

/* ---------------- apply ---------------- */

/**
 * True when this page is the app *inside* the dock window.
 *
 * Two signals, because the SPA may rewrite its own URL after boot (dropping the
 * query before client modules run):
 *   - `?dock=1`, appended by the frame shell;
 *   - this document is an iframe (`window.self !== window.top`).
 */
function insideDockWindow() {
  try {
    if (new URLSearchParams(location.search).has('dock')) return true
  } catch (error) { /* ignore */ }
  try {
    return window.self !== window.top
  } catch (error) {
    return false
  }
}

/** Style element id, so a second apply() does not stack sheets. */
const DOCK_STYLE_ID = PLUGIN_ID + '-dock-layout'

/**
 * Layout fixes that only make sense in the dock window.
 *
 * At dock width the shipped sidebar squeezes the conversation into a sliver, so
 * while it is expanded it covers the whole window instead; picking a session
 * then collapses it, which is what a dock-sized window wants.
 *
 * The frame carries `data-sidebar-collapsed="true"` exactly while the sidebar is
 * a rail, so the rule can key off the app's own state instead of measuring.
 */
function applyDockMode() {
  if (document.getElementById(DOCK_STYLE_ID)) return
  const style = document.createElement('style')
  style.id = DOCK_STYLE_ID
  style.textContent = `
/* The dock has no right rail, and the conversation must fill the frame in both
   states. Pinning the centre column across every grid track keeps it full width
   no matter which side columns are hidden or lifted out of the flow. */
html[data-qd-dock] [class*="rightbarCol"] {
  display: none !important;
}
html[data-qd-dock] [class*="centerCol"] {
  grid-column: 1 / -1 !important;
  min-width: 0 !important;
}
/* Expanded: the sidebar floats over the whole window instead of squeezing it. */
html[data-qd-dock] [class*="_frame"][data-rightbar-collapsed]:not([data-sidebar-collapsed="true"]) [class*="sidebarCol"] {
  position: fixed !important;
  inset: 0 !important;
  width: 100vw !important;
  z-index: 60 !important;
  background: var(--dsw-alias-bg-base, #151517) !important;
}
/* Collapsed: the strip only ever held the expand toggle, so the column goes away
   entirely and the conversation gets its space back. */
html[data-qd-dock] [data-sidebar-collapsed="true"] [class*="sidebarCol"] {
  display: none !important;
}
/* The app's panel list (plugins/automations/more) is not part of the dock. */
html[data-qd-dock] [class*="panelList"] {
  display: none !important;
}
`
  try {
    document.head.appendChild(style)
  } catch (error) {
    return
  }
  document.documentElement.setAttribute('data-qd-dock', '1')

  // A session picked from the full-window sidebar should leave the conversation
  // visible again: collapse on the next tick, after the app handled the click.
  // The toggle is addressed by its class (inside the sidebar column), not by its
  // aria-label, which is localized.
  document.addEventListener('click', function (event) {
    const target = event.target
    if (!target || typeof target.closest !== 'function') return
    if (!target.closest('[class*="sessionRow"]')) return
    const frame = document.querySelector('[class*="_frame"][data-rightbar-collapsed]')
    if (!frame || frame.hasAttribute('data-sidebar-collapsed')) return
    const toggle = findToggle()
    if (!toggle) return
    setTimeout(function () { try { toggle.click() } catch (error) { /* ignore */ } }, 0)
  }, true)

  // The dock window opens on the conversation: the sidebar state is shared with
  // the main window through localStorage, so an expanded sidebar there would
  // cover the whole dock on every start. Collapse it once, then stop - clicking
  // again during this window used to undo the user's expand.
  let attempts = 0
  const collapseOnStart = setInterval(function () {
    attempts += 1
    const frame = document.querySelector('[class*="_frame"][data-rightbar-collapsed]')
    if (frame && frame.hasAttribute('data-sidebar-collapsed')) {
      clearInterval(collapseOnStart)
      return
    }
    const toggle = frame ? findToggle() : null
    if (toggle) {
      try { toggle.click() } catch (error) { /* ignore */ }
    }
    if (attempts > 30) clearInterval(collapseOnStart)
  }, 100)

  /* ---- shell <-> app channel (the dock title bar drives the sidebar) ---- */

  /**
   * Report the sidebar state to the shell so its button can reflect it.
   * `window.parent` is our frame shell page; postMessage is the only channel
   * because the two documents are different origins.
   */
  function reportSidebarState() {
    const frame = document.querySelector('[class*="_frame"][data-rightbar-collapsed]')
    const expanded = frame ? !frame.hasAttribute('data-sidebar-collapsed') : false
    try { window.parent.postMessage({ type: 'quickdock:sidebar-state', expanded }, '*') } catch (error) { /* ignore */ }
  }

  window.addEventListener('message', function (event) {
    // Only our embedding shell may drive the layout.
    if (event.source !== window.parent) return
    const data = event.data
    if (!data) return
    if (data.type === 'quickdock:toggle-sidebar') {
      // The user is driving now: the boot-time collapse must not fight the click.
      clearInterval(collapseOnStart)
      const toggle = findToggle()
      if (toggle) {
        try { toggle.click() } catch (error) { /* ignore */ }
      }
      setTimeout(reportSidebarState, 80)
      return
    }
    if (data.type === 'quickdock:new-session') {
      // The shell owns the shortcut button while the sidebar is hidden; the app's
      // own button stays in the DOM and its click handler does the work.
      const create = document.querySelector('button[class*="newSession"]')
      if (create) {
        try { create.click() } catch (error) { /* ignore */ }
      }
    }
  })

  // Any click may have toggled the rail (its own button, a session row, ...).
  document.addEventListener('click', function () { setTimeout(reportSidebarState, 80) }, true)
  setTimeout(reportSidebarState, 400)
  setTimeout(reportSidebarState, 1200)

  // The account menu only carries full-window actions (settings, feedback, sign
  // out); at dock size none of them is usable, so the trigger goes away too.
  hideDocklessMenuItems()
  // Mirror the session title into the shell's title bar and tell it which session
  // is on screen (the shell's handoff button sends that back to the main window).
  followDocumentTitle()
  followCurrentSession()
}

/**
 * Account-menu entries that only make sense in the full DSH window.
 *
 * Written as escapes on purpose: the repository check keeps literal CJK out of
 * product code (UI strings live in locale/*.json), and these are DSH's labels,
 * not ours.
 */
const HIDDEN_MENU_ITEMS = [
  /\u8bbe\u7f6e/,               // settings
  /settings/i,
  /\u610f\u89c1\u53cd\u9988/,   // feedback
  /feedback/i,
  /\u9000\u51fa\u767b\u5f55/,   // sign out
  /\u9000\u51fa\u5e33\u865f/,   // sign out (traditional)
  /\u767b\u51fa/,               // log out (traditional)
  /sign\s*out/i
]

/** The avatar that opens the account menu (localised label, hence the pattern). */
const ACCOUNT_TRIGGER = /(\u8d26\u53f7\u83dc\u5355)|account\s*menu|account/i

/**
 * Conversation-header actions that need the full window.
 *
 * At dock width the workspace opener, its "open with" chevron, the overflow menu
 * and the right-sidebar toggle crowd out the session title and cannot be used
 * meaningfully, so they go away in the dock.
 */
const HIDDEN_HEADER_BUTTONS = [
  /^\u7528 .+\u6253\u5f00$/,          // "open with <app>"
  /open with/i,
  /\u66f4\u591a\u6253\u5f00\u65b9\u5f0f/, // more ways to open
  /more ways to open/i,
  /\u66f4\u591a\u64cd\u4f5c/,         // more actions
  /more actions/i,
  /\u6253\u5f00\u53f3\u4fa7\u8fb9\u680f/, // open right sidebar
  /\u6536\u8d77\u53f3\u4fa7\u8fb9\u680f/, // close right sidebar
  /open right sidebar/i,
  /close right sidebar/i
]

/** Strip the "— DeepSeek Harness" suffix DSH appends to its document title. */
function sessionTitleOf(documentTitle) {
  const text = String(documentTitle || '').trim()
  const split = text.lastIndexOf(' \u2014 ')
  return (split > 0 ? text.slice(0, split) : text).trim()
}

/**
 * Keep the dock title bar in sync with the session title.
 *
 * The app owns the title (it folds it from the session log), so the shell reads
 * it from `document.title` here and mirrors it; no session state is modelled.
 */
function followDocumentTitle() {
  let last = ''
  const report = function () {
    let title = sessionTitleOf(document.title)
    // An unsaved session has no name yet and DSH reports the bare app name; use
    // the app's own label for "new session" instead of showing a brand twice.
    if (!title || title === 'DeepSeek Harness') {
      const create = document.querySelector('button[class*="newSession"]')
      const label = create && create.getAttribute('aria-label')
      if (label) title = String(label).trim()
    }
    if (!title || title === last) return
    last = title
    try { window.parent.postMessage({ type: 'quickdock:title', title: title }, '*') } catch (error) { /* ignore */ }
  }
  try {
    const titleElement = document.querySelector('title')
    if (titleElement) new MutationObserver(report).observe(titleElement, { childList: true, characterData: true, subtree: true })
  } catch (error) { /* poll below still runs */ }
  report()
  setInterval(report, 1200)
}

/**
 * Sidebar entries that only the full window needs.
 *
 * Management surfaces (plugins, automations, the "more" menu), workspace
 * creation and the list view options do not belong in a 460px dock; the session
 * list, the new-session button and search stay.
 *
 * Exact labels, not substrings: the "more views" entry and the "show remaining
 * N sessions" row must survive.
 */
const HIDDEN_SIDEBAR_LABELS = new Set([
  '\u63d2\u4ef6',           // plugins
  'plugins',
  '\u81ea\u52a8\u5316\u4efb\u52a1', // automation tasks
  'automations',
  '\u81ea\u52a8\u5316',
  '\u66f4\u591a',           // more
  'more',
  '\u6dfb\u52a0\u5de5\u4f5c\u533a', // add workspace
  'add workspace',
  '\u89c6\u56fe\u9009\u9879', // view options
  'view options'
])

/**
 * Hide the account-menu entries that only the full window needs.
 *
 * The menu is portalled when it opens, so this runs on DOM insertions instead of
 * once at boot; entries are matched by their label because the item list carries
 * no stable ids.
 */
function hideDocklessMenuItems() {
  const sweep = function () {
    for (const item of document.querySelectorAll('[role="menuitem"]')) {
      const label = String(item.textContent || '').trim()
      if (!label) continue
      if (HIDDEN_MENU_ITEMS.some(function (pattern) { return pattern.test(label) })) {
        item.style.display = 'none'
      }
    }
    // The trigger is useless once every entry is gone.
    for (const trigger of document.querySelectorAll('button[aria-label]')) {
      const label = String(trigger.getAttribute('aria-label') || '')
      if (ACCOUNT_TRIGGER.test(label)) trigger.style.display = 'none'
      if (HIDDEN_HEADER_BUTTONS.some(function (pattern) { return pattern.test(label) })) {
        trigger.style.display = 'none'
      }
    }
    // Sidebar: drop the management rows, keep navigation and the session list.
    const column = document.querySelector('[class*="sidebarCol"]')
    if (column) {
      for (const entry of column.querySelectorAll('button')) {
        const label = String(entry.getAttribute('aria-label') || entry.textContent || '').trim()
        if (!label) continue
        if (HIDDEN_SIDEBAR_LABELS.has(label) || HIDDEN_SIDEBAR_LABELS.has(label.toLowerCase())) {
          entry.style.display = 'none'
        }
      }
    }
    // The session title lives in the dock's own title bar now, so the app's title
    // row is a wasted 30px: drop the whole row, not just the text. The header also
    // reserves a leading strip and a fixed 76px height that the tab strip then
    // stretches into - collapse all of it, or the space stays even without text.
    const titleCluster = document.querySelector('[class*="titleCluster"]')
    const titleRow = titleCluster && titleCluster.parentElement
    if (titleRow) titleRow.style.display = 'none'
    for (const leading of document.querySelectorAll('[class*="headerLeading"]')) {
      leading.style.display = 'none'
    }
    for (const header of document.querySelectorAll('header')) {
      if (!header.querySelector('[class*="titleCluster"], [class*="tabs"]')) continue
      header.style.height = 'auto'
      header.style.minHeight = '0px'
      header.style.paddingTop = '0px'
      header.style.paddingBottom = '0px'
      header.style.paddingRight = '10px'
    }
    for (const tabs of document.querySelectorAll('[class*="tabs"]')) {
      tabs.style.height = 'auto'
      tabs.style.marginTop = '6px'
    }
  }
  let queued = false
  const schedule = function () {
    if (queued) return
    queued = true
    requestAnimationFrame(function () {
      queued = false
      sweep()
    })
  }
  try {
    const observer = new MutationObserver(schedule)
    observer.observe(document.body, { childList: true, subtree: true })
  } catch (error) {
    /* no observer: the sweep below still runs once */
  }
  sweep()
  setTimeout(sweep, 1500)
  // React re-renders the header on session switches and would put its own inline
  // styles back; a cheap re-apply keeps the dock layout stable.
  setInterval(sweep, 1500)
}

/** The sidebar rail/expanded toggle, independent of the active locale. */
function findToggle() {
  const column = document.querySelector('[class*="sidebarCol"]')
  return (column && column.querySelector('button[class*="_toggle"]'))
    || document.querySelector('button[class*="_toggle"]')
}

/**
 * Tell the shell which session is on screen, so its handoff button can ask the
 * main DSH window to show the same one.
 *
 * The app keeps the active session in localStorage and both windows share the
 * origin, so reading that key is cheaper and more stable than scraping the DOM.
 */
function followCurrentSession() {
  let last = ''
  const report = function () {
    let sessionId = ''
    try {
      const raw = localStorage.getItem('dsh.sessions.current')
      if (raw) sessionId = String(JSON.parse(raw).sessionId || '')
    } catch (error) {
      sessionId = ''
    }
    if (sessionId === last) return
    last = sessionId
    try { window.parent.postMessage({ type: 'quickdock:session', sessionId: sessionId }, '*') } catch (error) { /* ignore */ }
  }
  report()
  setInterval(report, 1000)
}

/**
 * The reverse of the Dock button: switch this (main) window to a session that
 * the dock asked for.
 *
 * The Host stores the request; polling is the only channel a browser tab offers
 * for this direction, and it is a loopback GET every couple of seconds.
 */
function followHandoff(uiCtx) {
  let last = -1
  bridge('web-url').then(function (body) {
    const origin = body && body.url ? new URL(body.url, location.href).origin : ''
    if (!origin) return
    const tick = function () {
      fetch(origin + '/quickdock/api/handoff', { cache: 'no-store' })
        .then(function (response) { return response.json() })
        .then(function (info) {
          if (!info || typeof info.seq !== 'number') return
          if (last === -1) { last = info.seq; return }
          if (info.seq <= last || !info.sessionId) return
          last = info.seq
          try {
            uiCtx.uiWorkspace.openSession(String(info.sessionId))
          } catch (error) {
            console.warn('[dsh-quickdock] handoff failed:', error)
          }
          // Bring this window forward. Browsers restrict programmatic focus, so
          // it is attempted and retried; the dock also hides itself on handoff,
          // which hands the foreground to this window at the OS level.
          const raise = function () {
            try { window.focus() } catch (error) { /* ignore */ }
          }
          raise()
          setTimeout(raise, 400)
          setTimeout(raise, 1500)
        })
        .catch(function () { /* dock not running: nothing to do */ })
    }
    setInterval(tick, 2000)
    tick()
  }).catch(function () { /* no dock host */ })
}

function apply(ctx) {
  if (insideDockWindow()) {
    // This page is the dock, not the window that opens it: no header button, no
    // download badge - only the layout fixes below.
    applyDockMode()
    try {
      ctx.inject(['uiWorkspace'], function (uiCtx) {
        // The Dock button in the main window bound a session: follow it. The shell
        // forwards the target over postMessage because the frames are cross-origin.
        window.addEventListener('message', function (event) {
          if (event.source !== window.parent) return
          const data = event.data
          if (!data || data.type !== 'quickdock:open-session' || !data.sessionId) return
          try {
            uiCtx.uiWorkspace.openSession(String(data.sessionId))
          } catch (error) {
            console.warn('[dsh-quickdock] open-session failed:', error)
          }
        })
        // Ask the shell for the target once this app can navigate.
        setTimeout(function () {
          try { window.parent.postMessage({ type: 'quickdock:ready' }, '*') } catch (error) { /* ignore */ }
        }, 300)
      })
    } catch (error) {
      console.warn('[dsh-quickdock] uiWorkspace unavailable in the dock window:', error)
    }
    return
  }
  try {
    ctx.slots.inject(HEADER_SLOT, () => ctx.slots.register({
      name: HEADER_SLOT,
      id: PLUGIN_ID + '-send-to-dock',
      registrant: PLUGIN_ID,
      // order is the display order (priority is the slot's own overlap rule).
      order: 1010
    }, SendToDock))
  } catch (error) {
    console.error('[dsh-quickdock] client apply failed (plugin disabled, web boot continues):', error)
  }

  // Sidebar footer: the runtime download must be visible, not a silent wait.
  try {
    ctx.slots.inject(FOOTER_SLOT, () => ctx.slots.register({
      name: FOOTER_SLOT,
      id: PLUGIN_ID + '-download',
      registrant: PLUGIN_ID,
      order: 1010
    }, DownloadBadge))
  } catch (error) {
    console.warn('[dsh-quickdock] footer slot unavailable:', error)
  }

  // Push the browser locale even when the locale service is unavailable.
  applyLocale(detectLocale())

  // The dock can ask this window to show a session (the reverse of the Dock
  // button); it needs the workspace navigation service to act on it.
  try {
    ctx.inject(['uiWorkspace'], followHandoff)
  } catch (error) {
    console.warn('[dsh-quickdock] handoff unavailable:', error)
  }

  // Optional dependencies: the button works without theme/locale services.
  try {
    ctx.inject(['theme'], syncTheme)
  } catch (error) {
    console.warn('[dsh-quickdock] theme service unavailable:', error)
  }
  try {
    ctx.inject(['locale'], syncLocale)
  } catch (error) {
    console.warn('[dsh-quickdock] locale service unavailable:', error)
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
