'use strict';

const callbacks = new Map();
let requestNumber = 0;
let contentSource = 'hongguo';
let contentReady;
const bridgeInstance = Date.now() + '-' + Math.random().toString(36).slice(2);
const privateMode = () => contentSource === 'huangguo';
window.NativeCallbacks = {
  resolve(id, value) { callbacks.get(id)?.resolve(value); callbacks.delete(id); },
  reject(id, message) { callbacks.get(id)?.reject(new Error(message)); callbacks.delete(id); }
};
function api(action, args = {}) {
  const request = () => new Promise((resolve, reject) => {
    const id = bridgeInstance + ':' + (++requestNumber);
    callbacks.set(id, { resolve, reject });
    try { AndroidHost.request(id, action, JSON.stringify({ ...args, source: contentSource })); }
    catch (error) { callbacks.delete(id); reject(error); }
  });
  return contentReady ? contentReady.then(request) : request();
}

const scroll = document.getElementById('scroll');
const content = document.getElementById('content');
const avatarButton = document.getElementById('account-avatar');
const avatarImage = document.getElementById('account-avatar-image');
const authOverlay = document.getElementById('auth-overlay');
const compact = document.getElementById('compact-category');
const toastHost = document.getElementById('toast-host');
const updateOverlay = document.getElementById('update-overlay');
const updateDownloadButton = document.getElementById('update-download');
const updateLaterButton = document.getElementById('update-later');
const searchInput = document.getElementById('search-input');
const headerSettings = document.getElementById('header-settings');
const confirmOverlay = document.getElementById('confirm-overlay');
const unlockOverlay = document.getElementById('unlock-overlay');
const downloadOverlay = document.getElementById('download-overlay');
const categoryIds = { adult: ['ai-duanju', 'ai-manju'], ai: ['ai-huanlian', 'ai-mogai'] };
const popularTags = [
  ['dushi', '都市'], ['xiaoyuan', '校园'], ['gufeng', '古风'], ['haomen', '豪门'],
  ['chuanyue', '穿越'], ['chongsheng', '重生'], ['qihuan', '奇幻'], ['zhichang', '职场']
];
const publicPopularTags = [
  ['short:romance', '爱情'], ['short:period', '年代'], ['short:comeback', '逆袭'], ['short:suspense', '悬疑'],
  ['comic:creative', '脑洞'], ['comic:fantasy', '玄幻'], ['comic:apocalypse', '末世'], ['comic:adventure', '冒险']
];
const tagGroups = [
  ['popular', '热门类型'], ['story', '故事题材'], ['setting', '场景与身份'],
  ['relationship', '人物与关系'], ['style', '外形风格'], ['plot', '情节元素'], ['other', '更多标签']
];
const state = {
  route: 'home', tab: 'home', sub: { adult: 0, ai: 0 }, home: null,
  category: null, categoryItems: [], detail: null, detailLoading: false, sourceItem: null,
  search: null, searchPending: false, searchError: '', query: '', filter: 'all', banner: 0, categoryBanner: 0,
  listing: null, tags: null, tagsReturn: null, listingReturn: null, settingsReturn: null,
  libraryTab: 'history', libraryQuery: '', accountReturn: null, account: { loggedIn: false },
  sourceGroup: '', sourceQueue: [], previous: null, compactHeld: false
};
contentReady = api('content-status').then(status => {
  contentSource = status.source || 'hongguo';
  state.privateUnlocked = Boolean(status.unlocked);
  // 启动即拉取黄果网络通道（避免重启后 state.proxyMode 未初始化导致下载误判手机直连）
  try { api('get-proxy-mode').then(v => { state.proxyMode = Number(v) || 3; }).catch(() => {}); } catch (ignore) {}
  document.title = 'Veyra';
  if (!privateMode()) {
    categoryIds.adult = ['short']; categoryIds.ai = ['comic'];
    document.querySelector('[data-nav="adult"] > span:last-child').textContent = '短剧';
    document.querySelector('[data-nav="ai"] > span:last-child').textContent = '漫剧';
    searchInput.placeholder = '搜索剧名';
    searchInput.setAttribute('aria-label', '搜索剧名');
  }
  return status;
});

let routeToken = 0;
let toastTimer;
let observer;
let listingObserver;
let categoryObserver;
const screenSnapshots = {};
let predictivePreview;
let predictiveTimer;
let predictiveSourceNode;
let predictiveFrame;
let pendingPredictiveProgress = 0;
let detailCard;
const coverRequests = new Map();
let bannerChanging = false;
let bannerTimer;
let lastDockTap = { tab: '', at: 0, navigated: false };
let updateChecking = false;
let updateDownloading = false;
let updateAvailable = null;
let appVersion = '';

const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const asArray = value => Array.isArray(value) ? value : [];
const icon = name => {
  const paths = {
    play: '<path d="m8 5 11 7-11 7z"/>',
    arrow: '<path d="m9 5 7 7-7 7"/>',
    back: '<path d="m15 5-7 7 7 7"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'
  };
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
};

function toast(message, info = false) {
  clearTimeout(toastTimer);
  toastHost.innerHTML = `<div class="toast ${info ? 'info' : ''}"><i></i><span>${esc(message)}</span></div>`;
  toastHost.classList.add('visible');
  toastTimer = setTimeout(() => toastHost.classList.remove('visible'), 3000);
}

let finishConfirmation;
function closeConfirmation(accepted) {
  if (confirmOverlay.hidden) return;
  confirmOverlay.hidden = true;
  updateBackEnabled();
  finishConfirmation?.(accepted);
  finishConfirmation = null;
}
function askConfirmation(title, message, action = '清空') {
  document.getElementById('confirm-title').textContent = title;
  document.getElementById('confirm-message').textContent = message;
  document.getElementById('confirm-accept').textContent = action;
  confirmOverlay.hidden = false;
  updateBackEnabled();
  document.getElementById('confirm-cancel').focus();
  return new Promise(resolve => { finishConfirmation = resolve; });
}
document.getElementById('confirm-cancel').addEventListener('click', () => closeConfirmation(false));
document.getElementById('confirm-accept').addEventListener('click', () => closeConfirmation(true));
confirmOverlay.addEventListener('click', event => { if (event.target === confirmOverlay) closeConfirmation(false); });

function setAccount(profile) {
  const next = profile || { loggedIn: false };
  if (JSON.stringify(state.account) === JSON.stringify(next)) return;
  const savedScroll = scroll.scrollTop;
  const userChanged = state.account.userId !== next.userId;
  state.account = next;
  if (userChanged) { state.library = null; if (state.route === 'home') { updateContinueWatching(); refreshHomeHistory(); } }
  avatarImage.hidden = !profile?.avatar;
  avatarButton.querySelector('.account-avatar-default').hidden = Boolean(profile?.avatar);
  if (profile?.avatar) avatarImage.src = profile.avatar;
  else avatarImage.removeAttribute('src');
  avatarButton.classList.toggle('is-signed-in', Boolean(profile?.loggedIn));
  avatarButton.setAttribute('aria-label', profile?.loggedIn ? `打开${profile.username}的账号管理` : '登录账号');
  const roleBadge = document.getElementById('account-role-badge');
  if (roleBadge) {
    const role = profile?.role === 'admin' ? 'admin' : profile?.role === 'vip' ? 'vip' : 'user';
    roleBadge.textContent = role === 'admin' ? '管理员' : role === 'vip' ? '特权组' : '普通用户';
    roleBadge.classList.toggle('is-admin', role === 'admin');
    roleBadge.classList.toggle('is-vip', role === 'vip');
    roleBadge.hidden = !profile?.loggedIn;
  }
  if (state.route === 'library') renderLibrary();
  if (state.route === 'settings') renderSettings();
  if (state.route === 'account-management' && !content.querySelector('#password-form')?.contains(document.activeElement)) renderAccountManagement();
  scroll.scrollTop = savedScroll;
}
api('account').then(profile => {
  setAccount(profile);
  if (!profile?.loggedIn) showAuth(); // 强制登录：未登录必须先登录/注册才能使用
}).catch(() => showAuth());
api('server-base').then(serverBase => {
  const input = document.getElementById('auth-server');
  if (input && !input.value) input.value = String(serverBase || '').replace(/\/+$/, '');
}).catch(() => {});
window.hgWindowInsets = height => {
  document.getElementById('app').style.setProperty('--status-bar-height', `${Math.max(0, Number(height) || 0)}px`);
};
api('window-insets').then(window.hgWindowInsets).catch(() => {});
api('screen-corners').then(corners => {
  const app = document.getElementById('app');
  for (const name of ['topLeft', 'topRight', 'bottomRight', 'bottomLeft']) {
    const radius = Number(corners?.[name]);
    if (radius > 0) app.style.setProperty(`--screen-corner-${name}`, `${radius}px`);
  }
}).catch(() => {});

let authMode = 'login';
let authPending = false;
function setAuthPending(pending, mode = authMode) {
  const submit = document.getElementById('auth-submit');
  submit.disabled = pending;
  submit.classList.toggle('is-loading', pending);
  submit.setAttribute('aria-busy', String(pending));
  submit.textContent = pending ? (mode === 'login' ? '正在登录…' : '正在注册…') : (mode === 'login' ? '登录' : '注册并登录');
  document.querySelectorAll('[data-auth-mode]').forEach(button => { button.disabled = pending; });
}
function showAuth(mode = 'login') {
  if (authPending) mode = authMode;
  authMode = mode;
  authOverlay.hidden = false;
  updateBackEnabled();
  document.getElementById('auth-title').textContent = mode === 'login' ? '登录应用账号' : '注册应用账号';
  setAuthPending(authPending, mode);
  document.getElementById('auth-password').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  const codeField = document.getElementById('auth-code');
  const codeLabel = document.getElementById('auth-code-label');
  if (codeField) { codeField.hidden = mode !== 'register'; codeField.required = mode === 'register'; codeField.value = ''; }
  if (codeLabel) codeLabel.hidden = mode !== 'register';
  document.querySelectorAll('[data-auth-mode]').forEach(button => button.classList.toggle('selected', button.dataset.authMode === mode));
  document.getElementById('auth-error').hidden = true;
}
function hideAuth() {
  authOverlay.hidden = true;
  updateBackEnabled();
  document.getElementById('auth-form').reset();
}
avatarButton.addEventListener('click', () => {
  if (state.account.loggedIn) goAccountManagement();
  else showAuth();
});
headerSettings.addEventListener('click', goSettings);
document.querySelectorAll('[data-auth-mode]').forEach(button => button.addEventListener('click', () => showAuth(button.dataset.authMode)));
document.getElementById('auth-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (authPending) return;
  const mode = authMode;
  const username = document.getElementById('auth-username').value.trim();
  const password = document.getElementById('auth-password').value;
  const server = document.getElementById('auth-server').value.trim();
  const error = document.getElementById('auth-error');
  authPending = true;
  setAuthPending(true, mode);
  error.hidden = true;
  try {
    if (mode === 'register') {
      const code = document.getElementById('auth-code')?.value.trim() || '';
      if (!/^\d{6}$/.test(code)) throw new Error('注册需要管理员提供的 6 位动态码');
      await api('verify-otp-public', { code, server }); // 先验证动态码，通过才允许注册
    }
    const profile = await api(mode, { username, password, server, code: mode === 'register' ? (document.getElementById('auth-code')?.value.trim() || '') : undefined });
    hideAuth();
    setAccount(profile);
    if (state.route === 'library') goLibrary(state.libraryTab);
    toast(mode === 'login' ? '登录成功，片单正在同步' : '注册成功，片单正在同步');
  } catch (failure) {
    if (authOverlay.hidden) toast(failure.message || '请稍后重试', true);
    else { error.textContent = failure.message || '请稍后重试'; error.hidden = false; }
  } finally { authPending = false; setAuthPending(false, mode); }
});
window.hgAccountRefreshed = profile => {
  if (profile?.userId && state.account.userId === profile.userId) setAccount(profile);
};
window.hgAvatarUpdated = profile => { setAccount(profile); toast('头像已更新'); };
window.hgAvatarError = message => toast(message || '头像保存失败', true);
window.hgCloudSynced = () => {
  if (state.route === 'home') refreshHomeHistory();
  else if (state.route === 'library') {
    const token = routeToken;
    api('library').then(data => { if (token !== routeToken) return; state.library = data; renderLibrary(); }).catch(() => {});
  }
};

function setAvailableUpdate(result) {
  updateAvailable = result?.status === 'available' ? result : null;
  headerSettings.classList.toggle('has-update', Boolean(updateAvailable));
  const versionButton = content.querySelector('.app-version');
  if (versionButton) {
    versionButton.classList.toggle('has-update', Boolean(updateAvailable));
    versionButton.setAttribute('aria-label', updateAvailable ? `当前版本 ${appVersion}，发现新版 ${updateAvailable.version}，查看更新` : `当前版本 ${appVersion}，检查更新`);
  }
}

function showUpdate(result) {
  document.getElementById('update-version').textContent = `当前 ${result.currentVersion} · 新版 ${result.version}`;
  const notes = document.getElementById('update-notes');
  notes.textContent = String(result.notes || '').trim().slice(0, 1200);
  notes.hidden = !notes.textContent;
  document.getElementById('update-progress').hidden = true;
  updateDownloadButton.textContent = '立即下载';
  updateDownloadButton.disabled = false;
  // 弹窗重新显示时把左按钮复位成静态文案，别残留上一轮的“后台下载”。
  updateLaterButton.textContent = '取消';
  updateLaterButton.disabled = false;
  // 【修复 Bug1】z-index 已提到所有弹层之上；再把节点挪到 #app 末尾，
  // 保证同一层叠上下文里 DOM 顺序也最高，不会被页面内容或其它 overlay 挡住。
  const appRoot = document.getElementById('app');
  if (appRoot) appRoot.appendChild(updateOverlay);
  updateOverlay.hidden = false;
  updateBackEnabled();
}

async function checkUpdate(manual) {
  if (updateDownloading) { if (manual) toast('更新包正在下载', true); return; }
  if (updateChecking) { if (manual) toast('正在检查更新', true); return; }
  updateChecking = true;
  try {
    const result = await api('check-update', { manual });
    if (result.status === 'available') {
      setAvailableUpdate(result);
      if (manual) { showUpdate(result); return; }
      // 启动自动模式：静默下载更新包，完成后弹窗提示安装（无需手动点检测）
      try {
        await api('download-update');
        showUpdate(result);
      } catch (ignore) {
        showUpdate(result); // 下载失败也弹窗，按钮可重试
      }
    } else if (result.status === 'current' || result.status === 'unpublished' || result.status === 'none') {
      setAvailableUpdate(null);
      if (manual && result.status === 'current') toast(`已是最新版本 ${result.version}`);
      if (manual && result.status === 'unpublished') toast('暂未发布更新包', true);
    }
    else if (manual && result.status === 'unconfigured') toast('暂未发布更新包', true);
    else if (manual && result.status === 'throttled') toast('一小时内最多手动检查 5 次，请稍后再试', true);
  } catch (error) {
    if (manual) toast(error.message || '检查更新失败，请稍后重试', true);
  } finally { updateChecking = false; }
}

window.hgUpdateProgress = percent => {
  document.getElementById('update-progress').hidden = false;
  document.getElementById('update-percent').textContent = `${percent}%`;
  document.getElementById('update-fill').style.transform = `scaleX(${percent / 100})`;
};
window.hgUpdateInstallPermissionDenied = () => toast('请允许此应用安装更新包后重试', true);
window.hgUpdateInstallError = () => toast('无法打开系统安装程序，请重试', true);

updateDownloadButton.addEventListener('click', async () => {
  if (updateDownloading) return;
  updateDownloading = true;
  updateDownloadButton.disabled = true;
  // 【修复 Bug2】下载期间不再禁用取消入口。左键是“转到后台”的动作入口，
  // 所以保持动作文案“后台下载”；只有点了它之后才进入后台下载状态。
  updateLaterButton.textContent = '后台下载';
  updateDownloadButton.textContent = '正在下载…';
  window.hgUpdateProgress(0);
  try {
    await api('download-update');
    // 原生侧 download-update 返回前已自动拉起系统安装页（缺权限时先跳授权页），
    // 这里收起弹窗，避免 WebView 盖在系统安装界面下面。
    updateOverlay.hidden = true;
    updateDownloadButton.textContent = '立即下载';
    updateLaterButton.textContent = '取消';
    toast('下载完成，正在打开安装程序');
  } catch (error) {
    updateDownloadButton.textContent = '重试下载';
    updateLaterButton.textContent = '取消';
    toast(error.message || '下载失败，请重试', true);
  } finally {
    updateDownloading = false;
    updateDownloadButton.disabled = false;
    updateLaterButton.disabled = false;
    updateBackEnabled();
  }
});
updateLaterButton.addEventListener('click', () => {
  // 【修复 Bug2】正在下载也允许关闭：下载在原生线程继续，完成后照常弹出安装。
  updateOverlay.hidden = true;
  updateBackEnabled();
  if (updateDownloading) toast('已转入后台下载，完成后会自动弹出安装', true);
});

window.hgTheme = dark => {
  // 外观（明暗/质感/配色/圆角）现在由 appearance.js 管理并存在 localStorage：
  // 用户在本机选过就以本地为准，否则跟随原生传来的系统主题，并把结果记下来当初始值。
  const A = window.VeyraAppearance;
  if (A) {
    let saved = null;
    try { saved = localStorage.getItem('veyra.appearance.v1'); } catch (e) {}
    if (!saved) A.set({ theme: dark ? 'dark' : 'light' });
    return;
  }
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
};
api('theme').then(window.hgTheme).catch(() => {});

function itemCard(item) {
  const id = esc(item.id);
  const title = esc(item.title || '影片');
  const info = esc(item.episodeLabel || asArray(item.tags).slice(0, 2).join(' · ') || '打开详情');
  return `<button class="film-card" type="button" data-open-id="${id}" aria-label="查看${title}">
    <span class="poster loading"><span class="poster-letter">${title.slice(0, 1)}</span><img data-cover="${esc(item.cover || '')}" alt=""><span class="poster-score" ${item.score ? '' : 'hidden'}>${esc(item.score || '')}</span></span>
    <span class="film-title">${title}</span><span class="film-info">${info}</span></button>`;
}

function moreCard(kind) {
  return `<button class="film-card more-tile" type="button" data-more="${esc(kind)}" aria-label="查看更多推荐">
    <span class="poster more-poster"><span class="more-tile-label">更多推荐 ${icon('arrow')}</span></span>
    <span class="film-title">查看全部</span><span class="film-info">打开完整列表</span></button>`;
}
function section(title, items, kind = '') {
  if (!items.length) return '';
  // 3×2 固定六格：前 5 个放推荐位，第 6 格就是原来右上角「更多」的入口，板块标题行不再带按钮。
  const cells = items.slice(0, 5).map(itemCard);
  if (kind) cells.push(moreCard(kind));
  return `<section class="film-section"><div class="section-heading"><h2>${esc(title)}</h2></div><div class="film-row">${cells.join('')}</div></section>`;
}
function homeTagBar() {
  const choices = privateMode() ? popularTags : publicPopularTags;
  return `<nav class="home-tags" aria-label="按类型浏览"><button type="button" class="all-tags-link" data-all-tags="1">全部类型 ${icon('arrow')}</button>
    <div class="home-tag-scroll">${choices.map(([slug, name]) => `<button type="button" class="home-tag" data-tag-slug="${slug}" data-tag-name="${name}">${name}</button>`).join('')}</div></nav>`;
}

function homeSignature(data) {
  return JSON.stringify([asArray(data.featured), asArray(data.homepageRecommend), asArray(data.homepageNewest), asArray(data.recommend?.items), asArray(data.newest?.items)]
    .map(list => list.map(item => [item.id, item.title, item.episodeLabel, item.score])));
}
function listSignature(data) {
  return JSON.stringify(asArray(data.items).map(item => [item.id, item.title, item.episodeLabel, item.score]));
}

function paletteFromImage(image) {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 48;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(image, 0, 0, 48, 48);
  const pixels = context.getImageData(0, 0, 48, 48).data;
  let red = 0, green = 0, blue = 0, weightSum = 0;
  for (let index = 0; index < pixels.length; index += 16) {
    const r = pixels[index], g = pixels[index + 1], b = pixels[index + 2];
    const brightness = (r + g + b) / 3;
    if (brightness < 28 || brightness > 225) continue;
    const weight = 0.6 + (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
    red += r * weight; green += g * weight; blue += b * weight; weightSum += weight;
  }
  if (!weightSum) throw new Error('未找到可用颜色');
  const r = red / weightSum / 255, g = green / weightSum / 255, b = blue / weightSum / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), difference = max - min;
  let hue = 28;
  if (difference) {
    hue = max === r ? ((g - b) / difference) % 6 : max === g ? (b - r) / difference + 2 : (r - g) / difference + 4;
    hue = (hue * 60 + 360) % 360;
  }
  const saturation = Math.round(Math.max(17, Math.min(32, difference / Math.max(max, .01) * 75)));
  return { light: `hsl(${Math.round(hue)} ${saturation}% 62%)`, dark: `hsl(${Math.round(hue)} ${Math.min(34, saturation + 2)}% 25%)` };
}
function applyBannerPalette(image) {
  const slide = image.closest('.hero-slide') || image.closest('.hero');
  if (!slide) return;
  const key = (image.dataset.cover || '').split('?')[0];
  let cache = {};
  try { cache = JSON.parse(localStorage.getItem('banner-palettes') || '{}'); } catch { }
  let colors = cache[key];
  if (!colors) {
    try { colors = paletteFromImage(image); cache[key] = colors; localStorage.setItem('banner-palettes', JSON.stringify(cache)); }
    catch { colors = { light: '#B5A08B', dark: '#49332F' }; }
  }
  slide.style.setProperty('--hero-tint-light', colors.light);
  slide.style.setProperty('--hero-tint-dark', colors.dark);
}

function coverKey(url) {
  try { return new URL(url).pathname; } catch { return String(url).split('?')[0]; }
}
function getCover(url) {
  const key = coverKey(url);
  if (coverRequests.has(key)) return coverRequests.get(key);
  const request = api('cover', { url }).catch(error => { coverRequests.delete(key); throw error; });
  coverRequests.set(key, request);
  if (coverRequests.size > 80) coverRequests.delete(coverRequests.keys().next().value);
  return request;
}
async function loadCoverInto(image) {
  const url = image.dataset.cover;
  if (image.dataset.loading === '1') return;
  // 已有真实 src：这是从预取缓存克隆带上来的图，src 已在（离屏预热设过）。
  // 重复 getCover + 设 src 会让海报被强制重载一次 —— 就是「抬手落位后推荐内容闪一下」。
  // 直接放行，让浏览器用缓存自然解码；加载失败由 retryFailedImages 兜底重试。
  if (image.getAttribute('src')) return;
  if (!url) {
    image.closest('.poster')?.classList.remove('loading');
    image.closest('.poster')?.classList.add('fallback');
    return;
  }
  image.dataset.loading = '1';
  const poster = image.closest('.poster');
  try {
    let data;
    try { data = await getCover(url); }
    catch { await new Promise(resolve => setTimeout(resolve, 450)); data = await getCover(url); }
    if (!image.isConnected || image.dataset.cover !== url) return;
    await new Promise((resolve, reject) => {
      image.onload = () => { image.onload = image.onerror = null; resolve(); };
      image.onerror = () => { image.onload = image.onerror = null; reject(new Error('图片无法解码')); };
      image.src = data;
      if (image.complete && image.naturalWidth > 0) { image.onload = image.onerror = null; resolve(); }
    });
    if (!image.isConnected || image.dataset.cover !== url) return;
    poster?.classList.remove('loading', 'fallback');
    poster?.classList.add('has-image');
    delete image.dataset.retryAfter;
    if (image.classList.contains('hero-image')) applyBannerPalette(image);
  } catch (error) {
    coverRequests.delete(coverKey(url));
    if (image.isConnected) {
      image.removeAttribute('src');
      poster?.classList.remove('loading');
      poster?.classList.add('fallback');
      image.dataset.retryAfter = String(Date.now() + (error.message === '图片无法解码' ? 300000 : 30000));
    }
    const id = image.closest('[data-open-id]')?.dataset.openId || image.closest('.hero-slide,.category-spotlight')?.querySelector('[data-open-id]')?.dataset.openId || 'unknown';
    console.warn('封面加载失败', id, (() => { try { return new URL(url).host; } catch { return 'invalid'; } })(), error.message);
  } finally { delete image.dataset.loading; }
}

