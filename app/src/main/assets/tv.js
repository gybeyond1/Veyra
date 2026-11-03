'use strict';
/* ===================================================================
   Veyra 电视端
   -------------------------------------------------------------------
   独立实现，不复用 app.js：那套里 60% 是手势、玻璃、转场、下载、主题，
   电视上一个都用不上，还会拖帧。这里只有四件事：
     1) 遥控器焦点（几何找最近邻，不依赖 DOM 顺序）
     2) 四个页面：首页 / 剧场 / 搜索 / 我的 + 左下角账号面板
     3) 详情（海报固定、剧集分组）+ 起播
     4) 未登录时手机扫码登录，搜索页常显扫码输入

   兼容目标：电视盒子上的老 WebView（Chrome 61 上下）。
   不用可选链、不用 ??、不用 replaceChildren / replaceAll / flat / Object.fromEntries。
   代码本身用 var/function 写，避免任何需要转译的语法。
   =================================================================== */

window.__veyraBooted = true;

/* ---------------- 桥 ---------------- */
var callbacks = new Map();
var requestNumber = 0;
var bridgeInstance = Date.now() + '-' + Math.random().toString(36).slice(2);
window.NativeCallbacks = {
  resolve: function (id, value) { var slot = callbacks.get(id); if (slot) { slot.resolve(value); callbacks.delete(id); } },
  reject: function (id, message) { var slot = callbacks.get(id); if (slot) { slot.reject(new Error(message)); callbacks.delete(id); } }
};
function api(action, args) {
  var payload = args || {};
  return new Promise(function (resolve, reject) {
    var id = bridgeInstance + ':' + (++requestNumber);
    callbacks.set(id, { resolve: resolve, reject: reject });
    try { window.AndroidHost.request(id, action, JSON.stringify(payload)); }
    catch (error) { callbacks.delete(id); reject(error); }
  });
}

/* ---------------- 状态 ---------------- */
var state = {
  route: 'home',
  source: 'hongguo',
  unlocked: false,
  home: null,
  homeError: '',
  category: null,       /* { id, items, nextPage, loading } */
  categoryId: '',
  search: { query: '', items: null, filter: 'all', pending: false },
  library: null,
  libraryTab: 'history',
  detail: null,
  detailFrom: 'home',
  detailLoading: false,
  epGroup: 0,           /* 剧集分组：每 20 集一组 */
  account: { loggedIn: false },
  version: '',
  update: null,         /* 检查更新查到的可更新版本 */
  focusKey: '',
  lastRailKey: 'nav:home'
};

var EP_PAGE = 20;

var view = document.getElementById('view');
var stage = document.getElementById('stage');
var loginLayer = document.getElementById('login');
var accountPanel = document.getElementById('account');
var updateLayer = document.getElementById('tv-update');
var toastEl = document.getElementById('toast');
var railAccount = document.getElementById('rail-account');
var railWho = document.getElementById('rail-who');

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function list(value) { return Object.prototype.toString.call(value) === '[object Array]' ? value : []; }

var toastTimer = 0;
function toast(message, isError) {
  if (!toastEl) return;
  toastEl.textContent = message || '';
  toastEl.className = 'show';
  toastEl.style.color = isError ? '#ffb4a8' : '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { toastEl.className = ''; }, 2400);
}

/* ---------------- 封面：走原生桥，避免直接命中防盗链 ---------------- */
var coverCache = new Map();
function cover(url) {
  if (!url) return Promise.resolve('');
  if (coverCache.has(url)) return coverCache.get(url);
  var job = api('cover', { url: url }).catch(function () { coverCache.delete(url); return ''; });
  coverCache.set(url, job);
  if (coverCache.size > 160) coverCache.delete(coverCache.keys().next().value);
  return job;
}
function paintCovers(root) {
  var nodes = root.querySelectorAll('img[data-cover]');
  for (var i = 0; i < nodes.length; i++) {
    (function (node) {
      var url = node.getAttribute('data-cover');
      if (!url) return;
      cover(url).then(function (src) { if (src && node.parentNode) node.src = src; }).catch(function () { });
    })(nodes[i]);
  }
}

/* ---------------- 焦点 ---------------- */
function inRail(el) { return !!(el && el.closest && el.closest('#rail')); }

/* 有浮层盖着时，焦点只在浮层里转，别跑到背后的卡片上 */
function activeOverlay() {
  if (updateLayer && !updateLayer.hidden) return updateLayer;
  if (loginLayer && !loginLayer.hidden) return loginLayer;
  if (accountPanel && !accountPanel.hidden) return accountPanel;
  return null;
}

function focusables() {
  var scope = activeOverlay() || document;
  var nodes = scope.querySelectorAll('[data-focusable]');
  var out = [];
  for (var i = 0; i < nodes.length; i++) {
    var el = nodes[i];
    if (el.hidden || el.disabled) continue;
    var box = el.getBoundingClientRect();
    if (box.width < 2 || box.height < 2) continue;
    out.push(el);
  }
  return out;
}

