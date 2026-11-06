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
  /* 首页瀑布流：原「剧场」的内容整体搬到这里，滚动到底自动续页 */
  feed: null,           /* { id, items, nextPage, loading, error } */
  feedId: '',
  search: { query: '', items: null, filter: 'all', pending: false, lastQuery: '' },
  library: null,
  libraryTab: 'history',
  nas: null,            /* NAS 下载任务列表 */
  nasError: '',
  detail: null,
  detailFrom: 'home',
  detailLoading: false,
  detailProgress: null, /* 上次看到的集与位置，用来把「立即播放」改成「继续播放」 */
  epGroup: 0,           /* 剧集分组：每 20 集一组 */
  account: { loggedIn: false },
  version: '',
  update: null,         /* 检查更新查到的可更新版本 */
  focusKey: '',
  lastRailKey: 'nav:home',
  lastContentKey: '',      /* 从侧栏按右回来时，回到刚才那张卡 */
  memory: {},              /* 每个页面离开时的滚动位置与焦点：进详情再返回要回到原地 */
  pendingRestore: null     /* 数据还没回来时先存着，渲染完再定位 */
};

var EP_PAGE = 20;

var view = document.getElementById('view');
var stage = document.getElementById('stage');
var loginLayer = document.getElementById('login');
var accountPanel = document.getElementById('account');
var updateLayer = document.getElementById('tv-update');
var toastEl = document.getElementById('toast');
var railAccount = document.getElementById('rail-account');
var railAvatar = document.getElementById('rail-avatar');
var themePanel = document.getElementById('theme');
var themeGrid = document.getElementById('theme-grid');
var themeSub = document.getElementById('theme-sub');
var heroTune = document.getElementById('hero-tune');
var heroRowsEl = document.getElementById('hero-rows');
var heroPreviewImg = document.getElementById('hero-preview-img');
var heroPreviewVeil = document.getElementById('hero-preview-veil');
var railVeil = document.getElementById('rail-veil');
var otpPanel = document.getElementById('otp');
var otpCells = document.getElementById('otp-cells');
var otpKeys = document.getElementById('otp-keys');
var otpError = document.getElementById('otp-error');
var otpCode = '';
var otpBusy = false;

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

/* ---------------- 主题 ----------------
   八套固定配色。首页背景不再用海报模糊，换主题只是换 body 上的一个属性，
   CSS 变量跟着变，零图片、零滤镜 —— 遥控器连着按也不会掉帧。 */
var THEMES = [
  { key: 'clean',  name: '简洁白', color: '#FFFFFF' },
  { key: 'pink',   name: '少女粉', color: '#FF6699' },
  { key: 'dark',   name: '主题黑', color: '#17181A' },
  { key: 'red',    name: '高能红', color: '#F44336' },
  { key: 'yellow', name: '高能黄', color: '#FFC107' },
  { key: 'green',  name: '早苗绿', color: '#8BC34A' },
  { key: 'blue',   name: '宝石蓝', color: '#2196F3' },
  { key: 'purple', name: '罗兰紫', color: '#9C27B0' },
  { key: 'custom', name: '自定义', color: 'linear-gradient(135deg,#6C8CFF,#F5D782)' }
];
var THEME_STORE = 'veyra.tv.theme';

function themeExists(key) {
  for (var i = 0; i < THEMES.length; i++) if (THEMES[i].key === key) return true;
  return false;
}
function currentTheme() {
  var saved = '';
  try { saved = localStorage.getItem(THEME_STORE) || ''; } catch (error) { saved = ''; }
  return themeExists(saved) ? saved : 'dark';
}
function applyTheme(key) {
  var next = themeExists(key) ? key : 'dark';
  document.body.setAttribute('data-tv-theme', next);
  try { localStorage.setItem(THEME_STORE, next); } catch (error) { }
  /* 原生层也存一份：播放器里的退出确认框要按当前主题取强调色 */
  try { if (window.AndroidHost && window.AndroidHost.setTvTheme) window.AndroidHost.setTvTheme(next); } catch (error) { }
  /* 高性能模式要看海报、自定义模式要看自己的图，切主题时立刻决定背景走哪套 */
  applyBackdropMode();
  if (next === CUSTOM_THEME) loadCustomBg();
  if (heroBackdropOn()) syncBackdropFromFocus();
  return next;
}
/* ---------------- 自定义背景 ----------------
   一张自己的图当首页底图：手机扫码 → 局域网直传上来 → 原生缩到长边 1920 压成 JPEG
   → data URL 交回页面。图不经过后端，也不落云端，换一张就覆盖上一张。
   只在首页/搜索/我的出现，详情页仍然用当前剧的海报。 */
var CUSTOM_THEME = 'custom';
var CUSTOM_STORE = 'veyra.tv.custombg';
var CUSTOM_FIELDS = [
  { key: 'blur', label: '模糊度', unit: 'px', min: 0, max: 30, step: 1, def: 0 },
  { key: 'bri', label: '亮度', unit: '%', min: 60, max: 140, step: 2, def: 100 },
  { key: 'sat', label: '饱和度', unit: '%', min: 0, max: 200, step: 4, def: 100 },
  { key: 'veil', label: '遮罩浓度', unit: '%', min: 0, max: 100, step: 5, def: 40 }
];
var customCache = null;
var customSrc = '';       /* data URL，只在内存里留一份 */
var customLoading = false;

function customThemeOn() { return currentTheme() === CUSTOM_THEME; }
/* 详情页不套自定义图：那儿要看的是这部剧的海报。
   还没传图时也不切 —— 先让主题底色顶着，别给一块黑屏。 */
function customBgOn() { return customThemeOn() && state.route !== 'detail' && !!customSrc; }

function customParams() {
  if (customCache) return customCache;
  var out = { zoom: 104 };
  for (var i = 0; i < CUSTOM_FIELDS.length; i++) out[CUSTOM_FIELDS[i].key] = CUSTOM_FIELDS[i].def;
  var saved = null;
  try { saved = JSON.parse(localStorage.getItem(CUSTOM_STORE) || 'null'); } catch (error) { saved = null; }
  if (saved) {
    for (var j = 0; j < CUSTOM_FIELDS.length; j++) {
      var f = CUSTOM_FIELDS[j];
      var v = Number(saved[f.key]);
      if (isFinite(v)) out[f.key] = Math.max(f.min, Math.min(f.max, Math.round(v)));
    }
  }
  customCache = out;
  return out;
}
function saveCustom() {
  try { localStorage.setItem(CUSTOM_STORE, JSON.stringify(customParams())); } catch (error) { }
}

/* 取一次图：native 存着压缩后的 JPEG，页面每次启动只需要这一份 data URL */
function loadCustomBg() {
  if (customSrc || customLoading) return;
  customLoading = true;
  api('tv-bg-load').then(function (value) {
    customLoading = false;
    customSrc = typeof value === 'string' ? value : '';
    if (customBgOn()) applyBackdropMode();
    syncTunePreview();
  }).catch(function () { customLoading = false; });
}

/* 手机扫码换图的二维码：直接用局域网那条通道，不依赖后端 */
var bgQrCache = { url: '', html: '' };
function renderBgQr() {
  var box = document.getElementById('bg-qr');
  if (!box) return;
  var url = '';
  try { url = JSON.parse(window.AndroidHost.relayInfo()).bgUrl || ''; } catch (error) { url = ''; }
  if (!url) {
    box.className = 'bg-qr-empty';
    box.innerHTML = '电视没连上局域网<br>先用网线或 Wi-Fi 连上，再回来扫码';
    return;
  }
  if (bgQrCache.url !== url) {
    try {
      var qr = window.qrcode(0, 'M');
      qr.addData(url);
      qr.make();
      bgQrCache = { url: url, html: qr.createSvgTag({ cellSize: 3, margin: 1, scalable: true }) };
    } catch (error) {
      bgQrCache = { url: url, html: '' };
    }
  }
  if (!bgQrCache.html) {
    box.className = 'bg-qr-empty';
    box.innerHTML = '二维码生成失败，重新打开这个面板再试';
    return;
  }
  box.className = 'bg-qr';
  box.innerHTML = '<div class="code">' + bgQrCache.html + '</div>'
    + '<p class="cap"><b>手机扫码换背景</b>选一张图上传<br>换好这张图立刻生效</p>';
}

function syncTunePreview() {
  if (!heroPreviewImg) return;
  if (customThemeOn() && customSrc) { heroPreviewImg.src = customSrc; return; }
  if (customThemeOn()) { heroPreviewImg.removeAttribute('src'); return; }
  if (!heroPreviewImg.getAttribute('src') && backdropSrc) heroPreviewImg.src = backdropSrc;
}

function renderThemeGrid() {
  if (!themeGrid) return;
  var active = currentTheme();
  var html = '';
  for (var i = 0; i < THEMES.length; i++) {
    var t = THEMES[i];
    html += '<button type="button" class="theme-swatch' + (t.key === active ? ' is-active' : '') + '"'
      + ' data-theme-key="' + t.key + '" data-focusable data-key="theme:' + t.key + '">'
      + '<span class="dot" style="background:' + t.color + '"></span>'
      + '<span class="name">' + esc(t.name) + '</span>'
      + '<span class="tick">' + (t.key === active ? '✓ 使用中' : '') + '</span>'
      + '</button>';
  }
  themeGrid.innerHTML = html;
  syncHeroTune();
}

/* ---------------- 高性能模式：背景海报参数 ----------------
   之前这几个值都写死在 CSS 里（blur 3px / saturate 1.04 / 遮罩三段透明度 /
   图片放大 108%），每换一个口味就得改一次代码发一版包。现在放到面板里，
   遥控器左右键直接调，结果存 localStorage，下次开电视还在。
   参数范围都留了余地：模糊 0–20、饱和 60–180%、亮度 60–140%、
   遮罩 0–100%、放大 100–130%（放大是为了让模糊后的边缘不露黑边）。 */
var HERO_STORE = 'veyra.tv.hero';
var HERO_FIELDS = [
  { key: 'blur', label: '模糊度', unit: 'px', min: 0, max: 20, step: 1, def: 3 },
  { key: 'sat', label: '饱和度', unit: '%', min: 60, max: 180, step: 4, def: 104 },
  { key: 'bri', label: '亮度', unit: '%', min: 60, max: 140, step: 4, def: 100 },
  { key: 'veil', label: '遮罩浓度', unit: '%', min: 0, max: 100, step: 5, def: 100 },
  { key: 'zoom', label: '画面放大', unit: '%', min: 100, max: 130, step: 2, def: 108 }
];
var heroCache = null;

