'use strict';
/* ===================================================================
   Veyra 电视端
   独立实现，不复用 app.js：那套里 60% 是手势、玻璃、转场、下载、主题，
   电视上一个都用不上，还会拖帧。这里只有四件事：
     1) 用遥控器走焦点（几何找最近邻，不依赖 DOM 顺序）
     2) 渲染四个页面：首页 / 剧场 / 搜索 / 我的
     3) 详情页 + 起播
     4) 未登录时显示手机扫码二维码

   兼容目标是 Android 8 的 WebView（Chrome 61）：不用可选链、不用 ??、
   不用 replaceChildren，需要的 polyfill 在 tv-polyfill.js。
   =================================================================== */

window.__veyraBooted = true;

/* ---------------- 桥 ---------------- */
const callbacks = new Map();
let requestNumber = 0;
const bridgeInstance = Date.now() + '-' + Math.random().toString(36).slice(2);
window.NativeCallbacks = {
  resolve: function (id, value) { const slot = callbacks.get(id); if (slot) { slot.resolve(value); callbacks.delete(id); } },
  reject: function (id, message) { const slot = callbacks.get(id); if (slot) { slot.reject(new Error(message)); callbacks.delete(id); } }
};
function api(action, args) {
  const payload = args || {};
  return new Promise(function (resolve, reject) {
    const id = bridgeInstance + ':' + (++requestNumber);
    callbacks.set(id, { resolve: resolve, reject: reject });
    try {
      payload.source = 'hongguo';
      window.AndroidHost.request(id, action, JSON.stringify(payload));
    } catch (error) {
      callbacks.delete(id);
      reject(error);
    }
  });
}

/* ---------------- 状态 ---------------- */
const state = {
  route: 'home',
  home: null,
  detail: null,
  detailLoading: false,
  category: null,
  categoryId: '',
  search: { query: '', items: null, pending: false },
  library: null,
  libraryTab: 'history',
  account: { loggedIn: false },
  focusKey: '',
  lastRailKey: 'nav:home'
};

const view = document.getElementById('view');
const stage = document.getElementById('stage');
const loginLayer = document.getElementById('login');
const toastEl = document.getElementById('toast');
const railAccount = document.getElementById('rail-account');
const CHIPS = [
  ['short:romance', '爱情'], ['short:period', '年代'], ['short:comeback', '逆袭'], ['short:suspense', '悬疑'],
  ['comic:creative', '脑洞'], ['comic:fantasy', '玄幻'], ['comic:apocalypse', '末世'], ['comic:adventure', '冒险']
];

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function list(value) { return Array.isArray(value) ? value : []; }

let toastTimer = 0;
function toast(message, isError) {
  if (!toastEl) return;
  toastEl.textContent = message || '';
  toastEl.className = 'show';
  if (isError) toastEl.style.color = '#ffb4a8';
  else toastEl.style.removeProperty('color');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { toastEl.className = ''; }, 2400);
}

/* ---------------- 封面：走原生桥，避免直接命中防盗链 ---------------- */
const coverCache = new Map();
function cover(url) {
  if (!url) return Promise.resolve('');
  if (coverCache.has(url)) return coverCache.get(url);
  const job = api('cover', { url: url }).catch(function () { coverCache.delete(url); return ''; });
  coverCache.set(url, job);
  if (coverCache.size > 120) coverCache.delete(coverCache.keys().next().value);
  return job;
}
function paintCovers(root) {
  const nodes = root.querySelectorAll('img[data-cover]');
  for (let i = 0; i < nodes.length; i++) {
    (function (node) {
      const url = node.getAttribute('data-cover');
      if (!url) return;
      cover(url).then(function (src) {
        if (src && node.parentNode) node.src = src;
      }).catch(function () { });
    })(nodes[i]);
  }
}