function focusElement(el, remember) {
  if (!el) return;
  var current = document.querySelector('.is-focused');
  if (current && current !== el) current.classList.remove('is-focused');
  el.classList.add('is-focused');
  try { el.focus({ preventScroll: true }); } catch (error) { try { el.focus(); } catch (e2) { } }
  if (remember !== false && el.dataset) {
    state.focusKey = el.dataset.key || '';
    if (inRail(el)) state.lastRailKey = state.focusKey;
  }
  var box = el.getBoundingClientRect();
  var stageBox = stage.getBoundingClientRect();
  if (box.top < stageBox.top + 8) stage.scrollTop -= (stageBox.top + 8 - box.top);
  else if (box.bottom > stageBox.bottom - 40) stage.scrollTop += (box.bottom - (stageBox.bottom - 40));
}

function restoreFocus() {
  var all = focusables();
  if (!all.length) return;
  var target = null;
  if (state.focusKey) {
    for (var i = 0; i < all.length; i++) {
      if (all[i].dataset.key === state.focusKey) { target = all[i]; break; }
    }
  }
  focusElement(target || all[0], false);
}

function move(direction) {
  var all = focusables();
  if (!all.length) return;
  var current = document.querySelector('.is-focused');
  if (!current || all.indexOf(current) < 0) { focusElement(all[0]); return; }

  var from = current.getBoundingClientRect();
  var cx = (from.left + from.right) / 2;
  var cy = (from.top + from.bottom) / 2;
  var best = null;
  var bestScore = Infinity;

  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    if (el === current) continue;
    var box = el.getBoundingClientRect();
    var ex = (box.left + box.right) / 2;
    var ey = (box.top + box.bottom) / 2;
    var dx = ex - cx;
    var dy = ey - cy;
    var primary;
    var secondary;
    if (direction === 'left') { if (dx > -4) continue; primary = -dx; secondary = Math.abs(dy); }
    else if (direction === 'right') { if (dx < 4) continue; primary = dx; secondary = Math.abs(dy); }
    else if (direction === 'up') { if (dy > -4) continue; primary = -dy; secondary = Math.abs(dx); }
    else { if (dy < 4) continue; primary = dy; secondary = Math.abs(dx); }
    var score = primary + secondary * 2.4;
    if (score < bestScore) { bestScore = score; best = el; }
  }
  if (best) focusElement(best);
}

/* ---------------- 卡片 ---------------- */
function cardMarkup(item, index) {
  var key = 'card:' + (item.id || index);
  return '<button type="button" class="card" data-focusable data-key="' + esc(key) + '" data-id="' + esc(item.id) + '">'
    + '<span class="art"><img data-cover="' + esc(item.cover || '') + '" alt="">'
    + (item.score ? '<i class="badge">' + esc(item.score) + '</i>' : '')
    + '</span><span class="name">' + esc(item.title || '') + '</span></button>';
}
function gridMarkup(items, emptyText) {
  if (!items.length) return '<p class="empty">' + esc(emptyText || '这里还没有内容') + '</p>';
  var html = '<div class="grid">';
  for (var i = 0; i < items.length; i++) html += cardMarkup(items[i], i);
  return html + '</div>';
}

/* ---------------- 分类：和安卓端一致，按内容源取真实分类 id ---------------- */
function categoryList() {
  if (state.source === 'huangguo') {
    return [['ai-duanju', '成人短剧'], ['ai-manju', '成人漫剧'], ['ai-huanlian', 'AI换脸'], ['ai-mogai', 'AI魔改']];
  }
  return [['short', '短剧'], ['comic', '漫剧']];
}
function filterList() {
  if (state.source === 'huangguo') {
    return [['all', '全部'], ['ai-duanju', '成人短剧'], ['ai-manju', '成人漫剧'], ['ai-huanlian', 'AI换脸'], ['ai-mogai', 'AI魔改']];
  }
  return [['all', '全部'], ['short', '短剧'], ['comic', '漫剧']];
}

/* ---------------- 首页 ---------------- */
function renderHome() {
  if (state.homeError) {
    view.innerHTML = '<h1 class="page-title">首页</h1><p class="empty">加载失败：' + esc(state.homeError) + '</p>';
    return;
  }
  if (!state.home) {
    view.innerHTML = '<h1 class="page-title">首页</h1><p class="empty">正在加载…</p>';
    return;
  }
  var home = state.home;
  /* 和安卓端同样的兜底顺序：homepageRecommend 空了就用 recommend.items */
  var recommend = list(home.homepageRecommend);
  if (!recommend.length) recommend = list(home.recommend && home.recommend.items);
  var newest = list(home.homepageNewest);
  if (!newest.length) newest = list(home.newest && home.newest.items);
  var browsing = list(state.library && state.library.progress);

  var html = '<h1 class="page-title">首页</h1>';
  if (browsing.length) {
    html += '<section class="section"><div class="section-head"><h2>继续观看</h2><span>' + browsing.length + ' 部</span></div>'
      + gridMarkup(browsing.slice(0, 6)) + '</section>';
  }
  html += '<section class="section"><div class="section-head"><h2>为你推荐</h2><span>' + recommend.length + ' 部</span></div>'
    + gridMarkup(recommend, '推荐列表是空的') + '</section>'
    + '<section class="section"><div class="section-head"><h2>' + (state.source === 'huangguo' ? '最近上新' : '热门短剧') + '</h2><span>' + newest.length + ' 部</span></div>'
    + gridMarkup(newest, '暂时没有新内容') + '</section>';
  view.innerHTML = html;
  paintCovers(view);
  restoreFocus();
}