function heroField(key) {
  var fields = customThemeOn() ? CUSTOM_FIELDS : HERO_FIELDS;
  for (var i = 0; i < fields.length; i++) if (fields[i].key === key) return fields[i];
  return null;
}
function heroParams() {
  if (heroCache) return heroCache;
  var out = {};
  for (var i = 0; i < HERO_FIELDS.length; i++) out[HERO_FIELDS[i].key] = HERO_FIELDS[i].def;
  var saved = null;
  try { saved = JSON.parse(localStorage.getItem(HERO_STORE) || 'null'); } catch (error) { saved = null; }
  if (saved) {
    for (var j = 0; j < HERO_FIELDS.length; j++) {
      var f = HERO_FIELDS[j];
      var v = Number(saved[f.key]);
      if (isFinite(v)) out[f.key] = Math.max(f.min, Math.min(f.max, Math.round(v)));
    }
  }
  heroCache = out;
  return out;
}
function saveHero() {
  try { localStorage.setItem(HERO_STORE, JSON.stringify(heroParams())); } catch (error) { }
}
function heroFilter(p) {
  return 'blur(' + p.blur + 'px) saturate(' + (p.sat / 100).toFixed(2)
    + ') brightness(' + (p.bri / 100).toFixed(2) + ')';
}
/* 把参数落到元素上：过滤器 + 放大（放大是为了让模糊后的边缘不露黑边） */
function heroStyle(el, p) {
  if (!el) return;
  var filter = heroFilter(p);
  var zoom = p.zoom;
  var off = -(zoom - 100) / 2;
  el.style.webkitFilter = filter;
  el.style.filter = filter;
  el.style.left = off + '%';
  el.style.top = off + '%';
  el.style.width = zoom + '%';
  el.style.height = zoom + '%';
}
/* 详情页的底图固定用上一版那套参数，不吃面板里的自定义值 ——
   面板只负责首页/我的/搜索这些「主页面」。 */
var DETAIL_HERO = { blur: 3, sat: 104, bri: 100, veil: 100, zoom: 108 };

function applyHero() {
  var custom = customBgOn();          /* 真的有图、且不在详情页 */
  var tuning = customThemeOn();       /* 面板现在调的是自定义那套参数 */
  var onDetail = state && state.route === 'detail';
  var p = tuning ? customParams() : heroParams();
  var bgImg = document.getElementById('tv-bg-img');
  if (custom) {
    /* 自定义图整张铺开：换图只在 data URL 变了的时候动一次 img.src */
    if (bgImg && bgImg.getAttribute('src') !== customSrc) bgImg.src = customSrc;
    if (bgImg) bgImg.classList.remove('is-dim');
    heroStyle(bgImg, p);
  } else {
    /* 离开自定义场景（最典型的就是进详情页）时必须把那张图撤掉：
       data-backdrop 已经切回 poster 了，但 img 的 src 还是用户的图，
       CSS 会让它照样显示 —— 详情页要的是这部剧自己的封面。
       撤掉后先留深色底，等海报解密到位由 setBackdrop 换上来。 */
    if (bgImg && customSrc && bgImg.getAttribute('src') === customSrc) {
      bgImg.removeAttribute('src');
      bgImg.classList.add('is-dim');
    }
    heroStyle(bgImg, onDetail ? DETAIL_HERO : heroParams());
  }
  /* 预览窗永远显示「你正在调的那套」，否则在详情页调参看不到变化 */
  heroStyle(heroPreviewImg, p);

  var mainVeil = document.querySelector('#tv-bg .veil');
  if (mainVeil) {
    /* 只有海报 / 自定义底图才显示遮罩，纯色主题下这块是透明的 */
    var strength = 0;
    if (custom) strength = p.veil / 100;
    else if (heroBackdropOn()) strength = (onDetail ? DETAIL_HERO.veil : heroParams().veil) / 100;
    mainVeil.style.opacity = String(strength);
  }
  if (heroPreviewVeil) heroPreviewVeil.style.opacity = String(p.veil / 100);
}
function tuneFields() { return customThemeOn() ? CUSTOM_FIELDS : HERO_FIELDS; }
function tuneParams() { return customThemeOn() ? customParams() : heroParams(); }
function tuneRowMarkup(f) {
  var p = tuneParams();
  var pct = (p[f.key] - f.min) / (f.max - f.min) * 100;
  return '<div class="tune-row" data-tune="' + f.key + '" data-focusable data-key="tune:' + f.key + '">'
    + '<span class="tune-label">' + esc(f.label) + '</span>'
    + '<span class="tune-track"><i style="width:' + pct.toFixed(1) + '%"></i></span>'
    + '<span class="tune-value">' + p[f.key] + ' ' + f.unit + '</span>'
    + '</div>';
}
function renderTuneRows() {
  if (!heroRowsEl) return;
  var html = '';
  var fields = tuneFields();
  for (var i = 0; i < fields.length; i++) html += tuneRowMarkup(fields[i]);
  heroRowsEl.innerHTML = html;
}
function paintTuneRow(key) {
  var row = heroRowsEl && heroRowsEl.querySelector('[data-tune="' + key + '"]');
  if (!row) return;
  var f = heroField(key);
  if (!f) return;
  var p = tuneParams();
  var pct = (p[key] - f.min) / (f.max - f.min) * 100;
  var fill = row.querySelector('.tune-track i');
  if (fill) fill.style.width = pct.toFixed(1) + '%';
  var val = row.querySelector('.tune-value');
  if (val) val.textContent = p[key] + ' ' + f.unit;
}
/* 主题面板里：只有选中高性能模式才展开参数区，并把弹层黑底调淡让海报透出来 */
function syncHeroTune() {
  var custom = customThemeOn();
  var hero = currentTheme() === HERO_THEME;
  var on = hero || custom;
  if (heroTune) heroTune.hidden = !on;
  if (themePanel) {
    if (on) themePanel.classList.add('is-hero-preview');
    else themePanel.classList.remove('is-hero-preview');
  }
  var title = document.getElementById('tune-title');
  if (title) title.textContent = custom ? '自定义背景' : '海报背景参数';
  var hint = document.getElementById('tune-hint');
  if (hint) hint.textContent = custom ? '扫码换图，← → 调参数，自动保存' : '选中一行后按 ← → 调节，自动保存';
  var qr = document.getElementById('bg-qr');
  if (qr) qr.hidden = !custom;
  var pvTitle = document.getElementById('preview-title');
  if (pvTitle) pvTitle.textContent = custom ? '背景效果预览' : '剧名效果预览';
  if (themeSub) {
    themeSub.textContent = custom
      ? '手机扫码上传一张自己的图，只用在首页 / 搜索 / 我的，详情页仍是剧集海报'
      : (hero
        ? '现在这套会跟着封面换底图，下面的参数改了立刻生效，改完自动保存'
        : '固定底色，不跟着首页海报换图，遥控器怎么按都不卡');
  }
  if (on) {
    renderTuneRows();
    applyHero();
  }
  if (custom) { loadCustomBg(); renderBgQr(); }
  syncTunePreview();
}
function adjustTune(key, dir) {
  var f = heroField(key);
  if (!f) return;
  var p = tuneParams();
  var next = p[key] + dir * f.step;
  next = Math.max(f.min, Math.min(f.max, next));
  if (next === p[key]) return;
  p[key] = next;
  if (customThemeOn()) saveCustom(); else saveHero();
  paintTuneRow(key);
  applyHero();
}
function resetHero() {
  var p = tuneParams();
  var fields = tuneFields();
  for (var i = 0; i < fields.length; i++) p[fields[i].key] = fields[i].def;
  if (customThemeOn()) saveCustom(); else saveHero();
  renderTuneRows();
  applyHero();
  toast(customThemeOn() ? '背景参数已恢复默认' : '海报参数已恢复默认');
}
function focusTuneRow() {
  var focused = document.querySelector('.is-focused');
  return focused && focused.getAttribute ? focused.getAttribute('data-tune') : null;
}

function openTheme() {
  if (!themePanel) return;
  renderThemeGrid();
  themePanel.hidden = false;
  state.focusKey = 'theme:' + currentTheme();
  restoreFocus();
}
function closeTheme() {
  if (!themePanel) return;
  themePanel.hidden = true;
  themePanel.classList.remove('is-hero-preview');
  state.focusKey = 'acct:theme';
  restoreFocus();
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
  if (!nodes.length) return;
  var pending = nodes.length;
  function done() {
    if (--pending > 0) return;
    /* 图都到位了再决定首屏背景：这时第一张卡已经有 src */
    syncBackdropFromFocus();
  }
  for (var i = 0; i < nodes.length; i++) {
    (function (node) {
      var url = node.getAttribute('data-cover');
      if (!url) { done(); return; }
      cover(url).then(function (src) {
        if (!src || !node.parentNode) { done(); return; }
        node.src = src;
        /* 焦点已经停在这张卡上时，背景也跟着换成它 */
        var card = node.closest ? node.closest('.card.is-focused') : null;
        if (card || (state.route === 'detail' && node.closest('.detail-art'))) setBackdrop(src);
        done();
      }).catch(done);
    })(nodes[i]);
  }
}

/* ---------------- 背景 ----------------
   两种模式，由 body[data-backdrop] 切换：
     theme  —— 纯色主题底，没有图片、没有模糊；
     poster —— 当前这部剧的封面放大 + 低模糊。
   详情页一直用 poster；"高性能模式"主题下首页/搜索/我的也跟着焦点换图。
   换图做了 150ms 防抖：方向键连按时只加载最后一张，不会每按一下都触发一次
   全屏重绘 —— 老盒子上那个延迟感就是这么来的。 */
var HERO_THEME = 'cinema';
var backdropSrc = '';
var backdropTimer = 0;

function heroBackdropOn() {
  return (state && state.route === 'detail') || currentTheme() === HERO_THEME;
}
function setBackdrop(src) {
  /* 自定义底图下，焦点换卡不再改背景 —— 用户选的那张图才是背景 */
  if (customBgOn()) return;
  if (!src || src === backdropSrc) return;
  clearTimeout(backdropTimer);
  backdropTimer = setTimeout(function () {
    var img = document.getElementById('tv-bg-img');
    backdropSrc = src;
    if (img) { img.classList.remove('is-dim'); img.src = src; }
    /* 参数面板里的预览窗跟着同一张图走，调参时看到的就是屏幕上那张 */
    if (heroPreviewImg) heroPreviewImg.src = src;
  }, 150);
}
function applyBackdropMode() {
  if (!document.body) return;
  if (customBgOn()) document.body.setAttribute('data-backdrop', 'custom');
  else if (heroBackdropOn()) document.body.setAttribute('data-backdrop', 'poster');
  else document.body.removeAttribute('data-backdrop');
  applyHero();
}
function syncBackdrop(el) {
  if (!heroBackdropOn() || !el) return;
  var img = el.classList && el.classList.contains('card') ? el.querySelector('.art img') : null;
  if (img && img.src) setBackdrop(img.src);
}
function syncBackdropFromFocus() {
  if (!heroBackdropOn() || !view) return;
  var art = view.querySelector('.detail-art img');
  if (art && art.src) { setBackdrop(art.src); return; }
  var focused = document.querySelector('.card.is-focused');
  if (focused) syncBackdrop(focused);
}

/* ---------------- 焦点 ---------------- */
function inRail(el) { return !!(el && el.closest && el.closest('#rail')); }

/* 侧栏平时在屏幕外，只有 rail-open 时才参与焦点导航 */
function railOpen() { return document.body.classList.contains('rail-open'); }
function openRail() {
  if (railOpen()) return;
  document.body.classList.add('rail-open');
}
function closeRail() {
  if (!railOpen()) return;
  document.body.classList.remove('rail-open');
}