/* ---------------- 焦点 ---------------- */
function focusables() {
  // 登录层盖着时只让焦点在层里转，别跑到背后的卡片上
  const scope = loginLayer.hidden ? document : loginLayer;
  const nodes = scope.querySelectorAll('[data-focusable]');
  const list = [];
  for (let i = 0; i < nodes.length; i++) {
    const el = nodes[i];
    if (el.hidden || el.disabled) continue;
    const box = el.getBoundingClientRect();
    if (box.width < 2 || box.height < 2) continue;
    list.push(el);
  }
  return list;
}
function focusElement(el, remember) {
  if (!el) return;
  const current = document.querySelector('.is-focused');
  if (current && current !== el) current.classList.remove('is-focused');
  el.classList.add('is-focused');
  try { el.focus({ preventScroll: true }); } catch (error) { el.focus(); }
  if (remember !== false && el.dataset) {
    state.focusKey = el.dataset.key || '';
    if (isRail(el)) state.lastRailKey = state.focusKey;
  }
  // 只滚最近的边，别把整页甩到中间 —— 电视上一格一格走才不晕
  const box = el.getBoundingClientRect();
  const stageBox = stage.getBoundingClientRect();
  if (box.top < stageBox.top + 8) stage.scrollTop -= (stageBox.top + 8 - box.top);
  else if (box.bottom > stageBox.bottom - 40) stage.scrollTop += (box.bottom - (stageBox.bottom - 40));
}
function isRail(el) {
  const rail = document.getElementById('rail');
  return !!(rail && el && el.closest && el.closest('#rail') === rail);
}
function railItems() {
  return Array.prototype.slice.call(document.querySelectorAll('#rail [data-focusable]'));
}
function restoreFocus() {
  const all = focusables();
  if (!all.length) return;
  let target = null;
  if (state.focusKey) {
    for (let i = 0; i < all.length; i++) {
      if (all[i].dataset.key === state.focusKey) { target = all[i]; break; }
    }
  }
  focusElement(target || all[0], false);
}
function move(direction) {
  const all = focusables();
  if (!all.length) return;
  let current = document.querySelector('.is-focused');
  if (!current || all.indexOf(current) < 0) { focusElement(all[0]); return; }

  const inRail = isRail(current);
  const from = current.getBoundingClientRect();
  const cx = (from.left + from.right) / 2;
  const cy = (from.top + from.bottom) / 2;

  // 第一步：只在同一区域（导航 / 内容）里找。跨区域只在没有同区目标时发生，
  // 这样「内容区最左列按左 → 回导航栏」不会因为某个导航项更近而被抢走。
  let best = null;
  let bestScore = Infinity;
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    if (el === current || isRail(el) !== inRail) continue;
    const box = el.getBoundingClientRect();
    const ex = (box.left + box.right) / 2;
    const ey = (box.top + box.bottom) / 2;
    const dx = ex - cx;
    const dy = ey - cy;
    let primary;
    let secondary;
    if (direction === 'left') { if (dx > -4) continue; primary = -dx; secondary = Math.abs(dy); }
    else if (direction === 'right') { if (dx < 4) continue; primary = dx; secondary = Math.abs(dy); }
    else if (direction === 'up') { if (dy > -4) continue; primary = -dy; secondary = Math.abs(dx); }
    else { if (dy < 4) continue; primary = dy; secondary = Math.abs(dx); }
    const score = primary + secondary * 2.4;
    if (score < bestScore) { bestScore = score; best = el; }
  }
  if (best) { focusElement(best); return; }

  // 第二步：同区没目标，跨区域
  if (!inRail) {
    const items = railItems();
    if (!items.length) return;
    let target = null;
    for (let i = 0; i < items.length; i++) {
      if (items[i].dataset.key === state.lastRailKey) { target = items[i]; break; }
    }
    if (!target) {
      for (let i = 0; i < items.length; i++) {
        if (items[i].classList.contains('is-active')) { target = items[i]; break; }
      }
    }
    focusElement(target || items[0]);
    return;
  }
  if (direction === 'right') {
    for (let i = 0; i < all.length; i++) {
      if (!isRail(all[i])) { focusElement(all[i]); return; }
    }
  }
}

/* ---------------- 页面 ---------------- */
function setActiveNav(tab) {
  const items = document.querySelectorAll('.rail-item');
  for (let i = 0; i < items.length; i++) {
    items[i].classList.toggle('is-active', items[i].dataset.nav === tab);
  }
}

function cardMarkup(item, index) {
  const key = 'card:' + (item.id || index);
  return '<button type="button" class="card" data-focusable data-key="' + esc(key) + '" data-id="' + esc(item.id) + '">'
    + '<span class="art"><img data-cover="' + esc(item.cover || '') + '" alt="">'
    + (item.score ? '<i class="badge">' + esc(item.score) + '</i>' : '')
    + '</span><span class="name">' + esc(item.title || '') + '</span></button>';
}

function gridMarkup(items) {
  if (!items.length) return '<p class="empty">这里还没有内容</p>';
  let html = '<div class="grid">';
  for (let i = 0; i < items.length; i++) html += cardMarkup(items[i], i);
  return html + '</div>';
}

