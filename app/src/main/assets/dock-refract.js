/* 液态玻璃折射 · 移植自 xudong7587/sunny-ui-design-system（Apache-2.0，SunnyTV circleMap）
 *
 * 和之前那版「feTurbulence 噪声位移」的根本区别：
 *   噪声位移是**整块面板都在随机扭**，图标边缘发毛、文字发虚，看着很脏；
 *   这里的位移纹理是**几何**算出来的 —— 圆角矩形的有符号距离场 + 透镜法线：
 *     · 距边缘 >= DEPTH 的区域，depth=0 → circle=0 → 位移恒为 0（中心一个像素都不弯）
 *     · 越贴边缘 depth 越大 → 位移越大，方向沿内法线
 *   所以「只在靠近边缘的地方折射」是算法本身保证的，不是靠调参碰运气。
 *
 * 纹理本身只是几何信息（不含截图、不读页面内容），尺寸/圆角变了才重算。
 * 不支持（非 Chromium / 没有 backdrop-filter）时什么都不做，CSS 自然回退到纯模糊。
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || !window.document) return;

  var ua = navigator.userAgent || '';
  // SVG 滤镜作用在 backdrop 上这条路径只在 Chromium 验证过；其它引擎保留原生模糊
  var isChromium = /(?:Chrome|Chromium|Edg)\//.test(ua) && !/(?:CriOS|EdgiOS)\//.test(ua);
  if (!isChromium) return;
  var CSSok = window.CSS && CSS.supports && (
      CSS.supports('backdrop-filter', 'blur(2px)') ||
      CSS.supports('-webkit-backdrop-filter', 'blur(2px)'));
  if (!CSSok) return;

  var NS = 'http://www.w3.org/2000/svg';
  var SCALE = 28;          // 必须和 feDisplacementMap 的 scale 一致（纹理编码用 255*(0.5+dx/SCALE)）
  var MAX_EDGE = 640;      // 纹理最长边上限

  function el(name, attrs) {
    var n = document.createElementNS(NS, name);
    for (var k in attrs) if (attrs.hasOwnProperty(k)) n.setAttribute(k, attrs[k]);
    return n;
  }

  /** 单个像素的位移量（CSS px）。严格按 SunnyTV 的 rounded-rect distance + circleMap。 */
  function lensDisplacement(x, y, w, h, radius, depth, push) {
    var px = x - w / 2, py = y - h / 2;
    var r = Math.min(radius, w / 2, h / 2);
    var qx = Math.abs(px) - (w / 2 - r), qy = Math.abs(py) - (h / 2 - r);
    // 圆角矩形 SDF：外部取正距离，内部取负
    var sd = Math.sqrt(Math.max(qx, 0) * Math.max(qx, 0) + Math.max(qy, 0) * Math.max(qy, 0))
           + Math.min(Math.max(qx, qy), 0) - r;
    var d = Math.min(1, Math.max(0, -sd / depth));    // 0 = 中心，1 = 贴边
    var circle = 1 - Math.sqrt(Math.max(0, 1 - (1 - d) * (1 - d)));
    // 法线：在「半径 1.5 倍」的矩形边界上取内法线方向
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

  /* 折射强度来自外观设置：--glass-refract 是百分比（158 = 默认 1.0 倍）。
     玻璃总开关关掉、或按钮材质选了「模糊」时直接不挂折射（0 = 纯模糊）。 */
  function lensRatio() {
    var root = document.documentElement;
    if (root.dataset.glass === 'off') return 0;
    if (root.dataset.btnMat === 'fuzzy') return 0;
    var raw = parseFloat(getComputedStyle(root).getPropertyValue('--glass-refract'));
    if (!isFinite(raw) || raw <= 0) return 1;
    return Math.max(0, Math.min(2.2, raw / 158));
  }

  var refreshers = [];

  var hostSvg = null;
  function ensureHost() {
    if (hostSvg && hostSvg.parentNode) return hostSvg;
    hostSvg = el('svg', { width: '0', height: '0', 'aria-hidden': 'true', focusable: 'false' });
    hostSvg.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;overflow:hidden';
    document.body.appendChild(hostSvg);
    return hostSvg;
  }

  /** 给一个元素挂上「只在边缘折射」的滤镜；返回 { dispose }。 */
  function applyLens(target, opts) {
    var id = opts.id, depth = opts.depth || 18, push = opts.push || 14;

    var svg = ensureHost();
    var filter = el('filter', {
      id: id, filterUnits: 'userSpaceOnUse', primitiveUnits: 'userSpaceOnUse',
      'color-interpolation-filters': 'sRGB'
    });
    // 完整复刻 Sunny 的滤镜链：先柔化背景，再降饱和（把花花绿绿的封面压灰一点，
    // 文字才读得出来），最后按几何纹理做位移。refracted 态下 CSS 只剩 url()，
    // 模糊和降饱和全部在这里完成 —— 所以 2.2 和 .85 必须和 CSS 里那条保持同一个值。
    var blur = el('feGaussianBlur', { 'in': 'SourceGraphic', stdDeviation: '2.2', result: 'diffused' });
    var sat = el('feColorMatrix', { 'in': 'diffused', type: 'saturate', values: '.85', result: 'soft' });
    var map = el('feImage', { result: 'lens', preserveAspectRatio: 'none' });
    var disp = el('feDisplacementMap', {
      'in': 'soft', in2: 'lens', scale: String(SCALE),
      xChannelSelector: 'R', yChannelSelector: 'G'
    });
    filter.appendChild(blur);
    filter.appendChild(sat);
    filter.appendChild(map);
    filter.appendChild(disp);
    svg.appendChild(filter);

    var lastKey = '', disposed = false, queued = 0;

    function update() {
      queued = 0;
      if (disposed) return;
      var w = target.offsetWidth, h = target.offsetHeight;   // 未变形尺寸：位移图用 CSS 像素坐标系
      if (w < 2 || h < 2) return;
      var ratio = lensRatio();
      if (ratio <= 0) {
        target.removeAttribute('data-lens');   // 交回 CSS 的原生模糊
        return;
      }
      var cs = getComputedStyle(target);
      var radius = parseFloat(cs.borderTopLeftRadius) || 0;
      var key = Math.round(w) + ':' + Math.round(h) + ':' + Math.round(radius) + ':' + ratio.toFixed(2);
      if (key !== lastKey) {
        var factor = Math.min(1, MAX_EDGE / Math.max(w, h));
        var cw = Math.max(1, Math.round(w * factor)), ch = Math.max(1, Math.round(h * factor));
        var canvas = document.createElement('canvas');
        canvas.width = cw; canvas.height = ch;
        var ctx = canvas.getContext('2d');
        if (!ctx) return;
        var img = ctx.createImageData(cw, ch);
        var data = img.data, i = 0;
        for (var yy = 0; yy < ch; yy++) {
          for (var xx = 0; xx < cw; xx++) {
            var dxy = lensDisplacement((xx + 0.5) / factor, (yy + 0.5) / factor, w, h, radius, depth, push * ratio);
            data[i]     = Math.round(255 * (0.5 + dxy[0] / SCALE));   // R = x 位移
            data[i + 1] = Math.round(255 * (0.5 + dxy[1] / SCALE));   // G = y 位移
            data[i + 2] = 128;
            data[i + 3] = 255;
            i += 4;
          }
        }
        ctx.putImageData(img, 0, 0);
        // 滤镜区域四周留 40px 余量，圆角外侧的采样不会缺图
        filter.setAttribute('x', '-40'); filter.setAttribute('y', '-40');
        filter.setAttribute('width', String(w + 80)); filter.setAttribute('height', String(h + 80));
        map.setAttribute('x', '0'); map.setAttribute('y', '0');
        map.setAttribute('width', String(w)); map.setAttribute('height', String(h));
        map.setAttribute('href', canvas.toDataURL());
        lastKey = key;
      }
      target.setAttribute('data-lens', 'on');   // CSS 据此换成带 url(#id) 的 backdrop-filter
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
    // 拖动时透镜会切换尺寸（.dragging），class 变化后重新量一次
    var mo = new MutationObserver(schedule);
    mo.observe(target, { attributes: true, attributeFilter: ['class'] });
    var dock = target.closest ? target.closest('#dock') : null;
    if (dock && dock !== target) mo.observe(dock, { attributes: true, attributeFilter: ['class'] });

    refreshers.push(schedule);
    schedule();

    return {
      dispose: function () {
        var at = refreshers.indexOf(schedule);
        if (at >= 0) refreshers.splice(at, 1);
        disposed = true;
        if (queued) cancelAnimationFrame(queued);
        if (ro) ro.disconnect(); else window.removeEventListener('resize', schedule);
        mo.disconnect();
        if (filter.parentNode) filter.parentNode.removeChild(filter);
        target.removeAttribute('data-lens');
      }
    };
  }

  function boot() {
    var dock = document.getElementById('dock');
    if (!dock) return;
    // 底栏：深度 18px、最大位移 14px —— 只有贴着轮廓那一圈会掰弯背景
    applyLens(dock, { id: 'dock-lens', depth: 18, push: 14 });
    // 透镜：体积小、曲率大，深度 12 / 位移 9，免得把自己撑变形
    var blob = dock.querySelector('#dock-blob b');
    if (blob) applyLens(blob, { id: 'dock-lens-blob', depth: 12, push: 9 });
    // v0.18.105：搜索框 + 搜索历史/联想面板，同款液态玻璃折射。
    // 搜索框小体积高曲率（同透镜参数 12/9）；面板大一点用 16/11。
    // 面板初始 hidden（尺寸 0），显示后 ResizeObserver 会自动补挂 data-lens。
    var searchForm = document.querySelector('.search-form');
    if (searchForm) applyLens(searchForm, { id: 'search-lens', depth: 12, push: 9 });
    var suggest = document.getElementById('search-suggest');
    if (suggest) applyLens(suggest, { id: 'search-lens-suggest', depth: 16, push: 11 });
    // v0.18.106：设置按钮（我的页右上）同款玻璃折射。初始 hidden，显示后 RO 自动补挂。
    var settings = document.querySelector('.header-settings');
    if (settings) applyLens(settings, { id: 'header-settings-lens', depth: 10, push: 7 });
    // 外观设置改了折射强度/材质后，由 appearance.js 调这里重算
    window.__veyraRelens = function () {
      for (var i = 0; i < refreshers.length; i++) {
        try { refreshers[i](); } catch (error) { }
      }
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
