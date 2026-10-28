'use strict';

/**
 * QuickDock Electron main-process entry point.
 *
 * WARNING: this file must stay .cjs, never rename it to .js.
 * Electron started as `<exe> <script>` goes through default_app.asar's
 * loadApplicationPackage, which decides the module type from the file EXTENSION
 * alone and ignores the nearest package.json "type". The root package.json is
 * "type": "module" (the plugin is ESM), so a .js file is parsed as ESM ->
 * `require is not defined` -> the dock silently never starts: process alive, no
 * window, no output, very hard to diagnose.
 * Verified: same CJS code, qdapp.js never runs, qdapp.cjs gets a BrowserWindow.
 *
 * Any other entry file added under runtime/ must be .cjs as well.
 */

const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

// Temporary debug aid: no usable console on the Electron side, so log to disk.
const TRACE = path.join(process.env.LOCALAPPDATA || process.env.TEMP || '.', 'dsh-quickdock', 'dock.log');
/** The directory may not exist yet (window state creates it elsewhere) - create it first, or the whole log silently vanishes. */
function trace(msg) {
  try {
    fs.mkdirSync(path.dirname(TRACE), { recursive: true });
    fs.appendFileSync(TRACE, '[' + new Date().toISOString() + '] ' + String(msg) + '\n');
  } catch (_) {}
}
let tracedError = false
process.on('uncaughtException', (e) => { trace('UNCAUGHT ' + (e && e.stack || e)); tracedError = true })
process.on('unhandledRejection', (e) => { trace('UNHANDLED ' + (e && e.stack || e)); tracedError = true })

const { parseConfig, defaultStatePath } = require('./config');
const {
  currentDisplay,
  pointInRects,
  clampBounds,
  restoreBounds,
} = require('./geometry');
const { HostProtocol, writeStatus } = require('./protocol');
const { WindowStore } = require('./window-store');

function eventWebContents(event) {
  return event && (event.sender || (event.senderFrame && event.senderFrame.webContents));
}

/**
 * BrowserWindow options shared by both windows.
 *
 * Key items:
 *  - useContentSize: width/height are interpreted as the CONTENT area. The renderer
 *    viewport equals the content area; if set as outer frame, the measured page size
 *    and the window size disagree and feed back into "the window keeps growing".
 *  - thickFrame:false: drop the Windows standard border, otherwise an opaque 1px
 *    outline is drawn around the window.
 *  - roundedCorners:false: corners are drawn in CSS, so the system does not clip
 *    again and leave hard edges.
 */
function sharedWindowOptions(extra) {
  return Object.assign({
    useContentSize: true,
    show: false,
    transparent: true,
    frame: false,
    thickFrame: false,
    roundedCorners: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: false,
    },
  }, extra || {});
}