/* ---------------- 剧场 ---------------- */
function renderCategory() {
  var cats = categoryList();
  var chips = '<div class="chips">';
  for (var i = 0; i < cats.length; i++) {
    var active = cats[i][0] === state.categoryId;
    chips += '<button type="button" class="chip' + (active ? ' is-active' : '') + '" data-focusable data-key="chip:' + esc(cats[i][0]) + '" data-chip="' + esc(cats[i][0]) + '">' + esc(cats[i][1]) + '</button>';
  }
  chips += '</div>';

  var items = state.category ? list(state.category.items) : [];
  var body;
  if (!state.category) body = '<p class="empty">正在加载…</p>';
  else body = gridMarkup(items, '这个分类下暂时没有内容');

  view.innerHTML = '<h1 class="page-title">剧场</h1>' + chips + body;
  paintCovers(view);
  restoreFocus();
  observeStageEnd();
}

function loadCategory(id, append) {
  state.categoryId = id || state.categoryId || categoryList()[0][0];
  if (!append) {
    state.category = null;
    state.focusKey = 'chip:' + state.categoryId;
    renderCategory();
  } else if (state.category) {
    state.category.loading = true;
  }
  var pageNo = append && state.category ? (state.category.nextPage || 2) : 1;
  api('category', { id: state.categoryId, page: pageNo }).then(function (data) {
    if (state.route !== 'category') return;
    var incoming = list(data && data.items);
    if (append && state.category) {
      state.category.items = state.category.items.concat(incoming);
      state.category.nextPage = data && data.nextPage ? data.nextPage : null;
      state.category.loading = false;
      renderCategory();
    } else {
      state.category = { id: state.categoryId, items: incoming, nextPage: (data && data.nextPage) || null, loading: false };
      renderCategory();
    }
  }).catch(function (error) {
    if (state.route !== 'category') return;
    if (append && state.category) { state.category.loading = false; return; }
    state.category = { id: state.categoryId, items: [], nextPage: null, loading: false };
    renderCategory();
    toast(error.message || '加载失败', true);
  });
}

function observeStageEnd() {
  /* 滚到底自动续一页，电视上不用点“加载更多” */
  stage.onscroll = function () {
    if (state.route !== 'category' || !state.category || state.category.loading || !state.category.nextPage) return;
    if (stage.scrollTop + stage.clientHeight >= stage.scrollHeight - 400) loadCategory(state.categoryId, true);
  };
}

/* ---------------- 搜索（对齐安卓端：同样的过滤与系列合并） ---------------- */
function seriesGroups(items) {
  var groups = {};
  var order = [];
  var singles = [];
  for (var i = 0; i < items.length; i++) {
    var aid = items[i].albumId;
    if (aid && String(aid) !== '0') {
      if (!groups[aid]) { groups[aid] = []; order.push(aid); }
      groups[aid].push(items[i]);
    } else singles.push(items[i]);
  }
  var blocks = [];
  for (var j = 0; j < order.length; j++) {
    var members = groups[order[j]].slice();
    members.sort(function (a, b) {
      var sa = Number(a.seasonIndex) > 0 ? Number(a.seasonIndex) : 99;
      var sb = Number(b.seasonIndex) > 0 ? Number(b.seasonIndex) : 99;
      return sa - sb;
    });
    var lead = members[0];
    for (var k = 0; k < members.length; k++) { if (Number(members[k].seasonIndex) === 1) { lead = members[k]; break; } }
    blocks.push({ id: order[j], title: (lead && lead.title) || '系列', seasons: members });
  }
  return { blocks: blocks, singles: singles };
}

function filteredSearchItems() {
  var all = list(state.search.items);
  if (state.search.filter === 'all') return all;
  var out = [];
  for (var i = 0; i < all.length; i++) {
    var item = all[i];
    if (item.category) { if (item.category === state.search.filter) out.push(item); continue; }
    var title = String(item.title || '');
    var hit;
    if (state.search.filter === 'ai-huanlian') hit = /AI\s*换脸/.test(title);
    else if (state.search.filter === 'ai-mogai') hit = /AI\s*魔改/.test(title);
    else if (state.search.filter === 'ai-manju') hit = /漫剧/.test(title);
    else hit = !/AI\s*(换脸|魔改)|漫剧/.test(title);
    if (hit) out.push(item);
  }
  return out;
}

