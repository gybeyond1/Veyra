/* 分段控件液态玻璃交互层（v0.20.5）
 * 适用：我的页「观看历史/我的收藏/我的下载」、分类页子标签（.segmented / .compact-tabs）。
 *
 * 逻辑 1:1 对齐 dock-glass.js（底栏），两者同源同手感：
 *   1) 每条 tab 栏内各挂一枚玻璃透镜（.seg-blob > b），静止时停在 .selected 那格下面；
 *   2) 按住任一格 → 透镜先吸附过去，横向拖动时透镜跟手并被「拿起」（.dragging 放大），
 *      被拖到的格文字加深（.drag-over），其余变淡（.dim）；
 *   3) 松手：悬停在哪格就切到哪格（悬停按横坐标在栏内的最近格判定，
 *      手指滑到栏外/栏下方也不丢目标）→ 派发该格的 click（交给 app.js 原有
 *      [data-library-tab] / [data-sub] 导航链路），原地 → 弹簧弹回当前选中格。
 * 不接管导航，只做手势与视觉 —— 和 dock-glass.js 的分工一致。
 *
 * 对外还暴露 setProgress(from,to,q)：给「内容区横滑切页」复用同一枚透镜做跟手插值，
 * 避免出现两套浮标（拖动一个样、落地又一个样）。
 */
