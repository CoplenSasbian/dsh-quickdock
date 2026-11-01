/* Run window (display) view.
 *
 * Renders the folded step list of the bound session into #blocks:
 * thinking rows, prose rows, tool rows with lazily loaded detail, approval and
 * question cards, and one live-stream row. It never owns the state: app.js
 * passes the latest snapshot in on every SSE tick.
 *
 * Rows are reconciled by id instead of rebuilt, so a status change updates the
 * node in place: expanded detail animates shut instead of the whole list
 * flashing. The detail body is a 0fr -> 1fr grid row, which animates to its
 * natural height without being measured in JS.
 */
(function () {
  'use strict';

  var U = window.QD.util;
  var t = window.QD.i18n.t;

  /** Any renderable live stream content? */
  function hasLiveText(stream) {
    if (!stream) return false;
    return Boolean(stream.text || stream.thinking || (stream.tools && stream.tools.length));
  }

  /**
   * Create the display view.
   * @param {{root: HTMLElement, api: Function, getState: Function,
   *          isListHidden: Function, scheduleHitReport?: Function,
   *          toastError?: Function, onAnswered?: Function}} options
   * @returns {{render: Function, bindAutoScroll: Function, initialScroll: Function,
   *            scrollHost: Function, applyVisibility: Function}}
   */
  /**
   * Detail mode chosen in the input window (the details button). Both pages share
   * the origin, so the docked window reads the same storage key.
   * @returns {'auto'|'open'|'closed'|'hidden'} current mode.
   */
  function readDetailMode() {
    try {
      var saved = localStorage.getItem('qd-detail-mode');
      return saved === 'open' || saved === 'closed' || saved === 'hidden' ? saved : 'auto';
    } catch (error) {
      return 'auto';
    }
  }

  function create(options) {
    var latestState = null;
    /** Turns shown in the column, oldest first: { number, turn, steps }. */
    /** How many older turns arrive on their own: none - the reader asks. */
    var FIRST_BATCH = 0;
    /** How many each click of the button adds. */
    var MORE_BATCH = 5;

    /** Bounded retry: the host may still be seeding when the page asks. */
    var retriedEmpty = false;

    /** The first painted column drops to its newest turn once. */
    var didInitialScroll = false;

    /** True while older turns are being inserted above the viewport. */
    var anchorAbove = false;

    /** Set once the column had content; the window then stays up. */
    var seenContent = false;
    var turnList = [];
    /** Turns the session has on disk, taken once from /turns. */
    var outline = [];
    var loadingHistory = false;
    var loadedFor = 0;
    var loadedSession = null;
    var outlineRequested = false;
    var host = options.root;
    var api = options.api;
    var getState = options.getState;
    var isListHidden = options.isListHidden || function () { return false; };
    var scheduleHitReport = options.scheduleHitReport || function () {};

    var cardNode = null;
    var cardKey = '';
    var needsRebuild = false;
    /** Follow the newest row. Only a real user gesture may turn this off. */
    var autoScroll = true;
    /** A wheel / touch / key / scrollbar gesture that can move the list is live. */
    var gestureActive = false;
    var gestureTimer = null;
    /** Idle time after which a gesture is considered settled (ms). */
    var GESTURE_IDLE_MS = 240;
    /** Keys that can scroll the focused list. */
    var SCROLL_KEYS = {
      ArrowUp: true, ArrowDown: true, PageUp: true, PageDown: true,
      Home: true, End: true, ' ': true, Spacebar: true
    };

    function scrollHost() {
      return document.getElementById('blocks');
    }

    /** Let the Host decide whether the run window should show at all. */
    function applyVisibility(hasContent, force) {
      var quickDock = window.quickDock;
      if (!quickDock || !quickDock.setDisplayEmpty) return;
      try {
        if (hasContent) seenContent = true;
      // Same rule as the input window: a fresh turn must not blink the window
      // away while its first row is still being written.
      quickDock.setDisplayEmpty(force ? false : (isListHidden() || (!hasContent && !seenContent)));
      } catch (error) {
        /* IPC is optional outside Electron */
      }
    }

    /**
     * Keep the newest content in view while a row grows. Layout changes do not
     * fire scroll events, so the animation is followed for its duration.
     */
    function followGrowth(ms) {
      var scroller = scrollHost();
      if (!scroller || !autoScroll) return;
      var until = Date.now() + (ms || 280);
      function step() {
        if (!autoScroll) return;
        scroller.scrollTop = scroller.scrollHeight;
        if (Date.now() < until) window.requestAnimationFrame(step);
      }
      window.requestAnimationFrame(step);
    }

    /* ----------------------------- render island ----------------------------- */

    /**
     * Rows are drawn by the React island in web/render (DSH web UI primitives),
     * so the run window shares the main window's typography, spacing and cards
     * instead of re-implementing them here. This view keeps the parts that are
     * not rows: the live stream block, the question card and scrolling.
     *
     * @type {{render: Function, unmount: Function}|null}
     */
    var island = null

    /** The island's container: first child of the list, before card and live row. */
    function rowsHost() {
      var existing = host.querySelector('.qd-rows')
      if (existing) return existing
      var rows = U.el('div', 'qd-rows')
      host.insertBefore(rows, host.firstChild)
      return rows
    }

    // The mode lives in localStorage; another window changing it must fold the
    // rows here without waiting for a state push.
    window.addEventListener('storage', function (event) {
      if (event.key !== 'qd-detail-mode') return;
      if (latestState) renderRows(latestState);
    });

    // Growth does not fire a scroll event, so following the bottom needs the
    // layout itself as the trigger: rows arriving one by one (a long turn, a
    // streamed chain) must keep the newest one in view.
    if (window.ResizeObserver) {
      try {
        var growObserver = new window.ResizeObserver(function () {
          var scroller = scrollHost();
          if (scroller && autoScroll) scroller.scrollTop = scroller.scrollHeight;
        });
        growObserver.observe(host);
        var listEl = document.getElementById('blocks');
        if (listEl) growObserver.observe(listEl);
      } catch (error) {
        /* the observer is an enhancement, not a requirement */
      }
    }

    /** Create the island once and hand it the newest state. */
    /**
     * Keep the column in step with the newest turn and pull older ones once, so
     * the window shows the conversation instead of only the turn being written.
     * @param {object} state snapshot.
     */
    function absorbHistory(state) {
      var meta = state && state.turn;
      var sessionId = (state && state.sessionId) || null;
      if (!sessionId) return;
      // A different session starts a new column.
      if (sessionId !== loadedSession) {
        report('column reset for session ' + sessionId + ' (was ' + loadedSession + ')')
        loadedSession = sessionId;
        turnList = [];
        outline = [];
        outlineRequested = false;
        loadedFor = 0;
        // A switch behaves like a first open: no history, follow the newest
        // turn, and drop to the bottom once the new column is painted.
        didInitialScroll = false;
        autoScroll = true;
        // The window is up from the moment a session is bound: an old session
        // binds with no live rows, and the column has to be on screen for its
        // "load earlier turns" pill to be reachable.
        seenContent = true;
      }
      if (!meta || typeof meta.number !== 'number') {
        // No turn yet (fresh bind): read the outline anyway so history can show.
        if (!outlineRequested) {
          outlineRequested = true;
          void loadOlderTurns(Infinity);
        }
        return;
      }
      var entry = { number: meta.number, turn: meta, steps: (state && state.steps) || [] };
      var found = false;
      for (var index = 0; index < turnList.length; index += 1) {
        if (turnList[index].number !== meta.number) continue;
        turnList[index] = entry;
        found = true;
        break;
      }
      if (!found) {
        turnList.push(entry);
        turnList.sort(function (a, b) { return a.number - b.number; });
      }
      if (loadedFor !== meta.number) {
        loadedFor = meta.number;
        outlineRequested = true;
        void loadOlderTurns(meta.number);
      }
    }

    /**
     * Read the session's outline once and pull a first batch of older turns.
     * The rest waits for the "load more" button: a long session should not cost
     * a burst of requests before the window even shows.
     * @param {number} latest newest turn number.
     */
    function loadOlderTurns(latest) {
      if (loadingHistory) return;
      loadingHistory = true;
      api('turns').then(function (list) {
        outline = ((list && list.turns) || []).filter(function (row) {
          return typeof row.turn === 'number' && row.turn < latest;
        });
        loadingHistory = false;
        // Nothing live (a session attached after its turn ended): show its newest
        // turn so the window is not empty, but stop there and let the reader ask
        // for the rest.
        loadMoreTurns(Math.max(FIRST_BATCH, turnList.length ? 0 : 1));
      }).catch(function () { loadingHistory = false; });
    }

    /** Older turns not in the column yet, newest first. */
    function pendingTurns() {
      var known = {};
      turnList.forEach(function (row) { known[row.number] = true; });
      return outline.filter(function (row) { return !known[row.turn]; }).reverse();
    }

    /**
     * Append the next batch of older turns.
     * @param {number} count how many to fetch.
     */
    function loadMoreTurns(count) {
      if (loadingHistory) return;
      var batch = pendingTurns().slice(0, count);
      if (!batch.length) {
        if (latestState) render(latestState);
        else render();
        return;
      }
      loadingHistory = true;
      report('load more: batch=' + batch.length + ' have=' + turnList.length + ' pending=' + pendingTurns().length)
      var next = function (index) {
        if (index >= batch.length) {
          loadingHistory = false;
          // An empty read right after a bind is usually a race with the host's
          // history fold; retry once before showing "nothing has run".
          if (!turnList.length && outline.length && !retriedEmpty) {
            retriedEmpty = true;
            report('history empty after a read, retrying once');
            setTimeout(function () { loadMoreTurns(count); }, 700);
            return;
          }
          // Everything fetched lands above the current view: keep the reader where
          // they were instead of jumping to the top.
          anchorAbove = true;
          if (latestState) render(latestState);
          else render();
          return;
        }
        var row = batch[index];
        var meta = { number: row.turn, startedAt: row.startedAt, endedAt: row.endedAt };
        api('turn?turn=' + row.turn).then(function (detail) {
          report('turn ' + row.turn + ': observed=' + Boolean(detail && detail.observed)
            + ' steps=' + ((detail && detail.steps && detail.steps.length) || 0))
          if (detail && detail.observed && detail.steps && detail.steps.length) {
            turnList.push({ number: row.turn, turn: meta, steps: detail.steps });
            turnList.sort(function (a, b) { return a.number - b.number; });
          }
        }).catch(function (error) {
          report('turn ' + row.turn + ' failed: ' + String((error && error.message) || error))
        }).then(function () { next(index + 1); });
      };
      next(0);
    }

    function renderRows(state) {
      latestState = state;
      // A new conversation has no session yet: never fall back to a stale turn.
      var blank = Boolean(state && (state.newSession || !state.sessionId));
      var rows = rowsHost()
      if (!island) {
        island = window.QD.render.create({
          root: rows,
          t: t,
          loadDetail: function (id) {
            return api('step-detail?id=' + encodeURIComponent(id))
          },
          onGrowth: function () {
            followGrowth(320)
            scheduleHitReport()
          }
        })
      }
      island.render({
        detail: readDetailMode(),
        turns: turnList,
        moreCount: pendingTurns().length,
        onLoadMore: function () { loadMoreTurns(MORE_BATCH); },
        steps: blank ? [] : ((state && state.steps) || []),
        stream: blank ? null : (state && state.stream),
        turn: blank ? null : (state && state.turn),
        running: Boolean(state && state.status === 'running')
      })
    }

    /** Drop the island (locale change rebuilds every label). */
    function destroyIsland() {
      if (island) {
        try {
          island.unmount()
        } catch (error) {
          console.warn('[QuickDock] render island unmount failed:', error)
        }
        island = null
      }
    }

    /**
     * Question card. Approvals are intentionally not rendered here: they are
     * answered in the input window's run panel, and duplicating the Allow/Deny
     * dialog in the list window made two identical dialogs appear.
     * Returns null when there is nothing to ask.
     */
    /** Questions are answered in the input window; nothing to draw here. */
    function buildInteractionCard() {
      return null;
    }

    /* -------------------------------- scrolling -------------------------------- */

    /** Adopt the position the user left the list at. */
    function adoptScroll() {
      var scroller = scrollHost();
      if (!scroller) return;
      autoScroll = U.isNearBottom(scroller, 24);
    }

    /**
     * Mark a real user gesture.
     *
     * Momentum, smooth scrolling and a scrollbar drag keep firing scroll events,
     * and each one refreshes the window; once it settles, the final position
     * decides whether following resumes. Nothing else may change `autoScroll`:
     * content growth, a scrollbar appearing or a programmatic write all produce
     * scroll events that must not pause follow mode.
     */
    function markGesture() {
      gestureActive = true;
      clearTimeout(gestureTimer);
      gestureTimer = setTimeout(function () {
        gestureActive = false;
        adoptScroll();
      }, GESTURE_IDLE_MS);
    }

    /**
     * Restore the reading position after a render.
     *
     * Older turns are inserted ABOVE the viewport, so the scroll offset must grow
     * by however much the content grew - otherwise the reader is thrown to the
     * top of the conversation on every "load earlier turns".
     * @param {number} prevTop offset before the render.
     * @param {boolean} wasAuto whether the list was following the bottom.
     * @param {number} prevHeight scrollHeight before the render.
     */
    /** Diagnostic line in dock.log; silent outside Electron. */
    function report(message) {
      var bridge = window.quickDock;
      if (bridge && bridge.debug) {
        try { bridge.debug(message); } catch (error) { /* ignore */ }
      }
    }

    function applyAutoScroll(prevTop, wasAuto, prevHeight) {
      var scroller = scrollHost();
      if (!scroller) {
        report('restore skipped: no scroll host');
        return;
      }
      if (wasAuto) {
        scroller.scrollTop = scroller.scrollHeight;
        return;
      }
      var grown = Math.max(0, scroller.scrollHeight - (prevHeight || 0));
      scroller.scrollTop = anchorAbove ? prevTop + grown : prevTop;
      report('restore prevTop=' + Math.round(prevTop) + ' prevHeight=' + Math.round(prevHeight || 0)
        + ' grown=' + Math.round(grown) + ' anchor=' + anchorAbove
        + ' -> top=' + Math.round(scroller.scrollTop)
        + ' height=' + Math.round(scroller.scrollHeight)
        + ' client=' + Math.round(scroller.clientHeight));
      anchorAbove = false;
    }

    function bindAutoScroll() {
      var scroller = scrollHost();
      if (!scroller || scroller.__qdBound) return;
      scroller.__qdBound = true;
      ['wheel', 'touchstart', 'touchmove'].forEach(function (type) {
        scroller.addEventListener(type, markGesture, { passive: true });
      });
      // A scrollbar press targets the element itself (offsetX beyond clientWidth),
      // so pointerdown also covers dragging the scrollbar thumb.
      scroller.addEventListener('pointerdown', markGesture, { passive: true });
      document.addEventListener('keydown', function (event) {
        if (!SCROLL_KEYS[event.key]) return;
        if (event.target === scroller || (event.target && scroller.contains(event.target))) {
          markGesture();
        }
      }, true);
      scroller.addEventListener('scroll', function () {
        if (gestureActive) {
          // Keep the window alive through momentum / drag events, then adopt.
          markGesture();
          adoptScroll();
          return;
        }
        // Not the user: a new row, the scrollbar appearing, our own write. Follow
        // mode must not change; when following, re-pin so growth is never missed.
        if (autoScroll) scroller.scrollTop = scroller.scrollHeight;
      }, { passive: true });
    }

    function initialScroll() {
      var scroller = scrollHost();
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    }

    /* -------------------------------- reconcile -------------------------------- */

    function syncCard(interaction, hasInter) {
      // Only questions get a card; approvals live in the input window.
      var key = hasInter && interaction && interaction.kind !== 'approval'
        ? interaction.kind + ':' + interaction.id
        : '';
      if (key === cardKey) return;
      if (cardNode && cardNode.parentNode === host) host.removeChild(cardNode);
      cardNode = null;
      cardKey = '';
      if (!key) return;
      var card = buildInteractionCard(interaction);
      if (!card) return;
      cardNode = U.el('div', 'drow');
      cardNode.appendChild(card);
      cardKey = key;
      host.appendChild(cardNode);
    }

    function resetHost() {
      destroyIsland();
      host.textContent = '';
      cardNode = null;
      cardKey = '';
    }

    /** Hand the newest state to the island; the question card stays here. */
    function syncRows(state, interaction, hasInter) {
      renderRows(state);
      syncCard(interaction, hasInter);
    }

    /* --------------------------------- render --------------------------------- */

    /**
     * Render the current state.
     * @param {object} [next] state snapshot (defaults to getState()).
     */
    function render(next) {
      var state = next || getState();
      if (!host) return;
      if (needsRebuild) {
        needsRebuild = false;
        resetHost();
      }
      // Absorb before deciding whether there is anything to show: on a cold bind
      // the live state is empty and only the outline can tell us otherwise.
      absorbHistory(state);
      // A new conversation has no session yet: the previous column must not survive.
      var blank = Boolean(state && (state.newSession || !state.sessionId));
      if (blank) {
        turnList = [];
        outline = [];
      }
      var steps = blank ? [] : ((state && state.steps) || []);
      var interaction = state && state.interaction;
      var hasInter = Boolean(interaction && interaction.status === 'open');
      var hasStream = hasLiveText(state && state.stream);
      // Loaded history counts as content: an old session binds with no live rows,
      // and the column (plus its load-more pill) still has to be on screen.
      var hasContent = Boolean(steps.length || hasInter || hasStream || turnList.length);

      // Approvals are answered in the input window, so a hidden list stays hidden.
      applyVisibility(hasContent);
      // Nothing to show still renders: the island paints the "nothing has run"
      // hint, and the panel keeps its full height instead of collapsing to a
      // two-pixel strip inside a 520px window.
      if (!hasContent) {
        syncRows(blank ? Object.assign({}, state, { turn: null, stream: null, steps: [] }) : state, interaction, hasInter);
        return;
      }

      var scroller = scrollHost();
      var prevTop = scroller ? scroller.scrollTop : 0;
      var prevHeight = scroller ? scroller.scrollHeight : 0;
      var wasAuto = autoScroll;
      syncRows(state, interaction, hasInter);
      applyAutoScroll(prevTop, wasAuto, prevHeight);
      // The session opens on the newest turn, not on whatever the first paint
      // happened to leave in view.
      if (!didInitialScroll) {
        didInitialScroll = true;
        autoScroll = true;
        // Layout may not be flushed when this runs (fonts, images, the island's
        // first commit), so pin on the next frames as well instead of writing
        // scrollTop once against a height that is still 0.
        var scroller = scrollHost();
        if (scroller) scroller.scrollTop = scroller.scrollHeight;
        followGrowth(600);
      }
      scheduleHitReport();
    }

    /** Rebuild on the next render (locale change or other labeling change). */
    function invalidate() {
      needsRebuild = true;
    }

    return {
      render: render,
      invalidate: invalidate,
      bindAutoScroll: bindAutoScroll,
      initialScroll: initialScroll,
      scrollHost: scrollHost,
      applyVisibility: applyVisibility
    };
  }

  window.QD.display = { create: create, hasLiveText: hasLiveText };
})();