/* 扫码输入二维码：电视打字太难受，直接常显在搜索框旁边 */
var qrCache = { url: '', html: '' };
function searchQrMarkup() {
  var info = null;
  try { info = JSON.parse(window.AndroidHost.relayInfo()); } catch (error) { }
  var url = info && info.url ? info.url : '';
  if (!url) {
    return '<div class="qr empty-qr">电视没连上局域网<br>手机端「扫码输入」仍可用</div>';
  }
  if (qrCache.url !== url) {
    try {
      var qr = window.qrcode(0, 'M');
      qr.addData(url);
      qr.make();
      qrCache = { url: url, html: qr.createSvgTag({ cellSize: 4, margin: 1, scalable: true }) };
    } catch (error) {
      return '<div class="qr empty-qr">二维码生成失败</div>';
    }
  }
  return '<div class="qr">' + qrCache.html + '</div>'
    + '<p class="cap">手机扫码 → 输入剧名<br>文字直接推到电视搜索</p>';
}

function renderSearch() {
  var filters = filterList();
  var query = state.search.query;
  var items = filteredSearchItems();
  var loading = state.search.items === null;

  var html = '<h1 class="page-title">搜索</h1>'
    + '<div class="search-head">'
    + '<div class="search-main">'
    + '<div class="search-box" data-focusable data-key="search-box" tabindex="0">'
    + '<input id="search-input" type="text" value="' + esc(query) + '" placeholder="输入剧名，或手机扫码输入" autocomplete="off">'
    + '</div>'
    + '<p class="search-hint">按 OK 调出键盘；也可以扫右边的二维码，用手机把字推过来</p>'
    + '</div>'
    + '<div class="search-qr">' + searchQrMarkup() + '</div>'
    + '</div>';

  if (query) {
    var chips = '<div class="chips">';
    for (var i = 0; i < filters.length; i++) {
      var active = filters[i][0] === state.search.filter;
      chips += '<button type="button" class="chip' + (active ? ' is-active' : '') + '" data-focusable data-key="filter:' + esc(filters[i][0]) + '" data-filter="' + esc(filters[i][0]) + '">' + esc(filters[i][1]) + '</button>';
    }
    chips += '</div>';
    html += chips;
  }
  if (loading && query) html += '<p class="empty">正在搜索「' + esc(query) + '」…</p>';
  else if (!query) html += '<p class="empty">输入关键词开始搜索</p>';
  else if (!items.length) html += '<p class="empty">没有找到「' + esc(query) + '」</p>';
  else {
    html += '<p class="search-count">' + esc(query) + ' · ' + items.length + ' 部作品</p>';
    var grouped = seriesGroups(items);
    if (grouped.blocks.length) {
      for (var b = 0; b < grouped.blocks.length; b++) {
        var block = grouped.blocks[b];
        html += '<section class="section"><div class="section-head"><h2>' + esc(block.title) + '</h2><span>官方系列 · ' + block.seasons.length + ' 季</span></div>'
          + gridMarkup(block.seasons) + '</section>';
      }
    }
    if (grouped.singles.length) html += gridMarkup(grouped.singles, '没有找到匹配的影片');
  }
  view.innerHTML = html;
  paintCovers(view);

  var input = document.getElementById('search-input');
  if (input) {
    input.onkeydown = function (event) {
      if (event.keyCode === 13) { event.preventDefault(); runSearch(input.value.trim()); }
    };
    input.onblur = function () {
      try { window.AndroidHost.setTvCapture(true); } catch (error) { }
    };
  }
  restoreFocus();
}

function runSearch(query) {
  if (!query) { toast('先输入剧名'); return; }
  state.search.query = query;
  state.search.items = null;
  state.search.filter = 'all';
  renderSearch();
  api('search', { query: query }).then(function (data) {
    if (state.search.query !== query) return;
    state.search.items = list(data && data.items);
    if (state.route === 'search') renderSearch();
  }).catch(function (error) {
    if (state.search.query !== query) return;
    state.search.items = [];
    if (state.route === 'search') renderSearch();
    toast(error.message || '搜索失败', true);
  });
}

/* ---------------- 我的 ---------------- */
function renderLibrary() {
  var data = state.library || { bookmarks: [], progress: [] };
  var history = list(data.progress);
  var bookmarks = list(data.bookmarks);
  var items = state.libraryTab === 'history' ? history : bookmarks;
  view.innerHTML = '<h1 class="page-title">我的</h1>'
    + '<div class="tabs">'
    + '<button type="button" class="chip' + (state.libraryTab === 'history' ? ' is-active' : '') + '" data-focusable data-key="tab:history" data-tab="history">观看记录</button>'
    + '<button type="button" class="chip' + (state.libraryTab === 'bookmarks' ? ' is-active' : '') + '" data-focusable data-key="tab:bookmarks" data-tab="bookmarks">收藏</button>'
    + '</div>'
    + gridMarkup(items, state.libraryTab === 'history' ? '还没有观看记录' : '还没有收藏');
  paintCovers(view);
  restoreFocus();
}

