'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { defaultBounds, clampBounds, pointInRects, restoreBounds } = require('../geometry');

const primary = { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
const second = { id: 2, workArea: { x: 1920, y: -200, width: 1280, height: 1024 } };
const screen = {
  getAllDisplays: () => [primary, second],
  getPrimaryDisplay: () => primary,
  getDisplayNearestPoint: (point) => point.x >= 1920 ? second : primary,
};
const size = { width: 360, height: 400 };

test('default position sits at the bottom-right of the work area', () => {
  assert.deepEqual(defaultBounds(primary.workArea, size, 16), { x: 1544, y: 624 });
  assert.deepEqual(defaultBounds(second.workArea, size, 16), { x: 2824, y: 408 });
});

test('window size is fixed: input window uses inputHeight', () => {
  // The input window always uses config.inputHeight (the run window is separate).
  const fresh = restoreBounds({}, screen, { width: 360, inputHeight: 280, displayHeight: 520 });
  assert.deepEqual(fresh.bounds, { x: 1544, y: 744, width: 360, height: 280 });

  // A remembered height (560) is ignored: inputHeight wins.
  const withOld = restoreBounds({ displayId: 1, x: 100, y: 200, width: 360, height: 560 }, screen, { width: 360, inputHeight: 280, displayHeight: 520 });
  assert.deepEqual(withOld.bounds, { x: 100, y: 200, width: 360, height: 280 });
});

test('a dragged position is preserved exactly', () => {
  // A dragged position is restored exactly.
  const result = restoreBounds({ displayId: 1, x: 300, y: 220, width: 360, height: 400 }, screen, { width: 360, inputHeight: 280, displayHeight: 520 });
  assert.deepEqual(result.bounds, { x: 300, y: 220, width: 360, height: 280 });
});

test('negative-origin and secondary displays are respected', () => {
  const result = restoreBounds({ displayId: 2, x: 2380, y: -184, width: 360, height: 400 }, screen, { width: 360, inputHeight: 280, displayHeight: 520 });
  assert.deepEqual(result.bounds, { x: 2380, y: -184, width: 360, height: 280 });
});

test('renderer height is clamped and width remains fixed', () => {
  // clampBounds only moves the window; it never changes the size.
  const tall = clampBounds(primary.workArea, { x: 100, y: 100, width: 360, height: 560 });
  assert.deepEqual(tall, { x: 100, y: 100, width: 360, height: 560 });
  const short = clampBounds(primary.workArea, { x: 100, y: 100, width: 360, height: 280 });
  assert.deepEqual(short, { x: 100, y: 100, width: 360, height: 280 });
});

test('a window dragged off-screen is pulled back into view', () => {
  // Off-screen windows are pulled back into view.
  assert.deepEqual(clampBounds(primary.workArea, { x: -5000, y: -5000, width: 360, height: 400 }), {
    x: 0, y: 0, width: 360, height: 400,
  });
  assert.deepEqual(clampBounds(primary.workArea, { x: 9999, y: 9999, width: 360, height: 400 }), {
    x: 1560, y: 640, width: 360, height: 400,
  });
});

test('remembered display and valid position are restored', () => {
  const result = restoreBounds({ displayId: 2, x: 2200, y: 100, width: 360, height: 400 }, screen, { width: 360, inputHeight: 280, displayHeight: 520 });
  assert.deepEqual(result.bounds, { x: 2200, y: 100, width: 360, height: 280 });
});

test('missing display or off-screen coordinates fall back safely', () => {
  // Missing display: default position on the primary display.
  assert.deepEqual(restoreBounds({ displayId: 99, x: 2200, y: 100 }, screen, { width: 360, inputHeight: 280 }).bounds, {
    x: 1544, y: 744, width: 360, height: 280,
  });
  // Fully off-screen coordinates also fall back to the default position.
  assert.deepEqual(restoreBounds({ displayId: 2, x: -5000, y: 100 }, screen, { width: 360, inputHeight: 280 }).bounds, {
    x: 2824, y: 528, width: 360, height: 280,
  });
});

test('hit regions use window-local coordinates', () => {
  const bounds = { x: 100, y: 200, width: 360, height: 400 };
  const rects = [{ x: 10, y: 10, width: 100, height: 40 }];
  assert.equal(pointInRects({ x: 150, y: 230 }, bounds, rects), true);
  assert.equal(pointInRects({ x: 50, y: 230 }, bounds, rects), false);
  assert.equal(pointInRects({ x: 150, y: 500 }, bounds, rects), false);
});