/** Post-creation setup shared by both windows. */
function prepareWindow(win, store) {
  win.setMenuBarVisibility(false);
  win.setAlwaysOnTop(store.state.alwaysOnTop, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  if (typeof win.setBackgroundThrottling === 'function') win.setBackgroundThrottling(false);
  else win.webContents.setBackgroundThrottling(false);
  // Zoom locked to 1: any zoom desyncs renderer CSS pixels from the window DIP size.
  try { win.webContents.setZoomFactor(1); } catch (_) {}
  try { win.webContents.setVisualZoomLevelLimits(1, 1); } catch (_) {}
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

class DockRuntime {
  constructor(electron, options) {
    this.electron = electron;
    this.process = options.process || process;
    this.config = options.config;
    this.platform = options.platform || this.process.platform;
    /** Input window (fixed size, draggable by the user). */
    this.win = null;
    /** Display window (sticks above or below the input window, moves independently). */
    this.displayWin = null;
    this.store = null;
    /** Click-through state of the input window. */
    this.interactive = false;
    /** Click-through state of the display window (independent of the input window). */
    this.displayInteractive = false;
    /** Whether the display window sticks above the input window. */
    this.displayAbove = false;
    /** Diagnostics: disable click-through entirely (DSH_QUICKDOCK_NO_CLICK_THROUGH=1). */
    this.noClickThrough = this.process.env.DSH_QUICKDOCK_NO_CLICK_THROUGH === '1';
    this.quitting = false;
    this.timers = new Set();
    this.protocols = [];
    this.showFallback = null;
    this.resizeTimer = null;
    this.moveTimer = null;
    /**
     * Extra height temporarily taken by the dropdown menu.
     * null = collapsed; otherwise { base: original outer bounds, content: original
     * content size, extra: current extra height in px }.
     * The input window is only inputHeight tall, so a model list with dozens of
     * entries needs this to expand.
     */
    this.menuSpace = null;
    this.destroyed = false;
    // On-demand mode: closing the window exits the process (host recreates it on the next click);
    this.exitOnClose = options.exitOnClose !== false;
    // HTTP control channel (loopback): on Windows Electron never receives piped stdin,
    // so the host cannot send show/quit/attach over the stdin protocol. The dock
    // listens on a loopback port instead.
    this.controlServer = null;
    this.controlPort = 0;
  }

  async start() {
    const { app, BrowserWindow, ipcMain, powerMonitor, screen, shell } = this.electron;
    trace('start: platform=' + this.platform + ' url=' + this.config.url);
    if (this.platform === 'win32') {
      // Hardware acceleration stays on by default: turning it off makes the transparent
      // region of a transparent window composite as opaque before the first repaint.
      // If a machine has an unstable GPU, set DSH_QUICKDOCK_DISABLE_GPU=1 for software rendering.
      if (this.process.env.DSH_QUICKDOCK_DISABLE_GPU === '1') app.disableHardwareAcceleration();
      if (this.process.env.DSH_QUICKDOCK_GPU_SANDBOX !== '1') app.commandLine.appendSwitch('disable-gpu-sandbox');
    }
    app.setName('dsh-quickdock');
    trace('requestSingleInstanceLock...');
    if (!app.requestSingleInstanceLock()) {
      trace('SINGLE-INSTANCE-LOCK FAILED: another dock owns it, quitting');
      app.quit();
      return false;
    }
    app.on('second-instance', () => this.show());
    app.on('window-all-closed', () => {});
    app.on('before-quit', () => { this.quitting = true; });

    this.store = WindowStore.load(this.config.statePath || defaultStatePath(app, this.process.env), {
      delay: this.config.saveDelayMs,
    });
    trace('store loaded: ' + this.config.statePath);
    await app.whenReady();
    if (this.destroyed) return false;
    trace('app ready, gpu=' + (this.process.env.DSH_QUICKDOCK_DISABLE_GPU === '1' ? 'disabled' : 'enabled'));

    const restored = restoreBounds(this.store.state, screen, this.config);
    trace('restored bounds: ' + JSON.stringify(restored.bounds)
      + ' scale=' + (restored.display && restored.display.scaleFactor)
      + ' workArea=' + JSON.stringify(restored.display && restored.display.workArea));
    this.win = new BrowserWindow(sharedWindowOptions(Object.assign({ title: 'QuickDock' }, restored.bounds)));
    prepareWindow(this.win, this.store);
    // Record initial geometry once: size is fixed, position changes while dragging and must persist.
    this.remember();
    trace('created: bounds=' + JSON.stringify(this.win.getBounds())
      + ' content=' + JSON.stringify(this.win.getContentBounds())
      + ' contentSize=' + JSON.stringify(this.win.getContentSize()));

    // Display window: separate from the input window, sticks to its top or bottom edge.
    this.displayWin = this.createDisplayWindow(restored.display);
    trace('display window created: bounds=' + JSON.stringify(this.displayWin.getBounds()));
    // Keep the creation-time content size as the reference: moving drifts the client area, use it to correct.
    const initialSize = this.displayWin.getContentSize();
    this.displayWantW = initialSize[0];
    this.displayWantH = initialSize[1];
    trace('display want size = ' + initialSize);
    this.placeDisplayWindow(true);

    /**
     * The two windows must stay **stacked together**.
     *
     * Problem: when another app has focus and the input window is clicked, the input
     * window moves to the front but the display window stays behind (or is covered) -
     * the two panels get separated.
     * moveTop() only changes z-order without stealing focus, so this is safe.
     */
    this.win.on('focus', () => this.raiseDisplay());
    this.displayWin.on('focus', () => {
      if (this.win && !this.win.isDestroyed()) {
        try { this.win.moveTop(); } catch (_) {}
      }
    });

    // Click-through is enabled only after show() and the first painted frame
    // (see ensurePainted): being click-through before showing makes the first frame
    // composite with WS_EX_TRANSPARENT, so the transparent region never renders.

    /**
     * Links in the body: open in the system browser, **never navigate inside the dock**.
     * (renderMarkdown sets target=_blank on <a>, which goes through setWindowOpenHandler.)
     */
    const openExternal = (url) => {
      try {
        if (/^https?:\/\//i.test(url)) shell.openExternal(url);
      } catch (_) {}
    };
    for (const target of [this.win, this.displayWin]) {
      if (!target || target.isDestroyed()) continue;
      target.webContents.setWindowOpenHandler(({ url }) => {
        openExternal(url);
        return { action: 'deny' };
      });
    }

    const wc = this.win.webContents;
    wc.on('will-navigate', (event, url) => {
      if (url !== this.config.url) {
        event.preventDefault();
        this.error(new Error('Blocked non-QuickDock navigation'));
      }
    });
    /**
     * Window close -> really exit the process in on-demand mode.
     *
     * exitOnClose comes from the host via DSH_QUICKDOCK_EXIT_ON_CLOSE (default true):
     *  - true  (on-demand): X / Esc -> window destroyed -> process exits; the host
     *    recreates it on the next click.
     *  - false (resident):  only hide the window; the process stays for instant summoning.
     */
    this.win.on('close', (event) => {
      if (this.quitting) return;
      if (!this.exitOnClose) {
        event.preventDefault();
        this.hide();
        return;
      }
      // No preventDefault: let the window really close, which fires 'closed' -> app.quit().
      this.quitting = true;
    });
    this.win.on('closed', () => {
      this.win = null;
      this.cleanup();
      this.store.close().catch(() => {}).then(() => {
        this.status('closed');
        if (!this.destroyed) {
          this.destroyed = true;
          app.quit();
        }
      });
    });
    // Dragging:
    //  - 'move'  fires continuously while dragging -> keep the display window following live
    //  - 'moved' fires on release -> clamp back on screen + persist, avoiding writes while dragging
    this.win.on('move', () => {
      if (this.moving) return;
      this.moving = true;
      this.placeDisplayWindow(false);
      // Throttle with a microtask: follow at most once per event-loop turn.
      Promise.resolve().then(() => { this.moving = false; });
    });    this.win.on('moved', () => {
      this.clearTimer(this.moveTimer);
      this.moveTimer = this.later(() => {
        this.clampIntoView();
        this.placeDisplayWindow(true);
      }, 150);
    });
    this.win.on('show', () => this.reinforceSkipTaskbar());
    this.win.on('ready-to-show', () => this.show());
    wc.on('did-finish-load', () => {
      this.clearTimer(this.showFallback);
      this.showFallback = this.later(() => this.show(), this.config.showFallbackMs);
    });
    wc.on('render-process-gone', (_event, details) => {
      this.status('error', { reason: 'render-process-gone', details: details && details.reason });
      this.quit(1);
    });

    // Both windows may send these IPC messages (input and display share the same preload).
    const sendAllowed = (event) => {
      const wc = eventWebContents(event);
      if (!wc) return false;
      if (this.win && !this.win.isDestroyed() && wc === this.win.webContents) return true;
      if (this.displayWin && !this.displayWin.isDestroyed() && wc === this.displayWin.webContents) return true;
      return false;
    };
    /** Hit regions are tracked per window (each window decides click-through independently). */
    this.regions = { input: { hit: [], drag: [] }, display: { hit: [], drag: [] } };
    ipcMain.on('dock:set-interactive', (event, value) => {
      if (sendAllowed(event) && typeof value === 'boolean') this.setInteractive(value);
    });
    ipcMain.on('dock:set-hit-regions', (event, value) => {
      if (sendAllowed(event) && this.validHitRegions(value)) {
        const which = this.whichWindow(event);
        this.regions[which].hit = value;
        // Log the display window hit region count: 0 means it stays click-through (unclickable).
        if (which === 'display') trace('display hit regions: ' + value.length);
      }
    });
    ipcMain.on('dock:set-drag-zones', (event, value) => {
      if (sendAllowed(event) && this.validHitRegions(value)) {
        this.regions[this.whichWindow(event)].drag = value;
      }
    });
    ipcMain.on('dock:hide', (event) => { if (sendAllowed(event)) this.hide(); });
    ipcMain.on('dock:set-display-empty', (event, empty) => {
      if (!sendAllowed(event) || typeof empty !== 'boolean') return;
      this.setDisplayVisible(!empty);
    });
    ipcMain.handle('dock:set-menu-space', (event, extra) => {
      if (!sendAllowed(event)) throw new Error('Untrusted IPC sender');
      if (typeof extra !== 'number' || !Number.isFinite(extra) || extra < 0) {
        throw new TypeError('Menu space must be a non-negative number');
      }
      return this.setMenuSpace(extra);
    });
    ipcMain.handle('dock:set-always-on-top', (event, flag) => {
      if (!sendAllowed(event) || typeof flag !== 'boolean') throw new TypeError('Invalid always-on-top request');
      this.applyAlwaysOnTop(flag);
      this.remember({ alwaysOnTop: flag });
      this.sendState();
      return flag;
    });
    ipcMain.handle('dock:get-state', (event) => {
      if (!sendAllowed(event)) throw new Error('Untrusted IPC sender');
      return this.state();
    });

    const displaysChanged = () => {
      // Display topology change (plug/unplug/resolution): clamp the window back into view.
      this.clearTimer(this.resizeTimer);
      this.resizeTimer = this.later(() => this.clampIntoView(), 300);
    };
    for (const name of ['display-metrics-changed', 'display-added', 'display-removed']) screen.on(name, displaysChanged);
    powerMonitor.on('resume', () => this.reinforceSkipTaskbar());
    screen.on('unlock-screen', () => this.reinforceSkipTaskbar());

    for (const stream of [this.process.stdin, this.process.stdout]) {
      if (!stream || typeof stream.on !== 'function' || this.protocols.some((item) => item.stream === stream)) continue;
      this.protocols.push(new HostProtocol(stream, (message) => this.command(message), (error) => this.error(error)));
    }
    if (this.process.stdin && typeof this.process.stdin.resume === 'function') this.process.stdin.resume();
    trace('protocol wired: stdin=' + Boolean(this.process.stdin) + ' stdout=' + Boolean(this.process.stdout));

    // HTTP control channel: piped stdin is unavailable on Windows, so the host uses this.
    await this.startControlServer();
    this.later(() => this.pollHost(), this.config.hostPollMs);
    this.later(() => this.pollHitTest(), this.config.hitPollMs);

    await this.win.loadURL(this.config.url);
    trace('loadURL done: ' + this.config.url);
    if (this.displayWin) {
      await this.displayWin.loadURL(this.config.url + (this.config.url.indexOf('?') >= 0 ? '&' : '?') + 'view=display');
      trace('display loadURL done');
    }
    this.status('ready', { pid: this.process.pid, bounds: this.win.getBounds(), controlPort: this.controlPort });
    trace('status(ready) written to stdout, controlPort=' + this.controlPort);
    this.sendState();
    return true;
  }

  /**
   * Create the display window.
   *
   * Independent of the input window: the input box has a fixed size while displayed
   * content grows naturally; sharing one window would force it to resize with the
   * content. The display window keeps a fixed size (height = config.displayHeight)
   * and scrolls its content.
   */
  createDisplayWindow(display) {
    const { BrowserWindow } = this.electron;
    const area = (display && display.workArea) || { x: 0, y: 0, width: 1920, height: 1040 };
    const width = this.config.width;
    const height = Math.min(this.config.displayHeight || 520, area.height);
    const win = new BrowserWindow(sharedWindowOptions({
      width,
      height,
      x: Math.round(area.x + area.width - width - (this.config.margin || 16)),
      y: Math.round(area.y + area.height - height - (this.config.margin || 16)),
      title: 'QuickDock Display',
    }));
    prepareWindow(win, this.store);
    // Closing the display window must not exit the dock, only hide it.
    win.on('close', (event) => {
      if (this.quitting) return;
      event.preventDefault();
      this.hideDisplay();
    });
    return win;
  }

  /**
   * Content width both windows are created with.
   *
   * Every size correction must use this one reference: enforceDisplaySize used
   * to read the input window's content size while placeDisplayWindow used
   * displayWantW, so a 1px DPI rounding difference made the two disagree and
   * the display window fluttered between the two widths on every state push.
   */
  displayWidth() {
    return this.displayWantW || this.config.width;
  }

  /**
   * Correct the display window content size back to the target value.
   *
   * Why: on Windows with non-100% scaling, moving a window drifts the client size
   * (measured 604->606, 304->312) because DIP and physical pixels are rounded back
   * and forth. setContentSize itself rounds by +/-1, so it must NOT be re-applied
   * while dragging - the two fight each other and the window flashes and grows.
   *
   * Therefore: only move while dragging, then call this once on release.
   */
  enforceDisplaySize() {
    const win = this.displayWin;
    if (!win || win.isDestroyed()) return;
    const wantW = this.displayWidth();
    const wantH = this.displayWantH || this.config.displayHeight || 520;
    const cur = win.getContentSize();
    if (cur[0] === wantW && cur[1] === wantH) return;
    try {
      win.setContentSize(wantW, wantH);
      let after = win.getContentSize();
      // Compensate once for system rounding eating +/-1 (single pass, to avoid oscillation).
      if (after[0] !== wantW || after[1] !== wantH) {
        win.setContentSize(wantW - (after[0] - wantW), wantH - (after[1] - wantH));
        after = win.getContentSize();
      }
      trace('display size: ' + cur + ' -> ' + after + ' (want ' + wantW + ',' + wantH + ')');
    } catch (_) {}
  }

  /**
   * Stick the display window to the top or bottom edge of the input window.
   *
   * Rule: default is BELOW; if there is not enough space below (would leave the
   * screen), flip to ABOVE. If neither fits, pick the side with more space and clamp
   * into the screen.
   */
  placeDisplayWindow(fixSize) {
    if (!this.win || !this.displayWin) return;
    const input = this.win.getBounds();
    // Correct size only when not dragging; during a drag the system owns the size, fix it on release.
    if (fixSize === true) this.enforceDisplaySize();
    const content = this.displayWin.getContentSize();
    const width = this.displayWidth();
    // Position with the reference height, not the measured value: drift would make the position jitter.
    const height = this.displayWantH || content[1] || (this.config.displayHeight || 520);
    const display = currentDisplay(this.electron.screen, { x: input.x + input.width / 2, y: input.y + input.height / 2 });
    const area = display.workArea;
    // Both windows have a 10px transparent inner padding (so the rounded corners float),
    // so when they touch edge to edge the two PANELS are actually 10 + 10 = 20px apart
    // and look far away. Let them overlap slightly to bring the panel-to-panel gap down
    // to PANEL_GAP.
    const EDGE_PAD = 10;     // transparent inner padding of .stack / .display-body in the page
    const PANEL_GAP = 6;     // desired panel gap
    const gap = PANEL_GAP - 2 * EDGE_PAD;   // = -14, i.e. the two windows overlap by 14px

    const below = input.y + input.height + gap;
    const above = input.y - height - gap;
    const spaceBelow = area.y + area.height - below;
    const spaceAbove = above - area.y;

    let y;
    if (spaceBelow >= Math.min(height, 120) || spaceBelow >= spaceAbove) {
      y = below;                       // fits below (or more space below) -> place below
    } else {
      y = above;                       // does not fit -> flip above
    }
    // Clamp into the screen so the display window stays fully visible.
    y = Math.round(Math.max(area.y, Math.min(area.y + area.height - height, y)));
    const x = Math.round(Math.max(area.x, Math.min(area.x + area.width - width, input.x)));

    // Do nothing if position and size did not drift: every SSE state push lands here,
    // unconditional setting would make both windows jitter.
    const wasAbove = this.displayAbove;
    this.displayAbove = y < input.y;
    const current = this.displayWin.getBounds();
    const wantW = width;
    const wantH = this.displayWantH || height;
    const sizeDrift = content[0] !== wantW || content[1] !== wantH;
    if (current.x !== x || current.y !== y || sizeDrift) {
      // **Set position and size at once**: with a bare setPosition, Windows re-rounds
      // the client area at high DPI and the window grows the longer it is dragged
      // (+1..2px per step, measured). This also fixes the size, so no separate
      // correction is needed while dragging.
      this.displayWin.setBounds({ x, y, width: wantW, height: wantH });
      trace('display placed: x=' + x + ' y=' + y + ' above=' + this.displayAbove
        + ' size=' + wantW + 'x' + wantH
        + (sizeDrift ? ' (fixed from ' + content + ')' : ''));
    }
    // Notify the page when above/below flips: content grows from the top when placed
    // below and from the bottom when above (so it always hugs the input window).
    if (wasAbove !== this.displayAbove) this.sendState();
  }

  /**
   * Force both windows to repaint and (re-)arm click-through.
   *
   * Why: on Windows the transparent region of a transparent window is sometimes not
   * applied on the first composite and only repaints once "something happens" (mouse
   * enters, a drag) - the symptom is "the background turns transparent only when the
   * mouse moves over the window".
   *
   * Order matters: WS_EX_TRANSPARENT (click-through) must not be set before the
   * window's first composite. If it is - armed while the window was hidden, or
   * before its first visible frame - Windows paints the transparent region opaque
   * until the next style toggle (exactly the "move the mouse to fix it" symptom).
   * Callers therefore clear the style before showing, and arming happens here only
   * after a frame or two has composited; the second arm re-toggles the style as a
   * self-heal for a stale DWM layer.
   */
  ensurePainted() {
    const invalidate = (win) => {
      if (!win || win.isDestroyed()) return;
      try { win.webContents.invalidate(); } catch (_) {}
    };
    const both = () => {
      for (const win of [this.win, this.displayWin]) invalidate(win);
    };
    both();
    const arm = (bounce) => {
      const apply = (win, interactive) => {
        // A hidden window must stay armless: its first composite must be clean.
        if (!win || win.isDestroyed() || !win.isVisible()) return;
        const ignore = !interactive;
        if (bounce && !this.noClickThrough) {
          // A stale layer only rebuilds on an actual style change, not on setting
          // the same value again: flip it once, then apply the wanted state.
          try { win.setIgnoreMouseEvents(!ignore); } catch (_) {}
        }
        this.applyClickThrough(win, ignore);
      };
      apply(this.win, this.interactive);
      apply(this.displayWin, this.displayInteractive);
    };
    // Give the first visible frame time to composite before toggling the style.
    this.later(() => arm(false), 90);
    this.later(both, 160);
    // Self-heal: force a real style change once the repaint had a chance to land.
    this.later(() => arm(true), 220);
  }

  /**
   * Clear the click-through style before a window becomes visible.
   *
   * Re-showing a window that was armed while visible would otherwise composite its
   * first frame with WS_EX_TRANSPARENT and render the transparent region opaque.
   */
  releaseClickThrough(win) {
    if (this.noClickThrough || !win || win.isDestroyed()) return;
    try { win.setIgnoreMouseEvents(false); } catch (_) {}
  }

  /** Show/hide the display window (hidden when there is no execution content). */
  setDisplayVisible(visible) {
    if (!this.displayWin) return;
    if (visible) {
      this.placeDisplayWindow(true);
      if (!this.displayWin.isVisible()) {
        // First composite must not be click-through: clear, show, then re-arm.
        this.releaseClickThrough(this.displayWin);
        this.displayWin.showInactive();
        this.ensurePainted();
        trace('display shown');
      }
    } else if (this.displayWin.isVisible()) {
      this.displayWin.hide();
      trace('display hidden');
    }
  }

  hideDisplay() {
    if (this.displayWin && this.displayWin.isVisible()) this.displayWin.hide();
  }

  /**
   * Dropdown menu space: grow the input window **upward** by extra pixels (bottom edge
   * fixed); pass 0 to collapse.
   *
   * Why: the input window is a short fixed window (172px by default) while the model
   * catalog can have dozens of entries. The menu is drawn inside the page, so without
   * growing the window it is clipped to two or three rows - the classic "dropdown
   * shows only half the list". Only the height changes, and the position is derived
   * from the fixed bottom edge, so:
   *   - at the screen bottom edge the extra space grows upward and the menu fits
   *   - dragging while expanded does not misplace it (collapse uses the current bottom edge)
   *
   * Returns the pixels actually added (truncated when there is not enough room above, may be 0).
   */
  setMenuSpace(extra) {
    const win = this.win;
    if (!win || win.isDestroyed()) return 0;
    const wanted = Number.isFinite(extra) ? Math.max(0, Math.round(extra)) : 0;
    if (!this.menuSpace) {
      if (wanted === 0) return 0;
      this.menuSpace = { base: win.getBounds(), content: win.getContentSize(), extra: 0 };
    }
    const base = this.menuSpace.base;
    if (wanted === 0) {
      const cur = win.getBounds();
      this.menuSpace = null;
      win.setBounds({
        x: cur.x,
        y: cur.y + cur.height - base.height,
        width: base.width,
        height: base.height,
      });
      this.placeDisplayWindow(true);
      trace('menu space released: ' + JSON.stringify(win.getBounds()));
      return 0;
    }
    // Can only grow upward: the usable height is between the window top and the screen top.
    const area = currentDisplay(this.electron.screen, base).workArea;
    const room = Math.max(0, base.y - area.y - 8);
    const grant = Math.min(wanted, room, 460);
    if (grant === this.menuSpace.extra) return grant;
    if (grant === 0) {
      // No room at all (window already at the screen top): treat as not expanded.
      this.menuSpace = null;
      return 0;
    }
    this.menuSpace.extra = grant;
    win.setBounds({
      x: base.x,
      y: base.y + base.height - (base.height + grant),
      width: base.width,
      height: base.height + grant,
    });
    // The display window sticks above the input window, so it must move up when the input grows.
    this.placeDisplayWindow(true);
    trace('menu space: +' + grant + 'px -> ' + JSON.stringify(win.getBounds()));
    return grant;
  }

  /**
   * Start the loopback HTTP control channel.
   *
   * Why: on Windows the Electron main process never receives piped stdin (noted in
   * DESIGN section 3.3), so the host cannot send show/quit/attach over stdin - a quit
   * command is simply never received. The dock listens on a random 127.0.0.1 port and
   * the host calls it over HTTP.
   *
   * Security: loopback bind only; every request must carry a one-time token (passed by
   * the host through env at launch).
   */
  async startControlServer() {
    const token = this.process.env.DSH_QUICKDOCK_CONTROL_TOKEN;
    if (!token) { trace('control server skipped: no token'); return }
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (url.pathname !== '/control' || url.searchParams.get('t') !== token) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        return res.end('{"ok":false}');
      }
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 64 * 1024) req.destroy();
      });
      req.on('end', () => {
        let message = {};
        try { message = body ? JSON.parse(body) : {} } catch (e) {}
        try {
          this.command(message);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"ok":true}');
        } catch (error) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end('{"ok":false}');
        }
      });
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        this.controlPort = server.address().port;
        resolve();
      });
    });
    this.controlServer = server;
    trace('control server listening on 127.0.0.1:' + this.controlPort);
  }

  validHitRegions(value) {
    return Array.isArray(value) && value.length <= 1000 && value.every((rect) => rect
      && ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(rect[key]))
      && rect.width >= 0 && rect.height >= 0 && rect.width <= 10000 && rect.height <= 10000);
  }

  /**
   * Always-on-top: **pin both windows together**.
   *
   * The input window and the execution window look like one panel; pinning only the
   * input window leaves the list covered by other apps - "input pinned, list not".
   */
  applyAlwaysOnTop(flag) {
    const value = Boolean(flag);
    for (const win of [this.win, this.displayWin]) {
      if (!win || win.isDestroyed()) continue;
      try { win.setAlwaysOnTop(value, 'screen-saver'); } catch (_) {}
    }
    if (this.store) this.store.state.alwaysOnTop = value;
  }

  state() {
    return {
      alwaysOnTop: this.store ? this.store.state.alwaysOnTop : false,
      displayAbove: Boolean(this.displayAbove),
    };
  }

  /** Broadcast to both windows (input + display). */
  send(channel, value) {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send(channel, value);
    if (this.displayWin && !this.displayWin.isDestroyed()) this.displayWin.webContents.send(channel, value);
  }

  sendState() { this.send('dock:state', this.state()); }

  status(type, details) {
    writeStatus(this.process.stdout, type, details);
  }

  error(error) {
    this.status('error', { message: error && error.message ? error.message : String(error) });
  }

  setInteractive(value) {
    this.interactive = value;
    this.applyClickThrough(this.win, !value);
  }

  /**
   * Clamp the window back into view after a drag.
   *
   * The user may drag it off screen but must be able to drag it back - so on release
   * pull the whole window into the workArea.
   */
  clampIntoView() {
    if (!this.win) return;
    const outer = this.win.getBounds();
    const display = currentDisplay(this.electron.screen, outer);
    const content = this.win.getContentSize();
    // Clamp using the real outer bounds (content + invisible frame) so the whole window stays visible.
    const clamped = clampBounds(display.workArea, {
      x: outer.x, y: outer.y, width: outer.width, height: outer.height,
    });
    if (clamped.x !== outer.x || clamped.y !== outer.y) {
      this.win.setPosition(clamped.x, clamped.y);
    }
    void content;
    this.remember();
  }

  remember(patch) {
    if (!this.store || !this.win || !this.config.rememberGeometry) return;
    const outer = this.win.getBounds();
    // While the menu is open the window is "temporarily taller": persist the original
    // height, otherwise the next launch shows a 400px empty panel. Position is derived
    // from the bottom edge, so a dragged position is preserved too.
    const base = this.menuSpace ? this.menuSpace.base : outer;
    const content = this.menuSpace ? this.menuSpace.content : this.win.getContentSize();
    const display = currentDisplay(this.electron.screen, outer);
    this.store.update(Object.assign({
      x: outer.x,
      y: outer.y + outer.height - base.height,
      // Store content-area size: with useContentSize this restores the same viewport size on the next create.
      width: content[0],
      height: content[1],
      displayId: display.id,
    }, patch || {}));
  }

  reinforceSkipTaskbar() {
    if (!this.win) return;
    this.win.setSkipTaskbar(true);
    this.later(() => { if (this.win) this.win.setSkipTaskbar(true); }, 0);
  }

  /** Raise the display window to the input window's layer (no focus steal, no relative move). */
  raiseDisplay() {
    if (!this.displayWin || this.displayWin.isDestroyed() || !this.displayWin.isVisible()) return;
    try { this.displayWin.moveTop(); } catch (_) {}
  }

  show() {
    if (!this.win || this.destroyed) return;
    this.clearTimer(this.showFallback);
    this.reinforceSkipTaskbar();
    // Same rule as the display window: never show while click-through is armed
    // (only when it is actually being shown; a re-summon keeps its state).
    if (!this.win.isVisible()) this.releaseClickThrough(this.win);
    if (this.config.focusOnSummon) this.win.show();
    else this.win.showInactive();
    this.placeDisplayWindow(true);
    // show() brings the input window to the front; the display window must follow or the panels separate.
    this.raiseDisplay();
    // Repaint right after showing, otherwise the transparent region only clears when the mouse enters.
    this.ensurePainted();
    this.status('shown');
    this.sendState();
  }

  hide() {
    if (!this.win || this.destroyed) return;
    // Closing while the menu is open: collapse the temporary height first so it is not persisted.
    if (this.menuSpace) this.setMenuSpace(0);
    this.remember();
    this.hideDisplay();
    // On-demand mode: hiding equals exiting, otherwise the process lingers (the user expects click-and-go).
    if (this.exitOnClose) {
      this.quitting = true;
      this.win.close();
      return;
    }
    this.win.hide();
    this.status('hidden');
  }

  command(message) {
    trace('command: ' + JSON.stringify(message));
    if (message.type === 'quit') this.quit(0);
    else if (message.type === 'show') this.show();
    else if (message.type === 'ping') this.status('pong');
    else if (message.type === 'attach') this.show();
    else if (message.type === 'window') {
      if (message.alwaysOnTop !== undefined) this.applyAlwaysOnTop(message.alwaysOnTop);
      this.show();
      this.sendState();
    }
  }

  isHostAlive() {
    try {
      this.process.kill(this.config.hostPid, 0);
      return true;
    } catch (error) {
      return error.code !== 'ESRCH';
    }
  }

  pollHost() {
    if (this.destroyed) return;
    if (!this.isHostAlive()) {
      this.status('closed', { reason: 'host-exited' });
      this.quit(0);
      return;
    }
    this.later(() => this.pollHost(), this.config.hostPollMs);
  }

  /** Determine which window an IPC message came from. */
  whichWindow(event) {
    const wc = eventWebContents(event);
    if (this.displayWin && !this.displayWin.isDestroyed() && wc === this.displayWin.webContents) return 'display';
    return 'input';
  }

  /**
   * Hit testing: for both windows, check whether the cursor is inside an interactive
   * or drag region; if so, disable click-through for that window.
   */
  pollHitTest() {
    if (this.destroyed) return;
    const point = (() => {
      try { return this.electron.screen.getCursorScreenPoint(); } catch (_) { return null; }
    })();
    if (point) {
      this.updateWindowHit(this.win, this.regions.input, point);
      this.updateWindowHit(this.displayWin, this.regions.display, point);
    }
    this.later(() => this.pollHitTest(), this.config.hitPollMs);
  }

  /**
   * Toggle click-through and force a repaint.
   *
   * On Windows every WS_EX_TRANSPARENT toggle recomposites the window, and the
   * transparent region may fall back to opaque until the next repaint. So invalidate
   * right after toggling - this is why "the window turns back into a colour block
   * after the mouse leaves".
   */
  applyClickThrough(win, ignore) {
    if (!win || win.isDestroyed()) return;
    // Diagnostic switch: disable click-through entirely (window stays interactive).
    // If transparency still misbehaves, DSH_QUICKDOCK_NO_CLICK_THROUGH=1 rules it out.
    if (this.noClickThrough) return;
    try { win.setIgnoreMouseEvents(ignore, { forward: true }); } catch (_) { return; }
    try { win.webContents.invalidate(); } catch (_) {}
  }

  updateWindowHit(win, regions, point) {
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    if (!regions) return;
    const hasHit = Array.isArray(regions.hit) && regions.hit.length > 0;
    const hasDrag = Array.isArray(regions.drag) && regions.drag.length > 0;
    if (!hasHit && !hasDrag) return;
    try {
      const bounds = win.getBounds();
      const hit = hasHit ? pointInRects(point, bounds, regions.hit) : false;
      // Drag regions are checked separately: with the cursor on the drag bar,
      // click-through must be off, otherwise -webkit-app-region: drag receives no real
      // mouse events and the window cannot be dragged.
      const overDrag = hasDrag ? pointInRects(point, bounds, regions.drag) === true : false;
      const want = Boolean(hit) || overDrag;
      const key = win === this.displayWin ? 'displayInteractive' : 'interactive';
      if (want !== this[key]) {
        this[key] = want;
        this.applyClickThrough(win, !want);
      }
    } catch (_) {
      // Cursor/display queries can fail during a display topology transition.
    }
  }

  later(callback, delay) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.destroyed) callback();
    }, delay);
    if (timer.unref) timer.unref();
    this.timers.add(timer);
    return timer;
  }

  clearTimer(timer) {
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(timer);
    }
  }

  cleanup() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const protocol of this.protocols) protocol.dispose();
    this.protocols = [];
    if (this.controlServer) {
      try { this.controlServer.close() } catch (_) {}
      this.controlServer = null;
    }
    if (this.displayWin && !this.displayWin.isDestroyed()) {
      try { this.displayWin.destroy(); } catch (_) {}
      this.displayWin = null;
    }
  }

  async quit(code) {
    if (this.destroyed) return;
    this.destroyed = true;
    this.quitting = true;
    this.cleanup();
    if (this.store) await this.store.close().catch(() => {});
    if (code !== undefined) this.process.exitCode = code;
    this.electron.app.quit();
  }
}