/* ---------------- 详情 ---------------- */
function renderDetail() {
  if (!state.detail) {
    view.innerHTML = '<p class="empty">正在打开…</p>';
    return;
  }
  var data = state.detail;
  var episodes = list(data.episodes);
  var total = episodes.length;

  var groups = total ? Math.ceil(total / EP_PAGE) : 0;
  var gi = state.epGroup || 0;
  if (gi > groups - 1) gi = groups - 1;
  if (gi < 0) gi = 0;
  state.epGroup = gi;
  var start = gi * EP_PAGE;
  var end = Math.min(total, start + EP_PAGE);

  var eps = '';
  if (total) {
    var groupHtml = '';
    if (groups > 1) {
      groupHtml = '<div class="ep-groups"><div class="chips">';
      for (var g = 0; g < groups; g++) {
        var from = g * EP_PAGE + 1;
        var to = Math.min(total, (g + 1) * EP_PAGE);
        groupHtml += '<button type="button" class="chip' + (g === gi ? ' is-active' : '') + '" data-focusable data-key="epg:' + g + '" data-epgroup="' + g + '">' + from + '-' + to + '</button>';
      }
      groupHtml += '</div></div>';
    }
    eps = '<h2 class="eps-title">选集<span>' + (start + 1) + '-' + end + ' / 共 ' + total + ' 集</span></h2>'
      + groupHtml + '<div class="eps">';
    for (var i = start; i < end; i++) {
      var number = episodes[i].number || (i + 1);
      eps += '<button type="button" data-focusable data-key="ep:' + number + '" data-episode="' + number + '">' + number + '</button>';
    }
    eps += '</div>';
  }

  view.innerHTML = '<div class="detail">'
    + '<div class="detail-art"><img data-cover="' + esc(data.cover || '') + '" alt=""></div>'
    + '<div class="detail-info">'
    + '<h1>' + esc(data.title || '') + '</h1>'
    + '<p class="meta">' + esc(data.score || '') + '　' + esc(data.episodeLabel || '') + '</p>'
    + '<p class="desc">' + esc(data.description || '') + '</p>'
    + '<div class="actions">'
    + '<button type="button" class="btn primary" data-focusable data-key="play" data-play="1"' + (state.detailLoading ? ' disabled' : '') + '>' + (state.detailLoading ? '正在加载…' : '立即播放') + '</button>'
    + '<button type="button" class="btn" data-focusable data-key="bookmark" data-bookmark="1">' + (data.bookmarked ? '已收藏' : '收藏') + '</button>'
    + '</div>' + eps + '</div></div>';
  paintCovers(view);
  restoreFocus();
}

function openDetail(id) {
  if (id == null) return;
  if (state.route !== 'detail') state.detailFrom = state.route;
  state.route = 'detail';
  state.detail = null;
  state.detailLoading = true;
  state.epGroup = 0;
  state.focusKey = 'play';
  stage.scrollTop = 0;
  renderDetail();
  api('detail', { id: String(id) }).then(function (data) {
    if (state.route !== 'detail') return;
    state.detail = data;
    state.detailLoading = false;
    renderDetail();
    return api('bookmark-state', { id: String(id) }).catch(function () { return false; });
  }).then(function (saved) {
    if (state.route === 'detail' && state.detail) {
      state.detail.bookmarked = !!saved;
      renderDetail();
    }
  }).catch(function (error) {
    state.detailLoading = false;
    view.innerHTML = '<p class="empty">打开失败：' + esc(error.message || '网络异常') + '</p>';
  });
}

/* ---------------- 动作 ---------------- */
function play(detail, episode) {
  if (!detail || !detail.id) return;
  var episodes = list(detail.episodes);
  var item = { id: detail.id, title: detail.title, cover: detail.cover };
  api('open-player', {
    item: item,
    detail: detail,
    episodes: episodes,
    queue: [item],
    index: 0,
    group: '',
    episode: episode || 1
  }).catch(function (error) { toast(error.message || '无法播放', true); });
}
function toggleBookmark() {
  var data = state.detail;
  if (!data || !data.id) return;
  var next = !data.bookmarked;
  api('bookmark', { id: String(data.id), saved: next }).then(function () {
    data.bookmarked = next;
    renderDetail();
    toast(next ? '已收藏' : '已取消收藏');
  }).catch(function (error) { toast(error.message || '操作失败', true); });
}

/* ---------------- 路由 ---------------- */
function setActiveNav(tab) {
  var items = document.querySelectorAll('.rail-item');
  for (var i = 0; i < items.length; i++) {
    items[i].classList.toggle('is-active', items[i].dataset.nav === tab);
  }
}

function go(tab) {
  stage.scrollTop = 0;
  if (tab === 'home') {
    state.route = 'home';
    state.focusKey = 'nav:home';
    setActiveNav('home'); renderHome();
    if (!state.home && !state.homeError) loadHome();
  } else if (tab === 'adult') {
    state.route = 'category';
    setActiveNav('adult');
    if (!state.category || state.category.id !== (state.categoryId || categoryList()[0][0])) loadCategory(state.categoryId || categoryList()[0][0], false);
    else { state.focusKey = state.focusKey || 'chip:' + state.categoryId; renderCategory(); }
  } else if (tab === 'search') {
    state.route = 'search';
    state.focusKey = 'search-box';
    setActiveNav('search'); renderSearch();
  } else if (tab === 'library') {
    state.route = 'library';
    state.focusKey = 'tab:' + state.libraryTab;
    setActiveNav('library'); renderLibrary();
    loadLibrary();
  }
}

