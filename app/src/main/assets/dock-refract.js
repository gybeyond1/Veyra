/* 液态玻璃折射 · Sunny UI 2.1 / SunnyTV circleMap（Apache-2.0）
 *
 * 圆角矩形 SDF + circleMap 只折射边缘，中心文字和图标不参与位移。
 * 本文件同时负责：
 *   1) 给真实底栏、搜索、刷剧卡片/按钮、预览与弹窗统一挂载材质；
 *   2) 动态节点扫描与移除后的资源释放；
 *   3) 外观滑杆实时更新 SVG 模糊和几何折射，不重建业务 DOM。
 * 位移纹理只有几何信息，不读取页面截图或业务内容。
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || !window.document) return;

  var ua = navigator.userAgent || '';
  var isChromium = /(?:Chrome|Chromium|Edg)\//.test(ua) && !/(?:CriOS|EdgiOS)\//.test(ua);
  var CSSok = !!(window.CSS && CSS.supports && (
    CSS.supports('backdrop-filter', 'blur(2px)') ||
    CSS.supports('-webkit-backdrop-filter', 'blur(2px)')));
  var canRefract = isChromium && CSSok;

  var NS = 'http://www.w3.org/2000/svg';
  var SCALE = 28;
  var MAX_EDGE = 640;
  var serial = 0;
  var mounted = [];
  var hostSvg = null;
  var scanQueued = 0;

  var RULES = [
    { selector: '#dock', depth: 18, push: 14 },
    { selector: '#dock-blob b', depth: 12, push: 9 },
    { selector: '.search-form', depth: 12, push: 9 },
    { selector: '#search-suggest', depth: 16, push: 11 },
    { selector: '.header-settings', depth: 10, push: 7 },
    { selector: '#binge-fab', depth: 12, push: 9 },
    { selector: '.binge-card', depth: 16, push: 11 },
    { selector: '.ap-preview-dock', depth: 18, push: 14 },
    { selector: '.ap-preview-dock > i > b', depth: 12, push: 9 },
    { selector: '.appearance-pop', depth: 18, push: 14 },
    { selector: '#unlock-overlay .auth-panel', depth: 18, push: 14 },
    { selector: '.confirm-panel', depth: 18, push: 14 },
    { selector: '.download-panel', depth: 18, push: 14 },
    { selector: '.update-panel', depth: 18, push: 14 },
    { selector: '.age-panel', depth: 18, push: 14 }
  ];
  var TARGETS = RULES.map(function (rule) { return rule.selector; }).join(',');

  function el(name, attrs) {
    var node = document.createElementNS(NS, name);
    for (var key in attrs) if (attrs.hasOwnProperty(key)) node.setAttribute(key, attrs[key]);
    return node;
  }

  function ensureHost() {
    if (hostSvg && hostSvg.parentNode) return hostSvg;
    hostSvg = el('svg', { width: '0', height: '0', 'aria-hidden': 'true', focusable: 'false' });
    hostSvg.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;overflow:hidden';
    document.body.appendChild(hostSvg);
    return hostSvg;
  }

  function optionsFor(target) {
    for (var i = 0; i < RULES.length; i++) {
      if (target.matches(RULES[i].selector)) return RULES[i];
    }
    return { depth: 18, push: 14 };
  }

  function rootNumber(name, fallback) {
    var value = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
    return isFinite(value) ? value : fallback;
  }

  function lensRatio() {
    var root = document.documentElement;
    if (root.dataset.glass === 'off' || root.dataset.btnMat === 'fuzzy') return 0;
    var raw = rootNumber('--glass-refract', 158);
    if (raw <= 0) return 0;
    return Math.max(0, Math.min(2.2, raw / 158));
  }

  function blurValue() {
    return Math.max(0, Math.min(24, rootNumber('--glass-blur', 2.2)));
  }

  /** SunnyTV rounded-rect distance + circleMap。中心 depth=0，位移恒为 0。 */
  function lensDisplacement(x, y, w, h, radius, depth, push) {
    var px = x - w / 2, py = y - h / 2;
    var r = Math.min(radius, w / 2, h / 2);
    var qx = Math.abs(px) - (w / 2 - r), qy = Math.abs(py) - (h / 2 - r);
    var sd = Math.sqrt(Math.max(qx, 0) * Math.max(qx, 0) + Math.max(qy, 0) * Math.max(qy, 0))
      + Math.min(Math.max(qx, qy), 0) - r;
    var d = Math.min(1, Math.max(0, -sd / depth));
    var circle = 1 - Math.sqrt(Math.max(0, 1 - (1 - d) * (1 - d)));
    var gr = Math.min(r * 1.5, w / 2, h / 2);
    var gx = Math.abs(px) - (w / 2 - gr), gy = Math.abs(py) - (h / 2 - gr);
    var nx, ny;
    if (gx >= 0 || gy >= 0) { nx = Math.max(gx, 0); ny = Math.max(gy, 0); }
    else if (gx >= gy) { nx = 1; ny = 0; }
    else { nx = 0; ny = 1; }
    var len = Math.sqrt(nx * nx + ny * ny) || 1;
    nx = nx / len * (px < 0 ? -1 : 1);
    ny = ny / len * (py < 0 ? -1 : 1);
    return [circle * -push * nx, circle * -push * ny];
  }

  function mount(target) {
    if (!target || target.__veyraGlassMounted) return;
    target.__veyraGlassMounted = true;
    target.setAttribute('data-sunny-glass', 'glass');
    target.setAttribute('data-glass-renderer', canRefract ? 'refracted' : 'blur');

    var opts = optionsFor(target);
    var id = 'veyra-lens-' + (++serial);
    var filter = null, blur = null, map = null;
    if (canRefract) {
      filter = el('filter', {
        id: id, filterUnits: 'userSpaceOnUse', primitiveUnits: 'userSpaceOnUse',
        'color-interpolation-filters': 'sRGB'
      });
      blur = el('feGaussianBlur', { 'in': 'SourceGraphic', stdDeviation: String(blurValue()), result: 'diffused' });
      var sat = el('feColorMatrix', { 'in': 'diffused', type: 'saturate', values: '.85', result: 'soft' });
      map = el('feImage', { result: 'lens', preserveAspectRatio: 'none' });
      var disp = el('feDisplacementMap', {
        'in': 'soft', in2: 'lens', scale: String(SCALE),
        xChannelSelector: 'R', yChannelSelector: 'G'
      });
      filter.appendChild(blur);
      filter.appendChild(sat);
      filter.appendChild(map);
      filter.appendChild(disp);
      ensureHost().appendChild(filter);
    }

    var lastGeometry = '';
    var disposed = false;
    var queued = 0;

    function update() {
      queued = 0;
      if (disposed || !target.isConnected) return;
      if (blur) blur.setAttribute('stdDeviation', String(blurValue()));
      var ratio = lensRatio();
      if (!canRefract || ratio <= 0 || target.hidden) {
        target.removeAttribute('data-lens');
        target.style.removeProperty('--sunny-glass-filter');
        return;
      }
      var w = target.offsetWidth, h = target.offsetHeight;
      if (w < 2 || h < 2) {
        target.removeAttribute('data-lens');
        target.style.removeProperty('--sunny-glass-filter');
        return;
      }
      var cs = getComputedStyle(target);
      var radius = parseFloat(cs.borderTopLeftRadius) || 0;
      var key = [Math.round(w), Math.round(h), Math.round(radius * 10) / 10, ratio.toFixed(3), opts.depth, opts.push].join(':');
      if (key !== lastGeometry) {
        var factor = Math.min(1, MAX_EDGE / Math.max(w, h));
        var cw = Math.max(1, Math.round(w * factor)), ch = Math.max(1, Math.round(h * factor));
        var canvas = document.createElement('canvas');
        canvas.width = cw; canvas.height = ch;
        var ctx = canvas.getContext('2d');
        if (!ctx) {
          target.removeAttribute('data-lens');
          return;
        }
        var image = ctx.createImageData(cw, ch);
        var data = image.data, i = 0;
        for (var yy = 0; yy < ch; yy++) {
          for (var xx = 0; xx < cw; xx++) {
            var dxy = lensDisplacement((xx + 0.5) / factor, (yy + 0.5) / factor, w, h, radius, opts.depth, opts.push * ratio);
            data[i] = Math.round(255 * (0.5 + dxy[0] / SCALE));
            data[i + 1] = Math.round(255 * (0.5 + dxy[1] / SCALE));
            data[i + 2] = 128;
            data[i + 3] = 255;
            i += 4;
          }
        }
        ctx.putImageData(image, 0, 0);
        filter.setAttribute('x', '-40'); filter.setAttribute('y', '-40');
        filter.setAttribute('width', String(w + 80)); filter.setAttribute('height', String(h + 80));
        map.setAttribute('x', '0'); map.setAttribute('y', '0');
        map.setAttribute('width', String(w)); map.setAttribute('height', String(h));
        map.setAttribute('href', canvas.toDataURL('image/png'));
        lastGeometry = key;
      }
      target.style.setProperty('--sunny-glass-filter', 'url("#' + id + '")');
      target.setAttribute('data-lens', 'on');
    }

    function schedule() {
      if (disposed || queued) return;
      queued = requestAnimationFrame(update);
    }

    var ro = null;
    if (window.ResizeObserver) {
      ro = new ResizeObserver(schedule);
      ro.observe(target);
    } else {
      window.addEventListener('resize', schedule);
    }
    var mo = new MutationObserver(schedule);
    mo.observe(target, { attributes: true, attributeFilter: ['class', 'hidden'] });
    var dock = target.closest ? target.closest('#dock,.ap-preview-dock') : null;
    if (dock && dock !== target) mo.observe(dock, { attributes: true, attributeFilter: ['class'] });

    var entry = {
      target: target,
      schedule: schedule,
      dispose: function () {
        if (disposed) return;
        disposed = true;
        if (queued) cancelAnimationFrame(queued);
        if (ro) ro.disconnect(); else window.removeEventListener('resize', schedule);
        mo.disconnect();
        if (filter && filter.parentNode) filter.parentNode.removeChild(filter);
        target.__veyraGlassMounted = false;
        target.removeAttribute('data-lens');
        target.removeAttribute('data-sunny-glass');
        target.removeAttribute('data-glass-renderer');
        target.style.removeProperty('--sunny-glass-filter');
      }
    };
    mounted.push(entry);
    schedule();
  }

  function scan() {
    scanQueued = 0;
    var found = Array.prototype.slice.call(document.querySelectorAll(TARGETS));
    for (var i = mounted.length - 1; i >= 0; i--) {
      var entry = mounted[i];
      if (!entry.target.isConnected || found.indexOf(entry.target) < 0) {
        entry.dispose();
        mounted.splice(i, 1);
      }
    }
    for (var j = 0; j < found.length; j++) mount(found[j]);
  }

  function scheduleScan() {
    if (scanQueued) return;
    scanQueued = requestAnimationFrame(scan);
  }

  function relens() {
    scheduleScan();
    for (var i = 0; i < mounted.length; i++) {
      try { mounted[i].schedule(); } catch (error) { }
    }
  }

  function boot() {
    window.__veyraRelens = relens;
    window.VeyraGlass = { scan: scheduleScan, relens: relens };
    var observer = new MutationObserver(scheduleScan);
    observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener('visibilitychange', function () { if (!document.hidden) relens(); });
    scan();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