function retryFailedImages(force = false) {
  const viewport = scroll.getBoundingClientRect();
  content.querySelectorAll('img[data-cover]').forEach(image => {
    if (image.naturalWidth > 0 || image.dataset.loading === '1') return;
    if (!force && Date.now() < Number(image.dataset.retryAfter || 0)) return;
    const card = image.closest('.poster');
    if (card && !card.classList.contains('fallback')) return;
    const box = image.getBoundingClientRect();
    if (box.bottom < viewport.top - 320 || box.top > viewport.bottom + 320) return;
    const row = image.closest('.film-row');
    if (row) {
      const visible = row.getBoundingClientRect();
      if (box.right < visible.left - 250 || box.left > visible.right + 250) return;
    }
    card?.classList.remove('fallback');
    card?.classList.add('loading');
    loadCoverInto(image);
  });
}
let coverScrollTimer;
scroll.addEventListener('scroll', () => {
  clearTimeout(coverScrollTimer);
  coverScrollTimer = setTimeout(() => retryFailedImages(), 160);
}, { passive: true });
window.addEventListener('online', () => retryFailedImages(true));
// eagerLimit：前多少张不等进视口就直接补图。离屏预热可以放宽一些。
function hydrateImages(root = content, eagerLimit = 14) {
  const offstage = root !== content;   // 离屏预热不能动主 observer，否则会把当前页正在加载的图打断
  const io = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      const image = entry.target;
      io.unobserve(image);
      loadCoverInto(image);
    });
  }, { root: scroll, rootMargin: '320px' });
  if (!offstage) { if (observer) observer.disconnect(); observer = io; }
  root.querySelectorAll('img[data-cover]').forEach((image, index) => {
    if (image.naturalWidth > 0) return;
    if (index < eagerLimit || image.classList.contains('hero-image')) loadCoverInto(image);
    else io.observe(image);
  });
}

// 克隆前先抹掉“正在加载”的痕迹：原 DOM 上的补图请求在它被撤下时就作废了，
// data-loading 却跟着克隆进来，之后 loadCoverInto 见 data-loading=1 一律跳过 ——
// 于是这些海报永远加载不出来（只有手动点 tab 重新渲染才出来）。
function swipeCleanCloneImages(clone) {
  clone.querySelectorAll('img').forEach(image => {
    delete image.dataset.loading;
    delete image.dataset.retryAfter;
  });
}
// 离屏预热：clone 已挂到离屏容器上（isConnected 为真），补图才会真正落地到 clone 自己身上。
// 改 await：把前 N 张图的 src 真正设好并解码完，缓存里才是「已加载」的图；
// 否则缓存里只有 data-cover 空壳，落位后才首次设 src 再解码，海报就会闪一下。
async function swipePrimeImages(clone) {
  swipeCleanCloneImages(clone);
  const imgs = [...clone.querySelectorAll('img[data-cover]')].slice(0, 24);
  await Promise.race([
    Promise.all(imgs.map(img => loadCoverInto(img).catch(() => {}))),
    new Promise(resolve => setTimeout(resolve, 3000)),   // 最多等 3 秒，别拖垮整轮预取
  ]);
}

function activeCampaigns() {
  const now = Date.now();
  return asArray(window.HotRuntime?.theme?.campaigns).filter(item => item?.id
    && (!item.startsAt || now >= Date.parse(item.startsAt))
    && (!item.endsAt || now < Date.parse(item.endsAt))
    && /^theme\/[a-zA-Z0-9_./-]+$/.test(item.artwork || '') && !item.artwork.split('/').includes('..'));
}
function campaignArtwork(item) {
  return new URL(item.artwork, 'https://appassets.androidplatform.net/assets/').href;
}
function homeSlides() {
  const featured = asArray(state.home?.featured);
  const videos = featured.length ? featured : asArray(state.home?.recommend?.items).slice(0, 5);
  return [...activeCampaigns().map(item => ({ ...item, kind: 'campaign', cover: '' })), ...videos];
}
function campaignSlide(item, index, count) {
  return '<div class="hero-slide hero-campaign" data-index="' + index + '">'
    + '<img class="hero-image campaign-image" src="' + esc(campaignArtwork(item)) + '" alt="">'
    + '<button class="hero-cover-button" type="button" data-open-campaign="' + esc(item.id) + '" aria-label="查看国庆庆祝页"></button>'
    + '<div class="hero-copy"><h2>' + esc(item.title) + '</h2><p>' + esc(item.description || '').replaceAll('\n', '<br>') + '</p>'
    + '<button class="hero-action" type="button" data-open-campaign="' + esc(item.id) + '">' + esc(item.button || '查看庆祝页') + '</button></div>'
    + '<span class="campaign-date">' + esc(item.dateLabel || '') + '</span>'
    + '<div class="hero-index"><b>' + String(index + 1).padStart(2, '0') + '</b> / ' + String(count).padStart(2, '0') + '</div></div>';
}
function goCampaign(item) {
  state.campaignReturn = captureScreen();
  ++routeToken;
  setRoute('campaign');
  state.campaign = item;
  content.innerHTML = '<article class="campaign-page"><button class="campaign-back" type="button" data-back>' + icon('back') + ' 返回首页</button>'
    + '<section class="campaign-poster"><img src="' + esc(campaignArtwork(item)) + '" alt="">'
    + '<div><h1>' + esc(item.title) + '</h1><p>' + esc(item.description || '').replaceAll('\n', '<br>') + '</p><span>' + esc(item.dateLabel || '') + '</span></div></section>'
    + '<section class="campaign-message"><h2>共庆好时光</h2><p>' + esc(item.message || '') + '</p><button type="button" data-back>返回首页</button></section></article>';
  scroll.scrollTop = 0;
}
function isBannerRoute() { return state.route === 'home' || (state.route === 'category' && !privateMode()); }
function bannerSlides() { return state.route === 'category' ? asArray(state.category?.items).slice(0, 5) : homeSlides(); }
function bannerIndex() { return state.route === 'category' ? state.categoryBanner : state.banner; }
function restoreBannerIndex() {
  const index = Number(content.querySelector('.hero-slide:last-child')?.dataset.index || 0);
  if (state.route === 'category') state.categoryBanner = index;
  else if (state.route === 'home') state.banner = index;
}
function categorySlide(item, index, count) {
  return `<div class="hero-slide" data-index="${index}"><img class="hero-image" data-cover="${esc(item.cover || '')}" alt=""><button class="hero-cover-button" type="button" data-open-id="${esc(item.id)}" aria-label="查看${esc(item.title)}详情"></button><div class="hero-shade"></div><div class="category-spotlight-copy"><h2>${esc(item.title)}</h2><button type="button" data-open-id="${esc(item.id)}">查看作品 ${icon('arrow')}</button></div><div class="hero-index"><b>${String(index + 1).padStart(2, '0')}</b> / ${String(count).padStart(2, '0')}</div></div>`;
}
function stopBannerAuto() {
  clearTimeout(bannerTimer);
  bannerTimer = null;
}
function scheduleBannerAuto() {
  stopBannerAuto();
  if (!isBannerRoute() || document.hidden || bannerSlides().length < 2 || !content.querySelector('.hero')) return;
  bannerTimer = setTimeout(() => {
    bannerTimer = null;
    if (!isBannerRoute() || document.hidden) return;
    const count = bannerSlides().length;
    if (count > 1) changeBanner((bannerIndex() + 1) % count, 1, true);
  }, 3000);
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopBannerAuto();
  else scheduleBannerAuto();
});
function heroSlide(item, index, count) {
  if (item.kind === 'campaign') return campaignSlide(item, index, count);
  return `<div class="hero-slide" data-index="${index}"><img class="hero-image" data-cover="${esc(item.cover || '')}" alt=""><button class="hero-cover-button" type="button" data-open-id="${esc(item.id || '')}" aria-label="查看${esc(item.title || '作品')}详情"></button><div class="hero-shade"></div>
    <div class="hero-copy"><span class="hero-label">本周焦点 <i></i> 独家精选</span><h2>${esc(item.title || '为你推荐')}</h2><p>${esc(item.description || item.episodeLabel || '')}</p><button class="hero-action" data-open-id="${esc(item.id || '')}" type="button">${icon('play')} 立即观看</button></div>
    <div class="hero-index"><b>${String(index + 1).padStart(2, '0')}</b> / ${String(count).padStart(2, '0')}</div></div>`;
}
async function changeBanner(targetIndex, direction, automatic = false) {
  const slides = bannerSlides();
  const route = state.route, token = routeToken;
  const currentRoute = () => state.route === route && routeToken === token && !document.hidden;
  const hero = content.querySelector('.hero');
  if (!isBannerRoute() || !hero || !slides.length || bannerChanging || targetIndex === bannerIndex()) return;
  stopBannerAuto();
  bannerChanging = true;
  let incoming = null;
  try {
    const item = slides[targetIndex];
    const data = item.kind === 'campaign' ? campaignArtwork(item) : await getCover(item.cover);
    const template = document.createElement('template');
    template.innerHTML = route === 'category' ? categorySlide(item, targetIndex, slides.length) : heroSlide(item, targetIndex, slides.length);
    incoming = template.content.firstElementChild;
    const image = incoming.querySelector('img');
    image.src = data;
    if (!hero.isConnected || !currentRoute()) return;
    incoming.style.transform = `translateX(${direction > 0 ? 100 : -100}%)`;
    hero.appendChild(incoming);
    await image.decode();
    if (!hero.isConnected || !currentRoute()) { incoming.remove(); return; }
    if (route === 'home' && item.kind !== 'campaign') applyBannerPalette(image);
    const current = hero.querySelector('.hero-slide:not(:last-child)');
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    incoming.classList.add('animating');
    current.classList.add('animating');
    incoming.style.transform = 'translateX(0)';
    current.style.transform = `translateX(${direction > 0 ? -100 : 100}%)`;
    await new Promise(resolve => setTimeout(resolve, 330));
    current.remove();
    incoming.classList.remove('animating');
    incoming.style.transform = '';
    if (currentRoute()) {
      if (route === 'category') state.categoryBanner = targetIndex;
      else state.banner = targetIndex;
    }
    content.querySelectorAll('.hero-dots [data-slide]').forEach(dot => dot.classList.toggle('active', Number(dot.dataset.slide) === targetIndex));
  } catch (error) {
    incoming?.remove();
    hero.querySelectorAll('.hero-slide').forEach(slide => { slide.classList.remove('animating'); slide.style.transform = ''; });
    if (!automatic) toast('封面加载失败，请重试', true);
  }
  finally { bannerChanging = false; scheduleBannerAuto(); }
}
function continueWatchingItem() {
  return asArray(state.library?.progress)[0] || null;
}
function continueWatchingMarkup() {
  const item = continueWatchingItem();
  if (!item) return '';
  const episode = Math.max(1, Number(item.episode) || 1);
  const total = Number(item.episodeCount) || 0;
  const finished = Boolean(item.completed) && total > 0 && episode >= total;
  const seconds = Math.floor(Math.max(0, Number(item.position) || 0) / 1000);
  const time = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  return `<section class="continue-section"><div class="section-heading"><h2>继续观看</h2><button type="button" class="more" data-all-history="1">全部历史 ${icon('arrow')}</button></div>
    <button type="button" class="continue-card" data-continue-id="${esc(item.id)}" aria-label="${esc(item.title)}，${finished ? '打开详情' : '继续观看'}">
      <span class="continue-poster poster loading"><span class="poster-letter">${esc(String(item.title || '影片').slice(0, 1))}</span><img data-cover="${esc(item.cover || '')}" alt=""></span>
      <span class="continue-copy"><strong>${esc(item.title || '影片')}</strong><span>已看到第 ${episode} 集${total ? ` · 共 ${total} 集` : ''}</span><span class="continue-time">${finished ? '全剧已看完' : item.completed ? '本集已看完，接着看下一集' : `上次看到 ${time}`}</span></span>
      <span class="continue-action">${icon('play')}${finished ? '详情' : item.completed ? '继续看' : '续播'}</span>
    </button></section>`;
}
function updateContinueWatching() {
  const host = content.querySelector('.home-continue');
  if (!host) return;
  const markup = continueWatchingMarkup();
  if (host.continueMarkup === markup) return;
  const savedScroll = scroll.scrollTop;
  host.innerHTML = markup;
  host.continueMarkup = markup;
  host.querySelectorAll('img[data-cover]').forEach(loadCoverInto);
  scroll.scrollTop = savedScroll;
}
async function refreshHomeHistory() {
  const token = routeToken, source = contentSource, userId = state.account.userId;
  try {
    const library = await api('library');
    if (token !== routeToken || source !== contentSource || userId !== state.account.userId) return;
    state.library = library;
    if (state.route === 'home') updateContinueWatching();
  } catch (_) { }
}
async function resumeFromHome(id) {
  const item = continueWatchingItem();
  if (!item || String(item.id) !== id) return;
  const source = contentSource;
  const episode = Math.max(1, Number(item.episode) || 1) + (item.completed ? 1 : 0);
  const token = routeToken + 1;
  await goDetail(id);
  if (routeToken !== token || contentSource !== source || state.route !== 'detail' || state.detailLoading || String(state.detail?.id) !== id) return;
  if (episode <= asArray(state.detail.episodes).length) await openPlayer(episode);
}

function renderHome() {
  const data = state.home;
  if (!data) { renderSkeleton(); return; }
  const slides = homeSlides();
  const index = Math.min(state.banner, Math.max(0, slides.length - 1));
  const selected = slides[index] || {};
  content.innerHTML = `<div class="home-page"><div class="hero" data-hero="1">${heroSlide(selected, index, slides.length)}</div>
      <div class="hero-dots">${slides.map((_, i) => `<i class="${i === index ? 'active' : ''}" data-slide="${i}"></i>`).join('')}</div>
      ${homeTagBar()}
      <div class="home-continue">${continueWatchingMarkup()}</div>
      ${section('精选推荐', asArray(data.homepageRecommend).length ? asArray(data.homepageRecommend) : asArray(data.recommend?.items).slice(0, 12), 'recommend')}
      ${section(privateMode() ? '最近上新' : '热门漫剧', asArray(data.homepageNewest).length ? asArray(data.homepageNewest) : asArray(data.newest?.items).slice(0, 12), 'newest')}</div>`;
  hydrateImages();
  slides.forEach(item => { if (item.cover) getCover(item.cover).catch(() => {}); });
  scheduleBannerAuto();
  window.__bingeUpdateChrome && window.__bingeUpdateChrome();
}

function renderTags() {
  const tags = asArray(state.tags?.items);
  const sections = privateMode() ? tagGroups : [['short', '短剧类型'], ['comic', '漫剧类型']];
  const groups = sections.map(([id, title]) => {
    const members = tags.filter(tag => tag.group === id);
    if (!members.length) return '';
    return `<section class="tags-group"><h2>${title}</h2><div class="tags-grid">${members.map(tag => {
      const name = String(tag.name || tag.slug);
      const size = name.length > 8 ? 'wide' : name.length > 4 ? 'medium' : '';
      return `<button type="button" class="tag-choice ${size}" data-tag-slug="${esc(tag.slug)}" data-tag-name="${esc(name)}">${esc(name)}</button>`;
    }).join('')}</div></section>`;
  }).join('');
  content.innerHTML = `<div class="tags-page"><div class="tags-heading"><button type="button" data-back="1" aria-label="返回上一页">${icon('back')}</button><h1>全部类型</h1><span>${tags.length} 个${privateMode() ? '标签' : '大类'}</span></div>
    <p class="tags-intro">${privateMode() ? '点选标签，发现相关作品' : '按短剧、漫剧大类，发现相关作品'}</p>${groups}</div>`;
}

function refreshMissingImages(items) {
  const byId = new Map(items.filter(item => item?.id && item?.cover).map(item => [String(item.id), item.cover]));
  content.querySelectorAll('[data-open-id]').forEach(button => {
    const image = button.querySelector('img[data-cover]') || button.closest('.hero-slide,.category-spotlight')?.querySelector('img[data-cover]');
    const cover = byId.get(button.dataset.openId);
    if (!image || !cover || image.naturalWidth > 0) return;
    image.dataset.cover = cover;
    delete image.dataset.loading;
    loadCoverInto(image);
  });
}

function categoryId() { return categoryIds[state.tab][state.sub[state.tab]]; }
function compactMarkup() {
  if (!privateMode()) return '';
  const adult = state.tab === 'adult';
  const tabs = privateMode() ? (adult ? ['成人短剧', '成人漫剧'] : ['AI换脸', 'AI魔改']) : [adult ? '短剧' : '漫剧'];
  return `<strong>${privateMode() ? (adult ? '成人剧场' : 'AI专区') : (adult ? '短剧' : '漫剧')}</strong><div class="compact-tabs" role="tablist">${tabs.map((name, index) => `<button type="button" role="tab" aria-selected="${index === state.sub[state.tab]}" data-sub="${index}" class="${index === state.sub[state.tab] ? 'selected' : ''}">${name}</button>`).join('')}</div>`;
}
function updateCompact() {
  const eligible = privateMode() && state.route === 'category';
  if (!eligible || scroll.scrollTop <= 0) state.compactHeld = false;
  else if (scroll.scrollTop > 92) state.compactHeld = true;
  const visible = eligible && state.compactHeld;
  compact.classList.toggle('visible', visible);
  compact.setAttribute('aria-hidden', String(!visible));
  compact.inert = !visible;
  content.querySelector('.category-page')?.classList.toggle('is-collapsed', visible);
}
scroll.addEventListener('scroll', updateCompact, { passive: true });

function renderCategory(keepCompact = false) {
  categoryObserver?.disconnect();
  const adult = state.tab === 'adult';
  const tabs = privateMode() ? (adult ? ['成人短剧', '成人漫剧'] : ['AI换脸', 'AI魔改']) : [adult ? '短剧' : '漫剧'];
  const items = asArray(state.category?.items);
  const lead = items[0] || null;
  const slides = privateMode() ? [] : items.slice(0, 5);
  const banner = Math.min(state.categoryBanner, Math.max(0, slides.length - 1));
  state.categoryBanner = banner;
  const spotlight = !privateMode() && slides.length ? `<div class="hero category-spotlight category-carousel">${categorySlide(slides[banner], banner, slides.length)}</div><div class="hero-dots">${slides.map((_, index) => `<i class="${index === banner ? 'active' : ''}" data-slide="${index}"></i>`).join('')}</div>` : lead ? `<div class="category-spotlight"><img data-cover="${esc(lead.cover)}" alt=""><div class="category-spotlight-copy"><h2>${esc(lead.title)}</h2><button type="button" data-open-id="${esc(lead.id)}">查看作品 ${icon('arrow')}</button></div></div>` : '';
  const switcher = privateMode() ? `<div class="segmented" role="tablist">${tabs.map((name, index) => `<button type="button" role="tab" data-sub="${index}" aria-selected="${index === state.sub[state.tab]}" class="${index === state.sub[state.tab] ? 'selected' : ''}">${name}</button>`).join('')}</div>` : '';
  content.innerHTML = `<div class="category-page"><div class="category-head"><h1>${privateMode() ? (adult ? '成人剧场' : 'AI专区') : (adult ? '短剧' : '漫剧')}</h1><p>${privateMode() ? (adult ? '短剧与漫剧，走进不同的人生。' : '换脸与魔改，探索影像新可能。') : (adult ? '真人演的看了不烧心' : '探索热门漫剧。')}</p></div>
    ${switcher}
    ${spotlight}
    <section class="category-section"><div class="section-heading"><h2>${tabs[state.sub[state.tab]]}作品</h2><span class="category-count">已显示 ${items.length} 部</span></div>
    <div class="search-grid category-grid">${items.map(itemCard).join('')}</div><div class="category-footer">${categoryFooter()}</div></section></div>`;
  compact.innerHTML = compactMarkup();
  scroll.scrollTop = keepCompact ? 150 : 0;
  state.compactHeld = keepCompact;
  updateCompact();
  hydrateImages();
  observeCategoryEnd();
  slides.forEach(item => { if (item.cover) getCover(item.cover).catch(() => {}); });
  scheduleBannerAuto();
}

function categoryFooter() {
  const category = state.category;
  if (category?.error) return '<button type="button" data-retry-category="1">加载失败，点击重试</button>';
  if (category?.loading) return '<span role="status">正在加载更多…</span>';
  if (category?.refreshing) return '<span role="status">正在更新列表…</span>';
  if (category?.nextPage) return '<span class="category-sentinel" aria-hidden="true"></span>';
  return '<span>已经到底了</span>';
}

function observeCategoryEnd() {
  categoryObserver?.disconnect();
  const category = state.category;
  if (state.route !== 'category' || !category?.nextPage || category.loading || category.refreshing || category.error) return;
  const sentinel = content.querySelector('.category-sentinel');
  if (!sentinel) return;
  if (!categoryObserver) {
    categoryObserver = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) loadMoreCategory();
    }, { root: scroll, rootMargin: '0px 0px 320px 0px' });
  }
  categoryObserver.observe(sentinel);
}

function updateCategoryFooter() {
  const footer = content.querySelector('.category-footer');
  if (!footer) return;
  footer.innerHTML = categoryFooter();
  observeCategoryEnd();
}

function renderLibrary() {
  const data = state.library || { progress: [], bookmarks: [] };
  const query = state.libraryQuery.trim().toLocaleLowerCase();
  const matches = item => String(item.title || '').toLocaleLowerCase().includes(query);
  const progress = asArray(data.progress).filter(matches);
  const bookmarks = asArray(data.bookmarks).filter(matches);
  const historyActive = state.libraryTab === 'history';
  const downloadsActive = state.libraryTab === 'downloads';
  const historyCards = progress.map(item => {
    const completed = Boolean(item.completed);
    const episode = Number(item.episode) || 1;
    const percentage = completed ? 100 : Math.max(0, Math.min(100, item.duration ? item.position / item.duration * 100 : 0));
    return `<button type="button" class="history-card" data-history-id="${esc(item.id)}" data-history-episode="${episode}" data-history-completed="${completed}" aria-label="${esc(item.title)}，第 ${episode} 集，${completed ? '已看完，打开详情' : '继续观看'}">
      <span class="history-poster poster loading"><span class="poster-letter">${esc(String(item.title || '影片').slice(0, 1))}</span><img data-cover="${esc(item.cover || '')}" alt=""></span><span class="history-copy"><span class="history-status">${completed ? '已看完' : '继续观看'} · 第 ${episode} 集</span>
      <strong>${esc(item.title || '影片')}</strong><span class="progress"><i style="width:${percentage}%"></i></span><span class="history-hint">${completed ? '打开详情选择剧集' : `已看 ${Math.floor(item.position / 60000)} 分钟`}</span></span></button>`;
  }).join('');
  content.innerHTML = `<div class="library-page"><div class="my-heading"><h1>我的</h1></div>
    ${state.account.loggedIn ? '' : `<button type="button" class="my-account" data-account-action="1">点击头像登录，同步收藏和观看历史 ${icon('arrow')}</button>`}
    ${query ? `<div class="library-results"><p class="library-count">在观看历史中找到 ${progress.length} 部，在我的收藏中找到 ${bookmarks.length} 部</p>
      <h2>观看历史</h2>${progress.length ? `<div class="history-list">${historyCards}</div>` : '<p class="library-no-match">没有匹配的观看记录</p>'}
      <h2>我的收藏</h2>${bookmarks.length ? `<div class="search-grid library-bookmark-grid">${bookmarks.map(itemCard).join('')}</div>` : '<p class="library-no-match">没有匹配的收藏</p>'}</div>` : downloadsActive ? `
    <div class="segmented library-tabs" role="tablist" aria-label="我的片单分类"><button type="button" role="tab" data-library-tab="history" aria-selected="${false}" class="">观看历史</button>
    <button type="button" role="tab" data-library-tab="bookmarks" aria-selected="${false}" class="">我的收藏</button>
    <button type="button" role="tab" data-library-tab="downloads" aria-selected="${true}" class="selected">我的下载</button></div>
    <div id="library-downloads"><p class="page-loading">正在加载…</p></div>` : `
    <div class="segmented library-tabs" role="tablist" aria-label="我的片单分类"><button type="button" role="tab" data-library-tab="history" aria-selected="${historyActive}" class="${historyActive ? 'selected' : ''}">观看历史</button>
    <button type="button" role="tab" data-library-tab="bookmarks" aria-selected="${!historyActive}" class="${!historyActive ? 'selected' : ''}">我的收藏</button>
    <button type="button" role="tab" data-library-tab="downloads" aria-selected="${false}" class="">我的下载</button></div>
    <p class="library-count">${historyActive ? `最近观看的 ${progress.length} 部作品` : `已收藏 ${bookmarks.length} 部作品`}</p>
    ${historyActive ? (progress.length ? `<div class="history-list">${historyCards}</div>` : '<div class="empty-state">还没有观看记录，播放作品后会出现在这里</div>') :
      (bookmarks.length ? `<div class="search-grid library-bookmark-grid">${bookmarks.map(itemCard).join('')}</div>` : '<div class="empty-state">还没有收藏作品</div>')}`}</div>`;
  hydrateImages();
  if (downloadsActive && !swipePrefetchBusy) renderLibraryDownloads();
}

let libraryDownloadsToken = 0;
const withTimeout = (promise, ms) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('请求超时')), ms))]);
async function renderLibraryDownloads(prefetched) {
  const token = ++libraryDownloadsToken;
  let phone = [], nas = [];
  if (prefetched) { phone = prefetched.phone || []; nas = prefetched.nas || []; }
  else {
    try { phone = asArray(await withTimeout(api('download-list'), 4000)); } catch (error) { phone = []; }
    if (state.account.loggedIn) {
      try { const result = await withTimeout(api('nas-download-list'), 4000); nas = asArray(result.tasks); } catch (error) { nas = []; }
    }
  }
  if (state.route !== 'library' || state.libraryTab !== 'downloads' || token !== libraryDownloadsToken) return;
  const list = document.getElementById('library-downloads');
  if (!list) return;
  commitDownloadList(list, phone, nas, prefetched ? { noTimer: true } : {});
}

