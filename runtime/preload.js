'use strict';

/**
 * Preload bridge for both dock windows.
 *
 * The renderer has contextIsolation and no Node access; this file is the only
 * channel. Every outbound call validates its arguments so a compromised page
 * cannot hand the main process arbitrary shapes.
 */

const { contextBridge, ipcRenderer } = require('electron');

const outbound = Object.freeze({
  setInteractive: 'dock:set-interactive',
  setHitRegions: 'dock:set-hit-regions',
  debug: 'dock:debug',
  reloadDisplay: 'dock:reload-display',
  setDragZones: 'dock:set-drag-zones',
  setAlwaysOnTop: 'dock:set-always-on-top',
  setDisplayEmpty: 'dock:set-display-empty',
  setTodoEmpty: 'dock:set-todo-empty',
  setTodoHeight: 'dock:todo-height',
  setMenuSpace: 'dock:set-menu-space',
  setContentHeight: 'dock:content-height',
  hide: 'dock:hide',
  getState: 'dock:get-state',
  restoreDock: 'dock:restore-from-ball',
  ballDrag: 'dock:ball-drag',
  collapseToBall: 'dock:collapse-to-ball',
  closeWindow: 'dock:close-window',
});

function validRect(rect) {
  return rect && ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(rect[key]))
    && rect.width >= 0 && rect.height >= 0 && rect.width <= 10000 && rect.height <= 10000;
}

function subscribe(channel, callback) {
  if (typeof callback !== 'function') throw new TypeError('callback must be a function');
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api = Object.freeze({
  /** Toggle host-side click-through for the window under the cursor. */
  setInteractive(interactive) {
    if (typeof interactive !== 'boolean') throw new TypeError('interactive must be boolean');
    ipcRenderer.send(outbound.setInteractive, interactive);
  },
  /** Report rectangles that should receive mouse events. */
  /** Ask the docked window to reload (re-reads state and history). */
  reloadDisplay() {
    ipcRenderer.send(outbound.reloadDisplay);
  },

  /** Diagnostic line in dock.log (the page has no console of its own). */
  debug(message) {
    ipcRenderer.send(outbound.debug, String(message));
  },

  setHitRegions(rectangles) {
    if (!Array.isArray(rectangles) || rectangles.length > 1000 || !rectangles.every(validRect)) {
      throw new TypeError('hit regions must be an array of valid rectangles');
    }
    ipcRenderer.send(outbound.setHitRegions, rectangles.map((rect) => ({
      x: rect.x, y: rect.y, width: rect.width, height: rect.height,
    })));
  },
  /**
   * Report drag-zone rectangles (title bars). The main process clears
   * click-through over them so `-webkit-app-region: drag` works.
   */
  setDragZones(rectangles) {
    if (!Array.isArray(rectangles) || rectangles.length > 100 || !rectangles.every(validRect)) {
      throw new TypeError('drag zones must be an array of valid rectangles');
    }
    ipcRenderer.send(outbound.setDragZones, rectangles.map((rect) => ({
      x: rect.x, y: rect.y, width: rect.width, height: rect.height,
    })));
  },
  /** Pin both windows (input + run) to the top. */
  setAlwaysOnTop(flag) {
    if (typeof flag !== 'boolean') return Promise.reject(new TypeError('flag must be boolean'));
    return ipcRenderer.invoke(outbound.setAlwaysOnTop, flag);
  },
  /**
   * Grow the input window upwards by `extra` pixels (bottom edge fixed) so a
   * long menu fits. Returns the height actually granted; 0 releases.
   */
  setMenuSpace(extra) {
    if (typeof extra !== 'number' || !Number.isFinite(extra) || extra < 0) {
      return Promise.reject(new TypeError('extra must be a non-negative number'));
    }
    return ipcRenderer.invoke(outbound.setMenuSpace, extra);
  },
  /**
   * Ask the window to size itself to the content it is about to show. The bottom
   * edge stays put, so a growing composer grows upwards instead of clipping.
   * Returns the height the window actually took.
   */
  setContentHeight(height) {
    if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0) {
      return Promise.reject(new TypeError('height must be a positive number'));
    }
    return ipcRenderer.invoke(outbound.setContentHeight, Math.round(height));
  },
  hide() {
    ipcRenderer.send(outbound.hide);
  },
  /** Bring the dock back from the floating ball. */
  restoreDock() {
    ipcRenderer.send(outbound.restoreDock);
  },
  /**
   * Drag the floating ball. The main process polls the OS cursor, so only the
   * press and the release travel over IPC.
   * @param {'start'|'end'} phase drag phase.
   */
  ballDrag(phase) {
    if (phase !== 'start' && phase !== 'end') return;
    ipcRenderer.send(outbound.ballDrag, { phase });
  },
  /**
   * Collapse the dock into the floating ball.
   * @param {number} [screenX] click position, so the ball appears under the pointer.
   * @param {number} [screenY] click position.
   */
  collapseToBall(screenX, screenY) {
    const point = Number.isFinite(screenX) && Number.isFinite(screenY)
      ? { x: screenX, y: screenY }
      : null;
    ipcRenderer.send(outbound.collapseToBall, point);
  },
  /** Close the window the way the OS close button would. */
  closeWindow() {
    ipcRenderer.send(outbound.closeWindow);
  },
  /** Show or hide the run window (no content = hidden). */
  /** Size the task window to the height the page reports. */
  setTodoHeight(height) {
    if (typeof height !== 'number' || !Number.isFinite(height)) return Promise.resolve(0);
    return ipcRenderer.invoke(outbound.setTodoHeight, height);
  },

  /** Show or hide the task window. */
  setTodoEmpty(empty) {
    if (typeof empty !== 'boolean') return;
    ipcRenderer.send(outbound.setTodoEmpty, empty);
  },

  setDisplayEmpty(empty) {
    if (typeof empty !== 'boolean') return;
    ipcRenderer.send(outbound.setDisplayEmpty, empty);
  },
  getState() {
    return ipcRenderer.invoke(outbound.getState);
  },
  /** Subscribe to window state changes (always-on-top, side of the run window). */
  onStateChanged(callback) { return subscribe('dock:state', callback); },
});

contextBridge.exposeInMainWorld('quickDock', api);
