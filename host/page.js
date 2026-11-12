/**
 * The frame shell page.
 *
 * The dock window loads this page, never the DSH Web UI directly: a foreign page
 * cannot provide a draggable title bar, and it cannot be reloaded or driven from
 * outside. The shell owns the chrome (drag, sidebar, pin, window controls) and
 * puts the app in an iframe below it.
 *
 * Everything the shell needs from the app travels over `postMessage`; see the
 * script at the end of the document for the message table.
 */

import { createRequire } from 'node:module'

import { htmlLang } from './locale.js'
import { themeCss } from './theme.js'

const require = createRequire(import.meta.url)
const { WHALE_PATH, WHALE_VIEWBOX } = require('../runtime/whale.cjs')

/** Attribute-safe escaping for a URL that is written into the shell HTML. */
function escapeAttribute(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export class PageRenderer {
  /**
   * @param {{theme: object, locale: object, trace?: Function}} deps
   */
  constructor(deps) {
    this.theme = deps.theme
    this.locale = deps.locale
    this.trace = deps.trace || (() => {})
  }

  /**
   * Render the frame shell for one client.
   * @param {string} src absolute, already-authenticated Web UI URL (or the app proxy's).
   * @param {{view?: string, systemControls?: boolean, ballIcon?: string}} [options]
   *   `view` picks the chrome: `electron` (desktop window), `vscode` or
   *   `browser` (trimmed editor bar); the default is `electron`.
   * @returns {string} complete HTML document.
   */
  renderFrame(src, options) {
    const scheme = this.theme.colorScheme()
    const theme = themeCss(this.theme.current())
    const href = escapeAttribute(src)
    const view = options && options.view ? options.view : 'electron'
    // Only the desktop window owns pin/collapse/close: inside an editor tab
    // those actions belong to the client, and dead buttons are worse than none.
    const electron = view === 'electron'
    // The OS keeps the close button; its minimise is replaced by our own button,
    // because only we can collapse the window into the floating ball.
    const system = electron && Boolean(options && options.systemControls)
    const barClass = (electron ? '' : ' qd-frame-bar--editor') + (system ? ' qd-frame-bar--system' : '')
    const closeButton = electron && !system ? '\n    <button type="button" data-action="close" title="Close">✕</button>' : ''
    // Not a minimise: the icon is the whale the window collapses into.
    // The button shows the same mark as the disc it produces.
    const dot = Boolean(options && options.ballIcon === 'dot')
    const mark = dot
      ? '<span class="qd-dot"></span>'
      : '<svg viewBox="' + WHALE_VIEWBOX + '" fill="none" aria-hidden="true"><path d="' + WHALE_PATH + '" fill="currentColor"></path></svg>'
    const collapseButton = electron
      ? '\n    <button type="button" data-action="collapse" title="Collapse to the floating ball">' + mark + '</button>'
      : ''
    const pinButton = electron
      ? '\n    <button type="button" data-action="pin" title="Pin on top" data-on="0"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17v5"></path><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"></path></svg></button>'
      : ''
    // The shell tells the app which client is looking at it; the app uses it to
    // decide whether desktop-only affordances make sense.
    const host = electron ? 'desktop' : view
    return `<!doctype html>
<html lang="${htmlLang(this.locale.locale)}" data-theme="${scheme}" data-qd-view="${view}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>QuickDock</title>
${theme}
<style>
  :root { color-scheme: ${scheme}; }
  html, body { margin: 0; height: 100%; overflow: hidden; }
  body {
    display: flex; flex-direction: column;
    background: var(--dsw-alias-bg-base, #1b1b1c); color: var(--dsw-alias-label-primary, #e9e9ec);
    font: 12px/1 system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  .qd-frame-bar {
    flex: 0 0 34px; height: 34px; display: flex; align-items: center; gap: 8px;
    padding: 0 8px 0 12px; background: #1b1b1c;
    border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.08));
    -webkit-app-region: drag; user-select: none;
  }
  .qd-frame-title {
    flex: 1 1 auto; min-width: 0; overflow: hidden; white-space: nowrap;
    text-overflow: ellipsis; opacity: .72; letter-spacing: .02em; font-size: 11px;
  }
  .qd-frame-bar button {
    -webkit-app-region: no-drag; width: 28px; height: 22px; display: flex;
    align-items: center; justify-content: center; border: 0; border-radius: 7px;
    background: transparent; color: inherit; opacity: .8; cursor: pointer; font-size: 13px;
  }
  .qd-frame-bar button:hover { background: rgba(255,255,255,.14); opacity: 1; }
  .qd-frame-bar button[disabled] { opacity: .28; pointer-events: none; }
  .qd-frame-bar button[data-on="1"] { background: rgba(88,158,255,.42); color: #fff; opacity: 1; }
  .qd-frame-bar button[data-action="close"]:hover { background: rgba(232,72,72,.8); color: #fff; }
  .qd-frame-bar button[data-action="sidebar"] { width: 26px; }
  .qd-frame-bar button[data-action="sidebar"][data-expanded="1"] { background: rgba(255,255,255,.14); opacity: 1; }
  /* The new-session shortcut only makes sense while the sidebar (which owns the
     real button) is out of the way. */
  .qd-frame-bar button[data-action="sidebar"][data-expanded="1"] ~ button[data-action="new-session"] { display: none; }
  .qd-frame-bar button svg { width: 16px; height: 16px; display: block; }
  .qd-frame-bar .qd-dot { width: 12px; height: 12px; border-radius: 50%; background: currentColor; display: block; }
  /* Room for the OS close button drawn over the bar's right edge. */
  .qd-frame-bar--system { padding-right: 56px; }
  /* Outside the Electron window the bar is page chrome, not a window handle. */
  .qd-frame-bar--editor { -webkit-app-region: no-drag; }
  iframe { flex: 1 1 auto; width: 100%; border: 0; display: block; background: #fff; }
</style>
</head>
<body>
  <div class="qd-frame-bar${barClass}">
    <button type="button" data-action="sidebar" title="Toggle sidebar" data-expanded="0"><svg viewBox="0 0 16 16" fill="none" stroke-width="1" aria-hidden="true"><path d="M13.5 1.5H2.5C1.94772 1.5 1.5 1.94772 1.5 2.5V13.5C1.5 14.0523 1.94772 14.5 2.5 14.5H13.5C14.0523 14.5 14.5 14.0523 14.5 13.5V2.5C14.5 1.94772 14.0523 1.5 13.5 1.5Z" stroke="currentColor"></path><path d="M5.5 1.5V14.5" stroke="currentColor"></path></svg></button>
    <button type="button" data-action="new-session" title="New session"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" aria-hidden="true"><path d="M8 3.2v9.6M3.2 8h9.6"></path></svg></button>
    <span class="qd-frame-title">DeepSeek Harness</span>
    <button type="button" data-action="handoff" title="Show in DSH" disabled><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.5 2.5H13.5V6.5"></path><path d="M13.5 2.5 7.5 8.5"></path><path d="M11.5 9.5V12a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 12V6A1.5 1.5 0 0 1 4 4.5h2.5"></path></svg></button>
    ${pinButton}${collapseButton}${closeButton}
  </div>
  <iframe src="${href}" allow="clipboard-read; clipboard-write" referrerpolicy="no-referrer"></iframe>
  <script>
  (function () {
    var api = window.quickDock;
    var frame = document.querySelector('iframe');
    var origin = null;
    try { origin = frame ? new URL(frame.src).origin : null } catch (error) { origin = null }

    /* ---- dock context ----
       The shell connects as one dock: it registers the context QuickDock keeps
       (identity, type, workspace). The id is stable per tab and, for the desktop
       window, supplied by the Host in the URL. */
    var dockView = ${JSON.stringify(view)};
    var dockId = '';
    try {
      var params = new URLSearchParams(location.search);
      dockId = params.get('dock') || sessionStorage.getItem('quickdock.dock') || '';
      if (!dockId) dockId = 'dock-' + Math.random().toString(36).slice(2, 10);
      sessionStorage.setItem('quickdock.dock', dockId);
      var dockWorkspace = params.get('workspace') || '';
      fetch('/quickdock/api/dock-context', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: dockId,
          type: dockView,
          client: { name: navigator.userAgent },
          workspace: dockWorkspace ? { path: dockWorkspace } : undefined
        })
      }).catch(function () { /* dock-target recreates the context on demand */ });
    } catch (error) { dockId = ''; /* storage denied: legacy binding */ }

    /* ---- shell -> app ---- */
    function tell(message) {
      if (!frame || !origin) return;
      try { frame.contentWindow.postMessage(message, origin) } catch (error) { /* frame gone */ }
    }

    var sidebarButton = document.querySelector('[data-action="sidebar"]');
    if (sidebarButton) {
      sidebarButton.addEventListener('click', function () { tell({ type: 'quickdock:toggle-sidebar' }) });
    }
    var newSessionButton = document.querySelector('[data-action="new-session"]');
    if (newSessionButton) {
      newSessionButton.addEventListener('click', function () { tell({ type: 'quickdock:new-session' }) });
    }
    // The app reports which session it currently shows; the handoff button asks
    // the main DSH window to open the same one.
    var currentSessionId = '';
    var handoffButton = document.querySelector('[data-action="handoff"]');
    if (handoffButton) {
      handoffButton.addEventListener('click', function () {
        if (!currentSessionId) return;
        fetch('/quickdock/api/handoff', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: currentSessionId })
        }).catch(function () { /* the button stays usable for a retry */ });
      });
    }

    var lastTargetSeq = -1;
    var lastReloadSeq = -1;

    function reloadApp() {
      // A cross-origin frame cannot be asked to reload through its location, but
      // assigning its own src is allowed and does exactly that.
      if (!frame) return;
      try { frame.src = frame.src } catch (error) { /* ignore */ }
    }

    function syncTarget() {
      fetch('/quickdock/api/dock-target' + (dockId ? '?dock=' + encodeURIComponent(dockId) : ''), { cache: 'no-store' })
        .then(function (response) { return response.json() })
        .then(function (info) {
          if (!info) return;
          if (typeof info.reloadSeq === 'number' && info.reloadSeq !== lastReloadSeq) {
            var first = lastReloadSeq === -1;
            lastReloadSeq = info.reloadSeq;
            if (!first) reloadApp();
          }
          if (!info.sessionId || info.seq === lastTargetSeq) return;
          lastTargetSeq = info.seq;
          tell({ type: 'quickdock:open-session', sessionId: info.sessionId });
        })
        .catch(function () {});
    }

    /* ---- app -> shell ---- */
    window.addEventListener('message', function (event) {
      if (!frame || event.source !== frame.contentWindow) return;
      var data = event.data;
      if (!data) return;
      if (data.type === 'quickdock:sidebar-state') {
        if (sidebarButton) sidebarButton.setAttribute('data-expanded', data.expanded ? '1' : '0');
        return;
      }
      if (data.type === 'quickdock:title') {
        var titleElement = document.querySelector('.qd-frame-title');
        if (titleElement && typeof data.title === 'string' && data.title) {
          titleElement.textContent = data.title;
          titleElement.title = data.title;
        }
        return;
      }
      if (data.type === 'quickdock:session') {
        currentSessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
        if (handoffButton) {
          if (currentSessionId) handoffButton.removeAttribute('disabled');
          else handoffButton.setAttribute('disabled', 'disabled');
        }
        // The app switched sessions inside this dock: report the binding so the
        // context (and its later tool set) follows what this dock actually shows.
        // The quiet flag keeps the Host from summoning the window on every switch.
        if (dockId && currentSessionId) {
          fetch('/quickdock/api/bind?dock=' + encodeURIComponent(dockId), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: currentSessionId, quiet: true })
          }).catch(function () { /* the next switch retries */ });
        }
        return;
      }
      if (data.type === 'quickdock:ready') {
        // The dock window follows the session the Dock button bound. Re-sending
        // the context here also labels a page that booted before its shell.
        tell({ type: 'quickdock:context', dock: true, host: '${host}', view: '${view}', id: dockId });
        lastTargetSeq = -1;
        syncTarget();
      }
    });

    // The app is cross-origin: postMessage is the whole channel, plus this poll
    // for targets bound while the window is already open.
    if (frame) {
      frame.addEventListener('load', function () {
        tell({ type: 'quickdock:context', dock: true, host: '${host}', view: '${view}', id: dockId });
        lastTargetSeq = -1;
        syncTarget();
      });
    }
    setInterval(syncTarget, 1200);
    setTimeout(syncTarget, 800);

    /* ---- window controls (only present in the Electron window) ---- */
    if (!api) return;
    var pin = document.querySelector('[data-action="pin"]');
    var close = document.querySelector('[data-action="close"]');
    if (pin) pin.addEventListener('click', function () {
      var on = pin.getAttribute('data-on') !== '1';
      pin.setAttribute('data-on', on ? '1' : '0');
      Promise.resolve(api.setAlwaysOnTop(on)).catch(function () {
        pin.setAttribute('data-on', on ? '0' : '1');
      });
    });
    var collapse = document.querySelector('[data-action="collapse"]');
    if (collapse) collapse.addEventListener('click', function (event) {
      // The ball appears where the button was clicked, not at a fixed corner.
      if (typeof api.collapseToBall === 'function') api.collapseToBall(event.screenX, event.screenY);
      else api.hide();
    });
    if (close) close.addEventListener('click', function () {
      if (typeof api.closeWindow === 'function') api.closeWindow();
      else api.hide();
    });
    Promise.resolve(api.getState()).then(function (state) {
      if (state && state.alwaysOnTop && pin) pin.setAttribute('data-on', '1');
    }).catch(function () {});
  })();
  </script>
</body>
</html>`
  }
}
