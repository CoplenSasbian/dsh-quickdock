'use strict';

/**
 * The floating "ball" the dock collapses into when minimised.
 *
 * The window has no taskbar entry (skipTaskbar), so a real minimise would make it
 * unreachable; instead the window is hidden and this small always-on-top disc
 * takes its place. The disc is the DeepSeek whale: the outer ring drags the disc,
 * the centre restores the dock.
 */

const { WHALE_PATH, WHALE_VIEWBOX } = require('./whale.cjs');

/** Default disc diameter, in DIP (config: ballSize). */
const BALL_SIZE = 64;
/** Transparent margin around the disc so its edge is never clipped by the window. */
const BALL_PADDING = 4;

/**
 * The ball's document.
 * @returns {string} HTML for a `data:` URL.
 */
function ballHtml(options) {
  const icon = options && options.icon === 'dot' ? 'dot' : 'whale';
  const mark = icon === 'dot'
    ? '<span class="qdb-dot"></span>'
    : '<svg viewBox="' + WHALE_VIEWBOX + '" fill="none" aria-hidden="true"><path d="' + WHALE_PATH + '" fill="currentColor"></path></svg>';
  return `<!doctype html>
<html><head><meta charset="utf-8">
<style>
  html, body { margin: 0; height: 100%; background: transparent; overflow: hidden; }
  body { font: 12px/1 system-ui, -apple-system, "Segoe UI", sans-serif; }
  /* The whole disc is the pointer target: a drag region would swallow the click,
     and a hit button cannot leave a ring on a small disc. Drag and click are told
     apart by pointer travel instead. */
  .qdb-ball {
    position: absolute; inset: ${BALL_PADDING}px; border-radius: 50%;
    background: #1b1b1c; border: 1px solid rgba(255,255,255,.16);
    display: flex; align-items: center; justify-content: center;
    cursor: grab; user-select: none; -webkit-user-select: none;
    color: #e9e9ec;
  }
  .qdb-ball:hover { background: #242428; border-color: rgba(255,255,255,.28); }
  .qdb-ball:active { cursor: grabbing; background: #2b2b30; }
  svg { width: 62%; max-width: 40px; height: auto; display: block; pointer-events: none; }
  .qdb-dot { width: 26%; height: 26%; border-radius: 50%; background: currentColor; pointer-events: none; }
</style></head>
<body>
  <div class="qdb-ball" role="button" tabindex="0" aria-label="Open QuickDock" title="Open QuickDock">
    ${mark}
  </div>
  <script>
    (function () {
      var api = window.quickDock;
      var ball = document.querySelector('.qdb-ball');
      var dragging = false;
      var moved = false;
      var startX = 0;
      var startY = 0;

      function send(phase) {
        if (!api || typeof api.ballDrag !== 'function') return;
        api.ballDrag(phase);
      }

      ball.addEventListener('mousedown', function (event) {
        if (event.button !== 0) return;
        dragging = true;
        moved = false;
        startX = event.screenX;
        startY = event.screenY;
        send('start');
        event.preventDefault();
      });

      window.addEventListener('mouseup', function () {
        if (!dragging) return;
        dragging = false;
        // The main process owns the cursor, so it decides click versus drag.
        send('end');
      });

      // Keyboard access: Enter/Space restores.
      ball.addEventListener('keydown', function (event) {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        if (api && typeof api.restoreDock === 'function') api.restoreDock();
      });
    })();
  </script>
</body></html>`;
}

module.exports = { BALL_SIZE, BALL_PADDING, ballHtml };
