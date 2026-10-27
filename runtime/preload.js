'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const outbound = Object.freeze({
  setInteractive: 'dock:set-interactive',
  setHitRegions: 'dock:set-hit-regions',
  setDragZones: 'dock:set-drag-zones',
  setAlwaysOnTop: 'dock:set-always-on-top',
  setDisplayEmpty: 'dock:set-display-empty',
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
  setInteractive(interactive) {
    if (typeof interactive !== 'boolean') throw new TypeError('interactive must be boolean');
    ipcRenderer.send(outbound.setInteractive, interactive);
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
   * 报告拖动区（窗口标题条）的屏幕内矩形。
   * 主进程用光标位置判断何时取消点击穿透，从而让 app-region: drag 生效。
   */
  setDragZones(rectangles) {
    if (!Array.isArray(rectangles) || rectangles.length > 100 || !rectangles.every(validRect)) {
      throw new TypeError('drag zones must be an array of valid rectangles');
    }
    ipcRenderer.send(outbound.setDragZones, rectangles.map((rect) => ({
      x: rect.x, y: rect.y, width: rect.width, height: rect.height,
    })));
  },
  setAlwaysOnTop(flag) {
    if (typeof flag !== 'boolean') return Promise.reject(new TypeError('flag must be boolean'));
    return ipcRenderer.invoke(outbound.setAlwaysOnTop, flag);
  },
  hide() {
    ipcRenderer.send(outbound.hide);
  },
  /**
   * 展示窗口：内容为空时通知宿主隐藏展示窗口。
   * 有内容时显示（并自动贴到输入窗口的上/下边）。
   */
  setDisplayEmpty(empty) {
    if (typeof empty !== 'boolean') return;
    ipcRenderer.send(outbound.setDisplayEmpty, empty);
  },
  getState() {
    return ipcRenderer.invoke(outbound.getState);
  },
  onStateChanged(callback) { return subscribe('dock:state', callback); },
});

contextBridge.exposeInMainWorld('quickDock', api);