/* 有浮层盖着时，焦点只在浮层里转，别跑到背后的卡片上 */
function activeOverlay() {
  /* 动态码浮窗优先级最高：它开着的时候背后就是整页海报，
     不锁住的话上下左右会直接选到浮窗后面的剧集封面上。 */
  if (otpPanel && !otpPanel.hidden) return otpPanel;
  if (sourcePanel && !sourcePanel.hidden) return sourcePanel;
  if (proxyPanel && !proxyPanel.hidden) return proxyPanel;
  if (themePanel && !themePanel.hidden) return themePanel;
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
    /* 收起的侧栏还占着布局尺寸，但视觉上在屏幕外：不排除的话
       内容区按左会「选中」一个看不见的图标 */
    if (!railOpen() && inRail(el)) continue;
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
  updateMarquee(current, el);
  try { el.focus({ preventScroll: true }); } catch (error) { try { el.focus(); } catch (e2) { } }
  if (remember !== false && el.dataset) {
    state.focusKey = el.dataset.key || '';
    if (inRail(el)) state.lastRailKey = state.focusKey;
    else if (state.focusKey) state.lastContentKey = state.focusKey;
  }
  alignGridScroll(el);
  var box = el.getBoundingClientRect();
  var stageBox = stage.getBoundingClientRect();
  if (box.top < stageBox.top + 8) stage.scrollTop -= (stageBox.top + 8 - box.top);
  else if (box.bottom > stageBox.bottom - 40) stage.scrollTop += (box.bottom - (stageBox.bottom - 40));
  if (!inRail(el)) revealSectionHead(el);
  syncBackdrop(el);
}

/* 剧名跑马灯。
   电视端 WebView 内核老（Android TV 普遍 Chrome 60 上下），两个新特性都不认：
   1) flex 的 gap —— 所以两份文本会贴在一起，看起来就是 abcdefgabcdefg；
   2) @keyframes 里用 var() —— to 的位移值直接失效，动画到头就跳回起点，也就是闪。
   所以这里不用 CSS 动画：文本 + 一个真实宽度的空档 span + 文本，位移由 rAF 逐帧
   累加并对总长度取模，老内核一样跑，且永远不会「跳回起点」。 */
var MARQUEE_CHARS = 3.5;     /* 字，尾部与下一轮第一个字之间隔三四个字符 */
var MARQUEE_SPEED = 34;      /* px/秒，街边 LED 广告牌那种不紧不慢的节奏 */

var mqState = null;          /* {name, track, total, pos} */
var mqRaf = 0;
var mqLast = 0;

function mqStop() {
  if (mqRaf) { cancelAnimationFrame(mqRaf); mqRaf = 0; }
  mqState = null;
  mqLast = 0;
}

function mqTick(ts) {
  if (!mqState) { mqRaf = 0; return; }
  /* 卡片被页面重建掉了还继续跑就是白烧 CPU，直接收摊 */
  if (!document.body.contains(mqState.track)) { mqStop(); return; }
  var dt = mqLast ? Math.min(64, ts - mqLast) : 16;
  mqLast = ts;
  mqState.pos += MARQUEE_SPEED * dt / 1000;
  /* 取模而不是归零：超过一轮就从 total 里减掉，位移永远连续，接缝处看不到跳 */
  while (mqState.pos >= mqState.total) mqState.pos -= mqState.total;
  mqState.track.style.transform = 'translateX(' + (-Math.round(mqState.pos * 10) / 10) + 'px)';
  mqRaf = requestAnimationFrame(mqTick);
}

function mqStart(name, track, total) {
  mqStop();
  mqState = { name: name, track: track, total: total, pos: 0 };
  track.style.transform = 'translateX(0)';
  mqRaf = requestAnimationFrame(mqTick);
}

function resetMarquee(card) {
  var name = card && card.querySelector ? card.querySelector('.name') : null;
  if (!name) return;
  if (!name.classList.contains('is-scrolling') && !name.querySelector('.mq-track')) return;
  if (mqState && mqState.name === name) mqStop();
  var text = name.getAttribute('data-mq-text');
  if (text != null) name.textContent = text;
  name.classList.remove('is-scrolling');
  name.removeAttribute('data-mq-text');
}

function updateMarquee(prev, next) {
  if (prev !== next) resetMarquee(prev);
  var name = next && next.querySelector ? next.querySelector('.name') : null;
  if (!name) return;
  /* 已经在滚就直接复用，重建会把位移归零，看起来就是闪一下从头开始 */
  if (name.getAttribute('data-mq-text') != null) return;
  resetMarquee(next);
  /* 还没套 track 时才量得到真实溢出：overflow:hidden + ellipsis 下 scrollWidth 仍是全宽 */
  if (name.scrollWidth - name.clientWidth < 4) return;
  var text = name.textContent;
  if (!text) return;
  var fontSize = parseFloat(window.getComputedStyle(name).fontSize) || 30;
  var gap = Math.round(fontSize * MARQUEE_CHARS);
  var track = document.createElement('span');
  track.className = 'mq-track';
  var copy = document.createElement('span');
  copy.className = 'mq-seg';
  copy.textContent = text;
  var blank = document.createElement('span');
  blank.className = 'mq-blank';
  blank.style.width = gap + 'px';     /* 真实占位，不依赖 flex gap */
  var tail = document.createElement('span');
  tail.className = 'mq-seg';
  tail.textContent = text;
  tail.setAttribute('aria-hidden', 'true');
  track.appendChild(copy);
  track.appendChild(blank);
  track.appendChild(tail);
  name.setAttribute('data-mq-text', text);
  name.textContent = '';
  name.appendChild(track);
  /* offsetWidth 同步强制布局；量到 0 说明卡片还没上屏，这一轮放弃，等下次聚焦再量 */
  var width = copy.offsetWidth || 0;
  if (width < 4) { resetMarquee(next); return; }
  name.classList.add('is-scrolling');
  mqStart(name, track, width + gap);
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
  /* 侧栏收起后没有「首页图标」可以停：没有记录就落在第一张海报上，
     别落在分类条 —— 分类条在标题下面，选中它会把页面往下带一截 */
  if (!target) target = view.querySelector('.card') || all[0];
  focusElement(target, false);
}

/* 侧栏和内容区是两套焦点：内容区里按左右只在内容里走，只在最左一列
   继续按左才进侧栏；侧栏里按右回到刚才那张卡。原来的做法是纯按距离算，
   第一排的卡上面没东西时，最近的目标反而是左上角那排图标 —— 于是
   「往上按一下」直接跳到侧栏，标题头永远看不到。 */
function railKeyForRoute() {
  if (state.route === 'search') return 'nav:search';
  if (state.route === 'library') return 'nav:library';
  return 'nav:home';
}

/* 呼出侧栏：内容区走到最左一列还继续按左，侧栏从左边滑出来，
   焦点直接落在当前页对应的图标上（首页/搜索/我的）。 */
function enterRail(from) {
  if (from && from.dataset && from.dataset.key && !inRail(from)) state.lastContentKey = from.dataset.key;
  openRail();
  var target = document.querySelector('#rail [data-key="' + railKeyForRoute() + '"]');
  if (!target) target = document.querySelector('#rail [data-focusable]');
  if (!target) return;
  focusElement(target);
}

/* 收回侧栏：焦点回到刚才那张卡，页面位置不动 */
function leaveRail() {
  var target = null;
  if (state.lastContentKey) target = document.querySelector('[data-key="' + state.lastContentKey + '"]');
  if (!target) {
    var all = focusables();
    for (var i = 0; i < all.length; i++) if (!inRail(all[i])) { target = all[i]; break; }
  }
  closeRail();
  if (target) focusElement(target);
}

/* 第一排的卡被选中时，把这一块的标题头（「全部作品」）滚进画面。
   否则往下翻过之后按回来，标题头一直藏在屏幕上边。 */
function revealSectionHead(el) {
  if (!el || !el.closest) return;
  /* 窗口模式下 #stage 是不滚的，这一套「把标题带回来」会把已经对齐的行带歪 */
  if (document.body.classList.contains('page-windowed')) return;
  var grid = el.closest('.grid');
  if (!grid) return;
  var cards = grid.querySelectorAll('.card');
  var top = Infinity;
  for (var i = 0; i < cards.length; i++) {
    var t = cards[i].getBoundingClientRect().top;
    if (t < top) top = t;
  }
  var box = el.getBoundingClientRect();
  if (Math.abs(box.top - top) > 6) return;            /* 不是第一排 */
  var section = el.closest('.section');
  var head = section && section.querySelector('.section-head');
  if (!head) return;
  var stageBox = stage.getBoundingClientRect();
  var headBox = head.getBoundingClientRect();
  var pad = 10;
  if (headBox.top < stageBox.top + pad) stage.scrollTop -= (stageBox.top + pad - headBox.top);
}

/* 同一「排」的判定：左右移动只认竖直方向有重叠的目标。
   否则最左边那张卡按左，最近的目标反而是它斜上方的分类条（x 稍微靠左一点点），
   于是永远进不了侧栏。 */
function sameBand(a, b) {
  var overlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return overlap > Math.min(a.height, b.height) * 0.5;
}
function sameColumn(a, b) {
  var overlap = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  return overlap > 0;
}

/* 窗口模式下按行跳：一屏 6 列，往下就是 +6 张。
   返回 true 表示这次按键已经处理掉（包括「已经到头，别再动」）。
   lastRowIntent：在最后一行又按了一下「下」—— 说明用户想继续往下看，
   这一下除了翻页没有别的语义，记下来，新内容插完后把焦点接到新那一行。 */
var lastRowIntent = null;

function stepToRow(el, direction) {
  if (!el || !el.closest) return false;
  var grid = el.closest('.grid');
  if (!grid || !grid.classList.contains('is-window')) return false;
  var cards = grid.querySelectorAll('.card');
  if (cards.length <= 6) return false;
  var card = el.closest('.card') || el;
  var idx = Array.prototype.indexOf.call(cards, card);
  if (idx < 0) return false;
  var target = idx + (direction === 'down' ? 6 : -6);
  if (target < 0) return false;              /* 第一排再往上：交回常规逻辑（分类条/页签） */
  if (target >= cards.length) {
    if (idx >= cards.length - 6) {
      /* 已经在最后一行：窗口模式把 #stage 锁死了，以前这里直接 return true，
         于是「滚到底自动续页」永远不会触发 —— 一页就 18 张，翻三排到头。
         现在按一下就主动要下一页，焦点等新行插进来再跟过去。 */
      if (direction === 'down' && state.feed && state.feed.nextPage && !state.feed.loading) {
        lastRowIntent = card;
        loadFeed(state.feedId, false);
      }
      return true;
    }
    target = cards.length - 1;
  }
  focusElement(cards[target]);
  return true;
}

function pickNearest(current, all, direction, banded) {
  var from = current.getBoundingClientRect();
  var cx = (from.left + from.right) / 2;
  var cy = (from.top + from.bottom) / 2;
  var best = null;
  var bestScore = Infinity;
  var onRail = inRail(current);
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    if (el === current) continue;
    /* 侧栏与内容区互不参与距离比较，只有显式的左/右才能跨过去 */
    if (inRail(el) !== onRail) continue;
    var box = el.getBoundingClientRect();
    if (banded) {
      if ((direction === 'left' || direction === 'right') && !sameBand(from, box)) continue;
      if ((direction === 'up' || direction === 'down') && !sameColumn(from, box)) continue;
    }
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
  return best;
}

