/* 外观设置 —— 按参考稿（流影「玻璃材质」页）重排：
 *   玻璃材质开关 / 按钮材质（模糊·液态玻璃）/ 背景（浅色·彩色·深色）/ 实时预览
 *   / 高光强度 · 模糊程度 · 折射强度 三条滑杆 / 恢复默认材质
 *   / 显示导航文字 / 界面动效（标准·减少·关闭）
 *
 * 四件事都落成 HTML 上的 data-* 与 CSS 变量，样式表只消费、不判断：
 *   data-glass=on|off      → 玻璃全关时退回实底（不模糊、不折射）
 *   data-btn-mat=fuzzy|liquid → 按钮材质：模糊 vs 液态玻璃（后者额外吃折射透镜）
 *   data-bg=light|color|dark  → 背景：浅色 / 彩色（accent 渐变）/ 深色
 *   data-nav-text=on|off   → 底栏是否显示文字
 *   data-motion=standard|reduce|off → 界面动效
 *   --glass-blur / --glass-hi / --glass-hi-strong / --glass-refract
 */
(function () {
  'use strict';

  var KEY = 'veyra.appearance.v2';
  var LEGACY_KEY = 'veyra.appearance.v1';
  var DEFAULT = {
    glass: 'on',
    btnMat: 'liquid',
    bg: 'color',
    specular: 138,
    // 默认沿用首页底栏原本的 2.2dp：不在用户没要求的情况下改掉他们已经认可的观感
    blur: 2.2,
    refract: 158,
    navText: 'on',
    motion: 'standard',
    // 兼容旧四维：材质/配色/圆角仍由 Sunny 令牌层消费，只是不再占设置页的位置
    theme: 'light',
    material: 'soft',
    color: 'blue',
    corner: 'default'
  };
  var root = document.documentElement;

  function clamp(value, min, max) {
    value = Number(value);
    if (isNaN(value)) return min;
    return Math.max(min, Math.min(max, value));
  }

  function read() {
    var out = {};
    for (var key in DEFAULT) out[key] = DEFAULT[key];
    try {
      var raw = localStorage.getItem(KEY) || localStorage.getItem(LEGACY_KEY);
      if (raw) {
        var saved = JSON.parse(raw);
        for (var name in DEFAULT) {
          if (saved[name] !== undefined && saved[name] !== null) out[name] = saved[name];
        }
        // 旧版本只存了 theme；新的「背景」三选一以它为准
        if (saved.bg === undefined && saved.theme) out.bg = saved.theme === 'dark' ? 'dark' : 'light';
      }
    } catch (error) { }
    out.specular = clamp(out.specular, 40, 220);
    out.blur = clamp(out.blur, 0, 24);
    out.refract = clamp(out.refract, 0, 200);
    return out;
  }

  var state = read();

  function paint() {
    var dark = state.bg === 'dark';
    root.dataset.theme = dark ? 'dark' : 'light';
    root.dataset.bg = state.bg;
    root.dataset.glass = state.glass;
    root.dataset.btnMat = state.btnMat;
    root.dataset.navText = state.navText;
    root.dataset.motion = state.motion;
    root.dataset.material = state.material;
    root.dataset.color = state.color;
    root.dataset.corner = state.corner;

    var spec = state.specular / 100;
    root.style.setProperty('--glass-blur', state.blur.toFixed(1) + 'px');
    root.style.setProperty('--glass-hi', Math.min(0.96, 0.30 * spec).toFixed(3));
    root.style.setProperty('--glass-hi-strong', Math.min(0.98, 0.62 * spec).toFixed(3));
    root.style.setProperty('--glass-refract', String(Math.round(state.refract)));

    var meta = document.querySelector('meta[name="color-scheme"]');
    if (meta) meta.setAttribute('content', dark ? 'dark' : 'light');
    // 折射透镜要跟着强度/材质重挂（dock-refract.js 提供）
    if (typeof window.__veyraRelens === 'function') window.__veyraRelens();
  }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (error) { }
  }

  window.VeyraAppearance = {
    get: function () { var out = {}; for (var key in state) out[key] = state[key]; return out; },
    set: function (patch) {
      var changed = false;
      for (var key in patch) {
        if (!patch.hasOwnProperty(key) || !state.hasOwnProperty(key)) continue;
        if (state[key] === patch[key]) continue;
        state[key] = patch[key];
        changed = true;
      }
      if (!changed) return;
      paint();
      save();
      if (typeof window.VeyraAppearance.onChange === 'function') window.VeyraAppearance.onChange(state);
    },
    reset: function () {
      for (var key in DEFAULT) state[key] = DEFAULT[key];
      paint();
      save();
      syncSelection();
      updateSummary();
      if (typeof window.VeyraAppearance.onChange === 'function') window.VeyraAppearance.onChange(state);
    }
  };

  paint();

  /* ---------- 文案 ---------- */
  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var BTN_MAT = { fuzzy: '模糊', liquid: '液态玻璃' };
  var BG = { light: '浅色背景', color: '彩色背景', dark: '深色背景' };
  var MOTION = { standard: '标准', reduce: '减少', off: '关闭' };

  function summaryText() {
    return (BTN_MAT[state.btnMat] || '液态玻璃')
      + ' · ' + (BG[state.bg] || '彩色背景')
      + ' · 高光 ' + Math.round(state.specular) + '%'
      + ' · 模糊 ' + state.blur.toFixed(1) + 'dp';
  }

  function updateSummary() {
    var el = document.querySelector('[data-appearance-summary]');
    if (el) el.textContent = summaryText();
  }

  /* ---------- 面板 ---------- */
  var ARROW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"'
    + ' stroke-linecap="round" stroke-linejoin="round"><path d="m9 5 7 7-7 7"/></svg>';

  var CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"'
    + ' stroke-linecap="round" stroke-linejoin="round"><path d="m5 13 4 4L19 7"/></svg>';

  /* 预览直接复用当前真实底栏的四项导航和 SVG，去掉 id/业务事件后交给同一玻璃引擎。
     不维护第二套图标，也不克隆真实节点 id。 */
  function previewDockHtml() {
    var dock = document.getElementById('dock');
    if (!dock) return '';
    var clone = dock.cloneNode(true);
    clone.removeAttribute('id');
    clone.removeAttribute('aria-label');
    clone.removeAttribute('data-lens');
    clone.removeAttribute('data-sunny-glass');
    clone.removeAttribute('data-glass-renderer');
    clone.className = 'ap-preview-bar ap-preview-dock';
    clone.querySelectorAll('[id]').forEach(function (node) { node.removeAttribute('id'); });
    clone.querySelectorAll('[style]').forEach(function (node) { node.removeAttribute('style'); });
    clone.querySelectorAll('[data-lens],[data-sunny-glass],[data-glass-renderer]').forEach(function (node) {
      node.removeAttribute('data-lens');
      node.removeAttribute('data-sunny-glass');
      node.removeAttribute('data-glass-renderer');
    });
    clone.querySelectorAll('button').forEach(function (button, index) {
      button.removeAttribute('data-nav');
      button.classList.remove('drag-over', 'dim', 'holding');
      button.classList.toggle('active', index === 0);
      button.tabIndex = -1;
    });
    return clone.outerHTML;
  }

  function seg(group, options, current) {
    var html = '<div class="seg ap-seg" data-group="' + group + '" role="group">';
    for (var id in options) {
      html += '<button type="button" data-value="' + id + '" aria-pressed="'
        + (id === current ? 'true' : 'false') + '">'
        + (id === current ? '<i class="ap-tick">' + CHECK + '</i>' : '')
        + '<span>' + options[id] + '</span></button>';
    }
    return html + '</div>';
  }

  function switchRow(label, key, on) {
    return '<div class="ap-row"><span class="ap-row-title">' + label + '</span>'
      + '<button type="button" class="ap-switch" data-switch="' + key + '" role="switch"'
      + ' aria-pressed="' + (on ? 'true' : 'false') + '" aria-label="' + label + '"><i></i></button></div>';
  }

  function slider(key, label, value, min, max, step, unit) {
    return '<div class="ap-slider">'
      + '<div class="ap-slider-head"><span>' + label + '</span>'
      + '<b data-out="' + key + '">' + value + unit + '</b></div>'
      + '<input type="range" min="' + min + '" max="' + max + '" step="' + step + '"'
      + ' value="' + value + '" data-range="' + key + '" aria-label="' + label + '">'
      + '</div>';
  }

  function panelHtml() {
    return '<div class="ap-sec">'
      +   switchRow('玻璃材质', 'glass', state.glass === 'on')
      + '</div>'

      + '<div class="ap-sec">'
      +   '<span class="ap-label">按钮材质</span>'
      +   seg('btnMat', BTN_MAT, state.btnMat)
      +   '<div class="ap-seg-gap"></div>'
      +   seg('bg', BG, state.bg)
      +   '<div class="ap-preview" aria-hidden="true">'
      +     '<span class="ap-preview-title">VEYRA</span>'
      +     previewDockHtml()
      +   '</div>'
      +   slider('specular', '高光强度', Math.round(state.specular), 40, 220, 1, '%')
      +   slider('blur', '模糊程度', state.blur.toFixed(1), 0, 24, 0.1, ' dp')
      +   slider('refract', '折射强度', Math.round(state.refract), 0, 200, 1, '%')
      +   '<button type="button" class="ap-reset" data-appearance-reset>恢复默认材质</button>'
      + '</div>'

      + '<div class="ap-sec">'
      +   switchRow('显示导航文字', 'navText', state.navText === 'on')
      + '</div>'

      + '<div class="ap-sec">'
      +   '<span class="ap-label">界面动效</span>'
      +   seg('motion', MOTION, state.motion)
      + '</div>';
  }

  /* ---------- 弹窗 ---------- */
  function renderPop(pop) {
    pop.innerHTML = '<div class="appearance-head"><h2 id="appearance-title">外观</h2>'
      + '<button type="button" class="appearance-close" data-appearance-close aria-label="关闭">✕</button></div>'
      + '<p class="appearance-note">玻璃材质、按钮材质、背景各存一份，改了立刻生效。</p>'
      + '<div class="appearance ap-panel" id="appearance-panel">' + panelHtml() + '</div>';
  }

  window.renderAppearance = function () {
    return '<section><button type="button" class="settings-link appearance-entry"'
      + ' data-appearance-open aria-haspopup="dialog">'
      + '<span><strong>外观</strong><small data-appearance-summary>' + esc(summaryText()) + '</small></span>'
      + ARROW + '</button></section>';
  };

  var scrim = null;

  function ensurePop() {
    if (scrim && document.body.contains(scrim)) return scrim;
    scrim = document.createElement('div');
    scrim.className = 'appearance-scrim';
    scrim.hidden = true;
    scrim.innerHTML = '<div class="appearance-pop" role="dialog" aria-modal="true"'
      + ' aria-labelledby="appearance-title"></div>';
    document.body.appendChild(scrim);
    var pop = scrim.querySelector('.appearance-pop');
    renderPop(pop);

    // 滑杆：input 事件就地改 + 就地刷数值，拖的时候预览同步变
    pop.addEventListener('input', function (event) {
      var range = event.target.closest('[data-range]');
      if (!range) return;
      var key = range.dataset.range;
      var value = key === 'blur' ? Number(range.value) : Math.round(Number(range.value));
      window.VeyraAppearance.set(key === 'blur' ? { blur: value } : buildRangePatch(key, value));
      var out = pop.querySelector('[data-out="' + key + '"]');
      if (out) out.textContent = (key === 'blur' ? Number(range.value).toFixed(1) + ' dp' : value + '%');
      updateSummary();
    });

    pop.addEventListener('click', function (event) {
      if (event.target.closest('[data-appearance-close]')) { closePop(); return; }
      var sw = event.target.closest('[data-switch]');
      if (sw) {
        var key = sw.dataset.switch;
        var on = sw.getAttribute('aria-pressed') !== 'true';
        window.VeyraAppearance.set(key === 'glass'
          ? { glass: on ? 'on' : 'off' }
          : { navText: on ? 'on' : 'off' });
        syncSelection();
        updateSummary();
        return;
      }
      var option = event.target.closest('[data-group] button');
      if (option) {
        var group = option.closest('[data-group]').dataset.group;
        var patch = {};
        patch[group] = option.dataset.value;
        window.VeyraAppearance.set(patch);
        syncSelection();
        updateSummary();
        return;
      }
      if (event.target.closest('[data-appearance-reset]')) {
        window.VeyraAppearance.reset();
        renderPop(pop);
        syncSelection();
      }
    });

    scrim.addEventListener('click', function (event) {
      if (event.target === scrim) closePop();
    });
    return scrim;
  }

  function buildRangePatch(key, value) {
    var patch = {};
    patch[key] = value;
    return patch;
  }

  function openPop() {
    ensurePop();
    syncSelection();
    scrim.hidden = false;
    document.body.classList.add('appearance-open');
  }

  function closePop() {
    if (!scrim || scrim.hidden) return;
    scrim.hidden = true;
    document.body.classList.remove('appearance-open');
  }

  /** 系统侧滑/返回键拦截入口（由 app.js hgBack 调用）。 */
  window.__veyraAppearanceBack = function () {
    if (scrim && !scrim.hidden) { closePop(); return true; }
    return false;
  };

  /** 供 hgPredictiveBackStart 判断：外观弹窗是否打开。 */
  window.__veyraAppearanceOpen = function () {
    return !!(scrim && !scrim.hidden);
  };

  function syncSelection() {
    var panel = scrim && document.body.contains(scrim)
      ? scrim.querySelector('#appearance-panel')
      : document.getElementById('appearance-panel');
    if (!panel) return;
    panel.querySelectorAll('[data-group]').forEach(function (group) {
      var key = group.dataset.group;
      group.querySelectorAll('button').forEach(function (button) {
        var on = button.dataset.value === state[key];
        button.setAttribute('aria-pressed', on ? 'true' : 'false');
        var tick = button.querySelector('.ap-tick');
        if (on && !tick) {
          button.insertAdjacentHTML('afterbegin', '<i class="ap-tick">' + CHECK + '</i>');
        } else if (!on && tick) {
          tick.remove();
        }
      });
    });
    panel.querySelectorAll('[data-switch]').forEach(function (button) {
      var key = button.dataset.switch;
      var on = key === 'glass' ? state.glass === 'on' : state.navText === 'on';
      button.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    panel.querySelectorAll('[data-range]').forEach(function (range) {
      var key = range.dataset.range;
      range.value = key === 'blur' ? state.blur : state[key];
      var out = panel.querySelector('[data-out="' + key + '"]');
      if (out) out.textContent = key === 'blur' ? state.blur.toFixed(1) + ' dp' : Math.round(state[key]) + '%';
    });
  }

  /** 设置页渲染完调用：刷新入口文案/选中态，并挂一次性全局事件。 */
  window.bindAppearance = function () {
    updateSummary();
    syncSelection();
    if (window.__veyraAppearanceWired) return;
    window.__veyraAppearanceWired = true;
    document.addEventListener('click', function (event) {
      if (event.target.closest('[data-appearance-open]')) { openPop(); return; }
      if (!scrim || scrim.hidden) return;
      if (event.target.closest('[data-nav],[data-back]')) closePop();
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') closePop();
    });
  };
})();