(() => {
  const PAD = 4;            // 透镜相对按钮左右各内缩（与 #dock-blob 一致）
  const DRAG_SLOP = 7;      // 超过这个位移才算拖动，否则算点击
  const SELECTOR = '[role="tablist"].segmented,[role="tablist"].compact-tabs';

  const listOf = bar => Array.from(bar.querySelectorAll('button'));
  const currentOf = bar => bar.querySelector('button.selected') || listOf(bar)[0] || null;

  function buzz(ms) {
    try { navigator.vibrate && navigator.vibrate(ms); } catch (_) { }
  }

  /** 取句柄：bar 上已有则复用（克隆体也会带 .seg-blob，能被认出来） */
  function handle(bar) {
    if (!bar || !bar.nodeType) return null;
    if (bar.__seg) return bar.__seg;
    let blob = null;
    for (const kid of bar.children) if (kid.classList.contains('seg-blob')) { blob = kid; break; }
    if (!blob) {
      blob = document.createElement('i');
      blob.className = 'seg-blob';
      blob.setAttribute('aria-hidden', 'true');
      blob.appendChild(document.createElement('b'));
      bar.insertBefore(blob, bar.firstChild);
    }
    const h = {
      bar, blob,
      dragging: false, pointerId: null, startX: 0, startY: 0,
      hovered: undefined, raf: 0, widthPx: 0,
    };

    h.metrics = el => {
      const d = bar.getBoundingClientRect();
      const b = el.getBoundingClientRect();
      return { x: b.left - d.left, w: b.width, barW: d.width };
    };

    h.rects = () => {
      const d = bar.getBoundingClientRect();
      return listOf(bar).map(el => {
        const r = el.getBoundingClientRect();
        return { l: r.left - d.left, t: r.top - d.top, w: r.width, h: r.height };
      });
    };

    /** 静止/切换：透镜对齐到某个按钮并弹簧滑过去 */
    h.paint = (el, animate = true) => {
      if (!el) return;
      const m = h.metrics(el);
      const w = Math.max(0, m.w - PAD * 2);
      if (!animate) h.blob.style.transition = 'none';
      h.blob.style.width = w + 'px';
      h.blob.style.transform = `translate3d(${m.x + PAD}px,0,0)`;
      h.widthPx = w;
      if (!animate) {
        void h.blob.offsetWidth;      // 强制回流，避免首帧从 -999px 滑进来
        h.blob.style.transition = '';
      }
    };

    h.sync = animate => h.paint(currentOf(bar), animate);
    h.animate = () => {
      if (h.raf) return;
      h.raf = requestAnimationFrame(() => { h.raf = 0; h.sync(true); });
    };

    /** 拖动中：透镜中心跟手，左右夹在栏内（不越界） */
    h.follow = clientX => {
      const d = bar.getBoundingClientRect();
      const w = h.widthPx || (d.width / Math.max(1, listOf(bar).length)) - PAD * 2;
      let x = clientX - d.left - w / 2;
      x = Math.max(PAD, Math.min(d.width - w - PAD, x));
      h.blob.style.transform = `translate3d(${x}px,0,0)`;
    };

    /** 内容区横滑时的跟手插值：from→to 两格之间按进度连续过渡 */
    h.progress = (from, to, ratio) => {
      const items = listOf(bar), rects = h.rects();
      if (!items.length || rects[from] == null || rects[to] == null) return;
      const q = Math.max(0, Math.min(1, ratio || 0));
      const mix = (a, b) => a + (b - a) * q;
      const A = rects[from], B = rects[to];
      // 注意：这里不要写 inline transition —— 收尾动画要靠 swipeCloseTrack 设的行内过渡生效，
      // 一写 none 就变成瞬跳。跟手期间的无过渡由 .dragging 类负责。
      // 与 paint()/follow() 严格同源：y 恒 0（透镜靠 CSS top 定位）、不写 height（靠 CSS calc）。
      // 若这里多写 y=A.t / height=mix()，落位那一帧透镜会在垂直/高度上跳一下 —— 就是「松手闪一下」。
      h.blob.style.width = `${mix(A.w, B.w) - PAD * 2}px`;
      h.blob.style.transform = `translate3d(${mix(A.l, B.l) + PAD}px, 0px, 0)`;
      h.widthPx = mix(A.w, B.w) - PAD * 2;
      items.forEach((el, i) => el.classList.toggle('dim', i !== to && i !== from));
      items[to].classList.toggle('drag-over', q > 0.5);
    };

    h.setHover = el => {
      // 手指落在格与格之间的缝隙 / 栏外时保持上一格的悬停态：
      // 一旦这里清成 null，drag-over 与 dim 会被抹平，相邻项在拖动中就会反复闪一下，
      // 正是「旁边的项背景突然变色」的观感来源。只有松手才真正清空。
      if (!el) return;
      if (el === h.hovered) return;
      h.hovered = el;
      const cur = currentOf(bar);
      listOf(bar).forEach(b => {
        b.classList.toggle('drag-over', b === el && b !== cur);
        b.classList.toggle('dim', !!el && b !== el);
      });
      if (el) {
        const m = h.metrics(el);
        h.widthPx = Math.max(0, m.w - PAD * 2);
        h.blob.style.width = h.widthPx + 'px';
      }
    };

    h.clearHover = () => {
      h.hovered = undefined;
      listOf(bar).forEach(b => b.classList.remove('drag-over', 'dim', 'holding'));
    };

    h.setDragging = on => bar.classList.toggle('dragging', !!on);
    // 横滑切页跟手专用态：只关弹簧过渡、不放大透镜本体（放大是手指按住「拿起」才有的效果，
    // 若横滑跟手也放大，落位那一刻透镜会从放大态缩回正常态，又闪一下）。
    h.setFollow = on => bar.classList.toggle('seg-follow', !!on);

    /** 交还静止态：撤掉过渡强关、按 .selected 归位 */
    h.release = () => {
      h.setDragging(false);
      h.setFollow(false);
      h.clearHover();
      h.blob.style.transition = '';
      h.blob.style.height = '';
      h.animate();
    };

    bar.__seg = h;
    if (!bar.hasAttribute('data-seg-no-gesture')) bind(h);
    h.sync(false);
    return h;
  }

  /* ---------------- 手势：与 dock-glass.js 同结构 ---------------- */
  /* 拖动后吞掉系统补发的那次 click：
   * - 轻点：补发 click 落在栏内，只需吃栏内的；
   * - 拖动：手指可能已滑出栏条，补发 click 会落在栏外（误开卡片），须在 document 层全吃。
   * 自己派发的导航 click（hit.click()）用 selfClick 放行，不被窗口误伤。 */
  let suppressUntil = 0;
  let suppressEverywhere = false;
  let selfClick = false;
  document.addEventListener('click', e => {
    if (selfClick || performance.now() >= suppressUntil) return;
    if (suppressEverywhere || !(e.target instanceof Element) || e.target.closest(SELECTOR)) {
      e.stopPropagation(); e.preventDefault();
    }
  }, true);

  function bind(h) {
    const bar = h.bar;

    const trackMove = e => {
      const dx = e.clientX - h.startX, dy = e.clientY - h.startY;
      if (!h.dragging) {
        if (Math.abs(dx) < DRAG_SLOP && Math.abs(dy) < DRAG_SLOP) return;
        if (Math.abs(dx) <= Math.abs(dy)) return;        // 竖向 → 让页面滚动
        h.dragging = true;
        h.setDragging(true);
        buzz(8);
      }
      h.follow(e.clientX);
      // 悬停判定只看横坐标在栏内的投影（离哪格最近就算哪格）：
      // 手指拖动时经常滑到栏外/栏下方，elementFromPoint(指针位置) 会取不到按钮，
      // 导致「透镜明明拖到了这格、松手却不切」——悬停必须与透镜位置同源。
      const items = listOf(bar);
      const rects = h.rects();
      const x = e.clientX - bar.getBoundingClientRect().left;
      let best = null, bestD = Infinity;
      items.forEach((el, i) => {
        const r = rects[i];
        const dd = x < r.l ? r.l - x : (x > r.l + r.w ? x - (r.l + r.w) : 0);
        if (dd < bestD) { bestD = dd; best = el; }
      });
      h.setHover(best);
    };

    bar.addEventListener('pointerdown', e => {
      if (e.button != null && e.button !== 0) return;
      const btn = e.target.closest('button');
      if (!btn) return;
      h.pointerId = e.pointerId;
      h.startX = e.clientX; h.startY = e.clientY;
      h.dragging = false;
      h.hovered = undefined;
      try { bar.setPointerCapture(e.pointerId); } catch (_) { }
      btn.classList.add('holding');
      h.paint(btn, true);          // 按下即成为焦点：透镜先吸附过去
    }, { passive: true });

    const finish = (e, cancelled) => {
      if (h.pointerId === null || (e && e.pointerId !== h.pointerId)) return;
      const wasDragging = h.dragging;
      const target = h.hovered;
      h.pointerId = null; h.dragging = false;
      try { bar.releasePointerCapture(e.pointerId); } catch (_) { }
      h.release();
      if (cancelled) { suppressUntil = 0; return; }
      const cur = currentOf(bar);
      let hit = target;
      if (!hit && e && !wasDragging) {
        // 轻点兜底：手指通常就落在按钮上
        const el = document.elementFromPoint(e.clientX ?? 0, e.clientY ?? 0);
        const btn = el ? el.closest('button') : null;
        hit = btn && bar.contains(btn) ? btn : null;
      }
      if (wasDragging) buzz(6);
      // 一律自己派发 click：pointer capture 会把浏览器补发的 click 重定向到栏身上，
      // 届时 closest('[data-library-tab]') 取不到按钮——轻点就会「没反应」。
      // 轻点（没拖动）时即使原地重复点也照常派发，保持与浏览器原生点击一致的行为。
      if (hit && (!wasDragging || hit !== cur)) {
        selfClick = true;
        try { hit.click(); } finally { selfClick = false; }
      }
      suppressEverywhere = wasDragging;
      suppressUntil = performance.now() + 350;   // 吃掉系统补发的那次 click
    };

    /* 移动/松手挂 document 捕获段：指针捕获偶尔会被系统提前收回
     * （部分 WebView、无头环境都会出现，pointerup 直接到不了栏上），
     * 表现为「透镜拖过去了、松手却不切换」。捕获只作加速，不作依赖。 */
    document.addEventListener('pointermove', e => {
      if (h.pointerId === null || e.pointerId !== h.pointerId) return;
      trackMove(e);
    }, { passive: true, capture: true });
    document.addEventListener('pointerup', e => {
      if (h.pointerId === null || e.pointerId !== h.pointerId) return;
      finish(e, false);
    }, { passive: true, capture: true });
    document.addEventListener('pointercancel', e => {
      if (h.pointerId === null || e.pointerId !== h.pointerId) return;
      finish(e, true);
    }, { passive: true, capture: true });

    h.__suppress = () => suppressUntil;

    /* selected 类由 app.js 切换，这里同步透镜位置 */
    const mo = new MutationObserver(() => { if (!h.dragging) h.animate(); });
    listOf(bar).forEach(b => mo.observe(b, { attributes: true, attributeFilter: ['class'] }));
    bar.__segMO = mo;
  }

  /* ---------------- 自动挂载：tab 栏随页面重渲染重建 ---------------- */
  function attachAll(root) {
    if (!root || !root.querySelectorAll) return;
    for (const bar of root.querySelectorAll(SELECTOR)) handle(bar);
  }

  function syncAll(root) {
    if (!root || !root.querySelectorAll) return;
    for (const bar of root.querySelectorAll(SELECTOR)) {
      if (bar.__seg && !bar.__seg.dragging) bar.__seg.animate();
    }
  }

  const target = document.getElementById('content') || document.body;
  const mo = new MutationObserver(records => {
    for (const r of records) {
      for (const node of r.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.matches && node.matches(SELECTOR)) handle(node);
        attachAll(node);
      }
    }
  });
  try { mo.observe(target, { childList: true, subtree: true }); } catch (_) { }
  addEventListener('resize', () => syncAll(target));
  addEventListener('orientationchange', () => setTimeout(() => syncAll(target), 260));

  window.SegGlass = { handle, attachAll, syncAll };
  attachAll(target);
})();
