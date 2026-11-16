/* 液态玻璃 Dock 交互层（v0.18.70）
 * 职责：
 *   1) 把 #dock-blob（玻璃透镜）同步到当前 active 按钮下面，切换 tab 时弹簧滑过去；
 *   2) 每个按钮都是「焦点」：按住即成为焦点，横向拖动时**透镜**跟手并放大（.dragging），
 *      图标本身不做任何位移/缩放，只切换颜色与亮度；
 *   3) 松手时若停在别的选项上 → 触发该选项（走 app.js 原有 click 导航链路），
 *      若拖到空白处/原地 → 弹回原焦点。
 * 不接管导航逻辑，只做手势与视觉；导航仍由 app.js 的 #dock [data-nav] click 处理。
 */
(() => {
  const dock = document.getElementById('dock');
  const blob = document.getElementById('dock-blob');
  if (!dock || !blob) return;

  const buttons = Array.from(dock.querySelectorAll('[data-nav]'));
  if (buttons.length < 2) return;

  const PAD = 4;          // 透镜相对按钮左右各内缩
  const DRAG_SLOP = 7;    // 超过这个位移才算拖动（否则当点击）
  let dragging = false;
  let pointerId = null;
  let startX = 0, startY = 0;
  let hovered = null;
  let pressedBtn = null;
  let suppressClickUntil = 0;
  let selfClick = false;   // 自己派发的导航 click 要放行，不被上一次拖动遗留的窗口误吞
  let rafId = 0;

  const current = () => dock.querySelector('[data-nav].active') || buttons[0];

  function metrics(btn) {
    const d = dock.getBoundingClientRect();
    const b = btn.getBoundingClientRect();
    return { x: b.left - d.left, w: b.width, dockW: d.width };
  }

  function paint(btn, animate) {
    const m = metrics(btn);
    if (!animate) blob.style.transition = 'none';
    blob.style.width = Math.max(0, m.w - PAD * 2) + 'px';
    blob.style.transform = `translate3d(${m.x + PAD}px,0,0)`;
    if (!animate) {
      void blob.offsetWidth;          // 强制回流，避免首帧从初始位置滑入
      blob.style.transition = '';
    }
  }

  /* 拖动中：透镜中心跟手，左右夹取在 dock 内 */
  function follow(clientX) {
    const d = dock.getBoundingClientRect();
    const w = parseFloat(blob.style.width) || d.width / buttons.length;
    let x = clientX - d.left - w / 2;
    x = Math.max(PAD, Math.min(d.width - w - PAD, x));
    blob.style.transform = `translate3d(${x}px,0,0)`;
  }

  function animate() {
    if (rafId) return;
    rafId = requestAnimationFrame(() => { rafId = 0; paint(current(), true); });
  }

  // 内容区整页横滑：底栏透镜使用与页面相同的进度，不在松手后才跳过去。
  let contentFrom = 0, contentTo = 0, contentRatio = 0, contentFollowing = false;
  function contentProgress(from, to, ratio, animate = false) {
    const A = buttons[from], B = buttons[to];
    if (!A || !B) return;
    contentFrom = from; contentTo = to;
    contentRatio = Math.max(0, Math.min(1, ratio || 0));
    const a = metrics(A), b = metrics(B), q = contentRatio;
    const mix = (x, y) => x + (y - x) * q;
    blob.style.transition = animate
      ? 'transform .2s cubic-bezier(.22,.61,.36,1),width .2s cubic-bezier(.22,.61,.36,1)'
      : 'none';
    blob.style.width = Math.max(0, mix(a.w, b.w) - PAD * 2) + 'px';
    blob.style.transform = `translate3d(${mix(a.x, b.x) + PAD}px,0,0)`;
    buttons.forEach((button, i) => {
      button.classList.toggle('drag-over', i === (q >= .5 ? to : from) && button !== current());
      button.classList.toggle('dim', i !== from && i !== to);
    });
  }
  function contentBegin(from, to) {
    contentFollowing = true;
    clearHover();
    contentFrom = from; contentTo = to; contentRatio = 0;
    contentProgress(from, to, 0, false);
  }
  function contentSettle(commit) {
    contentProgress(contentFrom, contentTo, commit ? 1 : 0, true);
    setTimeout(() => {
      contentFollowing = false;
      blob.style.transition = '';
      clearHover();
      animate();
    }, 210);
  }
  window.DockGlass = { begin: contentBegin, progress: contentProgress, settle: contentSettle };

  function setHovered(btn) {
    if (btn === hovered) return;
    hovered = btn;
    buttons.forEach(b => {
      b.classList.toggle('drag-over', b === btn && b !== current());
      b.classList.toggle('dim', !!btn && b !== btn);
    });
    if (btn) {
      /* 透镜宽度恒定贴住按钮：放大由 CSS 的 scale 完成，不改宽度 */
      const m = metrics(btn);
      blob.style.width = Math.max(0, m.w - PAD * 2) + 'px';
    }
  }

  function clearHover() {
    hovered = null;
    buttons.forEach(b => b.classList.remove('drag-over', 'dim', 'holding'));
  }

  function buzz(ms) {
    try { navigator.vibrate && navigator.vibrate(ms); } catch (_) {}
  }

  dock.addEventListener('pointerdown', e => {
    if (e.button != null && e.button !== 0) return;
    const btn = e.target.closest('[data-nav]');
    if (!btn) return;
    pointerId = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    dragging = false;
    hovered = null;
    pressedBtn = btn;
    try { dock.setPointerCapture(pointerId); } catch (_) {}
    /* 按下即成为焦点：透镜先吸附到按下的按钮；拖动时透镜再跟手并放大 */
    btn.classList.add('holding');
    paint(btn, true);
  }, { passive: true });

  function trackMove(e) {
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!dragging) {
      if (Math.hypot(dx, dy) < DRAG_SLOP) return;
      dragging = true;
      /* .dragging 同时做两件事：外层 blob 关掉过渡（跟手）、内层 b 放大（透镜被拿起来） */
      dock.classList.add('dragging');
      buzz(8);
    }
    follow(e.clientX);
    /* 命中判定只看横坐标在 dock 内的投影（离哪个按钮最近就算哪个），与透镜位置同源 ——
     * 手指拖动时经常漂到 dock 上方/下方，elementFromPoint(指针位置) 会取不到按钮，
     * 导致「透镜明明拖到了这格、松手却不切」。 */
    const d = dock.getBoundingClientRect();
    const x = e.clientX - d.left;
    let best = null, bestD = Infinity;
    buttons.forEach(b => {
      const m = metrics(b);
      const dd = x < m.x ? m.x - x : (x > m.x + m.w ? x - (m.x + m.w) : 0);
      if (dd < bestD) { bestD = dd; best = b; }
    });
    setHovered(best);
  }

  function finish(e, cancelled) {
    if (pointerId === null || (e && e.pointerId !== pointerId)) return;
    const pid = pointerId;
    const wasDragging = dragging;
    const target = hovered;
    const tapped = pressedBtn;
    pointerId = null;
    dragging = false;
    pressedBtn = null;
    dock.classList.remove('dragging');
    blob.style.transition = '';
    clearHover();
    try { dock.releasePointerCapture(pid); } catch (_) {}

    if (wasDragging) {
      /* 先把手势触发的导航发出去（click 同步派发，此时还不能吞），
       * 然后再挂上「吞 click」窗口，把浏览器在 pointerup 后补发的那次点击吃掉，
       * 否则原按钮会再导航一次。 */
      if (target && !cancelled && target !== current()) {
        buzz(6);
        selfClick = true;
        try { target.click(); } finally { selfClick = false; }   // 交给 app.js 的 tapDock 处理，含双击回顶逻辑
      }
      suppressClickUntil = performance.now() + 350;
    } else {
      /* 轻点：pointer capture 生效时浏览器补发的 click 会被重定向到 dock 本身
       * （closest('[data-nav]') 取不到，导航丢失），必须自己派发 —— 与 seg-glass 同源。 */
      if (!cancelled && tapped && tapped.isConnected) {
        selfClick = true;
        try { tapped.click(); } finally { selfClick = false; }
      }
      suppressClickUntil = performance.now() + 350;
    }
    animate();                        // 无论成败都弹回合法焦点
  }

  /* 移动/松手挂 document 捕获段：指针捕获偶尔会被系统提前收回
   * （部分 WebView、无头环境都会出现，pointerup 直接到不了 dock 上），
   * 表现为「透镜拖过去了、松手却不切换」。捕获只作加速，不作依赖。 */
  document.addEventListener('pointermove', e => {
    if (pointerId === null || e.pointerId !== pointerId) return;
    trackMove(e);
  }, { passive: true, capture: true });
  document.addEventListener('pointerup', e => {
    if (pointerId === null || e.pointerId !== pointerId) return;
    finish(e, false);
  }, { passive: true, capture: true });
  document.addEventListener('pointercancel', e => {
    if (pointerId === null || e.pointerId !== pointerId) return;
    finish(e, true);
  }, { passive: true, capture: true });

  /* 拖动后吞掉浏览器补发的那次 click（app.js 的导航监听在 document 上）。
   * 窗口只在拖动后开启；手指若已滑出 dock，补发 click 会落在 dock 外，
   * 所以要在 document 捕获段吃，轻点路径不受影响（窗口未开启）。 */
  document.addEventListener('click', e => {
    if (selfClick || performance.now() >= suppressClickUntil) return;
    e.stopPropagation();
    e.preventDefault();
  }, true);

  /* active 类由 app.js 切换，这里监听变化同步透镜位置 */
  const mo = new MutationObserver(records => {
    if (dragging || contentFollowing) return;
    for (const r of records) {
      if (r.target.classList && r.target.classList.contains('active')) { animate(); return; }
    }
    animate();
  });
  buttons.forEach(b => mo.observe(b, { attributes: true, attributeFilter: ['class'] }));

  window.addEventListener('resize', () => paint(current(), false));
  window.addEventListener('orientationchange', () => {
    setTimeout(() => paint(current(), false), 260);
  });

  /* 首帧定位（不加动画） */
  const boot = () => paint(current(), false);
  if (document.readyState === 'complete') boot();
  else window.addEventListener('load', boot, { once: true });
  boot();
})();