// 把下载列表填进容器并补封面；命中签名守卫时只补图、不重建 DOM（避免滑动落位后「再闪一下」）。
function commitDownloadList(list, phone, nas, opts = {}) {
  const sig = downloadListSignature(phone, nas);
  if (!opts.force && list.dataset.sig === sig) { if (!opts.noTimer) syncDownloadsTimer([...phone, ...nas]); return; }
  list.dataset.sig = sig;
  if (!opts.noTimer) syncDownloadsTimer([...phone, ...nas]);
  if (!opts.noTimer) processForwardTasks(phone, nas);   // 转发模式：NAS 完成自动拉取合并（不阻塞渲染）
  const phoneTasks = phone.map(t => Object.assign({}, t, { kind: 'phone' }));
  // 手机转发任务关联的 NAS 任务不在下载页单独显示（由"下载到手机"触发，属内部步骤；主动下载到 NAS 的任务正常显示）
  const forwardNas = new Set(phone.filter(t => t.nasTaskId).map(t => String(t.nasTaskId)));
  const nasTasks = nas.filter(t => !forwardNas.has(String(t.id)) && (!t.source || t.source === contentSource)).map(t => Object.assign({}, t, { kind: 'nas' }));
  list.innerHTML = renderDownloadList([...phoneTasks, ...nasTasks]);
  hydrateImages();   // 下载封面是 data-cover，必须补 src 才出图（之前缺这步 → 灰块）
  backfillNasCovers(nasTasks);   // 老 NAS 任务后端没存封面：用 seriesId 现拉详情页封面兜底（尽力而为）
}

// NAS 老任务 cover 为空时，用 seriesId 向详情页接口要一次封面，持久化并补到对应行。
// 失败静默（剧集可能下架/风控），不影响列表渲染；已持久化到 localStorage，下次启动直接命中。
const nasCoverBackfill = new Set();
function backfillNasCovers(nasTasks) {
  for (const t of nasTasks) {
    if (t.cover || !t.seriesId) continue;
    const key = String(t.seriesId);
    if (nasCoverBackfill.has(key)) continue;
    nasCoverBackfill.add(key);
    api('detail', { id: key }).then(detail => {
      nasCoverBackfill.delete(key);
      if (!detail || !detail.cover) return;
      rememberTitleCover(t.title, detail.cover);
      const img = content.querySelector(`[data-dl-play-nas="${t.id}"] img[data-cover]`);
      if (img && !img.naturalWidth) {
        img.dataset.cover = detail.cover;
        delete img.dataset.loading;
        loadCoverInto(img);
      }
    }).catch(() => { nasCoverBackfill.delete(key); });
  }
}

// 仅当任务状态真正变化时才重建列表，避免滑动落位后无谓重绘（那一闪）。
function downloadListSignature(phone, nas) {
  const red = t => [t.id, t.status, t.percent, t.doneCount, t.totalCount, t.nasTaskId, t.cover].map(v => v == null ? '' : v).join('|');
  return [...phone.map(red), ...nas.map(red)].join(',');
}

// 下载任务是否仍在进行（手机端 running/pulling；NAS 端 queued/downloading/merging）
function downloadTaskActive(task) {
  return ['queued', 'downloading', 'merging', 'running', 'pulling'].includes(task && task.status);
}

// 转发模式（proxyMode=3）：NAS 下载完成后自动逐集拉到手机 → 合并 → 删除 NAS 原文件。
// 防重入：处理中置 forwardProcessing，避免 2s 轮询重复触发。
let forwardProcessing = false;
async function processForwardTasks(phoneTasks, nasTasks) {
  if (forwardProcessing) return;
  const fwd = (phoneTasks || []).find(t => t.status === 'pulling');
  if (!fwd) return;
  if (!fwd.nasTaskId) return;   // 旧任务无关联 NAS id（持久化前版本），跳过等用户重下
  const nas = (nasTasks || []).find(t => String(t.id) === String(fwd.nasTaskId));
  if (!nas) return;
  if (!['done', 'ready'].includes(nas.status)) return;   // 等 NAS 下载完成
  if (nas.status === 'ready') {
    // NAS 已下载未合并：触发 NAS 端合并（merging/done 状态后端会拒绝，忽略即可，继续等）
    try { await withTimeout(api('nas-download-merge', { id: fwd.nasTaskId }), 8000); } catch (ignore) {}
    return;
  }
  forwardProcessing = true;
  try {
    toast(`NAS 已合并，正在拉到手机（${fwd.title}）`);
    await api('download-forward-pull-merged', { id: fwd.id, nasTaskId: fwd.nasTaskId });
    try { await api('nas-download-cancel', { id: fwd.nasTaskId }); } catch (ignore) {}  // 清理 NAS 原文件
    toast('已拉到手机完整成品');
  } catch (error) {
    toast(`转发拉取失败：${error.message}`, true);
  } finally {
    forwardProcessing = false;
  }
}

// 有进行中任务则维持 2s 轮询，全部终态则停止；避免反复 stop/start 重置定时器
function syncDownloadsTimer(tasks) {
  const active = tasks.some(downloadTaskActive);
  if (active) {
    if (!downloadsTimer) downloadsTimer = setInterval(() => {
      if (state.route === 'downloads') refreshDownloads(routeToken, true);
      else if (state.route === 'library' && state.libraryTab === 'downloads') renderLibraryDownloads();
      else stopDownloadsTimer();
    }, 2000);
  } else stopDownloadsTimer();
}

// ---- 下载（手机本地 + NAS 后端）----
let downloadsTimer = null;

function stopDownloadsTimer() { if (downloadsTimer) { clearInterval(downloadsTimer); downloadsTimer = null; } }

function goDownloads() {
  const token = ++routeToken;
  state.previous = { route: state.route };
  state.settingsReturn = { route: state.route };
  setRoute('downloads');
  content.innerHTML = `<div class="settings-page downloads-page"><button type="button" class="listing-back" data-back="1">${icon('back')} 返回设置</button><h1>下载管理</h1><div id="downloads-list"><p class="page-loading">正在加载…</p></div></div>`;
  refreshDownloads(token, true);
}

async function refreshDownloads(token, keepTimer) {
  if (state.route !== 'downloads' || routeToken !== token) { stopDownloadsTimer(); return; }
  let phone = [], nas = [];
  try { phone = await api('download-list'); } catch (error) { phone = []; }
  if (state.account.loggedIn) {
    try { const result = await api('nas-download-list'); nas = asArray(result.tasks); } catch (error) { nas = []; }
  }
  if (state.route !== 'downloads' || routeToken !== token) return;
  const list = document.getElementById('downloads-list');
  if (!list) return;
  if (keepTimer) syncDownloadsTimer([...phone, ...nas]);
  processForwardTasks(phone, nas);   // 转发模式：NAS 完成自动拉取合并（不阻塞渲染）
  const phoneTasks = phone.map(t => Object.assign({}, t, { kind: 'phone' }));
  // 手机转发任务关联的 NAS 任务不在下载页单独显示（由"下载到手机"触发，属内部步骤；主动下载到 NAS 的任务正常显示）
  const forwardNas = new Set(phone.filter(t => t.nasTaskId).map(t => String(t.nasTaskId)));
  const nasTasks = nas.filter(t => !forwardNas.has(String(t.id)) && (!t.source || t.source === contentSource)).map(t => Object.assign({}, t, { kind: 'nas' }));
  list.innerHTML = renderDownloadList([...phoneTasks, ...nasTasks]);
}

function renderDownloadSection(label, tasks, kind) {
  if (!tasks.length) return '';
  const rows = tasks.map(task => downloadTaskRow(task, kind)).join('');
  return `<h2 class="downloads-section-title">${label}</h2>${rows}`;
}

// 手机/NAS 不单独分类：一个列表，来源以标记显示
function renderDownloadList(tasks) {
  if (!tasks.length) return '<div class="empty-state">还没有下载内容，去详情页点击「下载」吧</div>';
  // 手机任务按剧名归并：同一部剧分多次下载（分批集数）显示为一条，集数合计；
  // 合并按钮取第一个未完成任务（后端合并已是「整剧合并」：一次合并该剧全部分集+已有产物）
  const grouped = [];
  const byTitle = new Map();
  for (const t of tasks) {
    if (t.kind === 'phone') {
      const key = t.title || '';
      if (!byTitle.has(key)) byTitle.set(key, []);
      byTitle.get(key).push(t);
    } else grouped.push(t);
  }
  for (const [title, list] of byTitle) {
    if (list.length === 1) { grouped.push(list[0]); continue; }
    const first = Object.assign({}, list.find(t => t.status !== 'done') || list[0]);
    first.totalCount = list.reduce((s, t) => s + (Number(t.totalCount) || 0), 0);
    first.doneCount = list.reduce((s, t) => s + (Number(t.doneCount) || 0), 0);
    const anyActive = list.some(downloadTaskActive);
    const anyReady = list.some(t => t.status === 'ready' || (t.status === 'failed' && (t.error || '').includes('合并失败')));
    const anyFailed = list.some(t => t.status === 'failed' && !(t.error || '').includes('合并失败'));
    first.status = anyActive ? 'running' : (anyReady ? 'ready' : (anyFailed ? 'failed' : 'done'));
    first.percent = list.reduce((s, t) => s + (Number(t.percent) || 0), 0) / list.length;
    if (!anyActive && anyReady) first.detail = `已下载 ${first.doneCount} 集，待合并`;
    first.children = list;
    grouped.push(first);
  }
  const rows = grouped.map(task => downloadTaskRow(task, task.kind || (task.nas ? 'nas' : 'phone'))).join('');
  return `<div class="downloads-list">${rows}</div>`;
}

// title→cover 兜底缓存：NAS 老任务后端没存封面，用用户浏览过的详情页封面兜底。
// 之前是会话内 Map，App 一重启就清空，老 NAS 任务重启后必灰块；现持久化到 localStorage，
// 下载/浏览过详情页的剧，重启后 NAS 行仍能按剧名找回封面。
const TITLE_COVERS_KEY = 'veyra-title-covers';
let titleCovers = null;
function loadTitleCovers() {
  if (titleCovers) return titleCovers;
  try { titleCovers = new Map(Object.entries(JSON.parse(localStorage.getItem(TITLE_COVERS_KEY) || '{}'))); }
  catch { titleCovers = new Map(); }
  return titleCovers;
}
function rememberTitleCover(title, cover) {
  if (!title || !cover) return;
  const map = loadTitleCovers();
  const key = String(title);
  if (map.has(key)) return;
  map.set(key, String(cover));
  if (map.size > 400) map.delete(map.keys().next().value);   // 限容量，防 localStorage 超限
  try { localStorage.setItem(TITLE_COVERS_KEY, JSON.stringify(Object.fromEntries(map))); } catch (ignore) { }
}
function coverForTask(task) {
  return task.cover || loadTitleCovers().get(String(task.title || '')) || '';
}

function downloadTaskRow(task, kind) {
  const running = task.status === 'running';
  const statusText = downloadStatusText(task, kind);
  const sourceBadge = kind === 'nas'
    ? '<span class="dl-source-badge nas">NAS</span>'
    : '<span class="dl-source-badge phone">手机</span>';
  // 直写导出后 output 是 file:// 路径（不再走 MediaStore 的 content://），两者都按「已保存」展示
  const output = task.output && (task.output.startsWith('content://') || task.output.startsWith('file://')) ? '已保存到系统下载目录' : task.output || '';
  const cancelBtn = running ? `<button type="button" class="dl-cancel" data-dl-cancel="${kind}" data-dl-id="${esc(task.id)}">取消</button>` : '';
  const retryBtn = !running && kind === 'phone' && (task.status === 'failed' || task.status === 'canceled') && !(task.error || '').includes('合并失败')
    ? `<button type="button" class="dl-cancel dl-retry" data-dl-retry="phone" data-dl-id="${esc(task.id)}">重试</button>` : '';
  const failedList = task.failedEpisodes || [];
  // 来源标识（红果 App 源 / 网页源保底）来自后端 ready detail，前端直接展示
  const srcNote = task.detail && task.detail.includes('（') ? ((task.detail.match(/（([^）]*)）/) || [])[1] || '') : '';
  // NAS 任务部分失败：ready（下载完成）或 failed（重启中断/失败）都可只重下失败集，已下载分集保留不动
  const canRetryFailed = task.status === 'ready' || (task.status === 'failed' && !(task.error || '').includes('合并失败'));
  const retryFailedBtn = !running && kind === 'nas' && canRetryFailed && failedList.length > 0
    ? `<button type="button" class="dl-cancel dl-retry" data-dl-retry-failed="nas" data-dl-id="${esc(task.id)}">重试失败${failedList.length}集</button>` : '';
  // 手动合并：下载完成（ready，含部分失败）或合并失败（分集保留）时显示合并按钮，等用户点合并才合并
  const mergeBtn = !running && (task.status === 'ready' || ((task.status === 'failed' || task.status === 'done') && (task.error || '').includes('合并失败')))
    ? `<button type="button" class="dl-cancel dl-retry" data-dl-merge="${kind}" data-dl-id="${esc(task.id)}">合并</button>` : '';
  const deleteBtn = !running ? `<button type="button" class="dl-cancel" data-dl-delete="${kind}" data-dl-id="${esc(task.id)}"${task.children && task.children.length > 1 ? ` data-dl-siblings="${esc(task.children.map(c => c.id).join(','))}"` : ''}>删除</button>` : '';
  const failedInfo = failedList.length > 0
    ? `<span class="dl-error" data-dl-copy="${esc(task.id)}" data-dl-log="${esc('失败集: ' + failedList.map(f => '第' + f.index + '集(' + (f.error || '') + ')').join('；'))}" title="点击复制失败明细">失败 ${failedList.length} 集：${esc(failedList.slice(0, 3).map(f => '第' + f.index + '集').join('、'))}${failedList.length > 3 ? ' 等' : ''}</span>` : '';
  const errLog = task.error || task.debug || '';
  const errBlock = errLog
    ? `<span class="dl-error" data-dl-copy="${esc(task.id)}" data-dl-log="${esc(errLog.replace(/\n/g, '\\n'))}" title="点击复制全部日志">${task.error ? esc(task.error.split('\n').slice(0, 4).join('<br>')) : '<span class="dl-log-link">复制合并日志</span>'}</span>` : '';
  const detailHint = task.detail && (/片/.test(task.detail) || task.detail.includes('合并中')) ? ` · <span class="dl-detail-hint">${esc(task.detail)}</span>` : '';
  const playAttr = kind === 'nas' ? 'data-dl-play-nas' : 'data-dl-play';
  const playHint = kind === 'nas' ? '播放 NAS 成品' : '本地播放';
  const playTile = `<button type="button" class="download-cover" ${playAttr}="${esc(task.id)}" aria-label="${playHint}《${esc(task.title || '未知剧集')}》">
    <span class="poster loading"><span class="poster-letter">${esc(String(task.title || '影').slice(0, 1))}</span><img data-cover="${esc(coverForTask(task))}" alt=""></span>
    <span class="download-cover-hint">${playHint}</span></button>`;
  return `<div class="download-card">${playTile}<div class="download-task">
    <div class="download-task-head"><strong>${esc(task.title || '未知剧集')}</strong>${sourceBadge}<span class="dl-status ${running ? 'is-running' : ''}">${statusText}</span></div>
    <div class="download-task-meta">${task.doneCount}/${task.totalCount} 集 · ${task.doneCount === task.totalCount && task.status !== 'running' ? '已下载全部集' : (failedList.length ? `失败 ${failedList.length} 集` : '')}${srcNote ? ` · <b class="dl-src-note">${esc(srcNote)}</b>` : ''}${detailHint}</div>
    <div class="download-track"><i style="width:${Math.max(0, Math.min(100, Number(task.percent) || 0))}%"></i></div>
    <div class="download-task-foot">${output ? `<span class="dl-output">${esc(output)}</span>` : ''}${failedInfo}${errBlock}${mergeBtn}${retryFailedBtn}${retryBtn}${cancelBtn}${deleteBtn}</div>
  </div></div>`;
}

function downloadStatusText(task, kind) {
  const failedCount = (task.failedEpisodes || []).length;
  if (task.status === 'pulling') {
    const d = task.detail || '';
    if (d.includes('拉取')) return d.replace(/已从 NAS /, '从 NAS ');
    return '等待 NAS 下载';
  }
  if (task.status === 'ready') return failedCount > 0 ? `已下载 · 失败${failedCount}集` : '已下载 · 待合并';
  if (task.status === 'done') {
    if (kind === 'nas') return '已下载 · 已合并';
    if ((task.detail || '').includes('已合并')) return '已下载 · 已合并';
    return '已下载';
  }
  if (task.status === 'failed') return failedCount > 0 ? `失败 · 可重试${failedCount}集` : '失败';
  if (task.status === 'canceled') return '已取消';
  const detail = task.detail || '';
  if (detail.includes('保存')) return '保存到手机';
  // 下载进度优先：单集"第 X 集处理中/取流合并"或"第 X/Y 集"都是下载阶段，不算整任务合并
  const m = detail.match(/第\s*(\d+)\s*\/\s*(\d+)/);
  if (m) return `下载中 ${m[1]}/${m[2]}`;
  if (/第\s*\d+\s*集/.test(detail) && detail.includes('合并')) return '下载中 · 取流合并';
  if (detail.includes('待合并')) return '待合并';
  if (detail.includes('合并')) return '合并中';
  return '下载中';
}

// ---- 下载弹层：详情页"下载" → 选集（全选/取消全选）→ 点"下载" → 选手机/NAS → 提交 ----
let downloadMode = null;          // 'episodes' | 'target' | 'parsing'
const downloadSelection = new Set();
let downloadParsing = false;

function showDownloadSheet() {
  if (!state.detail) return;
  const episodes = asArray(state.detail.episodes);
  if (!episodes.length) { toast('该内容暂无可选集', true); return; }
  downloadMode = 'episodes';
  downloadSelection.clear();
  downloadParsing = false;
  downloadOverlay.hidden = false;
  updateBackEnabled();
  // 先强制拉服务端最新角色（管理员/NAS 下载鉴权），再渲染弹层
  if (state.account.loggedIn) {
    api('refresh-account').then(fresh => { if (fresh && fresh.role) setAccount(fresh); }).catch(() => {});
  }
  renderDownloadSheet();
}

function hideDownloadSheet() {
  downloadOverlay.hidden = true;
  downloadParsing = false;
  updateBackEnabled();
}

function renderDownloadSheet() {
  const sheet = document.getElementById('download-sheet');
  if (!sheet) return;
  const episodes = asArray(state.detail.episodes);
  if (downloadMode === 'parsing') {
    sheet.innerHTML = `<p class="download-parsing">正在解析播放地址…<br><small>需要逐集解析，请稍候</small></p>`;
    return;
  }
  if (downloadMode === 'target') {
    const isAdmin = state.account.role === 'admin';
    // 「调试」只在私密（黄果）模式给：那条链路才是 m3u8 → ts 分片 → 本地合并，
    // 也只有它能保留 TS/KEY 给开发者复现黑屏。公开模式没有分片可留。
    const canDebug = privateMode();
    sheet.innerHTML = `<div class="download-pick">
      <button type="button" class="download-pick-option" data-dl-pick="phone"><strong>下载到手机</strong></button>
      <button type="button" class="download-pick-option" data-dl-pick="nas" ${isAdmin ? '' : 'disabled'}><strong>下载到 NAS</strong>${isAdmin ? '' : '<small>仅管理员可用</small>'}</button>
      ${canDebug ? '<button type="button" class="download-pick-option" data-dl-pick="phone-debug"><strong>下载到手机（调试）</strong><small>保留 TS 与 Key，不自动合并，导出调试包</small></button>' : ''}
      <p class="download-nas-note">${state.account.loggedIn ? '' : 'NAS 下载需要先登录账号。'}</p>
    </div>`;
    return;
  }
  const all = episodes.map(ep => Number(ep.number) || 0);
  const checked = all.filter(n => downloadSelection.has(n)).length;
  const allSelected = all.length && checked === all.length;
  sheet.innerHTML = `<div class="download-sheet-toolbar"><button type="button" class="dl-secondary" data-dl-all="1">${allSelected ? '取消全选' : '全选'}</button><span>已选 ${checked}/${all.length} 集</span></div>
    <div class="download-sheet-grid">${episodes.map(ep => {
      const n = Number(ep.number) || 0;
      return `<label class="dl-ep ${downloadSelection.has(n) ? 'checked' : ''}" data-dl-ep="${n}"><span>${n}</span></label>`;
    }).join('')}</div>
    <div class="download-sheet-buttons"><button type="button" class="dl-secondary" data-dl-back="1">取消</button><button type="button" class="dl-primary" data-dl-confirm="1" ${checked ? '' : 'disabled'}>下载 ${checked ? checked + ' 集' : ''}</button></div>`;
}