function move(direction) {
  var all = focusables();
  if (!all.length) return;
  var current = document.querySelector('.is-focused');
  if (!current || all.indexOf(current) < 0) { focusElement(all[0]); return; }

  var onRail = inRail(current);
  if (onRail) {
    /* 侧栏是临时呼出来的：按右回内容区，再按左也收回 */
    if (direction === 'right' || direction === 'left') { leaveRail(); return; }
  }

  var from = current.getBoundingClientRect();
  /* 海报窗口模式：上下按「整行」跳，不用几何最近。
     被裁到窗口外的那一排，屏幕坐标还留在标题区旁边，按上键会先选中
     分类条（离得更近）—— 而用户按上就是想回上一排。 */
  if (direction === 'up' || direction === 'down') {
    if (stepToRow(current, direction)) return;
  }
  var best = pickNearest(current, all, direction, true);
  /* 上下允许放宽：不同区块宽度不一致时（分类条、按钮、剧集格），
     严格对齐会把人卡死，所以放宽再找一次。左右不放宽 —— 放宽就会斜着跳。 */
  if (!best && (direction === 'up' || direction === 'down')) best = pickNearest(current, all, direction, false);
  if (best) { focusElement(best); return; }
  if (onRail) return;
  /* 浮层开着时到边就停：再按左会把侧栏呼出来，那也是在浮层背后 */
  if (activeOverlay()) return;

  if (direction === 'left') { enterRail(current); return; }
  if (direction === 'up') {
    /* 上面还有没露出来的内容（标题头、上一排）就先往上滚一屏；
       到顶就停住 —— 侧栏只由「最左边再按左」呼出，上键不再跳到侧栏 */
    if (stage.scrollTop > 1) {
      var step = Math.max(120, from.height + 60);
      stage.scrollTop = Math.max(0, stage.scrollTop - step);
      revealSectionHead(current);
    }
  }
}

/* ---------------- 卡片 ---------------- */
function cardMarkup(item, index) {
  var key = 'card:' + (item.id || index);
  var rank = Number(item.rank) || 0;
  /* 榜单卡片用名次当角标（前 3 名描金），观看记录用「第N集」，其余用评分 */
  var badge = rank ? ('#' + rank) : (item.episode ? ('第' + item.episode + '集') : (item.score || ''));
  var badgeClass = rank ? ('badge is-rank' + (rank <= 3 ? ' is-top' : '')) : 'badge';
  return '<button type="button" class="card" data-focusable data-key="' + esc(key) + '" data-id="' + esc(item.id) + '">'
    + '<span class="art"><img data-cover="' + esc(item.cover || '') + '" alt="">'
    + (badge ? '<i class="' + badgeClass + '">' + esc(badge) + '</i>' : '')
    + '</span><span class="name">' + esc(item.title || '') + '</span></button>';
}
function gridMarkup(items, emptyText) {
  if (!items.length) return '<p class="empty">' + esc(emptyText || '这里还没有内容') + '</p>';
  var html = '<div class="grid">';
  for (var i = 0; i < items.length; i++) html += cardMarkup(items[i], i);
  return html + '</div>';
}

/* ---------------- 分类：和安卓端一致，按内容源取真实分类 id ---------------- */
/* 接口型源（剧果/野果/帝果…）的分类由后端给：先「全部 / 最新」，
   后面接源站自己的题材分类。黄果保持原来四个固定分类。 */
var siteCats = [['', '全部'], ['new', '最新']];

function applySiteCategories() {
  if (privateSite.id === 'huangguo') return;
  api('tags').then(function (data) {
    var rows = (data && data.items) || [];
    var list = [['', '全部'], ['new', '最新']];
    for (var i = 0; i < rows.length && list.length < 8; i++) {
      var row = rows[i] || {};
      if (!row.slug || row.slug === 'new') continue;
      list.push([row.slug, row.name || row.slug]);
    }
    siteCats = list;
    if (state.route === 'home') renderHome();
  }).catch(function () { });
}

function categoryList() {
  if (state.source === 'huangguo') {
    if (privateSite.id !== 'huangguo') return siteCats;
    return [['ai-duanju', '成人短剧'], ['ai-manju', '成人漫剧'], ['ai-huanlian', 'AI换脸'], ['ai-mogai', 'AI魔改']];
  }
  /* 前两个是常规分类，后四个是红果的热播榜（后端按榜单页解析，卡片带名次角标）。
     排在一起是因为对用户来说「看什么」是一件事，不必再开一级菜单。 */
  return [['short', '短剧'], ['comic', '漫剧'],
    ['hot-drama', '热播榜'], ['hot-real-drama', '真人榜'], ['hot-comic-drama', '漫剧榜'], ['hot-ai-drama', 'AI榜']];
}
function isRankId(id) { return /^hot-(drama|real-drama|comic-drama|ai-drama)$/.test(String(id || '')); }
function categoryName(id) {
  var cats = categoryList();
  for (var i = 0; i < cats.length; i++) if (cats[i][0] === id) return cats[i][1];
  return '全部作品';
}
function filterList() {
  if (state.source === 'huangguo') {
    return [['all', '全部'], ['ai-duanju', '成人短剧'], ['ai-manju', '成人漫剧'], ['ai-huanlian', 'AI换脸'], ['ai-mogai', 'AI魔改']];
  }
  return [['all', '全部'], ['short', '短剧'], ['comic', '漫剧']];
}

/* ---------------- 首页 ----------------
   两块：分类条 + 全部作品瀑布流（原「剧场」的内容）。
   「继续观看」已删 —— 「我的」里本来就有观看记录，首页留白给海报墙。 */
/* ---------------- 首屏排布 ----------------
   卡片宽度由「一屏 6 列」定死，高度跟着 1.4 比例走，所以缩不了。
   想让第一排 6 部完整、第二排只露顶部 1/3，多出来的空白只能放在
   #stage 的顶部内边距上 —— 标题（首页的分类条、我的的三个页签）
   跟着整体下沉，正好落在第一排海报的上沿，上面那片就留给背景海报。
   只对首页 / 我的生效；搜索、详情保持原样。 */
var FIRST_ROW_PORTION = 0.2;   /* 下面一排露出 1/5 行高 */

function resetFirstScreen() {
  if (stage) {
    stage.style.paddingTop = '';
    stage.style.paddingBottom = '';
    /* 只清 inline 的 overflow —— CSS 里那条 overflow:hidden 是给
       page-windowed 用的，跟着 body class 一起消失，这里不用管 */
  }
  document.body.classList.remove('page-windowed');
  var grid = view && view.querySelector('.grid');
  if (grid) {
    grid.classList.remove('is-window');
    grid.style.height = '';
    grid.style.marginLeft = '';
    grid.style.marginRight = '';
    grid.style.paddingTop = '';
    grid.style.paddingBottom = '';
    grid.style.paddingLeft = '';
    grid.style.paddingRight = '';
    grid.style.width = '';
    grid.scrollTop = 0;
  }
}

/* 把海报区做成一个固定高度的窗口：一整行 + 下一行露出 1/5。
   以前是让 #stage 整体加顶部内边距，结果往下翻时整页在滚，屏幕上会同时
   出现「两行完整」或者「上半屏空白」；现在窗口自己滚，每翻一行就把那一行
   顶到窗口顶部，上面那行整行退出，视觉上始终只有一行完整 + 下一行露头。 */
var layoutRetry = 0;

/* 窗口已经设好之后，再按「实际露出的像素」修一次高度。
   真机上字体 / 封面浮层落下来会把行高改掉，而 setHeight 那一下量到的还是旧值，
   于是露出来的变成半排 —— 这就是「只有某些主题看着对」的真正来源：
   有背景海报时整屏尺寸不同，测量基准跟着变。多修一次就没有这个先后问题。 */
function settleWindow(grid) {
  if (!grid || !grid.classList.contains('is-window')) return;
  var cards = grid.querySelectorAll('.card');
  if (cards.length <= 6) return;
  var rowH = cards[6].offsetTop - cards[0].offsetTop;
  if (rowH < 40) return;
  var h = parseFloat(grid.style.height) || grid.getBoundingClientRect().height;
  var peek = grid.getBoundingClientRect().bottom - cards[6].getBoundingClientRect().top;
  var fix = Math.round(rowH * FIRST_ROW_PORTION - peek);
  if (Math.abs(fix) >= 1) {
    var next = Math.max(140, h + fix);
    grid.style.height = next + 'px';
    /* 高度变了，贴底的位置也要跟着挪，否则窗口底部会离屏幕边一段 */
    if (heroBackdropOn()) {
      stage.style.paddingTop = '0px';
      var room = stage.clientHeight - next - grid.offsetTop;
      if (room > 0) stage.style.paddingTop = room + 'px';
    }
  }
}

function layoutFirstScreen() {
  /* 整行窗口那套已经撤掉了：所有主题都恢复成一开始的整页 6×2 滚动布局。
     函数名保留，调用点不用动；窗口相关的样式类一并清掉（可能是上个版本留下的）。 */
  resetFirstScreen();
}

/* 焦点换行时把窗口滚到那一行 —— 下面一行顶上来，上面一行退出去。
   只按整行滚，不做像素级跟随：遥控器上按一下跳一行才跟得上眼睛。 */
function alignGridScroll(el) {
  var grid = view && view.querySelector('.grid');
  if (!grid || !grid.classList.contains('is-window') || !el) return;
  var card = el.closest ? el.closest('.card') : null;
  if (!card || !grid.contains(card)) return;
  var cards = grid.querySelectorAll('.card');
  if (cards.length <= 6) return;
  var rowH = cards[6].offsetTop - cards[0].offsetTop;
  if (rowH < 40) return;
  var row = Math.round((card.offsetTop - cards[0].offsetTop) / rowH);
  var target = row * rowH;
  if (Math.abs(grid.scrollTop - target) > 2) grid.scrollTop = target;
}

function renderHome() {
  var cats = categoryList();
  var active = state.feedId || cats[0][0];
  var chips = '<div class="chips">';
  for (var i = 0; i < cats.length; i++) {
    chips += '<button type="button" class="chip' + (cats[i][0] === active ? ' is-active' : '') + '" data-focusable data-key="chip:' + esc(cats[i][0]) + '" data-chip="' + esc(cats[i][0]) + '">' + esc(cats[i][1]) + '</button>';
  }
  chips += '</div>';

  var feed = state.feed;
  var body;
  if (!feed) body = '<p class="empty">正在加载…</p>';
  else if (feed.error) body = '<p class="empty">加载失败，按 OK 重试</p>';
  else body = gridMarkup(feed.items, '这个分类下暂时没有内容');

  var html = '<h1 class="page-title">首页</h1>';
  html += '<section class="section" data-feed="1"><div class="section-head"><h2>'
    + esc(categoryName(active)) + (isRankId(active) ? ' · 每日更新' : '') + '</h2><span data-feed-count="1">'
    + (feed ? feed.items.length : 0) + ' 部</span></div>' + chips + body + '</section>';
  view.innerHTML = html;
  paintCovers(view);
  layoutFirstScreen();
  restoreFocus();
  applyPendingRestore();
  syncBackdropFromFocus();
}

var feedToken = 0;

/* 首页缓存：私密源一页要经后端转发好几秒，电视开机先看到一屏骨架很难受。
   进来先用上一轮的内容铺满，新数据回来且确实变了再整体替换，没变就只补封面。 */