function loadHome() {
  state.homeError = '';
  api('home').then(function (home) {
    state.home = home || {};
    if (state.route === 'home') renderHome();
  }).catch(function (error) {
    state.homeError = error.message || '网络异常';
    if (state.route === 'home') renderHome();
  });
}
function loadLibrary() {
  api('library').then(function (data) {
    state.library = data || { bookmarks: [], progress: [] };
    if (state.route === 'library' || state.route === 'home') renderHomeOr();
  }).catch(function () {
    state.library = { bookmarks: [], progress: [] };
  });
}
function renderHomeOr() {
  if (state.route === 'library') renderLibrary();
  else if (state.route === 'home') renderHome();
}

/* ---------------- 遥控器 ---------------- */
window.veyraTvKey = function (code) {
  var focused = document.querySelector('.is-focused');
  var typing = document.activeElement && document.activeElement.tagName === 'INPUT';
  if (typing) return;   /* 输入中把按键交还给系统 IME */

  if (code === 19) move('up');
  else if (code === 20) move('down');
  else if (code === 21) move('left');
  else if (code === 22) move('right');
  else if (code === 23 || code === 66 || code === 160) {
    if (focused) {
      /* 搜索框：OK 进输入态，把方向键交还给系统，否则软键盘里没法选字 */
      if (focused.classList.contains('search-box')) {
        var input = document.getElementById('search-input');
        if (input) {
          try { window.AndroidHost.setTvCapture(false); } catch (error) { }
          input.focus();
          return;
        }
      }
      focused.click();
    }
  }
};

window.hgBack = function () {
  if (updateLayer && !updateLayer.hidden) { closeUpdatePanel(); return true; }
  /* 没登录就停在登录页：返回交给原生弹退出确认，不能靠返回键绕过去 */
  if (!loginLayer.hidden) return false;
  if (accountPanel && !accountPanel.hidden) { accountPanel.hidden = true; state.focusKey = 'nav:account'; restoreFocus(); return true; }
  var active = document.activeElement;
  if (active && active.tagName === 'INPUT') {
    active.blur();
    try { window.AndroidHost.setTvCapture(true); } catch (error) { }
    return true;
  }
  if (state.route === 'detail') {
    var back = state.detailFrom || 'home';
    state.route = back;
    state.focusKey = '';
    go(back === 'search' ? 'search' : back === 'library' ? 'library' : back === 'category' ? 'adult' : 'home');
    return true;
  }
  if (state.route !== 'home') { go('home'); return true; }
  return false;
};

/* ---------------- 事件 ---------------- */
document.addEventListener('click', function (event) {
  var target = event.target;
  if (!target || !target.closest) return;

  var nav = target.closest('[data-nav]');
  if (nav) { go(nav.dataset.nav); return; }

  var chip = target.closest('[data-chip]');
  if (chip) { loadCategory(chip.dataset.chip, false); return; }

  var epGroup = target.closest('[data-epgroup]');
  if (epGroup) {
    var gi = Number(epGroup.dataset.epgroup) || 0;
    state.epGroup = gi;
    var eps = list(state.detail && state.detail.episodes);
    var first = eps[gi * EP_PAGE];
    state.focusKey = first ? 'ep:' + (first.number || (gi * EP_PAGE + 1)) : 'epg:' + gi;
    renderDetail();
    return;
  }

  var filter = target.closest('[data-filter]');
  if (filter) {
    state.search.filter = filter.dataset.filter;
    state.focusKey = 'filter:' + state.search.filter;
    renderSearch();
    return;
  }

  var tab = target.closest('[data-tab]');
  if (tab) { state.libraryTab = tab.dataset.tab; state.focusKey = 'tab:' + state.libraryTab; renderLibrary(); return; }

  var playButton = target.closest('[data-play]');
  if (playButton) { play(state.detail, 1); return; }

  var bookmark = target.closest('[data-bookmark]');
  if (bookmark) { toggleBookmark(); return; }

  var episode = target.closest('[data-episode]');
  if (episode) { play(state.detail, Number(episode.dataset.episode)); return; }

  if (target.closest('[data-account]')) { openAccount(); return; }
  if (target.closest('#account-close')) { closeAccount(); return; }
  if (target.closest('#account-mode')) { switchMode(); return; }
  if (target.closest('#account-logout')) { logout(); return; }
  if (target.closest('#account-update')) { checkTvUpdate(); return; }
  if (target.closest('#tv-update-install')) { startTvUpdate(); return; }
  if (target.closest('#tv-update-later')) { closeUpdatePanel(); return; }

  if (target.closest('#login-retry')) { showLoginQr(); return; }

  var card = target.closest('[data-id]');
  if (card && card.dataset.id) { openDetail(card.dataset.id); return; }
});

/* ---------------- 登录 ---------------- */
function setAccount(profile) {
  state.account = profile || { loggedIn: false };
  var name = state.account.loggedIn ? (state.account.username || '已登录') : '未登录';
  if (railWho) railWho.textContent = name;
}