async function resolveEpisodesForDownload(episodes) {
  const resolved = [];
  const detailEpisodes = asArray(state.detail.episodes);
  const hgJobs = [];
  for (const n of episodes) {
    if (privateMode()) {
      // 黄果源：选集列表的 url 只是剧集页面地址，不能直接用；分集是 m3u8 流，
      // 由 APK 本地拉 m3u8/分片（走后端代理同播放链路）并用本地 ffmpeg 封装 mp4，不依赖后端转码
      hgJobs.push({ n, p: api('episode', { id: state.detail.id, episode: n }) });
      continue;
    }
    const meta = detailEpisodes.find(ep => Number(ep.number) === n);
    if (meta && meta.url) { resolved.push({ index: n, url: meta.url, key: '' }); continue; }
    let data;
    try {
      data = await api('episode', { id: state.detail.id, episode: n });
    } catch (error) {
      throw new Error(`第 ${n} 集播放地址解析失败：${error.message || '未知错误'}`);
    }
    const source = String(data && data.source || '');
    if (!/^https?:\/\//i.test(source)) {
      throw new Error(`第 ${n} 集没有拿到有效的播放地址（${source.slice(0, 40) || '为空'}），请稍后重试`);
    }
    resolved.push({ index: n, url: source, key: data.key || '' });
  }
  for (const j of hgJobs) {
    let data;
    try { data = await j.p; } catch (error) { throw new Error(`第 ${j.n} 集播放地址解析失败：${error.message || '未知错误'}`); }
    const source = String(data && data.source || '');
    if (!/^https?:\/\//i.test(source)) throw new Error(`第 ${j.n} 集没有拿到有效的播放地址（${source.slice(0, 40) || '为空'}），请稍后重试`);
    resolved.push({ index: j.n, url: source, key: '' });
  }
  if (!resolved.length) throw new Error('没有可下载的分集');
  const bad = resolved.find(r => !/^https?:\/\//i.test(String(r.url || '')));
  if (bad) throw new Error(`第 ${bad.index} 集播放地址无效，已取消提交`);
  return resolved;
}

async function submitDownloadTo(target) {
  if (downloadParsing) return;
  if (target === 'nas') {
    if (!state.account.loggedIn) { toast('请先登录账号', true); return; }
    // 提交前再强制拉一次最新角色，避免本地缓存陈旧误判非管理员
    try { const fresh = await api('refresh-account'); if (fresh && fresh.role) setAccount(fresh); } catch (ignore) {}
    if (state.account.role !== 'admin') { toast('仅管理员可下载到 NAS', true); return; }
  }
  const episodes = asArray(state.detail.episodes).map(ep => Number(ep.number) || 0).filter(n => downloadSelection.has(n));
  if (!episodes.length) { toast('请先选择集数', true); return; }
  downloadParsing = true;
  downloadMode = 'parsing';
  renderDownloadSheet();
  try {
    if (target === 'nas') {
      // NAS 自主解析：只推 seriesId/title/集数，由后端调红果 App 接口取流（最高画质档）
      await api('nas-download-start', { source: contentSource, title: state.detail.title, seriesId: String(state.detail.seriesId || state.detail.id), episodes, cover: state.detail.cover || '' });
      toast('已提交 NAS 下载任务（后端自行解析取流）');
    } else {
      // 下载到手机。
      // 判定依据优先级：① 当前详情页实际内容源（detail.source，与详情/播放完全一致，杜绝全局模式脱节）；
      // ② 实时问原生端 content-status；③ 全局 contentSource。
      let sourceNow = String(state.detail?.source || '');
      if (sourceNow !== 'huangguo' && sourceNow !== 'hongguo') {
        try { const fresh = await api('content-status'); if (fresh && fresh.source) sourceNow = fresh.source; } catch (ignore) {}
        if (sourceNow !== 'huangguo' && sourceNow !== 'hongguo') sourceNow = contentSource;
      }
      // 下载到手机：黄果/红果一律手机本地（黄果经后端代理拉 m3u8/ts → 本地合并单集 mp4）。
      // 原"走后端转发"(proxyMode=3：NAS 全权下载→手机拉→手机合并)已废弃：手机本地 ts→mp4
      // 合并（含源显式 IV 保留）修好后，转发无需 NAS 下载合并，与代理/直连同一条链路；
      // NAS 端"下载到 NAS"入口仍保留（主动下载到 NAS 用）。
      let proxyModeNow = Number(state.proxyMode) || 3;
      try { const pmv = await api('get-proxy-mode'); if (pmv !== null && pmv !== undefined && pmv !== '') proxyModeNow = Number(pmv) || 3; } catch (ignore) {}
      console.log(`[dl-judge] source=${sourceNow} proxyMode=${proxyModeNow} role=${state.account?.role}`);
      {
        const resolved = await resolveEpisodesForDownload(episodes);
        if (!resolved.length) throw new Error('没有可下载的分集');
        // 调试模式：仍是「下载到手机」，但要求原生保留 TS/KEY、不自动合并，最后打成一个调试包
        const debug = target === 'phone-debug';
        await api('download-start', { source: sourceNow, title: state.detail.title, episodes: resolved, debug, cover: state.detail.cover || '' });
        toast(debug
          ? `调试模式已开始（${resolved.length} 集）：分片下完后会导出「第NN集_调试包.zip」到 Download/Veyra/${state.detail.title}`
          : `判定[源=${sourceNow} 通道=${proxyModeNow}] 已开始下载到手机（手机经代理拉源合并）`);
      }
    }
    hideDownloadSheet();
  } catch (error) {
    downloadParsing = false;
    downloadMode = 'target';
    renderDownloadSheet();
    toast(`${target === 'nas' ? '提交失败' : '下载失败'}：${error.message}`, true);
  }
}

function renderSettings() {
  content.innerHTML = `<div class="settings-page"><button type="button" class="listing-back" data-back="1">${icon('back')} 返回我的</button><h1>设置</h1>
    ${window.renderAppearance ? window.renderAppearance() : ''}
    <section><button type="button" class="settings-link" data-account-management="1"><span><strong>账号管理</strong><small>${state.account.loggedIn ? esc(state.account.username) : '登录或注册账号'}</small></span>${icon('arrow')}</button></section>
    <section><button type="button" class="settings-link" data-proxy-open><span><strong>黄果网络通道</strong><small data-proxy-summary>${esc(proxySummaryText())}</small></span>${icon('arrow')}</button></section>
    <section><button type="button" class="settings-link" data-about-open><span><strong>关于 Veyra</strong><small>项目地址 · GPL-3.0 开源</small></span>${icon('arrow')}</button></section></div>`;
  if (window.bindAppearance) window.bindAppearance();
  api('hot-update-status').then(window.hgHotUpdateStatus).catch(() => {});
}

const PROXY_MODE_NAMES = { 1: '仅直连', 2: '仅代理', 3: '走后端转发' };
// 走后端转发仅管理员/特权组可用；普通用户选项灰色，点击提示联系管理员
const roleCanUseBackend = () => state.account?.role === 'admin' || state.account?.role === 'vip';
function setProxyModeLabel(mode) {
  state.proxyMode = Number(mode) || 3;
  if (state.proxyMode < 1 || state.proxyMode > 3) state.proxyMode = 3;
  if (state.proxyMode === 3 && !roleCanUseBackend()) state.proxyMode = 1; // 普通用户不允许走后端转发
  const label = document.getElementById('proxy-mode-label');
  if (label) label.textContent = PROXY_MODE_NAMES[state.proxyMode] || '走后端转发';
  const menu = document.getElementById('proxy-mode-menu');
  if (menu) {
    for (const item of menu.querySelectorAll('[data-mode]')) {
      item.classList.toggle('active', Number(item.dataset.mode) === state.proxyMode);
      item.classList.toggle('disabled', Number(item.dataset.mode) === 3 && !roleCanUseBackend());
      item.toggleAttribute('disabled', Number(item.dataset.mode) === 3 && !roleCanUseBackend());
    }
  }
  updateProxySummary();
}
// 让弹窗只增长到“展开的下拉底部 + 12px”，不够时仍允许滚动兜底。
function fitPopToMenu(menu) {
  const pop = menu.closest('.appearance-pop');
  if (!pop || menu.hidden) return;
  pop.style.minHeight = '';
  const overflow = menu.getBoundingClientRect().bottom - pop.getBoundingClientRect().bottom;
  if (overflow > 0) pop.style.minHeight = `${Math.ceil(pop.offsetHeight + overflow + 12)}px`;
  menu.scrollIntoView({ block: 'nearest' });
}

function initProxyModeDropdown() {
  const root = document.getElementById('proxy-mode-dd');
  if (!root) return;
  const toggle = root.querySelector('[data-mode-toggle]');
  const menu = document.getElementById('proxy-mode-menu');
  if (!toggle || !menu) return;
  const close = () => { menu.hidden = true; toggle.setAttribute('aria-expanded', 'false'); root.dataset.open = 'false'; };
  toggle.addEventListener('click', event => {
    event.stopPropagation();
    menu.hidden = !menu.hidden;
    toggle.setAttribute('aria-expanded', String(!menu.hidden));
    root.dataset.open = String(!menu.hidden);
    // 展开时按菜单实际溢出量把弹窗“刚好”加高（多留 12px），收起后恢复原高度。
    if (!menu.hidden) requestAnimationFrame(() => fitPopToMenu(menu));
    else { const pop = menu.closest('.appearance-pop'); if (pop) pop.style.minHeight = ''; }
  });
  for (const item of menu.querySelectorAll('[data-mode]')) {
    item.addEventListener('click', event => {
      event.stopPropagation();
      const value = Number(item.dataset.mode) || 3;
      if (value === 3 && !roleCanUseBackend()) {
        toast('走后端转发仅管理员与特权组可用，请联系管理员开通', true);
        return;
      }
      setProxyModeLabel(value);
      close();
      api('set-proxy-mode', { value }).then(() => {
        toast(`已切换：${PROXY_MODE_NAMES[value] || value}`, false);
      }).catch(error => {
        setProxyModeLabel(state.proxyMode);
        toast(error.message, true);
      });
    });
  }
  document.addEventListener('click', event => {
    if (!root.contains(event.target)) close();
  });
}

function accountRoleInfo() {
  const role = state.account?.role;
  return role === 'admin' ? { key: 'admin', label: '管理员' }
    : role === 'vip' ? { key: 'vip', label: '特权用户' }
    : { key: 'user', label: '普通用户' };
}
// 头像即换头像入口：不再单列“从相册更换头像”按钮，点头像本身走同一条 data-choose-avatar 链路。
function accountIdentityHtml() {
  const account = state.account;
  const role = accountRoleInfo();
  return `<section class="account-identity"><button type="button" class="account-avatar-pick" data-choose-avatar="1" aria-label="点击头像从相册更换"><img src="${esc(account.avatar || 'user.svg')}" alt=""></button><div><strong>${esc(account.username)}</strong><span class="account-role is-${role.key}">${role.label}</span></div></section>`;
}

function renderAccountManagement() {
  const account = state.account;
  content.innerHTML = `<div class="settings-page account-page"><button type="button" class="listing-back" data-back="1">${icon('back')} 返回设置</button><h1>账号管理</h1>
    ${account.loggedIn ? `${accountIdentityHtml()}
      <section class="settings-account"><h2>修改密码</h2><p>先验证旧密码，再设置新密码。</p>
        <form id="password-form" class="password-form">
          <label for="old-password">旧密码</label><input id="old-password" type="password" autocomplete="current-password" required>
          <label for="new-password">新密码</label><input id="new-password" type="password" autocomplete="new-password" required>
          <p id="password-error" class="auth-error" role="alert" hidden></p><button type="submit">确认修改</button>
        </form></section>
      <section class="settings-account"><h2>同步与登录</h2><button type="button" data-sync-now="1">立即同步片单</button><button type="button" data-logout="1" aria-live="polite">退出登录</button></section>` : `<section class="settings-account"><p>登录后可同步收藏和观看历史，并管理头像与密码。</p><button type="button" data-account-action="1">登录或注册</button></section>`}</div>`;
}

// v0.18.108：账号管理弹窗（复用外观弹窗 scrim/pop 结构，body 锁滚动共用 .appearance-open）
var accountPop = null;
function buildAccountPopHtml() {
  const account = state.account;
  const body = account.loggedIn
    ? `${accountIdentityHtml()}
      <section class="settings-account"><h2>修改密码</h2><p>先验证旧密码，再设置新密码。</p>
        <form id="password-form" class="password-form">
          <label for="old-password">旧密码</label><input id="old-password" type="password" autocomplete="current-password" required>
          <label for="new-password">新密码</label><input id="new-password" type="password" autocomplete="new-password" required>
          <p id="password-error" class="auth-error" role="alert" hidden></p><button type="submit">确认修改</button>
        </form></section>
      <section class="settings-account"><h2>同步与登录</h2><button type="button" data-sync-now="1">立即同步片单</button><button type="button" data-logout="1" aria-live="polite">退出登录</button></section>`
    : `<section class="settings-account"><p>登录后可同步收藏和观看历史，并管理头像与密码。</p><button type="button" data-account-action="1">登录或注册</button></section>`;
  return `<div class="appearance-pop account-pop" role="dialog" aria-modal="true" aria-labelledby="account-title">
    <div class="appearance-head"><h2 id="account-title">账号管理</h2><button type="button" class="appearance-close" data-account-close aria-label="关闭">✕</button></div>
    ${body}</div>`;
}
function ensureAccountPop() {
  if (accountPop && document.body.contains(accountPop)) return accountPop;
  accountPop = document.createElement('div');
  accountPop.className = 'appearance-scrim';
  accountPop.hidden = true;
  accountPop.addEventListener('click', event => {
    if (event.target === accountPop || event.target.closest('[data-account-close]')) { closeAccountPop(); return; }
  });
  document.body.appendChild(accountPop);
  return accountPop;
}
function openAccountPop() {
  ensureAccountPop();
  accountPop.innerHTML = buildAccountPopHtml();
  accountPop.hidden = false;
  document.body.classList.add('appearance-open');
}
function closeAccountPop() {
  if (!accountPop || accountPop.hidden) return;
  accountPop.hidden = true;
  document.body.classList.remove('appearance-open');
}
window.__veyraAccountBack = () => { if (accountPop && !accountPop.hidden) { closeAccountPop(); return true; } return false; };
window.__veyraAccountOpen = () => !!(accountPop && !accountPop.hidden);
// v0.18.109：黄果网络通道/关于 Veyra 弹窗化（同账号管理弹窗，复用外观 scrim/pop 结构）
function proxySummaryText() {
  const m = PROXY_MODE_NAMES[state.proxyMode] || '走后端转发';
  return state.proxy ? `${m} · ${state.proxy}` : m;
}
function updateProxySummary() {
  const el = document.querySelector('[data-proxy-summary]');
  if (el) el.textContent = proxySummaryText();
}
var proxyPop = null;
function buildProxyPopHtml() {
  return `<div class="appearance-pop account-pop proxy-pop" role="dialog" aria-modal="true" aria-labelledby="proxy-title">
    <div class="appearance-head"><h2 id="proxy-title">黄果网络通道</h2><button type="button" class="appearance-close" data-proxy-close aria-label="关闭">✕</button></div>
    <p class="appearance-note">仅黄果/私密模式生效，红果永远直连不受影响；选择后立即生效，无需重启。</p>
    <div class="settings-storage">${privateMode() ? '<button type="button" data-return-public>返回红果（公开模式）</button>' : '<button type="button" data-enter-private>进入私密模式</button>'}</div>
    <div class="proxy-test-row">
      <input id="proxy-address" class="settings-input" type="text" placeholder="代理地址 host:port，如 192.168.31.108:7893" value="${esc(state.proxy || '')}" autocomplete="off" aria-label="黄果代理地址">
      <button type="button" id="proxy-test" class="proxy-test-btn">检测</button>
    </div>
    <span id="proxy-test-result" class="proxy-test-result" hidden></span>
    <div class="proxy-mode-dd" id="proxy-mode-dd">
      <button type="button" class="proxy-mode-dd-btn" data-mode-toggle aria-haspopup="listbox" aria-expanded="false"><span id="proxy-mode-label">${esc(PROXY_MODE_NAMES[state.proxyMode] || '走后端转发')}</span>${icon('arrow')}</button>
      <div class="proxy-mode-dd-menu" id="proxy-mode-menu" hidden>
        <button type="button" data-mode="1">仅直连</button>
        <button type="button" data-mode="2">仅代理</button>
        <button type="button" data-mode="3">走后端转发</button>
      </div>
    </div>
  </div>`;
}
function ensureProxyPop() {
  if (proxyPop && document.body.contains(proxyPop)) return proxyPop;
  proxyPop = document.createElement('div');
  proxyPop.className = 'appearance-scrim';
  proxyPop.hidden = true;
  proxyPop.addEventListener('click', event => {
    if (event.target === proxyPop || event.target.closest('[data-proxy-close]')) { closeProxyPop(); return; }
  });
  document.body.appendChild(proxyPop);
  return proxyPop;
}
function openProxyPop() {
  ensureProxyPop();
  proxyPop.innerHTML = buildProxyPopHtml();
  proxyPop.hidden = false;
  document.body.classList.add('appearance-open');
  api('get-proxy').then(value => {
    state.proxy = value || '';
    const input = document.getElementById('proxy-address');
    if (input) input.value = state.proxy;
    updateProxySummary();
  }).catch(() => {});
  api('get-proxy-mode').then(value => { setProxyModeLabel(Number(value) || 3); }).catch(() => {});
  const input = document.getElementById('proxy-address');
  if (input) input.addEventListener('change', () => {
    const value = input.value.trim();
    state.proxy = value;
    api('set-proxy', { value }).then(() => { toast('代理地址已保存'); updateProxySummary(); }).catch(error => toast(error.message, true));
  });
  const testBtn = document.getElementById('proxy-test');
  const testResult = document.getElementById('proxy-test-result');
  if (testBtn && testResult) {
    testBtn.addEventListener('click', () => {
      testBtn.disabled = true; testBtn.textContent = '检测中…'; testResult.hidden = true;
      api('test-proxy').then(value => {
        const v = value || {};
        testResult.textContent = `通 · ${Number(v.ms) || '?'}ms`;
        testResult.classList.remove('fail'); testResult.classList.add('ok'); testResult.hidden = false;
      }).catch(error => {
        testResult.textContent = `不通：${error.message}`;
        testResult.classList.remove('ok'); testResult.classList.add('fail'); testResult.hidden = false;
      }).finally(() => { testBtn.disabled = false; testBtn.textContent = '检测'; });
    });
  }
  initProxyModeDropdown();
}
function closeProxyPop() {
  if (!proxyPop || proxyPop.hidden) return;
  proxyPop.hidden = true;
  document.body.classList.remove('appearance-open');
}
window.__veyraProxyBack = () => { if (proxyPop && !proxyPop.hidden) { closeProxyPop(); return true; } return false; };
window.__veyraProxyOpen = () => !!(proxyPop && !proxyPop.hidden);

var aboutPop = null;
function buildAboutPopHtml() {
  return `<div class="appearance-pop account-pop" role="dialog" aria-modal="true" aria-labelledby="about-title">
    <div class="appearance-head"><h2 id="about-title">关于 Veyra</h2><button type="button" class="appearance-close" data-about-close aria-label="关闭">✕</button></div>
    <p class="appearance-note">项目地址：<button type="button" class="settings-url" data-open-url="https://github.com/gybeyond1/Veyra">github.com/gybeyond1/Veyra</button> <button type="button" data-check-update>检查更新</button></p>
    <p class="appearance-note">Veyra 基于开源项目二次开发，遵循 GPL-3.0 开源协议发布，完整源码、自建后端与 Docker 部署说明见仓库。</p>
  </div>`;
}
function ensureAboutPop() {
  if (aboutPop && document.body.contains(aboutPop)) return aboutPop;
  aboutPop = document.createElement('div');
  aboutPop.className = 'appearance-scrim';
  aboutPop.hidden = true;
  aboutPop.addEventListener('click', event => {
    if (event.target === aboutPop || event.target.closest('[data-about-close]')) { closeAboutPop(); return; }
  });
  document.body.appendChild(aboutPop);
  return aboutPop;
}
function openAboutPop() {
  ensureAboutPop();
  aboutPop.innerHTML = buildAboutPopHtml();
  aboutPop.hidden = false;
  document.body.classList.add('appearance-open');
}
function closeAboutPop() {
  if (!aboutPop || aboutPop.hidden) return;
  aboutPop.hidden = true;
  document.body.classList.remove('appearance-open');
}
window.__veyraAboutBack = () => { if (aboutPop && !aboutPop.hidden) { closeAboutPop(); return true; } return false; };
window.__veyraAboutOpen = () => !!(aboutPop && !aboutPop.hidden);


function renderSearch() {
  const filters = privateMode() ? [['all', '全部'], ['ai-duanju', '成人短剧'], ['ai-manju', '成人漫剧'], ['ai-huanlian', 'AI换脸'], ['ai-mogai', 'AI魔改']] : [['all', '全部'], ['short', '短剧'], ['comic', '漫剧']];
  const all = asArray(state.search?.items);
  const items = state.filter === 'all' ? all : all.filter(item => {
    if (item.category) return item.category === state.filter;
    const title = String(item.title || '');
    if (state.filter === 'ai-huanlian') return /AI\s*换脸/.test(title);
    if (state.filter === 'ai-mogai') return /AI\s*魔改/.test(title);
    if (state.filter === 'ai-manju') return /漫剧/.test(title);
    return !/AI\s*(换脸|魔改)|漫剧/.test(title);
  });
  const { blocks, singles } = seriesGroups(items);
  const cards = [...blocks.map(seriesBlock), ...singles.map(itemCard)].join('');
  content.innerHTML = `<div class="search-page"><h1>搜索结果</h1><p>${esc(state.query)} · ${items.length} 部作品</p>${searchFeedback()}<div class="filter-row">${filters.map(([id, label]) => `<button type="button" data-filter="${id}" class="${state.filter === id ? 'active' : ''}">${label}</button>`).join('')}</div>
    ${items.length ? `<div class="search-grid">${cards}</div>` : '<div class="empty-state">没有找到匹配的影片</div>'}</div>`;
  hydrateImages();
}

/** 按红果官方系列键（albumId=related_album_id）分组：同一 album 的剧合并为系列块，组内按官方季序号排序。 */
function seriesGroups(items) {
  const groups = new Map();
  const singles = [];
  for (const item of items) {
    const aid = item.albumId;
    if (aid && aid !== '0') {
      if (!groups.has(aid)) groups.set(aid, []);
      groups.get(aid).push(item);
    } else singles.push(item);
  }
  const blocks = [];
  for (const [aid, members] of groups) {
    const seasons = members.slice().sort((a, b) => {
      const sa = Number(a.seasonIndex) > 0 ? Number(a.seasonIndex) : 99;
      const sb = Number(b.seasonIndex) > 0 ? Number(b.seasonIndex) : 99;
      return sa - sb;
    });
    const lead = seasons.find(it => Number(it.seasonIndex) === 1) || seasons[0];
    blocks.push({ aid, title: lead?.title || '系列', cover: lead?.cover || '', seasons });
  }
  blocks.sort((a, b) => String(a.title).localeCompare(String(b.title), 'zh'));
  return { blocks, singles };
}

function seriesBlock(group) {
  const head = esc(group.title || '系列');
  return `<section class="series-block" data-album="${esc(group.aid)}">
    <div class="series-head"><span class="poster loading small"><img data-cover="${esc(group.cover || '')}" alt=""></span>
    <div class="series-meta"><h3>${head}</h3><span>官方系列 · ${group.seasons.length} 季</span></div></div>
    <div class="series-row">${group.seasons.map(itemCard).join('')}</div></section>`;
}

function listingFooter() {
  const listing = state.listing;
  if (listing.error) return '<button type="button" data-retry-listing="1">加载失败，点击重试</button>';
  if (listing.loading) return '<span role="status">正在加载更多…</span>';
  if (listing.refreshing) return '<span role="status">正在更新列表…</span>';
  if (listing.nextPage) return listing.kind === 'tag-list' ? '<span class="listing-sentinel" aria-hidden="true"></span>' : '<span class="listing-sentinel">继续下滑加载更多</span>';
  return '<span>已经到底了</span>';
}

function observeListingEnd() {
  listingObserver?.disconnect();
  if (state.route !== 'listing' || !state.listing?.nextPage || state.listing.loading ||
      state.listing.refreshing || state.listing.error) return;
  const sentinel = content.querySelector('.listing-sentinel');
  if (!sentinel) return;
  if (!listingObserver) {
    listingObserver = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) loadMoreListing();
    }, { root: scroll, rootMargin: '0px 0px 320px 0px' });
  }
  listingObserver.observe(sentinel);
}

function updateListingFooter() {
  const footer = content.querySelector('.listing-footer');
  if (!footer) return;
  footer.innerHTML = listingFooter();
  observeListingEnd();
}