var FEED_CACHE_TTL = 12 * 3600 * 1000;
function feedCacheKey(id) { return 'veyra-tv-feed-' + id; }
function readFeedCache(id) {
  try {
    var raw = localStorage.getItem(feedCacheKey(id));
    if (!raw) return null;
    var data = JSON.parse(raw);
    if (!data || !data.at || Date.now() - data.at > FEED_CACHE_TTL) return null;
    if (!list(data.items).length) return null;
    return data;
  } catch (error) { return null; }
}
function writeFeedCache(id, items, nextPage) {
  try {
    localStorage.setItem(feedCacheKey(id), JSON.stringify({ at: Date.now(), items: list(items).slice(0, 80), nextPage: nextPage || null }));
  } catch (error) { /* 配额满了就放弃缓存，不影响播放 */ }
}
function feedSignature(items) {
  return list(items).map(function (item) { return String(item && item.id); }).join(',');
}

/* focusChip=false：这是开机/切页触发的加载，焦点留在原处（侧栏图标）——
   以前不管谁调用都把焦点塞给分类条，分类条在首屏下方，浏览器为了露出它
   会把页面往下滚 100 多像素，「首页」标题头一进去就被顶没了。 */
function loadFeed(id, reset, focusChip) {
  var target = id || state.feedId || categoryList()[0][0];
  var switched = target !== state.feedId;
  state.feedId = target;
  if (reset || switched) {
    var cached = readFeedCache(target);
    if (cached) {
      // 有缓存：先把它当当前内容渲染出来，loading 仍然为真（底部会显示还在拉）
      state.feed = { id: target, items: cached.items, nextPage: cached.nextPage || null, loading: true, error: false };
    } else {
      state.feed = null;
    }
    if (focusChip !== false) state.focusKey = 'chip:' + target;
    if (state.route === 'home') renderHome();
  } else if (state.feed && (state.feed.loading || !state.feed.nextPage)) {
    return;
  }
  var pageNo = state.feed && state.feed.nextPage ? state.feed.nextPage : 1;
  var token = ++feedToken;
  if (state.feed) state.feed.loading = true;
  api('category', { id: target, page: pageNo }).then(function (data) {
    if (token !== feedToken || state.route !== 'home') return;
    var incoming = list(data && data.items);
    var nextPage = data && data.nextPage ? data.nextPage : null;
    if (!state.feed || pageNo === 1) {
      var before = feedSignature(state.feed && state.feed.items);
      var after = feedSignature(incoming);
      state.feed = { id: target, items: incoming, nextPage: nextPage, loading: false, error: false };
      writeFeedCache(target, incoming, nextPage);
      // 和缓存一模一样就别重绘：重绘会让遥控器焦点闪一下
      if (before !== after) renderHome();
    } else {
      state.feed.items = state.feed.items.concat(incoming);
      state.feed.nextPage = nextPage;
      state.feed.loading = false;
      appendFeed(incoming);
    }
  }).catch(function (error) {
    if (token !== feedToken || state.route !== 'home') return;
    if (state.feed) { state.feed.loading = false; if (pageNo === 1) state.feed.error = true; renderHome(); }
    else { state.feed = { id: target, items: [], nextPage: null, loading: false, error: true }; renderHome(); }
    toast(error.message || '加载失败', true);
  });
}

/* 续页只往末尾插卡片，不整页重绘 —— 整页重绘会把遥控器焦点打回第一张 */
function appendFeed(items) {
  if (!items.length || !state.feed) { lastRowIntent = null; return; }
  var grid = view.querySelector('[data-feed] .grid');
  if (!grid) { renderHome(); return; }
  var html = '';
  for (var i = 0; i < items.length; i++) html += cardMarkup(items[i], state.feed.items.length - items.length + i);
  grid.insertAdjacentHTML('beforeend', html);
  paintCovers(grid);
  var count = view.querySelector('[data-feed-count]');
  if (count) count.textContent = state.feed.items.length + ' 部';
  /* 第一页可能刚好 6 张，追加出第二排之后才需要重排顶部留白 */
  layoutFirstScreen();
  /* 在最后一行按「下」等来的这一页：接到新那一行的第一张，
     否则新内容插进来了、焦点还停在旧最后一行，用户得再按一下才动。 */
  if (lastRowIntent) {
    var anchor = lastRowIntent;
    lastRowIntent = null;
    var all = grid.querySelectorAll('.card');
    var from = Array.prototype.indexOf.call(all, anchor);
    if (from >= 0 && from + 6 < all.length) focusElement(all[from + 6]);
  }
}

