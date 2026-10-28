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

  /** Localized approval text: current locale first, then Chinese, then reason. */
  function approvalText(interaction) {
    var localized = interaction && interaction.displayReason;
    if (localized && typeof localized === 'object') {
      var picked = localized[window.QD.i18n.locale()] || localized.zh || localized.en;
      if (typeof picked === 'string' && picked.trim()) return picked.trim();
    }
    if (typeof localized === 'string' && localized.trim()) return localized.trim();
    return String((interaction && (interaction.reason || interaction.callId)) || '');
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

    /** Row id -> explicit expand choice (overrides "open while running"). */
    var expandedSteps = {};
    /** "id@status" -> { args, result } loaded on demand. */
    var stepDetails = {};
    /** Row id -> live DOM record; reconciled on every render. */
    var records = Object.create(null);
    var liveRow = null;
    var cardNode = null;
    var cardKey = '';
    var needsRebuild = false;
    var stepsSig = null;
    var autoScroll = true;
    var scrollGuard = false;

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

    /* ---------------------------- step details ---------------------------- */

    function rawPre(text) {
      return U.el('pre', 'sd-pre', text);
    }

    /**
     * Arguments panel: short values stay inline, long text gets its own row
     * with internal scrolling so one edit cannot stretch the whole list.
     */
    function argsBlock(raw) {
      var box = U.el('div', 'sd-args');
      var parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        parsed = null;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        box.appendChild(rawPre(parsed === null ? raw : U.prettyArgs(raw)));
        return box;
      }

      var shown = 0;
      var keys = Object.keys(parsed).filter(function (key) {
        var value = parsed[key];
        return !(value === null || value === undefined || value === '');
      });
      // A lone description has nothing else to show, so it is not a duplicate.
      var onlyDescription = keys.length === 1 && keys[0] === 'description';
      keys.forEach(function (key) {
        if (key === 'description' && !onlyDescription) return; // already the row title
        var value = parsed[key];
        var text = typeof value === 'string' ? value : U.stringifyValue(value);
        if (!text) return;
        var row = U.el('div', 'sd-arg');
        var name = U.el('span', 'sd-key', key);
        var cell = U.el('span', 'sd-val', text);
        if (text.indexOf('\n') < 0 && text.length <= 56) {
          row.classList.add('inline');
          cell.title = text;
        }
        row.appendChild(name);
        row.appendChild(cell);
        box.appendChild(row);
        shown += 1;
      });
      if (!shown) box.appendChild(rawPre(U.prettyArgs(raw)));
      return box;
    }

    function renderStepDetail(box, detail) {
      var args = String(detail.args || '');
      var result = String(detail.result || '');
      box.textContent = '';
      box.classList.toggle('empty', !args && !result);
      if (!args && !result) {
        box.textContent = t('display.noDetail');
        return;
      }
      if (args) box.appendChild(argsBlock(args));
      if (result) {
        var wrap = U.el('div', 'sd-result');
        wrap.appendChild(U.el('span', 'sd-label', t('display.output')));
        wrap.appendChild(U.el('pre', 'sd-out', result));
        box.appendChild(wrap);
      }
    }

    /**
     * Load one row's full detail on first expand. The cache key includes the
     * status because a tool's result only exists once the call finished.
     */
    function fillStepDetail(box, id, status) {
      var key = id + '@' + (status || '');
      if (box.dataset.key === key || box.dataset.failed === key) return;
      if (stepDetails[key]) {
        delete box.dataset.loading;
        box.dataset.key = key;
        renderStepDetail(box, stepDetails[key]);
        return;
      }
      if (box.dataset.loading === key) return;
      box.dataset.loading = key;
      box.dataset.key = '';
      box.classList.remove('empty');
      box.textContent = t('display.loading');
      api('step-detail?id=' + encodeURIComponent(id)).then(function (detail) {
        stepDetails[key] = detail || {};
        if (!box.isConnected || box.dataset.loading !== key) return;
        delete box.dataset.loading;
        delete box.dataset.failed;
        box.dataset.key = key;
        renderStepDetail(box, stepDetails[key]);
      }).catch(function (error) {
        if (!box.isConnected || box.dataset.loading !== key) return;
        delete box.dataset.loading;
        box.dataset.failed = key;
        box.textContent = t('display.loadFailed', { message: String(error && error.message || error) });
      });
    }

    /**
     * Open or close a tool row's detail. The classes drive the CSS transition;
     * the content stays mounted so collapsing animates instead of snapping.
     *
     * @param {object} rec row record.
     * @param {boolean} open target state.
     * @param {string} status row status (keys the detail cache).
     * @param {boolean} follow keep the list pinned to the bottom while an
     *   automatically opened running row grows.
     */
    function setDetailOpen(rec, open, status, follow) {
      if (rec.isOpen === open) {
        if (open) fillStepDetail(rec.detailBox, rec.id, status);
        return;
      }
      rec.isOpen = open;
      rec.row.classList.toggle('open', open);
      rec.detail.classList.toggle('open', open);
      rec.row.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (rec.chevron) rec.chevron.title = open ? t('display.collapse') : t('display.expand');
      if (open) {
        fillStepDetail(rec.detailBox, rec.id, status);
        if (follow) followGrowth(320);
      }
      scheduleHitReport();
    }

    /**
     * Manual toggles must not fight the user's scroll position. Opening a
     * detail pauses follow mode; closing it resumes only when the list is at
     * the bottom again (otherwise the next step tick would yank the view).
     */
    function pauseFollowOnToggle(open) {
      if (open) {
        autoScroll = false;
        return;
      }
      var scroller = scrollHost();
      autoScroll = !scroller || U.isNearBottom(scroller, 24);
    }

    /** Toggle one row in place (no list rebuild). */
    function toggleStepDetail(rec) {
      if (!rec || !rec.expandable) return;
      var open = !rec.isOpen;
      expandedSteps[rec.id] = open;
      pauseFollowOnToggle(open);
      // A manual toggle keeps the row anchored: the user reads from the top.
      setDetailOpen(rec, open, rec.status, false);
    }

    /* ------------------------------ row builders ------------------------------ */

    /** Set text on an optional row part and hide it when empty (no flex gap). */
    function setOptional(node, text) {
      var value = text || '';
      node.hidden = !value;
      if (node.textContent !== value) node.textContent = value;
    }

    /** One tool row plus its lazily loaded detail block. */
    function buildToolRow(step, isRunning) {
      var rec = { id: String(step.id), kind: 'tool', status: null, isOpen: false };
      var row = U.el('div', 'step');
      rec.iconEl = U.el('span', 'step-icon');
      rec.labelEl = U.el('span', 'step-label');
      rec.subEl = U.el('span', 'step-sub');
      rec.linesEl = U.el('span', 'step-lines');
      rec.diffEl = U.el('span', 'step-diff');
      rec.timeEl = U.el('span', 'step-time');
      rec.subEl.hidden = true;
      rec.linesEl.hidden = true;
      rec.diffEl.hidden = true;
      row.appendChild(rec.iconEl);
      row.appendChild(rec.labelEl);
      row.appendChild(rec.subEl);
      row.appendChild(rec.linesEl);
      row.appendChild(rec.diffEl);
      row.appendChild(rec.timeEl);

      var block = U.el('div', 'drow');
      block.appendChild(row);
      rec.block = block;
      rec.row = row;

      // Only real tool calls expand (approval rows share kind:'tool' but have no args).
      if (rec.id.indexOf('tool-') === 0) {
        rec.expandable = true;
        row.classList.add('expandable');
        row.setAttribute('role', 'button');
        row.setAttribute('tabindex', '0');
        row.setAttribute('aria-expanded', 'false');
        rec.chevron = U.el('span', 'step-chev', '▸');
        rec.chevron.title = t('display.expand');
        row.appendChild(rec.chevron);

        var detail = U.el('div', 'step-detail');
        var clip = U.el('div', 'sd-clip');
        rec.detailBox = U.el('div', 'sd-box');
        clip.appendChild(rec.detailBox);
        detail.appendChild(clip);
        rec.detail = detail;
        block.appendChild(detail);

        row.addEventListener('click', function () {
          toggleStepDetail(rec);
        });
        row.addEventListener('keydown', function (event) {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          toggleStepDetail(rec);
        });
        detail.addEventListener('transitionend', function (event) {
          if (event.target === detail) scheduleHitReport();
        });
      }

      updateToolRow(rec, step, isRunning);
      return rec;
    }

    /** Update a tool row in place: status classes, text parts, open state. */
    function updateToolRow(rec, step, isRunning) {
      var stateName = isRunning ? 'run'
        : step.status === 'fail' ? 'fail'
        : step.status === 'done' ? 'done'
        : 'todo';
      if (rec.stateName !== stateName) {
        if (rec.stateName) rec.row.classList.remove(rec.stateName);
        rec.row.classList.add(stateName);
        rec.stateName = stateName;
      }

      // Icons express the action kind; color expresses status.
      var icon = isRunning ? '' : U.toolIcon(step.tool);
      if (rec.iconEl.textContent !== icon) rec.iconEl.textContent = icon;

      var primary = String(step.description || '').trim();
      var sub = U.rowSub(step.command);
      // With line numbers the path only keeps two segments, or the file name
      // itself gets truncated.
      if ((step.lines || step.delta) && /[\\/]/.test(sub)) sub = U.tailSegments(sub, 2);
      if (!primary) {
        primary = sub;
        sub = '';
      }
      if (primary === sub) sub = '';

      setOptional(rec.labelEl, primary || step.tool || step.label || step.text || '');
      if (primary || sub) rec.labelEl.title = (primary + ' ' + sub).trim();
      else rec.labelEl.removeAttribute('title');
      setOptional(rec.subEl, sub);

      if (step.lines && step.lines[0] && step.lines[1]) {
        setOptional(rec.linesEl, t('display.lines', { from: step.lines[0], to: step.lines[1] }));
        rec.linesEl.title = t('display.linesTitle', { from: step.lines[0], to: step.lines[1] });
      } else {
        setOptional(rec.linesEl, '');
        rec.linesEl.removeAttribute('title');
      }

      var added = Number(step.delta && step.delta[0]) || 0;
      var removed = Number(step.delta && step.delta[1]) || 0;
      if (added || removed) {
        var diffKey = added + ':' + removed;
        rec.diffEl.hidden = false;
        if (rec.diffEl.dataset.key !== diffKey) {
          rec.diffEl.dataset.key = diffKey;
          rec.diffEl.textContent = '';
          if (added) rec.diffEl.appendChild(U.el('span', 'add', '+' + added));
          if (removed) rec.diffEl.appendChild(U.el('span', 'del', '−' + removed));
        }
        rec.diffEl.title = t('display.diffTitle', { added: added, removed: removed });
      } else {
        rec.diffEl.hidden = true;
        rec.diffEl.textContent = '';
        delete rec.diffEl.dataset.key;
      }

      var config = getState() && getState().config;
      var showTiming = !config || config.showTiming !== false;
      var time = showTiming && step.time ? String(step.time).slice(11, 19) : '';
      if (rec.timeEl.textContent !== time) rec.timeEl.textContent = time;

      var status = step.status || '';
      var statusChanged = rec.status !== status;
      rec.status = status;
      if (rec.expandable) {
        var explicit = typeof expandedSteps[rec.id] === 'boolean';
        var open = explicit ? expandedSteps[rec.id] : isRunning;
        // A finished call gains its result: refresh the open detail first, then
        // collapse it if it was only open because the call was running.
        if (statusChanged && rec.isOpen) fillStepDetail(rec.detailBox, rec.id, status);
        setDetailOpen(rec, open, status, !explicit && isRunning);
      }
    }

    /** Thinking row: a folded summary that expands to the full text. */
    function buildThink(step) {
      var rec = { id: String(step.id), kind: 'think', text: null };
      var box = U.el('div', 'think');
      var head = U.el('button', 'think-head');
      head.type = 'button';
      head.setAttribute('aria-expanded', 'false');
      head.appendChild(U.el('span', 'th-icon', '✦'));
      rec.preview = U.el('span', 'th-preview');
      head.appendChild(rec.preview);
      head.appendChild(U.el('span', 'th-chev', '▶'));

      var body = U.el('div', 'think-body');
      var clip = U.el('div', 'tb-clip');
      rec.textEl = U.el('div', 'tb-box');
      clip.appendChild(rec.textEl);
      body.appendChild(clip);
      box.appendChild(head);
      box.appendChild(body);

      head.addEventListener('click', function () {
        var open = !box.classList.contains('open');
        box.classList.toggle('open', open);
        head.setAttribute('aria-expanded', open ? 'true' : 'false');
        pauseFollowOnToggle(open);
        scheduleHitReport();
      });

      var block = U.el('div', 'drow');
      block.appendChild(box);
      rec.block = block;
      updateThink(rec, step);
      return rec;
    }

    function updateThink(rec, step) {
      var text = String(step.text || '');
      if (rec.text === text) return;
      rec.text = text;
      var one = text.replace(/\s+/g, ' ').trim();
      rec.preview.textContent = one.length > 42 ? one.slice(0, 42) + '…' : one;
      if (rec.textEl.textContent !== text) rec.textEl.textContent = text;
    }

    /** Prose row: rendered Markdown, updated only when the text changed. */
    function buildSay(step, isRunning) {
      var rec = { id: String(step.id), kind: 'say', text: null };
      var block = U.el('div', 'drow');
      rec.sayEl = U.el('div', 'say md');
      block.appendChild(rec.sayEl);
      rec.block = block;
      updateSay(rec, step, isRunning);
      return rec;
    }

    function updateSay(rec, step, isRunning) {
      var text = String(step.text || '');
      if (rec.text !== text) {
        rec.text = text;
        rec.sayEl.innerHTML = mdHtml(text);
      }
      rec.sayEl.classList.toggle('streaming', Boolean(isRunning));
    }

    function cardHead(text, tag) {
      var head = U.el('div', 'card-head', text);
      if (tag) head.appendChild(U.el('span', 'ch-tag', tag));
      return head;
    }

    function cardActions(items, id) {
      var row = U.el('div', 'card-actions');
      items.forEach(function (item) {
        var button = U.el('button', 'card-btn ' + (item.cls || ''), item.label);
        button.type = 'button';
        button.setAttribute('aria-label', item.aria || item.label);
        button.addEventListener('click', function () {
          api('answer', { id: id, outcome: item.value }).catch(toastError);
          markAnswered();
        });
        row.appendChild(button);
      });
      return row;
    }

    /** Approval / question card. Returns null when there is nothing to ask. */
    function buildInteractionCard(interaction) {
      if (!interaction || interaction.status !== 'open') return null;
      if (interaction.kind === 'approval') {
        var card = U.el('div', 'card approval');
        card.appendChild(cardHead(t('card.needConfirm'), interaction.toolName || ''));
        var body = U.el('div', 'card-body');
        body.appendChild(U.el('div', 'cmd', approvalText(interaction)));
        body.appendChild(cardActions([
          { label: t('card.allow'), cls: 'primary', value: 'allow', aria: t('card.allowLabel') },
          { label: t('card.deny'), cls: 'danger', value: 'deny', aria: t('card.denyLabel') }
        ], interaction.id));
        card.appendChild(body);
        card.appendChild(U.el('div', 'card-foot', t('card.note')));
        return card;
      }
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

    function applyAutoScroll(prevTop, wasAuto) {
      var scroller = scrollHost();
      if (!scroller) return;
      scrollGuard = true;
      if (wasAuto) scroller.scrollTop = scroller.scrollHeight;
      else scroller.scrollTop = prevTop;
      // Release on the next task so this assignment's scroll event is ignored.
      setTimeout(function () {
        scrollGuard = false;
      }, 0);
    }

    function bindAutoScroll() {
      var scroller = scrollHost();
      if (!scroller || scroller.__qdBound) return;
      scroller.__qdBound = true;
      scroller.addEventListener('scroll', function () {
        if (scrollGuard) return;
        // Back at the bottom = follow again; scrolled up = stay put.
        autoScroll = U.isNearBottom(scroller, 24);
      }, { passive: true });
    }

    function initialScroll() {
      var scroller = scrollHost();
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    }

    /* -------------------------------- reconcile -------------------------------- */

    function destroyRecord(rec) {
      if (rec.block && rec.block.parentNode === host) host.removeChild(rec.block);
    }

    /** Insert a new row before the card / live row, keeping the tail order. */
    function insertBlock(node) {
      var anchor = liveRow && liveRow.parentNode === host ? liveRow : null;
      if (cardNode && cardNode.parentNode === host) anchor = cardNode;
      if (anchor) host.insertBefore(node, anchor);
      else host.appendChild(node);
    }

    function ensureLiveRow() {
      if (!liveRow) {
        liveRow = U.el('div', 'drow');
        liveRow.id = 'liveRow';
        liveRow.hidden = true;
      }
      if (host.lastElementChild !== liveRow) host.appendChild(liveRow);
    }

    function syncCard(interaction, hasInter) {
      var key = hasInter && interaction ? interaction.kind + ':' + interaction.id : '';
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
      host.textContent = '';
      records = Object.create(null);
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

    /** Reconcile the step list with the snapshot, reusing nodes by row id. */
    function syncRows(steps, interaction, hasInter) {
      var seen = Object.create(null);
      // Only the last running row is "in progress": an interrupted session can
      // leave several rows in run state, and a wall of spinners reads as broken.
      var lastRun = -1;
      steps.forEach(function (step, index) {
        if (step && step.status === 'run') lastRun = index;
      });

      steps.forEach(function (step, index) {
        if (!step || !step.id) return;
        var id = String(step.id);
        seen[id] = true;
        var rec = records[id];
        if (rec && rec.kind !== step.kind) {
          destroyRecord(rec);
          rec = null;
        }
        if (!rec) {
          var running = index === lastRun;
          rec = step.kind === 'think' ? buildThink(step)
            : step.kind === 'say' ? buildSay(step, running)
              : buildToolRow(step, running);
          records[id] = rec;
          insertBlock(rec.block);
        } else if (step.kind === 'think') {
          updateThink(rec, step);
        } else if (step.kind === 'say') {
          updateSay(rec, step, index === lastRun);
        } else {
          updateToolRow(rec, step, index === lastRun);
        }
      });

      Object.keys(records).forEach(function (id) {
        if (seen[id]) return;
        destroyRecord(records[id]);
        delete records[id];
      });

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

      applyVisibility(hasContent, hasInter);
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
