'use strict';

/**
 * Window geometry.
 *
 * The user drags the window wherever they want; this module only (1) restores
 * the remembered position and (2) keeps the window reachable.
 */

const DEFAULTS = Object.freeze({
  width: 480,
  /** Fixed input window height. */
  inputHeight: 172,
  /** Fixed run window height (content scrolls inside). */
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

/** First-run position: bottom right of the work area with a margin. */
function defaultBounds(workArea, size, margin) {
  const gap = Math.max(0, finite(margin, DEFAULTS.margin));
  return {
    x: Math.round(workArea.x + workArea.width - size.width - gap),
    y: Math.round(workArea.y + workArea.height - size.height - gap),
  };
}

/** Fit a size into the work area. */
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

/** Restore the saved position; the size always comes from the configuration. */
function restoreBounds(saved, screen, options) {
  const opts = normalizeOptions(options);
  const primary = primaryDisplay(screen);
  if (!primary) throw new Error('No display is available');

  const remembered = saved && displayById(screen, saved.displayId);
  const display = remembered || primary;
  const size = { width: opts.width, height: opts.inputHeight };
  const hasPosition = saved && Number.isFinite(saved.x) && Number.isFinite(saved.y);

  if (remembered && hasPosition) {
    const candidate = fitBounds(display.workArea, Object.assign({}, saved, size));
    // A position that had to be clamped is not a remembered position.
    const visible = candidate.x === Math.round(saved.x) && candidate.y === Math.round(saved.y);
    if (visible) return { bounds: candidate, display };
  }

  return {
    bounds: Object.assign(defaultBounds(display.workArea, size, opts.margin), size),
    display,
  };
}

/**
 * Pull the window back into view. Only x/y change: dragging may leave the
 * window partially off-screen, but releasing it must remain reachable.
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

/** Hit test in window-local coordinates (null when no regions were reported). */
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