function renderListing() {
  const listing = state.listing;
  if (!listing?.items.length && listing?.refreshing) { renderSkeleton(); return; }
  const tagName = String(listing.label || listing.slug).replace(/^#+/, '');
  const tagTitle = privateMode() ? `#${tagName}` : `${listing.slug?.startsWith('comic:') ? '漫剧' : '短剧'} · ${tagName}`;
  const title = listing.kind === 'tag-list' ? tagTitle : listing.kind === 'recommend' ? '精选推荐' : privateMode() ? '最近上新' : '热门漫剧';
  const backLabel = listing.kind === 'tag-list' && state.listingReturn?.route === 'tags' ? '返回全部类型' : '返回首页';
  content.innerHTML = `<div class="listing-page"><button class="listing-back" type="button" data-back="1">${icon('back')} ${backLabel}</button>
    <h1>${esc(title)}</h1><p>已显示 ${listing.items.length} 部作品</p>
    ${listing.items.length ? `<div class="search-grid listing-grid">${listing.items.map(itemCard).join('')}</div>` : '<div class="empty-state">这个标签下暂无作品</div>'}
    <div class="listing-footer">${listingFooter()}</div></div>`;
  hydrateImages();
  observeListingEnd();
}

function renderDetail() {
  const data = state.detail;
  if (!data) { renderSkeleton(); return; }
  const loading = state.detailLoading;
  window.AndroidHost?.setDetailMode?.(true);
  const episodes = asArray(data.episodes);
  content.innerHTML = `<div class="detail-page"><button class="detail-back" type="button" data-back="1">${icon('back')} 返回</button>
    <div class="detail-art"><img data-cover="${esc(data.cover)}" alt=""></div><div class="detail-copy"><h1>${esc(data.title)}</h1><p>${loading ? '正在获取内容…' : `${esc(data.score)} ${esc(data.episodeLabel)}`}</p><div class="detail-desc-wrap"><p class="detail-description">${esc(data.description || '')}</p></div>
    <div class="detail-buttons"><button class="detail-play" type="button" data-play="1" ${loading ? 'disabled' : ''}>${loading ? '正在加载…' : '立即播放'}</button><button class="bookmark-button" type="button" data-bookmark="1" aria-label="${state.bookmarked ? '取消收藏' : '收藏'}" ${loading ? 'disabled' : ''}>${state.bookmarked ? '★' : '☆'}</button><button class="detail-download" type="button" data-download="1" ${loading ? 'disabled' : ''}>下载</button></div>
    ${loading ? '<div class="detail-loading" role="status">正在获取选集…</div>' : episodes.length ? `<h2>选集</h2><div class="episode-grid">${episodes.map((item, index) => `<button type="button" data-episode="${item.number}" class="${index === 0 ? 'active' : ''}">${item.number}</button>`).join('')}</div>` : ''}</div></div>`;
  hydrateImages();
}

function searchFeedback() {
  if (state.searchPending) return '<div class="search-feedback" role="status" aria-live="polite"><span class="search-spinner" aria-hidden="true"></span><span>正在更新搜索结果…</span></div>';
  if (state.searchError) return `<div class="search-feedback search-feedback--error" role="status"><span>更新失败，当前显示缓存结果</span><button type="button" data-retry="search">重试</button></div>`;
  return '';
}
function renderSearchLoading() {
  content.innerHTML = `<section class="search-loading" role="status" aria-live="polite" aria-busy="true"><span class="search-spinner search-spinner--large" aria-hidden="true"></span><h1>正在搜索…</h1><p>${esc(state.query)}</p></section>`;
}
function renderSkeleton() {
  content.innerHTML = '<div class="skeleton-home" role="status" aria-label="正在加载内容"><div class="skeleton skeleton-hero"></div><div class="skeleton skeleton-title"></div><div class="skeleton-row"><div class="skeleton skeleton-poster"></div><div class="skeleton skeleton-poster"></div><div class="skeleton skeleton-poster"></div></div><div class="skeleton skeleton-line"></div></div>';
}
function renderError(error, retry) {
  if (state.route === 'detail') window.AndroidHost?.setDetailMode?.(false);
  if (/站点连接失败|站点请求失败|failed to connect|unable to resolve host|unknownhost|connectexception|sockettimeoutexception|timed? out|network is unreachable|connection reset|connection refused|网络|连接失败|无法连接/i.test(error?.message || '')) {
    content.innerHTML = `<div class="error-state error-state--network" role="alert">
      <div class="error-main">
        <svg class="error-icon" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="24" cy="24" r="21"/><path d="m12 24 6-5 6 5 6-5 6 5"/></svg>
        <h1>网络走丢了</h1>
      </div>
      <div class="error-footer"><p>请尝试使用代理网络，或联系开发者。</p><button type="button" data-retry="${esc(retry)}">重新尝试</button></div>
    </div>`;
    return;
  }
  content.innerHTML = `<div class="error-state">${esc(error.message || '加载失败，请稍后重试')}<button type="button" data-retry="${esc(retry)}">重试</button></div>`;
}

function rememberScreen() {
  if (state.route === 'detail') return;
  const previewContent = content.cloneNode(true);
  previewContent.removeAttribute('id');
  screenSnapshots[state.route] = {
    content: previewContent, scrollTop: scroll.scrollTop,
    horizontalScroll: [...content.querySelectorAll('.film-row,.filter-row,.home-tag-scroll')].map(row => row.scrollLeft)
  };
}
function captureScreen() {
  rememberScreen();
  return {
    route: state.route, tab: state.tab, pageNode: content.firstElementChild,
    scrollTop: scroll.scrollTop, searchValue: searchInput.value,
    listing: state.route === 'listing' ? state.listing : null,
    listingReturn: state.listingReturn, tagsReturn: state.tagsReturn,
    compactHeld: state.compactHeld,
    horizontalScroll: [...content.querySelectorAll('.film-row,.filter-row,.home-tag-scroll')].map(row => row.scrollLeft)
  };
}
function restoreScreen(snapshot) {
  if (!snapshot?.pageNode) { goHome(); return; }
  ++routeToken;
  listingObserver?.disconnect();
  categoryObserver?.disconnect();
  setRoute(snapshot.route);
  state.tab = snapshot.tab;
  state.compactHeld = snapshot.compactHeld;
  if (snapshot.listing) state.listing = snapshot.listing;
  state.listingReturn = snapshot.listingReturn;
  state.tagsReturn = snapshot.tagsReturn;
  content.replaceChildren(snapshot.pageNode);
  if (snapshot.route === 'home') refreshHomeHistory();
  if (snapshot.route === 'library') renderLibrary();
  if (snapshot.route === 'settings') renderSettings();
  searchInput.value = snapshot.searchValue || '';
  document.querySelectorAll('#dock [data-nav]').forEach(button => button.classList.toggle('active', button.dataset.nav === state.tab));
  scroll.scrollTop = snapshot.scrollTop || 0;
  content.querySelectorAll('.film-row,.filter-row,.home-tag-scroll').forEach((row, index) => {
    row.scrollLeft = snapshot.horizontalScroll?.[index] || 0;
  });
  hydrateImages();
  if (isBannerRoute()) { restoreBannerIndex(); scheduleBannerAuto(); }
  if (snapshot.route === 'category') { compact.innerHTML = compactMarkup(); updateCompact(); observeCategoryEnd(); }
  if (snapshot.route === 'listing') observeListingEnd();
}

function updateBackEnabled() {
  const modalOpen = [unlockOverlay, authOverlay, confirmOverlay, updateOverlay, downloadOverlay].some(overlay => !overlay.hidden);
  window.AndroidHost?.setBackEnabled(modalOpen || !isRootColumn());
}

function setRoute(route) {
  stopBannerAuto();
  if (route !== 'downloads') stopDownloadsTimer();
  if (state.route === 'detail' && route !== 'detail') { detailCard?.dispose(); detailCard = null; }
  const libraryArea = ['library', 'settings', 'account-management'].includes(route);
  if (state.route === 'library' && route !== 'library') searchInput.value = '';
  state.route = route;
  window.hgScheduleResourceApply?.();
  document.getElementById('app').dataset.route = route;
  window.hgThemeRefresh?.();
  document.getElementById('app').classList.toggle('route-detail', route === 'detail');
  window.AndroidHost?.setDetailMode?.(route === 'detail');
  headerSettings.hidden = route !== 'library';
  window.__bingeUpdateChrome && window.__bingeUpdateChrome();
  searchInput.placeholder = libraryArea ? '搜索观看历史和收藏' : privateMode() ? '搜索剧名或 #标签' : '搜索剧名';
  searchInput.setAttribute('aria-label', libraryArea ? '搜索观看历史和收藏' : '搜索剧名或标签');
  if (route === 'library') searchInput.value = state.libraryQuery;
  updateBackEnabled();
  // 落到根页面就补预取：否则用户点 tab 进来立刻横滑时，相邻页还没缓存、落的是骨架，
  // 提交时必然整套重渲染 → 「滑完闪一下」。放在 idle 里跑，不抢首帧。
  if (['home', 'category', 'library'].includes(route)) scheduleSwipePrefetch();
}

// 合并短时间内的多次触发；只补缺失的相邻页缓存，已有的直接跳过。
let swipePrefetchTimer = 0;
function scheduleSwipePrefetch(delay = 260) {
  clearTimeout(swipePrefetchTimer);
  swipePrefetchTimer = setTimeout(() => {
    if (document.hidden || swiping || swipeTrack) return;
    swipePrefetchAll().catch(() => { });
  }, delay);
}

function isRootColumn() { return ['home', 'category', 'library'].includes(state.route); }

function backDestination() {
  if (isRootColumn()) return null;
  if (state.route === 'campaign') return state.campaignReturn?.route || 'home';
  if (state.route === 'detail') return state.previous?.route || 'home';
  if (state.route === 'account-management') return state.accountReturn?.route || 'settings';
  if (state.route === 'downloads') return state.settingsReturn?.route || 'settings';
  if (state.route === 'settings') return state.settingsReturn?.route || 'library';
  if (state.route === 'tags') return state.tagsReturn?.route || 'home';
  if (state.route === 'listing' && state.listing?.kind === 'tag-list') return state.listingReturn?.route || 'home';
  return state.route === 'home' ? null : 'home';
}

function clearPredictivePreview() {
  clearTimeout(predictiveTimer);
  if (predictiveFrame) cancelAnimationFrame(predictiveFrame);
  predictiveFrame = null;
  if (predictiveSourceNode && predictivePreview?.contains(predictiveSourceNode)) predictiveSourceNode.remove();
  predictiveSourceNode = null;
  predictivePreview?.remove();
  predictivePreview = null;
  document.getElementById('app').classList.remove('predictive-active');
  scroll.style.removeProperty('transition');
  scroll.style.removeProperty('transform');
}

window.hgPredictiveBackStart = fromRight => {
  clearPredictivePreview();
  if (!downloadOverlay.hidden || (window.__veyraAppearanceOpen && window.__veyraAppearanceOpen()) || (window.__veyraAccountOpen && window.__veyraAccountOpen()) || (window.__veyraProxyOpen && window.__veyraProxyOpen()) || (window.__veyraAboutOpen && window.__veyraAboutOpen())) return false;
  if (state.route === 'detail' && detailCard && authOverlay.hidden && confirmOverlay.hidden && updateOverlay.hidden && unlockOverlay.hidden) {
    detailCard.fromRight = fromRight;
    return detailCard.begin();
  }
  const destination = backDestination();
  const fromDetail = state.route === 'detail' && state.previous?.route === destination && state.previous.pageNode;
  const snapshot = fromDetail ? state.previous : screenSnapshots[destination];
  if (!snapshot) return false;
  const preview = document.createElement('div');
  preview.className = 'back-preview';
  preview.setAttribute('aria-hidden', 'true');
  if (state.route === 'detail' || state.route === 'settings') {
    const header = document.querySelector('#app > .app-top').cloneNode(true);
    const settings = header.querySelector('.header-settings');
    settings.hidden = destination !== 'library';
    if (destination === 'library') {
      const input = header.querySelector('.search-input');
      input.placeholder = '搜索观看历史和收藏';
      input.value = state.libraryQuery;
    }
    header.querySelectorAll('[id]').forEach(node => node.removeAttribute('id'));
    preview.appendChild(header);
  }
  if (fromDetail) {
    const holder = document.createElement('div');
    holder.style.transform = `translateY(${-snapshot.scrollTop}px)`;
    predictiveSourceNode = snapshot.pageNode;
    holder.appendChild(predictiveSourceNode);
    preview.appendChild(holder);
  } else {
    predictiveSourceNode = snapshot.content;
    predictiveSourceNode.style.transform = `translateY(${-snapshot.scrollTop}px)`;
    preview.appendChild(predictiveSourceNode);
  }
  document.getElementById('app').appendChild(preview);
  preview.querySelectorAll('.film-row,.filter-row,.home-tag-scroll').forEach((row, index) => {
    row.scrollLeft = snapshot.horizontalScroll?.[index] || 0;
  });
  document.getElementById('app').classList.add('predictive-active');
  scroll.style.transition = 'none';
  predictivePreview = preview;
  predictivePreview.fromRight = fromRight;
  return true;
};

window.hgPredictiveBackProgress = progress => {
  if (state.route === 'detail' && detailCard?.phase === 'dragging') {
    detailCard.predictive(Math.max(0, Math.min(1, progress)), detailCard.fromRight);
    return;
  }
  if (!predictivePreview) return;
  pendingPredictiveProgress = Math.max(0, Math.min(1, progress));
  if (predictiveFrame) return;
  predictiveFrame = requestAnimationFrame(() => {
    predictiveFrame = null;
    if (!predictivePreview) return;
    const direction = predictivePreview.fromRight ? -1 : 1;
    scroll.style.transform = `translate3d(${direction * pendingPredictiveProgress * 100}%,0,0)`;
  });
};

window.hgPredictiveBackCancel = () => {
  if (state.route === 'detail' && detailCard?.phase === 'dragging') { detailCard.cancel(); return; }
  if (!predictivePreview) return;
  if (predictiveFrame) cancelAnimationFrame(predictiveFrame);
  predictiveFrame = null;
  scroll.style.transition = 'transform 180ms ease-out';
  scroll.style.transform = 'translate3d(0,0,0)';
  predictiveTimer = setTimeout(clearPredictivePreview, 180);
};

window.hgPredictiveBackCommit = () => {
  if (!downloadOverlay.hidden) { hideDownloadSheet(); return true; }
  if (window.__veyraAppearanceBack && window.__veyraAppearanceBack()) return true;
  if (window.__veyraAccountBack && window.__veyraAccountBack()) return true;
  if (window.__veyraProxyBack && window.__veyraProxyBack()) return true;
  if (window.__veyraAboutBack && window.__veyraAboutBack()) return true;
  if (state.route === 'detail' && detailCard && downloadOverlay.hidden && authOverlay.hidden && confirmOverlay.hidden && updateOverlay.hidden && unlockOverlay.hidden) {
    detailCard.close(); return true;
  }
  if (!predictivePreview) return window.hgBack();
  if (predictiveFrame) cancelAnimationFrame(predictiveFrame);
  predictiveFrame = null;
  const direction = predictivePreview.fromRight ? -1 : 1;
  scroll.style.transition = 'transform 150ms ease-out';
  scroll.style.transform = `translate3d(${direction * 100}%,0,0)`;
  predictiveTimer = setTimeout(() => {
    const oldPage = content.firstElementChild;
    if (!window.hgBack()) { clearPredictivePreview(); return; }
    if (content.firstElementChild !== oldPage) { clearPredictivePreview(); return; }
    clearPredictivePreview();
  }, 150);
  return true;
};

function setNav(tab) {
  listingObserver?.disconnect();
  categoryObserver?.disconnect();
  document.querySelectorAll('#dock [data-nav]').forEach(button => button.classList.toggle('active', button.dataset.nav === tab));
  compact.classList.remove('visible');
  compact.inert = true;
  state.compactHeld = false;
  scroll.scrollTop = 0;
}

async function goHome() {
  const token = ++routeToken;
  const adopted = swipeAdopting; swipeAdopting = false;   // 滑动已把首页真实 DOM 放好了就别再画一遍
  stopBannerAuto();
  setRoute('home'); state.tab = 'home'; setNav('home');
  const refreshing = api('home');
  const [cached, library] = await Promise.all([api('cached', { key: 'home' }).catch(() => null), api('library').catch(() => null)]);
  if (token !== routeToken) return;
  state.library = library;
  state.home = cached?.data || null;
  if (adopted && state.home) { try { hydrateImages(); scheduleBannerAuto(); } catch (ignore) { } }
  else if (state.home) renderHome(); else renderSkeleton();
  try {
    const fresh = await refreshing;
    if (token !== routeToken) return;
    const changed = state.home && homeSignature(state.home) !== homeSignature(fresh);
    const firstLoad = !state.home;
    state.home = fresh;
    if (firstLoad || changed) renderHome();
    else refreshMissingImages([...asArray(fresh.featured), ...asArray(fresh.recommend?.items), ...asArray(fresh.newest?.items)]);
    if (changed) toast('更新成功');
  } catch (error) { if (!state.home && token === routeToken) renderError(error, 'home'); }
}

async function goTags() {
  const token = ++routeToken;
  if (state.route !== 'tags') state.tagsReturn = captureScreen();
  setRoute('tags'); state.tab = 'home'; setNav('home');
  const refreshing = api('tags');
  const cached = await api('cached', { key: 'tags' }).catch(() => null);
  if (token !== routeToken) return;
  state.tags = cached?.data || state.tags;
  if (state.tags) renderTags(); else renderSkeleton();
  try {
    const fresh = await refreshing;
    if (token !== routeToken) return;
    const changed = JSON.stringify(state.tags?.items) !== JSON.stringify(fresh.items);
    const previousScroll = scroll.scrollTop;
    state.tags = fresh;
    if (changed) { renderTags(); scroll.scrollTop = previousScroll; }
  } catch (error) { if (token === routeToken && !state.tags) renderError(error, 'tags'); }
}

async function goTag(slug, label) {
  const token = ++routeToken;
  if (state.route !== 'listing' || state.listing?.kind !== 'tag-list' || state.listing?.slug !== slug) state.listingReturn = captureScreen();
  setRoute('listing'); state.tab = 'home'; setNav('home');
  searchInput.value = `#${privateMode() ? '' : (slug.startsWith('comic:') ? '漫剧·' : '短剧·')}${String(label).replace(/^#+/, '')}`;
  const refreshing = api('tag-list', { slug, page: 1 });
  const cached = await api('cached', { key: `tag:${slug}:1` }).catch(() => null);
  if (token !== routeToken) return;
  const firstLoad = !cached?.data;
  state.listing = cached?.data ? { ...cached.data, kind: 'tag-list', slug, label, refreshing: true, loading: false, error: false } :
    { items: [], nextPage: null, kind: 'tag-list', slug, label, refreshing: true, loading: false, error: false };
  renderListing();
  try {
    const fresh = await refreshing;
    if (token !== routeToken) return;
    const changed = listSignature(state.listing) !== listSignature(fresh) || state.listing.nextPage !== fresh.nextPage;
    const previousScroll = scroll.scrollTop;
    state.listing = { ...fresh, kind: 'tag-list', slug, label, refreshing: false, loading: false, error: false };
    if (firstLoad || changed) { renderListing(); scroll.scrollTop = previousScroll; }
    else updateListingFooter();
  } catch (error) {
    if (token !== routeToken) return;
    if (!state.listing.items.length) renderError(error, 'tag-list');
    else { state.listing.refreshing = false; updateListingFooter(); toast('列表更新失败，已显示缓存内容', true); }
  }
}

async function goTagQuery(query) {
  const name = query.replace(/^[#＃]\s*/, '').trim();
  if (!name) { goTags(); return; }
  let tags = asArray(state.tags?.items);
  if (!tags.length) {
    const cached = await api('cached', { key: 'tags' }).catch(() => null);
    tags = asArray(cached?.data?.items);
  }
  if (!tags.length) {
    try { const fresh = await api('tags'); state.tags = fresh; tags = asArray(fresh.items); }
    catch { toast('标签暂时无法加载，请重试', true); return; }
  }
  const normalize = value => String(value || '').replace(/^#+/, '').trim().toLocaleLowerCase();
  const matches = item => normalize(item.name) === normalize(name) || (!privateMode() &&
    normalize(`${item.group === 'comic' ? '漫剧' : '短剧'}·${item.name}`) === normalize(name));
  let tag = tags.find(matches);
  if (!tag) {
    try { const fresh = await api('tags'); state.tags = fresh; tag = asArray(fresh.items).find(matches); }
    catch { /* 已有清单仍可用于搜索 */ }
  }
  if (tag) goTag(tag.slug, tag.name);
  else toast('没有找到这个标签', true);
}

async function openListing(kind) {
  if (kind !== 'recommend' && kind !== 'newest') return;
  const token = ++routeToken;
  rememberScreen();
  listingObserver?.disconnect();
  setRoute('listing'); state.tab = 'home';
  setNav('home');
  const initial = state.home?.[kind];
  state.listing = {
    kind, items: [...asArray(initial?.items)], nextPage: initial?.nextPage || null,
    refreshing: true, loading: false, error: false
  };
  renderListing();
  try {
    const fresh = await api(kind, { page: 1 });
    if (token !== routeToken) return;
    state.listing.items = asArray(fresh.items);
    state.listing.nextPage = fresh.nextPage;
    state.listing.refreshing = false;
    const previousScroll = scroll.scrollTop;
    renderListing();
    scroll.scrollTop = previousScroll;
  } catch (error) {
    if (token !== routeToken) return;
    state.listing.refreshing = false;
    if (!state.listing.items.length) renderError(error, 'listing');
    else { updateListingFooter(); toast('列表更新失败，已显示缓存内容', true); }
  }
}

async function loadMoreListing() {
  const listing = state.listing;
  if (state.route !== 'listing' || !listing?.nextPage || listing.refreshing || listing.loading || listing.error) return;
  const token = routeToken;
  const pageNumber = listing.nextPage;
  listing.loading = true;
  updateListingFooter();
  try {
    const page = await api(listing.kind, { page: pageNumber, slug: listing.slug });
    if (token !== routeToken || state.listing !== listing || state.route !== 'listing') return;
    const known = new Set(listing.items.map(item => String(item.id)));
    const added = asArray(page.items).filter(item => {
      const id = String(item.id);
      if (known.has(id)) return false;
      known.add(id);
      return true;
    });
    listing.items.push(...added);
    listing.nextPage = page.items?.length && page.nextPage > pageNumber ? page.nextPage : null;
    const grid = content.querySelector('.listing-grid');
    if (grid && added.length) {
      grid.insertAdjacentHTML('beforeend', added.map(itemCard).join(''));
      const images = [...grid.querySelectorAll('img[data-cover]')].slice(-added.length);
      images.forEach((image, index) => index < 8 ? loadCoverInto(image) : observer.observe(image));
    }
    const count = content.querySelector('.listing-page > p');
    if (count) count.textContent = `已显示 ${listing.items.length} 部作品`;
  } catch (error) {
    if (token === routeToken && state.listing === listing && state.route === 'listing') listing.error = true;
  } finally {
    listing.loading = false;
    if (state.listing === listing && state.route === 'listing') updateListingFooter();
  }
}

async function goCategory(tab, sub = state.sub[tab], keepCompact = false) {
  const token = ++routeToken;
  const adopted = swipeAdopting; swipeAdopting = false;
  categoryObserver?.disconnect();
  if (state.route === 'home') rememberScreen();
  setRoute('category'); state.tab = tab; state.sub[tab] = sub; state.category = null; state.categoryBanner = 0;
  if (!keepCompact) setNav(tab);
  const id = categoryId();
  const refreshing = api('category', { id, page: 1 });
  const cached = await api('cached', { key: `category:${id}:1` }).catch(() => null);
  if (token !== routeToken) return;
  state.category = cached?.data ? { ...cached.data, refreshing: true, loading: false, error: false } : null;
  // adopted：滑动已把这一页真实 DOM 放下 —— 绝不换骨架、绝不重渲染（那一闪就是它）。
  // 只补图片 + 续上「滚动到底加载更多」；底层数据等 fresh 到了再更新（见下方 try）。
  if (adopted) { try { hydrateImages(); } catch (ignore) { } if (state.category) observeCategoryEnd(); }
  else if (state.category) renderCategory(keepCompact); else renderSkeleton();
  try {
    const fresh = await refreshing;
    if (token !== routeToken) return;
    // 覆盖前先记住旧值：否则下方 firstLoad/changed 判断会拿到“已被 fresh 覆盖”的 state.category，
    // 恒为 false，导致无缓存时骨架一直残留、内容永远不渲染（就是那一闪/卡住）。
    const previousCategory = state.category;
    state.category = { ...fresh, refreshing: false, loading: false, error: false };
    state.categoryItems = asArray(fresh.items);
    if (adopted) {
      // 维持已落位的 DOM，只补齐图片与页脚，不整体重渲染（避免那一闪）
      try { refreshMissingImages(asArray(fresh.items)); } catch (ignore) { }
      updateCategoryFooter();
    } else {
      const changed = previousCategory && listSignature(previousCategory) !== listSignature(fresh);
      const firstLoad = !previousCategory;
      const previousScroll = scroll.scrollTop;
      if (firstLoad || changed) {
        renderCategory(keepCompact || state.compactHeld);
        if (!firstLoad) scroll.scrollTop = previousScroll;
      } else {
        refreshMissingImages(asArray(fresh.items));
        updateCategoryFooter();
      }
      if (changed) toast('更新成功');
    }
  } catch (error) {
    if (token !== routeToken) return;
    if (!state.category) renderError(error, 'category');
    else { state.category.refreshing = false; updateCategoryFooter(); toast('列表更新失败，已显示缓存内容', true); }
  }
}

async function goLibrary(tab = 'history') {
  const token = ++routeToken;
  const adopted = swipeAdopting; swipeAdopting = false;
  if (state.route === 'home') rememberScreen();
  state.libraryTab = tab;
  setRoute('library'); state.tab = 'library'; setNav('library');
  if (!adopted) renderSkeleton();
  try {
    const library = await api('library'); if (token !== routeToken) return; state.library = library;
    if (adopted) {
      // DOM 已落位，只补图片；但下载页的任务进度要实时，交给它自己刷列表
      try { hydrateImages(); } catch (ignore) { }
      if (state.libraryTab === 'downloads') renderLibraryDownloads();
    } else renderLibrary();
  }
  catch (error) { if (token === routeToken) renderError(error, 'library'); }
}

function goSettings() {
  state.settingsReturn = captureScreen();
  setRoute('settings'); state.tab = 'library'; setNav('library');
  refreshPrivateStatus();
  renderSettings();
}

// 进设置页时刷新一次私密解锁状态（只更新状态，不触发重渲染循环）
let privateStatusRefreshing = false;
async function refreshPrivateStatus() {
  if (privateStatusRefreshing) return;
  privateStatusRefreshing = true;
  try {
    const status = await api('content-status');
    state.privateUnlocked = Boolean(status.unlocked);
  } catch { /* 网络异常时保持上次状态 */ }
  finally { privateStatusRefreshing = false; }
}

function goAccountManagement() {
  if (state.route === 'account-management') return;
  if (state.route !== 'settings') goSettings();
  state.accountReturn = captureScreen();
  setRoute('account-management');
  renderAccountManagement();
}

async function goSearch(query) {
  const token = ++routeToken;
  if (state.route === 'home') rememberScreen();
  state.previous = { route: state.route, tab: state.tab };
  setRoute('search'); state.query = query.trim(); state.filter = 'all'; state.search = null;
  state.searchPending = true; state.searchError = '';
  scroll.scrollTop = 0;
  renderSearchLoading();
  let settled = false;
  let timeout;
  const refreshing = api('search', { query: state.query });
  api('cached', { key: `search:${state.query}` }).then(cached => {
    if (settled || token !== routeToken || !cached?.data) return;
    state.search = cached.data;
    renderSearch();
  }).catch(() => {});
  try {
    const fresh = await Promise.race([refreshing, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('搜索连接超时，请重试')), 25000);
    })]);
    if (token !== routeToken) return;
    state.searchPending = false; state.search = fresh;
    renderSearch();
  } catch (error) {
    if (token !== routeToken) return;
    state.searchPending = false;
    if (state.search) { state.searchError = error.message || '搜索刷新失败'; renderSearch(); }
    else renderError(error, 'search');
  } finally {
    settled = true;
    clearTimeout(timeout);
  }
}

