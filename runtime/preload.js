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
  setDragZones: 'dock:set-drag-zones',
  setAlwaysOnTop: 'dock:set-always-on-top',
  setDisplayEmpty: 'dock:set-display-empty',
  setMenuSpace: 'dock:set-menu-space',
  hide: 'dock:hide',
  getState: 'dock:get-state',
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
  hide() {
    ipcRenderer.send(outbound.hide);
  },
  /** Show or hide the run window (no content = hidden). */
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
