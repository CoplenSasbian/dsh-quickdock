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

  /** Render Markdown, falling back to escaped text (never raw innerHTML). */
  function mdHtml(text) {
    if (typeof renderMarkdown === 'function') {
      try {
        return renderMarkdown(text);
      } catch (error) {
        console.warn('[QuickDock] markdown failed:', error);
      }
    }
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\n/g, '<br>');
  }

  /**
   * Create the display view.
   * @param {{root: HTMLElement, api: Function, getState: Function,
   *          isListHidden: Function, scheduleHitReport?: Function,
   *          toastError?: Function, onAnswered?: Function}} options
   * @returns {{render: Function, bindAutoScroll: Function, initialScroll: Function,
   *            scrollHost: Function, applyVisibility: Function}}
   */
  function create(options) {
    var host = options.root;
    var api = options.api;
    var getState = options.getState;
    var isListHidden = options.isListHidden || function () { return false; };
    var scheduleHitReport = options.scheduleHitReport || function () {};

    var liveRow = null;
    var cardNode = null;
    var cardKey = '';
    var needsRebuild = false;
    var stepsSig = null;
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

    /** Create the island once and hand it the newest step list. */
    function renderRows(steps) {
      var rows = rowsHost()
      if (!island) {
        island = window.QD.render.create({
          root: rows,
          t: t,
          markdown: mdHtml,
          loadDetail: function (id) {
            return api('step-detail?id=' + encodeURIComponent(id))
          },
          onGrowth: function () {
            followGrowth(320)
            scheduleHitReport()
          }
        })
      }
      island.render(steps)
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

    /* ------------------------------- live row ------------------------------- */

    /**
     * Update the live block in place. Rebuilding it on every token would replay
     * the row animation and make the whole window flicker.
     */
    function updateLiveRow() {
      var row = liveRow || document.getElementById('liveRow');
      if (!row) return;
      var state = getState();
      var stream = state && state.stream;
      if (!hasLiveText(stream)) {
        row.hidden = true;
        row.textContent = '';
        return;
      }
      row.hidden = false;
      var box = row.firstElementChild;
      if (!box || box.className !== 'live') {
        row.textContent = '';
        box = U.el('div', 'live');
        box.appendChild(U.el('div', 'live-think'));
        box.appendChild(U.el('div', 'live-tools'));
        box.appendChild(U.el('div', 'live-say'));
        row.appendChild(box);
      }
      box.setAttribute('data-idle', t('display.thinkingIdle'));
      var thinkEl = box.children[0];
      var toolsEl = box.children[1];
      var sayEl = box.children[2];

      // Thinking is never sliced: mixed CJK/Latin wrapping makes a sliced
      // block jump in height. CSS caps the height and scrolls instead.
      var thinking = stream.thinking ? String(stream.thinking) : '';
      var followThink = U.isNearBottom(thinkEl, 4);
      if (thinkEl.textContent !== thinking) thinkEl.textContent = thinking;
      thinkEl.hidden = !thinking;
      if (thinking && followThink) thinkEl.scrollTop = thinkEl.scrollHeight;

      var list = stream.tools || [];
      var tools = list.length
        ? list.slice(-2).map(function (tool) {
          var arg = U.shortText(U.compactArgs(tool.args), 110);
          return (tool.name || t('display.toolFallback')) + (arg ? '  ' + arg : '');
        }).join('    ')
        : '';
      tools = tools ? U.shortText(tools, 220) : '';
      if (toolsEl.textContent !== tools) toolsEl.textContent = tools;
      toolsEl.hidden = !tools;

      var say = stream.text ? String(stream.text) : '';
      var followSay = U.isNearBottom(sayEl, 4);
      if (sayEl.textContent !== say) sayEl.textContent = say;
      sayEl.hidden = !say;
      if (say && followSay) sayEl.scrollTop = sayEl.scrollHeight;

      box.classList.toggle('idle', !thinking && !say && !tools);
      // The caret is drawn on the last content line (CSS keys off data-tail).
      box.setAttribute('data-tail', say ? 'say' : (tools ? 'tools' : (thinking ? 'think' : '')));
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

    function ensureLiveRow() {
      if (!liveRow) {
        liveRow = U.el('div', 'drow');
        liveRow.id = 'liveRow';
        liveRow.hidden = true;
      }
      if (host.lastElementChild !== liveRow) host.appendChild(liveRow);
    }

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
      host.insertBefore(cardNode, liveRow);
    }

    function resetHost() {
      destroyIsland();
      host.textContent = '';
      liveRow = null;
      cardNode = null;
      cardKey = '';
      stepsSig = null;
    }

    /**
     * Cheap row fingerprint used to skip reconciliation when only the live
     * stream changed. Lengths match the old rebuild trigger; full text would
     * allocate the whole transcript on every token.
     */
    function rowsSignature(steps, interaction, hasInter) {
      var parts = [];
      for (var i = 0; i < steps.length; i += 1) {
        var step = steps[i];
        if (!step) continue;
        parts.push(step.id + ':' + step.status + ':' + ((step.text || step.command || '').length));
      }
      parts.push(hasInter ? interaction.id + ':' + interaction.status : '');
      return parts.join('|');
    }

    /** Hand the newest step list to the island; card and live row stay here. */
    function syncRows(steps, interaction, hasInter) {
      renderRows(steps);
      syncCard(interaction, hasInter);
      ensureLiveRow();
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
        else stepsSig = null;
        return;
      }

      var scroller = scrollHost();
      var prevTop = scroller ? scroller.scrollTop : 0;
      var wasAuto = autoScroll;
      var sig = rowsSignature(steps, interaction, hasInter);
      if (sig !== stepsSig) {
        stepsSig = sig;
        syncRows(steps, interaction, hasInter);
      }
      updateLiveRow();
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
