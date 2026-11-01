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
    var turnList = [];
    var loadingHistory = false;
    var loadedFor = 0;
    var loadedSession = null;
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

    function toastError(error) {
      if (options.toastError) options.toastError(error);
    }

    function scrollHost() {
      return document.getElementById('blocks');
    }

    function onAnswered() {
      if (options.onAnswered) options.onAnswered();
    }

    /** Let the Host decide whether the run window should show at all. */
    function applyVisibility(hasContent, force) {
      var quickDock = window.quickDock;
      if (!quickDock || !quickDock.setDisplayEmpty) return;
      try {
        quickDock.setDisplayEmpty(force ? false : (isListHidden() || !hasContent));
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

    /** Create the island once and hand it the newest state. */
    /**
     * Keep the column in step with the newest turn and pull older ones once, so
     * the window shows the conversation instead of only the turn being written.
     * @param {object} state snapshot.
     */
    function absorbHistory(state) {
      var meta = state && state.turn;
      if (!meta || typeof meta.number !== 'number') return;
      // A different session starts a new column.
      var sessionId = (state && state.sessionId) || null;
      if (sessionId !== loadedSession) {
        loadedSession = sessionId;
        turnList = [];
        loadedFor = 0;
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
        void loadOlderTurns(meta.number);
      }
    }

    /** Fetch the rows of the turns already on disk, newest of them first. */
    function loadOlderTurns(latest) {
      if (loadingHistory) return;
      loadingHistory = true;
      api('turns').then(function (list) {
        var known = {};
        turnList.forEach(function (row) { known[row.number] = true; });
        var rows = ((list && list.turns) || [])
          .filter(function (row) { return typeof row.turn === 'number' && row.turn < latest && !known[row.turn]; })
          .slice(-12);
        var next = function (index) {
          if (index >= rows.length) {
            loadingHistory = false;
            if (latestState) renderRows(latestState);
            return;
          }
          var number = rows[index].turn;
          var meta = { number: number, startedAt: rows[index].startedAt, endedAt: rows[index].endedAt };
          api('turn?turn=' + number).then(function (detail) {
            if (detail && detail.observed && detail.steps && detail.steps.length) {
              turnList.push({ number: number, turn: meta, steps: detail.steps });
              turnList.sort(function (a, b) { return a.number - b.number; });
            }
          }).catch(function () {}).then(function () { next(index + 1); });
        };
        next(0);
      }).catch(function () { loadingHistory = false; });
    }

    function renderRows(state) {
      latestState = state;
      absorbHistory(state);
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
        steps: (state && state.steps) || [],
        stream: state && state.stream,
        turn: state && state.turn,
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

    function cardHead(text, tag) {
      var head = U.el('div', 'card-head', text);
      if (tag) head.appendChild(U.el('span', 'ch-tag', tag));
      return head;
    }

    /**
     * Question card. Approvals are intentionally not rendered here: they are
     * answered in the input window's run panel, and duplicating the Allow/Deny
     * dialog in the list window made two identical dialogs appear.
     * Returns null when there is nothing to ask.
     */
    function buildInteractionCard(interaction) {
      if (!interaction || interaction.status !== 'open') return null;
      if (interaction.kind !== 'question') return null;

      var questionCard = U.el('div', 'card question');
      questionCard.appendChild(cardHead(t('card.question'), ''));
      var questionBody = U.el('div', 'card-body');
      (interaction.questions || []).forEach(function (question) {
        questionBody.appendChild(U.el('div', 'card-q', question.question || question.header || ''));
        if (question.options && question.options.length) {
          var options = U.el('div', 'opts');
          question.options.forEach(function (option, index) {
            var button = U.el('button', 'opt');
            button.type = 'button';
            button.appendChild(U.el('span', 'opt-key', String(index + 1)));
            var text = U.el('span', 'opt-text', option.label);
            if (option.description) text.appendChild(U.el('small', null, option.description));
            button.appendChild(text);
            button.addEventListener('click', function () {
              api('answer', { id: interaction.id, answers: [{ id: question.id, selected: [option.label] }] }).catch(toastError);
              markAnswered();
            });
            options.appendChild(button);
          });
          questionBody.appendChild(options);
        } else {
          var input = U.el('textarea', 'answer-input');
          input.placeholder = t('card.answerPlaceholder');
          var submit = U.el('button', 'card-btn primary', t('card.submit'));
          submit.type = 'button';
          submit.addEventListener('click', function () {
            var value = input.value.trim();
            if (!value) return;
            api('answer', { id: interaction.id, answers: [{ id: question.id, selected: [value] }] }).catch(toastError);
            markAnswered();
          });
          questionBody.appendChild(input);
          questionBody.appendChild(submit);
        }
      });
      questionCard.appendChild(questionBody);
      return questionCard;
    }

    function markAnswered() {
      var state = getState();
      if (state && state.interaction) state.interaction.status = 'answered';
      render();
      onAnswered();
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

    function applyAutoScroll(prevTop, wasAuto) {
      var scroller = scrollHost();
      if (!scroller) return;
      if (wasAuto) scroller.scrollTop = scroller.scrollHeight;
      else scroller.scrollTop = prevTop;
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
      var steps = (state && state.steps) || [];
      var interaction = state && state.interaction;
      var hasInter = Boolean(interaction && interaction.status === 'open');
      var hasStream = hasLiveText(state && state.stream);
      var hasContent = Boolean(steps.length || hasInter || hasStream);

      // Approvals are answered in the input window, so a hidden list stays hidden.
      applyVisibility(hasContent);
      if (!hasContent) {
        if (host.firstChild) resetHost();
        return;
      }

      var scroller = scrollHost();
      var prevTop = scroller ? scroller.scrollTop : 0;
      var wasAuto = autoScroll;
      syncRows(state, interaction, hasInter);
      applyAutoScroll(prevTop, wasAuto);
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
