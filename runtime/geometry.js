'use strict';

/**
 * 窗口几何。
 *
 * 窗口位置完全由用户拖拽决定，这里只负责两件事：
 *   1. 记住上次的位置，下次启动恢复
 *   2. 保证窗口不会跑到屏幕外
 */

const DEFAULTS = Object.freeze({
  width: 600,
  /** 输入窗口的固定高度 */
  inputHeight: 170,
  /** 展示窗口的固定高度（内容超出时在窗口内滚动） */
  displayHeight: 520,
  margin: 16,
});

function finite(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function integer(value, fallback, min, max) {
  const number = Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.max(min, Math.min(max, number));
}

function normalizeOptions(options) {
  const value = options || {};
  return {
    width: integer(value.width, DEFAULTS.width, 240, 1200),
    inputHeight: integer(value.inputHeight, DEFAULTS.inputHeight, 120, 800),
    displayHeight: integer(value.displayHeight, DEFAULTS.displayHeight, 200, 1200),
    margin: integer(value.margin, DEFAULTS.margin, 0, 200),
  };
}

/**
 * 首次启动的默认位置：右下角，留出 margin 间距。
 * （只在还没有记住任何位置时用；之后完全跟随用户拖拽。）
 */
function defaultBounds(workArea, size, margin) {
  const gap = Math.max(0, finite(margin, DEFAULTS.margin));
  return {
    x: Math.round(workArea.x + workArea.width - size.width - gap),
    y: Math.round(workArea.y + workArea.height - size.height - gap),
  };
}

function fitBounds(workArea, bounds) {
  const width = Math.min(Math.max(1, Math.round(bounds.width)), workArea.width);
  const height = Math.min(Math.max(1, Math.round(bounds.height)), workArea.height);
  return {
    x: Math.round(Math.max(workArea.x, Math.min(workArea.x + workArea.width - width, bounds.x))),
    y: Math.round(Math.max(workArea.y, Math.min(workArea.y + workArea.height - height, bounds.y))),
    width,
    height,
  };
}

function displays(screen) {
  return typeof screen.getAllDisplays === 'function' ? screen.getAllDisplays() : [];
}

function primaryDisplay(screen) {
  if (typeof screen.getPrimaryDisplay === 'function') return screen.getPrimaryDisplay();
  return displays(screen)[0];
}

function displayById(screen, id) {
  return displays(screen).find((display) => display.id === id) || null;
}

function currentDisplay(screen, point) {
  if (point && typeof screen.getDisplayNearestPoint === 'function') {
    return screen.getDisplayNearestPoint(point);
  }
  return primaryDisplay(screen);
}

/** 恢复窗口位置；尺寸始终用配置里的固定值，不沿用上次记录。 */
function restoreBounds(saved, screen, options) {
  const opts = normalizeOptions(options);
  const primary = primaryDisplay(screen);
  if (!primary) throw new Error('No display is available');

  const remembered = saved && displayById(screen, saved.displayId);
  const display = remembered || primary;
  // 输入窗口：固定尺寸（宽 × inputHeight），用户可拖动
  const size = { width: opts.width, height: opts.inputHeight };
  const hasPosition = saved && Number.isFinite(saved.x) && Number.isFinite(saved.y);

  if (remembered && hasPosition) {
    const candidate = fitBounds(display.workArea, Object.assign({}, saved, size));
    // 完全在屏幕外不算"记住的位置"，用安全兜底。
    const visible = candidate.x === Math.round(saved.x) && candidate.y === Math.round(saved.y);
    if (visible) return { bounds: candidate, display };
  }

  return {
    bounds: Object.assign(defaultBounds(display.workArea, size, opts.margin), size),
    display,
  };
}

/**
 * 把窗口夹回可见范围：只改 x/y，尺寸原样保留。
 * 拖动可以让窗口跑到屏幕外，但松手时必须完整可见，否则再也拖不回来。
 */
function clampBounds(workArea, bounds) {
  const width = Math.max(1, Math.round(bounds.width));
  const height = Math.max(1, Math.round(bounds.height));
  return {
    x: Math.round(Math.max(workArea.x, Math.min(workArea.x + workArea.width - width, bounds.x))),
    y: Math.round(Math.max(workArea.y, Math.min(workArea.y + workArea.height - height, bounds.y))),
    width: bounds.width,
    height: bounds.height,
  };
}

function pointInRects(point, bounds, rects) {
  if (!Array.isArray(rects)) return null;
  const x = point.x - bounds.x;
  const y = point.y - bounds.y;
  if (x < 0 || y < 0 || x >= bounds.width || y >= bounds.height) return false;
  return rects.some((rect) => x >= rect.x && y >= rect.y && x < rect.x + rect.width && y < rect.y + rect.height);
}

module.exports = {
  DEFAULTS,
  clampBounds,
  currentDisplay,
  defaultBounds,
  displayById,
  fitBounds,
  normalizeOptions,
  pointInRects,
  primaryDisplay,
  restoreBounds,
};