function sourceItem(id) {
  const candidates = [state.listing?.items, state.home?.featured, state.home?.homepageRecommend, state.home?.homepageNewest, state.home?.recommend?.items, state.home?.newest?.items, state.category?.items, state.search?.items, state.library?.bookmarks, state.library?.progress].flatMap(asArray);
  return candidates.find(item => item.id === id) || { id, title: `剧集 ${id}` };
}
async function goDetail(id, trigger) {
  if (state.route === 'detail' && state.sourceItem?.id === id) {
    // Retry in place; preserve the original source card and return destination.
    state.detailLoading = true; renderDetail();
    const token = ++routeToken;
    try { const fresh = await api('detail', { id }); if (token === routeToken) { state.detail = fresh; state.detailLoading = false; if (state.detail && state.detail.title) rememberTitleCover(state.detail.title, state.detail.cover || ''); renderDetail(); } }
    catch (error) { if (token === routeToken) { state.detailLoading = false; renderError(error, 'detail'); } }
    return;
  }
  const token = ++routeToken;
  const entrySource = bannerChanging && trigger?.closest('.hero') ? null : HGCardTransition.capture(trigger);
  rememberScreen();
  state.previous = {
    route: state.route, tab: state.tab, sub: state.sub[state.tab], query: state.query,
    filter: state.filter, scrollTop: scroll.scrollTop, compactHeld: state.compactHeld,
    horizontalScroll: [...content.querySelectorAll('.film-row,.filter-row,.home-tag-scroll')].map(row => row.scrollLeft),
    pageNode: content.firstElementChild
  };
  if (state.route === 'listing' && state.listing) state.listing.refreshing = false;
  listingObserver?.disconnect();
  categoryObserver?.disconnect();
  state.sourceItem = sourceItem(id);
  state.sourceGroup = state.route === 'category' ? categoryId() : state.sourceItem.category || '';
  const aiGroup = state.sourceGroup === 'ai-huanlian' || state.sourceGroup === 'ai-mogai';
  const candidates = state.route === 'category' ? asArray(state.category?.items) : state.route === 'search' ? asArray(state.search?.items) : state.route === 'listing' ? asArray(state.listing?.items) :
    [...asArray(state.home?.recommend?.items), ...asArray(state.home?.newest?.items)];
  state.sourceQueue = aiGroup ? candidates.filter(item => item.category === state.sourceGroup) : [];
  setRoute('detail'); state.detail = { ...state.sourceItem }; state.detailLoading = true; state.bookmarked = false;
  // title→cover 记录：NAS 老任务后端没存封面，下载列表渲染时按剧名兜底
  if (state.detail && state.detail.title) rememberTitleCover(state.detail.title, state.detail.cover || '');
  scroll.scrollTop = 0;
  updateCompact();
  renderDetail();
  if (entrySource) {
    detailCard = new HGCardTransition({
      app: document.getElementById('app'), scroll, content, source: entrySource, snapshot: state.previous,
      isDetail: () => state.route === 'detail',
      onClose: () => { returnFromDetail(); trigger?.focus({ preventScroll: true }); }
    });
    detailCard.open();
  }
  const refreshing = api('detail', { id });
  const cached = await api('cached', { key: `detail:${id}` }).catch(() => null);
  if (token !== routeToken) return;
  let hasDetailData = Boolean(cached?.data);
  if (hasDetailData) { state.detail = cached.data; state.detailLoading = false; renderDetail(); }
  api('bookmark-state', { id }).then(saved => { if (token === routeToken) { state.bookmarked = saved; if (state.detail) renderDetail(); } }).catch(() => {});
  try { const fresh = await refreshing; if (token === routeToken) { state.detail = fresh; state.detailLoading = false; renderDetail(); } }
  catch (error) { if (!hasDetailData && token === routeToken) { state.detailLoading = false; renderError(error, 'detail'); } }
}

function returnFromDetail() {
  const previous = state.previous || { route: 'home', tab: 'home' };
  if (!previous.pageNode) { goHome(); return; }
  ++routeToken;
  setRoute(previous.route);
  state.tab = previous.tab;
  if (previous.route === 'category') state.sub[previous.tab] = previous.sub;
  state.query = previous.query || '';
  state.filter = previous.filter || 'all';
  state.compactHeld = previous.compactHeld;
  content.replaceChildren(previous.pageNode);
  state.previous = null;
  content.querySelectorAll('.film-row,.filter-row,.home-tag-scroll').forEach((row, index) => {
    row.scrollLeft = previous.horizontalScroll?.[index] || 0;
  });
  document.querySelectorAll('#dock [data-nav]').forEach(button =>
    button.classList.toggle('active', button.dataset.nav === state.tab));
  scroll.scrollTop = previous.scrollTop || 0;
  if (previous.route === 'category') compact.innerHTML = compactMarkup();
  updateCompact();
  hydrateImages();
  if (previous.route === 'home') refreshHomeHistory();
  if (previous.route === 'category') observeCategoryEnd();
  if (previous.route === 'listing') observeListingEnd();
  if (isBannerRoute()) { restoreBannerIndex(); scheduleBannerAuto(); }
}

window.hgBack = () => {
  if (window.__veyraAppearanceBack && window.__veyraAppearanceBack()) return true;
  if (window.__veyraAccountBack && window.__veyraAccountBack()) return true;
  if (window.__veyraProxyBack && window.__veyraProxyBack()) return true;
  if (window.__veyraAboutBack && window.__veyraAboutBack()) return true;
  if (!downloadOverlay.hidden) { hideDownloadSheet(); return true; }
  if (!unlockOverlay.hidden) { closeUnlock(); return true; }
  if (!authOverlay.hidden) { if (state.account.loggedIn) hideAuth(); return true; }
  if (!confirmOverlay.hidden) { closeConfirmation(false); return true; }
  if (!updateOverlay.hidden) { updateOverlay.hidden = true; updateBackEnabled(); if (updateDownloading) toast('已转入后台下载，完成后会自动弹出安装', true); return true; }
  if (isRootColumn()) return false;
  if (state.route === 'campaign') { restoreScreen(state.campaignReturn); return true; }
  if (state.route === 'account-management') { restoreScreen(state.accountReturn); return true; }
  if (state.route === 'settings') { restoreScreen(state.settingsReturn); return true; }
  if (state.route === 'detail') { if (detailCard) detailCard.close(); else returnFromDetail(); return true; }
  if (state.route === 'listing' && state.listing?.kind === 'tag-list') { restoreScreen(state.listingReturn); return true; }
  if (state.route === 'tags') { restoreScreen(state.tagsReturn); return true; }
  if (state.route === 'listing') { goHome(); return true; }
  if (state.route === 'search') { searchInput.value = ''; goHome(); return true; }
  if (state.route !== 'home') { goHome(); return true; }
  return false;
};
window.hgResume = () => {
  window.hgRefreshPendingResources?.();
  window.hgThemeRefresh?.();
  retryFailedImages(true);
  if (state.route === 'library') goLibrary(state.libraryTab);
  if (state.route === 'home') refreshHomeHistory();
  if (state.route === 'detail' && state.detail) api('bookmark-state', { id: state.detail.id }).then(value => { state.bookmarked = value; renderDetail(); });
};

async function openPlayer(episode = 1) {
  const detail = state.detail;
  if (!detail) return;
  const item = { ...state.sourceItem, ...detail };
  const queue = state.sourceQueue.length ? [...state.sourceQueue] : [item];
  if (!queue.some(candidate => candidate.id === item.id)) queue.unshift(item);
  const index = queue.findIndex(candidate => candidate.id === item.id);
  await api('open-player', { item, detail, episodes: asArray(detail.episodes), queue, index, group: state.sourceGroup, episode });
}

async function loadMoreCategory() {
  const category = state.category;
  if (state.route !== 'category' || !category?.nextPage || category.loading || category.refreshing || category.error) return;
  const token = routeToken;
  const next = category.nextPage;
  const id = categoryId();
  category.loading = true;
  updateCategoryFooter();
  try {
    const page = await api('category', { id, page: next });
    if (token !== routeToken || state.category !== category || state.route !== 'category' || categoryId() !== id) return;
    const existing = new Set(asArray(category.items).map(item => String(item.id)));
    const added = asArray(page.items).filter(item => {
      const itemId = String(item.id);
      if (existing.has(itemId)) return false;
      existing.add(itemId);
      return true;
    });
    category.items.push(...added);
    category.nextPage = page.items?.length && page.nextPage > next ? page.nextPage : null;
    const grid = content.querySelector('.category-grid');
    if (grid && added.length) {
      grid.insertAdjacentHTML('beforeend', added.map(itemCard).join(''));
      [...grid.querySelectorAll('img[data-cover]')].slice(-added.length)
        .forEach((image, index) => index < 8 ? loadCoverInto(image) : observer.observe(image));
    }
    const count = content.querySelector('.category-count');
    if (count) count.textContent = `已显示 ${category.items.length} 部`;
  } catch (error) {
    if (token === routeToken && state.category === category && state.route === 'category') category.error = true;
  } finally {
    category.loading = false;
    if (state.category === category && state.route === 'category') updateCategoryFooter();
  }
}

document.getElementById('search-form').addEventListener('submit', event => {
  event.preventDefault();
  const query = searchInput.value.trim();
  searchInput.blur();
  hideSearchSuggest();
  if (['library', 'settings', 'account-management'].includes(state.route)) {
    state.libraryQuery = query;
    if (state.route === 'library') renderLibrary();
    else goLibrary(state.libraryTab);
    scroll.scrollTop = 0;
    return;
  }
  if (/^[#＃]/.test(query)) goTagQuery(query);
  else if (query) { pushSearchHistory(query); goSearch(query); }
});
searchInput.addEventListener('input', () => {
  if (state.route === 'library') {
    state.libraryQuery = searchInput.value;
    renderLibrary();
    scroll.scrollTop = 0;
    return;
  }
  const v = searchInput.value.trim();
  if (!v) { hideSearchSuggest(); return; }
  clearTimeout(searchSuggestTimer);
  searchSuggestTimer = setTimeout(() => suggestSearch(v), 300);
});
searchInput.addEventListener('focus', () => {
  if (['library', 'settings', 'account-management'].includes(state.route)) return;
  const v = searchInput.value.trim();
  if (v) suggestSearch(v);
  else renderSearchHistory();
});
searchInput.addEventListener('blur', () => setTimeout(hideSearchSuggest, 200));

// ---- 搜索历史 + 实时联想（localStorage 持久化，词条可单独删除）----
const searchHistoryKey = 'search-history';
let searchSuggestTimer = null;
let searchSuggestSeq = 0;
function getSearchHistory() {
  try { return JSON.parse(localStorage.getItem(searchHistoryKey) || '[]'); } catch { return []; }
}
function pushSearchHistory(q) {
  q = String(q || '').trim();
  if (!q) return;
  let h = getSearchHistory().filter(x => x !== q);
  h.unshift(q);
  if (h.length > 20) h = h.slice(0, 20);
  try { localStorage.setItem(searchHistoryKey, JSON.stringify(h)); } catch {}
}
function removeSearchHistory(q) {
  try { localStorage.setItem(searchHistoryKey, JSON.stringify(getSearchHistory().filter(x => x !== q))); } catch {}
}
function searchSuggestEl() { return document.getElementById('search-suggest'); }
function hideSearchSuggest() {
  const el = searchSuggestEl();
  if (el) el.hidden = true;
  searchSuggestSeq++;
}
function renderSearchHistory() {
  const el = searchSuggestEl();
  if (!el) return;
  const h = getSearchHistory();
  if (!h.length) { el.hidden = true; return; }
  el.innerHTML = `<div class="search-suggest-title">搜索历史<button type="button" class="ss-clear" data-ss-clear>清空</button></div>
    <div class="search-suggest-list">${h.map(q => `<div class="search-suggest-item"><button type="button" class="ss-word" data-ss-word="${esc(q)}">${icon('clock')}<span>${esc(q)}</span></button><button type="button" class="ss-del" data-ss-del="${esc(q)}" aria-label="删除 ${esc(q)}">×</button></div>`).join('')}</div>`;
  el.hidden = false;
}
async function suggestSearch(v) {
  const seq = ++searchSuggestSeq;
  const el = searchSuggestEl();
  if (!el) return;
  let items = null;
  try {
    const fresh = await Promise.race([api('search', { query: v, suggest: true }), new Promise((_, rej) => setTimeout(() => rej(new Error('联想超时')), 6000))]);
    if (seq !== searchSuggestSeq || searchInput.value.trim() !== v) return;
    items = asArray(fresh && (fresh.items || fresh.data && fresh.data.items));
  } catch { return; }
  if (seq !== searchSuggestSeq) return;
  if (!items || !items.length) { el.hidden = true; return; }
  el.innerHTML = `<div class="search-suggest-title">联想结果</div><div class="search-suggest-list">${items.slice(0, 8).map(it => `<button type="button" class="search-suggest-card" data-open-id="${esc(it.id)}" data-ss-close>${it.cover ? `<span class="search-suggest-thumb"><img src="${esc(it.cover)}" alt="" loading="lazy" onerror="this.closest('.search-suggest-thumb').style.display='none'"></span>` : ''}<strong>${esc(it.title || '')}</strong>${it.episodeLabel ? `<em>${esc(it.episodeLabel)}</em>` : ''}</button>`).join('')}</div>`;
  el.hidden = false;
}
// 输入框聚焦时临时放行原生长按（复制/粘贴菜单），失焦后恢复全局禁选，其余区域仍禁长按
document.addEventListener('focusin', event => {
  const t = event.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
    api('input-edit', { active: true }).catch(() => {});
  }
});
document.addEventListener('focusout', event => {
  const t = event.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
    api('input-edit', { active: false }).catch(() => {});
  }
});
// 点击非输入区域时强制失焦输入框：软键盘收起后输入框往往仍聚焦，若不失焦则长按放行状态泄漏到全局（任意位置长按都弹系统菜单并震动）
document.addEventListener('pointerdown', event => {
  const active = document.activeElement;
  if (!active) return;
  if (active.tagName !== 'INPUT' && active.tagName !== 'TEXTAREA' && !active.isContentEditable) return;
  const t = event.target;
  if (!(t instanceof Element)) return;
  if (t !== active && !active.contains(t)) active.blur();
}, true);

document.addEventListener('submit', async event => {
  if (event.target.id !== 'password-form') return;
  event.preventDefault();
  const form = event.target;
  const oldPassword = form.querySelector('#old-password').value;
  const newPassword = form.querySelector('#new-password').value;
  const error = form.querySelector('#password-error');
  const button = form.querySelector('[type="submit"]');
  error.hidden = true;
  if (newPassword === oldPassword) { error.textContent = '新密码不能与旧密码相同'; error.hidden = false; return; }
  button.disabled = true;
  try { setAccount(await api('change-password', { oldPassword, newPassword })); toast('密码已修改'); }
  catch (failure) { error.textContent = failure.message || '修改失败，请稍后重试'; error.hidden = false; button.disabled = false; }
});

// ---- 全局左右滑动 v3：微信式双页跟随 ----
// cur = 真实 #scroll 直接平移（不搬 DOM、不动 scrollTop、页面事件全部保真），
// next = 底层面板，装目标页 DOM（优先页面缓存，秒出；无缓存给骨架）。
// 提交才真正路由，取消零副作用 —— 没有异步渲染竞态，也不会卡在半路。
const DOCK_ORDER = ['home', 'adult', 'ai', 'library'];
const LIBRARY_TABS = ['history', 'bookmarks', 'downloads'];
const SWIPE_MIN_PX = 40;        // 快速甩动的最短位移
const SWIPE_MIN_RATIO = 0.22;   // 或拖过屏宽 22%
const SWIPE_MAX_MS = 900;
let swiping = false;
let swipeStart = null;
let swipeAxis = null;
let swipeTrack = null;

// 目标页 DOM 缓存：key -> 节点克隆。滑动提交后写入，命中即免骨架。
const swipePageCache = new Map();
let swipePrefetchBusy = false;
// swipeSaveGuard： adopting 窗口内禁止 swipeSaveCurrent（见下方说明）
// swipeAdopting： 告诉下一次 go*()“目标页 DOM 已经就位，别再渲染一遍”
let swipeSaveGuard = false;
let swipeAdopting = false;
// 离屏容器：预取克隆挂在这里静默补图，不可见也不影响布局
const swipeOffstage = document.createElement('div');
swipeOffstage.style.cssText = 'position:fixed;left:-99999px;top:0;width:100%;visibility:hidden;pointer-events:none;';
document.addEventListener('DOMContentLoaded', () => document.body.appendChild(swipeOffstage));
if (document.body) document.body.appendChild(swipeOffstage);

// 空闲预取：把其余底栏页用真实数据渲染一遍、克隆进缓存，滑动时直接秒出真内容（骨架只是兜底）。
// 手法：取数据（不渲染）→ routeToken++ 作废在途渲染 → 同步渲染进 content → 克隆 → 同步恢复原页。
// 渲染与恢复之间没有 await，浏览器不会在中间绘制，用户全程看不到闪动。
async function swipePrefetch(keyOrFn, prepare, render) {
  if (swipePageCache.size >= 12 || swipePrefetchBusy || document.hidden || swiping || swipeTrack || state.route === 'detail') return;
  swipePrefetchBusy = true;
  try {
    // 阶段一（异步）：只取数据，绝不碰 state、绝不渲染 —— 期间用户随便操作。
    const data = await prepare();
    if (!data || swiping || swipeTrack || swipePageCache.size >= 12) return;
    const key = typeof keyOrFn === 'function' ? keyOrFn() : keyOrFn;
    if (!key || swipePageCache.has(key)) return;
    // 阶段二（同步窗口）：改 state → 渲染 → 克隆 → 恢复，中间没有任何 await，
    // 用户事件只能排在整个窗口之后，不存在竞态，也看不到闪动。
    routeToken++;
    const savedNode = content.firstElementChild;
    const resumeTop = scroll.scrollTop;   // 同步窗口开始时的真实滚动位置（取数阶段用户可能滚过）
    const saved = {
      route: state.route, tab: state.tab, sub: { ...state.sub }, libraryTab: state.libraryTab,
      library: state.library, libraryQuery: state.libraryQuery, home: state.home, category: state.category, categoryBanner: state.categoryBanner,
      categoryItems: state.categoryItems, query: state.query, filter: state.filter, compactHeld: state.compactHeld,
      compactHTML: compact.innerHTML,
    };
    let clone = null;
    try {
      render(data);
      const node = content.firstElementChild;
      // node === savedNode 说明 render 没真的产出新页面，绝不能把当前页当成目标页缓存
      if (node && node !== savedNode && swipeAdoptable(node)) {
        clone = node.cloneNode(true);
        // 预解码：真机首显大图要同步解码，滑动落位瞬间才解码就会掉帧（「卡一下」）。
        // 这里对克隆里的图提前触发 decode()，浏览器缓存解码结果，落位时直接上屏。
        setTimeout(() => {
          if (!clone || swiping || swipeTrack) return;
          for (const img of clone.querySelectorAll('img[src]')) {
            if (img.complete) continue;
            const probe = new Image();
            probe.src = img.src;
            if (probe.decode) probe.decode().catch(() => { });
          }
        }, 0);
      }
    } finally {
      routeToken++;
      stopBannerAuto();
      try { categoryObserver?.disconnect(); } catch (ignore) { }
      state.route = saved.route; state.tab = saved.tab; state.sub = saved.sub;
      state.libraryTab = saved.libraryTab; state.library = saved.library; state.libraryQuery = saved.libraryQuery; state.home = saved.home;
      state.category = saved.category; state.categoryBanner = saved.categoryBanner;
      state.categoryItems = saved.categoryItems;
      state.query = saved.query; state.filter = saved.filter; state.compactHeld = saved.compactHeld;
      content.replaceChildren(savedNode);
      compact.innerHTML = saved.compactHTML;
      scroll.scrollTop = resumeTop;
    }
    if (clone) {
      swipeOffstage.appendChild(clone);
      await swipePrimeImages(clone);  // 等离屏补图真正完成再入缓存：缓存里才有「已加载」的海报
      swipePageCache.set(key, clone);
      while (swipePageCache.size > 12) swipePageCache.delete(swipePageCache.keys().next().value);
    }
  } catch (error) { }
  swipePrefetchBusy = false;
}

async function swipePrefetchAll() {
  if (swipePrefetchBusy || document.hidden || state.route === 'detail') return;
  const homeJob = ['home', async () => {
    const cached = await api('cached', { key: 'home' }).catch(() => null);
    const home = cached?.data || await withTimeout(api('home'), 8000).catch(() => null);
    if (!home) return null;
    const library = await api('library').catch(() => null) || state.library;
    return { home, library };
  }, (data) => { state.home = data.home; state.library = data.library; renderHome(); }];
  const categoryJobs = [];
  for (const tab of ['adult', 'ai']) {
    (categoryIds[tab] || []).forEach((id, index) => {
      categoryJobs.push([
        'category:' + tab + ':' + index,
        async () => {
          const cached = await api('cached', { key: `category:${id}:1` }).catch(() => null);
          const fresh = cached?.data || await withTimeout(api('category', { id, page: 1 }), 8000).catch(() => null);
          return fresh ? { fresh, tab, sub: index } : null;
        },
        (data) => {
          state.tab = data.tab; state.sub[data.tab] = data.sub; state.categoryBanner = 0;
          state.category = { ...data.fresh, refreshing: false, loading: false, error: false };
          state.categoryItems = asArray(data.fresh.items);
          renderCategory();
        },
      ]);
    });
  }
  // “我的”三个子页都备一份：数据本来就在 state.library 里，纯本地渲染、不额外耗流量，
  // 这样左右切历史/收藏时落下就有真内容，不会再先闪一帧骨架。
  const libraryJobs = ['history', 'bookmarks', 'downloads'].map((tab, index) => [
    'library:' + tab,
    async () => {
      if (index === 0) return { library: await withTimeout(api('library'), 8000).catch(() => null) || state.library };
      if (index === 1) return { library: state.library };
      // downloads：预取时就把真实列表拉回来，克隆里才有真内容（否则滑到下载是骨架 → 提交时整套重渲染闪一下）
      let phone = [];
      try { phone = asArray(await withTimeout(api('download-list'), 4000)); } catch (ignore) { phone = []; }
      let nas = [];
      if (state.account.loggedIn) {
        try { nas = asArray((await withTimeout(api('nas-download-list'), 4000)).tasks); } catch (ignore) { nas = []; }
      }
      return { library: state.library, downloads: { phone, nas } };
    },
    (data) => {
      state.library = data.library; state.libraryTab = tab; state.libraryQuery = ''; state.query = '';
      if (tab !== 'downloads') { renderLibrary(); return; }
      // 下载页：先按正常布局搭出壳，再同步填进真实列表（克隆前就填好，免得克隆里是「正在加载…」）
      renderLibrary();
      const list = document.getElementById('library-downloads');
      if (list) { list.dataset.sig = ''; commitDownloadList(list, data.downloads.phone, data.downloads.nas, { noTimer: true }); }
    },
  ]);
  for (const [key, prepare, render] of [homeJob, ...categoryJobs, ...libraryJobs]) {
    if (document.hidden || swiping || swipeTrack) return;
    if (typeof key === 'string' && swipePageCache.has(key)) continue;
    // 单个 job 失败（接口超时/数据格式异常）不能拖垮整轮预取，否则排在它后面的页永远补不上
    try { await swipePrefetch(key, prepare, render); } catch (ignore) { }
  }
}

// 这些元素自身要横向滚动 / 有自己的横滑语义，手势让位（首页 .film-row 是网格不能横滚，所以不在列）。
const SWIPE_TAB_BAR_SELECTOR = '[role="tablist"].segmented,[role="tablist"].compact-tabs';
// 让位的手势区域：
//   .hero / .hero-dots 是顶部轮播，自己要左右翻页，不能被全局切页抢走；
//   子标签栏的手势归 seg-glass.js（按住拖动玻璃透镜，逻辑同底栏），
//   手指落在栏上时不起整页滑动 —— 但内容区横滑仍然可以切子项、透镜跟着走。
const SWIPE_IGNORE = '.filter-row,.home-tag-scroll,.search-form,input,textarea,select,.proxy-mode-dd-menu,.episode-grid'
  + ',.hero,.hero-dots,' + SWIPE_TAB_BAR_SELECTOR;

function swipeScrollOwner(node, dx) {
  let el = node;
  while (el && el !== scroll && el.nodeType === 1) {
    if (el.scrollWidth - el.clientWidth > 4) {
      const max = el.scrollWidth - el.clientWidth;
      if (dx < 0 && el.scrollLeft < max - 1) return el;
      if (dx > 0 && el.scrollLeft > 1) return el;
    }
    el = el.parentElement;
  }
  return null;
}

function swipeSubTabs() {
  if (state.route === 'library') return { list: LIBRARY_TABS, current: state.libraryTab };
  if (state.route === 'category') {
    const ids = categoryIds[state.tab] || [];
    return { list: ids.map((id, index) => index), current: state.sub[state.tab] };
  }
  return { list: [], current: null };
}

// 当前页缓存 key（提交时写入，滑动回来时命中）
function swipeCacheKey() {
  if (state.route === 'library') return 'library:' + state.libraryTab;
  if (state.route === 'category') return 'category:' + state.tab + ':' + state.sub[state.tab];
  return state.route;
}

function swipeSaveCurrent() {
  // 滑动提交 adopting 期间禁止保存：那时 content 已被换成目标页，
  // 再按旧的 state.route 存会把“目标页快照”写进“当前页”的 key，
  // 导致滑回来时预览显示成上一页的内容。
  if (swipeSaveGuard) return;
  const node = content.firstElementChild;
  if (!node || node.classList.contains('skeleton-home') || node.classList.contains('swipe-skel')) return;
  // 本体式：不再 cloneNode。克隆出的新 <img> 必须整批重新加载，而这一步既不等待也不预热，
  // 快速来回切时取出的就是“还没解码完”的克隆 → 又灰一帧。
  // 直接存本体：img 已加载状态随节点保留；这个节点随后会被 replaceChildren 替换掉，
  // 但缓存仍持有引用，不会丢失、也无需重新加载图片。
  swipeCleanCloneImages(node);
  node.querySelectorAll('*').forEach(el => { if (el.style && el.style.visibility === 'hidden') el.style.visibility = ''; });
  swipePageCache.set(swipeCacheKey(), node);
  if (swipePageCache.size > 12) swipePageCache.delete(swipePageCache.keys().next().value);
}