function showLoginQr() {
  var box = document.getElementById('login-qr');
  var tip = document.getElementById('login-tip');
  var retry = document.getElementById('login-retry');
  var info = null;
  try { info = JSON.parse(window.AndroidHost.tvLoginInfo()); } catch (error) { }
  if (!info || !info.ready) {
    box.hidden = true;
    retry.hidden = false;
    tip.textContent = '局域网没起来：确认电视和手机连在同一个 Wi-Fi，然后按 OK 重试';
    return;
  }
  try {
    var qr = window.qrcode(0, 'M');
    qr.addData(info.url);
    qr.make();
    box.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 1, scalable: true });
    box.hidden = false;
    retry.hidden = true;
    tip.textContent = '手机 Veyra → 我的 → 账号管理 → 扫码登录电视（' + info.host + ':' + info.port + '）';
  } catch (error) {
    box.hidden = true;
    retry.hidden = false;
    tip.textContent = '二维码生成失败，按 OK 重试';
  }
}

window.hgTvLogin = function (ok) {
  if (!ok) { toast('登录没成功，重新扫一次', true); showLoginQr(); return; }
  api('account').then(function (profile) {
    setAccount(profile);
    if (profile && profile.loggedIn) {
      loginLayer.hidden = true;
      toast('已登录');
      if (!state.home) loadHome();
      state.focusKey = 'nav:home';
      restoreFocus();
    }
  }).catch(function () { });
};

/* ---------------- 账号面板：退出登录 / 切换私密模式 ---------------- */
function openAccount() {
  var logged = !!(state.account && state.account.loggedIn);
  var nameEl = document.getElementById('account-name');
  var subEl = document.getElementById('account-sub');
  var logoutBtn = document.getElementById('account-logout');
  var modeBtn = document.getElementById('account-mode');

  if (nameEl) nameEl.textContent = logged ? (state.account.username || '已登录') : '未登录';
  if (subEl) {
    if (!logged) subEl.textContent = '没登录也能看，登录后可同步收藏与观看记录';
    else if (state.source === 'huangguo') subEl.textContent = '当前：私密内容';
    else subEl.textContent = '当前：公开内容';
  }
  if (logoutBtn) logoutBtn.hidden = !logged;
  var versionEl = document.getElementById('account-version');
  if (versionEl) versionEl.textContent = state.version ? ('版本 v' + state.version) : '版本 —';
  if (modeBtn) {
    modeBtn.hidden = !logged;
    if (state.source === 'huangguo') modeBtn.textContent = '返回公开内容';
    else modeBtn.textContent = state.unlocked ? '进入私密模式' : '进入私密模式（需手机端解锁）';
  }
  accountPanel.hidden = false;
  state.focusKey = logged ? 'acct:logout' : 'acct:close';
  restoreFocus();
}

function closeAccount() {
  accountPanel.hidden = true;
  state.focusKey = 'nav:account';
  restoreFocus();
}

/* ---------------- 检查更新 ----------------
   电视端不自动检查：只有「我的 → 检查更新」会去打接口。
   原生侧按渠道挑附件（电视只认名字带 tv 的包）并在下载后校验 packageName，
   所以这里不会装上手机包。 */
var updateBusy = false;

function setUpdateProgress(percent) {
  var bar = document.getElementById('tv-update-progress');
  var fill = document.getElementById('tv-update-fill');
  var label = document.getElementById('tv-update-percent');
  if (bar) bar.hidden = false;
  if (fill) fill.style.transform = 'scaleX(' + (Math.max(0, Math.min(100, percent)) / 100) + ')';
  if (label) label.textContent = percent + '%';
}

window.hgUpdateProgress = function (percent) {
  setUpdateProgress(Number(percent) || 0);
};
window.hgUpdateInstallPermissionDenied = function () {
  toast('请允许 Veyra 安装应用后再试', true);
};
window.hgUpdateInstallError = function () {
  toast('打不开系统安装程序，请用 U 盘安装', true);
};

function showUpdatePanel(result) {
  state.update = result;
  var title = document.getElementById('tv-update-title');
  var sub = document.getElementById('tv-update-sub');
  var go = document.getElementById('tv-update-install');
  var later = document.getElementById('tv-update-later');
  if (title) title.textContent = '发现新版本 v' + (result.version || '');
  if (sub) {
    var parts = ['当前 v' + (result.currentVersion || state.version || '?')];
    if (Number(result.size) > 0) parts.push('更新包 ' + Math.max(1, Math.round(Number(result.size) / 1048576)) + 'MB');
    sub.textContent = parts.join(' · ');
  }
  var notesEl = document.getElementById('tv-update-notes');
  if (notesEl) {
    var notes = String(result.notes || '').replace(/\s+/g, ' ').trim();
    if (notes.length > 140) notes = notes.slice(0, 140) + '…';
    notesEl.textContent = notes;
    notesEl.hidden = !notes;
  }
  setUpdateProgress(0);
  var bar = document.getElementById('tv-update-progress');
  if (bar) bar.hidden = true;
  if (go) { go.disabled = false; go.textContent = '立即更新'; }
  if (later) later.textContent = '稍后';
  if (accountPanel) accountPanel.hidden = true;
  updateLayer.hidden = false;
  state.focusKey = 'upd:install';
  restoreFocus();
}

