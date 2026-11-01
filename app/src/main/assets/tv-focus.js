/* TV 遥控焦点导航
 *
 * 只在 html[data-device="tv"] 启动；手机/平板这段代码直接 return，一个监听器都不装。
 *
 * 按键来源有两条：电视上由原生 dispatchKeyEvent 拦下来调 window.veyraTvKey(code)；
 * 浏览器/调试环境走 DOM keydown。两条路不会重复触发（原生拦掉的键到不了 WebView）。
 *
 * 导航用几何就近原则：不依赖 DOM 顺序和 tabindex，页面后续增删卡片不用改这里。
 */
(function () {
  'use strict';
  if (window.VEYRA_DEVICE !== 'tv') return;
  if (window.__veyraTvFocusReady) return;
  window.__veyraTvFocusReady = true;

  var KEY_UP = 19, KEY_DOWN = 20, KEY_LEFT = 21, KEY_RIGHT = 22, KEY_CENTER = 23, KEY_ENTER = 66, KEY_NUMPAD_ENTER = 160;
  var OVERLAYS = ['#detail-overlay', '#download-overlay', '#auth-overlay', '#unlock-overlay', '#confirm-overlay', '#update-overlay', '#age-gate', '#relay-overlay'];
  var FOCUSABLE = 'button, [role="button"], a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

  var current = null;
  var stash = null;
  var lastScope = null;
  var resetTimer = 0;
  var lastRoute = '';
  var paintGuard = { el: null, prev: null, until: 0 };

  function visible(el) {
    if (!el || el.disabled) return false;
    if (el.closest('[hidden]')) return false;
    var rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    var style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return false;
    return true;
  }

  /** 有弹层时只在弹层里找，避免焦点跑到后面的页面上。 */
  function scope() {
    for (var i = OVERLAYS.length - 1; i >= 0; i--) {
      var node = document.querySelector(OVERLAYS[i]);
      if (!node || node.hasAttribute('hidden')) continue;
      if (visible(node)) return node;
    }
    return null;
  }

  function collect() {
    var host = scope() || document;
    var nodes = host.querySelectorAll(FOCUSABLE);
    var list = [];
    for (var i = 0; i < nodes.length; i++) {
      if (visible(nodes[i])) list.push(nodes[i]);
    }
    return list;
  }

  /** 首屏落焦优先内容区：搜索框在最顶上，一进电视就选中它没有意义。
   *  再优先「卡片」——hero 的整块透明覆盖层虽然可聚焦，但焦点环会被 hero 的 overflow 裁掉，
   *  用户按下确认还会误触播放；直接落在第一张片子上，打开就能选。 */
  function contentFirst() {
    var content = document.getElementById('content');
    if (!content) return null;
    var cards = content.querySelectorAll('.film-card');
    for (var c = 0; c < cards.length; c++) {
      if (visible(cards[c])) return cards[c];
    }
    var nodes = content.querySelectorAll(FOCUSABLE);
    for (var i = 0; i < nodes.length; i++) {
      if (visible(nodes[i])) return nodes[i];
    }
    return null;
  }

  function center(el) {
    var rect = el.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }

  function paint(el) {
    if (current === el) return;
    var previous = current;
    if (previous) previous.classList.remove('tv-focus');
    current = el;
    if (current) current.classList.add('tv-focus');
    // 自己改 class 也会触发 MutationObserver：只屏蔽这一次对这两个节点的记录，
    // 不整体静音 —— 否则同一批里弹层开合的记录会被一起吞掉。
    paintGuard.el = current;
    paintGuard.prev = previous;
    paintGuard.until = Date.now() + 120;
  }

  function focus(el, scroll) {
    if (!el) return;
    paint(el);
    if (scroll !== false) {
      try { el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' }); }
      catch (error) { try { el.scrollIntoView(); } catch (ignored) { } }
    }
  }

  function ensureInitial() {
    var el = contentFirst();
    if (!el) {
      var list = collect();
      el = list.length ? list[0] : null;
    }
    if (el) focus(el, false);
    return el;
  }

  function ensure() {
    if (current && document.contains(current) && visible(current) && collect().indexOf(current) >= 0) return current;
    return ensureInitial() || current;
  }

  /** 作用域切换（进/出弹层）时把焦点带过去，回来时还原到原来的卡片。 */
  function applyScope(next) {
    if (next === lastScope) return;
    if (next) {
      stash = current;
    } else if (stash && document.contains(stash) && visible(stash)) {
      lastScope = next;
      focus(stash, false);
      stash = null;
      return;
    }
    lastScope = next;
    var list = collect();
    if (list.length) focus(list[0], false);
  }

  /** 跨区（内容区 ↔ 底栏 ↔ 顶栏）要额外加代价：不然按「下」时底栏离得近，会抢在下一行卡片前面。 */
  function regionOf(el) {
    if (!el) return 'other';
    var content = document.getElementById('content');
    if (content && content.contains(el)) return 'content';
    if (el.closest('#dock')) return 'dock';
    if (el.closest('.app-top')) return 'topbar';
    return 'other';
  }

  function move(direction) {
    var list = collect();
    if (!list.length) return;
    if (!current || list.indexOf(current) < 0 || !document.contains(current)) {
      focus(list[0]);
      return;
    }
    var origin = center(current);
    var originRegion = regionOf(current);
    var horizontal = direction === 'left' || direction === 'right';
    var best = null;
    var bestScore = Infinity;
    for (var i = 0; i < list.length; i++) {
      var candidate = list[i];
      if (candidate === current) continue;
      var point = center(candidate);
      var dx = point.x - origin.x;
      var dy = point.y - origin.y;
      var primary = horizontal ? dx : dy;
      var secondary = horizontal ? dy : dx;
      // 必须在目标方向上（留 8px 容差，避免同一行因小数差异被判到反方向）
      if (horizontal ? (direction === 'right' ? dx <= 8 : dx >= -8) : (direction === 'down' ? dy <= 8 : dy >= -8)) continue;
      primary = Math.abs(primary);
      secondary = Math.abs(secondary);
      // 偏得太厉害说明不在同一行/列（比如斜上方的卡片），跳过
      if (secondary > primary * 2.6 + 48) continue;
      var score = primary + secondary * 2.2;
      if (regionOf(candidate) !== originRegion) score *= 2.6;
      if (score < bestScore) { bestScore = score; best = candidate; }
    }
    if (best) focus(best);
  }

  function activate() {
    var el = ensure();
    if (!el) return;
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      // 电视上打字靠扫码输入，直接把面板叫出来；面板里有「改用本机键盘」的出口
      if (typeof window.veyraRelayOpen === 'function') { window.veyraRelayOpen(el); return; }
    }
    try { el.click(); } catch (error) { }
  }

  function handle(code) {
    applyScope(scope());
    if (code === KEY_UP) move('up');
    else if (code === KEY_DOWN) move('down');
    else if (code === KEY_LEFT) move('left');
    else if (code === KEY_RIGHT) move('right');
    else if (code === KEY_CENTER || code === KEY_ENTER || code === KEY_NUMPAD_ENTER) activate();
    else return false;
    return true;
  }

  window.veyraTvKey = function (code) {
    return handle(Number(code));
  };

  // 浏览器调试路径（原生拦截时这些事件根本到不了页面）
  document.addEventListener('keydown', function (event) {
    var map = { ArrowUp: KEY_UP, ArrowDown: KEY_DOWN, ArrowLeft: KEY_LEFT, ArrowRight: KEY_RIGHT, Enter: KEY_ENTER };
    var code = map[event.key] || (event.keyCode === 13 ? KEY_ENTER : 0);
    if (!code) return;
    if (event.target && (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA')) return;
    if (handle(code)) event.preventDefault();
  }, true);

  /** 页面重渲染后焦点可能指向已移除的节点：等一帧再补一个，别在渲染中途抢焦点。 */
  function scheduleReset(delay) {
    clearTimeout(resetTimer);
    resetTimer = setTimeout(function () {
      if (current && document.contains(current) && visible(current)) return;
      ensureInitial();
    }, delay || 120);
  }

  if (window.MutationObserver) {
    new window.MutationObserver(function (records) {
      var structural = false;
      var now = Date.now();
      for (var i = 0; i < records.length; i++) {
        var record = records[i];
        if (record.type === 'attributes' && record.attributeName === 'class' && now < paintGuard.until
            && (record.target === paintGuard.el || record.target === paintGuard.prev)) {
          continue; // 焦点环自身的 class 增删
        }
        structural = true;
        break;
      }
      if (!structural) return;
      applyScope(scope());
      if (!current || !document.contains(current) || !visible(current)) scheduleReset(90);
    }).observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['hidden', 'class']
    });
  }

  // 路由变化（首页 → 分类 → 详情 → 我的）时把焦点放到新页面的第一个可点元素
  var app = document.getElementById('app');
  if (app) {
    new window.MutationObserver(function () {
      var route = app.getAttribute('data-route') || '';
      if (route === lastRoute) return;
      lastRoute = route;
      lastScope = null;
      stash = null;
      scheduleReset(280);
    }).observe(app, { attributes: true, attributeFilter: ['data-route'] });
  }

  window.addEventListener('load', function () { scheduleReset(400); });
  document.addEventListener('veyra-relay-close', function () { scheduleReset(90); });
  scheduleReset(600);
})();