// 目标页节点是不是“真内容”（不是骨架/错误态）—— 是的话提交时直接采用，不许再重渲染一遍
function swipeAdoptable(node) {
  return !!node && !node.classList.contains('swipe-skel') && !node.classList.contains('error-state');
}

function swipeBuildCached(key) {
  const cached = swipePageCache.get(key);
  if (!cached) return null;
  // 取出本体、绝不再克隆：cloneNode 出来的新 <img> 必须整批重新走加载管线，
  // 落位那一帧全灰、再逐张回填（真机录屏已证实：连 spotlight 大图一起灰掉一帧）。
  // 移动节点（appendChild 已有节点）则 img 的加载/解码状态随节点保留，落位零闪。
  // 消耗掉的缓存由落位 1.5s 后的 swipePrefetchAll 自动补回。
  swipePageCache.delete(key);
  swipeCleanCloneImages(cached);
  return cached;
}

// 骨架按目标页真实布局生成（里面 + 列表 / 我的 + 子标签 + 卡片），不再是通用一张皮。
// key 形如 home / library:bookmarks / category:short:2
function swipeBuildSkeleton(key) {
  const wrap = document.createElement('div');
  if (String(key).indexOf('library:') === 0) {
    const cards = Array.from({ length: 4 }, () => '<div class="skeleton sk-card"></div>').join('');
    wrap.innerHTML = '<div class="library-page swipe-skel" role="status" aria-label="正在加载内容"><div class="my-heading"><h1>我的</h1></div>'
      + '<div class="segmented library-tabs skeleton-tabs" role="tablist"><span class="skeleton skeleton-pill"></span><span class="skeleton skeleton-pill"></span><span class="skeleton skeleton-pill"></span></div>'
      + '<p class="library-count"><span class="skeleton sk-sm"></span></p>'
      + `<div class="sk-list">${cards}</div></div>`;
  } else {
    const posters = Array.from({ length: 3 }, () => '<div class="skeleton skeleton-poster"></div>').join('');
    wrap.innerHTML = '<div class="swipe-skel" role="status" aria-label="正在加载内容"><div class="skeleton skeleton-hero"></div>'
      + '<div class="skeleton skeleton-title"></div><div class="skeleton-row">' + posters
      + '</div><div class="skeleton-row">' + posters + '</div></div>';
  }
  return wrap.firstElementChild;
}

// 页内切换时这些 tab 栏不跟着走：整页平移后对它们做反向位移，视觉上钉在原处，只有下方内容左右换。
// 同时手指落在上面时不起全局整页滑动 —— 该栏的手势交给 seg-glass.js（与底栏同一套逻辑）。

// 钉住集合 = tab 栏本身 + 它上方同属“页头”的区块（标题、登录条等），
// 这样页内切换时只有下方内容左右换，上面一切纹丝不动。
function swipeTabNodes(node) {
  if (!node) return [];
  const out = new Set();
  for (const tab of node.querySelectorAll(SWIPE_TAB_BAR_SELECTOR)) {
    out.add(tab);
    let el = tab;
    for (let depth = 0; el && el !== content && depth < 3; depth++) {
      let sib = el.previousElementSibling;
      while (sib) { out.add(sib); sib = sib.previousElementSibling; }
      el = el.parentElement;
    }
  }
  return [...out];
}

// 解析本次滑动去哪：先页内子标签，切到头溢出到底栏页；边界返回 null（阻尼回弹）。
function swipeResolve(delta) {
  const sub = swipeSubTabs();
  const pos = sub.list.indexOf(sub.current);
  if (sub.list.length > 1 && pos >= 0 && sub.list[pos + delta] !== undefined) {
    const next = sub.list[pos + delta];
    const key = state.route === 'library' ? 'library:' + next : 'category:' + state.tab + ':' + next;
    return {
      mode: 'inline',   // 页内子项：tab 栏与标题钉住，仅内容区平移
      key,              // 取消滑动时把预览节点（缓存本体）放回缓存用
      step: [pos, pos + delta],   // 高亮要跟着手从 pos 滑到 pos+delta
      // adopted：目标页 DOM 已由滑动的手放下（真内容），别再整体重渲染，否则会闪一下
      go: () => {
        const adopted = swipeAdopting; swipeAdopting = false; swipeSaveGuard = true;
        try {
          if (state.route === 'library') {
            state.libraryTab = next;
            if (!adopted) {
              // 没落下真内容（如首次滑动前尚未预取）——正常渲染
              renderLibrary();
            } else {
              // 沿用滑动放下的真内容，绝不整套重渲染（那一闪就是它）。
              // 下载页仍需拉最新进度并启动轮询 —— 交给 renderLibraryDownloads，
              // 命中签名守卫时只补图、不重建 DOM。
              for (const b of content.querySelectorAll('[data-library-tab]')) {
                const on = b.dataset.libraryTab === next;
                b.classList.toggle('selected', on);
                if (on) b.setAttribute('aria-selected', 'true'); else b.removeAttribute('aria-selected');
              }
              if (next === 'downloads') { try { renderLibraryDownloads(); } catch (ignore) { } }
              try { hydrateImages(); } catch (ignore) { }
            }
            scroll.scrollTop = 0;
          } else goCategory(state.tab, next);
        } finally { swipeSaveGuard = false; }
      },
      build: () => swipeBuildCached(key) || swipeBuildSkeleton(key),
    };
  }
  const index = DOCK_ORDER.indexOf(state.route === 'category' ? state.tab : state.route);
  const next = DOCK_ORDER[index + delta];
  if (!next) return null;
  const key = next === 'library' ? 'library:' + state.libraryTab
    : next === 'home' ? 'home' : 'category:' + next + ':' + (state.sub[next] || 0);
  return {
    mode: 'page',       // 底栏页之间：整页平移
    key,
    go: () => navigateDock(next),
    build: () => swipeBuildCached(key) || swipeBuildSkeleton(key),
  };
}

function swipeBlocked() {
  return swiping || state.route === 'detail'
    || [unlockOverlay, authOverlay, confirmOverlay, updateOverlay, downloadOverlay].some(overlay => !overlay.hidden)
    || document.body.classList.contains('predictive-active');
}

// 内容区横滑切子项时，页头 tab 的高亮必须跟手 —— 直接驱动 seg-glass 那枚玻璃透镜，
// 在两格之间连续插值（位置、宽度、某格文字同步变深），而不是松手才硬跳过去。
// 透镜与静止选中态是同一个元素，所以不存在"拖动中一个样、落地又一个样"。
function swipeBuildTabAnim(bar, step) {
  if (!bar || !step || !window.SegGlass) return null;
  const [from, to] = step;
  const items = [...bar.querySelectorAll('button')];
  if (items.length < 2 || !items[from] || !items[to] || from === to) return null;
  const seg = window.SegGlass.handle(bar);
  if (!seg) return null;
  seg.setDragging(true);       // 跟手期间关掉弹簧过渡
  return { seg, items, from, to };
}

function swipeTabProgress(t, ratio) {
  const anim = t && t.tabAnim;
  if (!anim) return;
  const q = Math.max(0, Math.min(1, ratio || 0));
  anim.seg.progress(anim.from, anim.to, q);
}

// 建轨：底层面板装目标页，真实 scroll 保持可见等待平移。
function swipeOpenTrack(delta, dx) {
  if (swiping || swipeTrack) return false;
  const resolve = swipeResolve(delta);
  if (!resolve) return false;
  const node = resolve.build();
  if (!node) return false;
  const box = scroll.getBoundingClientRect();
  const panel = document.createElement('div');
  panel.className = 'swipe-under';
  panel.style.background = getComputedStyle(scroll).background;   // 跟随当前页真实底色（主题渐变/暗色都一致）
  panel.style.top = `${Math.round(box.top)}px`;
  panel.style.height = `${Math.round(box.height)}px`;
  const inner = document.createElement('div');
  inner.className = 'swipe-page-inner';
  inner.style.paddingTop = getComputedStyle(scroll).paddingTop;
  inner.appendChild(node);
  panel.appendChild(inner);
  (document.getElementById('app') || document.body).appendChild(panel);
  // inline（页内子项）：页头克隆到独立固定层绝对钉住（不可能被任何容器裁剪），
  // 内容区单独平移；面板从内容区顶部开始，目标页页头临时摘除使内容对齐。
  const track = { panel, inner, mode: 'page', width: Math.round(box.width || scroll.clientWidth || 360), dirSign: delta > 0 ? 1 : -1, guard: 0, resolve, pinned: [], clones: [], moving: [], savedDisplays: [] };
  const pageNode = content.firstElementChild;
  if (resolve.mode === 'inline' && pageNode) {
    const tab = pageNode.querySelector(SWIPE_TAB_BAR_SELECTOR);
    if (tab && tab.parentElement) {
      const kids = [...tab.parentElement.children];
      const ti = kids.indexOf(tab);
      track.mode = 'inline';
      track.pinned = kids.slice(0, ti + 1);      // 页头 = tab 栏及其上方全部区块
      track.moving = kids.slice(ti + 1);          // 内容 = tab 栏下方全部
      // 页头壳：克隆整个页面节点、删掉内容区只留页头 —— DOM 上下文完整，布局与原页绝对一致，
      // 固定在页面原位（fixed 用视口坐标，含滚动偏移），拖动全程纹丝不动。
      const pageRect = pageNode.getBoundingClientRect();
      const shell = pageNode.cloneNode(true);
      const shellTab = shell.querySelector(SWIPE_TAB_BAR_SELECTOR);
      if (shellTab) {
        let sib = shellTab.nextElementSibling;
        while (sib) { const next = sib.nextElementSibling; sib.remove(); sib = next; }
        shell.style.cssText += `;position:fixed;left:${Math.round(pageRect.left)}px;top:${Math.round(pageRect.top)}px;width:${Math.round(pageRect.width)}px;margin:0;z-index:14;pointer-events:none;`;
        document.body.appendChild(shell);
        track.clones.push(shell);
        // 壳里的 tab 栏是克隆体：只要它的透镜跟手，不要再绑一套手势（它也收不到 pointer 事件）
        shellTab.setAttribute('data-seg-no-gesture', '');
        track.tabAnim = swipeBuildTabAnim(shellTab, resolve.step);
      }
      for (const el of track.pinned) el.style.visibility = 'hidden';   // 原页头让位给壳
      // 目标页页头临时摘除（display:none），其内容上移到面板顶部与当前页内容区对齐
      const nodeTab = node.querySelector(SWIPE_TAB_BAR_SELECTOR);
      if (nodeTab && nodeTab.parentElement) {
        const nk = [...nodeTab.parentElement.children];
        const ni = nk.indexOf(nodeTab);
        for (const el of nk.slice(0, ni + 1)) { track.savedDisplays.push([el, el.style.display]); el.style.display = 'none'; }
      }
    }
  }
  if (track.mode === 'inline') {
    const firstMoving = track.moving[0];
    const contentTop = firstMoving ? Math.round(firstMoving.getBoundingClientRect().top) : null;
    if (contentTop != null && contentTop > box.top) {
      panel.style.top = `${contentTop}px`;
      panel.style.height = `${Math.max(80, Math.round(box.bottom - contentTop))}px`;
      inner.style.paddingTop = '0';
      inner.style.overflow = 'hidden';
    } else {
      inner.style.paddingTop = getComputedStyle(scroll).paddingTop;
    }
    // 垂直对齐补偿：目标页页头摘除后，其根节点自身的 padding-top（如 .library-page 的 20px）
    // 仍占位，预览内容被往下推 —— 落地后页头恢复、内容上抬，肉眼就是一次跳变。
    // 测出目标内容首块与当前页内容首块的落差，用负 margin 拉平，预览与落地逐像素一致。
    const nodeTab = node.querySelector(SWIPE_TAB_BAR_SELECTOR);
    let firstTarget = null;
    if (nodeTab && nodeTab.parentElement) {
      const nk = [...nodeTab.parentElement.children];
      firstTarget = nk[nk.indexOf(nodeTab) + 1] || null;
    }
    if (firstMoving && firstTarget && firstTarget.offsetHeight > 0) {
      const align = Math.round(firstMoving.getBoundingClientRect().top - firstTarget.getBoundingClientRect().top);
      if (align) node.style.marginTop = `${align}px`;
    }
  } else {
    inner.style.paddingTop = getComputedStyle(scroll).paddingTop;
  }
  inner.appendChild(node);
  swipeTrack = track;
  routeToken++;   // 作废未落地的异步渲染，防止拖动中 content 被覆盖
  swipeLayTrack(dx);
  swipeTrack.guard = setTimeout(() => { if (swipeTrack) swipeCloseTrack(false); }, 1500);
  return true;
}

function swipeLayTrack(dx) {
  const t = swipeTrack;
  if (!t) return;
  if (t.mode === 'inline') {
    for (const el of t.moving) el.style.transform = `translateX(${dx}px)`;   // 只有内容区跟手
    swipeTabProgress(t, Math.abs(dx) / t.width);                              // 高亮同步跟到哪一格
  } else {
    scroll.style.transform = `translateX(${dx}px)`;
  }
  t.panel.style.transform = `translateX(${t.dirSign * t.width + dx}px)`;
}

// 收拾：把为跟手临时加的行内样式/克隆全部撤掉
function swipeClearTabs(t) {
  for (const el of t.pinned || []) el.style.visibility = '';
  for (const [el, d] of t.savedDisplays || []) el.style.display = d;
  for (const el of t.moving || []) el.style.transform = '';
  // 页头壳里的透镜提前释放：它是克隆体，随壳一起移除，这里只需把「拖动态」撤干净
  try { t.tabAnim?.seg?.blob && (t.tabAnim.seg.blob.style.transition = ''); } catch (ignore) { }
  for (const c of t.clones || []) c.remove();
}

// 松手：提交则当前页滑出、目标页落位并真正路由；取消则全部归位（零副作用）。
function swipeCloseTrack(commit) {
  const t = swipeTrack;
  if (!t) return;
  swipeTrack = null;
  swiping = true;
  clearTimeout(t.guard);
  const ease = 'transform .2s cubic-bezier(.22,.61,.36,1)';
  scroll.style.transition = ease;
  t.panel.style.transition = ease;
  const tabEase = 'transform .2s cubic-bezier(.22,.61,.36,1),width .2s cubic-bezier(.22,.61,.36,1),height .2s cubic-bezier(.22,.61,.36,1)';
  if (commit) {
    if (t.tabAnim) {   // 透镜跟着收尾动画一路滑到目标格，不是落地才跳
      const anim = t.tabAnim;
      anim.seg.blob.style.transition = tabEase;
      for (const el of anim.items) el.style.transition = 'color .2s ease';
      swipeTabProgress(t, 1);
    }
    scroll.style.transform = `translateX(${-t.dirSign * t.width}px)`;
    t.panel.style.transform = 'translateX(0)';
    setTimeout(() => {
      swipeClearTabs(t);   // 先撤掉页头 hidden / 内容位移等临时样式，再存当前页 —— 缓存里不能有脏快照
      swipeSaveCurrent();
      const node = t.inner.firstElementChild;
      if (node) node.style.marginTop = '';   // 撤掉滑动时的垂直对齐补偿，别带进真实页面
      scroll.style.transition = '';
      scroll.style.transform = '';
      if (node) { content.replaceChildren(node); scroll.scrollTop = 0; }
      t.panel.remove();
      swiping = false;
      // 预览已经是真内容 → 让这次路由只换状态、不再重画一遍（重画就是那一闪）
      swipeAdopting = swipeAdoptable(node);
      swipeSaveGuard = true;   // content 已被换成目标页，期间不许再存“当前页”
      try { const result = t.resolve.go(); if (result && result.catch) result.catch(() => { }); } catch (ignore) { }
      swipeSaveGuard = false;
      swipeAdopting = false;
      setTimeout(() => { swipePrefetchAll().catch(() => { }); }, 1500);
    }, 210);
  } else {
    if (t.tabAnim) {
      const anim = t.tabAnim;
      for (const el of anim.items) el.style.transition = 'color .2s ease';
      anim.seg.blob.style.transition = tabEase;   // 行内过渡优先于 .dragging 的 none
      swipeTabProgress(t, 0);
    }
    scroll.style.transform = 'translateX(0)';
    t.panel.style.transform = `translateX(${t.dirSign * t.width}px)`;
    setTimeout(() => {
      swipeClearTabs(t);
      const node = t.inner.firstElementChild;
      if (node) node.style.marginTop = '';   // 缓存/复用的克隆不带对齐补偿
      // 预览用的是缓存本体（取出式），取消要把节点放回缓存，否则这份真内容缓存被白白消耗
      if (node && t.resolve.key && swipeAdoptable(node)) {
        swipeCleanCloneImages(node);
        swipePageCache.set(t.resolve.key, node);
      }
      scroll.style.transition = '';
      scroll.style.transform = '';
      t.panel.remove();
      swiping = false;
      // downloads 页的轮询被 routeToken++ 打断过，重新挂上
      if (state.route === 'downloads') refreshDownloads(routeToken, true);
    }, 210);
  }
}

function swipeSettleBack() {
  scroll.style.transition = 'transform .17s cubic-bezier(.22,.61,.36,1)';
  scroll.style.transform = 'translateX(0)';
  setTimeout(() => { scroll.style.transition = ''; scroll.style.transform = ''; }, 180);
}

scroll.addEventListener('touchstart', event => {
  const touch = event.touches[0];
  if (!touch || swiping || swipeBlocked() || document.querySelector('.card-transition-stage')
    || !DOCK_ORDER.includes(state.route === 'category' ? state.tab : state.route)) {
    swipeStart = null;
    return;
  }
  if (event.target.closest && event.target.closest(SWIPE_IGNORE)) { swipeStart = null; return; }
  swipeStart = { x: touch.clientX, y: touch.clientY, at: Date.now(), target: event.target };
  swipeAxis = null;
}, { passive: true });

scroll.addEventListener('touchmove', event => {
  const start = swipeStart;
  if (!start) return;
  const touch = event.touches[0];
  if (!touch) return;
  const dx = touch.clientX - start.x, dy = touch.clientY - start.y;
  if (!swipeAxis) {
    if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
    if (Math.abs(dx) < Math.abs(dy) * 1.3) { swipeAxis = 'y'; swipeStart = null; return; }
    if (swipeScrollOwner(start.target, dx)) { swipeStart = null; return; }
    swipeAxis = 'x';
    swipeOpenTrack(dx < 0 ? 1 : -1, dx);   // 手指左滑=前进，右滑=后退
  }
  if (swipeAxis !== 'x') return;
  if (event.cancelable) event.preventDefault();
  if (swipeTrack) swipeLayTrack(dx);
  else scroll.style.transform = `translateX(${dx * 0.3}px)`;   // 边界：阻尼跟手
}, { passive: false });

scroll.addEventListener('touchend', event => {
  const start = swipeStart;
  const axis = swipeAxis, track = swipeTrack;
  swipeStart = null; swipeAxis = null;
  if (!start || axis !== 'x') return;
  const touch = event.changedTouches[0];
  const dx = touch ? touch.clientX - start.x : 0;
  const dy = touch ? touch.clientY - start.y : 0;
  const elapsed = Math.max(1, Date.now() - start.at);
  const width = track ? track.width : (scroll.clientWidth || 360);
  const fling = Math.abs(dx) / elapsed > 0.45 && Math.abs(dx) > 24;
  const passed = elapsed <= SWIPE_MAX_MS
    && Math.abs(dx) >= Math.abs(dy) * 1.3
    && (Math.abs(dx) >= width * SWIPE_MIN_RATIO || (fling && Math.abs(dx) >= SWIPE_MIN_PX));
  if (track) { swipeCloseTrack(passed); return; }
  swipeSettleBack();
}, { passive: true });

scroll.addEventListener('touchcancel', () => {
  const track = swipeTrack, axis = swipeAxis;
  swipeStart = null; swipeAxis = null;
  if (track) swipeCloseTrack(false);
  else if (axis === 'x') swipeSettleBack();
});

function navigateDock(tab) {
  try { swipeSaveCurrent(); } catch (ignore) { }   // 点底栏离开时也存一份，滑动回来能直接秒出
  if (state.route === 'detail') state.previous = null;
  if (tab === 'home') goHome();
  else if (tab === 'library') goLibrary();
  else goCategory(tab);
}

function tapDock(button) {
  const tab = button.dataset.nav;
  const now = performance.now();
  if (lastDockTap.tab === tab && now - lastDockTap.at < 320) {
    const alreadyNavigated = lastDockTap.navigated;
    lastDockTap = { tab: '', at: 0, navigated: false };
    const icon = button.querySelector('.nav-icon');
    icon?.classList.remove('dock-bounce');
    void icon?.offsetWidth;
    icon?.classList.add('dock-bounce');
    icon?.addEventListener('animationend', () => icon.classList.remove('dock-bounce'), { once: true });
    scroll.scrollTop = 0;
    if (!alreadyNavigated) navigateDock(tab);
    return;
  }
  const route = tab === 'home' ? 'home' : tab === 'library' ? 'library' : 'category';
  const navigated = state.route !== route || state.tab !== tab;
  lastDockTap = { tab, at: now, navigated };
  if (navigated) navigateDock(tab);
}