async function startRuntime(electron, options) {
  const opts = options || {};
  const proc = opts.process || process;
  try {
    const config = opts.config || parseConfig(proc.argv.slice(1), proc.env);
    trace('config parsed ok: url=' + config.url + ' hostPid=' + config.hostPid);
    const runtime = new DockRuntime(electron, Object.assign({}, opts, { process: proc, config }));
    await runtime.start();
    return runtime;
  } catch (error) {
    trace('START-THREW ' + (error && error.stack || error));
    throw error;
  }
}

module.exports = { DockRuntime, startRuntime };

/**
 * WARNING: do NOT guard auto-start with `if (require.main === module)`.
 *
 * Electron started as `<exe> <script>` require()s the entry file through
 * default_app.asar, so require.main points at electron itself
 * (`require.main.filename === 'electron'`) and never equals module -> the auto-start
 * block never runs -> the dock silently never starts (verified).
 *
 * So run unconditionally here; being require()d as a library (tests only) has no side
 * effects: in that case `require('electron')` itself throws MODULE_NOT_FOUND, so the
 * try below is required - without it a library require would blow up the caller (the
 * old code only caught startRuntime rejections and could not stop this sync throw).
 */
try {
  startRuntime(require('electron')).catch((error) => {
    trace('AUTOSTART-FAILED ' + (error && error.stack || error));
  });
} catch (error) {
  trace('AUTOSTART-FAILED ' + (error && error.stack || error));
}