function renderHome() {
  const home = state.home;
  if (!home) {
    view.innerHTML = '<h1 class="page-title">首页</h1><p class="empty">正在加载…</p>';
    return;
  }
  const recommend = list(home.homepageRecommend);
  const newest = list(home.homepageNewest);
  view.innerHTML = '<h1 class="page-title">首页</h1>'
    + '<section class="section"><div class="section-head"><h2>为你推荐</h2><span>' + recommend.length + ' 部</span></div>'
    + gridMarkup(recommend) + '</section>'
    + '<section class="section"><div class="section-head"><h2>最近上新</h2><span>' + newest.length + ' 部</span></div>'
    + gridMarkup(newest) + '</section>';
  paintCovers(view);
  restoreFocus();
}

function renderCategory() {
  let chips = '<div class="chips">';
  for (let i = 0; i < CHIPS.length; i++) {
    const active = CHIPS[i][0] === state.categoryId;
    chips += '<button type="button" class="chip' + (active ? ' is-active' : '') + '" data-focusable data-key="chip:' + esc(CHIPS[i][0]) + '" data-chip="' + esc(CHIPS[i][0]) + '">' + esc(CHIPS[i][1]) + '</button>';
  }
  chips += '</div>';
  const items = state.category ? list(state.category.items) : [];
  view.innerHTML = '<h1 class="page-title">剧场</h1>' + chips
    + (state.category ? gridMarkup(items) : '<p class="empty">正在加载…</p>');
  paintCovers(view);
  restoreFocus();
}

function renderSearch() {
  const query = state.search.query;
  const items = state.search.items;
  view.innerHTML = '<h1 class="page-title">搜索</h1>'
    + '<div class="search-box" data-focusable data-key="search-box" tabindex="0">'
    + '<input id="search-input" type="text" value="' + esc(query) + '" placeholder="输入剧名，或手机扫码输入" autocomplete="off">'
    + '</div>'
    + '<p class="search-hint">按 OK 调出键盘；也可以打开手机端「扫码输入」直接打字传过来</p>'
    + (items === null ? (query ? '<p class="empty">正在搜索…</p>' : '')
      : (items.length ? gridMarkup(items) : '<p class="empty">没有找到「' + esc(query) + '」</p>'));
  paintCovers(view);
  const input = document.getElementById('search-input');
  if (input) {
    input.addEventListener('keydown', function (event) {
      if (event.keyCode === 13) { event.preventDefault(); runSearch(input.value.trim()); }
    });
  }
  restoreFocus();
}

function renderLibrary() {
  const data = state.library || { bookmarks: [], progress: [] };
  const history = list(data.progress);
  const bookmarks = list(data.bookmarks);
  const items = state.libraryTab === 'history' ? history : bookmarks;
  view.innerHTML = '<h1 class="page-title">我的</h1>'
    + '<div class="tabs">'
    + '<button type="button" class="chip' + (state.libraryTab === 'history' ? ' is-active' : '') + '" data-focusable data-key="tab:history" data-tab="history">观看记录</button>'
    + '<button type="button" class="chip' + (state.libraryTab === 'bookmarks' ? ' is-active' : '') + '" data-focusable data-key="tab:bookmarks" data-tab="bookmarks">收藏</button>'
    + '</div>'
    + (items.length ? gridMarkup(items) : '<p class="empty">' + (state.libraryTab === 'history' ? '还没有观看记录' : '还没有收藏') + '</p>');
  paintCovers(view);
  restoreFocus();
}

function renderDetail() {
  const data = state.detail;
  if (!data) {
    view.innerHTML = '<p class="empty">正在打开…</p>';
    return;
  }
  const episodes = list(data.episodes);
  let eps = '';
  if (episodes.length) {
    eps = '<h2 style="font-size:calc(24 * var(--s));margin:0 0 calc(14 * var(--s))">选集</h2><div class="eps">';
    for (let i = 0; i < episodes.length; i++) {
      const number = episodes[i].number || (i + 1);
      eps += '<button type="button" data-focusable data-key="ep:' + number + '" data-episode="' + number + '" aria-label="第 ' + number + ' 集">' + number + '</button>';
    }
    eps += '</div>';
  }
  view.innerHTML = '<div class="detail">'
    + '<div class="detail-art"><img data-cover="' + esc(data.cover || '') + '" alt=""></div>'
    + '<div class="detail-info">'
    + '<h1>' + esc(data.title || '') + '</h1>'
    + '<p class="meta">' + esc(data.score || '') + ' ' + esc(data.episodeLabel || '') + '</p>'
    + '<p class="desc">' + esc(data.description || '') + '</p>'
    + '<div class="actions">'
    + '<button type="button" class="btn primary" data-focusable data-key="play" data-play="1"' + (state.detailLoading ? ' disabled' : '') + '>立即播放</button>'
    + '<button type="button" class="btn" data-focusable data-key="bookmark" data-bookmark="1">' + (data.bookmarked ? '已收藏' : '收藏') + '</button>'
    + '</div>' + eps + '</div></div>';
  paintCovers(view);
  restoreFocus();
}

