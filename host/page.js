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
   * @param {{view?: string, systemControls?: boolean, ballIcon?: string, dockMcp?: boolean}} [options]
   *   `view` picks the chrome: `electron` (desktop window), an editor view
   *   (`vscode`, `intellij`, `visualstudio`) or `browser` (trimmed editor bar); the default is
   *   `electron`. `dockMcp` shows
   *   the editor-tools toggle: the embedding client owns that server, so it is
   *   the only one that can ask for the button.
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
    // An IDE dock runs the MCP server the agent calls; the shell only hosts the
    // switch, next to the session controls it already owns. The desktop window
    // has no such client (and no parent to report a click to), so it never shows it.
    const dockMcp = Boolean(options && options.dockMcp) && !electron
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
  /* Contract controls an embedding client may ask for (an IDE dock's editor
     tools): hidden until the client says it owns them. */
  .qd-frame-bar [hidden] { display: none !important; }
  .qd-frame-bar button[data-action="mcp"]:not([data-on="1"]) { opacity: .6; }
  .qd-frame-bar .qd-frame-warn {
    -webkit-app-region: no-drag; display: none; align-items: center; justify-content: center;
    width: 24px; height: 22px; color: #e6b23f;
  }
  .qd-frame-bar .qd-frame-warn[data-on="1"] { display: flex; }
  .qd-frame-bar .qd-frame-warn svg { width: 15px; height: 15px; display: block; }
  /* Room for the OS close button drawn over the bar's right edge. */
  .qd-frame-bar--system { padding-right: 56px; }
  /* Outside the Electron window the bar is page chrome, not a window handle. */
  .qd-frame-bar--editor { -webkit-app-region: no-drag; }
  /* ---- the tool panel ----
     What the dock in this folder has connected: one card per MCP server with the
     tools it publishes and whether DSH has it mounted right now. */
  body { position: relative; }
  .qd-mcp-panel {
    position: absolute; top: 34px; right: 8px; z-index: 30;
    width: min(460px, calc(100vw - 16px)); max-height: min(72vh, 560px);
    display: flex; flex-direction: column; overflow: hidden;
    background: #1b1b1c; color: #e8e8ea;
    border: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.12)); border-radius: 8px;
    box-shadow: 0 12px 32px rgba(0,0,0,.5);
    font: 12px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
    text-align: left;
  }
  .qd-mcp-panel[hidden] { display: none; }
  .qd-mcp-head { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-bottom: 1px solid rgba(255,255,255,.08); }
  .qd-mcp-head h2 { margin: 0; font-size: 12px; font-weight: 600; flex: 1 1 auto; }
  .qd-mcp-close { background: none; border: 0; color: inherit; cursor: pointer; font-size: 15px; line-height: 1; opacity: .65; }
  .qd-mcp-close:hover { opacity: 1; }
  .qd-mcp-ws { padding: 7px 10px 0; color: #9a9aa2; font-family: ui-monospace, Consolas, monospace; font-size: 11px; word-break: break-all; }
  .qd-mcp-body { overflow: auto; padding: 8px 10px 10px; display: flex; flex-direction: column; gap: 10px; }
  .qd-mcp-server { border: 1px solid rgba(255,255,255,.08); border-radius: 6px; padding: 8px; }
  .qd-mcp-server-head { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; }
  .qd-mcp-server-name { font-weight: 600; font-family: ui-monospace, Consolas, monospace; }
  .qd-mcp-badge { padding: 0 6px; border-radius: 999px; font-size: 10px; background: rgba(255,255,255,.1); color: #c9c9cf; }
  .qd-mcp-badge[data-state="mounted"] { background: rgba(64,160,255,.18); color: #8cc4ff; }
  .qd-mcp-url { margin-top: 3px; color: #8a8a92; font-family: ui-monospace, Consolas, monospace; font-size: 11px; word-break: break-all; }
  .qd-mcp-tools { display: flex; flex-wrap: wrap; gap: 4px 6px; margin-top: 6px; }
  .qd-mcp-tool { font-family: ui-monospace, Consolas, monospace; font-size: 11px; padding: 1px 6px; border-radius: 4px; background: rgba(255,255,255,.07); }
  .qd-mcp-empty { color: #9a9aa2; }
  iframe { flex: 1 1 auto; width: 100%; border: 0; display: block; background: #fff; }
</style>
</head>
<body>
  <div class="qd-frame-bar${barClass}">
    <button type="button" data-action="sidebar" title="Toggle sidebar" data-expanded="0"><svg viewBox="0 0 16 16" fill="none" stroke-width="1" aria-hidden="true"><path d="M13.5 1.5H2.5C1.94772 1.5 1.5 1.94772 1.5 2.5V13.5C1.5 14.0523 1.94772 14.5 2.5 14.5H13.5C14.0523 14.5 14.5 14.0523 14.5 13.5V2.5C14.5 1.94772 14.0523 1.5 13.5 1.5Z" stroke="currentColor"></path><path d="M5.5 1.5V14.5" stroke="currentColor"></path></svg></button>
    <button type="button" data-action="new-session" title="New session"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" aria-hidden="true"><path d="M8 3.2v9.6M3.2 8h9.6"></path></svg></button>
    <span class="qd-frame-title">DeepSeek Harness</span>
    <span class="qd-frame-warn" data-warn="workspace" title="" aria-live="polite"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 1.8 15 14H1z"></path><path d="M8 6v3.5"></path><path d="M8 11.8v.2"></path></svg></span>
    <button type="button" data-action="mcp-info" title="Editor tools connected to this dock"${dockMcp ? '' : ' hidden'}><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" aria-hidden="true"><path d="M4.5 4h9M4.5 8h9M4.5 12h9"></path><circle cx="2.2" cy="4" r=".9" fill="currentColor" stroke="none"></circle><circle cx="2.2" cy="8" r=".9" fill="currentColor" stroke="none"></circle><circle cx="2.2" cy="12" r=".9" fill="currentColor" stroke="none"></circle></svg></button>
    <button type="button" data-action="mcp" title="Editor tools"${dockMcp ? '' : ' hidden'}><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5.5 1.5v3"></path><path d="M10.5 1.5v3"></path><path d="M3.5 4.5h9v2.5a4.5 4.5 0 0 1-9 0z"></path><path d="M8 11.5V15"></path></svg></button>
    <button type="button" data-action="handoff" title="Show in DSH" disabled><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.5 2.5H13.5V6.5"></path><path d="M13.5 2.5 7.5 8.5"></path><path d="M11.5 9.5V12a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 12V6A1.5 1.5 0 0 1 4 4.5h2.5"></path></svg></button>
    ${pinButton}${collapseButton}${closeButton}
  </div>
  <div class="qd-mcp-panel" data-panel="mcp" hidden>
    <div class="qd-mcp-head">
      <h2>Editor tools</h2>
      <button type="button" class="qd-mcp-close" aria-label="Close">×</button>
    </div>
    <div class="qd-mcp-ws"></div>
    <div class="qd-mcp-body" aria-live="polite"></div>
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
    /* Folders this dock edits (an IDE may pass several) and whether the client
       owns the editor-tools toggle: both decide what the bar shows. */
    var dockWorkspaces = [];
    var dockMcpRequested = false;
    try {
      var params = new URLSearchParams(location.search);
      dockId = params.get('dock') || sessionStorage.getItem('quickdock.dock') || '';
      if (!dockId) dockId = 'dock-' + Math.random().toString(36).slice(2, 10);
      sessionStorage.setItem('quickdock.dock', dockId);
      dockWorkspaces = params.getAll('workspace').filter(function (path) { return Boolean(path) });
      dockMcpRequested = params.get('mcp') !== null;
      fetch('/quickdock/api/dock-context', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: dockId,
          type: dockView,
          client: { name: navigator.userAgent },
          workspace: dockWorkspaces.length
            ? { path: dockWorkspaces[0], paths: dockWorkspaces }
            : undefined
        })
      }).catch(function () { /* dock-target recreates the context on demand */ });
    } catch (error) { dockId = ''; /* storage denied: legacy binding */ }

    /* The embedding client can be a webview parent (VS Code, JetBrains' frame)
       or the host of a top-level WebView2 document (Visual Studio). Both are
       "embedded" for the editor-tools switch, and both need the messages that
       used to go to window.parent. */
    var hostBridge = (typeof window.chrome !== 'undefined' && window.chrome.webview) ? window.chrome.webview : null;

    function embedded() {
      return window.parent !== window || Boolean(hostBridge);
    }

    function toHost(message) {
      if (hostBridge) {
        try { hostBridge.postMessage(JSON.stringify(message)); } catch (error) { /* ignore */ }
        return;
      }
      if (window.parent !== window) {
        try { window.parent.postMessage(message, '*') } catch (error) { /* ignore */ }
      }
    }

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

    /* ---- editor tools (the MCP server an IDE dock runs) ----
       The client that embedded this page owns that server, so it owns the toggle
       too: the bar reports a click upward and the client posts the state back.
       The desktop window has no parent, so the button never appears there. */
    var mcpButton = document.querySelector('[data-action="mcp"]');
    var workspaceWarn = document.querySelector('[data-warn="workspace"]');
    var mcpOn = false;
    var workspaceInfo = null;

    function refreshWorkspaceWarning() {
      if (!workspaceWarn) return;
      var mismatched = Boolean(mcpOn && workspaceInfo && workspaceInfo.matches === false);
      workspaceWarn.setAttribute('data-on', mismatched ? '1' : '0');
      if (!mismatched) return;
      workspaceWarn.title = 'This session works in ' + workspaceInfo.session
        + ', outside ' + workspaceInfo.dock
        + ' — the editor tools are not mounted here.';
    }

    function applyMcpState(on, detail) {
      mcpOn = Boolean(on);
      if (mcpButton) {
        mcpButton.setAttribute('data-on', mcpOn ? '1' : '0');
        mcpButton.removeAttribute('data-pending');
        mcpButton.title = 'Editor tools for DSH: ' + (mcpOn ? 'on' : 'off')
          + ' — click to ' + (mcpOn ? 'turn off' : 'turn on')
          + (detail ? ' (' + detail + ')' : '');
      }
      refreshWorkspaceWarning();
    }

    if (mcpButton && dockMcpRequested && embedded()) {
      mcpButton.hidden = false;
      mcpButton.addEventListener('click', function () {
        if (mcpButton.hasAttribute('data-pending')) return;
        mcpButton.setAttribute('data-pending', '');
        toHost({ type: 'quickdock:mcp-toggle' });
      });
    }
    if (dockMcpRequested) applyMcpState(new URLSearchParams(location.search).get('mcp') === '1', '');

    /* ---- the tool panel ----
       The Host keeps what each dock published about its MCP server (name, url,
       build, tool names) and the bridge's live mount state; this panel is the one
       place that shows both, so "is the editor connected here, and to what?" has
       an answer that does not need a log file. */
    var mcpInfoButton = document.querySelector('[data-action="mcp-info"]');
    var mcpPanel = document.querySelector('[data-panel="mcp"]');
    var mcpPanelTimer = 0;

    function el(tag, className, text) {
      var node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined && text !== null) node.textContent = String(text);
      return node;
    }

    function renderMcpServers(answer) {
      var body = mcpPanel.querySelector('.qd-mcp-body');
      var where = mcpPanel.querySelector('.qd-mcp-ws');
      body.textContent = '';
      var workspace = answer && answer.workspace ? String(answer.workspace) : '';
      if (where) {
        where.textContent = workspace
          ? 'folder: ' + workspace
          : 'no folder declared by this dock';
      }
      var servers = answer && Array.isArray(answer.servers) ? answer.servers : [];
      if (servers.length === 0) {
        body.appendChild(el('div', 'qd-mcp-empty',
          'No editor published tools for this folder. Turn the plug on in the editor, or enable the editor tools (dshVsdock.mcp).'));
        return;
      }
      for (var index = 0; index < servers.length; index += 1) {
        var server = servers[index] || {};
        var card = el('div', 'qd-mcp-server');
        var head = el('div', 'qd-mcp-server-head');
        head.appendChild(el('span', 'qd-mcp-server-name', server.name || 'mcp'));
        var sessions = server.mounted && typeof server.mounted.sessions === 'number' ? server.mounted.sessions : 0;
        var badge = el('span', 'qd-mcp-badge', sessions > 0
          ? 'mounted in ' + sessions + ' session' + (sessions === 1 ? '' : 's')
          : 'published, nothing mounted');
        badge.setAttribute('data-state', sessions > 0 ? 'mounted' : 'idle');
        head.appendChild(badge);
        if (server.version) head.appendChild(el('span', 'qd-mcp-badge', 'v' + server.version));
        card.appendChild(head);
        if (server.url) card.appendChild(el('div', 'qd-mcp-url', server.url));
        var tools = Array.isArray(server.tools) ? server.tools : [];
        if (tools.length === 0) {
          card.appendChild(el('div', 'qd-mcp-empty', 'the dock did not publish its tool list'));
        } else {
          var list = el('div', 'qd-mcp-tools');
          for (var t = 0; t < tools.length; t += 1) list.appendChild(el('span', 'qd-mcp-tool', tools[t]));
          card.appendChild(list);
        }
        body.appendChild(card);
      }
    }

    function loadMcpServers() {
      var workspace = dockWorkspaces.length > 0 ? dockWorkspaces[0] : '';
      var query = workspace ? '?workspace=' + encodeURIComponent(workspace) : '';
      fetch('/quickdock/api/mcp-servers' + query)
        .then(function (response) { return response.json() })
        .then(function (answer) { if (!mcpPanel.hidden) renderMcpServers(answer) })
        .catch(function () {
          if (mcpPanel.hidden) return;
          var body = mcpPanel.querySelector('.qd-mcp-body');
          body.textContent = '';
          body.appendChild(el('div', 'qd-mcp-empty', 'cannot read the editor tools from this dock'));
        });
    }

    function setMcpPanel(open) {
      if (!mcpPanel) return;
      mcpPanel.hidden = !open;
      if (mcpInfoButton) mcpInfoButton.setAttribute('data-on', open ? '1' : '0');
      if (mcpPanelTimer) { clearInterval(mcpPanelTimer); mcpPanelTimer = 0 }
      if (!open) return;
      loadMcpServers();
      mcpPanelTimer = setInterval(loadMcpServers, 5000);
    }

    if (mcpInfoButton && mcpPanel && dockMcpRequested && embedded()) {
      mcpInfoButton.hidden = false;
      mcpInfoButton.addEventListener('click', function () { setMcpPanel(mcpPanel.hidden) });
      mcpPanel.querySelector('.qd-mcp-close').addEventListener('click', function () { setMcpPanel(false) });
      document.addEventListener('keydown', function (event) {
        if (event.key === 'Escape' && !mcpPanel.hidden) setMcpPanel(false);
      });
    }

    /* The embedding client (an IDE webview, or a WebView2 host of this top-level
       document for Visual Studio) answers with the real state. */
    function forwardToApp(message) {
      if (!frame) return;
      try { frame.contentWindow.postMessage(message, '*'); } catch (error) { /* frame gone */ }
    }
    function onHostState(data) {
      if (!data) return;
      if (data.type === 'quickdock:add-to-chat') {
        forwardToApp(data);
        return;
      }
      if (data.type !== 'quickdock:mcp-state') return;
      applyMcpState(data.on, data.detail);
    }
    // IDE webviews (VS Code) post to this document directly; WebView2 hosts
    // (Visual Studio) go through chrome.webview.
    window.addEventListener('message', function (event) {
      if (event.source === frame.contentWindow) return;
      onHostState(event.data);
    });
    if (hostBridge) {
      hostBridge.addEventListener('message', function (event) {
        try { onHostState(JSON.parse(String(event.data))) } catch (error) { /* not ours */ }
      });
    } else if (window.parent !== window) {
      window.addEventListener('message', function (event) {
        if (event.source !== window.parent) return;
        onHostState(event.data);
      });
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
          // Whether the session on screen works inside the folder this dock
          // edits decides the warning icon next to the title.
          workspaceInfo = info.workspace && typeof info.workspace === 'object' ? info.workspace : null;
          refreshWorkspaceWarning();
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
      if (data.type === 'quickdock:debug-click') {
        // Diagnostic only: a WebView2 app reports the click it found and the
        // host it believes it is embedded in, so the dock log can tell routing
        // failures from delivery failures.
        toHost(data);
        return;
      }
      if (data.type === 'quickdock:open-file') {
        // The app wants a file opened, and in an editor dock the editor owns that
        // window: hand it up to the embedding page, which knows how to open it.
        // The desktop window has no editor to tell.
        if (dockView === 'electron' || !embedded()) return;
        var raw = typeof data.path === 'string' ? data.path : '';
        if (!raw) return;
        var nul = raw.indexOf('\u0000');
        var file = nul >= 0 ? raw.slice(0, nul) : raw;
        var suffix = nul >= 0 ? raw.slice(nul) : '';
        // DSH shows a path relative to the session's working directory, which is
        // not necessarily one of the editor's open folders. Resolve it once,
        // here, from the bound session QuickDock already tracks - every client
        // then receives an absolute path it can open.
        if (
          file &&
          !/^[A-Za-z]:[\\/]/.test(file) &&
          file.charAt(0) !== '/' &&
          workspaceInfo &&
          typeof workspaceInfo.session === 'string' &&
          workspaceInfo.session
        ) {
          // Build the separators from their codes: this code is itself inside a
          // template literal, and a literal backslash would be lost on the way.
          var backslash = String.fromCharCode(92);
          var slash = String.fromCharCode(47);
          var trimEnd = new RegExp('[' + backslash + backslash + slash + ']+$');
          var trimStart = new RegExp('^[' + backslash + backslash + slash + ']+');
          var base = workspaceInfo.session.replace(trimEnd, '');
          var separator = base.indexOf(backslash) >= 0 ? backslash : slash;
          file = base + separator + file.replace(trimStart, '');
        }
        toHost({ type: 'quickdock:open-file', path: file + suffix });
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
