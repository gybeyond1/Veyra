/* 扫码输入（仅电视）
 *
 * 只有 data-device=tv 时才存在这个入口：遥控选中输入框按确认，弹出二维码面板。
 * 手机 / 平板本来就能打字，不出现任何浮标、不弹面板，点输入框的行为和改动前完全一致。
 *
 * 二维码指向这台设备自己在局域网起的服务（原生 LanTextRelay），扫码后在手机浏览器里打字，
 * 文字由 window.veyraRelayFill 回填到当前输入框，并派发 input 事件，页面原有逻辑（联想、校验）照常走。
 */
(function () {
  'use strict';
  if (window.__veyraRelayReady) return;
  window.__veyraRelayReady = true;

  var isTv = window.VEYRA_DEVICE === 'tv';
  var overlay = null;
  var panel = null;
  var qrHost = null;
  var statusEl = null;
  var addrEl = null;
  var target = null;
  var link = '';
  var pollTimer = 0;
  var pollCount = 0;

  function isField(el) {
    return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.type !== 'checkbox' && el.type !== 'radio';
  }

  function bridge() {
    return window.AndroidHost || null;
  }

  function relayInfo() {
    var host = bridge();
    if (host && typeof host.relayInfo === 'function') {
      try { return JSON.parse(host.relayInfo() || '{}') || {}; } catch (error) { return {}; }
    }
    // 浏览器调试：?relay=http://192.168.1.10:8765/?t=demo 模拟一条可用地址
    var forced = '';
    try { forced = new URLSearchParams(location.search).get('relay') || ''; } catch (error) { }
    return forced ? { url: forced, address: forced.replace(/^https?:\/\//, '').split(':')[0] } : { url: '' };
  }

  function capture(enabled) {
    var host = bridge();
    if (host && typeof host.setTvCapture === 'function') {
      try { host.setTvCapture(!!enabled); } catch (error) { }
    }
  }

  function build() {
    if (overlay) return;

    overlay = document.createElement('div');
    overlay.id = 'relay-overlay';
    overlay.hidden = true;
    overlay.innerHTML = '<section class="relay-panel" role="dialog" aria-modal="true" aria-labelledby="relay-title">'
      + '<button type="button" class="relay-close" id="relay-close" aria-label="关闭">×</button>'
      + '<h2 id="relay-title">扫码输入</h2>'
      + '<p class="relay-sub">用手机扫下面的码，和这台设备连同一个 Wi-Fi，打字后内容会直接填进输入框。</p>'
      + '<div class="relay-qr" id="relay-qr"></div>'
      + '<p class="relay-addr" id="relay-addr"></p>'
      + '<p class="relay-status" id="relay-status">准备中…</p>'
      + '<button type="button" class="relay-keyboard" id="relay-keyboard" hidden>改用本机键盘输入</button>'
      + '</section>';
    document.body.appendChild(overlay);

    qrHost = overlay.querySelector('#relay-qr');
    statusEl = overlay.querySelector('#relay-status');
    addrEl = overlay.querySelector('#relay-addr');
    panel = overlay.querySelector('.relay-panel');

    overlay.querySelector('#relay-close').addEventListener('click', close);
    overlay.addEventListener('click', function (event) {
      if (event.target === overlay) close();
    });
    var keyboard = overlay.querySelector('#relay-keyboard');
    if (isTv) {
      keyboard.hidden = false;
      keyboard.addEventListener('click', function () {
        var field = target;
        close();
        capture(false);
        if (field && document.contains(field)) {
          field.removeAttribute('readonly');
          field.focus();
        }
      });
    }
  }

  function renderQr(value) {
    if (!qrHost) return;
    if (!value) {
      qrHost.innerHTML = '<div class="relay-qr-empty">服务启动中…</div>';
      return;
    }
    try {
      var qr = window.qrcode(0, 'M');
      qr.addData(value);
      qr.make();
      var count = qr.getModuleCount();
      var cell = Math.max(3, Math.floor(280 / count));
      qrHost.innerHTML = qr.createSvgTag({ cellSize: cell, margin: 2, scalable: true });
    } catch (error) {
      qrHost.innerHTML = '<div class="relay-qr-empty">二维码生成失败</div>';
    }
  }

  function refresh() {
    var info = relayInfo();
    link = info && info.url ? String(info.url) : '';
    if (link) {
      clearTimeout(pollTimer);
      pollCount = 0;
      renderQr(link);
      if (addrEl) addrEl.textContent = link.replace(/\?.*$/, '');
      if (statusEl) statusEl.textContent = '等待扫码…';
      return;
    }
    renderQr('');
    if (statusEl) statusEl.textContent = '局域网服务还没就绪，请稍候';
    if (addrEl) addrEl.textContent = '';
    pollCount += 1;
    clearTimeout(pollTimer);
    if (pollCount < 12) pollTimer = setTimeout(refresh, 400);
    else if (statusEl) statusEl.textContent = '服务未能启动，可直接用本机键盘输入';
  }

  function open(field) {
    if (!isTv) return; // 手机 / 平板不提供扫码入口，调用也无效
    build();
    if (isField(field)) target = field;
    overlay.hidden = false;
    pollCount = 0;
    refresh();
    // 电视要靠遥控操作，焦点必须落在面板里
    var closeButton = overlay.querySelector('#relay-close');
    if (closeButton) { try { closeButton.focus({ preventScroll: true }); } catch (error) { } }
  }

  function close() {
    if (!overlay || overlay.hidden) return;
    overlay.hidden = true;
    clearTimeout(pollTimer);
    if (isTv) {
      capture(true);
      document.dispatchEvent(new Event('veyra-relay-close'));
    }
  }

  document.addEventListener('focusin', function (event) {
    var field = event.target;
    if (!isField(field)) return;
    if (overlay && overlay.contains(field)) return;
    target = field; // 记录当前输入框，扫码文字回来后填这里
  });

  window.veyraRelayOpen = function (field) {
    if (!isTv) return false;
    build();
    open(field || document.activeElement);
    return true;
  };

  window.veyraRelayClose = close;

  window.veyraRelayFill = function (text) {
    var value = String(text == null ? '' : text);
    var field = null;
    if (isField(document.activeElement) && !(overlay && overlay.contains(document.activeElement))) field = document.activeElement;
    else if (target && document.contains(target) && isField(target)) field = target;
    if (!field) {
      var candidates = document.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea');
      for (var i = 0; i < candidates.length; i++) {
        var rect = candidates[i].getBoundingClientRect();
        if (rect.width > 2 && rect.height > 2) { field = candidates[i]; break; }
      }
    }
    if (!field) {
      if (statusEl) statusEl.textContent = '已收到，但当前没有可填入的输入框';
      return false;
    }
    if (!isTv) {
      try { field.focus({ preventScroll: true }); } catch (error) { }
    }
    field.value = value;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    if (statusEl) statusEl.textContent = '已收到，已填入输入框';
    setTimeout(close, 700);
    return true;
  };
})();
