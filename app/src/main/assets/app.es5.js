"use strict";
var __defProp = Object.defineProperty;
var __defProps = Object.defineProperties;
var __getOwnPropDescs = Object.getOwnPropertyDescriptors;
var __getOwnPropSymbols = Object.getOwnPropertySymbols;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __propIsEnum = Object.prototype.propertyIsEnumerable;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __spreadValues = (a, b) => {
  for (var prop in b || (b = {}))
    if (__hasOwnProp.call(b, prop))
      __defNormalProp(a, prop, b[prop]);
  if (__getOwnPropSymbols)
    for (var prop of __getOwnPropSymbols(b)) {
      if (__propIsEnum.call(b, prop))
        __defNormalProp(a, prop, b[prop]);
    }
  return a;
};
var __spreadProps = (a, b) => __defProps(a, __getOwnPropDescs(b));
var _a, _b, _c, _d;
window.__veyraBooted = true;
const callbacks = /* @__PURE__ */ new Map();
let requestNumber = 0;
let contentSource = "hongguo";
let contentReady;
const bridgeInstance = Date.now() + "-" + Math.random().toString(36).slice(2);
const privateMode = () => contentSource === "huangguo";
window.NativeCallbacks = {
  resolve(id, value) {
    var _a2;
    (_a2 = callbacks.get(id)) == null ? void 0 : _a2.resolve(value);
    callbacks.delete(id);
  },
  reject(id, message) {
    var _a2;
    (_a2 = callbacks.get(id)) == null ? void 0 : _a2.reject(new Error(message));
    callbacks.delete(id);
  }
};
function api(action, args = {}) {
  const request = () => new Promise((resolve, reject) => {
    const id = bridgeInstance + ":" + ++requestNumber;
    callbacks.set(id, { resolve, reject });
    try {
      AndroidHost.request(id, action, JSON.stringify(__spreadProps(__spreadValues({}, args), { source: contentSource })));
    } catch (error) {
      callbacks.delete(id);
      reject(error);
    }
  });
  return contentReady ? contentReady.then(request) : request();
}
const scroll = document.getElementById("scroll");
const content = document.getElementById("content");
const avatarButton = document.getElementById("account-avatar");
const avatarImage = document.getElementById("account-avatar-image");
const authOverlay = document.getElementById("auth-overlay");
const compact = document.getElementById("compact-category");
const toastHost = document.getElementById("toast-host");
const updateOverlay = document.getElementById("update-overlay");
const updateDownloadButton = document.getElementById("update-download");
const updateLaterButton = document.getElementById("update-later");
const searchInput = document.getElementById("search-input");
const headerSettings = document.getElementById("header-settings");
const confirmOverlay = document.getElementById("confirm-overlay");
const unlockOverlay = document.getElementById("unlock-overlay");
const downloadOverlay = document.getElementById("download-overlay");
const categoryIds = { adult: ["ai-duanju", "ai-manju"], ai: ["ai-huanlian", "ai-mogai"] };
const CATEGORY_NAMES = {
  short: "\u77ED\u5267",
  comic: "\u6F2B\u5267",
  "hot-drama": "\u70ED\u64AD\u699C",
  "hot-real-drama": "\u771F\u4EBA\u699C",
  "hot-comic-drama": "\u6F2B\u5267\u699C",
  "hot-ai-drama": "AI\u699C",
  "ai-duanju": "\u6210\u4EBA\u77ED\u5267",
  "ai-manju": "\u6210\u4EBA\u6F2B\u5267",
  "ai-huanlian": "AI\u6362\u8138",
  "ai-mogai": "AI\u9B54\u6539"
};
function isRankId(id) {
  return /^hot-(drama|real-drama|comic-drama|ai-drama)$/.test(String(id || ""));
}
function tabNames(tab) {
  return (categoryIds[tab] || []).map((id) => CATEGORY_NAMES[id] || id);
}
const popularTags = [
  ["dushi", "\u90FD\u5E02"],
  ["xiaoyuan", "\u6821\u56ED"],
  ["gufeng", "\u53E4\u98CE"],
  ["haomen", "\u8C6A\u95E8"],
  ["chuanyue", "\u7A7F\u8D8A"],
  ["chongsheng", "\u91CD\u751F"],
  ["qihuan", "\u5947\u5E7B"],
  ["zhichang", "\u804C\u573A"]
];
const publicPopularTags = [
  ["short:romance", "\u7231\u60C5"],
  ["short:period", "\u5E74\u4EE3"],
  ["short:comeback", "\u9006\u88AD"],
  ["short:suspense", "\u60AC\u7591"],
  ["comic:creative", "\u8111\u6D1E"],
  ["comic:fantasy", "\u7384\u5E7B"],
  ["comic:apocalypse", "\u672B\u4E16"],
  ["comic:adventure", "\u5192\u9669"]
];
const tagGroups = [
  ["popular", "\u70ED\u95E8\u7C7B\u578B"],
  ["story", "\u6545\u4E8B\u9898\u6750"],
  ["setting", "\u573A\u666F\u4E0E\u8EAB\u4EFD"],
  ["relationship", "\u4EBA\u7269\u4E0E\u5173\u7CFB"],
  ["style", "\u5916\u5F62\u98CE\u683C"],
  ["plot", "\u60C5\u8282\u5143\u7D20"],
  ["other", "\u66F4\u591A\u6807\u7B7E"]
];
const state = {
  route: "home",
  tab: "home",
  sub: { adult: 0, ai: 0 },
  home: null,
  binge: false,
  category: null,
  categoryItems: [],
  detail: null,
  detailLoading: false,
  sourceItem: null,
  search: null,
  searchPending: false,
  searchError: "",
  query: "",
  filter: "all",
  banner: 0,
  categoryBanner: 0,
  listing: null,
  tags: null,
  tagsReturn: null,
  listingReturn: null,
  settingsReturn: null,
  libraryTab: "history",
  libraryQuery: "",
  accountReturn: null,
  account: { loggedIn: false },
  sourceGroup: "",
  sourceQueue: [],
  previous: null,
  compactHeld: false,
  detailProgress: null
};
contentReady = api("content-status").then((status) => {
  contentSource = status.source || "hongguo";
  state.privateUnlocked = Boolean(status.unlocked);
  try {
    api("get-proxy-mode").then((v) => {
      state.proxyMode = Number(v) || 3;
    }).catch(() => {
    });
  } catch (ignore) {
  }
  document.title = "Veyra";
  if (!privateMode()) {
    categoryIds.adult = ["short", "hot-drama", "hot-real-drama"];
    categoryIds.ai = ["comic", "hot-comic-drama", "hot-ai-drama"];
    document.querySelector('[data-nav="adult"] > span:last-child').textContent = "\u5267\u573A";
    document.querySelector('[data-nav="ai"] > span:last-child').textContent = "\u6F2B\u5267";
    searchInput.placeholder = "\u641C\u7D22\u5267\u540D";
    searchInput.setAttribute("aria-label", "\u641C\u7D22\u5267\u540D");
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
const coverRequests = /* @__PURE__ */ new Map();
let bannerChanging = false;
let bannerTimer;
let lastDockTap = { tab: "", at: 0, navigated: false };
let updateChecking = false;
let updateDownloading = false;
let updateAvailable = null;
let updatePendingVersion = "";
let appVersion = "";
const esc = (value) => String(value != null ? value : "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const asArray = (value) => Array.isArray(value) ? value : [];
const icon = (name) => {
  const paths = {
    play: '<path d="m8 5 11 7-11 7z"/>',
    arrow: '<path d="m9 5 7 7-7 7"/>',
    back: '<path d="m15 5-7 7 7 7"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    restart: '<path d="M3.5 12a8.5 8.5 0 1 0 2.7-6.2"/><path d="M3.5 4.5V10h5.5"/>'
  };
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
};
function toast(message, info = false) {
  clearTimeout(toastTimer);
  toastHost.innerHTML = `<div class="toast ${info ? "info" : ""}"><i></i><span>${esc(message)}</span></div>`;
  toastHost.classList.add("visible");
  toastTimer = setTimeout(() => toastHost.classList.remove("visible"), 3e3);
}
let finishConfirmation;
function closeConfirmation(accepted) {
  if (confirmOverlay.hidden) return;
  confirmOverlay.hidden = true;
  updateBackEnabled();
  finishConfirmation == null ? void 0 : finishConfirmation(accepted);
  finishConfirmation = null;
}
function askConfirmation(title, message, action = "\u6E05\u7A7A") {
  document.getElementById("confirm-title").textContent = title;
  document.getElementById("confirm-message").textContent = message;
  document.getElementById("confirm-accept").textContent = action;
  confirmOverlay.hidden = false;
  updateBackEnabled();
  document.getElementById("confirm-cancel").focus();
  return new Promise((resolve) => {
    finishConfirmation = resolve;
  });
}
document.getElementById("confirm-cancel").addEventListener("click", () => closeConfirmation(false));
document.getElementById("confirm-accept").addEventListener("click", () => closeConfirmation(true));
confirmOverlay.addEventListener("click", (event) => {
  if (event.target === confirmOverlay) closeConfirmation(false);
});
function setAccount(profile) {
  var _a2;
  const next = profile || { loggedIn: false };
  if (JSON.stringify(state.account) === JSON.stringify(next)) return;
  const savedScroll = scroll.scrollTop;
  const userChanged = state.account.userId !== next.userId;
  state.account = next;
  if (userChanged) {
    state.library = null;
    if (state.route === "home") {
      updateContinueWatching();
      refreshHomeHistory();
    }
  }
  avatarImage.hidden = !(profile == null ? void 0 : profile.avatar);
  avatarButton.querySelector(".account-avatar-default").hidden = Boolean(profile == null ? void 0 : profile.avatar);
  if (profile == null ? void 0 : profile.avatar) avatarImage.src = profile.avatar;
  else avatarImage.removeAttribute("src");
  avatarButton.classList.toggle("is-signed-in", Boolean(profile == null ? void 0 : profile.loggedIn));
  avatarButton.setAttribute("aria-label", (profile == null ? void 0 : profile.loggedIn) ? `\u6253\u5F00${profile.username}\u7684\u8D26\u53F7\u7BA1\u7406` : "\u767B\u5F55\u8D26\u53F7");
  const roleBadge = document.getElementById("account-role-badge");
  if (roleBadge) {
    const role = (profile == null ? void 0 : profile.role) === "admin" ? "admin" : (profile == null ? void 0 : profile.role) === "vip" ? "vip" : "user";
    roleBadge.textContent = role === "admin" ? "\u7BA1\u7406\u5458" : role === "vip" ? "\u7279\u6743\u7EC4" : "\u666E\u901A\u7528\u6237";
    roleBadge.classList.toggle("is-admin", role === "admin");
    roleBadge.classList.toggle("is-vip", role === "vip");
    roleBadge.hidden = !(profile == null ? void 0 : profile.loggedIn);
  }
  if (state.route === "library") renderLibrary();
  if (state.route === "settings") renderSettings();
  if (state.route === "account-management" && !((_a2 = content.querySelector("#password-form")) == null ? void 0 : _a2.contains(document.activeElement))) renderAccountManagement();
  scroll.scrollTop = savedScroll;
}
api("account").then((profile) => {
  setAccount(profile);
  if (!(profile == null ? void 0 : profile.loggedIn)) showAuth();
}).catch(() => showAuth());
api("server-base").then((serverBase) => {
  const input = document.getElementById("auth-server");
  if (input && !input.value) input.value = String(serverBase || "").replace(/\/+$/, "");
}).catch(() => {
});
window.hgWindowInsets = (height) => {
  document.getElementById("app").style.setProperty("--status-bar-height", `${Math.max(0, Number(height) || 0)}px`);
};
window.hgSafeInsets = (bottom) => {
  const app = document.getElementById("app");
  if (!app) return;
  app.style.setProperty("--safe-bottom", `${Math.max(0, Number(bottom) || 0)}px`);
};
api("window-insets").then(window.hgWindowInsets).catch(() => {
});
api("window-safe-insets").then((value) => {
  const values = Array.isArray(value) ? value : [value];
  window.hgSafeInsets(values[0], values[1]);
}).catch(() => {
});
api("screen-corners").then((corners) => {
  const app = document.getElementById("app");
  for (const name of ["topLeft", "topRight", "bottomRight", "bottomLeft"]) {
    const radius = Number(corners == null ? void 0 : corners[name]);
    if (radius > 0) app.style.setProperty(`--screen-corner-${name}`, `${radius}px`);
  }
}).catch(() => {
});
let authMode = "login";
let authPending = false;
function setAuthPending(pending, mode = authMode) {
  const submit = document.getElementById("auth-submit");
  submit.disabled = pending;
  submit.classList.toggle("is-loading", pending);
  submit.setAttribute("aria-busy", String(pending));
  submit.textContent = pending ? mode === "login" ? "\u6B63\u5728\u767B\u5F55\u2026" : "\u6B63\u5728\u6CE8\u518C\u2026" : mode === "login" ? "\u767B\u5F55" : "\u6CE8\u518C\u5E76\u767B\u5F55";
  document.querySelectorAll("[data-auth-mode]").forEach((button) => {
    button.disabled = pending;
  });
}
function tvDevice() {
  return window.VEYRA_DEVICE === "tv" || document.documentElement.dataset.device === "tv";
}
function showTvLoginPanel() {
  const panel = authOverlay.querySelector(".auth-panel");
  const tabs = panel == null ? void 0 : panel.querySelector(".auth-tabs");
  const form = document.getElementById("auth-form");
  const footnote = panel == null ? void 0 : panel.querySelector(".auth-footnote");
  if (tabs) tabs.hidden = true;
  if (form) form.hidden = true;
  if (footnote) footnote.hidden = true;
  document.getElementById("auth-title").textContent = "\u767B\u5F55\u7535\u89C6";
  document.getElementById("auth-subtitle").textContent = "\u7528\u624B\u673A\u4E0A\u7684 Veyra \u626B\u4E00\u4E0B\uFF0C\u8D26\u53F7\u76F4\u63A5\u540C\u6B65\u8FC7\u6765";
  document.getElementById("tv-login").hidden = false;
  requestTvLoginQr();
}
function requestTvLoginQr() {
  var _a2, _b2;
  const code = document.getElementById("tv-login-code");
  const note = document.getElementById("tv-login-note");
  const start = document.getElementById("tv-login-start");
  let info = null;
  try {
    info = JSON.parse(((_b2 = (_a2 = window.AndroidHost) == null ? void 0 : _a2.tvLoginInfo) == null ? void 0 : _b2.call(_a2)) || "null");
  } catch (error) {
  }
  if (!info || !info.ready) {
    showQrUnavailable();
    return;
  }
  if (!window.qrcode) {
    if (note) {
      note.textContent = "\u4E8C\u7EF4\u7801\u7EC4\u4EF6\u6CA1\u52A0\u8F7D\uFF0C\u8BF7\u66F4\u65B0\u5E94\u7528";
      note.hidden = false;
    }
    return;
  }
  try {
    const qr = window.qrcode(0, "M");
    qr.addData(info.url);
    qr.make();
    code.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
    code.hidden = false;
    if (start) start.hidden = true;
    if (note) {
      note.textContent = "\u7528\u53E6\u4E00\u53F0\u5DF2\u767B\u5F55\u7684 Veyra \u626B\u8FD9\u4E2A\u7801\uFF1A\u7535\u89C6 / \u7535\u8111 / \u5E73\u677F / \u624B\u673A\u90FD\u884C\uFF08" + info.host + ":" + info.port + "\uFF09";
      note.hidden = false;
    }
  } catch (error) {
    if (note) {
      note.textContent = "\u4E8C\u7EF4\u7801\u751F\u6210\u5931\u8D25\uFF0C\u8BF7\u91CD\u8BD5";
      note.hidden = false;
    }
  }
}
function showQrUnavailable() {
  const code = document.getElementById("tv-login-code");
  const note = document.getElementById("tv-login-note");
  const start = document.getElementById("tv-login-start");
  if (code) {
    code.hidden = true;
    code.innerHTML = "";
  }
  if (start) {
    start.hidden = false;
    start.textContent = "\u91CD\u8BD5";
  }
  if (note) {
    note.textContent = "\u5C40\u57DF\u7F51\u6CA1\u8D77\u6765\uFF0C\u786E\u8BA4\u8FD9\u53F0\u8BBE\u5907\u548C\u626B\u7801\u7684\u8BBE\u5907\u8FDE\u5728\u540C\u4E00\u4E2A Wi-Fi \u540E\u518D\u8BD5";
    note.hidden = false;
  }
}
function startLoginHostAndRender() {
  var _a2, _b2;
  let info = null;
  try {
    info = JSON.parse(((_b2 = (_a2 = window.AndroidHost) == null ? void 0 : _a2.startLoginHost) == null ? void 0 : _b2.call(_a2)) || "null");
  } catch (error) {
  }
  if (info && info.ready) {
    requestTvLoginQr();
    return;
  }
  let tries = 0;
  const tick = () => {
    var _a3, _b3;
    let next = null;
    try {
      next = JSON.parse(((_b3 = (_a3 = window.AndroidHost) == null ? void 0 : _a3.tvLoginInfo) == null ? void 0 : _b3.call(_a3)) || "null");
    } catch (error) {
    }
    if (next && next.ready) {
      requestTvLoginQr();
      return;
    }
    if (++tries < 12) {
      setTimeout(tick, 400);
      return;
    }
    showQrUnavailable();
  };
  setTimeout(tick, 300);
}
window.hgTvLogin = (ok) => {
  if (!ok) {
    toast("\u767B\u5F55\u6CA1\u6210\u529F\uFF0C\u91CD\u65B0\u626B\u4E00\u6B21", true);
    requestTvLoginQr();
    return;
  }
  api("account").then((profile) => {
    setAccount(profile);
    if (profile == null ? void 0 : profile.loggedIn) {
      hideAuth();
      toast("\u5DF2\u767B\u5F55");
    }
  }).catch(() => {
  });
};
function showAuth(mode = "login") {
  if (authPending) mode = authMode;
  authMode = mode;
  authOverlay.hidden = false;
  updateBackEnabled();
  if (tvDevice()) {
    showTvLoginPanel();
    return;
  }
  const scan = mode === "scan";
  const form = document.getElementById("auth-form");
  const panel = authOverlay.querySelector(".auth-panel");
  const footnote = panel == null ? void 0 : panel.querySelector(".auth-footnote");
  const scanBox = document.getElementById("tv-login");
  if (form) form.hidden = scan;
  if (footnote) footnote.hidden = scan;
  if (scanBox) scanBox.hidden = !scan;
  document.getElementById("auth-title").textContent = scan ? "\u626B\u7801\u767B\u5F55" : mode === "login" ? "\u767B\u5F55\u5E94\u7528\u8D26\u53F7" : "\u6CE8\u518C\u5E94\u7528\u8D26\u53F7";
  const subtitle = document.getElementById("auth-subtitle");
  if (subtitle) subtitle.textContent = scan ? "\u7528\u53E6\u4E00\u53F0\u5DF2\u767B\u5F55\u7684 Veyra \u626B\u4E0B\u9762\u7684\u7801\uFF0C\u8D26\u53F7\u76F4\u63A5\u540C\u6B65\u8FC7\u6765" : "\u767B\u5F55\u540E\u540C\u6B65\u6536\u85CF\u548C\u89C2\u770B\u5386\u53F2";
  setAuthPending(authPending, mode);
  document.getElementById("auth-password").autocomplete = mode === "login" ? "current-password" : "new-password";
  const codeField = document.getElementById("auth-code");
  const codeLabel = document.getElementById("auth-code-label");
  if (codeField) {
    codeField.hidden = mode !== "register";
    codeField.required = mode === "register";
    codeField.value = "";
  }
  if (codeLabel) codeLabel.hidden = mode !== "register";
  document.querySelectorAll("[data-auth-mode]").forEach((button) => button.classList.toggle("selected", button.dataset.authMode === mode));
  document.getElementById("auth-error").hidden = true;
  if (scan) startLoginHostAndRender();
}
function hideAuth() {
  authOverlay.hidden = true;
  updateBackEnabled();
  const form = document.getElementById("auth-form");
  if (form) {
    form.reset();
    form.hidden = false;
  }
  const panel = authOverlay.querySelector(".auth-panel");
  const footnote = panel == null ? void 0 : panel.querySelector(".auth-footnote");
  if (footnote) footnote.hidden = false;
  const scanBox = document.getElementById("tv-login");
  if (scanBox) scanBox.hidden = true;
}
avatarButton.addEventListener("click", () => {
  if (state.account.loggedIn) goAccountManagement();
  else showAuth();
});
headerSettings.addEventListener("click", goSettings);
document.querySelectorAll("[data-auth-mode]").forEach((button) => button.addEventListener("click", () => showAuth(button.dataset.authMode)));
(_a = document.getElementById("tv-login-start")) == null ? void 0 : _a.addEventListener("click", () => {
  if (tvDevice()) requestTvLoginQr();
  else startLoginHostAndRender();
});
function startQrScan() {
  var _a2;
  if (!((_a2 = window.AndroidHost) == null ? void 0 : _a2.startQrScan)) {
    toast("\u5F53\u524D\u7248\u672C\u4E0D\u652F\u6301\u626B\u7801\uFF0C\u8BF7\u66F4\u65B0\u5E94\u7528", true);
    return;
  }
  try {
    window.AndroidHost.startQrScan();
  } catch (error) {
    toast(error.message || "\u6253\u4E0D\u5F00\u626B\u7801\u9875", true);
  }
}
window.hgQrScan = (ok, message) => {
  toast(message || (ok ? "\u5DF2\u767B\u5F55" : "\u626B\u7801\u5931\u8D25"), !ok);
};
document.getElementById("auth-form").addEventListener("submit", async (event) => {
  var _a2, _b2;
  event.preventDefault();
  if (authPending) return;
  const mode = authMode;
  const username = document.getElementById("auth-username").value.trim();
  const password = document.getElementById("auth-password").value;
  const server = document.getElementById("auth-server").value.trim();
  const error = document.getElementById("auth-error");
  authPending = true;
  setAuthPending(true, mode);
  error.hidden = true;
  try {
    if (mode === "register") {
      const code = ((_a2 = document.getElementById("auth-code")) == null ? void 0 : _a2.value.trim()) || "";
      if (!/^\d{6}$/.test(code)) throw new Error("\u6CE8\u518C\u9700\u8981\u7BA1\u7406\u5458\u63D0\u4F9B\u7684 6 \u4F4D\u52A8\u6001\u7801");
      await api("verify-otp-public", { code, server });
    }
    const profile = await api(mode, { username, password, server, code: mode === "register" ? ((_b2 = document.getElementById("auth-code")) == null ? void 0 : _b2.value.trim()) || "" : void 0 });
    hideAuth();
    setAccount(profile);
    if (state.route === "library") goLibrary(state.libraryTab);
    toast(mode === "login" ? "\u767B\u5F55\u6210\u529F\uFF0C\u7247\u5355\u6B63\u5728\u540C\u6B65" : "\u6CE8\u518C\u6210\u529F\uFF0C\u7247\u5355\u6B63\u5728\u540C\u6B65");
  } catch (failure) {
    if (authOverlay.hidden) toast(failure.message || "\u8BF7\u7A0D\u540E\u91CD\u8BD5", true);
    else {
      error.textContent = failure.message || "\u8BF7\u7A0D\u540E\u91CD\u8BD5";
      error.hidden = false;
    }
  } finally {
    authPending = false;
    setAuthPending(false, mode);
  }
});
window.hgAccountRefreshed = (profile) => {
  if ((profile == null ? void 0 : profile.userId) && state.account.userId === profile.userId) setAccount(profile);
};
window.hgAvatarUpdated = (profile) => {
  setAccount(profile);
  toast("\u5934\u50CF\u5DF2\u66F4\u65B0");
};
window.hgAvatarError = (message) => toast(message || "\u5934\u50CF\u4FDD\u5B58\u5931\u8D25", true);
window.hgCloudSynced = () => {
  if (state.route === "home") refreshHomeHistory();
  else if (state.route === "library") {
    const token = routeToken;
    api("library").then((data) => {
      if (token !== routeToken) return;
      state.library = data;
      renderLibrary();
    }).catch(() => {
    });
  }
};
const UPDATE_DISMISS_KEY = "veyra.update.dismissed";
function dismissedUpdateVersion() {
  try {
    return localStorage.getItem(UPDATE_DISMISS_KEY) || "";
  } catch (error) {
    return "";
  }
}
function rememberDismissedUpdate(version) {
  try {
    if (version) localStorage.setItem(UPDATE_DISMISS_KEY, String(version));
    else localStorage.removeItem(UPDATE_DISMISS_KEY);
  } catch (error) {
  }
}
function setAvailableUpdate(result) {
  updateAvailable = (result == null ? void 0 : result.status) === "available" ? result : null;
  updatePendingVersion = updateAvailable ? String(updateAvailable.version || "") : "";
  headerSettings.classList.toggle("has-update", Boolean(updateAvailable));
  const versionButton = content.querySelector(".app-version");
  if (versionButton) {
    versionButton.classList.toggle("has-update", Boolean(updateAvailable));
    versionButton.setAttribute("aria-label", updateAvailable ? `\u5F53\u524D\u7248\u672C ${appVersion}\uFF0C\u53D1\u73B0\u65B0\u7248 ${updateAvailable.version}\uFF0C\u67E5\u770B\u66F4\u65B0` : `\u5F53\u524D\u7248\u672C ${appVersion}\uFF0C\u68C0\u67E5\u66F4\u65B0`);
  }
}
function showUpdate(result) {
  document.getElementById("update-version").textContent = `\u5F53\u524D ${result.currentVersion} \xB7 \u65B0\u7248 ${result.version}`;
  const notes = document.getElementById("update-notes");
  notes.textContent = String(result.notes || "").trim().slice(0, 1200);
  notes.hidden = !notes.textContent;
  document.getElementById("update-progress").hidden = true;
  updateDownloadButton.textContent = "\u7ACB\u5373\u4E0B\u8F7D";
  updateDownloadButton.disabled = false;
  updateLaterButton.textContent = "\u53D6\u6D88";
  updateLaterButton.disabled = false;
  const appRoot = document.getElementById("app");
  if (appRoot) appRoot.appendChild(updateOverlay);
  updateOverlay.hidden = false;
  updateBackEnabled();
}
async function checkUpdate(manual) {
  if (updateDownloading) {
    if (manual) toast("\u66F4\u65B0\u5305\u6B63\u5728\u4E0B\u8F7D", true);
    return;
  }
  if (updateChecking) {
    if (manual) toast("\u6B63\u5728\u68C0\u67E5\u66F4\u65B0", true);
    return;
  }
  updateChecking = true;
  try {
    const result = await api("check-update", { manual });
    if (result.status === "available") {
      setAvailableUpdate(result);
      if (manual) {
        showUpdate(result);
        return;
      }
      if (dismissedUpdateVersion() === String(result.version || "")) return;
      try {
        await api("download-update");
        showUpdate(result);
      } catch (ignore) {
        showUpdate(result);
      }
    } else if (result.status === "current" || result.status === "unpublished" || result.status === "none") {
      setAvailableUpdate(null);
      if (manual && result.status === "current") toast(`\u5DF2\u662F\u6700\u65B0\u7248\u672C ${result.version}`);
      if (manual && result.status === "unpublished") toast("\u6682\u672A\u53D1\u5E03\u66F4\u65B0\u5305", true);
    } else if (result.status === "channel-missing") {
      setAvailableUpdate(null);
      if (manual) toast("\u8FD9\u4E2A\u7248\u672C\u8FD8\u6CA1\u53D1\u5E03\u624B\u673A\u7248\u5B89\u88C5\u5305\uFF0C\u7B49\u6253\u5305\u540E\u518D\u8BD5", true);
    } else if (manual && result.status === "unconfigured") toast("\u6682\u672A\u53D1\u5E03\u66F4\u65B0\u5305", true);
    else if (manual && result.status === "throttled") toast("\u4E00\u5C0F\u65F6\u5185\u6700\u591A\u624B\u52A8\u68C0\u67E5 5 \u6B21\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5", true);
  } catch (error) {
    if (manual) toast(error.message || "\u68C0\u67E5\u66F4\u65B0\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5", true);
  } finally {
    updateChecking = false;
  }
}
window.hgUpdateProgress = (percent) => {
  document.getElementById("update-progress").hidden = false;
  document.getElementById("update-percent").textContent = `${percent}%`;
  document.getElementById("update-fill").style.transform = `scaleX(${percent / 100})`;
};
window.hgUpdateInstallPermissionDenied = () => toast("\u8BF7\u5141\u8BB8\u6B64\u5E94\u7528\u5B89\u88C5\u66F4\u65B0\u5305\u540E\u91CD\u8BD5", true);
window.hgUpdateInstallError = () => toast("\u65E0\u6CD5\u6253\u5F00\u7CFB\u7EDF\u5B89\u88C5\u7A0B\u5E8F\uFF0C\u8BF7\u91CD\u8BD5", true);
updateDownloadButton.addEventListener("click", async () => {
  if (updateDownloading) return;
  updateDownloading = true;
  updateDownloadButton.disabled = true;
  updateLaterButton.textContent = "\u540E\u53F0\u4E0B\u8F7D";
  updateDownloadButton.textContent = "\u6B63\u5728\u4E0B\u8F7D\u2026";
  window.hgUpdateProgress(0);
  try {
    await api("download-update");
    updateOverlay.hidden = true;
    rememberDismissedUpdate("");
    updateDownloadButton.textContent = "\u7ACB\u5373\u4E0B\u8F7D";
    updateLaterButton.textContent = "\u53D6\u6D88";
    toast("\u4E0B\u8F7D\u5B8C\u6210\uFF0C\u6B63\u5728\u6253\u5F00\u5B89\u88C5\u7A0B\u5E8F");
  } catch (error) {
    updateDownloadButton.textContent = "\u91CD\u8BD5\u4E0B\u8F7D";
    updateLaterButton.textContent = "\u53D6\u6D88";
    toast(error.message || "\u4E0B\u8F7D\u5931\u8D25\uFF0C\u8BF7\u91CD\u8BD5", true);
  } finally {
    updateDownloading = false;
    updateDownloadButton.disabled = false;
    updateLaterButton.disabled = false;
    updateBackEnabled();
  }
});
updateLaterButton.addEventListener("click", () => {
  updateOverlay.hidden = true;
  updateBackEnabled();
  if (updateDownloading) toast("\u5DF2\u8F6C\u5165\u540E\u53F0\u4E0B\u8F7D\uFF0C\u5B8C\u6210\u540E\u4F1A\u81EA\u52A8\u5F39\u51FA\u5B89\u88C5", true);
  else rememberDismissedUpdate(updatePendingVersion);
});
window.hgTheme = (info) => {
  const isDark = !!(info && typeof info === "object" ? info.dark : info);
  const A = window.VeyraAppearance;
  if (A) {
    let saved = null;
    try {
      saved = localStorage.getItem("veyra.appearance.v1");
    } catch (e) {
    }
    if (!saved) A.set({ theme: isDark ? "dark" : "light" });
    return;
  }
  document.documentElement.dataset.theme = isDark ? "dark" : "light";
};
api("theme").then(window.hgTheme).catch(() => {
});
function itemCard(item) {
  const id = esc(item.id);
  const title = esc(item.title || "\u5F71\u7247");
  const info = esc(item.heat || item.episodeLabel || asArray(item.tags).slice(0, 2).join(" \xB7 ") || "\u6253\u5F00\u8BE6\u60C5");
  const rank = Number(item.rank) || 0;
  const scoreText = rank ? `#${rank}` : item.score || "";
  const scoreClass = rank ? `poster-score is-rank${rank <= 3 ? " is-top" : ""}` : "poster-score";
  return `<button class="film-card" type="button" data-open-id="${id}" aria-label="\u67E5\u770B${title}">
    <span class="poster loading"><span class="poster-letter">${title.slice(0, 1)}</span><img data-cover="${esc(item.cover || "")}" alt=""><span class="${scoreClass}" ${scoreText ? "" : "hidden"}>${esc(scoreText)}</span></span>
    <span class="film-title">${title}</span><span class="film-info">${info}</span></button>`;
}
function moreCard(kind) {
  return `<button class="film-card more-tile" type="button" data-more="${esc(kind)}" aria-label="\u67E5\u770B\u66F4\u591A\u63A8\u8350">
    <span class="poster more-poster"><span class="more-tile-label">\u66F4\u591A\u63A8\u8350 ${icon("arrow")}</span></span>
    <span class="film-title">\u67E5\u770B\u5168\u90E8</span><span class="film-info">\u6253\u5F00\u5B8C\u6574\u5217\u8868</span></button>`;
}
function section(title, items, kind = "") {
  if (!items.length) return "";
  const cells = items.slice(0, 5).map(itemCard);
  if (kind) cells.push(moreCard(kind));
  return `<section class="film-section"><div class="section-heading"><h2>${esc(title)}</h2></div><div class="film-row">${cells.join("")}</div></section>`;
}
function homeTagBar() {
  const choices = privateMode() ? popularTags : publicPopularTags;
  return `<nav class="home-tags" aria-label="\u6309\u7C7B\u578B\u6D4F\u89C8"><button type="button" class="all-tags-link" data-all-tags="1">\u5168\u90E8\u7C7B\u578B ${icon("arrow")}</button>
    <div class="home-tag-scroll">${choices.map(([slug, name]) => `<button type="button" class="home-tag" data-tag-slug="${slug}" data-tag-name="${name}">${name}</button>`).join("")}</div></nav>`;
}
function homeSignature(data) {
  var _a2, _b2;
  return JSON.stringify([asArray(data.featured), asArray(data.homepageRecommend), asArray(data.homepageNewest), asArray((_a2 = data.recommend) == null ? void 0 : _a2.items), asArray((_b2 = data.newest) == null ? void 0 : _b2.items)].map((list) => list.map((item) => [item.id, item.title, item.episodeLabel, item.score])));
}
function listSignature(data) {
  return JSON.stringify(asArray(data.items).map((item) => [item.id, item.title, item.episodeLabel, item.score]));
}
function paletteFromImage(image) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 48;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(image, 0, 0, 48, 48);
  const pixels = context.getImageData(0, 0, 48, 48).data;
  let red = 0, green = 0, blue = 0, weightSum = 0;
  for (let index = 0; index < pixels.length; index += 16) {
    const r2 = pixels[index], g2 = pixels[index + 1], b2 = pixels[index + 2];
    const brightness = (r2 + g2 + b2) / 3;
    if (brightness < 28 || brightness > 225) continue;
    const weight = 0.6 + (Math.max(r2, g2, b2) - Math.min(r2, g2, b2)) / 255;
    red += r2 * weight;
    green += g2 * weight;
    blue += b2 * weight;
    weightSum += weight;
  }
  if (!weightSum) throw new Error("\u672A\u627E\u5230\u53EF\u7528\u989C\u8272");
  const r = red / weightSum / 255, g = green / weightSum / 255, b = blue / weightSum / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), difference = max - min;
  let hue = 28;
  if (difference) {
    hue = max === r ? (g - b) / difference % 6 : max === g ? (b - r) / difference + 2 : (r - g) / difference + 4;
    hue = (hue * 60 + 360) % 360;
  }
  const saturation = Math.round(Math.max(17, Math.min(32, difference / Math.max(max, 0.01) * 75)));
  return { light: `hsl(${Math.round(hue)} ${saturation}% 62%)`, dark: `hsl(${Math.round(hue)} ${Math.min(34, saturation + 2)}% 25%)` };
}
function applyBannerPalette(image) {
  const slide = image.closest(".hero-slide") || image.closest(".hero");
  if (!slide) return;
  const key = (image.dataset.cover || "").split("?")[0];
  let cache = {};
  try {
    cache = JSON.parse(localStorage.getItem("banner-palettes") || "{}");
  } catch (e) {
  }
  let colors = cache[key];
  if (!colors) {
    try {
      colors = paletteFromImage(image);
      cache[key] = colors;
      localStorage.setItem("banner-palettes", JSON.stringify(cache));
    } catch (e) {
      colors = { light: "#B5A08B", dark: "#49332F" };
    }
  }
  slide.style.setProperty("--hero-tint-light", colors.light);
  slide.style.setProperty("--hero-tint-dark", colors.dark);
}
function coverKey(url) {
  try {
    return new URL(url).pathname;
  } catch (e) {
    return String(url).split("?")[0];
  }
}
function getCover(url) {
  const key = coverKey(url);
  if (coverRequests.has(key)) return coverRequests.get(key);
  const request = api("cover", { url }).catch((error) => {
    coverRequests.delete(key);
    throw error;
  });
  coverRequests.set(key, request);
  if (coverRequests.size > 80) coverRequests.delete(coverRequests.keys().next().value);
  return request;
}
async function loadCoverInto(image) {
  var _a2, _b2, _c2, _d2, _e;
  const url = image.dataset.cover;
  if (image.dataset.loading === "1") return;
  if (image.getAttribute("src")) return;
  if (!url) {
    (_a2 = image.closest(".poster")) == null ? void 0 : _a2.classList.remove("loading");
    (_b2 = image.closest(".poster")) == null ? void 0 : _b2.classList.add("fallback");
    return;
  }
  image.dataset.loading = "1";
  const poster = image.closest(".poster");
  try {
    let data;
    try {
      data = await getCover(url);
    } catch (e) {
      await new Promise((resolve) => setTimeout(resolve, 450));
      data = await getCover(url);
    }
    if (!image.isConnected || image.dataset.cover !== url) return;
    await new Promise((resolve, reject) => {
      image.onload = () => {
        image.onload = image.onerror = null;
        resolve();
      };
      image.onerror = () => {
        image.onload = image.onerror = null;
        reject(new Error("\u56FE\u7247\u65E0\u6CD5\u89E3\u7801"));
      };
      image.src = data;
      if (image.complete && image.naturalWidth > 0) {
        image.onload = image.onerror = null;
        resolve();
      }
    });
    if (!image.isConnected || image.dataset.cover !== url) return;
    poster == null ? void 0 : poster.classList.remove("loading", "fallback");
    poster == null ? void 0 : poster.classList.add("has-image");
    delete image.dataset.retryAfter;
    if (image.classList.contains("hero-image")) applyBannerPalette(image);
  } catch (error) {
    coverRequests.delete(coverKey(url));
    if (image.isConnected) {
      image.removeAttribute("src");
      poster == null ? void 0 : poster.classList.remove("loading");
      poster == null ? void 0 : poster.classList.add("fallback");
      image.dataset.retryAfter = String(Date.now() + (error.message === "\u56FE\u7247\u65E0\u6CD5\u89E3\u7801" ? 3e5 : 3e4));
    }
    const id = ((_c2 = image.closest("[data-open-id]")) == null ? void 0 : _c2.dataset.openId) || ((_e = (_d2 = image.closest(".hero-slide,.category-spotlight")) == null ? void 0 : _d2.querySelector("[data-open-id]")) == null ? void 0 : _e.dataset.openId) || "unknown";
    console.warn("\u5C01\u9762\u52A0\u8F7D\u5931\u8D25", id, (() => {
      try {
        return new URL(url).host;
      } catch (e) {
        return "invalid";
      }
    })(), error.message);
  } finally {
    delete image.dataset.loading;
  }
}
function retryFailedImages(force = false) {
  const viewport = scroll.getBoundingClientRect();
  content.querySelectorAll("img[data-cover]").forEach((image) => {
    if (image.naturalWidth > 0 || image.dataset.loading === "1") return;
    if (!force && Date.now() < Number(image.dataset.retryAfter || 0)) return;
    const card = image.closest(".poster");
    if (card && !card.classList.contains("fallback")) return;
    const box = image.getBoundingClientRect();
    if (box.bottom < viewport.top - 320 || box.top > viewport.bottom + 320) return;
    const row = image.closest(".film-row");
    if (row) {
      const visible = row.getBoundingClientRect();
      if (box.right < visible.left - 250 || box.left > visible.right + 250) return;
    }
    card == null ? void 0 : card.classList.remove("fallback");
    card == null ? void 0 : card.classList.add("loading");
    loadCoverInto(image);
  });
}
let coverScrollTimer;
scroll.addEventListener("scroll", () => {
  clearTimeout(coverScrollTimer);
  coverScrollTimer = setTimeout(() => retryFailedImages(), 160);
}, { passive: true });
window.addEventListener("online", () => retryFailedImages(true));
function hydrateImages(root = content, eagerLimit = 14) {
  const offstage = root !== content;
  const io = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      const image = entry.target;
      io.unobserve(image);
      loadCoverInto(image);
    });
  }, { root: scroll, rootMargin: "320px" });
  if (!offstage) {
    if (observer) observer.disconnect();
    observer = io;
  }
  root.querySelectorAll("img[data-cover]").forEach((image, index) => {
    if (image.naturalWidth > 0) return;
    if (index < eagerLimit || image.classList.contains("hero-image")) loadCoverInto(image);
    else io.observe(image);
  });
}
function swipeCleanCloneImages(clone) {
  clone.querySelectorAll("img").forEach((image) => {
    delete image.dataset.loading;
    delete image.dataset.retryAfter;
  });
}
async function swipePrimeImages(clone) {
  swipeCleanCloneImages(clone);
  const imgs = [...clone.querySelectorAll("img[data-cover]")].slice(0, 24);
  await Promise.race([
    Promise.all(imgs.map((img) => loadCoverInto(img).catch(() => {
    }))),
    new Promise((resolve) => setTimeout(resolve, 3e3))
    // 最多等 3 秒，别拖垮整轮预取
  ]);
}
function activeCampaigns() {
  var _a2, _b2;
  const now = Date.now();
  return asArray((_b2 = (_a2 = window.HotRuntime) == null ? void 0 : _a2.theme) == null ? void 0 : _b2.campaigns).filter((item) => (item == null ? void 0 : item.id) && (!item.startsAt || now >= Date.parse(item.startsAt)) && (!item.endsAt || now < Date.parse(item.endsAt)) && /^theme\/[a-zA-Z0-9_./-]+$/.test(item.artwork || "") && !item.artwork.split("/").includes(".."));
}
function campaignArtwork(item) {
  return new URL(item.artwork, "https://appassets.androidplatform.net/assets/").href;
}
function homeSlides() {
  var _a2, _b2, _c2;
  const featured = asArray((_a2 = state.home) == null ? void 0 : _a2.featured);
  const videos = featured.length ? featured : asArray((_c2 = (_b2 = state.home) == null ? void 0 : _b2.recommend) == null ? void 0 : _c2.items).slice(0, 5);
  return [...activeCampaigns().map((item) => __spreadProps(__spreadValues({}, item), { kind: "campaign", cover: "" })), ...videos];
}
function campaignSlide(item, index, count) {
  return '<div class="hero-slide hero-campaign" data-index="' + index + '"><img class="hero-image campaign-image" src="' + esc(campaignArtwork(item)) + '" alt=""><button class="hero-cover-button" type="button" data-open-campaign="' + esc(item.id) + '" aria-label="\u67E5\u770B\u56FD\u5E86\u5E86\u795D\u9875"></button><div class="hero-copy"><h2>' + esc(item.title) + "</h2><p>" + esc(item.description || "").replaceAll("\n", "<br>") + '</p><button class="hero-action" type="button" data-open-campaign="' + esc(item.id) + '">' + esc(item.button || "\u67E5\u770B\u5E86\u795D\u9875") + '</button></div><span class="campaign-date">' + esc(item.dateLabel || "") + '</span><div class="hero-index"><b>' + String(index + 1).padStart(2, "0") + "</b> / " + String(count).padStart(2, "0") + "</div></div>";
}
function goCampaign(item) {
  state.campaignReturn = captureScreen();
  ++routeToken;
  setRoute("campaign");
  state.campaign = item;
  content.innerHTML = '<article class="campaign-page"><button class="campaign-back" type="button" data-back>' + icon("back") + ' \u8FD4\u56DE\u9996\u9875</button><section class="campaign-poster"><img src="' + esc(campaignArtwork(item)) + '" alt=""><div><h1>' + esc(item.title) + "</h1><p>" + esc(item.description || "").replaceAll("\n", "<br>") + "</p><span>" + esc(item.dateLabel || "") + '</span></div></section><section class="campaign-message"><h2>\u5171\u5E86\u597D\u65F6\u5149</h2><p>' + esc(item.message || "") + '</p><button type="button" data-back>\u8FD4\u56DE\u9996\u9875</button></section></article>';
  scroll.scrollTop = 0;
}
function isBannerRoute() {
  return state.route === "home" || state.route === "category" && !privateMode();
}
function bannerSlides() {
  var _a2;
  return state.route === "category" ? asArray((_a2 = state.category) == null ? void 0 : _a2.items).slice(0, 5) : homeSlides();
}
function bannerIndex() {
  return state.route === "category" ? state.categoryBanner : state.banner;
}
function restoreBannerIndex() {
  var _a2;
  const index = Number(((_a2 = content.querySelector(".hero-slide:last-child")) == null ? void 0 : _a2.dataset.index) || 0);
  if (state.route === "category") state.categoryBanner = index;
  else if (state.route === "home") state.banner = index;
}
function categorySlide(item, index, count) {
  return `<div class="hero-slide" data-index="${index}"><img class="hero-image" data-cover="${esc(item.cover || "")}" alt=""><button class="hero-cover-button" type="button" data-open-id="${esc(item.id)}" aria-label="\u67E5\u770B${esc(item.title)}\u8BE6\u60C5"></button><div class="hero-shade"></div><div class="category-spotlight-copy"><h2>${esc(item.title)}</h2><button type="button" data-open-id="${esc(item.id)}">\u67E5\u770B\u4F5C\u54C1 ${icon("arrow")}</button></div><div class="hero-index"><b>${String(index + 1).padStart(2, "0")}</b> / ${String(count).padStart(2, "0")}</div></div>`;
}
function stopBannerAuto() {
  clearTimeout(bannerTimer);
  bannerTimer = null;
}
function bannerHiddenByLayout() {
  try {
    return window.matchMedia("(min-width: 600px)").matches && window.VEYRA_DEVICE !== "tv";
  } catch (error) {
    return false;
  }
}
function scheduleBannerAuto() {
  stopBannerAuto();
  if (!isBannerRoute() || document.hidden || bannerSlides().length < 2 || !content.querySelector(".hero")) return;
  if (bannerHiddenByLayout()) return;
  bannerTimer = setTimeout(() => {
    bannerTimer = null;
    if (!isBannerRoute() || document.hidden) return;
    const count = bannerSlides().length;
    if (count > 1) changeBanner((bannerIndex() + 1) % count, 1, true);
  }, 3e3);
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopBannerAuto();
  else scheduleBannerAuto();
});
function heroSlide(item, index, count) {
  if (item.kind === "campaign") return campaignSlide(item, index, count);
  return `<div class="hero-slide" data-index="${index}"><img class="hero-image" data-cover="${esc(item.cover || "")}" alt=""><button class="hero-cover-button" type="button" data-open-id="${esc(item.id || "")}" aria-label="\u67E5\u770B${esc(item.title || "\u4F5C\u54C1")}\u8BE6\u60C5"></button><div class="hero-shade"></div>
    <div class="hero-copy"><span class="hero-label">\u672C\u5468\u7126\u70B9 <i></i> \u72EC\u5BB6\u7CBE\u9009</span><h2>${esc(item.title || "\u4E3A\u4F60\u63A8\u8350")}</h2><p>${esc(item.description || item.episodeLabel || "")}</p><button class="hero-action" data-open-id="${esc(item.id || "")}" type="button">${icon("play")} \u7ACB\u5373\u89C2\u770B</button></div>
    <div class="hero-index"><b>${String(index + 1).padStart(2, "0")}</b> / ${String(count).padStart(2, "0")}</div></div>`;
}
async function changeBanner(targetIndex, direction, automatic = false) {
  const slides = bannerSlides();
  const route = state.route, token = routeToken;
  const currentRoute = () => state.route === route && routeToken === token && !document.hidden;
  const hero = content.querySelector(".hero");
  if (!isBannerRoute() || !hero || !slides.length || bannerChanging || targetIndex === bannerIndex()) return;
  stopBannerAuto();
  bannerChanging = true;
  let incoming = null;
  try {
    const item = slides[targetIndex];
    const data = item.kind === "campaign" ? campaignArtwork(item) : await getCover(item.cover);
    const template = document.createElement("template");
    template.innerHTML = route === "category" ? categorySlide(item, targetIndex, slides.length) : heroSlide(item, targetIndex, slides.length);
    incoming = template.content.firstElementChild;
    const image = incoming.querySelector("img");
    image.src = data;
    if (!hero.isConnected || !currentRoute()) return;
    incoming.style.transform = `translateX(${direction > 0 ? 100 : -100}%)`;
    hero.appendChild(incoming);
    await image.decode();
    if (!hero.isConnected || !currentRoute()) {
      incoming.remove();
      return;
    }
    if (route === "home" && item.kind !== "campaign") applyBannerPalette(image);
    const current = hero.querySelector(".hero-slide:not(:last-child)");
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    incoming.classList.add("animating");
    current.classList.add("animating");
    incoming.style.transform = "translateX(0)";
    current.style.transform = `translateX(${direction > 0 ? -100 : 100}%)`;
    await new Promise((resolve) => setTimeout(resolve, 330));
    current.remove();
    incoming.classList.remove("animating");
    incoming.style.transform = "";
    if (currentRoute()) {
      if (route === "category") state.categoryBanner = targetIndex;
      else state.banner = targetIndex;
    }
    content.querySelectorAll(".hero-dots [data-slide]").forEach((dot) => dot.classList.toggle("active", Number(dot.dataset.slide) === targetIndex));
  } catch (error) {
    incoming == null ? void 0 : incoming.remove();
    hero.querySelectorAll(".hero-slide").forEach((slide) => {
      slide.classList.remove("animating");
      slide.style.transform = "";
    });
    if (!automatic) toast("\u5C01\u9762\u52A0\u8F7D\u5931\u8D25\uFF0C\u8BF7\u91CD\u8BD5", true);
  } finally {
    bannerChanging = false;
    scheduleBannerAuto();
  }
}
function continueWatchingItem() {
  var _a2;
  return asArray((_a2 = state.library) == null ? void 0 : _a2.progress)[0] || null;
}
function continueWatchingMarkup() {
  const item = continueWatchingItem();
  if (!item) return "";
  const episode = Math.max(1, Number(item.episode) || 1);
  const total = Number(item.episodeCount) || 0;
  const finished = Boolean(item.completed) && total > 0 && episode >= total;
  const seconds = Math.floor(Math.max(0, Number(item.position) || 0) / 1e3);
  const time = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  return `<section class="continue-section"><div class="section-heading"><h2>\u7EE7\u7EED\u89C2\u770B</h2><button type="button" class="more" data-all-history="1">\u5168\u90E8\u5386\u53F2 ${icon("arrow")}</button></div>
    <button type="button" class="continue-card" data-continue-id="${esc(item.id)}" aria-label="${esc(item.title)}\uFF0C${finished ? "\u6253\u5F00\u8BE6\u60C5" : "\u7EE7\u7EED\u89C2\u770B"}">
      <span class="continue-poster poster loading"><span class="poster-letter">${esc(String(item.title || "\u5F71\u7247").slice(0, 1))}</span><img data-cover="${esc(item.cover || "")}" alt=""></span>
      <span class="continue-copy"><strong>${esc(item.title || "\u5F71\u7247")}</strong><span>\u5DF2\u770B\u5230\u7B2C ${episode} \u96C6${total ? ` \xB7 \u5171 ${total} \u96C6` : ""}</span><span class="continue-time">${finished ? "\u5168\u5267\u5DF2\u770B\u5B8C" : item.completed ? "\u672C\u96C6\u5DF2\u770B\u5B8C\uFF0C\u63A5\u7740\u770B\u4E0B\u4E00\u96C6" : `\u4E0A\u6B21\u770B\u5230 ${time}`}</span></span>
      <span class="continue-action">${icon("play")}${finished ? "\u8BE6\u60C5" : item.completed ? "\u7EE7\u7EED\u770B" : "\u7EED\u64AD"}</span>
    </button></section>`;
}
function updateContinueWatching() {
  const host = content.querySelector(".home-continue");
  if (!host) return;
  const markup = continueWatchingMarkup();
  if (host.continueMarkup === markup) return;
  const savedScroll = scroll.scrollTop;
  host.innerHTML = markup;
  host.continueMarkup = markup;
  host.querySelectorAll("img[data-cover]").forEach(loadCoverInto);
  scroll.scrollTop = savedScroll;
}
async function refreshHomeHistory() {
  const token = routeToken, source = contentSource, userId = state.account.userId;
  try {
    const library = await api("library");
    if (token !== routeToken || source !== contentSource || userId !== state.account.userId) return;
    state.library = library;
    if (state.route === "home") updateContinueWatching();
  } catch (_) {
  }
}
async function resumeFromHome(id) {
  var _a2;
  const item = continueWatchingItem();
  if (!item || String(item.id) !== id) return;
  const source = contentSource;
  const episode = Math.max(1, Number(item.episode) || 1) + (item.completed ? 1 : 0);
  const token = routeToken + 1;
  await goDetail(id);
  if (routeToken !== token || contentSource !== source || state.route !== "detail" || state.detailLoading || String((_a2 = state.detail) == null ? void 0 : _a2.id) !== id) return;
  if (episode <= asArray(state.detail.episodes).length) await openPlayer(episode, Boolean(item.completed));
}
function renderHome() {
  var _a2, _b2;
  const data = state.home;
  if (!data) {
    renderSkeleton();
    return;
  }
  const slides = homeSlides();
  const index = Math.min(state.banner, Math.max(0, slides.length - 1));
  const selected = slides[index] || {};
  content.innerHTML = `<div class="home-page"><div class="hero" data-hero="1">${heroSlide(selected, index, slides.length)}</div>
      <div class="hero-dots">${slides.map((_, i) => `<i class="${i === index ? "active" : ""}" data-slide="${i}"></i>`).join("")}</div>
      ${homeTagBar()}
      <div class="home-continue">${continueWatchingMarkup()}</div>
      ${section("\u7CBE\u9009\u63A8\u8350", asArray(data.homepageRecommend).length ? asArray(data.homepageRecommend) : asArray((_a2 = data.recommend) == null ? void 0 : _a2.items).slice(0, 12), "recommend")}
      ${section(privateMode() ? "\u6700\u8FD1\u4E0A\u65B0" : "\u70ED\u95E8\u6F2B\u5267", asArray(data.homepageNewest).length ? asArray(data.homepageNewest) : asArray((_b2 = data.newest) == null ? void 0 : _b2.items).slice(0, 12), "newest")}</div>`;
  hydrateImages();
  slides.forEach((item) => {
    if (item.cover) getCover(item.cover).catch(() => {
    });
  });
  scheduleBannerAuto();
  window.__bingeUpdateChrome && window.__bingeUpdateChrome();
}
function renderTags() {
  var _a2;
  const tags = asArray((_a2 = state.tags) == null ? void 0 : _a2.items);
  const sections = privateMode() ? tagGroups : [["short", "\u77ED\u5267\u7C7B\u578B"], ["comic", "\u6F2B\u5267\u7C7B\u578B"]];
  const groups = sections.map(([id, title]) => {
    const members = tags.filter((tag) => tag.group === id);
    if (!members.length) return "";
    return `<section class="tags-group"><h2>${title}</h2><div class="tags-grid">${members.map((tag) => {
      const name = String(tag.name || tag.slug);
      const size = name.length > 8 ? "wide" : name.length > 4 ? "medium" : "";
      return `<button type="button" class="tag-choice ${size}" data-tag-slug="${esc(tag.slug)}" data-tag-name="${esc(name)}">${esc(name)}</button>`;
    }).join("")}</div></section>`;
  }).join("");
  content.innerHTML = `<div class="tags-page"><div class="tags-heading"><button type="button" data-back="1" aria-label="\u8FD4\u56DE\u4E0A\u4E00\u9875">${icon("back")}</button><h1>\u5168\u90E8\u7C7B\u578B</h1><span>${tags.length} \u4E2A${privateMode() ? "\u6807\u7B7E" : "\u5927\u7C7B"}</span></div>
    <p class="tags-intro">${privateMode() ? "\u70B9\u9009\u6807\u7B7E\uFF0C\u53D1\u73B0\u76F8\u5173\u4F5C\u54C1" : "\u6309\u77ED\u5267\u3001\u6F2B\u5267\u5927\u7C7B\uFF0C\u53D1\u73B0\u76F8\u5173\u4F5C\u54C1"}</p>${groups}</div>`;
}
function refreshMissingImages(items) {
  const byId = new Map(items.filter((item) => (item == null ? void 0 : item.id) && (item == null ? void 0 : item.cover)).map((item) => [String(item.id), item.cover]));
  content.querySelectorAll("[data-open-id]").forEach((button) => {
    var _a2;
    const image = button.querySelector("img[data-cover]") || ((_a2 = button.closest(".hero-slide,.category-spotlight")) == null ? void 0 : _a2.querySelector("img[data-cover]"));
    const cover = byId.get(button.dataset.openId);
    if (!image || !cover || image.naturalWidth > 0) return;
    image.dataset.cover = cover;
    delete image.dataset.loading;
    loadCoverInto(image);
  });
}
function categoryId() {
  const list = categoryIds[state.tab] || [];
  const index = Math.min(Math.max(0, Number(state.sub[state.tab]) || 0), Math.max(0, list.length - 1));
  state.sub[state.tab] = index;
  return list[index];
}
function compactMarkup() {
  if (!privateMode()) return "";
  const adult = state.tab === "adult";
  const tabs = privateMode() ? adult ? ["\u6210\u4EBA\u77ED\u5267", "\u6210\u4EBA\u6F2B\u5267"] : ["AI\u6362\u8138", "AI\u9B54\u6539"] : tabNames(state.tab);
  return `<strong>${privateMode() ? adult ? "\u6210\u4EBA\u5267\u573A" : "AI\u4E13\u533A" : adult ? "\u77ED\u5267" : "\u6F2B\u5267"}</strong><div class="compact-tabs" role="tablist">${tabs.map((name, index) => `<button type="button" role="tab" aria-selected="${index === state.sub[state.tab]}" data-sub="${index}" class="${index === state.sub[state.tab] ? "selected" : ""}">${name}</button>`).join("")}</div>`;
}
function updateCompact() {
  var _a2;
  const eligible = privateMode() && state.route === "category";
  if (!eligible || scroll.scrollTop <= 0) state.compactHeld = false;
  else if (scroll.scrollTop > 92) state.compactHeld = true;
  const visible = eligible && state.compactHeld;
  compact.classList.toggle("visible", visible);
  compact.setAttribute("aria-hidden", String(!visible));
  compact.inert = !visible;
  (_a2 = content.querySelector(".category-page")) == null ? void 0 : _a2.classList.toggle("is-collapsed", visible);
}
scroll.addEventListener("scroll", updateCompact, { passive: true });
function renderCategory(keepCompact = false) {
  var _a2;
  categoryObserver == null ? void 0 : categoryObserver.disconnect();
  const adult = state.tab === "adult";
  const currentId = categoryId();
  const currentName = tabNames(state.tab)[state.sub[state.tab]] || tabNames(state.tab)[0] || "";
  const tabs = privateMode() ? adult ? ["\u6210\u4EBA\u77ED\u5267", "\u6210\u4EBA\u6F2B\u5267"] : ["AI\u6362\u8138", "AI\u9B54\u6539"] : tabNames(state.tab);
  const items = asArray((_a2 = state.category) == null ? void 0 : _a2.items);
  const lead = items[0] || null;
  const slides = privateMode() ? [] : items.slice(0, 5);
  const banner = Math.min(state.categoryBanner, Math.max(0, slides.length - 1));
  state.categoryBanner = banner;
  const spotlight = !privateMode() && slides.length ? `<div class="hero category-spotlight category-carousel">${categorySlide(slides[banner], banner, slides.length)}</div><div class="hero-dots">${slides.map((_, index) => `<i class="${index === banner ? "active" : ""}" data-slide="${index}"></i>`).join("")}</div>` : lead ? `<div class="category-spotlight"><img data-cover="${esc(lead.cover)}" alt=""><div class="category-spotlight-copy"><h2>${esc(lead.title)}</h2><button type="button" data-open-id="${esc(lead.id)}">\u67E5\u770B\u4F5C\u54C1 ${icon("arrow")}</button></div></div>` : "";
  const switcher = tabs.length > 1 ? `<div class="segmented cols-${tabs.length}" role="tablist">${tabs.map((name, index) => `<button type="button" role="tab" data-sub="${index}" aria-selected="${index === state.sub[state.tab]}" class="${index === state.sub[state.tab] ? "selected" : ""}">${name}</button>`).join("")}</div>` : "";
  const heading = privateMode() ? adult ? "\u6210\u4EBA\u5267\u573A" : "AI\u4E13\u533A" : currentName;
  const intro = isRankId(currentId) ? "\u7EA2\u679C\u5B98\u65B9\u70ED\u64AD\u699C\uFF0C\u6309\u89C2\u770B\u4E0E\u4E92\u52A8\u7EFC\u5408\u70ED\u5EA6\u6392\u5E8F\uFF0C\u6BCF\u65E5\u66F4\u65B0\u3002" : privateMode() ? adult ? "\u77ED\u5267\u4E0E\u6F2B\u5267\uFF0C\u8D70\u8FDB\u4E0D\u540C\u7684\u4EBA\u751F\u3002" : "\u6362\u8138\u4E0E\u9B54\u6539\uFF0C\u63A2\u7D22\u5F71\u50CF\u65B0\u53EF\u80FD\u3002" : adult ? "\u771F\u4EBA\u6F14\u7684\u770B\u4E86\u4E0D\u70E7\u5FC3" : "\u63A2\u7D22\u70ED\u95E8\u6F2B\u5267\u3002";
  content.innerHTML = `<div class="category-page"><div class="category-head"><h1>${esc(heading)}</h1><p>${intro}</p></div>
    ${switcher}
    ${spotlight}
    <section class="category-section"><div class="section-heading"><h2>${esc(isRankId(currentId) ? currentName : currentName + "\u4F5C\u54C1")}</h2><span class="category-count">\u5DF2\u663E\u793A ${items.length} \u90E8</span></div>
    <div class="search-grid category-grid">${items.map(itemCard).join("")}</div><div class="category-footer">${categoryFooter()}</div></section></div>`;
  compact.innerHTML = compactMarkup();
  scroll.scrollTop = keepCompact ? 150 : 0;
  state.compactHeld = keepCompact;
  updateCompact();
  hydrateImages();
  observeCategoryEnd();
  slides.forEach((item) => {
    if (item.cover) getCover(item.cover).catch(() => {
    });
  });
  scheduleBannerAuto();
}
function categoryFooter() {
  const category = state.category;
  if (category == null ? void 0 : category.error) return '<button type="button" data-retry-category="1">\u52A0\u8F7D\u5931\u8D25\uFF0C\u70B9\u51FB\u91CD\u8BD5</button>';
  if (category == null ? void 0 : category.loading) return '<span role="status">\u6B63\u5728\u52A0\u8F7D\u66F4\u591A\u2026</span>';
  if (category == null ? void 0 : category.refreshing) return '<span role="status">\u6B63\u5728\u66F4\u65B0\u5217\u8868\u2026</span>';
  if (category == null ? void 0 : category.nextPage) return '<span class="category-sentinel" aria-hidden="true"></span>';
  return "<span>\u5DF2\u7ECF\u5230\u5E95\u4E86</span>";
}
function observeCategoryEnd() {
  categoryObserver == null ? void 0 : categoryObserver.disconnect();
  const category = state.category;
  if (state.route !== "category" || !(category == null ? void 0 : category.nextPage) || category.loading || category.refreshing || category.error) return;
  const sentinel = content.querySelector(".category-sentinel");
  if (!sentinel) return;
  if (!categoryObserver) {
    categoryObserver = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) loadMoreCategory();
    }, { root: scroll, rootMargin: "0px 0px 320px 0px" });
  }
  categoryObserver.observe(sentinel);
}
function updateCategoryFooter() {
  const footer = content.querySelector(".category-footer");
  if (!footer) return;
  footer.innerHTML = categoryFooter();
  observeCategoryEnd();
}
function renderLibrary() {
  const data = state.library || { progress: [], bookmarks: [] };
  const query = state.libraryQuery.trim().toLocaleLowerCase();
  const matches = (item) => String(item.title || "").toLocaleLowerCase().includes(query);
  const progress = asArray(data.progress).filter(matches);
  const bookmarks = asArray(data.bookmarks).filter(matches);
  const historyActive = state.libraryTab === "history";
  const downloadsActive = state.libraryTab === "downloads";
  const historyCards = progress.map((item) => {
    const completed = Boolean(item.completed);
    const episode = Number(item.episode) || 1;
    const percentage = completed ? 100 : Math.max(0, Math.min(100, item.duration ? item.position / item.duration * 100 : 0));
    return `<button type="button" class="history-card" data-history-id="${esc(item.id)}" data-history-episode="${episode}" data-history-completed="${completed}" aria-label="${esc(item.title)}\uFF0C\u7B2C ${episode} \u96C6\uFF0C${completed ? "\u5DF2\u770B\u5B8C\uFF0C\u6253\u5F00\u8BE6\u60C5" : "\u7EE7\u7EED\u89C2\u770B"}">
      <span class="history-poster poster loading"><span class="poster-letter">${esc(String(item.title || "\u5F71\u7247").slice(0, 1))}</span><img data-cover="${esc(item.cover || "")}" alt=""></span><span class="history-copy"><span class="history-status">${completed ? "\u5DF2\u770B\u5B8C" : "\u7EE7\u7EED\u89C2\u770B"} \xB7 \u7B2C ${episode} \u96C6</span>
      <strong>${esc(item.title || "\u5F71\u7247")}</strong><span class="progress"><i style="width:${percentage}%"></i></span><span class="history-hint">${completed ? "\u6253\u5F00\u8BE6\u60C5\u9009\u62E9\u5267\u96C6" : `\u5DF2\u770B ${Math.floor(item.position / 6e4)} \u5206\u949F`}</span></span></button>`;
  }).join("");
  content.innerHTML = `<div class="library-page"><div class="my-heading"><h1>\u6211\u7684</h1></div>
    ${state.account.loggedIn ? "" : `<button type="button" class="my-account" data-account-action="1">\u70B9\u51FB\u5934\u50CF\u767B\u5F55\uFF0C\u540C\u6B65\u6536\u85CF\u548C\u89C2\u770B\u5386\u53F2 ${icon("arrow")}</button>`}
    ${query ? `<div class="library-results"><p class="library-count">\u5728\u89C2\u770B\u5386\u53F2\u4E2D\u627E\u5230 ${progress.length} \u90E8\uFF0C\u5728\u6211\u7684\u6536\u85CF\u4E2D\u627E\u5230 ${bookmarks.length} \u90E8</p>
      <h2>\u89C2\u770B\u5386\u53F2</h2>${progress.length ? `<div class="history-list">${historyCards}</div>` : '<p class="library-no-match">\u6CA1\u6709\u5339\u914D\u7684\u89C2\u770B\u8BB0\u5F55</p>'}
      <h2>\u6211\u7684\u6536\u85CF</h2>${bookmarks.length ? `<div class="search-grid library-bookmark-grid">${bookmarks.map(itemCard).join("")}</div>` : '<p class="library-no-match">\u6CA1\u6709\u5339\u914D\u7684\u6536\u85CF</p>'}</div>` : downloadsActive ? `
    <div class="segmented library-tabs" role="tablist" aria-label="\u6211\u7684\u7247\u5355\u5206\u7C7B"><button type="button" role="tab" data-library-tab="history" aria-selected="${false}" class="">\u89C2\u770B\u5386\u53F2</button>
    <button type="button" role="tab" data-library-tab="bookmarks" aria-selected="${false}" class="">\u6211\u7684\u6536\u85CF</button>
    <button type="button" role="tab" data-library-tab="downloads" aria-selected="${true}" class="selected">\u6211\u7684\u4E0B\u8F7D</button></div>
    <div id="library-downloads"><p class="page-loading">\u6B63\u5728\u52A0\u8F7D\u2026</p></div>` : `
    <div class="segmented library-tabs" role="tablist" aria-label="\u6211\u7684\u7247\u5355\u5206\u7C7B"><button type="button" role="tab" data-library-tab="history" aria-selected="${historyActive}" class="${historyActive ? "selected" : ""}">\u89C2\u770B\u5386\u53F2</button>
    <button type="button" role="tab" data-library-tab="bookmarks" aria-selected="${!historyActive}" class="${!historyActive ? "selected" : ""}">\u6211\u7684\u6536\u85CF</button>
    <button type="button" role="tab" data-library-tab="downloads" aria-selected="${false}" class="">\u6211\u7684\u4E0B\u8F7D</button></div>
    <p class="library-count">${historyActive ? `\u6700\u8FD1\u89C2\u770B\u7684 ${progress.length} \u90E8\u4F5C\u54C1` : `\u5DF2\u6536\u85CF ${bookmarks.length} \u90E8\u4F5C\u54C1`}</p>
    ${historyActive ? progress.length ? `<div class="history-list">${historyCards}</div>` : '<div class="empty-state">\u8FD8\u6CA1\u6709\u89C2\u770B\u8BB0\u5F55\uFF0C\u64AD\u653E\u4F5C\u54C1\u540E\u4F1A\u51FA\u73B0\u5728\u8FD9\u91CC</div>' : bookmarks.length ? `<div class="search-grid library-bookmark-grid">${bookmarks.map(itemCard).join("")}</div>` : '<div class="empty-state">\u8FD8\u6CA1\u6709\u6536\u85CF\u4F5C\u54C1</div>'}`}</div>`;
  hydrateImages();
  if (downloadsActive && !swipePrefetchBusy) renderLibraryDownloads();
}
let libraryDownloadsToken = 0;
const withTimeout = (promise, ms) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error("\u8BF7\u6C42\u8D85\u65F6")), ms))]);
async function renderLibraryDownloads(prefetched) {
  const token = ++libraryDownloadsToken;
  let phone = [], nas = [];
  if (prefetched) {
    phone = prefetched.phone || [];
    nas = prefetched.nas || [];
  } else {
    try {
      phone = asArray(await withTimeout(api("download-list"), 4e3));
    } catch (error) {
      phone = [];
    }
    if (state.account.loggedIn) {
      try {
        const result = await withTimeout(api("nas-download-list"), 4e3);
        nas = asArray(result.tasks);
      } catch (error) {
        nas = [];
      }
      try {
        const pc = await withTimeout(api("desktop-download-list"), 4e3);
        nas = nas.concat(asArray(pc.tasks));
      } catch (error) {
      }
    }
  }
  await loadRemoteJobs();
  if (state.route !== "library" || state.libraryTab !== "downloads" || token !== libraryDownloadsToken) return;
  const list = document.getElementById("library-downloads");
  if (!list) return;
  commitDownloadList(list, phone, nas, prefetched ? { noTimer: true } : {});
}
function commitDownloadList(list, phone, nas, opts = {}) {
  const sig = downloadListSignature(phone, nas);
  if (!opts.force && list.dataset.sig === sig) {
    if (!opts.noTimer) syncDownloadsTimer([...phone, ...nas]);
    return;
  }
  list.dataset.sig = sig;
  if (!opts.noTimer) syncDownloadsTimer([...phone, ...nas]);
  if (!opts.noTimer) processForwardTasks(phone, nas);
  const phoneTasks = phone.map((t) => Object.assign({}, t, { kind: "phone" }));
  const forwardNas = new Set(phone.filter((t) => t.nasTaskId).map((t) => String(t.nasTaskId)));
  const nasTasks = nas.filter((t) => !forwardNas.has(String(t.id)) && (!t.source || t.source === contentSource)).map((t) => Object.assign({}, t, { kind: t.kind === "desktop" || t.kind === "tv" || t.kind === "android" ? t.kind : "nas" }));
  state.deviceTasks = nasTasks.filter((t) => t.kind === "desktop" || t.kind === "tv" || t.kind === "android");
  list.innerHTML = renderDownloadList([...phoneTasks, ...nasTasks]);
  hydrateImages();
  backfillNasCovers(nasTasks);
}
const nasCoverBackfill = /* @__PURE__ */ new Set();
function backfillNasCovers(nasTasks) {
  for (const t of nasTasks) {
    if (t.cover || !t.seriesId) continue;
    const key = String(t.seriesId);
    if (nasCoverBackfill.has(key)) continue;
    nasCoverBackfill.add(key);
    api("detail", { id: key }).then((detail) => {
      nasCoverBackfill.delete(key);
      if (!detail || !detail.cover) return;
      rememberTitleCover(t.title, detail.cover);
      const img = content.querySelector(`[data-dl-play-nas="${t.id}"] img[data-cover]`);
      if (img && !img.naturalWidth) {
        img.dataset.cover = detail.cover;
        delete img.dataset.loading;
        loadCoverInto(img);
      }
    }).catch(() => {
      nasCoverBackfill.delete(key);
    });
  }
}
function downloadListSignature(phone, nas) {
  const red = (t) => [t.id, t.status, t.percent, t.doneCount, t.totalCount, t.nasTaskId, t.cover].map((v) => v == null ? "" : v).join("|");
  const remote = [...remoteJobs.values()].map((j) => [j.taskId, j.status, j.percent, j.serverName, j.error].map((v) => v == null ? "" : v).join("|")).join(";");
  return [...phone.map(red), ...nas.map(red), remote].join(",");
}
function downloadTaskActive(task) {
  return ["queued", "downloading", "merging", "running", "pulling"].includes(task && task.status);
}
let forwardProcessing = false;
async function processForwardTasks(phoneTasks, nasTasks) {
  if (forwardProcessing) return;
  const fwd = (phoneTasks || []).find((t) => t.status === "pulling");
  if (!fwd) return;
  if (!fwd.nasTaskId) return;
  const nas = (nasTasks || []).find((t) => String(t.id) === String(fwd.nasTaskId));
  if (!nas) return;
  if (!["done", "ready"].includes(nas.status)) return;
  if (nas.status === "ready") {
    try {
      await withTimeout(api("nas-download-merge", { id: fwd.nasTaskId }), 8e3);
    } catch (ignore) {
    }
    return;
  }
  forwardProcessing = true;
  try {
    toast(`NAS \u5DF2\u5408\u5E76\uFF0C\u6B63\u5728\u62C9\u5230\u624B\u673A\uFF08${fwd.title}\uFF09`);
    await api("download-forward-pull-merged", { id: fwd.id, nasTaskId: fwd.nasTaskId });
    try {
      await api("nas-download-cancel", { id: fwd.nasTaskId });
    } catch (ignore) {
    }
    toast("\u5DF2\u62C9\u5230\u624B\u673A\u5B8C\u6574\u6210\u54C1");
  } catch (error) {
    toast(`\u8F6C\u53D1\u62C9\u53D6\u5931\u8D25\uFF1A${error.message}`, true);
  } finally {
    forwardProcessing = false;
  }
}
function syncDownloadsTimer(tasks) {
  const active = tasks.some(downloadTaskActive) || [...remoteJobs.values()].some((job) => job && (job.status === "running" || job.status === "queued"));
  if (active) {
    if (!downloadsTimer) downloadsTimer = setInterval(() => {
      if (state.route === "downloads") refreshDownloads(routeToken, true);
      else if (state.route === "library" && state.libraryTab === "downloads") renderLibraryDownloads();
      else stopDownloadsTimer();
    }, 2e3);
  } else stopDownloadsTimer();
}
let downloadsTimer = null;
let remoteJobs = /* @__PURE__ */ new Map();
async function loadRemoteJobs() {
  try {
    const list = asArray(await withTimeout(api("remote-transfer-list"), 3e3));
    const map = /* @__PURE__ */ new Map();
    for (const job of list) {
      if (job && job.taskId) map.set(String(job.taskId), job);
    }
    remoteJobs = map;
  } catch (error) {
  }
  return remoteJobs;
}
function stopDownloadsTimer() {
  if (downloadsTimer) {
    clearInterval(downloadsTimer);
    downloadsTimer = null;
  }
}
function goDownloads() {
  const token = ++routeToken;
  state.previous = { route: state.route };
  state.settingsReturn = { route: state.route };
  setRoute("downloads");
  content.innerHTML = `<div class="settings-page downloads-page"><button type="button" class="listing-back" data-back="1">${icon("back")} \u8FD4\u56DE\u8BBE\u7F6E</button><h1>\u4E0B\u8F7D\u7BA1\u7406</h1><div id="downloads-list"><p class="page-loading">\u6B63\u5728\u52A0\u8F7D\u2026</p></div></div>`;
  refreshDownloads(token, true);
}
async function refreshDownloads(token, keepTimer) {
  if (state.route !== "downloads" || routeToken !== token) {
    stopDownloadsTimer();
    return;
  }
  let phone = [], nas = [];
  try {
    phone = await api("download-list");
  } catch (error) {
    phone = [];
  }
  if (state.account.loggedIn) {
    try {
      const result = await api("nas-download-list");
      nas = asArray(result.tasks);
    } catch (error) {
      nas = [];
    }
    try {
      const pc = await api("desktop-download-list");
      nas = nas.concat(asArray(pc.tasks));
    } catch (error) {
    }
  }
  await loadRemoteJobs();
  if (state.route !== "downloads" || routeToken !== token) return;
  const list = document.getElementById("downloads-list");
  if (!list) return;
  if (keepTimer) syncDownloadsTimer([...phone, ...nas]);
  processForwardTasks(phone, nas);
  const phoneTasks = phone.map((t) => Object.assign({}, t, { kind: "phone" }));
  const forwardNas = new Set(phone.filter((t) => t.nasTaskId).map((t) => String(t.nasTaskId)));
  const nasTasks = nas.filter((t) => !forwardNas.has(String(t.id)) && (!t.source || t.source === contentSource)).map((t) => Object.assign({}, t, { kind: t.kind === "desktop" || t.kind === "tv" || t.kind === "android" ? t.kind : "nas" }));
  state.deviceTasks = nasTasks.filter((t) => t.kind === "desktop" || t.kind === "tv" || t.kind === "android");
  list.innerHTML = renderDownloadList([...phoneTasks, ...nasTasks]);
}
function renderDownloadSection(label, tasks, kind) {
  if (!tasks.length) return "";
  const rows = tasks.map((task) => downloadTaskRow(task, kind)).join("");
  return `<h2 class="downloads-section-title">${label}</h2>${rows}`;
}
function renderDownloadList(tasks) {
  if (!tasks.length) return '<div class="empty-state">\u8FD8\u6CA1\u6709\u4E0B\u8F7D\u5185\u5BB9\uFF0C\u53BB\u8BE6\u60C5\u9875\u70B9\u51FB\u300C\u4E0B\u8F7D\u300D\u5427</div>';
  const grouped = [];
  const byTitle = /* @__PURE__ */ new Map();
  for (const t of tasks) {
    if (t.kind === "phone") {
      const key = t.title || "";
      if (!byTitle.has(key)) byTitle.set(key, []);
      byTitle.get(key).push(t);
    } else grouped.push(t);
  }
  for (const [title, list] of byTitle) {
    if (list.length === 1) {
      grouped.push(list[0]);
      continue;
    }
    const first = Object.assign({}, list.find((t) => t.status !== "done") || list[0]);
    first.totalCount = list.reduce((s, t) => s + (Number(t.totalCount) || 0), 0);
    first.doneCount = list.reduce((s, t) => s + (Number(t.doneCount) || 0), 0);
    const anyActive = list.some(downloadTaskActive);
    const anyReady = list.some((t) => t.status === "ready" || t.status === "failed" && (t.error || "").includes("\u5408\u5E76\u5931\u8D25"));
    const anyFailed = list.some((t) => t.status === "failed" && !(t.error || "").includes("\u5408\u5E76\u5931\u8D25"));
    first.status = anyActive ? "running" : anyReady ? "ready" : anyFailed ? "failed" : "done";
    first.percent = list.reduce((s, t) => s + (Number(t.percent) || 0), 0) / list.length;
    if (!anyActive && anyReady) first.detail = `\u5DF2\u4E0B\u8F7D ${first.doneCount} \u96C6\uFF0C\u5F85\u5408\u5E76`;
    first.children = list;
    grouped.push(first);
  }
  const rows = grouped.map((task) => downloadTaskRow(task, task.kind || (task.nas ? "nas" : "phone"))).join("");
  return `<div class="downloads-list">${rows}</div>`;
}
const TITLE_COVERS_KEY = "veyra-title-covers";
let titleCovers = null;
function loadTitleCovers() {
  if (titleCovers) return titleCovers;
  try {
    titleCovers = new Map(Object.entries(JSON.parse(localStorage.getItem(TITLE_COVERS_KEY) || "{}")));
  } catch (e) {
    titleCovers = /* @__PURE__ */ new Map();
  }
  return titleCovers;
}
function rememberTitleCover(title, cover) {
  if (!title || !cover) return;
  const map = loadTitleCovers();
  const key = String(title);
  if (map.has(key)) return;
  map.set(key, String(cover));
  if (map.size > 400) map.delete(map.keys().next().value);
  try {
    localStorage.setItem(TITLE_COVERS_KEY, JSON.stringify(Object.fromEntries(map)));
  } catch (ignore) {
  }
}
function coverForTask(task) {
  return task.cover || loadTitleCovers().get(String(task.title || "")) || "";
}
function downloadTaskRow(task, kind) {
  const running = task.status === "running";
  const statusText = downloadStatusText(task, kind);
  const remoteKind = kind === "desktop" || kind === "tv" || kind === "android";
  const deviceLabel = kind === "desktop" ? "\u7535\u8111" : kind === "tv" ? "\u7535\u89C6" : "\u624B\u673A";
  const sourceBadge = kind === "nas" ? '<span class="dl-source-badge nas">NAS</span>' : remoteKind ? `<span class="dl-source-badge ${kind}">${deviceLabel} \xB7 ${esc(task.deviceName || "\u5728\u7EBF")}</span>` : '<span class="dl-source-badge phone">\u624B\u673A</span>';
  const remoteJob = kind === "phone" ? remoteJobs.get(String(task.id)) : null;
  const remoteText = remoteJobText(remoteJob);
  const remoteBusy = !!(remoteJob && (remoteJob.status === "running" || remoteJob.status === "queued"));
  const canTransfer = kind === "phone" && !running && !remoteBusy && (task.status === "done" || task.status === "ready" || task.status === "failed");
  const transferBtn = canTransfer ? `<button type="button" class="dl-cancel dl-transfer" data-dl-transfer="${esc(task.id)}">${remoteJob && remoteJob.status === "failed" ? "\u91CD\u4F20" : "\u4F20\u5230\u670D\u52A1\u5668"}</button>` : "";
  const transferCancel = remoteJob && (remoteJob.status === "running" || remoteJob.status === "queued") ? `<button type="button" class="dl-cancel" data-dl-transfer-cancel="${esc(remoteJob.id)}">\u53D6\u6D88\u4F20\u8F93</button>` : "";
  const output = task.output && (task.output.startsWith("content://") || task.output.startsWith("file://")) ? "\u5DF2\u4FDD\u5B58\u5230\u7CFB\u7EDF\u4E0B\u8F7D\u76EE\u5F55" : task.output || "";
  const cancelBtn = running ? `<button type="button" class="dl-cancel" data-dl-cancel="${kind}" data-dl-id="${esc(task.id)}">\u53D6\u6D88</button>` : "";
  const retryBtn = !running && kind === "phone" && (task.status === "failed" || task.status === "canceled") && !(task.error || "").includes("\u5408\u5E76\u5931\u8D25") ? `<button type="button" class="dl-cancel dl-retry" data-dl-retry="phone" data-dl-id="${esc(task.id)}">\u91CD\u8BD5</button>` : "";
  const failedList = task.failedEpisodes || [];
  const srcNote = task.detail && task.detail.includes("\uFF08") ? (task.detail.match(/（([^）]*)）/) || [])[1] || "" : "";
  const canRetryFailed = task.status === "ready" || task.status === "failed" && !(task.error || "").includes("\u5408\u5E76\u5931\u8D25");
  const retryFailedBtn = !running && kind === "nas" && canRetryFailed && failedList.length > 0 ? `<button type="button" class="dl-cancel dl-retry" data-dl-retry-failed="nas" data-dl-id="${esc(task.id)}">\u91CD\u8BD5\u5931\u8D25${failedList.length}\u96C6</button>` : "";
  const mergeBtn = !running && !remoteKind && (task.status === "ready" || (task.status === "failed" || task.status === "done") && (task.error || "").includes("\u5408\u5E76\u5931\u8D25")) ? `<button type="button" class="dl-cancel dl-retry" data-dl-merge="${kind}" data-dl-id="${esc(task.id)}">\u5408\u5E76</button>` : "";
  const deleteBtn = !running && !remoteKind ? `<button type="button" class="dl-cancel" data-dl-delete="${kind}" data-dl-id="${esc(task.id)}"${task.children && task.children.length > 1 ? ` data-dl-siblings="${esc(task.children.map((c) => c.id).join(","))}"` : ""}>\u5220\u9664</button>` : "";
  const failedInfo = failedList.length > 0 ? `<span class="dl-error" data-dl-copy="${esc(task.id)}" data-dl-log="${esc("\u5931\u8D25\u96C6: " + failedList.map((f) => "\u7B2C" + f.index + "\u96C6(" + (f.error || "") + ")").join("\uFF1B"))}" title="\u70B9\u51FB\u590D\u5236\u5931\u8D25\u660E\u7EC6">\u5931\u8D25 ${failedList.length} \u96C6\uFF1A${esc(failedList.slice(0, 3).map((f) => "\u7B2C" + f.index + "\u96C6").join("\u3001"))}${failedList.length > 3 ? " \u7B49" : ""}</span>` : "";
  const errLog = task.error || task.debug || "";
  const errBlock = errLog ? `<span class="dl-error" data-dl-copy="${esc(task.id)}" data-dl-log="${esc(errLog.replace(/\n/g, "\\n"))}" title="\u70B9\u51FB\u590D\u5236\u5168\u90E8\u65E5\u5FD7">${task.error ? task.error.split("\n").slice(0, 4).map(esc).join("<br>") : '<span class="dl-log-link">\u590D\u5236\u5408\u5E76\u65E5\u5FD7</span>'}</span>` : "";
  const detailHint = task.detail && (/片/.test(task.detail) || task.detail.includes("\u5408\u5E76\u4E2D")) ? ` \xB7 <span class="dl-detail-hint">${esc(task.detail)}</span>` : "";
  const playAttr = kind === "nas" ? "data-dl-play-nas" : remoteKind ? "data-dl-play-device" : "data-dl-play";
  const playHint = kind === "nas" ? "\u64AD\u653E NAS \u6210\u54C1" : remoteKind ? `\u64AD\u653E${deviceLabel}\u4E0A\u7684\u6210\u54C1` : "\u672C\u5730\u64AD\u653E";
  const playTile = `<button type="button" class="download-cover" ${playAttr}="${esc(task.id)}" aria-label="${playHint}\u300A${esc(task.title || "\u672A\u77E5\u5267\u96C6")}\u300B">
    <span class="poster loading"><span class="poster-letter">${esc(String(task.title || "\u5F71").slice(0, 1))}</span><img data-cover="${esc(coverForTask(task))}" alt=""></span>
    <span class="download-cover-hint">${playHint}</span></button>`;
  return `<div class="download-card">${playTile}<div class="download-task">
    <div class="download-task-head"><strong>${esc(task.title || "\u672A\u77E5\u5267\u96C6")}</strong>${sourceBadge}<span class="dl-status ${running ? "is-running" : ""}">${statusText}</span></div>
    <div class="download-task-meta">${task.doneCount}/${task.totalCount} \u96C6 \xB7 ${task.doneCount === task.totalCount && task.status !== "running" ? "\u5DF2\u4E0B\u8F7D\u5168\u90E8\u96C6" : failedList.length ? `\u5931\u8D25 ${failedList.length} \u96C6` : ""}${srcNote ? ` \xB7 <b class="dl-src-note">${esc(srcNote)}</b>` : ""}${detailHint}${remoteText ? ` \xB7 <span class="dl-remote-note ${remoteJob.status}">${esc(remoteText)}</span>` : ""}</div>
    <div class="download-track"><i style="width:${Math.max(0, Math.min(100, Number(task.percent) || 0))}%"></i></div>
    <div class="download-task-foot">${output ? `<span class="dl-output">${esc(output)}</span>` : ""}${failedInfo}${errBlock}${transferBtn}${transferCancel}${mergeBtn}${retryFailedBtn}${retryBtn}${cancelBtn}${deleteBtn}</div>
  </div></div>`;
}
function remoteJobText(job) {
  if (!job) return "";
  const name = job.serverName || "\u8FDC\u7A0B\u670D\u52A1\u5668";
  if (job.status === "running" || job.status === "queued") return `\u4F20\u8F93\u5230 ${name} ${Number(job.percent) || 0}%`;
  if (job.status === "done") return `\u5DF2\u4F20\u5230 ${name}`;
  if (job.status === "failed") return `\u4F20\u8F93\u5931\u8D25\uFF1A${job.error || "\u672A\u77E5\u9519\u8BEF"}`;
  if (job.status === "canceled") return "\u4F20\u8F93\u5DF2\u53D6\u6D88";
  return "";
}
function downloadStatusText(task, kind) {
  const failedCount = (task.failedEpisodes || []).length;
  if (task.status === "pulling") {
    const d = task.detail || "";
    if (d.includes("\u62C9\u53D6")) return d.replace(/已从 NAS /, "\u4ECE NAS ");
    return "\u7B49\u5F85 NAS \u4E0B\u8F7D";
  }
  if (task.status === "ready") return failedCount > 0 ? `\u5DF2\u4E0B\u8F7D \xB7 \u5931\u8D25${failedCount}\u96C6` : "\u5DF2\u4E0B\u8F7D \xB7 \u5F85\u5408\u5E76";
  if (task.status === "done") {
    if (kind === "nas") return "\u5DF2\u4E0B\u8F7D \xB7 \u5DF2\u5408\u5E76";
    if ((task.detail || "").includes("\u5DF2\u5408\u5E76")) return "\u5DF2\u4E0B\u8F7D \xB7 \u5DF2\u5408\u5E76";
    return "\u5DF2\u4E0B\u8F7D";
  }
  if (task.status === "failed") return failedCount > 0 ? `\u5931\u8D25 \xB7 \u53EF\u91CD\u8BD5${failedCount}\u96C6` : "\u5931\u8D25";
  if (task.status === "canceled") return "\u5DF2\u53D6\u6D88";
  const detail = task.detail || "";
  if (detail.includes("\u4FDD\u5B58")) return "\u4FDD\u5B58\u5230\u624B\u673A";
  const m = detail.match(/第\s*(\d+)\s*\/\s*(\d+)/);
  if (m) return `\u4E0B\u8F7D\u4E2D ${m[1]}/${m[2]}`;
  if (/第\s*\d+\s*集/.test(detail) && detail.includes("\u5408\u5E76")) return "\u4E0B\u8F7D\u4E2D \xB7 \u53D6\u6D41\u5408\u5E76";
  if (detail.includes("\u5F85\u5408\u5E76")) return "\u5F85\u5408\u5E76";
  if (detail.includes("\u5408\u5E76")) return "\u5408\u5E76\u4E2D";
  return "\u4E0B\u8F7D\u4E2D";
}
let downloadMode = null;
const downloadSelection = /* @__PURE__ */ new Set();
let downloadParsing = false;
function showDownloadSheet() {
  if (!state.detail) return;
  const episodes = asArray(state.detail.episodes);
  if (!episodes.length) {
    toast("\u8BE5\u5185\u5BB9\u6682\u65E0\u53EF\u9009\u96C6", true);
    return;
  }
  downloadMode = "episodes";
  downloadSelection.clear();
  downloadParsing = false;
  downloadOverlay.hidden = false;
  updateBackEnabled();
  if (state.account.loggedIn) {
    api("refresh-account").then((fresh) => {
      if (fresh && fresh.role) setAccount(fresh);
    }).catch(() => {
    });
  }
  renderDownloadSheet();
}
function hideDownloadSheet() {
  downloadOverlay.hidden = true;
  downloadParsing = false;
  updateBackEnabled();
}
function renderDownloadSheet() {
  const sheet = document.getElementById("download-sheet");
  if (!sheet) return;
  const episodes = asArray(state.detail.episodes);
  if (downloadMode === "parsing") {
    sheet.innerHTML = `<p class="download-parsing">\u6B63\u5728\u89E3\u6790\u64AD\u653E\u5730\u5740\u2026<br><small>\u9700\u8981\u9010\u96C6\u89E3\u6790\uFF0C\u8BF7\u7A0D\u5019</small></p>`;
    return;
  }
  if (downloadMode === "target") {
    const isAdmin = state.account.role === "admin";
    const canDebug = privateMode();
    if (remoteServers === null) {
      loadRemoteServers(true).then(() => {
        if (downloadMode === "target") renderDownloadSheet();
      }).catch(() => {
      });
    }
    const hasRemote = !!(remoteServers && remoteServers.length);
    sheet.innerHTML = `<div class="download-pick">
      <button type="button" class="download-pick-option" data-dl-pick="phone"><strong>\u4E0B\u8F7D\u5230\u624B\u673A</strong></button>
      <button type="button" class="download-pick-option" data-dl-pick="remote"><strong>\u4E0B\u8F7D\u5230\u8FDC\u7A0B\u670D\u52A1\u5668</strong>${hasRemote ? "" : "<small>\u8FD8\u6CA1\u914D\u7F6E\u670D\u52A1\u5668</small>"}</button>
      <button type="button" class="download-pick-option" data-dl-pick="nas" ${isAdmin ? "" : "disabled"}><strong>\u4E0B\u8F7D\u5230 NAS</strong>${isAdmin ? "" : "<small>\u4EC5\u7BA1\u7406\u5458\u53EF\u7528</small>"}</button>
      ${canDebug ? '<button type="button" class="download-pick-option" data-dl-pick="phone-debug"><strong>\u4E0B\u8F7D\u5230\u624B\u673A\uFF08\u8C03\u8BD5\uFF09</strong><small>\u4FDD\u7559 TS \u4E0E Key\uFF0C\u4E0D\u81EA\u52A8\u5408\u5E76\uFF0C\u5BFC\u51FA\u8C03\u8BD5\u5305</small></button>' : ""}
      <p class="download-nas-note">${state.account.loggedIn ? "" : "NAS \u4E0B\u8F7D\u9700\u8981\u5148\u767B\u5F55\u8D26\u53F7\u3002"}</p>
    </div>`;
    return;
  }
  if (downloadMode === "remote") {
    const servers = asArray(remoteServers);
    sheet.innerHTML = `<div class="download-pick">${servers.map((s) => `<button type="button" class="download-pick-option" data-dl-remote="${esc(s.id)}"><strong>${esc(s.name)}</strong><small>${esc(s.typeName)} \xB7 ${esc(s.address)}</small></button>`).join("")}</div>
      <div class="download-sheet-buttons"><button type="button" class="dl-secondary" data-dl-back-target="1">\u8FD4\u56DE</button></div>`;
    return;
  }
  const all = episodes.map((ep) => Number(ep.number) || 0);
  const checked = all.filter((n) => downloadSelection.has(n)).length;
  const allSelected = all.length && checked === all.length;
  sheet.innerHTML = `<div class="download-sheet-toolbar"><button type="button" class="dl-secondary" data-dl-all="1">${allSelected ? "\u53D6\u6D88\u5168\u9009" : "\u5168\u9009"}</button><span>\u5DF2\u9009 ${checked}/${all.length} \u96C6</span></div>
    <div class="download-sheet-grid">${episodes.map((ep) => {
    const n = Number(ep.number) || 0;
    return `<label class="dl-ep ${downloadSelection.has(n) ? "checked" : ""}" data-dl-ep="${n}"><span>${n}</span></label>`;
  }).join("")}</div>
    <div class="download-sheet-buttons"><button type="button" class="dl-secondary" data-dl-back="1">\u53D6\u6D88</button><button type="button" class="dl-primary" data-dl-confirm="1" ${checked ? "" : "disabled"}>\u4E0B\u8F7D ${checked ? checked + " \u96C6" : ""}</button></div>`;
}
async function resolveEpisodesForDownload(episodes) {
  const resolved = [];
  const detailEpisodes = asArray(state.detail.episodes);
  const hgJobs = [];
  for (const n of episodes) {
    if (privateMode()) {
      hgJobs.push({ n, p: api("episode", { id: state.detail.id, episode: n }) });
      continue;
    }
    const meta = detailEpisodes.find((ep) => Number(ep.number) === n);
    if (meta && meta.url) {
      resolved.push({ index: n, url: meta.url, key: "" });
      continue;
    }
    let data;
    try {
      data = await api("episode", { id: state.detail.id, episode: n });
    } catch (error) {
      throw new Error(`\u7B2C ${n} \u96C6\u64AD\u653E\u5730\u5740\u89E3\u6790\u5931\u8D25\uFF1A${error.message || "\u672A\u77E5\u9519\u8BEF"}`);
    }
    const source = String(data && data.source || "");
    if (!/^https?:\/\//i.test(source)) {
      throw new Error(`\u7B2C ${n} \u96C6\u6CA1\u6709\u62FF\u5230\u6709\u6548\u7684\u64AD\u653E\u5730\u5740\uFF08${source.slice(0, 40) || "\u4E3A\u7A7A"}\uFF09\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5`);
    }
    resolved.push({ index: n, url: source, key: data.key || "" });
  }
  for (const j of hgJobs) {
    let data;
    try {
      data = await j.p;
    } catch (error) {
      throw new Error(`\u7B2C ${j.n} \u96C6\u64AD\u653E\u5730\u5740\u89E3\u6790\u5931\u8D25\uFF1A${error.message || "\u672A\u77E5\u9519\u8BEF"}`);
    }
    const source = String(data && data.source || "");
    if (!/^https?:\/\//i.test(source)) throw new Error(`\u7B2C ${j.n} \u96C6\u6CA1\u6709\u62FF\u5230\u6709\u6548\u7684\u64AD\u653E\u5730\u5740\uFF08${source.slice(0, 40) || "\u4E3A\u7A7A"}\uFF09\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5`);
    resolved.push({ index: j.n, url: source, key: "" });
  }
  if (!resolved.length) throw new Error("\u6CA1\u6709\u53EF\u4E0B\u8F7D\u7684\u5206\u96C6");
  const bad = resolved.find((r) => !/^https?:\/\//i.test(String(r.url || "")));
  if (bad) throw new Error(`\u7B2C ${bad.index} \u96C6\u64AD\u653E\u5730\u5740\u65E0\u6548\uFF0C\u5DF2\u53D6\u6D88\u63D0\u4EA4`);
  return resolved;
}
async function submitDownloadTo(target, remoteId) {
  var _a2, _b2;
  if (downloadParsing) return;
  if (target === "nas") {
    if (!state.account.loggedIn) {
      toast("\u8BF7\u5148\u767B\u5F55\u8D26\u53F7", true);
      return;
    }
    try {
      const fresh = await api("refresh-account");
      if (fresh && fresh.role) setAccount(fresh);
    } catch (ignore) {
    }
    if (state.account.role !== "admin") {
      toast("\u4EC5\u7BA1\u7406\u5458\u53EF\u4E0B\u8F7D\u5230 NAS", true);
      return;
    }
  }
  if (target === "remote" && !remoteId) {
    toast("\u8BF7\u9009\u62E9\u8981\u4F20\u5230\u54EA\u53F0\u670D\u52A1\u5668", true);
    return;
  }
  const episodes = asArray(state.detail.episodes).map((ep) => Number(ep.number) || 0).filter((n) => downloadSelection.has(n));
  if (!episodes.length) {
    toast("\u8BF7\u5148\u9009\u62E9\u96C6\u6570", true);
    return;
  }
  downloadParsing = true;
  downloadMode = "parsing";
  renderDownloadSheet();
  try {
    if (target === "nas") {
      await api("nas-download-start", { source: contentSource, title: state.detail.title, seriesId: String(state.detail.seriesId || state.detail.id), episodes, cover: state.detail.cover || "" });
      toast("\u5DF2\u63D0\u4EA4 NAS \u4E0B\u8F7D\u4EFB\u52A1\uFF08\u540E\u7AEF\u81EA\u884C\u89E3\u6790\u53D6\u6D41\uFF09");
    } else {
      let sourceNow = String(((_a2 = state.detail) == null ? void 0 : _a2.source) || "");
      if (sourceNow !== "huangguo" && sourceNow !== "hongguo") {
        try {
          const fresh = await api("content-status");
          if (fresh && fresh.source) sourceNow = fresh.source;
        } catch (ignore) {
        }
        if (sourceNow !== "huangguo" && sourceNow !== "hongguo") sourceNow = contentSource;
      }
      let proxyModeNow = Number(state.proxyMode) || 3;
      try {
        const pmv = await api("get-proxy-mode");
        if (pmv !== null && pmv !== void 0 && pmv !== "") proxyModeNow = Number(pmv) || 3;
      } catch (ignore) {
      }
      console.log(`[dl-judge] source=${sourceNow} proxyMode=${proxyModeNow} role=${(_b2 = state.account) == null ? void 0 : _b2.role} remote=${remoteId || "-"}`);
      {
        const resolved = await resolveEpisodesForDownload(episodes);
        if (!resolved.length) throw new Error("\u6CA1\u6709\u53EF\u4E0B\u8F7D\u7684\u5206\u96C6");
        const debug = target === "phone-debug";
        const targetRemote = target === "remote" ? String(remoteId || "") : "";
        await api("download-start", { source: sourceNow, title: state.detail.title, episodes: resolved, debug, cover: state.detail.cover || "", remoteId: targetRemote });
        toast(debug ? `\u8C03\u8BD5\u6A21\u5F0F\u5DF2\u5F00\u59CB\uFF08${resolved.length} \u96C6\uFF09\uFF1A\u5206\u7247\u4E0B\u5B8C\u540E\u4F1A\u5BFC\u51FA\u300C\u7B2CNN\u96C6_\u8C03\u8BD5\u5305.zip\u300D\u5230 Download/Veyra/${state.detail.title}` : targetRemote ? `\u5DF2\u5F00\u59CB\u4E0B\u8F7D ${resolved.length} \u96C6` : `\u5224\u5B9A[\u6E90=${sourceNow} \u901A\u9053=${proxyModeNow}] \u5DF2\u5F00\u59CB\u4E0B\u8F7D\u5230\u624B\u673A\uFF08\u624B\u673A\u7ECF\u4EE3\u7406\u62C9\u6E90\u5408\u5E76\uFF09`);
      }
    }
    hideDownloadSheet();
  } catch (error) {
    downloadParsing = false;
    downloadMode = "target";
    renderDownloadSheet();
    toast(`${target === "nas" ? "\u63D0\u4EA4\u5931\u8D25" : "\u4E0B\u8F7D\u5931\u8D25"}\uFF1A${error.message}`, true);
  }
}
function renderSettings() {
  content.innerHTML = `<div class="settings-page"><button type="button" class="listing-back" data-back="1">${icon("back")} \u8FD4\u56DE\u6211\u7684</button><h1>\u8BBE\u7F6E</h1>
    ${window.renderAppearance ? window.renderAppearance() : ""}
    <section><button type="button" class="settings-link" data-account-management="1"><span><strong>\u8D26\u53F7\u7BA1\u7406</strong><small>${state.account.loggedIn ? esc(state.account.username) : "\u767B\u5F55\u6216\u6CE8\u518C\u8D26\u53F7"}</small></span>${icon("arrow")}</button></section>
    <section><button type="button" class="settings-link" data-proxy-open><span><strong>\u9EC4\u679C\u7F51\u7EDC\u901A\u9053</strong><small data-proxy-summary>${esc(proxySummaryText())}</small></span>${icon("arrow")}</button></section>
    <section><button type="button" class="settings-link" data-remote-open><span><strong>\u8FDC\u7A0B\u670D\u52A1\u5668</strong><small data-remote-summary>${esc(remoteSummaryText())}</small></span>${icon("arrow")}</button></section>
    <section><button type="button" class="settings-link" data-about-open><span><strong>\u5173\u4E8E Veyra</strong><small>\u9879\u76EE\u5730\u5740 \xB7 GPL-3.0 \u5F00\u6E90</small></span>${icon("arrow")}</button></section></div>`;
  if (window.bindAppearance) window.bindAppearance();
  api("hot-update-status").then(window.hgHotUpdateStatus).catch(() => {
  });
  loadRemoteServers(true).catch(() => {
  });
}
const PROXY_MODE_NAMES = { 1: "\u4EC5\u76F4\u8FDE", 2: "\u4EC5\u4EE3\u7406", 3: "\u8D70\u540E\u7AEF\u8F6C\u53D1" };
const roleCanUseBackend = () => {
  var _a2, _b2;
  return ((_a2 = state.account) == null ? void 0 : _a2.role) === "admin" || ((_b2 = state.account) == null ? void 0 : _b2.role) === "vip";
};
function setProxyModeLabel(mode) {
  state.proxyMode = Number(mode) || 3;
  if (state.proxyMode < 1 || state.proxyMode > 3) state.proxyMode = 3;
  if (state.proxyMode === 3 && !roleCanUseBackend()) state.proxyMode = 1;
  const label = document.getElementById("proxy-mode-label");
  if (label) label.textContent = PROXY_MODE_NAMES[state.proxyMode] || "\u8D70\u540E\u7AEF\u8F6C\u53D1";
  const menu = document.getElementById("proxy-mode-menu");
  if (menu) {
    for (const item of menu.querySelectorAll("[data-mode]")) {
      item.classList.toggle("active", Number(item.dataset.mode) === state.proxyMode);
      item.classList.toggle("disabled", Number(item.dataset.mode) === 3 && !roleCanUseBackend());
      item.toggleAttribute("disabled", Number(item.dataset.mode) === 3 && !roleCanUseBackend());
    }
  }
  updateProxySummary();
}
function fitPopToMenu(menu) {
  const pop = menu.closest(".appearance-pop");
  if (!pop || menu.hidden) return;
  pop.style.minHeight = "";
  const overflow = menu.getBoundingClientRect().bottom - pop.getBoundingClientRect().bottom;
  if (overflow > 0) pop.style.minHeight = `${Math.ceil(pop.offsetHeight + overflow + 12)}px`;
  menu.scrollIntoView({ block: "nearest" });
}
function initProxyModeDropdown() {
  const root = document.getElementById("proxy-mode-dd");
  if (!root) return;
  const toggle = root.querySelector("[data-mode-toggle]");
  const menu = document.getElementById("proxy-mode-menu");
  if (!toggle || !menu) return;
  const close = () => {
    menu.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
    root.dataset.open = "false";
  };
  toggle.addEventListener("click", (event) => {
    event.stopPropagation();
    menu.hidden = !menu.hidden;
    toggle.setAttribute("aria-expanded", String(!menu.hidden));
    root.dataset.open = String(!menu.hidden);
    if (!menu.hidden) requestAnimationFrame(() => fitPopToMenu(menu));
    else {
      const pop = menu.closest(".appearance-pop");
      if (pop) pop.style.minHeight = "";
    }
  });
  for (const item of menu.querySelectorAll("[data-mode]")) {
    item.addEventListener("click", (event) => {
      event.stopPropagation();
      const value = Number(item.dataset.mode) || 3;
      if (value === 3 && !roleCanUseBackend()) {
        toast("\u8D70\u540E\u7AEF\u8F6C\u53D1\u4EC5\u7BA1\u7406\u5458\u4E0E\u7279\u6743\u7EC4\u53EF\u7528\uFF0C\u8BF7\u8054\u7CFB\u7BA1\u7406\u5458\u5F00\u901A", true);
        return;
      }
      setProxyModeLabel(value);
      close();
      api("set-proxy-mode", { value }).then(() => {
        toast(`\u5DF2\u5207\u6362\uFF1A${PROXY_MODE_NAMES[value] || value}`, false);
      }).catch((error) => {
        setProxyModeLabel(state.proxyMode);
        toast(error.message, true);
      });
    });
  }
  document.addEventListener("click", (event) => {
    if (!root.contains(event.target)) close();
  });
}
function accountRoleInfo() {
  var _a2;
  const role = (_a2 = state.account) == null ? void 0 : _a2.role;
  return role === "admin" ? { key: "admin", label: "\u7BA1\u7406\u5458" } : role === "vip" ? { key: "vip", label: "\u7279\u6743\u7528\u6237" } : { key: "user", label: "\u666E\u901A\u7528\u6237" };
}
function accountIdentityHtml() {
  const account = state.account;
  const role = accountRoleInfo();
  return `<section class="account-identity"><button type="button" class="account-avatar-pick" data-choose-avatar="1" aria-label="\u70B9\u51FB\u5934\u50CF\u4ECE\u76F8\u518C\u66F4\u6362"><img src="${esc(account.avatar || "user.svg")}" alt=""></button><div><strong>${esc(account.username)}</strong><span class="account-role is-${role.key}">${role.label}</span></div></section>`;
}
function renderAccountManagement() {
  const account = state.account;
  content.innerHTML = `<div class="settings-page account-page"><button type="button" class="listing-back" data-back="1">${icon("back")} \u8FD4\u56DE\u8BBE\u7F6E</button><h1>\u8D26\u53F7\u7BA1\u7406</h1>
    ${account.loggedIn ? `${accountIdentityHtml()}
      <section class="settings-account"><h2>\u4FEE\u6539\u5BC6\u7801</h2><p>\u5148\u9A8C\u8BC1\u65E7\u5BC6\u7801\uFF0C\u518D\u8BBE\u7F6E\u65B0\u5BC6\u7801\u3002</p>
        <form id="password-form" class="password-form">
          <label for="old-password">\u65E7\u5BC6\u7801</label><input id="old-password" type="password" autocomplete="current-password" required>
          <label for="new-password">\u65B0\u5BC6\u7801</label><input id="new-password" type="password" autocomplete="new-password" required>
          <p id="password-error" class="auth-error" role="alert" hidden></p><button type="submit">\u786E\u8BA4\u4FEE\u6539</button>
        </form></section>
      <section class="settings-account"><h2>\u540C\u6B65\u4E0E\u767B\u5F55</h2><button type="button" data-sync-now="1">\u7ACB\u5373\u540C\u6B65\u7247\u5355</button><button type="button" data-logout="1" aria-live="polite">\u9000\u51FA\u767B\u5F55</button></section>
      <section class="settings-account"><h2>\u626B\u7801\u767B\u5F55\u5176\u5B83\u8BBE\u5907</h2><p>\u7535\u89C6\u3001\u7535\u8111\u3001\u5E73\u677F\u767B\u5F55\u9875\u4E0A\u7684\u4E8C\u7EF4\u7801\u90FD\u80FD\u626B\uFF1A\u626B\u5B8C\u8FD9\u53F0\u624B\u673A\u7684\u8D26\u53F7\u4F1A\u76F4\u63A5\u540C\u6B65\u8FC7\u53BB\uFF0C\u4E0D\u7528\u6572\u5BC6\u7801\u3002</p><button type="button" data-qr-login="1">\u53BB\u626B\u7801\u767B\u5F55</button></section>` : `<section class="settings-account"><p>\u767B\u5F55\u540E\u53EF\u540C\u6B65\u6536\u85CF\u548C\u89C2\u770B\u5386\u53F2\uFF0C\u5E76\u7BA1\u7406\u5934\u50CF\u4E0E\u5BC6\u7801\u3002</p><button type="button" data-account-action="1">\u767B\u5F55\u6216\u6CE8\u518C</button></section>
      <section class="settings-account"><h2>\u626B\u7801\u767B\u5F55\u5176\u5B83\u8BBE\u5907</h2><p>\u7535\u89C6\u3001\u7535\u8111\u3001\u5E73\u677F\u767B\u5F55\u9875\u4E0A\u7684\u4E8C\u7EF4\u7801\u90FD\u80FD\u626B\uFF1A\u626B\u5B8C\u8FD9\u53F0\u624B\u673A\u7684\u8D26\u53F7\u4F1A\u76F4\u63A5\u540C\u6B65\u8FC7\u53BB\uFF0C\u4E0D\u7528\u6572\u5BC6\u7801\u3002</p><button type="button" data-qr-login="1">\u53BB\u626B\u7801\u767B\u5F55</button></section>`}</div>`;
}
var accountPop = null;
function buildAccountPopHtml() {
  const account = state.account;
  const body = account.loggedIn ? `${accountIdentityHtml()}
      <section class="settings-account"><h2>\u4FEE\u6539\u5BC6\u7801</h2><p>\u5148\u9A8C\u8BC1\u65E7\u5BC6\u7801\uFF0C\u518D\u8BBE\u7F6E\u65B0\u5BC6\u7801\u3002</p>
        <form id="password-form" class="password-form">
          <label for="old-password">\u65E7\u5BC6\u7801</label><input id="old-password" type="password" autocomplete="current-password" required>
          <label for="new-password">\u65B0\u5BC6\u7801</label><input id="new-password" type="password" autocomplete="new-password" required>
          <p id="password-error" class="auth-error" role="alert" hidden></p><button type="submit">\u786E\u8BA4\u4FEE\u6539</button>
        </form></section>
      <section class="settings-account"><h2>\u540C\u6B65\u4E0E\u767B\u5F55</h2><button type="button" data-sync-now="1">\u7ACB\u5373\u540C\u6B65\u7247\u5355</button><button type="button" data-logout="1" aria-live="polite">\u9000\u51FA\u767B\u5F55</button></section>
      <section class="settings-account"><h2>\u626B\u7801\u767B\u5F55\u5176\u5B83\u8BBE\u5907</h2><p>\u7535\u89C6\u3001\u7535\u8111\u3001\u5E73\u677F\u767B\u5F55\u9875\u4E0A\u7684\u4E8C\u7EF4\u7801\u90FD\u80FD\u626B\uFF1A\u626B\u5B8C\u8FD9\u53F0\u624B\u673A\u7684\u8D26\u53F7\u4F1A\u76F4\u63A5\u540C\u6B65\u8FC7\u53BB\uFF0C\u4E0D\u7528\u6572\u5BC6\u7801\u3002</p><button type="button" data-qr-login="1">\u53BB\u626B\u7801\u767B\u5F55</button></section>` : `<section class="settings-account"><p>\u767B\u5F55\u540E\u53EF\u540C\u6B65\u6536\u85CF\u548C\u89C2\u770B\u5386\u53F2\uFF0C\u5E76\u7BA1\u7406\u5934\u50CF\u4E0E\u5BC6\u7801\u3002</p><button type="button" data-account-action="1">\u767B\u5F55\u6216\u6CE8\u518C</button></section>
      <section class="settings-account"><h2>\u626B\u7801\u767B\u5F55\u5176\u5B83\u8BBE\u5907</h2><p>\u7535\u89C6\u3001\u7535\u8111\u3001\u5E73\u677F\u767B\u5F55\u9875\u4E0A\u7684\u4E8C\u7EF4\u7801\u90FD\u80FD\u626B\uFF1A\u626B\u5B8C\u8FD9\u53F0\u624B\u673A\u7684\u8D26\u53F7\u4F1A\u76F4\u63A5\u540C\u6B65\u8FC7\u53BB\uFF0C\u4E0D\u7528\u6572\u5BC6\u7801\u3002</p><button type="button" data-qr-login="1">\u53BB\u626B\u7801\u767B\u5F55</button></section>`;
  return `<div class="appearance-pop account-pop" role="dialog" aria-modal="true" aria-labelledby="account-title">
    <div class="appearance-head"><h2 id="account-title">\u8D26\u53F7\u7BA1\u7406</h2><button type="button" class="appearance-close" data-account-close aria-label="\u5173\u95ED">\u2715</button></div>
    ${body}</div>`;
}
function ensureAccountPop() {
  if (accountPop && document.body.contains(accountPop)) return accountPop;
  accountPop = document.createElement("div");
  accountPop.className = "appearance-scrim";
  accountPop.hidden = true;
  accountPop.addEventListener("click", (event) => {
    if (event.target === accountPop || event.target.closest("[data-account-close]")) {
      closeAccountPop();
      return;
    }
  });
  document.body.appendChild(accountPop);
  return accountPop;
}
function openAccountPop() {
  ensureAccountPop();
  accountPop.innerHTML = buildAccountPopHtml();
  accountPop.hidden = false;
  document.body.classList.add("appearance-open");
}
function closeAccountPop() {
  if (!accountPop || accountPop.hidden) return;
  accountPop.hidden = true;
  document.body.classList.remove("appearance-open");
}
window.__veyraAccountBack = () => {
  if (accountPop && !accountPop.hidden) {
    closeAccountPop();
    return true;
  }
  return false;
};
window.__veyraAccountOpen = () => !!(accountPop && !accountPop.hidden);
function proxySummaryText() {
  const m = PROXY_MODE_NAMES[state.proxyMode] || "\u8D70\u540E\u7AEF\u8F6C\u53D1";
  return state.proxy ? `${m} \xB7 ${state.proxy}` : m;
}
function updateProxySummary() {
  const el = document.querySelector("[data-proxy-summary]");
  if (el) el.textContent = proxySummaryText();
}
var proxyPop = null;
function buildProxyPopHtml() {
  return `<div class="appearance-pop account-pop proxy-pop" role="dialog" aria-modal="true" aria-labelledby="proxy-title">
    <div class="appearance-head"><h2 id="proxy-title">\u9EC4\u679C\u7F51\u7EDC\u901A\u9053</h2><button type="button" class="appearance-close" data-proxy-close aria-label="\u5173\u95ED">\u2715</button></div>
    <p class="appearance-note">\u4EC5\u9EC4\u679C/\u79C1\u5BC6\u6A21\u5F0F\u751F\u6548\uFF0C\u7EA2\u679C\u6C38\u8FDC\u76F4\u8FDE\u4E0D\u53D7\u5F71\u54CD\uFF1B\u9009\u62E9\u540E\u7ACB\u5373\u751F\u6548\uFF0C\u65E0\u9700\u91CD\u542F\u3002</p>
    <div class="settings-storage">${privateMode() ? '<button type="button" data-return-public>\u8FD4\u56DE\u7EA2\u679C\uFF08\u516C\u5F00\u6A21\u5F0F\uFF09</button>' : '<button type="button" data-enter-private>\u8FDB\u5165\u79C1\u5BC6\u6A21\u5F0F</button>'}</div>
    <div class="proxy-test-row">
      <input id="proxy-address" class="settings-input" type="text" placeholder="\u4EE3\u7406\u5730\u5740 host:port\uFF0C\u5982 192.168.31.108:7893" value="${esc(state.proxy || "")}" autocomplete="off" aria-label="\u9EC4\u679C\u4EE3\u7406\u5730\u5740">
      <button type="button" id="proxy-test" class="proxy-test-btn">\u68C0\u6D4B</button>
    </div>
    <span id="proxy-test-result" class="proxy-test-result" hidden></span>
    <div class="proxy-mode-dd" id="proxy-mode-dd">
      <button type="button" class="proxy-mode-dd-btn" data-mode-toggle aria-haspopup="listbox" aria-expanded="false"><span id="proxy-mode-label">${esc(PROXY_MODE_NAMES[state.proxyMode] || "\u8D70\u540E\u7AEF\u8F6C\u53D1")}</span>${icon("arrow")}</button>
      <div class="proxy-mode-dd-menu" id="proxy-mode-menu" hidden>
        <button type="button" data-mode="1">\u4EC5\u76F4\u8FDE</button>
        <button type="button" data-mode="2">\u4EC5\u4EE3\u7406</button>
        <button type="button" data-mode="3">\u8D70\u540E\u7AEF\u8F6C\u53D1</button>
      </div>
    </div>
  </div>`;
}
function ensureProxyPop() {
  if (proxyPop && document.body.contains(proxyPop)) return proxyPop;
  proxyPop = document.createElement("div");
  proxyPop.className = "appearance-scrim";
  proxyPop.hidden = true;
  proxyPop.addEventListener("click", (event) => {
    if (event.target === proxyPop || event.target.closest("[data-proxy-close]")) {
      closeProxyPop();
      return;
    }
  });
  document.body.appendChild(proxyPop);
  return proxyPop;
}
function openProxyPop() {
  ensureProxyPop();
  proxyPop.innerHTML = buildProxyPopHtml();
  proxyPop.hidden = false;
  document.body.classList.add("appearance-open");
  api("get-proxy").then((value) => {
    state.proxy = value || "";
    const input2 = document.getElementById("proxy-address");
    if (input2) input2.value = state.proxy;
    updateProxySummary();
  }).catch(() => {
  });
  api("get-proxy-mode").then((value) => {
    setProxyModeLabel(Number(value) || 3);
  }).catch(() => {
  });
  const input = document.getElementById("proxy-address");
  if (input) input.addEventListener("change", () => {
    const value = input.value.trim();
    state.proxy = value;
    api("set-proxy", { value }).then(() => {
      toast("\u4EE3\u7406\u5730\u5740\u5DF2\u4FDD\u5B58");
      updateProxySummary();
    }).catch((error) => toast(error.message, true));
  });
  const testBtn = document.getElementById("proxy-test");
  const testResult = document.getElementById("proxy-test-result");
  if (testBtn && testResult) {
    testBtn.addEventListener("click", () => {
      testBtn.disabled = true;
      testBtn.textContent = "\u68C0\u6D4B\u4E2D\u2026";
      testResult.hidden = true;
      api("test-proxy").then((value) => {
        const v = value || {};
        testResult.textContent = `\u901A \xB7 ${Number(v.ms) || "?"}ms`;
        testResult.classList.remove("fail");
        testResult.classList.add("ok");
        testResult.hidden = false;
      }).catch((error) => {
        testResult.textContent = `\u4E0D\u901A\uFF1A${error.message}`;
        testResult.classList.remove("ok");
        testResult.classList.add("fail");
        testResult.hidden = false;
      }).finally(() => {
        testBtn.disabled = false;
        testBtn.textContent = "\u68C0\u6D4B";
      });
    });
  }
  initProxyModeDropdown();
}
function closeProxyPop() {
  if (!proxyPop || proxyPop.hidden) return;
  proxyPop.hidden = true;
  document.body.classList.remove("appearance-open");
}
window.__veyraProxyBack = () => {
  if (proxyPop && !proxyPop.hidden) {
    closeProxyPop();
    return true;
  }
  return false;
};
window.__veyraProxyOpen = () => !!(proxyPop && !proxyPop.hidden);
var aboutPop = null;
function buildAboutPopHtml() {
  return `<div class="appearance-pop account-pop" role="dialog" aria-modal="true" aria-labelledby="about-title">
    <div class="appearance-head"><h2 id="about-title">\u5173\u4E8E Veyra</h2><button type="button" class="appearance-close" data-about-close aria-label="\u5173\u95ED">\u2715</button></div>
    <p class="appearance-note">\u9879\u76EE\u5730\u5740\uFF1A<button type="button" class="settings-url" data-open-url="https://github.com/gybeyond1/Veyra">github.com/gybeyond1/Veyra</button> <button type="button" data-check-update>\u68C0\u67E5\u66F4\u65B0</button></p>
    <p class="appearance-note">Veyra \u57FA\u4E8E\u5F00\u6E90\u9879\u76EE\u4E8C\u6B21\u5F00\u53D1\uFF0C\u9075\u5FAA GPL-3.0 \u5F00\u6E90\u534F\u8BAE\u53D1\u5E03\uFF0C\u5B8C\u6574\u6E90\u7801\u3001\u81EA\u5EFA\u540E\u7AEF\u4E0E Docker \u90E8\u7F72\u8BF4\u660E\u89C1\u4ED3\u5E93\u3002</p>
  </div>`;
}
function ensureAboutPop() {
  if (aboutPop && document.body.contains(aboutPop)) return aboutPop;
  aboutPop = document.createElement("div");
  aboutPop.className = "appearance-scrim";
  aboutPop.hidden = true;
  aboutPop.addEventListener("click", (event) => {
    if (event.target === aboutPop || event.target.closest("[data-about-close]")) {
      closeAboutPop();
      return;
    }
  });
  document.body.appendChild(aboutPop);
  return aboutPop;
}
function openAboutPop() {
  ensureAboutPop();
  aboutPop.innerHTML = buildAboutPopHtml();
  aboutPop.hidden = false;
  document.body.classList.add("appearance-open");
}
function closeAboutPop() {
  if (!aboutPop || aboutPop.hidden) return;
  aboutPop.hidden = true;
  document.body.classList.remove("appearance-open");
}
window.__veyraAboutBack = () => {
  if (aboutPop && !aboutPop.hidden) {
    closeAboutPop();
    return true;
  }
  return false;
};
window.__veyraAboutOpen = () => !!(aboutPop && !aboutPop.hidden);
var REMOTE_TYPES = [["smb", "SMB"], ["webdav", "WebDAV"], ["ftp", "FTP"]];
let remoteServers = null;
let remoteEditing = null;
let remoteDraft = null;
let remoteTestText = "";
let remoteTestOk = false;
function remoteTypeName(type) {
  const hit = REMOTE_TYPES.find((t) => t[0] === type);
  return hit ? hit[1] : String(type || "").toUpperCase();
}
function remoteSummaryText() {
  const list = asArray(remoteServers);
  if (!list.length) return "\u672A\u914D\u7F6E \xB7 \u652F\u6301 SMB / WebDAV / FTP";
  if (list.length === 1) return `${list[0].name} \xB7 ${list[0].typeName || remoteTypeName(list[0].type)}`;
  return `${list.length} \u4E2A\u670D\u52A1\u5668 \xB7 ${list.slice(0, 2).map((s) => s.name).join("\u3001")}`;
}
async function loadRemoteServers(force) {
  if (remoteServers && !force) return remoteServers;
  try {
    remoteServers = asArray(await api("remote-list"));
  } catch (error) {
    if (!remoteServers) remoteServers = [];
  }
  const summary = document.querySelector("[data-remote-summary]");
  if (summary) summary.textContent = remoteSummaryText();
  return remoteServers;
}
var remotePop = null;
function remoteDraftOf(server) {
  const s = server || {};
  return {
    id: s.id || "",
    type: s.type || "smb",
    name: s.name || "",
    host: s.host || "",
    port: Number(s.port) || 0,
    share: s.share || "",
    path: s.path || "",
    user: s.user || "",
    pass: "",
    hasPass: !!s.hasPass,
    secure: !!s.secure,
    insecure: s.insecure !== false,
    cleanup: s.cleanup !== false
  };
}
function buildRemoteFormHtml() {
  const d = remoteDraft;
  const isSmb = d.type === "smb";
  const isWebdav = d.type === "webdav";
  const portHint = isSmb ? "445" : isWebdav ? d.secure ? "443" : "80" : d.secure ? "990" : "21";
  return `<div class="remote-types">${REMOTE_TYPES.map((t) => `<button type="button" data-remote-type="${t[0]}"${d.type === t[0] ? ' class="active"' : ""}>${t[1]}</button>`).join("")}</div>
    <div class="remote-row"><label class="remote-field"><span>\u5730\u5740</span><input id="remote-host" class="settings-input" type="text" placeholder="192.168.1.10" value="${esc(d.host)}" autocomplete="off" inputmode="url"></label>
      <label class="remote-field remote-field-port"><span>\u7AEF\u53E3</span><input id="remote-port" class="settings-input" type="text" placeholder="${portHint}" value="${d.port ? esc(String(d.port)) : ""}" inputmode="numeric"></label></div>
    ${isSmb ? `<div class="remote-row"><label class="remote-field"><span>\u5171\u4EAB\u540D</span><input id="remote-share" class="settings-input" type="text" placeholder="video" value="${esc(d.share)}" autocomplete="off"></label>
      <label class="remote-field"><span>\u76EE\u5F55\uFF08\u53EF\u9009\uFF09</span><input id="remote-path" class="settings-input" type="text" placeholder="/\u77ED\u5267" value="${esc(d.path)}" autocomplete="off"></label></div>` : `<label class="remote-field"><span>\u76EE\u5F55\uFF08\u53EF\u9009\uFF09</span><input id="remote-path" class="settings-input" type="text" placeholder="/\u77ED\u5267" value="${esc(d.path)}" autocomplete="off"></label>`}
    <div class="remote-row"><label class="remote-field"><span>\u7528\u6237\u540D\uFF08\u53EF\u9009\uFF09</span><input id="remote-user" class="settings-input" type="text" value="${esc(d.user)}" autocomplete="off"></label>
      <label class="remote-field"><span>\u5BC6\u7801${d.hasPass ? "\uFF08\u5DF2\u5B58\uFF0C\u7559\u7A7A\u4E0D\u6539\uFF09" : "\uFF08\u53EF\u9009\uFF09"}</span><input id="remote-pass" class="settings-input" type="password" placeholder="${d.hasPass ? "\u2022\u2022\u2022\u2022\u2022\u2022" : ""}" autocomplete="new-password"></label></div>
    <label class="remote-field"><span>\u663E\u793A\u540D\u79F0\uFF08\u53EF\u9009\uFF09</span><input id="remote-name" class="settings-input" type="text" placeholder="\u5BA2\u5385 NAS" value="${esc(d.name)}" autocomplete="off"></label>
    ${isSmb ? "" : `<label class="remote-check"><input id="remote-secure" type="checkbox"${d.secure ? " checked" : ""}><span>${isWebdav ? "\u4F7F\u7528 HTTPS" : "\u4F7F\u7528 FTPS\uFF08\u663E\u5F0F TLS\uFF09"}</span></label>`}
    ${isSmb ? "" : `<label class="remote-check"><input id="remote-insecure" type="checkbox"${d.insecure ? " checked" : ""}><span>\u5FFD\u7565\u8BC1\u4E66\u6821\u9A8C\uFF08\u5BB6\u7528 NAS \u5E38\u662F\u81EA\u7B7E\u8BC1\u4E66\uFF09</span></label>`}
    <label class="remote-check"><input id="remote-cleanup" type="checkbox"${d.cleanup ? " checked" : ""}><span>\u4F20\u5B8C\u5220\u672C\u5730\uFF08\u5927\u5C0F\u5BF9\u4E0D\u4E0A\u4F1A\u4FDD\u7559\uFF09</span></label>
    <div class="remote-test-row"><button type="button" class="remote-secondary" data-remote-test>\u6D4B\u8BD5\u8FDE\u63A5</button><span class="remote-test-result ${remoteTestOk ? "ok" : "fail"}" data-remote-result${remoteTestText ? "" : " hidden"}>${esc(remoteTestText)}</span></div>
    <div class="remote-actions">
      <button type="button" class="remote-secondary" data-remote-cancel>\u8FD4\u56DE</button>
      ${d.id ? '<button type="button" class="remote-danger" data-remote-delete="1">\u5220\u9664</button>' : ""}
      <button type="button" class="remote-primary" data-remote-save>\u4FDD\u5B58</button>
    </div>`;
}
function buildRemoteListHtml() {
  const list = asArray(remoteServers);
  if (!list.length) {
    return `<p class="appearance-note">\u8FD8\u6CA1\u6709\u670D\u52A1\u5668\u3002\u6DFB\u52A0\u540E\uFF0C\u4E0B\u8F7D\u5B8C\u6210\u7684\u5267\u4F1A\u6309\u5267\u540D\u5728\u670D\u52A1\u5668\u4E0A\u5EFA\u540C\u540D\u6587\u4EF6\u5939\uFF0C\u628A\u6210\u54C1\u653E\u8FDB\u53BB\u3002</p>
      <div class="remote-actions"><button type="button" class="remote-primary" data-remote-add>\u6DFB\u52A0\u670D\u52A1\u5668</button></div>`;
  }
  return `<p class="appearance-note">\u652F\u6301 SMB\uFF08Windows \u5171\u4EAB / NAS\uFF09\u3001WebDAV\u3001FTP\u3002\u70B9\u6761\u76EE\u53EF\u4FEE\u6539\u3002</p>
    <div class="remote-list">${list.map((s) => `<button type="button" class="remote-item" data-remote-edit="${esc(s.id)}">
        <span class="remote-item-main"><strong>${esc(s.name)}</strong><small>${esc(s.typeName || remoteTypeName(s.type))} \xB7 ${esc(s.address || "")}${s.cleanup === false ? " \xB7 \u672C\u5730\u4FDD\u7559" : " \xB7 \u4F20\u5B8C\u5220\u672C\u5730"}</small></span>
        ${icon("arrow")}
      </button>`).join("")}</div>
    <div class="remote-actions"><button type="button" class="remote-primary" data-remote-add>\u6DFB\u52A0\u670D\u52A1\u5668</button></div>`;
}
function renderRemotePop() {
  if (!remotePop) return;
  const editing = remoteEditing;
  const title = editing === null ? "\u8FDC\u7A0B\u670D\u52A1\u5668" : editing ? "\u7F16\u8F91\u670D\u52A1\u5668" : "\u6DFB\u52A0\u670D\u52A1\u5668";
  remotePop.innerHTML = `<div class="appearance-pop account-pop remote-pop" role="dialog" aria-modal="true" aria-labelledby="remote-title">
    <div class="appearance-head"><h2 id="remote-title">${title}</h2><button type="button" class="appearance-close" data-remote-close aria-label="\u5173\u95ED">\u2715</button></div>
    ${editing === null ? buildRemoteListHtml() : buildRemoteFormHtml()}
  </div>`;
}
function ensureRemotePop() {
  if (remotePop && document.body.contains(remotePop)) return remotePop;
  remotePop = document.createElement("div");
  remotePop.className = "appearance-scrim";
  remotePop.hidden = true;
  remotePop.addEventListener("click", (event) => {
    if (event.target === remotePop || event.target.closest("[data-remote-close]")) {
      closeRemotePop();
      return;
    }
  });
  document.body.appendChild(remotePop);
  return remotePop;
}
async function openRemotePop() {
  ensureRemotePop();
  remoteEditing = null;
  remoteDraft = null;
  remoteTestText = "";
  remoteTestOk = false;
  remotePop.hidden = false;
  document.body.classList.add("appearance-open");
  await loadRemoteServers(true);
  renderRemotePop();
  updateBackEnabled();
}
function closeRemotePop() {
  if (!remotePop || remotePop.hidden) return;
  remotePop.hidden = true;
  document.body.classList.remove("appearance-open");
  remoteEditing = null;
  remoteDraft = null;
  updateBackEnabled();
}
window.__veyraRemoteBack = () => {
  if (!remotePop || remotePop.hidden) return false;
  if (remoteEditing !== null) {
    remoteEditing = null;
    renderRemotePop();
    return true;
  }
  closeRemotePop();
  return true;
};
window.__veyraRemoteOpen = () => !!(remotePop && !remotePop.hidden);
function readRemoteForm() {
  const value = (id) => {
    const el = document.getElementById(id);
    return el ? String(el.value || "").trim() : "";
  };
  const checked = (id) => {
    const el = document.getElementById(id);
    return !!(el && el.checked);
  };
  const isSmb = remoteDraft.type === "smb";
  return {
    id: remoteDraft.id || "",
    type: remoteDraft.type,
    name: value("remote-name"),
    host: value("remote-host"),
    port: Number(value("remote-port")) || 0,
    share: isSmb ? value("remote-share") : "",
    path: value("remote-path"),
    user: value("remote-user"),
    pass: value("remote-pass"),
    secure: isSmb ? false : checked("remote-secure"),
    insecure: isSmb ? true : checked("remote-insecure"),
    cleanup: checked("remote-cleanup")
  };
}
function stashRemoteForm() {
  if (remoteEditing === null || !remoteDraft) return;
  const form = readRemoteForm();
  remoteDraft = Object.assign({}, remoteDraft, form, { hasPass: remoteDraft.hasPass || !!remoteDraft.pass });
}
async function saveRemoteForm() {
  const server = readRemoteForm();
  if (!server.host) {
    toast("\u8BF7\u586B\u5199\u670D\u52A1\u5668\u5730\u5740", true);
    return;
  }
  if (server.type === "smb" && !server.share) {
    toast("\u8BF7\u586B\u5199\u5171\u4EAB\u6587\u4EF6\u5939\u540D", true);
    return;
  }
  try {
    await api("remote-save", { server });
    remoteServers = null;
    await loadRemoteServers(true);
    remoteEditing = null;
    remoteDraft = null;
    remoteTestText = "";
    renderRemotePop();
    toast("\u670D\u52A1\u5668\u5DF2\u4FDD\u5B58");
  } catch (error) {
    toast(error.message, true);
  }
}
async function testRemoteForm(button) {
  const server = readRemoteForm();
  const result = remotePop && remotePop.querySelector("[data-remote-result]");
  if (!server.host) {
    toast("\u8BF7\u586B\u5199\u670D\u52A1\u5668\u5730\u5740", true);
    return;
  }
  if (button) {
    button.disabled = true;
    button.textContent = "\u6D4B\u8BD5\u4E2D\u2026";
  }
  remoteTestText = "";
  if (result) result.hidden = true;
  try {
    const info = await api("remote-test", { server });
    remoteTestOk = true;
    remoteTestText = `\u8FDE\u63A5\u6B63\u5E38 \xB7 ${Number(info && info.ms) || 0}ms`;
    toast(`\u8FDE\u63A5\u6210\u529F\uFF1A${info && info.address || server.host}`);
  } catch (error) {
    remoteTestOk = false;
    remoteTestText = `\u8FDE\u63A5\u5931\u8D25\uFF1A${error.message}`;
    toast(`\u8FDE\u63A5\u5931\u8D25\uFF1A${error.message}`, true);
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "\u6D4B\u8BD5\u8FDE\u63A5";
    }
    if (result) {
      result.textContent = remoteTestText;
      result.classList.toggle("ok", remoteTestOk);
      result.classList.toggle("fail", !remoteTestOk);
      result.hidden = !remoteTestText;
    }
  }
}
var remotePicker = null;
let remotePickerTaskId = "";
function ensureRemotePicker() {
  if (remotePicker && document.body.contains(remotePicker)) return remotePicker;
  remotePicker = document.createElement("div");
  remotePicker.className = "appearance-scrim";
  remotePicker.hidden = true;
  remotePicker.addEventListener("click", (event) => {
    if (event.target === remotePicker || event.target.closest("[data-remote-pick-close]")) closeRemotePicker();
  });
  document.body.appendChild(remotePicker);
  return remotePicker;
}
async function openRemotePicker(taskId, title) {
  await loadRemoteServers(true);
  const list = asArray(remoteServers);
  if (!list.length) {
    toast("\u8FD8\u6CA1\u6709\u8FDC\u7A0B\u670D\u52A1\u5668\uFF0C\u8BF7\u5148\u5230\u300C\u8BBE\u7F6E \u2192 \u8FDC\u7A0B\u670D\u52A1\u5668\u300D\u6DFB\u52A0", true);
    return;
  }
  ensureRemotePicker();
  remotePickerTaskId = String(taskId);
  remotePicker.innerHTML = `<div class="appearance-pop account-pop remote-pop" role="dialog" aria-modal="true" aria-labelledby="remote-pick-title">
    <div class="appearance-head"><h2 id="remote-pick-title">\u4F20\u5230\u8FDC\u7A0B\u670D\u52A1\u5668</h2><button type="button" class="appearance-close" data-remote-pick-close aria-label="\u5173\u95ED">\u2715</button></div>
    <p class="appearance-note">\u300A${esc(title || "\u8FD9\u90E8")}\u300B\u4F1A\u5728\u670D\u52A1\u5668\u4E0A\u5EFA\u540C\u540D\u6587\u4EF6\u5939\uFF0C\u6210\u54C1\u76F4\u63A5\u653E\u8FDB\u53BB\u3002</p>
    <div class="remote-list">${list.map((s) => `<button type="button" class="remote-item" data-remote-pick="${esc(s.id)}">
        <span class="remote-item-main"><strong>${esc(s.name)}</strong><small>${esc(s.typeName || remoteTypeName(s.type))} \xB7 ${esc(s.address || "")}${s.cleanup === false ? " \xB7 \u672C\u5730\u4FDD\u7559" : " \xB7 \u4F20\u5B8C\u5220\u672C\u5730"}</small></span>
        ${icon("arrow")}
      </button>`).join("")}</div>
  </div>`;
  remotePicker.hidden = false;
  document.body.classList.add("appearance-open");
  updateBackEnabled();
}
function closeRemotePicker() {
  if (!remotePicker || remotePicker.hidden) return;
  remotePicker.hidden = true;
  document.body.classList.remove("appearance-open");
  remotePickerTaskId = "";
  updateBackEnabled();
}
window.__veyraRemotePickBack = () => {
  if (remotePicker && !remotePicker.hidden) {
    closeRemotePicker();
    return true;
  }
  return false;
};
window.__veyraRemotePickOpen = () => !!(remotePicker && !remotePicker.hidden);
async function startRemoteTransfer(taskId, remoteId) {
  try {
    const job = await api("remote-transfer-start", { taskId, remoteId });
    const name = job && job.serverName || "\u8FDC\u7A0B\u670D\u52A1\u5668";
    toast(`\u5DF2\u5F00\u59CB\u4F20\u8F93\u5230 ${name}`);
    closeRemotePicker();
    await loadRemoteJobs();
    if (state.route === "library" && state.libraryTab === "downloads") renderLibraryDownloads();
    else if (state.route === "downloads") refreshDownloads(routeToken, true);
  } catch (error) {
    toast(error.message || "\u4F20\u8F93\u5931\u8D25", true);
  }
}
function renderSearch() {
  var _a2;
  const filters = privateMode() ? [["all", "\u5168\u90E8"], ["ai-duanju", "\u6210\u4EBA\u77ED\u5267"], ["ai-manju", "\u6210\u4EBA\u6F2B\u5267"], ["ai-huanlian", "AI\u6362\u8138"], ["ai-mogai", "AI\u9B54\u6539"]] : [["all", "\u5168\u90E8"], ["short", "\u77ED\u5267"], ["comic", "\u6F2B\u5267"]];
  const all = asArray((_a2 = state.search) == null ? void 0 : _a2.items);
  const items = state.filter === "all" ? all : all.filter((item) => {
    if (item.category) return item.category === state.filter;
    const title = String(item.title || "");
    if (state.filter === "ai-huanlian") return /AI\s*换脸/.test(title);
    if (state.filter === "ai-mogai") return /AI\s*魔改/.test(title);
    if (state.filter === "ai-manju") return /漫剧/.test(title);
    return !/AI\s*(换脸|魔改)|漫剧/.test(title);
  });
  const { blocks, singles } = seriesGroups(items);
  const cards = [...blocks.map(seriesBlock), ...singles.map(itemCard)].join("");
  content.innerHTML = `<div class="search-page"><h1>\u641C\u7D22\u7ED3\u679C</h1><p>${esc(state.query)} \xB7 ${items.length} \u90E8\u4F5C\u54C1</p>${searchFeedback()}<div class="filter-row">${filters.map(([id, label]) => `<button type="button" data-filter="${id}" class="${state.filter === id ? "active" : ""}">${label}</button>`).join("")}</div>
    ${items.length ? `<div class="search-grid">${cards}</div>` : '<div class="empty-state">\u6CA1\u6709\u627E\u5230\u5339\u914D\u7684\u5F71\u7247</div>'}</div>`;
  hydrateImages();
}
function seriesGroups(items) {
  const groups = /* @__PURE__ */ new Map();
  const singles = [];
  for (const item of items) {
    const aid = item.albumId;
    if (aid && aid !== "0") {
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
    const lead = seasons.find((it) => Number(it.seasonIndex) === 1) || seasons[0];
    blocks.push({ aid, title: (lead == null ? void 0 : lead.title) || "\u7CFB\u5217", cover: (lead == null ? void 0 : lead.cover) || "", seasons });
  }
  blocks.sort((a, b) => String(a.title).localeCompare(String(b.title), "zh"));
  return { blocks, singles };
}
function seriesBlock(group) {
  const head = esc(group.title || "\u7CFB\u5217");
  return `<section class="series-block" data-album="${esc(group.aid)}">
    <div class="series-head"><span class="poster loading small"><img data-cover="${esc(group.cover || "")}" alt=""></span>
    <div class="series-meta"><h3>${head}</h3><span>\u5B98\u65B9\u7CFB\u5217 \xB7 ${group.seasons.length} \u5B63</span></div></div>
    <div class="series-row">${group.seasons.map(itemCard).join("")}</div></section>`;
}
function listingFooter() {
  const listing = state.listing;
  if (listing.error) return '<button type="button" data-retry-listing="1">\u52A0\u8F7D\u5931\u8D25\uFF0C\u70B9\u51FB\u91CD\u8BD5</button>';
  if (listing.loading) return '<span role="status">\u6B63\u5728\u52A0\u8F7D\u66F4\u591A\u2026</span>';
  if (listing.refreshing) return '<span role="status">\u6B63\u5728\u66F4\u65B0\u5217\u8868\u2026</span>';
  if (listing.nextPage) return listing.kind === "tag-list" ? '<span class="listing-sentinel" aria-hidden="true"></span>' : '<span class="listing-sentinel">\u7EE7\u7EED\u4E0B\u6ED1\u52A0\u8F7D\u66F4\u591A</span>';
  return "<span>\u5DF2\u7ECF\u5230\u5E95\u4E86</span>";
}
function observeListingEnd() {
  var _a2;
  listingObserver == null ? void 0 : listingObserver.disconnect();
  if (state.route !== "listing" || !((_a2 = state.listing) == null ? void 0 : _a2.nextPage) || state.listing.loading || state.listing.refreshing || state.listing.error) return;
  const sentinel = content.querySelector(".listing-sentinel");
  if (!sentinel) return;
  if (!listingObserver) {
    listingObserver = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) loadMoreListing();
    }, { root: scroll, rootMargin: "0px 0px 320px 0px" });
  }
  listingObserver.observe(sentinel);
}
function updateListingFooter() {
  const footer = content.querySelector(".listing-footer");
  if (!footer) return;
  footer.innerHTML = listingFooter();
  observeListingEnd();
}
function renderListing() {
  var _a2, _b2;
  const listing = state.listing;
  if (!(listing == null ? void 0 : listing.items.length) && (listing == null ? void 0 : listing.refreshing)) {
    renderSkeleton();
    return;
  }
  const tagName = String(listing.label || listing.slug).replace(/^#+/, "");
  const tagTitle = privateMode() ? `#${tagName}` : `${((_a2 = listing.slug) == null ? void 0 : _a2.startsWith("comic:")) ? "\u6F2B\u5267" : "\u77ED\u5267"} \xB7 ${tagName}`;
  const title = listing.kind === "tag-list" ? tagTitle : listing.kind === "recommend" ? "\u7CBE\u9009\u63A8\u8350" : privateMode() ? "\u6700\u8FD1\u4E0A\u65B0" : "\u70ED\u95E8\u6F2B\u5267";
  const backLabel = listing.kind === "tag-list" && ((_b2 = state.listingReturn) == null ? void 0 : _b2.route) === "tags" ? "\u8FD4\u56DE\u5168\u90E8\u7C7B\u578B" : "\u8FD4\u56DE\u9996\u9875";
  content.innerHTML = `<div class="listing-page"><button class="listing-back" type="button" data-back="1">${icon("back")} ${backLabel}</button>
    <h1>${esc(title)}</h1><p>\u5DF2\u663E\u793A ${listing.items.length} \u90E8\u4F5C\u54C1</p>
    ${listing.items.length ? `<div class="search-grid listing-grid">${listing.items.map(itemCard).join("")}</div>` : '<div class="empty-state">\u8FD9\u4E2A\u6807\u7B7E\u4E0B\u6682\u65E0\u4F5C\u54C1</div>'}
    <div class="listing-footer">${listingFooter()}</div></div>`;
  hydrateImages();
  observeListingEnd();
}
function renderDetail() {
  var _a2, _b2;
  const data = state.detail;
  if (!data) {
    renderSkeleton();
    return;
  }
  const loading = state.detailLoading;
  (_b2 = (_a2 = window.AndroidHost) == null ? void 0 : _a2.setDetailMode) == null ? void 0 : _b2.call(_a2, true);
  const episodes = asArray(data.episodes);
  content.innerHTML = `<div class="detail-page"><button class="detail-back" type="button" data-back="1">${icon("back")} \u8FD4\u56DE</button>
    <div class="detail-art"><img data-cover="${esc(data.cover)}" alt=""></div><div class="detail-copy"><h1>${esc(data.title)}</h1><p>${loading ? "\u6B63\u5728\u83B7\u53D6\u5185\u5BB9\u2026" : `${esc(data.score)} ${esc(data.episodeLabel)}`}</p><div class="detail-desc-wrap"><p class="detail-description">${esc(data.description || "")}</p></div>
    <div class="detail-buttons"><button class="detail-play" type="button" data-play="1" ${loading ? "disabled" : ""}>${loading ? "\u6B63\u5728\u52A0\u8F7D\u2026" : resumeLabel()}</button><button class="detail-restart" type="button" data-restart="1" aria-label="\u4ECE\u5934\u64AD\u653E" title="\u4ECE\u5934\u64AD\u653E" ${resumeReady() ? "" : "hidden"}>${icon("restart")}</button><button class="bookmark-button" type="button" data-bookmark="1" aria-label="${state.bookmarked ? "\u53D6\u6D88\u6536\u85CF" : "\u6536\u85CF"}" ${loading ? "disabled" : ""}>${state.bookmarked ? "\u2605" : "\u2606"}</button><button class="detail-download" type="button" data-download="1" ${loading ? "disabled" : ""}>\u4E0B\u8F7D</button></div>
    ${loading ? '<div class="detail-loading" role="status">\u6B63\u5728\u83B7\u53D6\u9009\u96C6\u2026</div>' : episodes.length ? `<h2>\u9009\u96C6</h2><div class="episode-grid">${episodes.map((item, index) => `<button type="button" data-episode="${item.number}" class="${index === 0 ? "active" : ""}">${item.number}</button>`).join("")}</div>` : ""}</div></div>`;
  hydrateImages();
  ensureDetailFilled();
}
function ensureDetailFilled() {
  const scrollEl = document.getElementById("scroll");
  const page = content.querySelector(".detail-page");
  if (!page) return;
  if (scrollEl && getComputedStyle(scrollEl).display === "none") scrollEl.style.removeProperty("display");
  const fit = () => {
    if (!page.isConnected) return;
    const need = window.innerHeight || document.documentElement.clientHeight || 0;
    if (need <= 0) return;
    if (page.getBoundingClientRect().height < need - 2) {
      page.style.minHeight = need + "px";
      if (getComputedStyle(page).backgroundColor === "rgba(0, 0, 0, 0)") page.style.backgroundColor = "var(--bg)";
    } else if (page.style.minHeight) {
      page.style.removeProperty("min-height");
      page.style.removeProperty("background-color");
    }
  };
  fit();
  requestAnimationFrame(fit);
}
function searchFeedback() {
  if (state.searchPending) return '<div class="search-feedback" role="status" aria-live="polite"><span class="search-spinner" aria-hidden="true"></span><span>\u6B63\u5728\u66F4\u65B0\u641C\u7D22\u7ED3\u679C\u2026</span></div>';
  if (state.searchError) return `<div class="search-feedback search-feedback--error" role="status"><span>\u66F4\u65B0\u5931\u8D25\uFF0C\u5F53\u524D\u663E\u793A\u7F13\u5B58\u7ED3\u679C</span><button type="button" data-retry="search">\u91CD\u8BD5</button></div>`;
  return "";
}
function renderSearchLoading() {
  content.innerHTML = `<section class="search-loading" role="status" aria-live="polite" aria-busy="true"><span class="search-spinner search-spinner--large" aria-hidden="true"></span><h1>\u6B63\u5728\u641C\u7D22\u2026</h1><p>${esc(state.query)}</p></section>`;
}
function renderSkeleton() {
  content.innerHTML = '<div class="skeleton-home" role="status" aria-label="\u6B63\u5728\u52A0\u8F7D\u5185\u5BB9"><div class="skeleton skeleton-hero"></div><div class="skeleton skeleton-title"></div><div class="skeleton-row"><div class="skeleton skeleton-poster"></div><div class="skeleton skeleton-poster"></div><div class="skeleton skeleton-poster"></div></div><div class="skeleton skeleton-line"></div></div>';
}
function renderError(error, retry) {
  var _a2, _b2;
  if (state.route === "detail") (_b2 = (_a2 = window.AndroidHost) == null ? void 0 : _a2.setDetailMode) == null ? void 0 : _b2.call(_a2, false);
  if (/站点连接失败|站点请求失败|failed to connect|unable to resolve host|unknownhost|connectexception|sockettimeoutexception|timed? out|network is unreachable|connection reset|connection refused|网络|连接失败|无法连接/i.test((error == null ? void 0 : error.message) || "")) {
    content.innerHTML = `<div class="error-state error-state--network" role="alert">
      <div class="error-main">
        <svg class="error-icon" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="24" cy="24" r="21"/><path d="m12 24 6-5 6 5 6-5 6 5"/></svg>
        <h1>\u7F51\u7EDC\u8D70\u4E22\u4E86</h1>
      </div>
      <div class="error-footer"><p>\u8BF7\u5C1D\u8BD5\u4F7F\u7528\u4EE3\u7406\u7F51\u7EDC\uFF0C\u6216\u8054\u7CFB\u5F00\u53D1\u8005\u3002</p><button type="button" data-retry="${esc(retry)}">\u91CD\u65B0\u5C1D\u8BD5</button></div>
    </div>`;
    return;
  }
  content.innerHTML = `<div class="error-state">${esc(error.message || "\u52A0\u8F7D\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5")}<button type="button" data-retry="${esc(retry)}">\u91CD\u8BD5</button></div>`;
}
function rememberScreen() {
  if (state.route === "detail") return;
  const previewContent = content.cloneNode(true);
  previewContent.removeAttribute("id");
  screenSnapshots[state.route] = {
    content: previewContent,
    scrollTop: scroll.scrollTop,
    horizontalScroll: [...content.querySelectorAll(".film-row,.filter-row,.home-tag-scroll")].map((row) => row.scrollLeft)
  };
}
function captureScreen() {
  rememberScreen();
  return {
    route: state.route,
    tab: state.tab,
    pageNode: content.firstElementChild,
    scrollTop: scroll.scrollTop,
    searchValue: searchInput.value,
    listing: state.route === "listing" ? state.listing : null,
    listingReturn: state.listingReturn,
    tagsReturn: state.tagsReturn,
    compactHeld: state.compactHeld,
    horizontalScroll: [...content.querySelectorAll(".film-row,.filter-row,.home-tag-scroll")].map((row) => row.scrollLeft)
  };
}
function restoreScreen(snapshot) {
  if (!(snapshot == null ? void 0 : snapshot.pageNode)) {
    goHome();
    return;
  }
  ++routeToken;
  listingObserver == null ? void 0 : listingObserver.disconnect();
  categoryObserver == null ? void 0 : categoryObserver.disconnect();
  setRoute(snapshot.route);
  state.tab = snapshot.tab;
  state.compactHeld = snapshot.compactHeld;
  if (snapshot.listing) state.listing = snapshot.listing;
  state.listingReturn = snapshot.listingReturn;
  state.tagsReturn = snapshot.tagsReturn;
  content.replaceChildren(snapshot.pageNode);
  if (snapshot.route === "home") refreshHomeHistory();
  if (snapshot.route === "library") renderLibrary();
  if (snapshot.route === "settings") renderSettings();
  searchInput.value = snapshot.searchValue || "";
  document.querySelectorAll("#dock [data-nav]").forEach((button) => button.classList.toggle("active", button.dataset.nav === state.tab));
  scroll.scrollTop = snapshot.scrollTop || 0;
  content.querySelectorAll(".film-row,.filter-row,.home-tag-scroll").forEach((row, index) => {
    var _a2;
    row.scrollLeft = ((_a2 = snapshot.horizontalScroll) == null ? void 0 : _a2[index]) || 0;
  });
  hydrateImages();
  if (isBannerRoute()) {
    restoreBannerIndex();
    scheduleBannerAuto();
  }
  if (snapshot.route === "category") {
    compact.innerHTML = compactMarkup();
    updateCompact();
    observeCategoryEnd();
  }
  if (snapshot.route === "listing") observeListingEnd();
}
function updateBackEnabled() {
  var _a2;
  const modalOpen = [unlockOverlay, authOverlay, confirmOverlay, updateOverlay, downloadOverlay].some((overlay) => !overlay.hidden);
  (_a2 = window.AndroidHost) == null ? void 0 : _a2.setBackEnabled(modalOpen || !isRootColumn());
}
function setRoute(route) {
  var _a2, _b2, _c2, _d2;
  stopBannerAuto();
  if (route !== "downloads") stopDownloadsTimer();
  if (state.route === "detail" && route !== "detail") {
    detailCard == null ? void 0 : detailCard.dispose();
    detailCard = null;
  }
  const libraryArea = ["library", "settings", "account-management"].includes(route);
  if (state.route === "library" && route !== "library") searchInput.value = "";
  state.route = route;
  (_a2 = window.hgScheduleResourceApply) == null ? void 0 : _a2.call(window);
  document.getElementById("app").dataset.route = route;
  (_b2 = window.hgThemeRefresh) == null ? void 0 : _b2.call(window);
  document.getElementById("app").classList.toggle("route-detail", route === "detail");
  (_d2 = (_c2 = window.AndroidHost) == null ? void 0 : _c2.setDetailMode) == null ? void 0 : _d2.call(_c2, route === "detail");
  headerSettings.hidden = route !== "library";
  window.__bingeSync && window.__bingeSync();
  searchInput.placeholder = libraryArea ? "\u641C\u7D22\u89C2\u770B\u5386\u53F2\u548C\u6536\u85CF" : privateMode() ? "\u641C\u7D22\u5267\u540D\u6216 #\u6807\u7B7E" : "\u641C\u7D22\u5267\u540D";
  searchInput.setAttribute("aria-label", libraryArea ? "\u641C\u7D22\u89C2\u770B\u5386\u53F2\u548C\u6536\u85CF" : "\u641C\u7D22\u5267\u540D\u6216\u6807\u7B7E");
  if (route === "library") searchInput.value = state.libraryQuery;
  updateBackEnabled();
  if (["home", "category", "library"].includes(route)) scheduleSwipePrefetch();
}
let swipePrefetchTimer = 0;
function scheduleSwipePrefetch(delay = 260) {
  clearTimeout(swipePrefetchTimer);
  swipePrefetchTimer = setTimeout(() => {
    if (document.hidden || swiping || swipeTrack) return;
    swipePrefetchAll().catch(() => {
    });
  }, delay);
}
function isRootColumn() {
  return ["home", "category", "library"].includes(state.route);
}
function backDestination() {
  var _a2, _b2, _c2, _d2, _e, _f, _g, _h;
  if (isRootColumn()) return null;
  if (state.route === "campaign") return ((_a2 = state.campaignReturn) == null ? void 0 : _a2.route) || "home";
  if (state.route === "detail") return ((_b2 = state.previous) == null ? void 0 : _b2.route) || "home";
  if (state.route === "account-management") return ((_c2 = state.accountReturn) == null ? void 0 : _c2.route) || "settings";
  if (state.route === "downloads") return ((_d2 = state.settingsReturn) == null ? void 0 : _d2.route) || "settings";
  if (state.route === "settings") return ((_e = state.settingsReturn) == null ? void 0 : _e.route) || "library";
  if (state.route === "tags") return ((_f = state.tagsReturn) == null ? void 0 : _f.route) || "home";
  if (state.route === "listing" && ((_g = state.listing) == null ? void 0 : _g.kind) === "tag-list") return ((_h = state.listingReturn) == null ? void 0 : _h.route) || "home";
  return state.route === "home" ? null : "home";
}
let bingePreviewClass = false;
function clearPredictivePreview() {
  clearTimeout(predictiveTimer);
  if (predictiveFrame) cancelAnimationFrame(predictiveFrame);
  predictiveFrame = null;
  if (predictiveSourceNode && (predictivePreview == null ? void 0 : predictivePreview.contains(predictiveSourceNode))) predictiveSourceNode.remove();
  predictiveSourceNode = null;
  predictivePreview == null ? void 0 : predictivePreview.remove();
  predictivePreview = null;
  document.getElementById("app").classList.remove("predictive-active", "binge-preview");
  document.body.classList.remove("binge-preview");
  if (bingePreviewClass) {
    bingePreviewClass = false;
    document.getElementById("app").classList.remove("binge");
    window.__bingeSync && window.__bingeSync();
  }
  scroll.style.removeProperty("transition");
  scroll.style.removeProperty("transform");
}
window.hgPredictiveBackStart = (fromRight) => {
  var _a2, _b2, _c2, _d2;
  clearPredictivePreview();
  if (!downloadOverlay.hidden || window.__veyraAppearanceOpen && window.__veyraAppearanceOpen() || window.__veyraAccountOpen && window.__veyraAccountOpen() || window.__veyraProxyOpen && window.__veyraProxyOpen() || window.__veyraAboutOpen && window.__veyraAboutOpen() || window.__veyraRemoteOpen && window.__veyraRemoteOpen() || window.__veyraRemotePickOpen && window.__veyraRemotePickOpen()) return false;
  if (state.route === "detail" && detailCard && authOverlay.hidden && confirmOverlay.hidden && updateOverlay.hidden && unlockOverlay.hidden) {
    detailCard.fromRight = fromRight;
    return detailCard.begin();
  }
  const destination = backDestination();
  if (state.route === "detail" && destination === "home" && state.binge) {
    const preview2 = document.createElement("div");
    preview2.className = "back-preview back-preview-binge";
    preview2.setAttribute("aria-hidden", "true");
    const layer = (_a2 = document.getElementById("binge")) == null ? void 0 : _a2.cloneNode(true);
    const dock = (_b2 = document.getElementById("dock")) == null ? void 0 : _b2.cloneNode(true);
    const fab = (_c2 = document.getElementById("binge-fab")) == null ? void 0 : _c2.cloneNode(true);
    if (layer) {
      layer.hidden = false;
      preview2.appendChild(layer);
    }
    if (dock) preview2.appendChild(dock);
    if (fab) {
      fab.hidden = false;
      preview2.appendChild(fab);
    }
    const app = document.getElementById("app");
    app.appendChild(preview2);
    app.classList.add("predictive-active", "binge-preview");
    if (!app.classList.contains("binge")) {
      app.classList.add("binge");
      bingePreviewClass = true;
    }
    document.body.classList.add("binge-preview");
    scroll.style.transition = "none";
    predictivePreview = preview2;
    predictivePreview.fromRight = fromRight;
    return true;
  }
  const fromDetail = state.route === "detail" && ((_d2 = state.previous) == null ? void 0 : _d2.route) === destination && state.previous.pageNode;
  const snapshot = fromDetail ? state.previous : screenSnapshots[destination];
  if (!snapshot) return false;
  const preview = document.createElement("div");
  preview.className = "back-preview";
  preview.setAttribute("aria-hidden", "true");
  if (state.route === "detail" || state.route === "settings") {
    const header = document.querySelector("#app > .app-top").cloneNode(true);
    const settings = header.querySelector(".header-settings");
    settings.hidden = destination !== "library";
    if (destination === "library") {
      const input = header.querySelector(".search-input");
      input.placeholder = "\u641C\u7D22\u89C2\u770B\u5386\u53F2\u548C\u6536\u85CF";
      input.value = state.libraryQuery;
    }
    header.querySelectorAll("[id]").forEach((node) => node.removeAttribute("id"));
    preview.appendChild(header);
  }
  if (fromDetail) {
    const holder = document.createElement("div");
    holder.style.transform = `translateY(${-snapshot.scrollTop}px)`;
    predictiveSourceNode = snapshot.pageNode;
    holder.appendChild(predictiveSourceNode);
    preview.appendChild(holder);
  } else {
    predictiveSourceNode = snapshot.content;
    predictiveSourceNode.style.transform = `translateY(${-snapshot.scrollTop}px)`;
    preview.appendChild(predictiveSourceNode);
  }
  document.getElementById("app").appendChild(preview);
  preview.querySelectorAll(".film-row,.filter-row,.home-tag-scroll").forEach((row, index) => {
    var _a3;
    row.scrollLeft = ((_a3 = snapshot.horizontalScroll) == null ? void 0 : _a3[index]) || 0;
  });
  document.getElementById("app").classList.add("predictive-active");
  scroll.style.transition = "none";
  predictivePreview = preview;
  predictivePreview.fromRight = fromRight;
  return true;
};
window.hgPredictiveBackProgress = (progress) => {
  if (state.route === "detail" && (detailCard == null ? void 0 : detailCard.phase) === "dragging") {
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
  if (state.route === "detail" && (detailCard == null ? void 0 : detailCard.phase) === "dragging") {
    detailCard.cancel();
    return;
  }
  if (!predictivePreview) return;
  if (predictiveFrame) cancelAnimationFrame(predictiveFrame);
  predictiveFrame = null;
  scroll.style.transition = "transform 180ms ease-out";
  scroll.style.transform = "translate3d(0,0,0)";
  predictiveTimer = setTimeout(clearPredictivePreview, 180);
};
window.hgPredictiveBackCommit = () => {
  if (!downloadOverlay.hidden) {
    hideDownloadSheet();
    return true;
  }
  if (window.__veyraAppearanceBack && window.__veyraAppearanceBack()) return true;
  if (window.__veyraAccountBack && window.__veyraAccountBack()) return true;
  if (window.__veyraProxyBack && window.__veyraProxyBack()) return true;
  if (window.__veyraAboutBack && window.__veyraAboutBack()) return true;
  if (window.__veyraRemoteBack && window.__veyraRemoteBack()) return true;
  if (window.__veyraRemotePickBack && window.__veyraRemotePickBack()) return true;
  if (state.route === "detail" && detailCard && downloadOverlay.hidden && authOverlay.hidden && confirmOverlay.hidden && updateOverlay.hidden && unlockOverlay.hidden) {
    detailCard.close();
    return true;
  }
  if (!predictivePreview) return window.hgBack();
  if (predictiveFrame) cancelAnimationFrame(predictiveFrame);
  predictiveFrame = null;
  const direction = predictivePreview.fromRight ? -1 : 1;
  scroll.style.transition = "transform 150ms ease-out";
  scroll.style.transform = `translate3d(${direction * 100}%,0,0)`;
  predictiveTimer = setTimeout(() => {
    const oldPage = content.firstElementChild;
    if (!window.hgBack()) {
      clearPredictivePreview();
      return;
    }
    if (content.firstElementChild !== oldPage) {
      clearPredictivePreview();
      return;
    }
    clearPredictivePreview();
  }, 150);
  return true;
};
function setNav(tab) {
  listingObserver == null ? void 0 : listingObserver.disconnect();
  categoryObserver == null ? void 0 : categoryObserver.disconnect();
  document.querySelectorAll("#dock [data-nav]").forEach((button) => button.classList.toggle("active", button.dataset.nav === tab));
  compact.classList.remove("visible");
  compact.inert = true;
  state.compactHeld = false;
  scroll.scrollTop = 0;
}
async function goHome() {
  var _a2, _b2;
  const token = ++routeToken;
  const adopted = swipeAdopting;
  swipeAdopting = false;
  stopBannerAuto();
  setRoute("home");
  state.tab = "home";
  setNav("home");
  const refreshing = api("home");
  const [cached, library] = await Promise.all([api("cached", { key: "home" }).catch(() => null), api("library").catch(() => null)]);
  if (token !== routeToken) return;
  state.library = library;
  state.home = (cached == null ? void 0 : cached.data) || null;
  if (adopted && state.home) {
    try {
      hydrateImages();
      scheduleBannerAuto();
    } catch (ignore) {
    }
  } else if (state.home) renderHome();
  else renderSkeleton();
  try {
    const fresh = await refreshing;
    if (token !== routeToken) return;
    const changed = state.home && homeSignature(state.home) !== homeSignature(fresh);
    const firstLoad = !state.home;
    state.home = fresh;
    if (firstLoad || changed) renderHome();
    else refreshMissingImages([...asArray(fresh.featured), ...asArray((_a2 = fresh.recommend) == null ? void 0 : _a2.items), ...asArray((_b2 = fresh.newest) == null ? void 0 : _b2.items)]);
    if (changed) toast("\u66F4\u65B0\u6210\u529F");
  } catch (error) {
    if (!state.home && token === routeToken) renderError(error, "home");
  }
}
async function goTags() {
  var _a2;
  const token = ++routeToken;
  if (state.route !== "tags") state.tagsReturn = captureScreen();
  setRoute("tags");
  state.tab = "home";
  setNav("home");
  const refreshing = api("tags");
  const cached = await api("cached", { key: "tags" }).catch(() => null);
  if (token !== routeToken) return;
  state.tags = (cached == null ? void 0 : cached.data) || state.tags;
  if (state.tags) renderTags();
  else renderSkeleton();
  try {
    const fresh = await refreshing;
    if (token !== routeToken) return;
    const changed = JSON.stringify((_a2 = state.tags) == null ? void 0 : _a2.items) !== JSON.stringify(fresh.items);
    const previousScroll = scroll.scrollTop;
    state.tags = fresh;
    if (changed) {
      renderTags();
      scroll.scrollTop = previousScroll;
    }
  } catch (error) {
    if (token === routeToken && !state.tags) renderError(error, "tags");
  }
}
async function goTag(slug, label) {
  var _a2, _b2;
  const token = ++routeToken;
  if (state.route !== "listing" || ((_a2 = state.listing) == null ? void 0 : _a2.kind) !== "tag-list" || ((_b2 = state.listing) == null ? void 0 : _b2.slug) !== slug) state.listingReturn = captureScreen();
  setRoute("listing");
  state.tab = "home";
  setNav("home");
  searchInput.value = `#${privateMode() ? "" : slug.startsWith("comic:") ? "\u6F2B\u5267\xB7" : "\u77ED\u5267\xB7"}${String(label).replace(/^#+/, "")}`;
  const refreshing = api("tag-list", { slug, page: 1 });
  const cached = await api("cached", { key: `tag:${slug}:1` }).catch(() => null);
  if (token !== routeToken) return;
  const firstLoad = !(cached == null ? void 0 : cached.data);
  state.listing = (cached == null ? void 0 : cached.data) ? __spreadProps(__spreadValues({}, cached.data), { kind: "tag-list", slug, label, refreshing: true, loading: false, error: false }) : { items: [], nextPage: null, kind: "tag-list", slug, label, refreshing: true, loading: false, error: false };
  renderListing();
  try {
    const fresh = await refreshing;
    if (token !== routeToken) return;
    const changed = listSignature(state.listing) !== listSignature(fresh) || state.listing.nextPage !== fresh.nextPage;
    const previousScroll = scroll.scrollTop;
    state.listing = __spreadProps(__spreadValues({}, fresh), { kind: "tag-list", slug, label, refreshing: false, loading: false, error: false });
    if (firstLoad || changed) {
      renderListing();
      scroll.scrollTop = previousScroll;
    } else updateListingFooter();
  } catch (error) {
    if (token !== routeToken) return;
    if (!state.listing.items.length) renderError(error, "tag-list");
    else {
      state.listing.refreshing = false;
      updateListingFooter();
      toast("\u5217\u8868\u66F4\u65B0\u5931\u8D25\uFF0C\u5DF2\u663E\u793A\u7F13\u5B58\u5185\u5BB9", true);
    }
  }
}
async function goTagQuery(query) {
  var _a2, _b2;
  const name = query.replace(/^[#＃]\s*/, "").trim();
  if (!name) {
    goTags();
    return;
  }
  let tags = asArray((_a2 = state.tags) == null ? void 0 : _a2.items);
  if (!tags.length) {
    const cached = await api("cached", { key: "tags" }).catch(() => null);
    tags = asArray((_b2 = cached == null ? void 0 : cached.data) == null ? void 0 : _b2.items);
  }
  if (!tags.length) {
    try {
      const fresh = await api("tags");
      state.tags = fresh;
      tags = asArray(fresh.items);
    } catch (e) {
      toast("\u6807\u7B7E\u6682\u65F6\u65E0\u6CD5\u52A0\u8F7D\uFF0C\u8BF7\u91CD\u8BD5", true);
      return;
    }
  }
  const normalize = (value) => String(value || "").replace(/^#+/, "").trim().toLocaleLowerCase();
  const matches = (item) => normalize(item.name) === normalize(name) || !privateMode() && normalize(`${item.group === "comic" ? "\u6F2B\u5267" : "\u77ED\u5267"}\xB7${item.name}`) === normalize(name);
  let tag = tags.find(matches);
  if (!tag) {
    try {
      const fresh = await api("tags");
      state.tags = fresh;
      tag = asArray(fresh.items).find(matches);
    } catch (e) {
    }
  }
  if (tag) goTag(tag.slug, tag.name);
  else toast("\u6CA1\u6709\u627E\u5230\u8FD9\u4E2A\u6807\u7B7E", true);
}
async function openListing(kind) {
  var _a2;
  if (kind !== "recommend" && kind !== "newest") return;
  const token = ++routeToken;
  rememberScreen();
  listingObserver == null ? void 0 : listingObserver.disconnect();
  setRoute("listing");
  state.tab = "home";
  setNav("home");
  const initial = (_a2 = state.home) == null ? void 0 : _a2[kind];
  state.listing = {
    kind,
    items: [...asArray(initial == null ? void 0 : initial.items)],
    nextPage: (initial == null ? void 0 : initial.nextPage) || null,
    refreshing: true,
    loading: false,
    error: false
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
    if (!state.listing.items.length) renderError(error, "listing");
    else {
      updateListingFooter();
      toast("\u5217\u8868\u66F4\u65B0\u5931\u8D25\uFF0C\u5DF2\u663E\u793A\u7F13\u5B58\u5185\u5BB9", true);
    }
  }
}
async function loadMoreListing() {
  var _a2;
  const listing = state.listing;
  if (state.route !== "listing" || !(listing == null ? void 0 : listing.nextPage) || listing.refreshing || listing.loading || listing.error) return;
  const token = routeToken;
  const pageNumber = listing.nextPage;
  listing.loading = true;
  updateListingFooter();
  try {
    const page = await api(listing.kind, { page: pageNumber, slug: listing.slug });
    if (token !== routeToken || state.listing !== listing || state.route !== "listing") return;
    const known = new Set(listing.items.map((item) => String(item.id)));
    const added = asArray(page.items).filter((item) => {
      const id = String(item.id);
      if (known.has(id)) return false;
      known.add(id);
      return true;
    });
    listing.items.push(...added);
    listing.nextPage = ((_a2 = page.items) == null ? void 0 : _a2.length) && page.nextPage > pageNumber ? page.nextPage : null;
    const grid = content.querySelector(".listing-grid");
    if (grid && added.length) {
      grid.insertAdjacentHTML("beforeend", added.map(itemCard).join(""));
      const images = [...grid.querySelectorAll("img[data-cover]")].slice(-added.length);
      images.forEach((image, index) => index < 8 ? loadCoverInto(image) : observer.observe(image));
    }
    const count = content.querySelector(".listing-page > p");
    if (count) count.textContent = `\u5DF2\u663E\u793A ${listing.items.length} \u90E8\u4F5C\u54C1`;
  } catch (error) {
    if (token === routeToken && state.listing === listing && state.route === "listing") listing.error = true;
  } finally {
    listing.loading = false;
    if (state.listing === listing && state.route === "listing") updateListingFooter();
  }
}
async function goCategory(tab, sub = state.sub[tab], keepCompact = false) {
  const token = ++routeToken;
  const adopted = swipeAdopting;
  swipeAdopting = false;
  categoryObserver == null ? void 0 : categoryObserver.disconnect();
  if (state.route === "home") rememberScreen();
  setRoute("category");
  state.tab = tab;
  state.sub[tab] = sub;
  state.category = null;
  state.categoryBanner = 0;
  if (!keepCompact) setNav(tab);
  const id = categoryId();
  const refreshing = api("category", { id, page: 1 });
  const cached = await api("cached", { key: `category:${id}:1` }).catch(() => null);
  if (token !== routeToken) return;
  state.category = (cached == null ? void 0 : cached.data) ? __spreadProps(__spreadValues({}, cached.data), { refreshing: true, loading: false, error: false }) : null;
  if (adopted) {
    try {
      hydrateImages();
    } catch (ignore) {
    }
    if (state.category) observeCategoryEnd();
  } else if (state.category) renderCategory(keepCompact);
  else renderSkeleton();
  try {
    const fresh = await refreshing;
    if (token !== routeToken) return;
    const previousCategory = state.category;
    state.category = __spreadProps(__spreadValues({}, fresh), { refreshing: false, loading: false, error: false });
    state.categoryItems = asArray(fresh.items);
    if (adopted) {
      try {
        refreshMissingImages(asArray(fresh.items));
      } catch (ignore) {
      }
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
      if (changed) toast("\u66F4\u65B0\u6210\u529F");
    }
  } catch (error) {
    if (token !== routeToken) return;
    if (!state.category) renderError(error, "category");
    else {
      state.category.refreshing = false;
      updateCategoryFooter();
      toast("\u5217\u8868\u66F4\u65B0\u5931\u8D25\uFF0C\u5DF2\u663E\u793A\u7F13\u5B58\u5185\u5BB9", true);
    }
  }
}
async function goLibrary(tab = "history") {
  const token = ++routeToken;
  const adopted = swipeAdopting;
  swipeAdopting = false;
  if (state.route === "home") rememberScreen();
  state.libraryTab = tab;
  setRoute("library");
  state.tab = "library";
  setNav("library");
  if (!adopted) renderSkeleton();
  try {
    const library = await api("library");
    if (token !== routeToken) return;
    state.library = library;
    if (adopted) {
      try {
        hydrateImages();
      } catch (ignore) {
      }
      if (state.libraryTab === "downloads") renderLibraryDownloads();
    } else renderLibrary();
  } catch (error) {
    if (token === routeToken) renderError(error, "library");
  }
}
function goSettings() {
  state.settingsReturn = captureScreen();
  setRoute("settings");
  state.tab = "library";
  setNav("library");
  refreshPrivateStatus();
  renderSettings();
}
let privateStatusRefreshing = false;
async function refreshPrivateStatus() {
  if (privateStatusRefreshing) return;
  privateStatusRefreshing = true;
  try {
    const status = await api("content-status");
    state.privateUnlocked = Boolean(status.unlocked);
  } catch (e) {
  } finally {
    privateStatusRefreshing = false;
  }
}
function goAccountManagement() {
  if (state.route === "account-management") return;
  if (state.route !== "settings") goSettings();
  state.accountReturn = captureScreen();
  setRoute("account-management");
  renderAccountManagement();
}
async function goSearch(query) {
  const token = ++routeToken;
  if (state.route === "home") rememberScreen();
  state.previous = { route: state.route, tab: state.tab };
  setRoute("search");
  state.query = query.trim();
  state.filter = "all";
  state.search = null;
  state.searchPending = true;
  state.searchError = "";
  scroll.scrollTop = 0;
  renderSearchLoading();
  let settled = false;
  let timeout;
  const refreshing = api("search", { query: state.query });
  api("cached", { key: `search:${state.query}` }).then((cached) => {
    if (settled || token !== routeToken || !(cached == null ? void 0 : cached.data)) return;
    state.search = cached.data;
    renderSearch();
  }).catch(() => {
  });
  try {
    const fresh = await Promise.race([refreshing, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error("\u641C\u7D22\u8FDE\u63A5\u8D85\u65F6\uFF0C\u8BF7\u91CD\u8BD5")), 25e3);
    })]);
    if (token !== routeToken) return;
    state.searchPending = false;
    state.search = fresh;
    renderSearch();
  } catch (error) {
    if (token !== routeToken) return;
    state.searchPending = false;
    if (state.search) {
      state.searchError = error.message || "\u641C\u7D22\u5237\u65B0\u5931\u8D25";
      renderSearch();
    } else renderError(error, "search");
  } finally {
    settled = true;
    clearTimeout(timeout);
  }
}
function sourceItem(id) {
  var _a2, _b2, _c2, _d2, _e, _f, _g, _h, _i, _j, _k, _l;
  const candidates = [(_a2 = state.listing) == null ? void 0 : _a2.items, (_b2 = state.home) == null ? void 0 : _b2.featured, (_c2 = state.home) == null ? void 0 : _c2.homepageRecommend, (_d2 = state.home) == null ? void 0 : _d2.homepageNewest, (_f = (_e = state.home) == null ? void 0 : _e.recommend) == null ? void 0 : _f.items, (_h = (_g = state.home) == null ? void 0 : _g.newest) == null ? void 0 : _h.items, (_i = state.category) == null ? void 0 : _i.items, (_j = state.search) == null ? void 0 : _j.items, (_k = state.library) == null ? void 0 : _k.bookmarks, (_l = state.library) == null ? void 0 : _l.progress].flatMap(asArray);
  return candidates.find((item) => item.id === id) || { id, title: `\u5267\u96C6 ${id}` };
}
async function goDetail(id, trigger) {
  var _a2, _b2, _c2, _d2, _e, _f, _g, _h;
  if (state.route === "detail" && ((_a2 = state.sourceItem) == null ? void 0 : _a2.id) === id) {
    state.detailLoading = true;
    renderDetail();
    const token2 = ++routeToken;
    try {
      const fresh = await api("detail", { id });
      if (token2 === routeToken) {
        state.detail = fresh;
        state.detailLoading = false;
        if (state.detail && state.detail.title) rememberTitleCover(state.detail.title, state.detail.cover || "");
        renderDetail();
      }
    } catch (error) {
      if (token2 === routeToken) {
        state.detailLoading = false;
        renderError(error, "detail");
      }
    }
    return;
  }
  const token = ++routeToken;
  const entrySource = bannerChanging && (trigger == null ? void 0 : trigger.closest(".hero")) ? null : window.HGCardTransition ? HGCardTransition.capture(trigger) : null;
  rememberScreen();
  state.previous = {
    route: state.route,
    tab: state.tab,
    sub: state.sub[state.tab],
    query: state.query,
    filter: state.filter,
    scrollTop: scroll.scrollTop,
    compactHeld: state.compactHeld,
    horizontalScroll: [...content.querySelectorAll(".film-row,.filter-row,.home-tag-scroll")].map((row) => row.scrollLeft),
    pageNode: content.firstElementChild
  };
  if (state.route === "listing" && state.listing) state.listing.refreshing = false;
  listingObserver == null ? void 0 : listingObserver.disconnect();
  categoryObserver == null ? void 0 : categoryObserver.disconnect();
  state.sourceItem = sourceItem(id);
  state.sourceGroup = state.route === "category" ? categoryId() : state.sourceItem.category || "";
  const aiGroup = state.sourceGroup === "ai-huanlian" || state.sourceGroup === "ai-mogai";
  const candidates = state.route === "category" ? asArray((_b2 = state.category) == null ? void 0 : _b2.items) : state.route === "search" ? asArray((_c2 = state.search) == null ? void 0 : _c2.items) : state.route === "listing" ? asArray((_d2 = state.listing) == null ? void 0 : _d2.items) : [...asArray((_f = (_e = state.home) == null ? void 0 : _e.recommend) == null ? void 0 : _f.items), ...asArray((_h = (_g = state.home) == null ? void 0 : _g.newest) == null ? void 0 : _h.items)];
  state.sourceQueue = aiGroup ? candidates.filter((item) => item.category === state.sourceGroup) : [];
  setRoute("detail");
  state.detail = __spreadValues({}, state.sourceItem);
  state.detailLoading = true;
  state.bookmarked = false;
  if (state.detail && state.detail.title) rememberTitleCover(state.detail.title, state.detail.cover || "");
  scroll.scrollTop = 0;
  updateCompact();
  renderDetail();
  if (entrySource) {
    detailCard = new HGCardTransition({
      app: document.getElementById("app"),
      scroll,
      content,
      source: entrySource,
      snapshot: state.previous,
      isDetail: () => state.route === "detail",
      onClose: () => {
        returnFromDetail();
        trigger == null ? void 0 : trigger.focus({ preventScroll: true });
      }
    });
    detailCard.open();
  }
  const refreshing = api("detail", { id });
  const cached = await api("cached", { key: `detail:${id}` }).catch(() => null);
  if (token !== routeToken) return;
  let hasDetailData = Boolean(cached == null ? void 0 : cached.data);
  if (hasDetailData) {
    state.detail = cached.data;
    state.detailLoading = false;
    renderDetail();
  }
  api("bookmark-state", { id }).then((saved) => {
    if (token === routeToken) {
      state.bookmarked = saved;
      if (state.detail) renderDetail();
    }
  }).catch(() => {
  });
  state.detailProgress = null;
  api("latest-progress", { id }).then((progress) => {
    if (token !== routeToken) return;
    state.detailProgress = progress || null;
    if (state.detail) renderDetail();
  }).catch(() => {
  });
  try {
    const fresh = await refreshing;
    if (token === routeToken) {
      state.detail = fresh;
      state.detailLoading = false;
      renderDetail();
    }
  } catch (error) {
    if (!hasDetailData && token === routeToken) {
      state.detailLoading = false;
      renderError(error, "detail");
    }
  }
}
function returnFromDetail() {
  const previous = state.previous || { route: "home", tab: "home" };
  if (!previous.pageNode) {
    goHome();
    return;
  }
  ++routeToken;
  setRoute(previous.route);
  state.tab = previous.tab;
  if (previous.route === "category") state.sub[previous.tab] = previous.sub;
  state.query = previous.query || "";
  state.filter = previous.filter || "all";
  state.compactHeld = previous.compactHeld;
  content.replaceChildren(previous.pageNode);
  state.previous = null;
  content.querySelectorAll(".film-row,.filter-row,.home-tag-scroll").forEach((row, index) => {
    var _a2;
    row.scrollLeft = ((_a2 = previous.horizontalScroll) == null ? void 0 : _a2[index]) || 0;
  });
  document.querySelectorAll("#dock [data-nav]").forEach((button) => button.classList.toggle("active", button.dataset.nav === state.tab));
  scroll.scrollTop = previous.scrollTop || 0;
  if (previous.route === "category") compact.innerHTML = compactMarkup();
  updateCompact();
  hydrateImages();
  if (previous.route === "home") refreshHomeHistory();
  if (previous.route === "category") observeCategoryEnd();
  if (previous.route === "listing") observeListingEnd();
  if (isBannerRoute()) {
    restoreBannerIndex();
    scheduleBannerAuto();
  }
}
window.hgBack = () => {
  var _a2;
  if (window.__veyraAppearanceBack && window.__veyraAppearanceBack()) return true;
  if (window.__veyraAccountBack && window.__veyraAccountBack()) return true;
  if (window.__veyraProxyBack && window.__veyraProxyBack()) return true;
  if (window.__veyraAboutBack && window.__veyraAboutBack()) return true;
  if (window.__veyraRemoteBack && window.__veyraRemoteBack()) return true;
  if (window.__veyraRemotePickBack && window.__veyraRemotePickBack()) return true;
  if (!downloadOverlay.hidden) {
    hideDownloadSheet();
    return true;
  }
  if (!unlockOverlay.hidden) {
    closeUnlock();
    return true;
  }
  if (!authOverlay.hidden) {
    if (state.account.loggedIn) hideAuth();
    return true;
  }
  if (!confirmOverlay.hidden) {
    closeConfirmation(false);
    return true;
  }
  if (!updateOverlay.hidden) {
    updateOverlay.hidden = true;
    updateBackEnabled();
    if (updateDownloading) toast("\u5DF2\u8F6C\u5165\u540E\u53F0\u4E0B\u8F7D\uFF0C\u5B8C\u6210\u540E\u4F1A\u81EA\u52A8\u5F39\u51FA\u5B89\u88C5", true);
    return true;
  }
  if (state.binge && state.route === "home") {
    exitBingeMode();
    return true;
  }
  if (isRootColumn()) return false;
  if (state.route === "campaign") {
    restoreScreen(state.campaignReturn);
    return true;
  }
  if (state.route === "account-management") {
    restoreScreen(state.accountReturn);
    return true;
  }
  if (state.route === "settings") {
    restoreScreen(state.settingsReturn);
    return true;
  }
  if (state.route === "detail") {
    if (detailCard) detailCard.close();
    else returnFromDetail();
    return true;
  }
  if (state.route === "listing" && ((_a2 = state.listing) == null ? void 0 : _a2.kind) === "tag-list") {
    restoreScreen(state.listingReturn);
    return true;
  }
  if (state.route === "tags") {
    restoreScreen(state.tagsReturn);
    return true;
  }
  if (state.route === "listing") {
    goHome();
    return true;
  }
  if (state.route === "search") {
    searchInput.value = "";
    goHome();
    return true;
  }
  if (state.route !== "home") {
    goHome();
    return true;
  }
  return false;
};
window.hgResume = () => {
  var _a2, _b2;
  (_a2 = window.hgRefreshPendingResources) == null ? void 0 : _a2.call(window);
  (_b2 = window.hgThemeRefresh) == null ? void 0 : _b2.call(window);
  retryFailedImages(true);
  if (state.route === "library") goLibrary(state.libraryTab);
  if (state.route === "home") refreshHomeHistory();
  if (state.route === "detail" && state.detail) {
    const id = String(state.detail.id);
    const token = routeToken;
    api("latest-progress", { id }).then((progress) => {
      if (token !== routeToken || state.route !== "detail" || !state.detail || String(state.detail.id) !== id) return;
      const before = JSON.stringify(state.detailProgress || null);
      state.detailProgress = progress || null;
      if (JSON.stringify(state.detailProgress) !== before) renderDetail();
    }).catch(() => {
    });
    api("bookmark-state", { id }).then((value) => {
      if (token !== routeToken || state.route !== "detail" || !state.detail) return;
      if (state.bookmarked === value) return;
      state.bookmarked = value;
      renderDetail();
    }).catch(() => {
    });
  }
  window.__bingeSync && window.__bingeSync();
};
function resumePlan() {
  const progress = state.detailProgress;
  if (!progress) return null;
  const episode = Number(progress.episode) || 0;
  if (episode < 1) return null;
  if (progress.completed) {
    const total = Number(progress.episodeCount) || 0;
    if (total > 0 && episode >= total) return null;
    return { episode: episode + 1, restart: true };
  }
  return { episode, restart: false };
}
function resumeReady() {
  return Boolean(resumePlan());
}
function resumeEpisode() {
  const plan = resumePlan();
  return plan ? plan.episode : 1;
}
function resumeRestart() {
  const plan = resumePlan();
  return plan ? plan.restart : false;
}
function resumeLabel() {
  const plan = resumePlan();
  return plan ? `\u7EE7\u7EED\u64AD\u653E \u7B2C${plan.episode}\u96C6` : "\u7ACB\u5373\u64AD\u653E";
}
async function openPlayer(episode = 1, restart = false) {
  const detail = state.detail;
  if (!detail) return;
  const item = __spreadValues(__spreadValues({}, state.sourceItem), detail);
  const queue = state.sourceQueue.length ? [...state.sourceQueue] : [item];
  if (!queue.some((candidate) => candidate.id === item.id)) queue.unshift(item);
  const index = queue.findIndex((candidate) => candidate.id === item.id);
  await api("open-player", { item, detail, episodes: asArray(detail.episodes), queue, index, group: state.sourceGroup, episode, restart });
}
async function loadMoreCategory() {
  var _a2;
  const category = state.category;
  if (state.route !== "category" || !(category == null ? void 0 : category.nextPage) || category.loading || category.refreshing || category.error) return;
  const token = routeToken;
  const next = category.nextPage;
  const id = categoryId();
  category.loading = true;
  updateCategoryFooter();
  try {
    const page = await api("category", { id, page: next });
    if (token !== routeToken || state.category !== category || state.route !== "category" || categoryId() !== id) return;
    const existing = new Set(asArray(category.items).map((item) => String(item.id)));
    const added = asArray(page.items).filter((item) => {
      const itemId = String(item.id);
      if (existing.has(itemId)) return false;
      existing.add(itemId);
      return true;
    });
    category.items.push(...added);
    category.nextPage = ((_a2 = page.items) == null ? void 0 : _a2.length) && page.nextPage > next ? page.nextPage : null;
    const grid = content.querySelector(".category-grid");
    if (grid && added.length) {
      grid.insertAdjacentHTML("beforeend", added.map(itemCard).join(""));
      [...grid.querySelectorAll("img[data-cover]")].slice(-added.length).forEach((image, index) => index < 8 ? loadCoverInto(image) : observer.observe(image));
    }
    const count = content.querySelector(".category-count");
    if (count) count.textContent = `\u5DF2\u663E\u793A ${category.items.length} \u90E8`;
  } catch (error) {
    if (token === routeToken && state.category === category && state.route === "category") category.error = true;
  } finally {
    category.loading = false;
    if (state.category === category && state.route === "category") updateCategoryFooter();
  }
}
document.getElementById("search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const query = searchInput.value.trim();
  searchInput.blur();
  hideSearchSuggest();
  if (["library", "settings", "account-management"].includes(state.route)) {
    state.libraryQuery = query;
    if (state.route === "library") renderLibrary();
    else goLibrary(state.libraryTab);
    scroll.scrollTop = 0;
    return;
  }
  if (/^[#＃]/.test(query)) goTagQuery(query);
  else if (query) {
    pushSearchHistory(query);
    goSearch(query);
  }
});
searchInput.addEventListener("input", () => {
  if (state.route === "library") {
    state.libraryQuery = searchInput.value;
    renderLibrary();
    scroll.scrollTop = 0;
    return;
  }
  const v = searchInput.value.trim();
  if (!v) {
    hideSearchSuggest();
    return;
  }
  clearTimeout(searchSuggestTimer);
  searchSuggestTimer = setTimeout(() => suggestSearch(v), 300);
});
searchInput.addEventListener("focus", () => {
  if (["library", "settings", "account-management"].includes(state.route)) return;
  const v = searchInput.value.trim();
  if (v) suggestSearch(v);
  else renderSearchHistory();
});
searchInput.addEventListener("blur", () => setTimeout(hideSearchSuggest, 200));
const searchHistoryKey = "search-history";
let searchSuggestTimer = null;
let searchSuggestSeq = 0;
function getSearchHistory() {
  try {
    return JSON.parse(localStorage.getItem(searchHistoryKey) || "[]");
  } catch (e) {
    return [];
  }
}
function pushSearchHistory(q) {
  q = String(q || "").trim();
  if (!q) return;
  let h = getSearchHistory().filter((x) => x !== q);
  h.unshift(q);
  if (h.length > 20) h = h.slice(0, 20);
  try {
    localStorage.setItem(searchHistoryKey, JSON.stringify(h));
  } catch (e) {
  }
}
function removeSearchHistory(q) {
  try {
    localStorage.setItem(searchHistoryKey, JSON.stringify(getSearchHistory().filter((x) => x !== q)));
  } catch (e) {
  }
}
function searchSuggestEl() {
  return document.getElementById("search-suggest");
}
function hideSearchSuggest() {
  const el = searchSuggestEl();
  if (el) el.hidden = true;
  searchSuggestSeq++;
}
function renderSearchHistory() {
  const el = searchSuggestEl();
  if (!el) return;
  const h = getSearchHistory();
  if (!h.length) {
    el.hidden = true;
    return;
  }
  el.innerHTML = `<div class="search-suggest-title">\u641C\u7D22\u5386\u53F2<button type="button" class="ss-clear" data-ss-clear>\u6E05\u7A7A</button></div>
    <div class="search-suggest-list">${h.map((q) => `<div class="search-suggest-item"><button type="button" class="ss-word" data-ss-word="${esc(q)}">${icon("clock")}<span>${esc(q)}</span></button><button type="button" class="ss-del" data-ss-del="${esc(q)}" aria-label="\u5220\u9664 ${esc(q)}">\xD7</button></div>`).join("")}</div>`;
  el.hidden = false;
}
async function suggestSearch(v) {
  const seq = ++searchSuggestSeq;
  const el = searchSuggestEl();
  if (!el) return;
  let items = null;
  try {
    const fresh = await Promise.race([api("search", { query: v, suggest: true }), new Promise((_, rej) => setTimeout(() => rej(new Error("\u8054\u60F3\u8D85\u65F6")), 6e3))]);
    if (seq !== searchSuggestSeq || searchInput.value.trim() !== v) return;
    items = asArray(fresh && (fresh.items || fresh.data && fresh.data.items));
  } catch (e) {
    return;
  }
  if (seq !== searchSuggestSeq) return;
  if (!items || !items.length) {
    el.hidden = true;
    return;
  }
  el.innerHTML = `<div class="search-suggest-title">\u8054\u60F3\u7ED3\u679C</div><div class="search-suggest-list">${items.slice(0, 8).map((it) => `<button type="button" class="search-suggest-card" data-open-id="${esc(it.id)}" data-ss-close>${it.cover ? `<span class="search-suggest-thumb"><img src="${esc(it.cover)}" alt="" loading="lazy" onerror="this.closest('.search-suggest-thumb').style.display='none'"></span>` : ""}<strong>${esc(it.title || "")}</strong>${it.episodeLabel ? `<em>${esc(it.episodeLabel)}</em>` : ""}</button>`).join("")}</div>`;
  el.hidden = false;
}
document.addEventListener("focusin", (event) => {
  const t = event.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) {
    api("input-edit", { active: true }).catch(() => {
    });
  }
});
document.addEventListener("focusout", (event) => {
  const t = event.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) {
    api("input-edit", { active: false }).catch(() => {
    });
  }
});
document.addEventListener("pointerdown", (event) => {
  const active = document.activeElement;
  if (!active) return;
  if (active.tagName !== "INPUT" && active.tagName !== "TEXTAREA" && !active.isContentEditable) return;
  const t = event.target;
  if (!(t instanceof Element)) return;
  if (t !== active && !active.contains(t)) active.blur();
}, true);
document.addEventListener("submit", async (event) => {
  if (event.target.id !== "password-form") return;
  event.preventDefault();
  const form = event.target;
  const oldPassword = form.querySelector("#old-password").value;
  const newPassword = form.querySelector("#new-password").value;
  const error = form.querySelector("#password-error");
  const button = form.querySelector('[type="submit"]');
  error.hidden = true;
  if (newPassword === oldPassword) {
    error.textContent = "\u65B0\u5BC6\u7801\u4E0D\u80FD\u4E0E\u65E7\u5BC6\u7801\u76F8\u540C";
    error.hidden = false;
    return;
  }
  button.disabled = true;
  try {
    setAccount(await api("change-password", { oldPassword, newPassword }));
    toast("\u5BC6\u7801\u5DF2\u4FEE\u6539");
  } catch (failure) {
    error.textContent = failure.message || "\u4FEE\u6539\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5";
    error.hidden = false;
    button.disabled = false;
  }
});
const DOCK_ORDER = ["home", "adult", "ai", "library"];
const LIBRARY_TABS = ["history", "bookmarks", "downloads"];
const SWIPE_MIN_PX = 40;
const SWIPE_MIN_RATIO = 0.22;
const SWIPE_MAX_MS = 900;
let swiping = false;
let swipeStart = null;
let swipeAxis = null;
let swipeTrack = null;
let touching = false;
const swipePageCache = /* @__PURE__ */ new Map();
let swipePrefetchBusy = false;
let swipeSaveGuard = false;
let swipeAdopting = false;
const swipeOffstage = document.createElement("div");
swipeOffstage.style.cssText = "position:fixed;left:-99999px;top:0;width:100%;visibility:hidden;pointer-events:none;";
document.addEventListener("DOMContentLoaded", () => document.body.appendChild(swipeOffstage));
if (document.body) document.body.appendChild(swipeOffstage);
async function swipePrefetch(keyOrFn, prepare, render) {
  if (swipePageCache.size >= 12 || swipePrefetchBusy || document.hidden || swiping || swipeTrack || state.route === "detail") return;
  swipePrefetchBusy = true;
  try {
    const data = await prepare();
    if (!data || swiping || swipeTrack || swipePageCache.size >= 12) return;
    const key = typeof keyOrFn === "function" ? keyOrFn() : keyOrFn;
    if (!key || swipePageCache.has(key)) return;
    routeToken++;
    const savedNode = content.firstElementChild;
    const resumeTop = scroll.scrollTop;
    const saved = {
      route: state.route,
      tab: state.tab,
      sub: __spreadValues({}, state.sub),
      libraryTab: state.libraryTab,
      library: state.library,
      libraryQuery: state.libraryQuery,
      home: state.home,
      category: state.category,
      categoryBanner: state.categoryBanner,
      categoryItems: state.categoryItems,
      query: state.query,
      filter: state.filter,
      compactHeld: state.compactHeld,
      compactHTML: compact.innerHTML
    };
    let clone = null;
    try {
      render(data);
      const node = content.firstElementChild;
      if (node && node !== savedNode && swipeAdoptable(node)) {
        clone = node.cloneNode(true);
        setTimeout(() => {
          if (!clone || swiping || swipeTrack) return;
          for (const img of clone.querySelectorAll("img[src]")) {
            if (img.complete) continue;
            const probe = new Image();
            probe.src = img.src;
            if (probe.decode) probe.decode().catch(() => {
            });
          }
        }, 0);
      }
    } finally {
      routeToken++;
      stopBannerAuto();
      try {
        categoryObserver == null ? void 0 : categoryObserver.disconnect();
      } catch (ignore) {
      }
      state.route = saved.route;
      state.tab = saved.tab;
      state.sub = saved.sub;
      state.libraryTab = saved.libraryTab;
      state.library = saved.library;
      state.libraryQuery = saved.libraryQuery;
      state.home = saved.home;
      state.category = saved.category;
      state.categoryBanner = saved.categoryBanner;
      state.categoryItems = saved.categoryItems;
      state.query = saved.query;
      state.filter = saved.filter;
      state.compactHeld = saved.compactHeld;
      content.replaceChildren(savedNode);
      compact.innerHTML = saved.compactHTML;
      scroll.scrollTop = resumeTop;
    }
    if (clone) {
      swipeOffstage.appendChild(clone);
      await swipePrimeImages(clone);
      swipePageCache.set(key, clone);
      while (swipePageCache.size > 12) swipePageCache.delete(swipePageCache.keys().next().value);
    }
  } catch (error) {
  }
  swipePrefetchBusy = false;
}
async function swipePrefetchAll() {
  if (swipePrefetchBusy || document.hidden || state.route === "detail") return;
  const homeJob = ["home", async () => {
    const cached = await api("cached", { key: "home" }).catch(() => null);
    const home = (cached == null ? void 0 : cached.data) || await withTimeout(api("home"), 8e3).catch(() => null);
    if (!home) return null;
    const library = await api("library").catch(() => null) || state.library;
    return { home, library };
  }, (data) => {
    state.home = data.home;
    state.library = data.library;
    renderHome();
  }];
  const categoryJobs = [];
  for (const tab of ["adult", "ai"]) {
    (categoryIds[tab] || []).forEach((id, index) => {
      categoryJobs.push([
        "category:" + tab + ":" + index,
        async () => {
          const cached = await api("cached", { key: `category:${id}:1` }).catch(() => null);
          const fresh = (cached == null ? void 0 : cached.data) || await withTimeout(api("category", { id, page: 1 }), 8e3).catch(() => null);
          return fresh ? { fresh, tab, sub: index } : null;
        },
        (data) => {
          state.tab = data.tab;
          state.sub[data.tab] = data.sub;
          state.categoryBanner = 0;
          state.category = __spreadProps(__spreadValues({}, data.fresh), { refreshing: false, loading: false, error: false });
          state.categoryItems = asArray(data.fresh.items);
          renderCategory();
        }
      ]);
    });
  }
  const libraryJobs = ["history", "bookmarks", "downloads"].map((tab, index) => [
    "library:" + tab,
    async () => {
      if (index === 0) return { library: await withTimeout(api("library"), 8e3).catch(() => null) || state.library };
      if (index === 1) return { library: state.library };
      let phone = [];
      try {
        phone = asArray(await withTimeout(api("download-list"), 4e3));
      } catch (ignore) {
        phone = [];
      }
      let nas = [];
      if (state.account.loggedIn) {
        try {
          nas = asArray((await withTimeout(api("nas-download-list"), 4e3)).tasks);
        } catch (ignore) {
          nas = [];
        }
        try {
          nas = nas.concat(asArray((await withTimeout(api("desktop-download-list"), 4e3)).tasks));
        } catch (ignore) {
        }
      }
      return { library: state.library, downloads: { phone, nas } };
    },
    (data) => {
      state.library = data.library;
      state.libraryTab = tab;
      state.libraryQuery = "";
      state.query = "";
      if (tab !== "downloads") {
        renderLibrary();
        return;
      }
      renderLibrary();
      const list = document.getElementById("library-downloads");
      if (list) {
        list.dataset.sig = "";
        commitDownloadList(list, data.downloads.phone, data.downloads.nas, { noTimer: true });
      }
    }
  ]);
  for (const [key, prepare, render] of [homeJob, ...categoryJobs, ...libraryJobs]) {
    if (document.hidden || swiping || swipeTrack) return;
    if (typeof key === "string" && swipePageCache.has(key)) continue;
    try {
      await swipePrefetch(key, prepare, render);
    } catch (ignore) {
    }
  }
}
const SWIPE_TAB_BAR_SELECTOR = '[role="tablist"].segmented,[role="tablist"].compact-tabs';
const SWIPE_IGNORE = ".filter-row,.home-tag-scroll,.search-form,input,textarea,select,.proxy-mode-dd-menu,.episode-grid,.hero,.hero-dots," + SWIPE_TAB_BAR_SELECTOR;
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
  if (state.route === "library") return { list: LIBRARY_TABS, current: state.libraryTab };
  if (state.route === "category") {
    const ids = categoryIds[state.tab] || [];
    return { list: ids.map((id, index) => index), current: state.sub[state.tab] };
  }
  return { list: [], current: null };
}
function swipeCacheKey() {
  if (state.route === "library") return "library:" + state.libraryTab;
  if (state.route === "category") return "category:" + state.tab + ":" + state.sub[state.tab];
  return state.route;
}
function swipeSaveCurrent() {
  if (swipeSaveGuard) return;
  const node = content.firstElementChild;
  if (!node || node.classList.contains("skeleton-home") || node.classList.contains("swipe-skel")) return;
  swipeCleanCloneImages(node);
  node.querySelectorAll("*").forEach((el) => {
    if (el.style && el.style.visibility === "hidden") el.style.visibility = "";
  });
  swipePageCache.set(swipeCacheKey(), node);
  if (swipePageCache.size > 12) swipePageCache.delete(swipePageCache.keys().next().value);
}
function swipeAdoptable(node) {
  return !!node && !node.classList.contains("swipe-skel") && !node.classList.contains("error-state");
}
function swipeBuildCached(key) {
  const cached = swipePageCache.get(key);
  if (!cached) return null;
  swipePageCache.delete(key);
  swipeCleanCloneImages(cached);
  return cached;
}
function swipeBuildSkeleton(key) {
  const wrap = document.createElement("div");
  if (String(key).indexOf("library:") === 0) {
    const cards = Array.from({ length: 4 }, () => '<div class="skeleton sk-card"></div>').join("");
    wrap.innerHTML = `<div class="library-page swipe-skel" role="status" aria-label="\u6B63\u5728\u52A0\u8F7D\u5185\u5BB9"><div class="my-heading"><h1>\u6211\u7684</h1></div><div class="segmented library-tabs skeleton-tabs" role="tablist"><span class="skeleton skeleton-pill"></span><span class="skeleton skeleton-pill"></span><span class="skeleton skeleton-pill"></span></div><p class="library-count"><span class="skeleton sk-sm"></span></p><div class="sk-list">${cards}</div></div>`;
  } else {
    const posters = Array.from({ length: 3 }, () => '<div class="skeleton skeleton-poster"></div>').join("");
    wrap.innerHTML = '<div class="swipe-skel" role="status" aria-label="\u6B63\u5728\u52A0\u8F7D\u5185\u5BB9"><div class="skeleton skeleton-hero"></div><div class="skeleton skeleton-title"></div><div class="skeleton-row">' + posters + '</div><div class="skeleton-row">' + posters + "</div></div>";
  }
  return wrap.firstElementChild;
}
function swipeTabNodes(node) {
  if (!node) return [];
  const out = /* @__PURE__ */ new Set();
  for (const tab of node.querySelectorAll(SWIPE_TAB_BAR_SELECTOR)) {
    out.add(tab);
    let el = tab;
    for (let depth = 0; el && el !== content && depth < 3; depth++) {
      let sib = el.previousElementSibling;
      while (sib) {
        out.add(sib);
        sib = sib.previousElementSibling;
      }
      el = el.parentElement;
    }
  }
  return [...out];
}
function swipeResolve(delta) {
  const sub = swipeSubTabs();
  const pos = sub.list.indexOf(sub.current);
  if (sub.list.length > 1 && pos >= 0 && sub.list[pos + delta] !== void 0) {
    const next2 = sub.list[pos + delta];
    const key2 = state.route === "library" ? "library:" + next2 : "category:" + state.tab + ":" + next2;
    return {
      mode: "inline",
      // 页内子项：tab 栏与标题钉住，仅内容区平移
      key: key2,
      // 取消滑动时把预览节点（缓存本体）放回缓存用
      step: [pos, pos + delta],
      // 高亮要跟着手从 pos 滑到 pos+delta
      // adopted：目标页 DOM 已由滑动的手放下（真内容），别再整体重渲染，否则会闪一下
      go: () => {
        const adopted = swipeAdopting;
        swipeSaveGuard = true;
        try {
          if (state.route === "library") {
            swipeAdopting = false;
            state.libraryTab = next2;
            if (!adopted) {
              renderLibrary();
            } else {
              for (const b of content.querySelectorAll("[data-library-tab]")) {
                const on = b.dataset.libraryTab === next2;
                b.classList.toggle("selected", on);
                if (on) b.setAttribute("aria-selected", "true");
                else b.removeAttribute("aria-selected");
              }
              if (next2 === "downloads") {
                try {
                  renderLibraryDownloads();
                } catch (ignore) {
                }
              }
              try {
                hydrateImages();
              } catch (ignore) {
              }
            }
            scroll.scrollTop = 0;
          } else goCategory(state.tab, next2);
        } finally {
          swipeSaveGuard = false;
        }
      },
      build: () => swipeBuildCached(key2) || swipeBuildSkeleton(key2)
    };
  }
  const index = DOCK_ORDER.indexOf(state.route === "category" ? state.tab : state.route);
  const next = DOCK_ORDER[index + delta];
  if (!next) return null;
  const key = next === "library" ? "library:" + state.libraryTab : next === "home" ? "home" : "category:" + next + ":" + (state.sub[next] || 0);
  return {
    mode: "page",
    // 底栏页之间：整页平移
    key,
    step: [index, index + delta],
    // 底栏透镜与页面共用同一滑动进度
    go: () => navigateDock(next),
    build: () => swipeBuildCached(key) || swipeBuildSkeleton(key)
  };
}
function swipeBlocked() {
  return swiping || state.route === "detail" || [unlockOverlay, authOverlay, confirmOverlay, updateOverlay, downloadOverlay].some((overlay) => !overlay.hidden) || document.body.classList.contains("predictive-active");
}
function swipeBuildTabAnim(bar, step) {
  if (!bar || !step || !window.SegGlass) return null;
  const [from, to] = step;
  const items = [...bar.querySelectorAll("button")];
  if (items.length < 2 || !items[from] || !items[to] || from === to) return null;
  const seg = window.SegGlass.handle(bar);
  if (!seg) return null;
  seg.setDragging(true);
  return { seg, items, from, to };
}
function swipeTabProgress(t, ratio) {
  const anim = t && t.tabAnim;
  if (!anim) return;
  const q = Math.max(0, Math.min(1, ratio || 0));
  anim.seg.progress(anim.from, anim.to, q);
}
function swipeBuildDockAnim(step) {
  if (!step || !window.DockGlass) return null;
  const [from, to] = step;
  if (from === to || from < 0 || to < 0) return null;
  window.DockGlass.begin(from, to);
  return { api: window.DockGlass, from, to };
}
function swipeDockProgress(t, ratio) {
  const anim = t && t.dockAnim;
  if (!anim) return;
  const q = Math.max(0, Math.min(1, ratio || 0));
  anim.api.progress(anim.from, anim.to, q);
}
function swipeOpenTrack(delta, dx) {
  if (swiping || swipeTrack) return false;
  const resolve = swipeResolve(delta);
  if (!resolve) return false;
  const node = resolve.build();
  if (!node) return false;
  const box = scroll.getBoundingClientRect();
  const current = content.firstElementChild;
  const currentStyle = current ? current.getAttribute("style") : null;
  const currentRect = current ? current.getBoundingClientRect() : null;
  const panel = node;
  const panelMotion = {
    transform: panel.style.transform,
    transition: panel.style.transition,
    willChange: panel.style.willChange,
    marginTop: panel.style.marginTop
  };
  const scrollOverflowX = scroll.style.overflowX;
  const previousScrollTop = scroll.scrollTop;
  if (current && currentRect) {
    current.style.cssText += `;position:absolute;left:0;top:${Math.round(currentRect.top - box.top)}px;width:100%;margin:0;z-index:2;background:${getComputedStyle(scroll).background};`;
  }
  scroll.style.overflowX = "hidden";
  scroll.scrollTop = 0;
  content.appendChild(panel);
  const track = { panel, current, currentStyle, panelMotion, scrollOverflowX, previousScrollTop, mode: "page", width: Math.round(box.width || scroll.clientWidth || 360), dirSign: delta > 0 ? 1 : -1, guard: 0, resolve, pinned: [], clones: [], moving: [], savedDisplays: [] };
  const pageNode = current;
  if (resolve.mode === "inline" && pageNode) {
    const tab = pageNode.querySelector(SWIPE_TAB_BAR_SELECTOR);
    if (tab && tab.parentElement) {
      const kids = [...tab.parentElement.children];
      const ti = kids.indexOf(tab);
      track.mode = "inline";
      track.pinned = kids.slice(0, ti + 1);
      track.moving = kids.slice(ti + 1);
      const pageRect = pageNode.getBoundingClientRect();
      const shell = pageNode.cloneNode(true);
      const shellTab = shell.querySelector(SWIPE_TAB_BAR_SELECTOR);
      if (shellTab) {
        let sib = shellTab.nextElementSibling;
        while (sib) {
          const next = sib.nextElementSibling;
          sib.remove();
          sib = next;
        }
        shell.style.cssText += `;position:fixed;left:${Math.round(pageRect.left)}px;top:${Math.round(pageRect.top)}px;width:${Math.round(pageRect.width)}px;margin:0;z-index:14;pointer-events:none;`;
        document.body.appendChild(shell);
        track.clones.push(shell);
        shellTab.setAttribute("data-seg-no-gesture", "");
        track.tabAnim = swipeBuildTabAnim(shellTab, resolve.step);
      }
      for (const el of track.pinned) el.style.visibility = "hidden";
      const nodeTab = node.querySelector(SWIPE_TAB_BAR_SELECTOR);
      if (nodeTab && nodeTab.parentElement) {
        const nk = [...nodeTab.parentElement.children];
        const ni = nk.indexOf(nodeTab);
        for (const el of nk.slice(0, ni + 1)) {
          track.savedDisplays.push([el, el.style.display]);
          el.style.display = "none";
        }
      }
    }
  }
  if (track.mode === "inline") {
    const firstMoving = track.moving[0];
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
  }
  if (track.mode === "page") track.dockAnim = swipeBuildDockAnim(resolve.step);
  swipeTrack = track;
  routeToken++;
  swipeLayTrack(dx);
  swipeTrack.guard = setTimeout(() => {
    if (swipeTrack && !touching) swipeCloseTrack(false);
  }, 1500);
  return true;
}
function swipeLayTrack(dx) {
  const t = swipeTrack;
  if (!t) return;
  if (t.mode === "inline") {
    for (const el of t.moving) el.style.transform = `translateX(${dx}px)`;
    swipeTabProgress(t, Math.abs(dx) / t.width);
  } else if (t.current) {
    t.current.style.transform = `translateX(${dx}px)`;
    swipeDockProgress(t, Math.abs(dx) / t.width);
  }
  t.panel.style.transform = `translateX(${t.dirSign * t.width + dx}px)`;
}
function swipeClearTabs(t) {
  var _a2, _b2;
  for (const el of t.pinned || []) el.style.visibility = "";
  for (const [el, d] of t.savedDisplays || []) el.style.display = d;
  for (const el of t.moving || []) {
    el.style.transform = "";
    el.style.transition = "";
  }
  if (t.mode === "inline" && window.SegGlass) {
    const selectedIndex = t.resolve.step ? t.resolve.step[1] : -1;
    for (const bar of t.panel.querySelectorAll(SWIPE_TAB_BAR_SELECTOR)) {
      const buttons = [...bar.querySelectorAll("button")];
      buttons.forEach((button, index) => {
        if (selectedIndex < 0) return;
        button.classList.toggle("selected", index === selectedIndex);
        button.classList.remove("drag-over", "dim", "holding");
        if (index === selectedIndex) button.setAttribute("aria-selected", "true");
        else button.removeAttribute("aria-selected");
      });
      const seg = window.SegGlass.handle(bar);
      seg.setDragging(false);
      seg.setFollow(false);
      seg.clearHover();
      seg.sync(false);
    }
  }
  try {
    ((_b2 = (_a2 = t.tabAnim) == null ? void 0 : _a2.seg) == null ? void 0 : _b2.blob) && (t.tabAnim.seg.blob.style.transition = "");
  } catch (ignore) {
  }
  for (const c of t.clones || []) c.remove();
}
function swipeCloseTrack(commit) {
  const t = swipeTrack;
  if (!t) return;
  swipeTrack = null;
  swiping = true;
  clearTimeout(t.guard);
  const ease = "transform .2s cubic-bezier(.22,.61,.36,1)";
  const restoreStyle = (el, value) => {
    if (!el) return;
    if (value == null) el.removeAttribute("style");
    else el.setAttribute("style", value);
  };
  const restorePanelMotion = () => {
    const m = t.panelMotion;
    t.panel.style.transform = m.transform;
    t.panel.style.transition = m.transition;
    t.panel.style.willChange = m.willChange;
    t.panel.style.marginTop = m.marginTop;
    scroll.style.overflowX = t.scrollOverflowX;
  };
  const moveCurrent = (x) => {
    if (t.mode === "inline") {
      for (const el of t.moving) {
        el.style.transition = ease;
        el.style.transform = `translateX(${x}px)`;
      }
    } else if (t.current) {
      t.current.style.transition = ease;
      t.current.style.transform = `translateX(${x}px)`;
    }
  };
  t.panel.style.transition = ease;
  const tabEase = "transform .2s cubic-bezier(.22,.61,.36,1),width .2s cubic-bezier(.22,.61,.36,1),height .2s cubic-bezier(.22,.61,.36,1)";
  if (t.dockAnim) t.dockAnim.api.settle(commit);
  if (commit) {
    if (t.tabAnim) {
      const anim = t.tabAnim;
      anim.seg.blob.style.transition = tabEase;
      for (const el of anim.items) el.style.transition = "color .2s ease";
      swipeTabProgress(t, 1);
    }
    moveCurrent(-t.dirSign * t.width);
    t.panel.style.transform = "translateX(0)";
    setTimeout(() => {
      swipeClearTabs(t);
      restoreStyle(t.current, t.currentStyle);
      swipeSaveCurrent();
      if (t.current) t.current.remove();
      scroll.scrollTop = 0;
      restorePanelMotion();
      swiping = false;
      swipeAdopting = swipeAdoptable(t.panel);
      swipeSaveGuard = true;
      try {
        const result = t.resolve.go();
        if (result && result.catch) result.catch(() => {
        });
      } catch (ignore) {
      }
      swipeSaveGuard = false;
      swipeAdopting = false;
      setTimeout(() => {
        swipePrefetchAll().catch(() => {
        });
      }, 1500);
    }, 210);
  } else {
    if (t.tabAnim) {
      const anim = t.tabAnim;
      for (const el of anim.items) el.style.transition = "color .2s ease";
      anim.seg.blob.style.transition = tabEase;
      swipeTabProgress(t, 0);
    }
    moveCurrent(0);
    t.panel.style.transform = `translateX(${t.dirSign * t.width}px)`;
    setTimeout(() => {
      swipeClearTabs(t);
      restoreStyle(t.current, t.currentStyle);
      restorePanelMotion();
      if (t.resolve.key && swipeAdoptable(t.panel)) {
        swipeCleanCloneImages(t.panel);
        swipePageCache.set(t.resolve.key, t.panel);
      }
      t.panel.remove();
      scroll.scrollTop = t.previousScrollTop;
      swiping = false;
      if (state.route === "downloads") refreshDownloads(routeToken, true);
    }, 210);
  }
}
function swipeSettleBack() {
  scroll.style.transition = "transform .17s cubic-bezier(.22,.61,.36,1)";
  scroll.style.transform = "translateX(0)";
  setTimeout(() => {
    scroll.style.transition = "";
    scroll.style.transform = "";
  }, 180);
}
scroll.addEventListener("touchstart", (event) => {
  touching = true;
  const touch = event.touches[0];
  if (!touch || swiping || swipeBlocked() || document.querySelector(".card-transition-stage") || !DOCK_ORDER.includes(state.route === "category" ? state.tab : state.route)) {
    swipeStart = null;
    return;
  }
  if (event.target.closest && event.target.closest(SWIPE_IGNORE)) {
    swipeStart = null;
    return;
  }
  swipeStart = { x: touch.clientX, y: touch.clientY, at: Date.now(), target: event.target };
  swipeAxis = null;
}, { passive: true });
scroll.addEventListener("touchmove", (event) => {
  const start = swipeStart;
  if (!start) return;
  const touch = event.touches[0];
  if (!touch) return;
  const dx = touch.clientX - start.x, dy = touch.clientY - start.y;
  if (!swipeAxis) {
    if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
    if (Math.abs(dx) < Math.abs(dy) * 1.3) {
      swipeAxis = "y";
      swipeStart = null;
      return;
    }
    if (swipeScrollOwner(start.target, dx)) {
      swipeStart = null;
      return;
    }
    swipeAxis = "x";
    swipeOpenTrack(dx < 0 ? 1 : -1, dx);
  }
  if (swipeAxis !== "x") return;
  if (event.cancelable) event.preventDefault();
  if (swipeTrack) swipeLayTrack(dx);
  else scroll.style.transform = `translateX(${dx * 0.3}px)`;
}, { passive: false });
scroll.addEventListener("touchend", (event) => {
  touching = false;
  const start = swipeStart;
  const axis = swipeAxis, track = swipeTrack;
  swipeStart = null;
  swipeAxis = null;
  if (!start || axis !== "x") return;
  const touch = event.changedTouches[0];
  const dx = touch ? touch.clientX - start.x : 0;
  const dy = touch ? touch.clientY - start.y : 0;
  const elapsed = Math.max(1, Date.now() - start.at);
  const width = track ? track.width : scroll.clientWidth || 360;
  const fling = Math.abs(dx) / elapsed > 0.45 && Math.abs(dx) > 24;
  const passed = elapsed <= SWIPE_MAX_MS && Math.abs(dx) >= Math.abs(dy) * 1.3 && (Math.abs(dx) >= width * SWIPE_MIN_RATIO || fling && Math.abs(dx) >= SWIPE_MIN_PX);
  if (track) {
    swipeCloseTrack(passed);
    return;
  }
  swipeSettleBack();
}, { passive: true });
scroll.addEventListener("touchcancel", () => {
  touching = false;
  const track = swipeTrack, axis = swipeAxis;
  swipeStart = null;
  swipeAxis = null;
  if (track) swipeCloseTrack(false);
  else if (axis === "x") swipeSettleBack();
});
function navigateDock(tab) {
  try {
    swipeSaveCurrent();
  } catch (ignore) {
  }
  if (state.route === "detail") state.previous = null;
  if (tab === "home") goHome();
  else if (tab === "library") goLibrary();
  else goCategory(tab);
}
function tapDock(button) {
  const tab = button.dataset.nav;
  const now = performance.now();
  if (lastDockTap.tab === tab && now - lastDockTap.at < 320) {
    const alreadyNavigated = lastDockTap.navigated;
    lastDockTap = { tab: "", at: 0, navigated: false };
    const icon2 = button.querySelector(".nav-icon");
    icon2 == null ? void 0 : icon2.classList.remove("dock-bounce");
    void (icon2 == null ? void 0 : icon2.offsetWidth);
    icon2 == null ? void 0 : icon2.classList.add("dock-bounce");
    icon2 == null ? void 0 : icon2.addEventListener("animationend", () => icon2.classList.remove("dock-bounce"), { once: true });
    scroll.scrollTop = 0;
    if (!alreadyNavigated) navigateDock(tab);
    return;
  }
  const route = tab === "home" ? "home" : tab === "library" ? "library" : "category";
  const navigated = state.route !== route || state.tab !== tab;
  lastDockTap = { tab, at: now, navigated };
  if (navigated) navigateDock(tab);
}
document.addEventListener("click", async (event) => {
  const ssWord = event.target.closest("[data-ss-word]");
  if (ssWord) {
    const w = ssWord.dataset.ssWord;
    hideSearchSuggest();
    searchInput.value = w;
    pushSearchHistory(w);
    goSearch(w);
    return;
  }
  const ssDel = event.target.closest("[data-ss-del]");
  if (ssDel) {
    removeSearchHistory(ssDel.dataset.ssDel);
    renderSearchHistory();
    return;
  }
  const ssClear = event.target.closest("[data-ss-clear]");
  if (ssClear) {
    try {
      localStorage.removeItem(searchHistoryKey);
    } catch (e) {
    }
    renderSearchHistory();
    return;
  }
  if (event.target.closest("[data-ss-close]")) hideSearchSuggest();
  const campaignButton = event.target.closest("[data-open-campaign]");
  if (campaignButton) {
    if (heroTapGuard(campaignButton)) return;
    const item = activeCampaigns().find((item2) => item2.id === campaignButton.dataset.openCampaign);
    if (item) goCampaign(item);
    return;
  }
  if (event.target.closest("[data-enter-private]")) {
    handleEnterPrivate();
    return;
  }
  const publicCategory = event.target.closest("[data-public-category]");
  if (publicCategory) {
    goCategory(publicCategory.dataset.publicCategory);
    return;
  }
  if (event.target.closest("[data-return-public]")) {
    await api("leave-private");
    location.reload();
    return;
  }
  if (event.target.closest("[data-check-update]")) {
    checkUpdate(true);
    return;
  }
  if (event.target.closest("[data-check-resources]")) {
    const button = event.target.closest("[data-check-resources]");
    button.disabled = true;
    try {
      const result = await api("check-hot-update");
      window.hgHotUpdateStatus(result);
      toast(result.pending ? "\u8D44\u6E90\u5DF2\u4E0B\u8F7D\uFF0C\u8FD4\u56DE\u9996\u9875\u7A7A\u95F2\u65F6\u4F1A\u81EA\u52A8\u542F\u7528" : result.unavailable ? "\u6682\u65E0\u53EF\u7528\u8D44\u6E90\u66F4\u65B0\uFF0C\u5F53\u524D\u4F7F\u7528\u5185\u7F6E\u8D44\u6E90" : "\u5DF2\u662F\u6700\u65B0\u8D44\u6E90");
    } catch (error) {
      toast(error.message, true);
    } finally {
      if (button.isConnected) button.disabled = false;
    }
    return;
  }
  if (event.target.closest("[data-apply-resources]")) {
    api("apply-hot-update").catch((error) => toast(error.message, true));
    return;
  }
  if (event.target.closest("[data-account-management]")) {
    openAccountPop();
    return;
  }
  if (event.target.closest("[data-qr-login]")) {
    startQrScan();
    return;
  }
  if (event.target.closest("[data-proxy-open]")) {
    openProxyPop();
    return;
  }
  if (event.target.closest("[data-about-open]")) {
    openAboutPop();
    return;
  }
  if (event.target.closest("[data-remote-open]")) {
    openRemotePop();
    return;
  }
  if (event.target.closest("[data-remote-add]")) {
    remoteEditing = "";
    remoteDraft = remoteDraftOf(null);
    remoteTestText = "";
    remoteTestOk = false;
    renderRemotePop();
    return;
  }
  if (event.target.closest("[data-remote-edit]")) {
    const id = event.target.closest("[data-remote-edit]").dataset.remoteEdit;
    const server = asArray(remoteServers).find((s) => String(s.id) === String(id));
    if (!server) {
      toast("\u8FD9\u6761\u914D\u7F6E\u4E0D\u5B58\u5728\u4E86\uFF0C\u8BF7\u91CD\u65B0\u6253\u5F00", true);
      return;
    }
    remoteEditing = String(id);
    remoteDraft = remoteDraftOf(server);
    remoteTestText = "";
    remoteTestOk = false;
    renderRemotePop();
    return;
  }
  if (event.target.closest("[data-remote-type]")) {
    stashRemoteForm();
    remoteDraft.type = event.target.closest("[data-remote-type]").dataset.remoteType;
    remoteTestText = "";
    renderRemotePop();
    return;
  }
  if (event.target.closest("[data-remote-cancel]")) {
    remoteEditing = null;
    remoteDraft = null;
    renderRemotePop();
    return;
  }
  if (event.target.closest("[data-remote-save]")) {
    saveRemoteForm();
    return;
  }
  if (event.target.closest("[data-remote-test]")) {
    testRemoteForm(event.target.closest("[data-remote-test]"));
    return;
  }
  if (event.target.closest("[data-remote-delete]")) {
    const current = remoteDraft ? remoteDraft.id : "";
    const name = remoteDraft && remoteDraft.name ? remoteDraft.name : "\u8FD9\u53F0\u670D\u52A1\u5668";
    askConfirmation("\u5220\u9664\u670D\u52A1\u5668", `\u786E\u5B9A\u5220\u9664\u300C${name}\u300D\u7684\u914D\u7F6E\uFF1F\u5DF2\u4F20\u8FC7\u53BB\u7684\u6587\u4EF6\u4E0D\u53D7\u5F71\u54CD\u3002`, "\u5220\u9664").then((ok) => {
      if (!ok || !current) return;
      api("remote-delete", { id: current }).then(async () => {
        remoteServers = null;
        await loadRemoteServers(true);
        remoteEditing = null;
        remoteDraft = null;
        renderRemotePop();
        toast("\u5DF2\u5220\u9664");
      }).catch((error) => toast(error.message, true));
    });
    return;
  }
  if (event.target.closest("[data-remote-pick]")) {
    startRemoteTransfer(remotePickerTaskId, event.target.closest("[data-remote-pick]").dataset.remotePick);
    return;
  }
  if (event.target.closest("[data-remote-pick-close]")) {
    closeRemotePicker();
    return;
  }
  if (event.target.closest("[data-dl-transfer]")) {
    const button = event.target.closest("[data-dl-transfer]");
    const head = button.closest(".download-task");
    const title = head ? (head.querySelector(".download-task-head strong") || {}).textContent : "";
    openRemotePicker(button.dataset.dlTransfer, title);
    return;
  }
  if (event.target.closest("[data-dl-transfer-cancel]")) {
    const id = event.target.closest("[data-dl-transfer-cancel]").dataset.dlTransferCancel;
    api("remote-transfer-cancel", { id }).then(() => {
      toast("\u5DF2\u53D6\u6D88\u4F20\u8F93");
      refreshCurrentDownloads();
    }).catch((error) => toast(error.message, true));
    return;
  }
  const openUrl = event.target.closest("[data-open-url]");
  if (openUrl) {
    api("open-url", { url: openUrl.dataset.openUrl }).catch((error) => toast(error.message, true));
    return;
  }
  if (event.target.closest("[data-downloads]")) {
    goDownloads();
    return;
  }
  if (event.target.closest("[data-download]")) {
    showDownloadSheet();
    return;
  }
  if (event.target === downloadOverlay) {
    hideDownloadSheet();
    return;
  }
  if (event.target.closest("[data-dl-pick]")) {
    const pick = event.target.closest("[data-dl-pick]").dataset.dlPick;
    if (pick === "remote") {
      loadRemoteServers(true).then((list) => {
        if (!asArray(list).length) {
          toast("\u8FD8\u6CA1\u6709\u8FDC\u7A0B\u670D\u52A1\u5668\uFF0C\u8BF7\u5148\u5230\u300C\u8BBE\u7F6E \u2192 \u8FDC\u7A0B\u670D\u52A1\u5668\u300D\u6DFB\u52A0", true);
          return;
        }
        downloadMode = "remote";
        renderDownloadSheet();
      });
      return;
    }
    submitDownloadTo(pick);
    return;
  }
  if (event.target.closest("[data-dl-remote]")) {
    submitDownloadTo("remote", event.target.closest("[data-dl-remote]").dataset.dlRemote);
    return;
  }
  if (event.target.closest("[data-dl-back-target]")) {
    downloadMode = "target";
    renderDownloadSheet();
    return;
  }
  if (event.target.closest("[data-dl-back]")) {
    hideDownloadSheet();
    return;
  }
  if (event.target.closest("[data-dl-confirm]")) {
    downloadMode = "target";
    renderDownloadSheet();
    return;
  }
  if (event.target.closest("[data-dl-all]")) {
    const episodes = asArray(state.detail.episodes).map((ep) => Number(ep.number) || 0);
    const allSelected = episodes.length && episodes.every((n) => downloadSelection.has(n));
    downloadSelection.clear();
    if (!allSelected) episodes.forEach((n) => downloadSelection.add(n));
    renderDownloadSheet();
    return;
  }
  if (event.target.closest("[data-dl-ep]")) {
    const n = Number(event.target.closest("[data-dl-ep]").dataset.dlEp);
    if (downloadSelection.has(n)) downloadSelection.delete(n);
    else downloadSelection.add(n);
    renderDownloadSheet();
    return;
  }
  if (event.target.closest("[data-dl-play]")) {
    const id = event.target.closest("[data-dl-play]").dataset.dlPlay;
    api("open-local-player", { id }).then(() => toast("\u6B63\u5728\u64AD\u653E\u672C\u5730\u6210\u54C1")).catch((error) => toast(error.message || "\u672C\u5730\u6587\u4EF6\u4E0D\u53EF\u64AD\u653E", true));
    return;
  }
  if (event.target.closest("[data-dl-play-device]")) {
    const id = event.target.closest("[data-dl-play-device]").dataset.dlPlayDevice;
    const task = (state.deviceTasks || []).find((t) => String(t.id) === String(id));
    if (!task) return;
    if (!task.url) {
      toast(task.merged ? "\u8FD9\u53F0\u8BBE\u5907\u6CA1\u6709\u53EF\u7528\u7684\u5C40\u57DF\u7F51\u5730\u5740\uFF0C\u786E\u8BA4\u5728\u540C\u4E00 Wi-Fi" : "\u5BF9\u9762\u8FD8\u6CA1\u5408\u5E76\u6210\u54C1\uFF0C\u7B49\u5B83\u5408\u5E76\u597D\u518D\u64AD");
      return;
    }
    api("open-desktop-player", { url: task.url, title: task.title }).catch((error) => toast(error.message || "\u6253\u5F00\u5931\u8D25"));
    return;
  }
  if (event.target.closest("[data-dl-play-nas]")) {
    const id = event.target.closest("[data-dl-play-nas]").dataset.dlPlayNas;
    api("open-nas-player", { id }).then(() => toast("\u6B63\u5728\u64AD\u653E NAS \u6210\u54C1")).catch((error) => toast(error.message || "NAS \u6210\u54C1\u4E0D\u53EF\u64AD\u653E", true));
    return;
  }
  if (event.target.closest("[data-dl-cancel]")) {
    const button = event.target.closest("[data-dl-cancel]");
    const kind = button.dataset.dlCancel, id = button.dataset.dlId;
    const action = kind === "nas" ? "nas-download-cancel" : "download-cancel";
    api(action, { id }).then(() => {
      toast("\u5DF2\u53D6\u6D88\u4EFB\u52A1");
      removeDownloadRow(kind, id);
      refreshCurrentDownloads();
    }).catch((error) => toast(error.message, true));
    return;
  }
  if (event.target.closest("[data-dl-copy]")) {
    const node = event.target.closest("[data-dl-copy]");
    const log = (node.dataset.dlLog || "").replace(/\\n/g, "\n");
    if (log) {
      api("copy-text", { text: log }).then(() => toast("\u65E5\u5FD7\u5DF2\u590D\u5236\u5230\u526A\u8D34\u677F")).catch(() => toast("\u590D\u5236\u5931\u8D25", true));
    }
    return;
  }
  if (event.target.closest("[data-dl-retry]")) {
    const button = event.target.closest("[data-dl-retry]");
    const id = button.dataset.dlId;
    api("download-retry", { id }).then(() => {
      toast("\u5DF2\u91CD\u65B0\u5F00\u59CB\u4E0B\u8F7D");
      refreshCurrentDownloads();
    }).catch((error) => toast(error.message, true));
    return;
  }
  if (event.target.closest("[data-dl-merge]")) {
    const button = event.target.closest("[data-dl-merge]");
    const kind = button.dataset.dlMerge, id = button.dataset.dlId;
    const action = kind === "nas" ? "nas-download-merge" : "download-merge";
    api(action, { id }).then(() => {
      toast("\u5DF2\u5F00\u59CB\u5408\u5E76");
      refreshCurrentDownloads();
    }).catch((error) => toast(error.message, true));
    return;
  }
  if (event.target.closest("[data-dl-retry-failed]")) {
    const button = event.target.closest("[data-dl-retry-failed]");
    const id = button.dataset.dlId;
    api("nas-download-retry-failed", { id }).then(() => {
      toast("\u5DF2\u5F00\u59CB\u91CD\u8BD5\u5931\u8D25\u96C6\uFF08\u5DF2\u4E0B\u8F7D\u5206\u96C6\u4FDD\u7559\uFF09");
      refreshCurrentDownloads();
    }).catch((error) => toast(error.message, true));
    return;
  }
  if (event.target.closest("[data-dl-delete]")) {
    const button = event.target.closest("[data-dl-delete]");
    const kind = button.dataset.dlDelete, id = button.dataset.dlId;
    const action = kind === "nas" ? "nas-download-cancel" : "download-delete";
    const ids = (button.dataset.dlSiblings || "").split(",").filter(Boolean);
    ids.unshift(id);
    const chain = ids.reduce((p, cid) => p.then(() => api(action, { id: cid }).catch((e) => toast(e.message, true))), Promise.resolve());
    chain.then(() => {
      toast("\u5DF2\u5220\u9664\u4E0B\u8F7D\u5185\u5BB9");
      refreshCurrentDownloads();
    }).catch(() => {
    });
    return;
  }
  function removeDownloadRow(kind, id) {
    const button = document.querySelector(`[data-dl-delete="${kind}"][data-dl-id="${id}"], [data-dl-cancel="${kind}"][data-dl-id="${id}"]`);
    if (!button) return;
    const card2 = button.closest(".download-task");
    if (!card2 || !card2.parentElement) return;
    const list = card2.parentElement;
    card2.remove();
    if (list && !list.querySelector(".download-task")) {
      list.innerHTML = '<div class="empty-state">\u8FD8\u6CA1\u6709\u4E0B\u8F7D\u5185\u5BB9\uFF0C\u53BB\u8BE6\u60C5\u9875\u70B9\u51FB\u300C\u4E0B\u8F7D\u300D\u5427</div>';
    }
  }
  function refreshCurrentDownloads() {
    if (state.route === "library" && state.libraryTab === "downloads") renderLibraryDownloads();
    else if (state.route === "downloads") refreshDownloads(routeToken, true);
  }
  if (event.target.closest("[data-choose-avatar]")) {
    api("choose-avatar").catch((error) => toast(error.message, true));
    return;
  }
  if (event.target.closest("[data-account-action]")) {
    if (state.account.loggedIn) openAccountPop();
    else {
      if (accountPop && !accountPop.hidden) closeAccountPop();
      showAuth();
    }
    return;
  }
  if (event.target.closest("[data-sync-now]")) {
    try {
      await api("sync");
      state.library = await api("library");
      toast("\u7247\u5355\u5DF2\u540C\u6B65");
    } catch (error) {
      toast(`\u540C\u6B65\u5931\u8D25\uFF1A${error.message}`, true);
    }
    return;
  }
  if (event.target.closest("[data-logout]")) {
    const button = event.target.closest("[data-logout]");
    if (button.disabled) return;
    button.disabled = true;
    button.classList.add("is-loading");
    button.setAttribute("aria-busy", "true");
    button.textContent = "\u6B63\u5728\u9000\u51FA\u2026";
    try {
      setAccount(await api("logout"));
      state.library = await api("library");
      if (accountPop && !accountPop.hidden) closeAccountPop();
      setRoute("settings");
      renderSettings();
      showAuth();
      toast("\u5DF2\u9000\u51FA\u767B\u5F55");
    } catch (error) {
      toast(error.message, true);
    } finally {
      if (button.isConnected) {
        button.disabled = false;
        button.classList.remove("is-loading");
        button.removeAttribute("aria-busy");
        button.textContent = "\u9000\u51FA\u767B\u5F55";
      }
    }
    return;
  }
  const nav = event.target.closest("[data-nav]");
  if (nav) {
    tapDock(nav);
    return;
  }
  const libraryTab = event.target.closest("[data-library-tab]");
  if (libraryTab) {
    state.libraryTab = libraryTab.dataset.libraryTab;
    renderLibrary();
    scroll.scrollTop = 0;
    return;
  }
  if (event.target.closest("[data-all-history]")) {
    state.libraryQuery = "";
    goLibrary("history");
    return;
  }
  const continueCard = event.target.closest("[data-continue-id]");
  if (continueCard) {
    resumeFromHome(continueCard.dataset.continueId).catch((error) => toast(error.message || "\u7EED\u64AD\u5931\u8D25\uFF0C\u8BF7\u91CD\u8BD5", true));
    return;
  }
  const historyCard = event.target.closest("[data-history-id]");
  if (historyCard) {
    const id = historyCard.dataset.historyId;
    if (historyCard.dataset.historyCompleted === "true") goDetail(id, historyCard);
    else goDetail(id).then(() => openPlayer(Number(historyCard.dataset.historyEpisode || 1)));
    return;
  }
  if (event.target.closest("[data-all-tags]")) {
    goTags();
    return;
  }
  const tagChoice = event.target.closest("[data-tag-slug]");
  if (tagChoice) {
    goTag(tagChoice.dataset.tagSlug, tagChoice.dataset.tagName);
    return;
  }
  const sub = event.target.closest("[data-sub]");
  if (sub) {
    goCategory(state.tab, Number(sub.dataset.sub), !!sub.closest("#compact-category"));
    return;
  }
  const card = event.target.closest("[data-open-id]");
  if (card == null ? void 0 : card.dataset.openId) {
    if (heroTapGuard(card)) return;
    goDetail(card.dataset.openId, card);
    return;
  }
  const filter = event.target.closest("[data-filter]");
  if (filter) {
    state.filter = filter.dataset.filter;
    renderSearch();
    return;
  }
  const slide = event.target.closest("[data-slide]");
  if (slide) {
    const target = Number(slide.dataset.slide);
    changeBanner(target, target > bannerIndex() ? 1 : -1);
    return;
  }
  if (event.target.closest("[data-back]")) {
    window.hgBack();
    return;
  }
  const episode = event.target.closest("[data-episode]");
  if (episode) {
    openPlayer(Number(episode.dataset.episode));
    return;
  }
  if (event.target.closest("[data-play]")) {
    openPlayer(resumeEpisode(), resumeRestart());
    return;
  }
  if (event.target.closest("[data-restart]")) {
    openPlayer(1, true);
    return;
  }
  if (event.target.closest("[data-bookmark]")) {
    if (!state.detail) return;
    try {
      state.bookmarked = await api("bookmark", state.detail);
      renderDetail();
      toast(state.bookmarked ? "\u5DF2\u52A0\u5165\u6211\u7684\u7247\u5355" : "\u5DF2\u53D6\u6D88\u6536\u85CF");
    } catch (error) {
      toast(error.message, true);
    }
    return;
  }
  if (event.target.closest("[data-retry-category]")) {
    state.category.error = false;
    loadMoreCategory();
    return;
  }
  const more = event.target.closest("[data-more]");
  if (more) {
    openListing(more.dataset.more);
    return;
  }
  if (event.target.closest("[data-retry-listing]")) {
    state.listing.error = false;
    loadMoreListing();
    return;
  }
  const retry = event.target.closest("[data-retry]");
  if (retry) {
    if (retry.dataset.retry === "home") goHome();
    else if (retry.dataset.retry === "category") goCategory(state.tab);
    else if (retry.dataset.retry === "library") goLibrary();
    else if (retry.dataset.retry === "search") goSearch(state.query);
    else if (retry.dataset.retry === "listing") openListing(state.listing.kind);
    else if (retry.dataset.retry === "tags") goTags();
    else if (retry.dataset.retry === "tag-list") goTag(state.listing.slug, state.listing.label);
    else if (retry.dataset.retry === "detail") goDetail(state.sourceItem.id);
    return;
  }
  const clear = event.target.closest("[data-clear]");
  if (clear) {
    if (clear.dataset.clear === "cache") {
      if (!await askConfirmation("\u6E05\u7406\u5185\u5BB9\u7F13\u5B58", "\u5C06\u5220\u9664\u5DF2\u7F13\u5B58\u7684\u76EE\u5F55\u548C\u5C01\u9762\u3002\u6536\u85CF\u4E0E\u89C2\u770B\u8FDB\u5EA6\u4F1A\u4FDD\u7559\u3002", "\u6E05\u7406")) return;
      await api("clear-content-cache");
      toast("\u5185\u5BB9\u7F13\u5B58\u5DF2\u6E05\u7A7A");
    } else if (clear.dataset.clear === "history" || clear.dataset.clear === "bookmarks") {
      const history = clear.dataset.clear === "history";
      if (!await askConfirmation(history ? "\u6E05\u7A7A\u89C2\u770B\u5386\u53F2" : "\u6E05\u7A7A\u6211\u7684\u6536\u85CF", history ? "\u6240\u6709\u89C2\u770B\u8BB0\u5F55\u4F1A\u88AB\u5220\u9664\uFF0C\u6211\u7684\u6536\u85CF\u4F1A\u4FDD\u7559\u3002" : "\u6240\u6709\u6536\u85CF\u4F5C\u54C1\u4F1A\u88AB\u79FB\u9664\uFF0C\u89C2\u770B\u5386\u53F2\u4F1A\u4FDD\u7559\u3002")) return;
      await api(history ? "clear-history" : "clear-bookmarks");
      state.library = await api("library");
      renderSettings();
      toast(history ? "\u89C2\u770B\u5386\u53F2\u5DF2\u6E05\u7A7A" : "\u6536\u85CF\u5DF2\u6E05\u7A7A");
    }
  }
});
let heroTouch;
let heroSuppressClickUntil = 0;
let heroTapSuppressed = false;
function heroTapGuard(el) {
  if (!el || !el.closest || !el.closest(".hero")) return false;
  if (performance.now() < heroSuppressClickUntil) return true;
  if (heroTapSuppressed) {
    heroTapSuppressed = false;
    return true;
  }
  return false;
}
function heroOwnsGesture(event) {
  var _a2, _b2;
  return !!((_b2 = (_a2 = event.target).closest) == null ? void 0 : _b2.call(_a2, ".hero")) && event.touches.length === 1;
}
function heroBuildPartner(ht, dir) {
  const slides = bannerSlides();
  const count = slides.length;
  if (count < 2) return null;
  if (ht.partner && ht.partnerDir === dir) return ht.partner;
  if (ht.partner) {
    ht.partner.remove();
    ht.partner = null;
  }
  const idx = (bannerIndex() + dir + count) % count;
  const item = slides[idx];
  const template = document.createElement("template");
  template.innerHTML = state.route === "category" ? categorySlide(item, idx, count) : heroSlide(item, idx, count);
  const node = template.content.firstElementChild;
  node.style.transition = "none";
  node.style.transform = `translateX(${dir > 0 ? 100 : -100}%)`;
  ht.hero.appendChild(node);
  const img = node.querySelector("img");
  if (img) {
    getCover(item.cover).then((src) => {
      if (ht.partner === node && src) img.src = src;
    }).catch(() => {
    });
    if (item.kind !== "campaign" && state.route === "home") {
      getCover(item.cover).then(() => {
        if (ht.partner === node) applyBannerPalette(img);
      }).catch(() => {
      });
    }
  }
  ht.partner = node;
  ht.partnerDir = dir;
  return node;
}
function heroCommit(ht, dir, targetIndex) {
  const cur = ht.current, partner = ht.partner, hero = ht.hero;
  if (!partner) {
    changeBanner(targetIndex, dir);
    return;
  }
  bannerChanging = true;
  cur.classList.add("animating");
  partner.classList.add("animating");
  cur.style.transition = "";
  partner.style.transition = "";
  cur.style.transform = `translateX(${dir > 0 ? -100 : 100}%)`;
  partner.style.transform = "translateX(0)";
  if (state.route === "category") state.categoryBanner = targetIndex;
  else state.banner = targetIndex;
  content.querySelectorAll(".hero-dots [data-slide]").forEach((dot) => dot.classList.toggle("active", Number(dot.dataset.slide) === targetIndex));
  setTimeout(() => {
    if (hero.isConnected && cur.isConnected) cur.remove();
    partner.classList.remove("animating");
    partner.style.transform = "";
    partner.style.transition = "";
    bannerChanging = false;
    scheduleBannerAuto();
  }, 340);
}
function heroSnap(ht, dir) {
  const cur = ht.current, partner = ht.partner;
  if (cur) {
    cur.classList.add("animating");
    cur.style.transition = "";
    cur.style.transform = "translateX(0)";
    setTimeout(() => {
      if (cur.isConnected) {
        cur.classList.remove("animating");
        cur.style.transform = "";
        cur.style.transition = "";
      }
    }, 340);
  }
  if (partner) {
    partner.classList.add("animating");
    partner.style.transition = "";
    partner.style.transform = `translateX(${dir > 0 ? 100 : -100}%)`;
    setTimeout(() => {
      if (partner.isConnected) partner.remove();
    }, 340);
  }
}
content.addEventListener("touchstart", (event) => {
  if (!heroOwnsGesture(event)) return;
  if (bannerChanging) return;
  stopBannerAuto();
  heroTapSuppressed = false;
  const touch = event.touches[0];
  const hero = content.querySelector(".hero");
  const current = hero && hero.querySelector(".hero-slide");
  if (!hero || !current) {
    heroTouch = null;
    return;
  }
  const rect = hero.getBoundingClientRect();
  heroTouch = { x: touch.clientX, y: touch.clientY, moved: false, axis: null, hero, current, width: rect.width, dx: 0, dir: 0, partner: null, partnerDir: 0 };
}, { passive: true });
content.addEventListener("touchmove", (event) => {
  if (!heroTouch || !event.touches.length) return;
  const t = event.touches[0];
  const dx = t.clientX - heroTouch.x, dy = t.clientY - heroTouch.y;
  if (!heroTouch.axis) {
    if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
    heroTouch.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
    if (heroTouch.axis === "x") {
      heroTouch.moved = true;
      heroTouch.current.style.transition = "none";
    }
  }
  if (heroTouch.axis !== "x") {
    heroSuppressClickUntil = performance.now() + 600;
    heroTapSuppressed = true;
    return;
  }
  heroSuppressClickUntil = performance.now() + 600;
  heroTapSuppressed = true;
  const dxv = Math.max(-heroTouch.width, Math.min(heroTouch.width, dx));
  heroTouch.dx = dxv;
  const dir = dxv < 0 ? 1 : -1;
  heroTouch.dir = dir;
  heroBuildPartner(heroTouch, dir);
  heroTouch.current.style.transform = `translateX(${dxv}px)`;
  if (heroTouch.partner) {
    heroTouch.partner.style.transition = "none";
    heroTouch.partner.style.transform = `translateX(calc(${dir > 0 ? 100 : -100}% + ${dxv}px))`;
  }
}, { passive: true });
content.addEventListener("touchend", (event) => {
  if (!heroTouch) return;
  const ht = heroTouch;
  heroTouch = null;
  scheduleBannerAuto();
  if (ht.axis !== "x" || !ht.moved) return;
  const dx = ht.dx, dir = ht.dir, count = bannerSlides().length;
  if (count < 2) {
    heroSnap(ht, dir);
    return;
  }
  const threshold = Math.max(42, ht.width * 0.18);
  if (Math.abs(dx) >= threshold) heroCommit(ht, dir, (bannerIndex() + dir + count) % count);
  else heroSnap(ht, dir);
}, { passive: true });
content.addEventListener("touchcancel", () => {
  if (!heroTouch) return;
  const ht = heroTouch;
  heroTouch = null;
  heroSuppressClickUntil = performance.now() + 600;
  heroTapSuppressed = true;
  heroSnap(ht, ht.dir);
  scheduleBannerAuto();
}, { passive: true });
scroll.addEventListener("scroll", () => {
  if (!heroTouch) return;
  heroSuppressClickUntil = performance.now() + 600;
  heroTapSuppressed = true;
}, { passive: true });
api("app-version").then((version) => {
  appVersion = String(version || "");
  const label = content.querySelector(".app-version-text");
  if (label) label.textContent = `\u7248\u672C v${appVersion}`;
  setAvailableUpdate(updateAvailable);
}).catch(() => {
});
api("cached-update").then((result) => {
  if (result.status === "available") setAvailableUpdate(result);
}).catch(() => {
});
function startHome() {
  window.__bingeRestore && window.__bingeRestore();
  if (state.binge) armBingeBootFallback();
  else clearBingeBoot();
  goHome().then(() => {
    window.__bingeRestore && window.__bingeRestore();
  }).catch(() => {
  });
  setTimeout(() => checkUpdate(false), 3e3);
}
api("crash-log").then((result) => {
  const log = (result && result.log || "").trim();
  if (log) {
    api("copy-text", { text: log }).then(() => {
    }).catch(() => {
    });
    toast("\u68C0\u6D4B\u5230\u4E0A\u6B21\u8FD0\u884C\u53D1\u751F\u5D29\u6E83\uFF0C\u5D29\u6E83\u65E5\u5FD7\u5DF2\u590D\u5236\u5230\u526A\u8D34\u677F\uFF0C\u8BF7\u7C98\u8D34\u53D1\u7ED9\u5F00\u53D1\u8005", true);
  }
}).catch(() => {
});
document.getElementById("age-confirm").addEventListener("click", async () => {
  await api("confirm-private-age");
  location.reload();
});
document.getElementById("age-exit").textContent = "\u8FD4\u56DE\u7EA2\u679C";
document.getElementById("age-exit").addEventListener("click", () => {
  document.getElementById("age-gate").hidden = true;
});
contentReady.then(() => startHome()).catch((error) => renderError(error, "home"));
setTimeout(() => {
  swipePrefetchAll().catch(() => {
  });
}, 5e3);
let pendingResourceRevision = 0;
let resourceApplyTimer = null;
let resourceApplyRequested = false;
let lastResourceInteraction = performance.now();
const resourceIdleMs = 3e3;
window.hgCanApplyHotUpdate = () => {
  var _a2;
  return ["home", "settings"].includes(state.route) && !document.hidden && document.hasFocus() && (state.route !== "home" || scroll.scrollTop <= 4) && authOverlay.hidden && confirmOverlay.hidden && updateOverlay.hidden && unlockOverlay.hidden && document.getElementById("age-gate").hidden && !["INPUT", "TEXTAREA"].includes((_a2 = document.activeElement) == null ? void 0 : _a2.tagName) && !bannerChanging && !heroTouch && !predictivePreview && !predictiveFrame && !document.getElementById("app").classList.contains("card-transition-active") && !document.getElementById("app").classList.contains("predictive-active");
};
function scheduleResourceApply(delay) {
  if (resourceApplyRequested) return;
  clearTimeout(resourceApplyTimer);
  resourceApplyTimer = null;
  if (!pendingResourceRevision || resourceApplyRequested || document.hidden || !document.hasFocus()) return;
  resourceApplyTimer = setTimeout(tryApplyResources, delay != null ? delay : Math.max(
    150,
    resourceIdleMs - (performance.now() - lastResourceInteraction)
  ));
}
function tryApplyResources() {
  resourceApplyTimer = null;
  if (!pendingResourceRevision || resourceApplyRequested) return;
  if (state.route !== "home" || !window.hgCanApplyHotUpdate() || !content.querySelector(".home-page,.error-state") || performance.now() - lastResourceInteraction < resourceIdleMs) {
    scheduleResourceApply(750);
    return;
  }
  resourceApplyRequested = true;
  api("apply-hot-update").catch(() => {
  });
  resourceApplyTimer = setTimeout(() => {
    resourceApplyRequested = false;
    window.hgRefreshPendingResources();
  }, 2e3);
}
window.hgScheduleResourceApply = () => {
  lastResourceInteraction = performance.now();
  scheduleResourceApply();
};
window.hgRefreshPendingResources = () => {
  if (!document.hidden && document.hasFocus()) api("hot-update-status").then(window.hgHotUpdateStatus).catch(() => {
  });
};
window.hgHotUpdateStatus = (result) => {
  var _a2, _b2;
  const resourceSection = (_a2 = content.querySelector("[data-resource-status]")) == null ? void 0 : _a2.closest("section");
  if (resourceSection && result.enabled === false) resourceSection.hidden = true;
  const label = content.querySelector("[data-resource-status]");
  if (label) label.textContent = result.pending ? "\u8D44\u6E90\u5DF2\u4E0B\u8F7D\uFF0C\u9996\u9875\u7A7A\u95F2\u65F6\u81EA\u52A8\u542F\u7528\u3002" : "\u5F53\u524D\u8D44\u6E90\uFF1A" + (result.version || "\u5185\u7F6E") + "\uFF0C\u540E\u53F0\u81EA\u52A8\u66F4\u65B0\u3002";
  const apply = content.querySelector("[data-apply-resources]");
  if (apply) apply.hidden = !result.pending;
  pendingResourceRevision = Number(result.pending) > Number(((_b2 = window.HotRuntime) == null ? void 0 : _b2.revision) || 0) ? Number(result.pending) : 0;
  if (!pendingResourceRevision) resourceApplyRequested = false;
  scheduleResourceApply();
};
function resourceInteraction() {
  lastResourceInteraction = performance.now();
  if (!resourceApplyRequested) scheduleResourceApply();
}
for (const type of ["pointerdown", "pointermove", "pointerup", "keydown", "input", "focusin", "focusout", "wheel"])
  document.addEventListener(type, resourceInteraction, { capture: true, passive: true });
