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