function render() {
  if (state.route === 'home') renderHome();
  else if (state.route === 'category') renderCategory();
  else if (state.route === 'search') renderSearch();
  else if (state.route === 'library') renderLibrary();
  else if (state.route === 'detail') renderDetail();
}

/* ---------------- 数据 ---------------- */
function loadHome() {
  state.focusKey = state.focusKey || 'nav:home';
  api('home').then(function (home) {
    state.home = home;
    if (state.route === 'home') render();
  }).catch(function (error) {
    view.innerHTML = '<h1 class="page-title">首页</h1><p class="empty">加载失败：' + esc(error.message || '网络异常') + '</p>';
  });
}
function loadCategory(id) {
  state.categoryId = id || state.categoryId || CHIPS[0][0];
  state.category = null;
  state.focusKey = 'chip:' + state.categoryId;
  render();
  api('category', { id: state.categoryId, page: 1 }).then(function (data) {
    state.category = data || { items: [] };
    if (state.route === 'category') render();
  }).catch(function (error) {
    state.category = { items: [] };
    if (state.route === 'category') render();
    toast(error.message || '加载失败', true);
  });
}
function runSearch(query) {
  state.search.query = query;
  state.search.items = null;
  state.search.pending = true;
  render();
  api('search', { query: query, page: 1 }).then(function (data) {
    state.search.items = list(data && data.items);
    state.search.pending = false;
    if (state.route === 'search') render();
  }).catch(function (error) {
    state.search.items = [];
    state.search.pending = false;
    if (state.route === 'search') render();
    toast(error.message || '搜索失败', true);
  });
}
function loadLibrary() {
  api('library').then(function (data) {
    state.library = data;
    if (state.route === 'library') render();
  }).catch(function () {
    state.library = { bookmarks: [], progress: [] };
    if (state.route === 'library') render();
  });
}
function openDetail(id) {
  if (state.route !== 'detail') state.detailFrom = state.route;
  state.route = 'detail';
  state.detail = null;
  state.detailLoading = true;
  state.focusKey = 'play';
  render();
  api('detail', { id: id }).then(function (data) {
    state.detail = data;
    state.detailLoading = false;
    if (state.route === 'detail') render();
    return api('bookmark-state', { id: id });
  }).then(function (saved) {
    if (state.route === 'detail' && state.detail) { state.detail.bookmarked = !!saved; render(); }
  }).catch(function (error) {
    state.detailLoading = false;
    view.innerHTML = '<p class="empty">打开失败：' + esc(error.message || '网络异常') + '</p>';
  });
}

/* ---------------- 动作 ---------------- */
function play(item, episode) {
  const id = item && item.id;
  if (!id) return;
  const known = state.detail && String(state.detail.id) === String(id) ? state.detail : null;
  if (known) { start(known, episode); return; }
  toast('正在准备…');
  api('detail', { id: id }).then(function (data) { start(data, episode); })
    .catch(function (error) { toast(error.message || '无法播放', true); });
}
function start(detail, episode) {
  const episodes = list(detail.episodes);
  api('open-player', {
    item: detail,
    detail: detail,
    episodes: episodes,
    queue: [],
    index: 0,
    group: '',
    episode: episode || 1
  }).catch(function (error) { toast(error.message || '无法播放', true); });
}
function toggleBookmark() {
  const data = state.detail;
  if (!data || !data.id) return;
  api('bookmark', { id: data.id, saved: !data.bookmarked }).then(function () {
    data.bookmarked = !data.bookmarked;
    render();
    toast(data.bookmarked ? '已收藏' : '已取消收藏');
  }).catch(function (error) { toast(error.message || '操作失败', true); });
}

