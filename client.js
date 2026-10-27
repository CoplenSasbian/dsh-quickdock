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
  const limit = timeoutMs || 6000
  const started = Date.now()
  let lastError = ''
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
          if (st2 && st2.error) return showError(st2.error)
        } catch (e) {}
        return showError(lastError)
      }
      if (st && st.running) return
    } catch (e) {}
  }
  if (lastError) showError(lastError)
}

/**
 * 显示一条错误提示（DOM toast）。
 *
 * 设计原则：**错误必须让用户看见**。宿主失败时不静默降级、不假装成功，
 * 而是在按钮旁边明确提示原因。
 */
let errorToast = null
let errorTimer = null

function showError(message) {
  const text = String(message || '未知错误')
  try {
    if (!errorToast) {
      errorToast = document.createElement('div')
      errorToast.setAttribute('role', 'alert')
      errorToast.setAttribute('data-plugin', PLUGIN_ID)
      Object.assign(errorToast.style, {
        position: 'fixed',
        right: '16px',
        bottom: '16px',
        zIndex: '2147483647',
        maxWidth: '420px',
        padding: '10px 14px',
        borderRadius: '8px',
        border: '1px solid rgba(220, 80, 80, .6)',
        background: 'rgba(48, 16, 16, .96)',
        color: '#ffd7d7',
        font: '12px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif',
        whiteSpace: 'pre-wrap',
        boxShadow: '0 6px 24px rgba(0, 0, 0, .35)',
        pointerEvents: 'none',
      })
      document.body.appendChild(errorToast)
    }
    errorToast.textContent = 'QuickDock: ' + text
    errorToast.style.display = 'block'
    clearTimeout(errorTimer)
    errorTimer = setTimeout(function () {
      if (errorToast) errorToast.style.display = 'none'
    }, 8000)
  } catch (error) {
    // 连 DOM 都不可用时，至少不要静默吞掉
    console.error('[dsh-quickdock] ' + text)
  }
}

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

function apply(ctx) {
  try {
  ctx.slots.inject(HEADER_SLOT, () => ctx.slots.register({
    name: HEADER_SLOT,
    id: PLUGIN_ID + '-send-to-dock',
    registrant: PLUGIN_ID,
    priority: 1010
  }, SendToDock))
  } catch (error) {
    console.error('[dsh-quickdock] client apply failed (plugin disabled, web boot continues):', error)
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