function closeUpdatePanel() {
  updateLayer.hidden = true;
  if (updateBusy) {
    toast('已转入后台下载，下完会弹出安装', true);
    return;
  }
  state.focusKey = 'acct:update';
  if (accountPanel) accountPanel.hidden = false;
  restoreFocus();
}

function checkTvUpdate() {
  if (updateBusy) return;
  updateBusy = true;
  var button = document.getElementById('account-update');
  if (button) { button.disabled = true; button.textContent = '正在检查…'; }
  api('check-update', { manual: true }).then(function (result) {
    var status = result && result.status;
    if (status === 'available') showUpdatePanel(result);
    else if (status === 'current') toast('已是最新版本 v' + (result.version || state.version));
    else if (status === 'channel-missing') toast('这个版本还没发布电视版安装包，等打包后再试', true);
    else if (status === 'unpublished') toast('暂未发布更新包', true);
    else toast('没查到更新信息，稍后再试', true);
  }).catch(function (error) {
    toast((error && error.message) || '检查更新失败，请稍后重试', true);
  }).then(function () {
    updateBusy = false;
    if (button) { button.disabled = false; button.textContent = '检查更新'; }
  });
}

function startTvUpdate() {
  if (updateBusy) return;
  updateBusy = true;
  var go = document.getElementById('tv-update-install');
  var later = document.getElementById('tv-update-later');
  if (go) { go.disabled = true; go.textContent = '正在下载…'; }
  if (later) later.textContent = '后台下载';
  setUpdateProgress(0);
  api('download-update').then(function () {
    /* 原生侧下载完就直接拉起系统安装页，这里把浮层收掉别挡着 */
    updateLayer.hidden = true;
    toast('下载完成，正在打开安装程序');
    state.focusKey = 'acct:update';
    restoreFocus();
  }).catch(function (error) {
    if (go) { go.disabled = false; go.textContent = '重试下载'; }
    if (later) later.textContent = '稍后';
    toast((error && error.message) || '下载失败，请重试', true);
  }).then(function () {
    updateBusy = false;
  });
}

function applyMode(status, fallback) {
  state.source = (status && status.source) || fallback;
  if (typeof (status && status.unlocked) === 'boolean') state.unlocked = status.unlocked;
  state.home = null;
  state.category = null;
  state.library = null;
  state.detail = null;
  if (accountPanel) accountPanel.hidden = true;
  toast(state.source === 'huangguo' ? '已进入私密内容' : '已返回公开内容');
  state.route = 'home';
  state.focusKey = 'nav:home';
  setActiveNav('home');
  renderHome();
  loadHome();
}

function switchMode() {
  var leaving = state.source === 'huangguo';
  var job = leaving
    ? api('leave-private')
    : api('enter-private').then(function (result) {
      if (result && result.needsAgeConfirmation) return api('confirm-private-age');
      return result;
    });
  job.then(function (status) {
    applyMode(status, leaving ? 'hongguo' : 'huangguo');
  }).catch(function (error) {
    var message = error && error.message ? error.message : '切换失败';
    if (/动态码|验证|otp/i.test(message)) message = '私密内容需要先在手机端解锁，再回来试';
    toast(message, true);
  });
}

function logout() {
  api('logout').then(function (profile) {
    setAccount(profile);
    if (accountPanel) accountPanel.hidden = true;
    state.home = null;
    state.library = null;
    state.category = null;
    state.detail = null;
    toast('已退出登录');
    state.route = 'home';
    state.focusKey = 'nav:home';
    setActiveNav('home');
    renderHome();
    loadHome();
    loginLayer.hidden = false;
    showLoginQr();
    state.focusKey = 'login:retry';
    restoreFocus();
  }).catch(function (error) { toast(error.message || '退出失败', true); });
}

/* 手机「扫码输入」传过来的文字：直接填进搜索框并搜 */
window.veyraRelayFill = function (text) {
  if (state.route !== 'search') go('search');
  var input = document.getElementById('search-input');
  if (input) input.value = text || '';
  if (text) runSearch(String(text).trim());
};

/* ---------------- 启动 ---------------- */
function boot() {
  view.innerHTML = '<p class="empty">正在启动…</p>';
  try { window.AndroidHost.setTvCapture(true); } catch (error) { }
  if (window.__tvApplyScale) window.__tvApplyScale();
  /* 版本号：账号面板里显示，检查更新时也拿它兜底显示「当前版本」 */
  api('app-version').then(function (version) {
    state.version = String(version || '');
  }).catch(function () { });

  Promise.all([
    api('content-status').catch(function () { return null; }),
    api('account').catch(function () { return null; })
  ]).then(function (results) {
    var status = results[0];
    if (status && status.source) state.source = status.source;
    if (status && typeof status.unlocked === 'boolean') state.unlocked = status.unlocked;
    setAccount(results[1]);
    go('home');
    if (!results[1] || !results[1].loggedIn) {
      loginLayer.hidden = false;
      showLoginQr();
      state.focusKey = 'login:retry';
      restoreFocus();
    } else {
      loadLibrary();
    }
  });
}
boot();