/* ---------------- 导航 ---------------- */
function go(tab) {
  if (tab === 'home') {
    state.route = 'home'; state.focusKey = 'nav:home';
    setActiveNav('home'); render(); if (!state.home) loadHome();
  } else if (tab === 'adult') {
    state.route = 'category'; state.focusKey = 'chip:' + (state.categoryId || CHIPS[0][0]);
    setActiveNav('adult'); render(); loadCategory(state.categoryId);
  } else if (tab === 'search') {
    state.route = 'search'; state.focusKey = 'search-box';
    setActiveNav('search'); render();
  } else if (tab === 'library') {
    state.route = 'library'; state.focusKey = 'tab:' + state.libraryTab;
    setActiveNav('library'); render(); loadLibrary();
  }
}

/* ---------------- 键盘 ---------------- */
window.veyraTvKey = function (code) {
  if (code === 19) move('up');
  else if (code === 20) move('down');
  else if (code === 21) move('left');
  else if (code === 22) move('right');
  else if (code === 23 || code === 66 || code === 160) {
    const current = document.querySelector('.is-focused');
    if (current) current.click();
  }
};
window.hgBack = function () {
  if (!loginLayer.hidden) { loginLayer.hidden = true; return true; }
  if (state.route === 'detail') {
    const back = state.detailFrom || 'home';
    state.route = back;
    state.focusKey = '';
    setActiveNav(back === 'search' ? 'search' : back === 'library' ? 'library' : back === 'category' ? 'adult' : 'home');
    render();
    return true;
  }
  if (state.route !== 'home') { go('home'); return true; }
  return false;
};

/* ---------------- 事件 ---------------- */
document.addEventListener('click', function (event) {
  const target = event.target;
  const nav = target.closest ? target.closest('[data-nav]') : null;
  if (nav) { go(nav.dataset.nav); return; }

  const chip = target.closest ? target.closest('[data-chip]') : null;
  if (chip) { loadCategory(chip.dataset.chip); return; }

  const tab = target.closest ? target.closest('[data-tab]') : null;
  if (tab) { state.libraryTab = tab.dataset.tab; render(); return; }

  const card = target.closest ? target.closest('[data-id]') : null;
  if (card && card.dataset.id) { openDetail(card.dataset.id); return; }

  const playButton = target.closest ? target.closest('[data-play]') : null;
  if (playButton) { play(state.detail, 1); return; }

  const bookmark = target.closest ? target.closest('[data-bookmark]') : null;
  if (bookmark) { toggleBookmark(); return; }

  const episode = target.closest ? target.closest('[data-episode]') : null;
  if (episode) { play(state.detail, Number(episode.dataset.episode)); return; }

  const retry = target.closest ? target.closest('#login-retry') : null;
  if (retry) { showLoginQr(); return; }
});

/* ---------------- 登录 ---------------- */
function setAccount(profile) {
  state.account = profile || { loggedIn: false };
  railAccount.textContent = state.account.loggedIn ? (state.account.username || '已登录') : '未登录';
}

function showLoginQr() {
  const box = document.getElementById('login-qr');
  const tip = document.getElementById('login-tip');
  const retry = document.getElementById('login-retry');
  let info = null;
  try { info = JSON.parse(window.AndroidHost.tvLoginInfo()); } catch (error) { }
  if (!info || !info.ready) {
    box.hidden = true;
    retry.hidden = false;
    tip.textContent = '局域网没起来：确认电视和手机在同一个 Wi-Fi';
    return;
  }
  try {
    const qr = window.qrcode(0, 'M');
    qr.addData(info.url);
    qr.make();
    box.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 1, scalable: true });
    box.hidden = false;
    retry.hidden = true;
    tip.textContent = '手机 Veyra → 设置 → 扫码登录电视（' + info.host + ':' + info.port + '）';
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

/* 手机「扫码输入」传过来的文字：直接填进搜索框并搜 */
window.veyraRelayFill = function (text) {
  if (state.route !== 'search') go('search');
  const input = document.getElementById('search-input');
  if (input) input.value = text || '';
  if (text) runSearch(String(text).trim());
};

/* ---------------- 启动 ---------------- */
function boot() {
  view.innerHTML = '<p class="empty">正在启动…</p>';
  api('account').then(function (profile) {
    setAccount(profile);
    if (!profile || !profile.loggedIn) {
      loginLayer.hidden = false;
      showLoginQr();
    } else {
      loadHome();
    }
  }).catch(function () {
    loginLayer.hidden = false;
    showLoginQr();
  });
  go('home');
  try { window.AndroidHost.setTvCapture(true); } catch (error) { }
}
boot();
