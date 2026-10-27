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
  // 输入窗口固定为 config.inputHeight（展示窗口是独立窗口，高度用 displayHeight）
  const fresh = restoreBounds({}, screen, { width: 360, inputHeight: 280, displayHeight: 520 });
  assert.deepEqual(fresh.bounds, { x: 1544, y: 744, width: 360, height: 280 });

  // 即便存了旧的高度（560），恢复时也强制用 inputHeight
  const withOld = restoreBounds({ displayId: 1, x: 100, y: 200, width: 360, height: 560 }, screen, { width: 360, inputHeight: 280, displayHeight: 520 });
  assert.deepEqual(withOld.bounds, { x: 100, y: 200, width: 360, height: 280 });
});

test('a dragged position is preserved exactly', () => {
  // 用户把窗口拖到任意位置 —— 原样恢复
  const result = restoreBounds({ displayId: 1, x: 300, y: 220, width: 360, height: 400 }, screen, { width: 360, inputHeight: 280, displayHeight: 520 });
  assert.deepEqual(result.bounds, { x: 300, y: 220, width: 360, height: 280 });
});

test('negative-origin and secondary displays are respected', () => {
  const result = restoreBounds({ displayId: 2, x: 2380, y: -184, width: 360, height: 400 }, screen, { width: 360, inputHeight: 280, displayHeight: 520 });
  assert.deepEqual(result.bounds, { x: 2380, y: -184, width: 360, height: 280 });
});

test('renderer height is clamped and width remains fixed', () => {
  // 高度由 normalizeSize 负责（渲染进程测量 + maxHeight 限制），clampBounds 不碰尺寸
  const tall = clampBounds(primary.workArea, { x: 100, y: 100, width: 360, height: 560 });
  assert.deepEqual(tall, { x: 100, y: 100, width: 360, height: 560 });
  const short = clampBounds(primary.workArea, { x: 100, y: 100, width: 360, height: 280 });
  assert.deepEqual(short, { x: 100, y: 100, width: 360, height: 280 });
});

test('a window dragged off-screen is pulled back into view', () => {
  // 拖到屏幕外 → 夹回可见范围（否则就再也拖不回来了）
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
  // 显示器没了 → 用主显示器的默认位置（右下角，留 margin 16），高度固定为 inputHeight
  assert.deepEqual(restoreBounds({ displayId: 99, x: 2200, y: 100 }, screen, { width: 360, inputHeight: 280 }).bounds, {
    x: 1544, y: 744, width: 360, height: 280,
  });
  // 位置完全在屏幕外 → 同样退回默认位置
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