/* 滚到底自动续页（电视上不用点“加载更多”） */
function observeStageEnd() {
  stage.onscroll = function () {
    if (state.route !== 'home' || !state.feed || state.feed.loading || !state.feed.nextPage) return;
    if (stage.scrollTop + stage.clientHeight >= stage.scrollHeight - 500) loadFeed(state.feedId, false);
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
  resetFirstScreen();
  var filters = filterList();
  var query = state.search.query;
  var items = filteredSearchItems();
  var loading = state.search.items === null;
  var hasResults = !!(state.search.items && state.search.items.length);

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
  else if (!query) {
    /* 没搜过时别留一整页黑：把搜过的关键词摆出来，按一下就能重搜 */
    var recent = recentSearches();
    if (recent.length) {
      html += '<p class="search-count">最近搜索</p><div class="chips">';
      for (var r = 0; r < recent.length; r++) {
        html += '<button type="button" class="chip" data-focusable data-key="recent:' + esc(recent[r]) + '" data-recent="' + esc(recent[r]) + '">' + esc(recent[r]) + '</button>';
      }
      html += '</div>';
    } else {
      html += '<p class="empty">输入关键词开始搜索</p>';
    }
  }
  else if (!items.length) html += '<p class="empty">没有找到「' + esc(query) + '」</p>';
  else {
    /* 上次的结果一直留在页面上，直到下次搜索覆盖它 */
    html += '<p class="search-count">' + esc(query) + ' · ' + items.length + ' 部作品'
      + (loading ? ' · 正在更新…' : '') + '</p>';
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
  syncBackdropFromFocus();

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
  applyPendingRestore();
}

/* 搜索结果落地：电视端搜索一次要按半天遥控器，下次开机还留着上次那批结果 */
var SEARCH_STORE = 'veyra.tv.search';
var RECENT_STORE = 'veyra.tv.recent';
function recentSearches() {
  try {
    var raw = window.localStorage.getItem(RECENT_STORE);
    var arr = raw ? JSON.parse(raw) : [];
    return Object.prototype.toString.call(arr) === '[object Array]' ? arr : [];
  } catch (error) { return []; }
}
function rememberSearch(query) {
  try {
    var old = recentSearches();
    var next = [query];
    for (var i = 0; i < old.length && next.length < 8; i++) if (old[i] !== query) next.push(old[i]);
    window.localStorage.setItem(RECENT_STORE, JSON.stringify(next));
  } catch (error) { }
}
function saveSearch(query, items) {
  rememberSearch(query);
  try {
    var slim = [];
    for (var i = 0; i < items.length && i < 60; i++) {
      var it = items[i];
      slim.push({ id: it.id, title: it.title, cover: it.cover, score: it.score, albumId: it.albumId, seasonIndex: it.seasonIndex, category: it.category, episodeLabel: it.episodeLabel });
    }
    window.localStorage.setItem(SEARCH_STORE, JSON.stringify({ query: query, items: slim, at: Date.now() }));
  } catch (error) { }
}
function restoreSearch() {
  try {
    var raw = window.localStorage.getItem(SEARCH_STORE);
    if (!raw) return;
    var saved = JSON.parse(raw);
    if (!saved || !saved.query || !saved.items || !saved.items.length) return;
    state.search.query = String(saved.query);
    state.search.items = saved.items;
  } catch (error) { }
}

function runSearch(query) {
  if (!query) { toast('先输入剧名'); return; }
  /* 新搜索开始：旧结果先留在屏幕上，等新结果回来再整体覆盖 */
  state.search.lastQuery = state.search.query;
  state.search.query = query;
  state.search.filter = 'all';
  renderSearch();
  api('search', { query: query }).then(function (data) {
    if (state.search.query !== query) return;
    state.search.items = list(data && data.items);
    saveSearch(query, state.search.items);
    if (state.route === 'search') renderSearch();
  }).catch(function (error) {
    if (state.search.query !== query) return;
    state.search.items = [];
    if (state.route === 'search') renderSearch();
    toast(error.message || '搜索失败', true);
  });
}

/* ---------------- 我的 ---------------- */
function nextWorkMarkup(item, index) {
  var key = 'nas:' + (item.id || index);
  var ready = item.status === 'done' || item.status === 'ready';
  /* done 是合并完成（分集已清理，只剩一个整片），ready 才是还按集摆着的；
     合并过的再写「全 N 集」会让人以为还能选集，直接标「已合并」 */
  var badge;
  if (item.status === 'done') badge = '已合并';
  else if (!ready) badge = '下载中';
  else badge = item.episodeCount ? ('全 ' + item.episodeCount + ' 集') : '已下载';
  if (item.kind === 'desktop' || item.kind === 'tv' || item.kind === 'android') {
    var label = item.kind === 'desktop' ? '电脑' : item.kind === 'tv' ? '电视' : '手机';
    badge = item.deviceName ? (label + ' · ' + item.deviceName) : label;
  }
  return '<button type="button" class="card' + (ready ? '' : ' is-dim') + '" data-focusable data-key="' + esc(key) + '" data-nas="' + esc(item.id) + '" data-nas-ready="' + (ready ? '1' : '') + '">'
    + '<span class="art"><img data-cover="' + esc(item.cover || '') + '" alt="">'
    + '<i class="badge">' + esc(badge) + '</i>'
    + '</span><span class="name">' + esc(item.title || '') + '</span></button>';
}

function renderLibrary() {
  var data = state.library || { bookmarks: [], progress: [] };
  var history = list(data.progress);
  var bookmarks = list(data.bookmarks);
  var tab = state.libraryTab;
  var html = '<h1 class="page-title">我的</h1>'
    + '<div class="tabs chips">'
    + '<button type="button" class="chip' + (tab === 'history' ? ' is-active' : '') + '" data-focusable data-key="tab:history" data-tab="history">观看记录</button>'
    + '<button type="button" class="chip' + (tab === 'bookmarks' ? ' is-active' : '') + '" data-focusable data-key="tab:bookmarks" data-tab="bookmarks">收藏</button>'
    + '<button type="button" class="chip' + (tab === 'nas' ? ' is-active' : '') + '" data-focusable data-key="tab:nas" data-tab="nas">下载</button>'
    + '</div>';
  if (tab === 'nas') {
    html += '<div class="nas-panel">';
    if (state.nasError) html += '<p class="empty">' + esc(state.nasError) + '</p>';
    else if (!state.nas) html += '<p class="empty">正在读取下载…</p>';
    else if (!state.nas.length) html += '<p class="empty">还没有已下载的作品<br><span class="tip">手机端传到 NAS，或在电脑端下载完成后，这里就能直接播放</span></p>';
    else {
      html += '<div class="grid">';
      for (var i = 0; i < state.nas.length; i++) html += nextWorkMarkup(state.nas[i], i);
      html += '</div>';
    }
    html += '</div>';
  } else {
    html += gridMarkup(tab === 'history' ? history : bookmarks, tab === 'history' ? '还没有观看记录' : '还没有收藏');
  }
  view.innerHTML = html;
  paintCovers(view);
  layoutFirstScreen();
  syncBackdropFromFocus();
  restoreFocus();
  applyPendingRestore();
}

function loadLibrary() {
  api('library').then(function (data) {
    state.library = data || { bookmarks: [], progress: [] };
    /* 首页已经不放观看记录，library 数据只影响「我的」——
       以前这里连首页一起重渲染，从详情返回会把整面海报墙重建一遍（闪一下） */
    if (state.route === 'library') renderLibrary();
  }).catch(function () {
    state.library = { bookmarks: [], progress: [] };
  });
}

function loadNas() {
  if (!state.account || !state.account.loggedIn) {
    state.nas = [];
    state.nasError = '登录后才能看 NAS 上的作品';
    if (state.route === 'library') renderLibrary();
    return;
  }
  state.nasError = '';
  api('nas-download-list').then(function (data) {
    state.nas = list(data && data.tasks);
    /* 同一账号下在线电脑的下载记录：和 NAS 混在一个列表里，点开直接播电脑上的成品 */
    return api('desktop-download-list').then(function (pc) {
      /* 同一账号下在线的电脑 / 手机 / 另一台电视：和 NAS 混在一个列表里，点开直接播那台机器上的成品 */
      var extra = list(pc && pc.tasks).map(function (t) {
        t.kind = (t.kind === 'desktop' || t.kind === 'tv' || t.kind === 'android') ? t.kind : 'desktop';
        return t;
      });
      state.nas = state.nas.concat(extra);
    }).catch(function () { });
  }).then(function () {
    if (state.route === 'library' && state.libraryTab === 'nas') renderLibrary();
  }).catch(function (error) {
    state.nas = [];
    state.nasError = '读取失败：' + ((error && error.message) || '网络异常');
    if (state.route === 'library' && state.libraryTab === 'nas') renderLibrary();
  });
}

function playNas(id) {
  var task = null;
  for (var i = 0; i < list(state.nas).length; i++) if (String(state.nas[i].id) === String(id)) task = state.nas[i];
  if (task && task.status !== 'done' && task.status !== 'ready') { toast('这部还没下载完，等它下载好再播'); return; }
  if (task && (task.kind === 'desktop' || task.kind === 'tv' || task.kind === 'android')) {
    if (!task.url) { toast(task.merged ? '这台设备没有可用的局域网地址，确认在同一 Wi-Fi' : '对面还没合并成品，等它合并好再播', true); return; }
    api('open-desktop-player', { url: task.url, title: task.title })
      .catch(function (error) { toast((error && error.message) || '视频打不开，确认设备在同一局域网且在线', true); });
    return;
  }
  api('open-nas-player', { id: String(id) }).catch(function (error) { toast((error && error.message) || 'NAS 视频打不开', true); });
}

/* ---------------- 详情 ---------------- */
/* 续播只认「最后看到哪一集哪一秒」，不设 5 秒/近结尾门槛；看完这集就顺延下一集 */
function resumePlan() {
  var p = state.detailProgress;
  if (!p) return null;
  var ep = Number(p.episode) || 0;
  if (ep < 1) return null;
  if (p.completed) {
    var total = Number(p.episodeCount) || 0;
    if (total > 0 && ep >= total) return null;
    return { episode: ep + 1, restart: true };
  }
  return { episode: ep, restart: false };
}

function renderDetail() {
  resetFirstScreen();
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

  var resume = resumePlan();
  var playText = state.detailLoading ? '正在加载…' : (resume ? ('继续播放 · 第' + resume.episode + '集') : '立即播放');

  view.innerHTML = '<div class="detail">'
    + '<div class="detail-art"><img data-cover="' + esc(data.cover || '') + '" alt=""></div>'
    + '<div class="detail-info">'
    + '<h1>' + esc(data.title || '') + '</h1>'
    + '<p class="meta">' + esc(data.score || '') + '　' + esc(data.episodeLabel || '') + '</p>'
    + (resume && !resume.restart ? '<p class="resume-line">上次看到第 ' + resume.episode + ' 集 · ' + clock(state.detailProgress.position) + '</p>' : '')
    + (resume && resume.restart ? '<p class="resume-line">第 ' + state.detailProgress.episode + ' 集已看完，接着看第 ' + resume.episode + ' 集</p>' : '')
    + '<p class="desc">' + esc(data.description || '') + '</p>'
    + '<div class="actions detail-actions">'
    + '<button type="button" class="btn primary" data-focusable data-key="play" data-play="1"' + (state.detailLoading ? ' disabled' : '') + '>' + playText + '</button>'
    + (resume ? '<button type="button" class="btn icon-only" data-focusable data-key="restart" data-restart="1" aria-label="从头播放" title="从头播放">'
      + '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5V1L7 6l5 5V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z"/></svg></button>' : '')
    + '<button type="button" class="btn" data-focusable data-key="bookmark" data-bookmark="1">' + (data.bookmarked ? '已收藏' : '收藏') + '</button>'
    + '</div>' + eps + '</div></div>';
  paintCovers(view);
  restoreFocus();
  syncBackdropFromFocus();
}

function clock(ms) {
  var total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  var h = Math.floor(total / 3600);
  var m = Math.floor((total % 3600) / 60);
  var s = total % 60;
  var mm = (m < 10 && h > 0 ? '0' : '') + m;
  var ss = (s < 10 ? '0' : '') + s;
  return (h > 0 ? h + ':' + mm : m) + ':' + ss;
}

/* 记住当前页看到哪儿、选中谁 —— 从详情返回时原样还原 */
function rememberRoute() {
  if (!state.route) return;
  state.memory[state.route] = { scrollTop: stage.scrollTop, focusKey: state.focusKey };
}
/* 数据没回来时先挂起；渲染完成后由各 render 函数再调一次 */
function applyPendingRestore() {
  var pending = state.pendingRestore;
  if (!pending) return;
  var all = focusables();
  var target = null;
  for (var i = 0; i < all.length; i++) {
    if (all[i].dataset.key === pending.focusKey) { target = all[i]; break; }
  }
  if (!target) return;                 /* 列表还没出来，等下一次渲染 */
  state.pendingRestore = null;
  focusElement(target, false);
  stage.scrollTop = pending.scrollTop;
}

function openDetail(id) {
  if (id == null) return;
  if (state.route !== 'detail') { state.detailFrom = state.route; rememberRoute(); }
  state.route = 'detail';
  state.detail = null;
  state.detailProgress = null;
  state.detailLoading = true;
  state.epGroup = 0;
  state.focusKey = 'play';
  stage.scrollTop = 0;
  /* 刚点进来的那张卡片，封面早就解密好了 —— 先铺上，别让背景空着等详情接口。
     详情数据回来后 hydrateCovers 会用正确的封面覆盖一次（通常就是同一张）。 */
  var seed = document.querySelector('.card.is-focused .art img');
  applyBackdropMode();
  if (seed && seed.src) setBackdrop(seed.src);
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
  /* 上次看到哪集哪一秒：拿到来就把按钮换成「继续播放」。
     注意以前这里要求 state.detail 已经到货，本地进度通常比详情接口先回来，
     结果进度被直接丢掉 —— 电视端详情页因此永远显示「立即播放」。 */
  var wanted = String(id);
  api('latest-progress', { id: wanted }).then(function (progress) {
    if (state.route !== 'detail') return;
    state.detailProgress = progress || null;
    if (state.detail && String(state.detail.id) === wanted) renderDetail();
  }).catch(function () { });
}

/* ---------------- 动作 ---------------- */
function play(detail, episode, restart, position) {
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
    episode: episode || 1,
    restart: !!restart,
    /* 投屏时手机已经播到第几秒，电视从同一位置接上；普通起播传 0 */
    position: Math.max(0, Number(position) || 0)
  }).catch(function (error) { toast(error.message || '无法播放', true); });
}

/* 手机投屏：原生轮询拿到 cast 指令后调这里。
   详情/选集/连播全部走上面 play()，不另起一套播放逻辑。 */
window.hgTvCast = function (cmd) {
  if (!cmd) return;
  var id = String(cmd.seriesId || '');
  var episode = Number(cmd.episode) || 1;
  var position = Number(cmd.position) || 0;
  if (!id) return;
  closeRail();
  if (themePanel) themePanel.hidden = true;
  if (accountPanel) accountPanel.hidden = true;
  state.detailFrom = state.route === 'detail' ? state.detailFrom : 'home';
  state.route = 'detail';
  state.detail = null;
  state.detailProgress = null;
  state.epGroup = Math.floor((episode - 1) / EP_PAGE);
  state.focusKey = 'play';
  stage.scrollTop = 0;
  applyBackdropMode();
  view.innerHTML = '<p class="empty">正在接收手机投屏…</p>';
  api('detail', { id: id }).then(function (data) {
    if (!data) throw new Error('没有取到剧集信息');
    if (state.route !== 'detail') return;
    state.detail = data;
    renderDetail();
    play(data, episode, false, position);
  }).catch(function (error) {
    toast('投屏失败：' + ((error && error.message) || '网络异常'), true);
    go('home');
  });
};
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

/* restore=true：从详情返回，用离开时记下的滚动位置与焦点。
   以前每次回首页都 scrollTop=0 + 焦点归位首页图标，翻了几十张海报再回来
   等于白翻。 */
