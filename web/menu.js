/* Dropdown menu for the four function keys.
 *
 * The input window is only ~172px high, so a long model list would be clipped
 * to two rows. Three measures keep it usable:
 *   1. a search field once the list is long enough (title stays fixed)
 *   2. arrow / Home / End / Enter / Escape navigation
 *   3. asking the Host to grow the window upwards while the menu is open
 *
 * The menu itself is a singleton: opening another anchor replaces it.
 */
(function () {
  'use strict';

  var U = window.QD.util;

  var MENU_MAX_H = 380;      // taller than this and the menu covers the screen
  var MENU_SEARCH_MIN = 8;   // a three-item permission list needs no search
  var MENU_EXTRA_MAX = 460;  // most extra height requested in one go
  var MENU_VIEW_PAD = 8;     // minimum distance to the window edge

  /**
   * @param {{menuEl: HTMLElement, getPanel: Function, t: Function,
   *          onLayout?: Function}} options
   */
  function create(options) {
    var menuEl = options.menuEl;
    var t = options.t;
    var getPanel = options.getPanel || function () { return null; };
    var onLayout = options.onLayout || function () {};

    var data = { owner: null, title: '', source: [], query: '' };
    var seq = 0;              // invalidates stale "wait for growth" callbacks
    var listEl = null;
    var searchEl = null;
    var itemEls = [];         // focusable option buttons, in visual order
    var active = -1;
    var expanded = false;     // window grown for the menu
    var spaceToken = 0;       // invalidates stale release callbacks

    function isOpen() {
      return Boolean(menuEl && menuEl.classList.contains('open'));
    }

    function quickDock() {
      return window.quickDock || null;
    }

    function reset() {
      seq += 1;
      data = { owner: null, title: '', source: [], query: '' };
      itemEls = [];
      active = -1;
      listEl = null;
      searchEl = null;
      if (!menuEl) return;
      menuEl.classList.remove('open');
      menuEl.textContent = '';
      menuEl.style.visibility = 'hidden';
    }

    function close() {
      reset();
      releaseSpace();
    }

    /** Clear the DOM without collapsing the window (avoids a jump between menus). */
    function resetKeepSpace() {
      reset();
    }

    /**
     * Open the menu for one anchor.
     * @param {HTMLElement} owner anchor button.
     * @param {string} title translated menu title.
     * @param {object[]} items entries: {name, sub?, group?, sel?, disabled?, onPick?}.
     */
    function open(owner, title, items) {
      if (!menuEl) return;
      if (data.owner === owner && isOpen()) {
        close();
        return;
      }
      resetKeepSpace();
      // A menu is opening: an in-flight release must not unpin the panel.
      spaceToken += 1;
      var current = seq;
      data.owner = owner;
      data.title = title || '';
      data.source = items || [];
      buildDom();

      var natural = measure();
      var extra = neededSpace(natural);
      reserveSpace(extra).then(function () {
        if (current !== seq) return; // closed or replaced while waiting
        place(owner);
        menuEl.style.visibility = '';
        menuEl.classList.add('open');
        highlightInitial();
        focusMenu();
        onLayout();
      });
    }

    function searchable() {
      var count = 0;
      for (var i = 0; i < data.source.length; i += 1) {
        var item = data.source[i];
        if (item && !item.head && !item.sep) count += 1;
      }
      return count >= MENU_SEARCH_MIN;
    }

    function matches(item, query) {
      var text = String(item.name || '') + ' ' + String(item.sub || '') + ' ' + String(item.group || '');
      return text.toLowerCase().indexOf(query) >= 0;
    }

    function buildDom() {
      menuEl.textContent = '';
      menuEl.style.maxHeight = '';
      menuEl.style.width = '';
      menuEl.style.left = '';
      menuEl.style.top = '';
      if (data.title) menuEl.appendChild(U.el('div', 'menu-title', data.title));
      if (searchable()) {
        var input = U.el('input', 'menu-search');
        input.type = 'search';
        input.placeholder = t('menu.searchPlaceholder', { title: data.title });
        input.setAttribute('aria-label', t('menu.searchLabel', { title: data.title || t('menu.menuLabel') }));
        input.addEventListener('input', function () {
          data.query = input.value.trim().toLowerCase();
          renderList();
          // Keep the anchor: the menu got shorter but the window stays open.
          place(data.owner);
          highlightInitial();
        });
        menuEl.appendChild(input);
        searchEl = input;
      }
      listEl = U.el('div', 'menu-list');
      menuEl.appendChild(listEl);
      renderList();
    }

    function renderList() {
      if (!listEl) return;
      var query = data.query;
      listEl.textContent = '';
      itemEls = [];
      active = -1;
      var lastGroup = null;
      var shown = 0;
      data.source.forEach(function (item) {
        if (!item) return;
        if (item.sep) {
          if (query) return;
          listEl.appendChild(U.el('div', 'menu-sep'));
          lastGroup = null;
          return;
        }
        if (item.head) {
          // Section heading (used by cross-workspace session lists).
          if (query) return;
          listEl.appendChild(U.el('div', 'menu-group', item.head));
          lastGroup = null;
          return;
        }
        if (query && !matches(item, query)) return;
        if (!query && item.group && item.group !== lastGroup) {
          listEl.appendChild(U.el('div', 'menu-group', item.group));
        }
        if (!query) lastGroup = item.group || null;

        var button = U.el('button', 'menu-item' + (item.sel ? ' sel' : ''));
        button.type = 'button';
        button.setAttribute('role', 'menuitem');
        var main = U.el('span', 'mi-main');
        main.appendChild(U.el('span', 'mi-name', item.name));
        if (item.sub) main.appendChild(U.el('span', 'mi-sub', item.sub));
        button.appendChild(main);
        button.appendChild(U.el('span', 'mi-check', item.sel ? '✓' : ''));
        if (item.disabled) button.disabled = true;
        button.addEventListener('click', function (event) {
          event.stopPropagation();
          if (item.disabled) return;
          close();
          if (item.onPick) item.onPick();
        });
        button.addEventListener('mouseenter', function () {
          if (item.disabled) return;
          var index = itemEls.indexOf(button);
          if (index >= 0) setActive(index, false);
        });
        listEl.appendChild(button);
        if (!item.disabled) itemEls.push(button);
        shown += 1;
      });
      if (!shown) listEl.appendChild(U.el('div', 'menu-empty', data.source.length ? t('menu.emptyMatch') : t('menu.emptyOptions')));
    }

    /** Measure the natural height while hidden (prevents a visible flash). */
    function measure() {
      menuEl.style.maxHeight = 'none';
      menuEl.style.visibility = 'hidden';
      menuEl.classList.add('open');
      var natural = menuEl.offsetHeight;
      menuEl.classList.remove('open');
      return natural;
    }

    /** How much extra window height the anchor lacks above it. */
    function neededSpace(natural) {
      var quick = quickDock();
      if (!quick || !quick.setMenuSpace) return 0;
      var rect = data.owner && data.owner.getBoundingClientRect ? data.owner.getBoundingClientRect() : null;
      // Same padding as place(): 4px gap to the anchor + 8px window edge.
      var available = rect ? Math.max(0, rect.top - 12) : window.innerHeight;
      var extra = Math.min(natural, MENU_MAX_H) - available;
      if (extra <= 0) return 0;
      // Round to 4px: repeated rounding otherwise makes the window jitter.
      return Math.min(Math.ceil(extra / 4) * 4, MENU_EXTRA_MAX);
    }

    /** Ask the Host for extra height; resolves once layout settled. */
    function reserveSpace(extra) {
      var quick = quickDock();
      if (!quick || !quick.setMenuSpace) return Promise.resolve(0);
      // Never shrink while a menu is open: shrinking forces a reposition.
      if (extra <= 0) return Promise.resolve(0);
      if (!expanded) {
        expanded = true;
        pinHeight(window.innerHeight);
      }
      // Attach the resize listener before asking: the Host may resize first.
      var layout = waitForLayout();
      var request;
      try {
        request = quick.setMenuSpace(extra);
      } catch (error) {
        request = Promise.reject(error);
      }
      return Promise.resolve(request).then(function (granted) {
        // No growth at all (window already at the screen edge): do not wait.
        return granted ? layout : 0;
      }, function () {
        releaseSpace();
        return layout;
      });
    }

    /** Wait for the renderer to observe a new window size. */
    function waitForLayout() {
      return new Promise(function (resolve) {
        var done = false;
        function finish() {
          if (done) return;
          done = true;
          window.removeEventListener('resize', onResize);
          resolve();
        }
        function onResize() {
          requestAnimationFrame(function () {
            requestAnimationFrame(finish);
          });
        }
        window.addEventListener('resize', onResize);
        setTimeout(finish, 120);
      });
    }

    /** Pin the panel to its original height while the window is taller. */
    function pinHeight(height) {
      spaceToken += 1;
      var dock = document.getElementById('dock');
      if (dock) dock.style.height = height + 'px';
      document.body.classList.add('menu-expanded');
    }

    /**
     * Release the extra height. The order matters: shrink first, unpin only
     * after the resize arrives, otherwise the panel visibly jumps.
     */
    function releaseSpace() {
      var quick = quickDock();
      if (!expanded) {
        if (quick && quick.setMenuSpace) {
          try {
            quick.setMenuSpace(0);
          } catch (error) {
            /* ignore */
          }
        }
        return;
      }
      var layout = waitForLayout();
      var request = null;
      if (quick && quick.setMenuSpace) {
        try {
          request = quick.setMenuSpace(0);
        } catch (error) {
          request = null;
        }
      }
      var token = spaceToken;
      var unpin = function () {
        // Another menu grew the window again in the meantime.
        if (token !== spaceToken || !expanded) return;
        expanded = false;
        document.body.classList.remove('menu-expanded');
        var dock = document.getElementById('dock');
        if (dock) dock.style.height = '';
      };
      if (!quick || !quick.setMenuSpace) {
        unpin();
        return;
      }
      if (request && typeof request.then === 'function') {
        request.then(function () {
          return layout;
        }, function () {
          return layout;
        }).then(unpin);
      } else {
        layout.then(unpin);
      }
    }

    /**
     * Place the menu above the anchor (below when there is no room).
     * Horizontally it follows the panel so long model names are not elided.
     */
    function place(owner) {
      if (!menuEl) return;
      var panel = getPanel();
      var panelRect = panel ? panel.getBoundingClientRect() : null;
      var viewWidth = window.innerWidth;
      var width = Math.min(panelRect ? Math.max(220, panelRect.width - 16) : 344, viewWidth - MENU_VIEW_PAD * 2, 460);
      menuEl.style.width = Math.round(width) + 'px';
      var left = panelRect
        ? Math.max(MENU_VIEW_PAD, Math.min(panelRect.left + 8, viewWidth - width - MENU_VIEW_PAD))
        : MENU_VIEW_PAD;
      menuEl.style.left = Math.round(left) + 'px';

      // Measure the natural height before deciding how much fits.
      menuEl.style.maxHeight = 'none';
      menuEl.classList.add('open');
      var natural = menuEl.offsetHeight;
      var anchor = owner && owner.getBoundingClientRect ? owner.getBoundingClientRect() : null;
      var PAD = 12;
      if (anchor) {
        var spaceAbove = Math.max(0, anchor.top - PAD);
        var spaceBelow = Math.max(0, window.innerHeight - anchor.bottom - PAD);
        // The input window is short: prefer upwards, else use the larger side.
        var openUp = spaceAbove >= Math.min(natural, MENU_MAX_H) || spaceAbove >= spaceBelow;
        var available = Math.max(openUp ? spaceAbove : spaceBelow, 96);
        var height = Math.min(natural, available, MENU_MAX_H);
        menuEl.style.maxHeight = Math.round(height) + 'px';
        menuEl.style.top = Math.round(openUp
          ? Math.max(MENU_VIEW_PAD, anchor.top - height - 4)
          : Math.min(anchor.bottom + 4, window.innerHeight - height - MENU_VIEW_PAD)) + 'px';
      } else {
        var fallback = Math.min(natural, MENU_MAX_H);
        menuEl.style.maxHeight = Math.round(fallback) + 'px';
        menuEl.style.top = Math.round(Math.max(MENU_VIEW_PAD, window.innerHeight - fallback - MENU_VIEW_PAD)) + 'px';
      }
    }

    /** Start on the selected item so a long list opens at the current value. */
    function highlightInitial() {
      if (!itemEls.length) return;
      var index = 0;
      if (!data.query) {
        for (var i = 0; i < itemEls.length; i += 1) {
          if (itemEls[i].classList.contains('sel')) {
            index = i;
            break;
          }
        }
      }
      setActive(index, true);
    }

    function focusMenu() {
      if (searchEl) {
        try {
          searchEl.focus();
        } catch (error) {
          /* ignore */
        }
        return;
      }
      try {
        menuEl.focus();
      } catch (error) {
        /* ignore */
      }
    }

    function setActive(index, scroll) {
      if (!itemEls.length) {
        active = -1;
        return;
      }
      if (!(index >= 0 && index < itemEls.length)) index = 0;
      if (active >= 0 && itemEls[active]) itemEls[active].classList.remove('active');
      active = index;
      var node = itemEls[index];
      node.classList.add('active');
      if (scroll) {
        try {
          node.scrollIntoView({ block: 'nearest' });
        } catch (error) {
          /* ignore */
        }
      }
    }

    function handleKeydown(event) {
      if (!isOpen()) return;
      var key = event.key;
      if (key === 'ArrowDown' || key === 'ArrowUp') {
        event.preventDefault();
        event.stopPropagation();
        if (!itemEls.length) return;
        var step = key === 'ArrowDown' ? 1 : -1;
        var next = active < 0
          ? (step > 0 ? 0 : itemEls.length - 1)
          : (active + step + itemEls.length) % itemEls.length;
        setActive(next, true);
        return;
      }
      if (key === 'Home' || key === 'End') {
        event.preventDefault();
        event.stopPropagation();
        setActive(key === 'Home' ? 0 : itemEls.length - 1, true);
        return;
      }
      if (key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        var node = itemEls[active];
        if (node) node.click();
        return;
      }
      if (key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    }

    if (menuEl) {
      menuEl.setAttribute('tabindex', '-1');
      menuEl.addEventListener('keydown', handleKeydown);
    }
    document.addEventListener('click', function (event) {
      if (!menuEl || !menuEl.classList.contains('open')) return;
      if (menuEl.contains(event.target)) return;
      close();
    });

    return { open: open, close: close, isOpen: isOpen, handleKeydown: handleKeydown };
  }

  window.QD.menu = { create: create };
})();
