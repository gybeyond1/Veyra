/* 设备形态：phone / tablet / tv
 *
 * 判定来源是第一优先的原生桥（AndroidHost.deviceProfile，同步返回）。
 * 浏览器里调试时用 ?device=tv / ?device=tablet 覆盖，未指定则按视口推断平板。
 * 结果写在 <html data-device>，样式表与遥控焦点全部以这个属性为准 —— 手机不加任何新规则。
 */
(function () {
  'use strict';
  if (window.__veyraDeviceReady) return;
  window.__veyraDeviceReady = true;

  var type = 'phone';
  var model = '';
  var native = false;

  try {
    if (window.AndroidHost && typeof window.AndroidHost.deviceProfile === 'function') {
      var info = JSON.parse(window.AndroidHost.deviceProfile() || '{}');
      if (info && (info.type === 'tv' || info.type === 'tablet' || info.type === 'phone')) {
        type = info.type;
        native = true;
      }
      model = info && info.model ? String(info.model) : '';
    }
  } catch (error) { /* 桥还没注入（极早期）就当手机，不阻断页面 */ }

  if (!native) {
    var forced = '';
    try { forced = (new URLSearchParams(location.search).get('device') || '').toLowerCase(); } catch (error) { }
    if (forced === 'tv' || forced === 'tablet' || forced === 'phone') type = forced;
    else if (Math.min(window.innerWidth, window.innerHeight) >= 600) type = 'tablet';
  }

  var root = document.documentElement;
  root.setAttribute('data-device', type);
  window.VEYRA_DEVICE = type;
  window.VEYRA_MODEL = model;
  window.veyraIsTv = type === 'tv';
  window.veyraIsTablet = type === 'tablet';
})();

/* 高度兜底 + 环境探针
 *
 * 不少电视 / 投影仪的 WebView 低于 Chrome 108，不认 dvh：样式里 height:100dvh 整条被丢弃，
 * #app 高度塌成 0，于是只有绝对定位在顶部的搜索框还看得见，底栏和内容全在视口外 ——
 * 表现就是「打开一片空白」。CSS 里已经补了 vh 前缀和 min-height，这里再做一次运行时实测，
 * 真塌了就直接按视口高度钉死，不管根因是 dvh 还是别的。
 */
(function () {
  var forced = false;
  function probe() {
    var app = document.getElementById('app');
    var info = {
      ua: navigator.userAgent,
      innerHeight: window.innerHeight,
      appHeight: app ? Math.round(app.getBoundingClientRect().height) : 0,
      dvh: !!(window.CSS && window.CSS.supports && window.CSS.supports('height', '100dvh')),
      device: window.VEYRA_DEVICE || ''
    };
    window.__veyraEnv = info;
    return info;
  }
  function guard() {
    var app = document.getElementById('app');
    if (!app) return;
    if (app.getBoundingClientRect().height < 50) {
      app.style.height = window.innerHeight + 'px';
      forced = true;
    } else if (forced) {
      app.style.height = '';
      forced = false;
    }
    probe();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', guard);
  else guard();
  window.addEventListener('load', guard);
  window.addEventListener('resize', guard);
  setTimeout(guard, 150);
  setTimeout(guard, 900);
})();

/* 脚本看门狗
 *
 * 老电视的 WebView 如果低于 Chrome 80，app.js 里的可选链会直接造成语法错误、整份脚本不执行，
 * 页面就停在空壳上。这时至少给一句人话，而不是让用户对着白屏猜。
 * 用 __veyraBooted 区分「脚本没跑」和「脚本跑了但数据还在路上」——后者会先画骨架屏，不会误报。
 */
setTimeout(function () {
  if (window.__veyraBooted) return;
  var host = document.getElementById('content');
  if (!host || host.firstElementChild) return;
  host.innerHTML = '<div style="padding:56px 40px;max-width:640px">'
    + '<h2 style="margin:0 0 12px;font-size:26px">页面没能启动</h2>'
    + '<p style="margin:0;font-size:16px;line-height:1.9;opacity:.72">'
    + '这台设备的系统 WebView 版本偏低，无法运行页面脚本。'
    + '请在应用商店更新「Android System WebView」或「Chrome」，再重新打开。'
    + '</p></div>';
}, 3500);