function go(tab, restore) {
  if (tab === 'adult' || tab === 'category') tab = 'home';   /* 剧场已并进首页 */
  closeRail();
  resetFirstScreen();   /* 首页/我的才需要顶部留白，切页先复位 */
  var mem = (restore && state.memory[tab]) ? state.memory[tab] : null;
  state.pendingRestore = mem ? { scrollTop: mem.scrollTop || 0, focusKey: mem.focusKey || '' } : null;
  if (!mem) stage.scrollTop = 0;
  if (tab === 'home') {
    state.route = 'home';
    state.focusKey = mem ? mem.focusKey : '';
    setActiveNav('home'); renderHome();
    if (!state.feed) loadFeed(state.feedId || categoryList()[0][0], true, false);
  } else if (tab === 'search') {
    state.route = 'search';
    state.focusKey = mem ? mem.focusKey : 'search-box';
    setActiveNav('search'); renderSearch();
  } else if (tab === 'library') {
    state.route = 'library';
    state.focusKey = mem ? mem.focusKey : ('tab:' + state.libraryTab);
    setActiveNav('library'); renderLibrary();
    loadLibrary();
    if (state.libraryTab === 'nas') loadNas();
  }
  applyBackdropMode();
  applyPendingRestore();
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

  /* 参数行上左右 = 调值（不是移焦点）。长按会连发，正好用来快速拖到底。
     上下仍然走 move()，所以「一行行翻、左右微调」是同一套手感。 */
  var tuneKey = focused && focused.getAttribute ? focused.getAttribute('data-tune') : null;
  if (tuneKey && (code === 21 || code === 22)) {
    adjustTune(tuneKey, code === 22 ? 1 : -1);
    return;
  }

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
  if (otpPanel && !otpPanel.hidden) { closeOtp(); state.focusKey = 'acct:mode'; restoreFocus(); return true; }
  if (sourcePanel && !sourcePanel.hidden) { closeSourcePanel(); return true; }
  if (proxyPanel && !proxyPanel.hidden) { closeProxy(); return true; }
  if (themePanel && !themePanel.hidden) { closeTheme(); return true; }
  if (updateLayer && !updateLayer.hidden) { closeUpdatePanel(); return true; }
  /* 没登录就停在登录页：返回直接交给原生弹退出确认，不能靠返回键绕过去 */
  if (!loginLayer.hidden) return false;
  if (accountPanel && !accountPanel.hidden) { accountPanel.hidden = true; state.focusKey = 'nav:account'; restoreFocus(); return true; }
  var active = document.activeElement;
  if (active && active.tagName === 'INPUT') {
    active.blur();
    try { window.AndroidHost.setTvCapture(true); } catch (error) { }
    return true;
  }
  /* 侧栏是临时呼出的：开着的时候先按返回 = 收回去，不是退页面 */
  if (railOpen()) { leaveRail(); return true; }
  if (state.route === 'detail') {
    var back = state.detailFrom || 'home';
    state.route = back;
    state.focusKey = '';
    go(back === 'search' ? 'search' : back === 'library' ? 'library' : back === 'category' ? 'adult' : 'home', true);
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
  if (chip) { loadFeed(chip.dataset.chip, true); return; }

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
  if (tab) {
    state.libraryTab = tab.dataset.tab;
    state.focusKey = 'tab:' + state.libraryTab;
    renderLibrary();
    if (state.libraryTab === 'nas') loadNas();
    return;
  }

  var playButton = target.closest('[data-play]');
  if (playButton) {
    var plan = resumePlan();
    play(state.detail, plan ? plan.episode : 1, plan ? plan.restart : false);
    return;
  }

  var restart = target.closest('[data-restart]');
  if (restart) { play(state.detail, 1, true); return; }

  var recent = target.closest('[data-recent]');
  if (recent) { runSearch(recent.dataset.recent); return; }

  var nasCard = target.closest('[data-nas]');
  if (nasCard) {
    if (nasCard.dataset.nasReady !== '1') { toast('这部还没下载完，等它下载好再播'); return; }
    playNas(nasCard.dataset.nas);
    return;
  }

  var bookmark = target.closest('[data-bookmark]');
  if (bookmark) { toggleBookmark(); return; }

  var episode = target.closest('[data-episode]');
  if (episode) { play(state.detail, Number(episode.dataset.episode)); return; }

  if (target.closest('[data-account]')) { openAccount(); return; }
  if (target.closest('#account-theme')) { openTheme(); return; }
  if (target.closest('#theme-close')) { closeTheme(); return; }
  if (target.closest('[data-tune-reset]')) { resetHero(); return; }
  var swatch = target.closest('[data-theme-key]');
  if (swatch) {
    var picked = applyTheme(swatch.dataset.themeKey);
    renderThemeGrid();
    state.focusKey = 'theme:' + picked;
    restoreFocus();
    for (var ti = 0; ti < THEMES.length; ti++) {
      if (THEMES[ti].key === picked) { toast('已切换：' + THEMES[ti].name); break; }
    }
    return;
  }
  if (target.closest('#account-close')) { closeAccount(); return; }
  if (target.closest('#account-mode')) { switchMode(); return; }
  if (target.closest('#account-source')) { openSourcePanel(); return; }
  if (target.closest('#account-proxy')) { openProxy(); return; }
  if (target.closest('#source-close')) { closeSourcePanel(); return; }
  var sitePick = target.closest('[data-site-pick]');
  if (sitePick) { pickSite(sitePick.getAttribute('data-site-pick'), sitePick.getAttribute('data-site-name')); return; }
  var proxyModeBtn = target.closest('[data-proxy-mode]');
  if (proxyModeBtn) { selectProxyMode(Number(proxyModeBtn.getAttribute('data-proxy-mode')) || 3); return; }
  if (target.closest('#proxy-save')) { saveProxyAddress(false); return; }
  if (target.closest('#proxy-close')) { closeProxy(); return; }
  /* 地址框：把按键交还系统 IME，跟搜索框同一套（电视遥控器打字难，能扫码就扫码） */
  if (target.closest('.proxy-input')) {
    var proxyField = document.getElementById('proxy-address');
    if (proxyField) {
      try { window.AndroidHost.setTvCapture(false); } catch (error) { }
      try { proxyField.focus(); } catch (error) { }
    }
    return;
  }
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
  var name = state.account.loggedIn ? (state.account.username || '已登录') : '';
  if (!railAvatar) return;
  /* 手机端设置过头像的话，账号资料里带 avatar（jpeg 的 data URL），
     直接铺满左下角那个圆；没有头像才退回首字母。 */
  var avatar = state.account.loggedIn ? String(state.account.avatar || '') : '';
  if (avatar) {
    railAvatar.innerHTML = '<img alt="">';
    var img = railAvatar.querySelector('img');
    img.onerror = function () {
      railAvatar.textContent = name ? name.slice(0, 1).toUpperCase() : '?';
    };
    img.src = avatar;
  } else {
    railAvatar.innerHTML = '';
    railAvatar.textContent = name ? name.slice(0, 1).toUpperCase() : '?';
  }
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
    tip.textContent = '用手机 Veyra → 我的 → 账号管理 → 去扫码登录（' + info.host + ':' + info.port + '）';
  } catch (error) {
    box.hidden = true;
    retry.hidden = false;
    tip.textContent = '二维码生成失败，按 OK 重试';
  }
}

window.hgTvLogin = function (ok) {
  if (!ok) { toast('登录没成功，重新扫一次', true); showLoginQr(); return; }
  /* 扫码登录是服务端才知道账号，顺手把头像一起拉下来 */
  api('refresh-account').then(function (profile) {
    if (!profile || !profile.loggedIn) return api('account');
    return profile;
  }).then(function (profile) {
    setAccount(profile);
    if (profile && profile.loggedIn) {
      loginLayer.hidden = true;
      toast('已登录');
      if (!state.feed) loadFeed(state.feedId || categoryList()[0][0], true, false);
      loadLibrary();
      state.focusKey = 'nav:home';
      restoreFocus();
    }
  }).catch(function () { });
};

/* 当前私密源要在首屏渲染前拿到：接口型源的两级 tab 跟黄果不一样 */
api('private-site').then(function (data) {
  if (!data || !data.id) return;
  privateSite = { id: data.id, name: data.name || data.id };
  if (data.id !== 'huangguo' && typeof applySiteCategories === 'function') applySiteCategories();
}).catch(function () { });

/* ---------------- 黄果网络通道：直连 / 代理 / 后端转发 ----------------
   跟手机端同一套原生设置（ProxySettings），电视上选完就是同一份配置，
   私密内容下次请求立刻按新模式走，不用重启。 */
var sourcePanel = document.getElementById('source');
var sourceListEl = document.getElementById('source-list');
var privateSite = { id: 'huangguo', name: '黄果' };
var proxyPanel = document.getElementById('proxy');
var proxyModesEl = document.getElementById('proxy-modes');
var proxyAddressInput = document.getElementById('proxy-address');
var proxyQrBox = document.getElementById('proxy-qr');
var proxyMode = 3;
var proxyAddress = '';
var proxyQrCache = { url: '', html: '' };
var PROXY_MODE_NAMES = { 1: '仅直连', 2: '仅代理', 3: '走后端转发' };

/* 走后端转发只有管理员/特权组能用；普通用户点上去给一句人话，而不是静默失败 */
function roleCanUseBackend() {
  var role = String((state.account && state.account.role) || 'user');
  return role === 'admin' || role === 'vip';
}

function renderProxyModes() {
  if (!proxyModesEl) return;
  var nodes = proxyModesEl.querySelectorAll('[data-proxy-mode]');
  for (var i = 0; i < nodes.length; i++) {
    var value = Number(nodes[i].getAttribute('data-proxy-mode'));
    if (value === proxyMode) nodes[i].classList.add('is-active');
    else nodes[i].classList.remove('is-active');
    /* 不能选的模式不禁用（禁用后焦点直接跳过去，用户看不到原因），
       只在文字上标一句，点的时候再提示。 */
    var small = nodes[i].querySelector('small');
    if (small && value === 3) {
      small.textContent = roleCanUseBackend()
        ? '全部经后端中转（仅管理员与特权组）'
        : '全部经后端中转 · 当前账号不可用';
    }
  }
}

function relayUrl() {
  var info = null;
  try { info = JSON.parse(window.AndroidHost.relayInfo()); } catch (error) { }
  return info && info.url ? info.url : '';
}

function renderProxyQr() {
  if (!proxyQrBox) return;
  var url = relayUrl();
  if (!url) {
    proxyQrBox.className = 'proxy-qr proxy-qr-empty';
    proxyQrBox.innerHTML = '电视没连上局域网<br>可以先点地址框用键盘输';
    return;
  }
  if (proxyQrCache.url !== url) {
    try {
      var qr = window.qrcode(0, 'M');
      qr.addData(url);
      qr.make();
      proxyQrCache = { url: url, html: qr.createSvgTag({ cellSize: 4, margin: 1, scalable: true }) };
    } catch (error) {
      proxyQrBox.className = 'proxy-qr proxy-qr-empty';
      proxyQrBox.innerHTML = '二维码生成失败';
      return;
    }
  }
  proxyQrBox.className = 'proxy-qr';
  proxyQrBox.innerHTML = proxyQrCache.html;
}

function paintProxyAddress() {
  if (proxyAddressInput && proxyAddressInput.value !== proxyAddress) proxyAddressInput.value = proxyAddress;
}

function saveProxyAddress(silent) {
  var value = proxyAddressInput ? String(proxyAddressInput.value || '').trim() : proxyAddress;
  proxyAddress = value;
  return api('set-proxy', { value: value }).then(function () {
    if (!silent) toast(value ? '代理地址已保存' : '代理地址已清空');
  }).catch(function (error) {
    toast((error && error.message) || '代理地址保存失败', true);
  });
}

function selectProxyMode(value) {
  if (value === 3 && !roleCanUseBackend()) {
    toast('走后端转发仅管理员与特权组可用，请联系管理员', true);
    return;
  }
  api('set-proxy-mode', { value: value }).then(function () {
    proxyMode = value;
    renderProxyModes();
    toast('已切换：' + (PROXY_MODE_NAMES[value] || ''));
    state.focusKey = 'proxy:' + value;
    restoreFocus();
  }).catch(function (error) {
    toast((error && error.message) || '切换失败', true);
  });
}

/* ---------------- 私密内容源 ----------------
   黄果是端侧解析（三通道），其余源走后端网关。
   切完清掉 feed 缓存并回首页，遥控器不用再做别的。 */
