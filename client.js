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
    'client.downloading': 'QuickDock is downloading its desktop runtime {percent}% ({mb}/{total} MB)'
  },
  zh: {
    'client.sendToDock': '在 QuickDock 中打开此会话',
    'client.label': 'Dock',
    'client.unknownError': '未知错误',
    'client.startTimeout': 'QuickDock 启动超时。请看 {log}',
    'client.preparing': 'QuickDock 正在准备桌面窗口（首次需要下载 Electron，约 1–2 分钟，只需一次）…',
    'client.requestFailed': '请求失败：HTTP {status}',
    'client.dockFailed': 'QuickDock 请求失败：{reason}',
    'client.downloading': 'QuickDock 正在下载桌面运行时 {percent}%（{mb}/{total} MB）'
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
  return el('button', {
    type: 'button',
    id: PLUGIN_ID + '-send',
    title: t('client.sendToDock'),
    'aria-label': t('client.sendToDock'),
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
  el('span', null, t('client.label')))
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

/* ---------------- command bus ---------------- */

/**
 * "Open session in DSH" command bus.
 *
 * The dock is a separate process and cannot drive the SPA; this plugin runs in
 * the SPA. The Host forwards the command over a lightweight SSE stream that
 * only carries occasional events (hence SSE rather than polling). Reconnects
 * after 3s when the stream drops.
 */
function connectCommandBus(onCommand) {
  var source = null
  var retry = null
  var stopped = false

  function schedule() {
    if (stopped || retry) return
    retry = setTimeout(function () {
      retry = null
      open()
    }, 3000)
  }

  function open() {
    if (stopped) return
    bridge('web-url').then(function (body) {
      var token = ''
      try {
        token = new URL(body && body.url, location.href).searchParams.get('t') || ''
      } catch (error) {}
      if (!token) throw new Error('bus token unavailable')
      if (stopped) return
      source = new EventSource('/quickdock/api/bus?t=' + encodeURIComponent(token))
      source.addEventListener('command', function (event) {
        var command = null
        try {
          command = JSON.parse(event.data)
        } catch (error) {}
        if (command && command.type === 'open-session' && command.sessionId) {
          try {
            onCommand(command.sessionId)
          } catch (error) {
            console.error('[dsh-quickdock] open-session failed:', error)
          }
        }
      })
      source.onerror = function () {
        try {
          source.close()
        } catch (error) {}
        source = null
        schedule()
      }
    }).catch(function () {
      schedule()
    })
  }

  open()
  return function stop() {
    stopped = true
    if (retry) clearTimeout(retry)
    if (source) {
      try {
        source.close()
      } catch (error) {}
    }
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

function apply(ctx) {
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
  // Receiver for "open this session in DSH" (absent uiWorkspace = no feature).
  try {
    ctx.inject(['uiWorkspace'], function (uiCtx) {
      var stop = connectCommandBus(function (sessionId) {
        uiCtx.uiWorkspace.openSession(sessionId)
        try {
          window.focus()
        } catch (error) {}
      })
      uiCtx.effect(function () {
        return stop
      }, 'quickdock: command bus')
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