document.addEventListener("scroll", resourceInteraction, { capture: true, passive: true });
window.addEventListener("blur", () => {
  clearTimeout(resourceApplyTimer);
  resourceApplyTimer = null;
  resourceApplyRequested = false;
});
window.addEventListener("focus", () => {
  resourceInteraction();
  window.hgRefreshPendingResources();
});
document.addEventListener("visibilitychange", () => {
  clearTimeout(resourceApplyTimer);
  resourceApplyTimer = null;
  resourceApplyRequested = false;
  if (!document.hidden) {
    resourceInteraction();
    window.hgRefreshPendingResources();
  }
});
api("hot-update-status").then(window.hgHotUpdateStatus).catch(() => {
});
(_b = window.hgBootReady) == null ? void 0 : _b.call(window);
function closeUnlock() {
  unlockOverlay.hidden = true;
  updateBackEnabled();
  document.getElementById("unlock-password").value = "";
}
async function enterPrivate(password = "") {
  const result = await api("enter-private", { password });
  closeUnlock();
  if (result.needsAgeConfirmation) document.getElementById("age-gate").hidden = false;
  else location.reload();
}
async function handleEnterPrivate() {
  if (privateMode()) return;
  try {
    const status = await api("content-status");
    if (status.unlocked) {
      await enterPrivate();
      return;
    }
    document.getElementById("unlock-error").hidden = true;
    unlockOverlay.hidden = false;
    updateBackEnabled();
    document.getElementById("unlock-password").focus();
  } catch (error) {
    toast(error.message, true);
  }
}
document.getElementById("unlock-close").addEventListener("click", closeUnlock);
document.getElementById("unlock-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.target.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await enterPrivate(document.getElementById("unlock-password").value);
  } catch (error) {
    const label = document.getElementById("unlock-error");
    label.textContent = error.message;
    label.hidden = false;
  } finally {
    button.disabled = false;
  }
});
const bingeFab = document.getElementById("binge-fab");
const BINGE_STORE_KEY = "veyra.binge.v2";
let bingePayload = null;
let bingeCurrentId = null;
let bingeCurrentIndex = 0;
let bingeEngineLive = false;
let bingeStarting = false;
function bingePoolItems() {
  var _a2, _b2;
  const data = state.home || {};
  const pool = [
    ...asArray(data.homepageRecommend),
    ...asArray((_a2 = data.recommend) == null ? void 0 : _a2.items),
    ...asArray(data.homepageNewest),
    ...asArray((_b2 = data.newest) == null ? void 0 : _b2.items)
  ];
  const seen = /* @__PURE__ */ new Set();
  return pool.filter((item) => item && item.id && item.cover && item.kind !== "campaign" && !seen.has(String(item.id)) && seen.add(String(item.id)));
}
function saveBingePref() {
  try {
    if (!state.binge || !bingePayload || !bingePayload.items || !bingePayload.items.length) {
      localStorage.removeItem(BINGE_STORE_KEY);
      return;
    }
    localStorage.setItem(BINGE_STORE_KEY, JSON.stringify({
      on: true,
      source: contentSource,
      items: bingePayload.items,
      index: bingeCurrentIndex
    }));
  } catch (error) {
  }
}
function readBingePref() {
  try {
    const raw = JSON.parse(localStorage.getItem(BINGE_STORE_KEY) || "null");
    if (!raw || !raw.on || !Array.isArray(raw.items) || !raw.items.length) return null;
    if (raw.source && raw.source !== contentSource) return null;
    return raw;
  } catch (error) {
    return null;
  }
}
function updateBingeChrome() {
  if (!bingeFab) return;
  const show = !privateMode() && state.route === "home" && (state.binge || bingePoolItems().length > 0);
  bingeFab.hidden = !show;
  const play = bingeFab.querySelector(".binge-fab-play");
  const home = bingeFab.querySelector(".binge-fab-home");
  if (play) play.hidden = false;
  if (home) home.hidden = true;
  bingeFab.classList.toggle("active", !!state.binge);
  bingeFab.setAttribute("aria-pressed", state.binge ? "true" : "false");
}
window.__bingeUpdateChrome = updateBingeChrome;
let bingeBootTimer = 0;
function clearBingeBoot() {
  clearTimeout(bingeBootTimer);
  bingeBootTimer = 0;
  document.documentElement.removeAttribute("data-binge-boot");
  const cover = document.getElementById("binge-boot-cover");
  if (cover && cover.parentNode) cover.parentNode.removeChild(cover);
}
function armBingeBootFallback() {
  clearTimeout(bingeBootTimer);
  bingeBootTimer = setTimeout(clearBingeBoot, 4e3);
}
window.__bingeBootClear = clearBingeBoot;
window.hgBingePosterReady = () => clearBingeBoot();
function syncBinge() {
  const app = document.getElementById("app");
  const binge = document.getElementById("binge");
  const hasItems = !!(bingePayload && bingePayload.items && bingePayload.items.length);
  const want = !!state.binge && hasItems && !privateMode();
  const visible = want && state.route === "home";
  app == null ? void 0 : app.classList.toggle("binge", visible);
  document.body.classList.toggle("binge", visible);
  if (binge) binge.hidden = !visible;
  updateBingeChrome();
  if (visible) {
    if (!bingeEngineLive) startBingeEngine();
    else if (window.api) api("binge-resume").catch(() => {
    });
  } else if (bingeEngineLive && window.api) {
    api("binge-pause").catch(() => {
    });
  }
  if (!visible) clearBingeBoot();
}
window.__bingeSync = syncBinge;
function startBingeEngine() {
  const items = bingePayload && bingePayload.items || [];
  if (!items.length) return;
  const index = Math.max(0, Math.min(bingeCurrentIndex, items.length - 1));
  if (!window.api || bingeStarting) return;
  bingeStarting = true;
  api("binge-start", { items, index, source: contentSource }).then(() => {
    bingeStarting = false;
    bingeEngineLive = true;
  }).catch((error) => {
    bingeStarting = false;
    bingeEngineLive = false;
    state.binge = false;
    saveBingePref();
    syncBinge();
    toast(error.message || "\u8FDB\u5165\u5237\u5267\u6A21\u5F0F\u5931\u8D25", true);
  });
}
function enterBingeFresh() {
  if (privateMode() || state.route !== "home") return;
  const items = bingePoolItems();
  if (!items.length) {
    toast("\u9996\u9875\u8FD8\u6CA1\u6709\u63A8\u8350\u5185\u5BB9\uFF0C\u7A0D\u540E\u518D\u8BD5", true);
    return;
  }
  const shuffled = items.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  bingePayload = { items: shuffled.slice(0, 40).map((item) => ({
    id: String(item.id),
    title: item.title || "",
    cover: item.cover || "",
    description: item.description || item.episodeLabel || ""
  })) };
  bingeCurrentIndex = 0;
  bingeCurrentId = null;
  state.binge = true;
  saveBingePref();
  syncBinge();
}
function exitBingeMode() {
  state.binge = false;
  bingeEngineLive = false;
  saveBingePref();
  syncBinge();
  if (window.api) api("binge-exit").catch(() => {
  });
}
function restoreBingeFromStore() {
  if (state.binge || privateMode() || state.route !== "home") return;
  const saved = readBingePref();
  if (!saved) return;
  bingePayload = { items: saved.items };
  bingeCurrentIndex = Math.max(0, Math.min(saved.index || 0, saved.items.length - 1));
  bingeCurrentId = saved.items[bingeCurrentIndex] ? saved.items[bingeCurrentIndex].id : null;
  state.binge = true;
  syncBinge();
}
window.__bingeRestore = restoreBingeFromStore;
bingeFab == null ? void 0 : bingeFab.addEventListener("click", () => {
  if (privateMode()) return;
  if (state.binge) exitBingeMode();
  else if (state.route === "home") enterBingeFresh();
});
let bingePosterSeq = 0;
function updateBingePoster(info) {
  const img = document.getElementById("binge-poster");
  const box = document.getElementById("binge-poster-box");
  if (!img || !box) return;
  const seq = ++bingePosterSeq;
  const id = String(info.id || "");
  const cover = info.cover || "";
  const isCurrent = () => seq === bingePosterSeq && String(bingeCurrentId || "") === id;
  box.hidden = true;
  img.onload = img.onerror = null;
  img.removeAttribute("src");
  if (!cover) return;
  img.alt = (info.title || "\u5F53\u524D\u5267\u96C6") + " \u6D77\u62A5";
  getCover(cover).then((src) => {
    if (!isCurrent()) return;
    img.onload = () => {
      if (isCurrent()) box.hidden = false;
    };
    img.onerror = () => {
      if (isCurrent()) {
        box.hidden = true;
        img.removeAttribute("src");
      }
    };
    img.src = src;
    if (img.complete && img.naturalWidth > 0) box.hidden = false;
  }).catch(() => {
    if (isCurrent()) box.hidden = true;
  });
}
window.hgBingeUpdate = (info) => {
  if (!info) return;
  const titleEl = document.getElementById("binge-title");
  const descEl = document.getElementById("binge-desc");
  const msgEl = document.getElementById("binge-msg");
  if (titleEl) titleEl.textContent = info.title || "";
  if (descEl) descEl.textContent = info.description || "";
  if (msgEl) msgEl.hidden = true;
  bingeCurrentId = info.id || null;
  if (typeof info.index === "number") bingeCurrentIndex = info.index;
  updateBingePoster(info);
  const card = document.getElementById("binge-card");
  if (card) card.hidden = false;
  if (document.documentElement.hasAttribute("data-binge-boot")) armBingeBootFallback();
  saveBingePref();
};
window.hgBingeFailed = (message) => {
  const msgEl = document.getElementById("binge-msg");
  if (msgEl) {
    msgEl.textContent = message || "";
    msgEl.hidden = false;
  }
  const card = document.getElementById("binge-card");
  if (card) card.hidden = true;
};
function openBingeDetail(id) {
  if (id == null) return;
  const app = document.getElementById("app");
  const layer = document.getElementById("binge");
  if (app) app.classList.remove("binge");
  document.body.classList.remove("binge");
  if (layer) layer.hidden = true;
  const scrollEl = document.getElementById("scroll");
  if (scrollEl) scrollEl.style.removeProperty("display");
  goDetail(String(id)).catch(() => {
  });
}
(_c = document.getElementById("binge-detail-btn")) == null ? void 0 : _c.addEventListener("click", () => openBingeDetail(bingeCurrentId));
(_d = document.getElementById("binge-full-btn")) == null ? void 0 : _d.addEventListener("click", () => {
  if (window.api) api("binge-full", { episode: 1 }).catch(() => {
  });
});
window.hgBingeAction = (type, id) => {
  if (type === "detail") openBingeDetail(id);
};
(function setupBingeSwipe() {
  const IGNORE = "#dock, #binge-fab, .binge-actions, .binge-msg, #toast-host";
  let tracking = false, dragging = false;
  let startX = 0, startY = 0, dy = 0, lastY = 0, lastAt = 0, velocity = 0, beginAt = 0;
  let samples = [];
  let dragAttrTimer = 0;
  function setDragging(on) {
    clearTimeout(dragAttrTimer);
    if (on) {
      document.documentElement.setAttribute("data-binge-drag", "1");
    } else {
      dragAttrTimer = setTimeout(() => {
        document.documentElement.removeAttribute("data-binge-drag");
      }, 260);
    }
  }
  const cardEl = () => document.getElementById("binge-card");
  function onScreen() {
    const layer = document.getElementById("binge");
    return !!state.binge && layer && !layer.hidden;
  }
  function bridge(phase, offset, speed) {
    const host = window.AndroidHost;
    if (!host || typeof host.bingeDrag !== "function") return;
    try {
      host.bingeDrag(phase, offset || 0, speed || 0);
    } catch (error) {
    }
  }
  function paintCard(value) {
    const card = cardEl();
    if (!card) return;
    card.style.transform = value ? "translate3d(0," + (value * 0.18).toFixed(1) + "px,0)" : "";
    card.style.opacity = value ? String(Math.max(0.74, 1 - Math.abs(value) / 900)) : "";
  }
  function begin(x, y) {
    if (!onScreen()) return;
    tracking = true;
    dragging = false;
    startX = x;
    startY = y;
    dy = 0;
    lastY = y;
    lastAt = Date.now();
    beginAt = lastAt;
    velocity = 0;
    samples = [{ t: lastAt, y }];
  }
  function move(x, y) {
    if (!tracking) return;
    const deltaY = y - startY;
    const deltaX = x - startX;
    if (!dragging) {
      if (Math.hypot(deltaX, deltaY) < 10) return;
      if (Math.abs(deltaX) > Math.abs(deltaY) * 1.15) {
        tracking = false;
        return;
      }
      dragging = true;
      setDragging(true);
      bridge("start", 0, 0);
      const card = cardEl();
      if (card) {
        card.style.transition = "none";
        card.style.transform = "";
        card.style.opacity = "";
      }
    }
    const now = Date.now();
    samples.push({ t: now, y });
    while (samples.length > 2 && now - samples[0].t > 100) samples.shift();
    const first = samples[0], last = samples[samples.length - 1];
    velocity = (last.y - first.y) / Math.max(1, last.t - first.t) * 1e3;
    lastY = y;
    lastAt = now;
    dy = deltaY;
    bridge("move", dy);
  }
  function finish(cancelled) {
    if (!tracking) return;
    tracking = false;
    if (!dragging) return;
    dragging = false;
    bridge("end", dy, cancelled ? 0 : velocity);
    setDragging(false);
    dy = 0;
    velocity = 0;
    samples = [];
  }
  function fromIgnored(target) {
    return !!(target && target.closest && target.closest(IGNORE));
  }
  window.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1 || fromIgnored(e.target)) {
      tracking = false;
      return;
    }
    begin(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: true, capture: true });
  window.addEventListener("touchmove", (e) => {
    if (!tracking || e.touches.length !== 1) return;
    move(e.touches[0].clientX, e.touches[0].clientY);
    if (dragging && e.cancelable) e.preventDefault();
  }, { passive: false, capture: true });
  window.addEventListener("touchend", () => finish(false), { passive: true, capture: true });
  window.addEventListener("touchcancel", () => finish(true), { passive: true, capture: true });
  window.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "mouse" || fromIgnored(e.target)) return;
    begin(e.clientX, e.clientY);
  }, { passive: true, capture: true });
  window.addEventListener("pointermove", (e) => {
    if (e.pointerType === "mouse") move(e.clientX, e.clientY);
  }, { passive: true, capture: true });
  window.addEventListener("pointerup", (e) => {
    if (e.pointerType === "mouse") finish(false);
  }, { passive: true, capture: true });
})();