function renderSourceList(sources) {
  if (!sourceListEl) return;
  var rows = [{ id: 'huangguo', name: '黄果', description: '视频 · AI · 旧版（直连 / 代理 / 后端）' }];
  for (var i = 0; i < sources.length; i++) {
    var row = sources[i] || {};
    if (!row.id || row.id === 'huangguo') continue;
    rows.push({ id: row.id, name: row.name || row.id, description: row.description || '' });
  }
  var html = '';
  for (var j = 0; j < rows.length; j++) {
    var item = rows[j];
    var active = item.id === privateSite.id;
    html += '<button type="button" class="source-item' + (active ? ' is-active' : '') + '" data-focusable'
      + ' data-key="source:' + esc(item.id) + '" data-site-pick="' + esc(item.id) + '" data-site-name="' + esc(item.name) + '">'
      + '<strong>' + esc(item.name) + '</strong><small>' + esc(item.description) + '</small></button>';
  }
  sourceListEl.innerHTML = html;
}

function openSourcePanel() {
  if (accountPanel) accountPanel.hidden = true;
  if (sourcePanel) sourcePanel.hidden = false;
  renderSourceList([]);
  state.focusKey = 'source:' + privateSite.id;
  restoreFocus();
  api('private-sites').then(function (data) {
    renderSourceList((data && data.sources) || []);
    state.focusKey = 'source:' + privateSite.id;
    restoreFocus();
  }).catch(function () { });
}

function closeSourcePanel() {
  if (sourcePanel) sourcePanel.hidden = true;
  if (accountPanel) accountPanel.hidden = false;
  state.focusKey = 'acct:source';
  restoreFocus();
}

function pickSite(id, name) {
  if (!id || id === privateSite.id) { closeSourcePanel(); return; }
  api('private-site', { id: id, name: name || id }).then(function (result) {
    privateSite = { id: (result && result.id) || id, name: (result && result.name) || name || id };
    closeSourcePanel();
    toast('已切换到 ' + privateSite.name);
    /* 上一个源的首页缓存不能留：不清的话会先闪一遍别的源的内容 */
    try {
      for (var i = localStorage.length - 1; i >= 0; i--) {
        var key = localStorage.key(i);
        if (key && key.indexOf('veyra-tv-feed-') === 0) localStorage.removeItem(key);
      }
    } catch (error) { }
    state.feed = null;
    go('home');
  }).catch(function (error) {
    toast((error && error.message) || '切换失败', true);
  });
}

function openProxy() {
  if (accountPanel) accountPanel.hidden = true;
  if (proxyPanel) proxyPanel.hidden = false;
  paintProxyAddress();
  renderProxyModes();
  renderProxyQr();
  state.focusKey = 'proxy:' + proxyMode;
  restoreFocus();
  api('get-proxy-mode').then(function (value) {
    var mode = Number(value) || 3;
    if (mode === proxyMode) return;
    proxyMode = mode;
    renderProxyModes();
  }).catch(function () { });
  api('get-proxy').then(function (value) {
    proxyAddress = String(value || '');
    paintProxyAddress();
  }).catch(function () { });
}

function closeProxy() {
  if (proxyPanel) proxyPanel.hidden = true;
  if (accountPanel) accountPanel.hidden = false;
  state.focusKey = 'acct:proxy';
  restoreFocus();
}

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
    else modeBtn.textContent = '进入私密模式（需动态码）';
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
  state.feed = null;
  /* 分类 id 是按内容源分的：公开源是 short/comic，私密源是 ai-duanju/ai-manju/…
     沿用旧 id 过去，后端只会回一句「无效分类」，界面停在空列表上，
     必须点一下顶部小标题才重新按新 id 拉 —— 就是「进来什么都没有」的原因。 */
  state.feedId = '';
  state.library = null;
  state.nas = null;
  state.detail = null;
  if (accountPanel) accountPanel.hidden = true;
  toast(state.source === 'huangguo' ? '已进入私密内容' : '已返回公开内容');
  state.route = 'home';
  state.focusKey = 'nav:home';
  setActiveNav('home');
  renderHome();
  loadFeed(state.feedId || categoryList()[0][0], true, false);
}

/* ---------------- 私密模式：电视端每次都要动态码 ----------------
   手机端验证一次会永久解锁（跟账号走），电视是家里共用的屏幕，
   所以这里不看「已解锁」标记，每次进入都重新验一次 6 位码。 */
function renderOtp() {
  if (otpCells) {
    var cells = '';
    for (var i = 0; i < 6; i++) {
      var digit = otpCode.charAt(i);
      cells += '<i class="' + (digit ? 'fill' : '') + '">' + (digit || '') + '</i>';
    }
    otpCells.innerHTML = cells;
  }
  if (otpKeys && !otpKeys.childNodes.length) {
    var keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'del', '0', 'clear'];
    var html = '';
    for (var k = 0; k < keys.length; k++) {
      var label = keys[k] === 'del' ? '删除' : (keys[k] === 'clear' ? '清空' : keys[k]);
      html += '<button type="button" data-focusable data-key="otp:' + keys[k] + '">' + label + '</button>';
    }
    otpKeys.innerHTML = html;
    otpKeys.addEventListener('click', function (event) {
      var btn = event.target && event.target.closest ? event.target.closest('button') : null;
      if (!btn) return;
      pressOtp((btn.dataset.key || '').replace('otp:', ''));
    });
  }
}

function openOtp() {
  otpCode = '';
  otpBusy = false;
  if (otpError) otpError.textContent = '';
  renderOtp();
  if (accountPanel) accountPanel.hidden = true;
  if (otpPanel) otpPanel.hidden = false;
  var first = otpKeys ? otpKeys.querySelector('button') : null;
  if (first) focusElement(first);
}

function closeOtp() {
  if (otpPanel) otpPanel.hidden = true;
  otpCode = '';
  if (otpError) otpError.textContent = '';
}

function pressOtp(key) {
  if (otpBusy) return;
  // 6 位输满会自动提交，所以这里不需要「确定」；空出来的位置给「清空」
  if (key === 'clear') { otpCode = ''; renderOtp(); if (otpError) otpError.textContent = ''; return; }
  if (key === 'del') otpCode = otpCode.slice(0, -1);
  else if (/^\d$/.test(key) && otpCode.length < 6) otpCode += key;
  if (otpError) otpError.textContent = '';
  renderOtp();
  if (otpCode.length === 6) submitOtp();
}

function submitOtp() {
  if (otpBusy || otpCode.length !== 6) return;
  otpBusy = true;
  api('enter-private', { password: otpCode, forceOtp: true }).then(function (result) {
    if (result && result.needsAgeConfirmation) return api('confirm-private-age');
    return result;
  }).then(function (status) {
    otpBusy = false;
    closeOtp();
    // 动态码通过后先放启动动画，播完再切私密内容
    var intro = window.veyraIntro ? window.veyraIntro.play() : null;
    return intro ? intro.then(function () { return status; }) : status;
  }).then(function (status) {
    applyMode(status, 'huangguo');
  }).catch(function (error) {
    otpBusy = false;
    otpCode = '';
    renderOtp();
    if (otpError) otpError.textContent = (error && error.message) || '动态码不正确，请重试';
  });
}

function switchMode() {
  var leaving = state.source === 'huangguo';
  if (!leaving) { openOtp(); return; }
  var job = api('leave-private');
  job.then(function (status) {
    applyMode(status, leaving ? 'hongguo' : 'huangguo');
  }).catch(function (error) {
    var message = error && error.message ? error.message : '切换失败';
    if (/动态码|验证|otp/i.test(message)) message = '动态码校验失败，请重试';
    toast(message, true);
  });
}

function logout() {
  api('logout').then(function (profile) {
    setAccount(profile);
    if (accountPanel) accountPanel.hidden = true;
    state.home = null;
    state.library = null;
    state.feed = null;
    state.nas = null;
    state.detail = null;
    toast('已退出登录');
    state.route = 'home';
    state.focusKey = 'nav:home';
    setActiveNav('home');
    renderHome();
    loadFeed(state.feedId || categoryList()[0][0], true, false);
    loginLayer.hidden = false;
    showLoginQr();
    state.focusKey = 'login:retry';
    restoreFocus();
  }).catch(function (error) { toast(error.message || '退出失败', true); });
}

/* 手机「扫码输入」传过来的文字：直接填进搜索框并搜 */
window.veyraRelayFill = function (text) {
  /* 黄果通道面板开着：手机推过来的就是代理地址，填进地址框并直接保存
     （电视遥控器输 host:port 太痛苦，扫码是主要输入方式）。 */
  if (proxyPanel && !proxyPanel.hidden) {
    proxyAddress = String(text == null ? '' : text).trim();
    paintProxyAddress();
    saveProxyAddress(true).then(function () {
      toast(proxyAddress ? '代理地址已填入并保存' : '代理地址已清空');
    });
    state.focusKey = 'proxy:addr';
    restoreFocus();
    return;
  }
  if (state.route !== 'search') go('search');
  var input = document.getElementById('search-input');
  if (input) input.value = text || '';
  if (text) runSearch(String(text).trim());
};

/* ---------------- 回到前台 ----------------
   原生的 onResume 会调这个（MainActivity 里一直有，但电视端页面没实现，
   等于什么都没做）。从播放器退回来、或切后台再回来时，必须重新取一遍：
   · 详情页的「继续播放」—— 否则看完三集回来，按钮还停在进来之前那一集
   · 「我的」—— 否则收藏/观看记录是上次进页面时的旧数据 */
window.hgResume = function () {
  if (state.route === 'detail' && state.detail) {
    var id = String(state.detail.id);
    api('latest-progress', { id: id }).then(function (progress) {
      if (state.route !== 'detail' || !state.detail || String(state.detail.id) !== id) return;
      var before = JSON.stringify(state.detailProgress || null);
      state.detailProgress = progress || null;
      if (JSON.stringify(state.detailProgress) !== before) renderDetail();
    }).catch(function () { });
    api('bookmark-state', { id: id }).then(function (saved) {
      if (state.route !== 'detail' || !state.detail || String(state.detail.id) !== id) return;
      if (!!state.detail.bookmarked === !!saved) return;
      state.detail.bookmarked = !!saved;
      renderDetail();
    }).catch(function () { });
  }
  if (state.route === 'home' || state.route === 'library') loadLibrary();
};

/* 手机扫码上传完成：原生把压缩后的 data URL 推过来，直接换背景 */
window.veyraTvBgUpdated = function (dataUrl) {
  if (!dataUrl) { toast('这张图没读出来，换一张试试', true); return; }
  customSrc = dataUrl;
  if (customBgOn()) applyBackdropMode();
  syncTunePreview();
  toast('背景已更新');
};

/* ---------------- 启动 ---------------- */
function boot() {
  view.innerHTML = '<p class="empty">正在启动…</p>';
  /* 主题必须在首屏渲染前定下来，否则会先闪一下默认配色 */
  applyTheme(currentTheme());
  applyBackdropMode();
  try { window.AndroidHost.setTvCapture(true); } catch (error) { }
  if (window.__tvApplyScale) window.__tvApplyScale();
  /* 字体随视口缩放，卡片尺寸也跟着变：窗口尺寸变了要重算首屏顶部留白 */
  window.addEventListener('resize', function () { setTimeout(layoutFirstScreen, 120); });
  restoreSearch();
  observeStageEnd();
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
    /* 头像只存在手机上：本地资料里没有就向服务端要一次（refresh-account 会顺带把
       头像图下下来，返回 base64），下到了再换掉左下角那个字母。 */
    if (results[1] && results[1].loggedIn) {
      api('refresh-account').then(function (profile) {
        if (profile && profile.loggedIn) setAccount(profile);
      }).catch(function () { });
    }
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