document.addEventListener('click', async event => {
  // 搜索浮层：历史词条 / 单条删除 / 清空
  const ssWord = event.target.closest('[data-ss-word]');
  if (ssWord) {
    const w = ssWord.dataset.ssWord;
    hideSearchSuggest();
    searchInput.value = w;
    pushSearchHistory(w);
    goSearch(w);
    return;
  }
  const ssDel = event.target.closest('[data-ss-del]');
  if (ssDel) {
    removeSearchHistory(ssDel.dataset.ssDel);
    renderSearchHistory();
    return;
  }
  const ssClear = event.target.closest('[data-ss-clear]');
  if (ssClear) {
    try { localStorage.removeItem(searchHistoryKey); } catch {}
    renderSearchHistory();
    return;
  }
  if (event.target.closest('[data-ss-close]')) hideSearchSuggest();
  const campaignButton = event.target.closest('[data-open-campaign]');
  if (campaignButton) {
    if (heroTapGuard(campaignButton)) return;
    const item = activeCampaigns().find(item => item.id === campaignButton.dataset.openCampaign);
    if (item) goCampaign(item);
    return;
  }
  if (event.target.closest('[data-enter-private]')) { handleEnterPrivate(); return; }
  const publicCategory = event.target.closest('[data-public-category]');
  if (publicCategory) { goCategory(publicCategory.dataset.publicCategory); return; }
  if (event.target.closest('[data-return-public]')) { await api('leave-private'); location.reload(); return; }
  if (event.target.closest('[data-check-update]')) { checkUpdate(true); return; }
  if (event.target.closest('[data-check-resources]')) {
    const button = event.target.closest('[data-check-resources]');
    button.disabled = true;
    try {
      const result = await api('check-hot-update');
      window.hgHotUpdateStatus(result);
      toast(result.pending ? '资源已下载，返回首页空闲时会自动启用' : (result.unavailable ? '暂无可用资源更新，当前使用内置资源' : '已是最新资源'));
    } catch (error) { toast(error.message, true); }
    finally { if (button.isConnected) button.disabled = false; }
    return;
  }
  if (event.target.closest('[data-apply-resources]')) { api('apply-hot-update').catch(error => toast(error.message, true)); return; }
  if (event.target.closest('[data-account-management]')) { openAccountPop(); return; }
  if (event.target.closest('[data-proxy-open]')) { openProxyPop(); return; }
  if (event.target.closest('[data-about-open]')) { openAboutPop(); return; }
  const openUrl = event.target.closest('[data-open-url]');
  if (openUrl) {
    api('open-url', { url: openUrl.dataset.openUrl }).catch(error => toast(error.message, true));
    return;
  }
  if (event.target.closest('[data-downloads]')) { goDownloads(); return; }
  if (event.target.closest('[data-download]')) { showDownloadSheet(); return; }
  if (event.target === downloadOverlay) { hideDownloadSheet(); return; }
  if (event.target.closest('[data-dl-pick]')) {
    submitDownloadTo(event.target.closest('[data-dl-pick]').dataset.dlPick);
    return;
  }
  if (event.target.closest('[data-dl-back]')) { hideDownloadSheet(); return; }
  if (event.target.closest('[data-dl-confirm]')) { downloadMode = 'target'; renderDownloadSheet(); return; }
  if (event.target.closest('[data-dl-all]')) {
    const episodes = asArray(state.detail.episodes).map(ep => Number(ep.number) || 0);
    const allSelected = episodes.length && episodes.every(n => downloadSelection.has(n));
    downloadSelection.clear();
    if (!allSelected) episodes.forEach(n => downloadSelection.add(n));
    renderDownloadSheet();
    return;
  }
  if (event.target.closest('[data-dl-ep]')) {
    const n = Number(event.target.closest('[data-dl-ep]').dataset.dlEp);
    if (downloadSelection.has(n)) downloadSelection.delete(n); else downloadSelection.add(n);
    renderDownloadSheet();
    return;
  }
  if (event.target.closest('[data-dl-play]')) {
    const id = event.target.closest('[data-dl-play]').dataset.dlPlay;
    api('open-local-player', { id }).then(() => toast('正在播放本地成品')).catch(error => toast(error.message || '本地文件不可播放', true));
    return;
  }
  if (event.target.closest('[data-dl-play-nas]')) {
    // NAS 任务点封面：流式播 NAS 上的成品（合并产物优先，未合并逐集）。
    // 之前误走 open-local-player，手机本地根本没有这个任务 → 永远报「任务不存在」。
    const id = event.target.closest('[data-dl-play-nas]').dataset.dlPlayNas;
    api('open-nas-player', { id }).then(() => toast('正在播放 NAS 成品')).catch(error => toast(error.message || 'NAS 成品不可播放', true));
    return;
  }
  if (event.target.closest('[data-dl-cancel]')) {
    const button = event.target.closest('[data-dl-cancel]');
    const kind = button.dataset.dlCancel, id = button.dataset.dlId;
    const action = kind === 'nas' ? 'nas-download-cancel' : 'download-cancel';
    api(action, { id }).then(() => { toast('已取消任务'); removeDownloadRow(kind, id); refreshCurrentDownloads(); }).catch(error => toast(error.message, true));
    return;
  }
  if (event.target.closest('[data-dl-copy]')) {
    const node = event.target.closest('[data-dl-copy]');
    const log = (node.dataset.dlLog || '').replace(/\\n/g, '\n');
    if (log) {
      api('copy-text', { text: log }).then(() => toast('日志已复制到剪贴板')).catch(() => toast('复制失败', true));
    }
    return;
  }
  if (event.target.closest('[data-dl-retry]')) {
    const button = event.target.closest('[data-dl-retry]');
    const id = button.dataset.dlId;
    api('download-retry', { id }).then(() => { toast('已重新开始下载'); refreshCurrentDownloads(); }).catch(error => toast(error.message, true));
    return;
  }
  if (event.target.closest('[data-dl-merge]')) {
    const button = event.target.closest('[data-dl-merge]');
    const kind = button.dataset.dlMerge, id = button.dataset.dlId;
    const action = kind === 'nas' ? 'nas-download-merge' : 'download-merge';
    api(action, { id }).then(() => { toast('已开始合并'); refreshCurrentDownloads(); }).catch(error => toast(error.message, true));
    return;
  }
  if (event.target.closest('[data-dl-retry-failed]')) {
    const button = event.target.closest('[data-dl-retry-failed]');
    const id = button.dataset.dlId;
    api('nas-download-retry-failed', { id }).then(() => { toast('已开始重试失败集（已下载分集保留）'); refreshCurrentDownloads(); }).catch(error => toast(error.message, true));
    return;
  }
  if (event.target.closest('[data-dl-delete]')) {
    const button = event.target.closest('[data-dl-delete]');
    const kind = button.dataset.dlDelete, id = button.dataset.dlId;
    const action = kind === 'nas' ? 'nas-download-cancel' : 'download-delete';
    // 归并条目（同剧分次下载合成一条）删除 = 该剧全部任务一起删；
    // 后端每个删除都会清掉 Download/Veyra/<剧名>/ 整剧文件夹，重复调用幂等无害
    const ids = (button.dataset.dlSiblings || '').split(',').filter(Boolean);
    ids.unshift(id);
    const chain = ids.reduce((p, cid) => p.then(() => api(action, { id: cid }).catch(e => toast(e.message, true))), Promise.resolve());
    chain.then(() => { toast('已删除下载内容'); refreshCurrentDownloads(); }).catch(() => {});
    return;
  }

// 删除/取消后先从当前 DOM 即时移除该行（立即消失，不再受路由/竞态影响），再后台拉最新列表
function removeDownloadRow(kind, id) {
  const button = document.querySelector(`[data-dl-delete="${kind}"][data-dl-id="${id}"], [data-dl-cancel="${kind}"][data-dl-id="${id}"]`);
  if (!button) return;
  const card = button.closest('.download-task');
  if (!card || !card.parentElement) return;
  const list = card.parentElement;
  card.remove();
  if (list && !list.querySelector('.download-task')) {
    list.innerHTML = '<div class="empty-state">还没有下载内容，去详情页点击「下载」吧</div>';
  }
}

// 删除/取消后立即刷新当前下载列表（我的下载 tab 或下载管理页）
function refreshCurrentDownloads() {
  if (state.route === 'library' && state.libraryTab === 'downloads') renderLibraryDownloads();
  else if (state.route === 'downloads') refreshDownloads(routeToken, true);
}
  if (event.target.closest('[data-choose-avatar]')) { api('choose-avatar').catch(error => toast(error.message, true)); return; }
  if (event.target.closest('[data-account-action]')) {
    if (state.account.loggedIn) openAccountPop();
    else { if (accountPop && !accountPop.hidden) closeAccountPop(); showAuth(); }
    return;
  }
  if (event.target.closest('[data-sync-now]')) {
    try { await api('sync'); state.library = await api('library'); toast('片单已同步'); }
    catch (error) { toast(`同步失败：${error.message}`, true); }
    return;
  }
  if (event.target.closest('[data-logout]')) {
    const button = event.target.closest('[data-logout]');
    if (button.disabled) return;
    button.disabled = true;
    button.classList.add('is-loading');
    button.setAttribute('aria-busy', 'true');
    button.textContent = '正在退出…';
    try {
      setAccount(await api('logout'));
      state.library = await api('library');
      if (accountPop && !accountPop.hidden) closeAccountPop();
      setRoute('settings'); renderSettings();
      showAuth(); // 退出登录后锁住：未登录状态强制回到全屏登录页
      toast('已退出登录');
    }
    catch (error) { toast(error.message, true); }
    finally {
      if (button.isConnected) {
        button.disabled = false;
        button.classList.remove('is-loading');
        button.removeAttribute('aria-busy');
        button.textContent = '退出登录';
      }
    }
    return;
  }
  const nav = event.target.closest('[data-nav]');
  if (nav) { tapDock(nav); return; }
  const libraryTab = event.target.closest('[data-library-tab]');
  if (libraryTab) { state.libraryTab = libraryTab.dataset.libraryTab; renderLibrary(); scroll.scrollTop = 0; return; }
  if (event.target.closest('[data-all-history]')) { state.libraryQuery = ''; goLibrary('history'); return; }
  const continueCard = event.target.closest('[data-continue-id]');
  if (continueCard) { resumeFromHome(continueCard.dataset.continueId).catch(error => toast(error.message || '续播失败，请重试', true)); return; }
  const historyCard = event.target.closest('[data-history-id]');
  if (historyCard) {
    const id = historyCard.dataset.historyId;
    if (historyCard.dataset.historyCompleted === 'true') goDetail(id, historyCard);
    else goDetail(id).then(() => openPlayer(Number(historyCard.dataset.historyEpisode || 1)));
    return;
  }
  if (event.target.closest('[data-all-tags]')) { goTags(); return; }
  const tagChoice = event.target.closest('[data-tag-slug]');
  if (tagChoice) { goTag(tagChoice.dataset.tagSlug, tagChoice.dataset.tagName); return; }
  const sub = event.target.closest('[data-sub]');
  if (sub) { goCategory(state.tab, Number(sub.dataset.sub), !!sub.closest('#compact-category')); return; }
  const card = event.target.closest('[data-open-id]');
  if (card?.dataset.openId) {
    if (heroTapGuard(card)) return;
    goDetail(card.dataset.openId, card); return;
  }
  const filter = event.target.closest('[data-filter]');
  if (filter) { state.filter = filter.dataset.filter; renderSearch(); return; }
  const slide = event.target.closest('[data-slide]');
  if (slide) { const target = Number(slide.dataset.slide); changeBanner(target, target > bannerIndex() ? 1 : -1); return; }
  if (event.target.closest('[data-back]')) { window.hgBack(); return; }
  const episode = event.target.closest('[data-episode]');
  if (episode) { openPlayer(Number(episode.dataset.episode)); return; }
  if (event.target.closest('[data-play]')) { openPlayer(1); return; }
  if (event.target.closest('[data-bookmark]')) {
    if (!state.detail) return;
    try { state.bookmarked = await api('bookmark', state.detail); renderDetail(); toast(state.bookmarked ? '已加入我的片单' : '已取消收藏'); }
    catch (error) { toast(error.message, true); }
    return;
  }
  if (event.target.closest('[data-retry-category]')) { state.category.error = false; loadMoreCategory(); return; }
  const more = event.target.closest('[data-more]');
  if (more) { openListing(more.dataset.more); return; }
  if (event.target.closest('[data-retry-listing]')) { state.listing.error = false; loadMoreListing(); return; }
  const retry = event.target.closest('[data-retry]');
  if (retry) {
    if (retry.dataset.retry === 'home') goHome();
    else if (retry.dataset.retry === 'category') goCategory(state.tab);
    else if (retry.dataset.retry === 'library') goLibrary();
    else if (retry.dataset.retry === 'search') goSearch(state.query);
    else if (retry.dataset.retry === 'listing') openListing(state.listing.kind);
    else if (retry.dataset.retry === 'tags') goTags();
    else if (retry.dataset.retry === 'tag-list') goTag(state.listing.slug, state.listing.label);
    else if (retry.dataset.retry === 'detail') goDetail(state.sourceItem.id);
    return;
  }
  const clear = event.target.closest('[data-clear]');
  if (clear) {
    if (clear.dataset.clear === 'cache') {
      if (!await askConfirmation('清理内容缓存', '将删除已缓存的目录和封面。收藏与观看进度会保留。', '清理')) return;
      await api('clear-content-cache'); toast('内容缓存已清空');
    } else if (clear.dataset.clear === 'history' || clear.dataset.clear === 'bookmarks') {
      const history = clear.dataset.clear === 'history';
      if (!await askConfirmation(history ? '清空观看历史' : '清空我的收藏', history ? '所有观看记录会被删除，我的收藏会保留。' : '所有收藏作品会被移除，观看历史会保留。')) return;
      await api(history ? 'clear-history' : 'clear-bookmarks');
      state.library = await api('library');
      renderSettings();
      toast(history ? '观看历史已清空' : '收藏已清空');
    }
  }
});

let heroTouch;
let heroSuppressClickUntil = 0;
// 滑动过 hero 之后，浏览器仍会补发一次 tap→click（部分 WebView 延迟可达 600ms 以上），
// 光靠时间窗口盖不住，于是再配一个「一次性作废」标志：下一次落在 hero 上的 click 直接丢弃。
// 每次新的 touchstart 都会把它重置，所以不会吃掉真正的点击。
let heroTapSuppressed = false;
function heroTapGuard(el) {
  if (!el || !el.closest || !el.closest('.hero')) return false;
  if (performance.now() < heroSuppressClickUntil) return true;
  if (heroTapSuppressed) { heroTapSuppressed = false; return true; }
  return false;
}
// 顶部轮播的左右翻页：全局「切底栏页」的手势已在 touchstart 阶段对 .hero 让位，
// 这里只需要把横滑意图判干净 —— 横向主导且够长就翻一张，竖向让页面正常滚动。
// thr 从 55 降到 42：以前太钝，短促一划经常翻不动，看起来像"轮播滑不动"。
function heroOwnsGesture(event) {
  return !!event.target.closest?.('.hero') && event.touches.length === 1;
}
// 顶部轮播：横滑「跟手」翻页 —— 手指拖动时当前页与相邻页一起跟着手指平移，
// 松手过阈值才真正落定到下一/上一页；不够则弹回。竖向手势照常交给页面滚动。
function heroBuildPartner(ht, dir) {
  const slides = bannerSlides();
  const count = slides.length;
  if (count < 2) return null;
  if (ht.partner && ht.partnerDir === dir) return ht.partner;
  if (ht.partner) { ht.partner.remove(); ht.partner = null; }
  const idx = (bannerIndex() + dir + count) % count;
  const item = slides[idx];
  const template = document.createElement('template');
  template.innerHTML = state.route === 'category' ? categorySlide(item, idx, count) : heroSlide(item, idx, count);
  const node = template.content.firstElementChild;
  node.style.transition = 'none';
  node.style.transform = `translateX(${dir > 0 ? 100 : -100}%)`;
  ht.hero.appendChild(node);
  const img = node.querySelector('img');
  if (img) {
    getCover(item.cover).then(src => { if (ht.partner === node && src) img.src = src; }).catch(() => { });
    if (item.kind !== 'campaign' && state.route === 'home') {
      getCover(item.cover).then(() => { if (ht.partner === node) applyBannerPalette(img); }).catch(() => { });
    }
  }
  ht.partner = node; ht.partnerDir = dir;
  return node;
}
function heroCommit(ht, dir, targetIndex) {
  const cur = ht.current, partner = ht.partner, hero = ht.hero;
  if (!partner) { changeBanner(targetIndex, dir); return; }   // 相邻页还没建好（极端），退回原动画
  bannerChanging = true;
  cur.classList.add('animating'); partner.classList.add('animating');
  cur.style.transition = ''; partner.style.transition = '';
  cur.style.transform = `translateX(${dir > 0 ? -100 : 100}%)`;
  partner.style.transform = 'translateX(0)';
  if (state.route === 'category') state.categoryBanner = targetIndex; else state.banner = targetIndex;
  content.querySelectorAll('.hero-dots [data-slide]').forEach(dot => dot.classList.toggle('active', Number(dot.dataset.slide) === targetIndex));
  setTimeout(() => {
    if (hero.isConnected && cur.isConnected) cur.remove();
    partner.classList.remove('animating');
    partner.style.transform = ''; partner.style.transition = '';
    bannerChanging = false; scheduleBannerAuto();
  }, 340);
}
function heroSnap(ht, dir) {
  const cur = ht.current, partner = ht.partner;
  if (cur) { cur.classList.add('animating'); cur.style.transition = ''; cur.style.transform = 'translateX(0)'; setTimeout(() => { if (cur.isConnected) { cur.classList.remove('animating'); cur.style.transform = ''; cur.style.transition = ''; } }, 340); }
  if (partner) { partner.classList.add('animating'); partner.style.transition = ''; partner.style.transform = `translateX(${dir > 0 ? 100 : -100}%)`; setTimeout(() => { if (partner.isConnected) partner.remove(); }, 340); }
}
content.addEventListener('touchstart', event => {
  if (!heroOwnsGesture(event)) return;
  if (bannerChanging) return;
  stopBannerAuto();
  heroTapSuppressed = false;
  const touch = event.touches[0];
  const hero = content.querySelector('.hero');
  const current = hero && hero.querySelector('.hero-slide');
  if (!hero || !current) { heroTouch = null; return; }
  const rect = hero.getBoundingClientRect();
  heroTouch = { x: touch.clientX, y: touch.clientY, moved: false, axis: null, hero, current, width: rect.width, dx: 0, dir: 0, partner: null, partnerDir: 0 };
}, { passive: true });
content.addEventListener('touchmove', event => {
  if (!heroTouch || !event.touches.length) return;
  const t = event.touches[0];
  const dx = t.clientX - heroTouch.x, dy = t.clientY - heroTouch.y;
  if (!heroTouch.axis) {
    if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
    heroTouch.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    if (heroTouch.axis === 'x') { heroTouch.moved = true; heroTouch.current.style.transition = 'none'; }
  }
  // 竖向：交给页面滚动，只抑制补发的点击（避免滑过 hero 弹详情）
  if (heroTouch.axis !== 'x') { heroSuppressClickUntil = performance.now() + 600; heroTapSuppressed = true; return; }
  heroSuppressClickUntil = performance.now() + 600; heroTapSuppressed = true;
  const dxv = Math.max(-heroTouch.width, Math.min(heroTouch.width, dx));
  heroTouch.dx = dxv;
  const dir = dxv < 0 ? 1 : -1;
  heroTouch.dir = dir;
  heroBuildPartner(heroTouch, dir);
  heroTouch.current.style.transform = `translateX(${dxv}px)`;
  if (heroTouch.partner) { heroTouch.partner.style.transition = 'none'; heroTouch.partner.style.transform = `translateX(calc(${dir > 0 ? 100 : -100}% + ${dxv}px))`; }
}, { passive: true });
content.addEventListener('touchend', event => {
  if (!heroTouch) return;
  const ht = heroTouch; heroTouch = null;
  scheduleBannerAuto();
  if (ht.axis !== 'x' || !ht.moved) return;
  const dx = ht.dx, dir = ht.dir, count = bannerSlides().length;
  if (count < 2) { heroSnap(ht, dir); return; }
  const threshold = Math.max(42, ht.width * 0.18);
  if (Math.abs(dx) >= threshold) heroCommit(ht, dir, (bannerIndex() + dir + count) % count);
  else heroSnap(ht, dir);
}, { passive: true });
content.addEventListener('touchcancel', () => {
  if (!heroTouch) return;
  const ht = heroTouch; heroTouch = null;
  heroSuppressClickUntil = performance.now() + 600; heroTapSuppressed = true;
  heroSnap(ht, ht.dir); scheduleBannerAuto();
}, { passive: true });
// 第三重兜底：hero 手势仍在手、页面却已经开始滚动 → 这次抬手注定不是「点开详情」。
// 只有在 hero 上按下时才会生效，普通浏览滚动不受影响。
scroll.addEventListener('scroll', () => {
  if (!heroTouch) return;
  heroSuppressClickUntil = performance.now() + 600;
  heroTapSuppressed = true;
}, { passive: true });

api('app-version').then(version => {
  appVersion = String(version || '');
  const label = content.querySelector('.app-version-text');
  if (label) label.textContent = `版本 v${appVersion}`;
  setAvailableUpdate(updateAvailable);
}).catch(() => {});
api('cached-update').then(result => { if (result.status === 'available') setAvailableUpdate(result); }).catch(() => {});
function startHome() { goHome(); setTimeout(() => checkUpdate(false), 3000); }
// 崩溃日志提示：上次运行发生未捕获异常（含闪退）时，启动后提示并支持复制，便于把日志发给开发者排查
api('crash-log').then(result => {
  const log = (result && result.log || '').trim();
  if (log) {
    api('copy-text', { text: log }).then(() => {}).catch(() => {});
    toast('检测到上次运行发生崩溃，崩溃日志已复制到剪贴板，请粘贴发给开发者', true);
  }
}).catch(() => {});
document.getElementById('age-confirm').addEventListener('click', async () => { await api('confirm-private-age'); location.reload(); });
document.getElementById('age-exit').textContent = '返回红果';
document.getElementById('age-exit').addEventListener('click', () => { document.getElementById('age-gate').hidden = true; });
contentReady.then(() => startHome()).catch(error => renderError(error, 'home'));
setTimeout(() => { swipePrefetchAll().catch(() => { }); }, 5000);

let pendingResourceRevision = 0;
let resourceApplyTimer = null;
let resourceApplyRequested = false;
let lastResourceInteraction = performance.now();
const resourceIdleMs = 3000;
window.hgCanApplyHotUpdate = () => ['home', 'settings'].includes(state.route)
  && !document.hidden && document.hasFocus()
  && (state.route !== 'home' || scroll.scrollTop <= 4)
  && authOverlay.hidden && confirmOverlay.hidden && updateOverlay.hidden && unlockOverlay.hidden
  && document.getElementById('age-gate').hidden
  && !['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)
  && !bannerChanging && !heroTouch && !predictivePreview && !predictiveFrame
  && !document.getElementById('app').classList.contains('card-transition-active')
  && !document.getElementById('app').classList.contains('predictive-active');
function scheduleResourceApply(delay) {
  if (resourceApplyRequested) return;
  clearTimeout(resourceApplyTimer);
  resourceApplyTimer = null;
  if (!pendingResourceRevision || resourceApplyRequested || document.hidden || !document.hasFocus()) return;
  resourceApplyTimer = setTimeout(tryApplyResources, delay ?? Math.max(150,
    resourceIdleMs - (performance.now() - lastResourceInteraction)));
}
function tryApplyResources() {
  resourceApplyTimer = null;
  if (!pendingResourceRevision || resourceApplyRequested) return;
  if (state.route !== 'home' || !window.hgCanApplyHotUpdate()
      || !content.querySelector('.home-page,.error-state')
      || performance.now() - lastResourceInteraction < resourceIdleMs) {
    scheduleResourceApply(750);
    return;
  }
  resourceApplyRequested = true;
  api('apply-hot-update').catch(() => {});
  // A gesture can start between the JS idle check and the native check. Retry
  // only if this document remains alive; a successful activation replaces it.
  resourceApplyTimer = setTimeout(() => {
    resourceApplyRequested = false;
    window.hgRefreshPendingResources();
  }, 2000);
}
window.hgScheduleResourceApply = () => { lastResourceInteraction = performance.now(); scheduleResourceApply(); };
window.hgRefreshPendingResources = () => {
  if (!document.hidden && document.hasFocus()) api('hot-update-status').then(window.hgHotUpdateStatus).catch(() => {});
};
window.hgHotUpdateStatus = result => {
  const resourceSection = content.querySelector('[data-resource-status]')?.closest('section');
  if (resourceSection && result.enabled === false) resourceSection.hidden = true;
  const label = content.querySelector('[data-resource-status]');
  if (label) label.textContent = result.pending ? '资源已下载，首页空闲时自动启用。' : '当前资源：' + (result.version || '内置') + '，后台自动更新。';
  const apply = content.querySelector('[data-apply-resources]');
  if (apply) apply.hidden = !result.pending;
  pendingResourceRevision = Number(result.pending) > Number(window.HotRuntime?.revision || 0) ? Number(result.pending) : 0;
  if (!pendingResourceRevision) resourceApplyRequested = false;
  scheduleResourceApply();
};
function resourceInteraction() {
  lastResourceInteraction = performance.now();
  if (!resourceApplyRequested) scheduleResourceApply();
}
for (const type of ['pointerdown', 'pointermove', 'pointerup', 'keydown', 'input', 'focusin', 'focusout', 'wheel'])
  document.addEventListener(type, resourceInteraction, { capture: true, passive: true });
document.addEventListener('scroll', resourceInteraction, { capture: true, passive: true });
window.addEventListener('blur', () => { clearTimeout(resourceApplyTimer); resourceApplyTimer = null; resourceApplyRequested = false; });
window.addEventListener('focus', () => { resourceInteraction(); window.hgRefreshPendingResources(); });
document.addEventListener('visibilitychange', () => {
  clearTimeout(resourceApplyTimer); resourceApplyTimer = null; resourceApplyRequested = false;
  if (!document.hidden) { resourceInteraction(); window.hgRefreshPendingResources(); }
});
api('hot-update-status').then(window.hgHotUpdateStatus).catch(() => {});
window.hgBootReady?.();


function closeUnlock() {
  unlockOverlay.hidden = true;
  updateBackEnabled();
  document.getElementById('unlock-password').value = '';
}
async function enterPrivate(password = '') {
  const result = await api('enter-private', { password });
  closeUnlock();
  if (result.needsAgeConfirmation) document.getElementById('age-gate').hidden = false;
  else location.reload();
}
async function handleEnterPrivate() {
  if (privateMode()) return;
  try {
    const status = await api('content-status'); // 原生端实时刷新角色/解锁状态；管理员视为已解锁
    if (status.unlocked) { await enterPrivate(); return; } // 已解锁（含管理员）切换无需动态码
    document.getElementById('unlock-error').hidden = true;
    unlockOverlay.hidden = false;
    updateBackEnabled();
    document.getElementById('unlock-password').focus();
  } catch (error) { toast(error.message, true); }
}
document.getElementById('unlock-close').addEventListener('click', closeUnlock);
document.getElementById('unlock-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.target.querySelector('button[type="submit"]');
  button.disabled = true;
  try { await enterPrivate(document.getElementById('unlock-password').value); }
  catch (error) { const label = document.getElementById('unlock-error'); label.textContent = error.message; label.hidden = false; }
  finally { button.disabled = false; }
});

/* ================= 刷剧模式（公开模式首页悬浮按钮） =================
   点击进入原生 BingeActivity：随机推荐剧第 1 集全屏自动播，上下滑换剧；
   「查看详情」由 BingeActivity 通过 hgBingeAction 回传路由。 */
const bingeFab = document.getElementById('binge-fab');

function bingePoolItems() {
  const data = state.home || {};
  const pool = [
    ...asArray(data.homepageRecommend), ...asArray(data.recommend?.items),
    ...asArray(data.homepageNewest), ...asArray(data.newest?.items),
  ];
  const seen = new Set();
  return pool.filter(item => item && item.id && item.cover && item.kind !== 'campaign'
    && !seen.has(String(item.id)) && seen.add(String(item.id)));
}

function updateBingeChrome() {
  if (!bingeFab) return;
  const show = state.route === 'home' && !privateMode() && bingePoolItems().length > 0;
  bingeFab.hidden = !show;
}
window.__bingeUpdateChrome = updateBingeChrome;

bingeFab?.addEventListener('click', async () => {
  if (privateMode() || state.route !== 'home') return;
  const items = bingePoolItems();
  if (!items.length) { toast('首页还没有推荐内容，稍后再试', true); return; }
  // 洗牌后取一批：每次进入刷的是不同的随机剧
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  const payload = items.slice(0, 40).map(item => ({
    id: String(item.id), title: item.title || '',
    cover: item.cover || '', description: item.description || item.episodeLabel || '',
  }));
  try { await api('open-binge', { items: payload, source: contentSource }); }
  catch (error) { toast(error.message || '进入刷剧模式失败', true); }
});

window.hgBingeAction = (type, id) => {
  if (type === 'detail' && id) goDetail(id).catch(() => {});
};
