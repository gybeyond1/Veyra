/* 老内核兼容层（Android WebView ≤ 87 / Chrome ≤ 87）
 *
 * 这套主题的 --bg / --surface / --mat-* 大量用 color-mix() 从配色里混出来。
 * color-mix() 是 Chrome 111 才有的函数，87 及以下整条声明判定无效：
 * 变量本身还留着 token，但一旦被 var() 引用就 invalid at computed-value time，
 * 属性退回初始值 —— 背景变透明、卡片没底色，登录层就成了「透明纸片浮在首页上」。
 *
 * 做法：启动前（head 内同步脚本，CSS 已加载）把当前生效的、含 color-mix 的自定义属性
 * 逐个求值成 rgba()，再以内联样式写回 <html>。内联优先级高于样式表，于是老内核拿到的
 * 是算好的实色，新内核因为原生支持 color-mix 直接跳过这段，零开销。
 * 切换外观（明暗/材质/配色）时重算一次，先撤掉上一轮写进去的内联值，否则会盖住新主题。
 */
(function () {
  var root = document.documentElement;
  var supported = true;
  try {
    supported = !!(window.CSS && CSS.supports && CSS.supports('color', 'color-mix(in srgb, red 50%, blue)'));
  } catch (e) {
    supported = false;
  }
  window.__veyraCompat = { colorMix: supported };
  if (supported) return;

  /* 给 <html> 打个记号，CSS 里所有老内核兜底都挂在这个属性上。
     不用 @supports not (color: color-mix(...)) 是因为 87 对这个条件的求值不可靠：
     上一版整块兜底在真机上一条都没生效（焦点框还在、头图遮罩仍在用实色）。 */
  root.setAttribute('data-legacy', '1');

  var NAMED = {
    transparent: [0, 0, 0, 0],
    none: null,
    white: [255, 255, 255, 1],
    black: [0, 0, 0, 1],
    red: [255, 0, 0, 1],
    gray: [128, 128, 128, 1],
    grey: [128, 128, 128, 1],
    silver: [192, 192, 192, 1]
  };

  function clamp255(v) {
    v = Math.round(v);
    return v < 0 ? 0 : v > 255 ? 255 : v;
  }

  function num(t) {
    t = String(t).trim();
    if (/%$/.test(t)) return parseFloat(t) / 100;
    return parseFloat(t);
  }

  /* "#rgb" "#rgba" "#rrggbb" "#rrggbbaa" */
  function fromHex(s) {
    var h = s.slice(1);
    if (h.length === 3 || h.length === 4) {
      h = h.replace(/./g, function (c) { return c + c; });
    }
    if (h.length !== 6 && h.length !== 8) return null;
    return [
      parseInt(h.slice(0, 2), 16),
      parseInt(h.slice(2, 4), 16),
      parseInt(h.slice(4, 6), 16),
      h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1
    ];
  }

  /* rgb() / rgba()，逗号与空格两种写法都收 */
  function fromRgb(s) {
    var body = s.slice(s.indexOf('(') + 1, s.lastIndexOf(')'));
    var slash = body.split('/');
    var head = slash[0].replace(/,/g, ' ').trim().split(/\s+/);
    if (head.length < 3) return null;
    var r = /%$/.test(head[0]) ? parseFloat(head[0]) * 2.55 : parseFloat(head[0]);
    var g = /%$/.test(head[1]) ? parseFloat(head[1]) * 2.55 : parseFloat(head[1]);
    var b = /%$/.test(head[2]) ? parseFloat(head[2]) * 2.55 : parseFloat(head[2]);
    var a = 1;
    var at = slash.length > 1 ? slash[1] : head[3];
    if (at != null && String(at).trim() !== '') a = num(at);
    if (isNaN(r) || isNaN(g) || isNaN(b) || isNaN(a)) return null;
    return [clamp255(r), clamp255(g), clamp255(b), a < 0 ? 0 : a > 1 ? 1 : a];
  }

  function parseColor(str) {
    if (!str) return null;
    var s = String(str).trim().toLowerCase();
    if (!s) return null;
    if (Object.prototype.hasOwnProperty.call(NAMED, s)) {
      return NAMED[s] ? NAMED[s].slice() : null;
    }
    if (s.charAt(0) === '#') return fromHex(s);
    if (/^rgba?\(/.test(s)) return fromRgb(s);
    return null;
  }

  /* 按顶层逗号切分：color-mix 的参数里可能还有 linear-gradient / var(...) 的括号 */
  function splitTop(text, sep) {
    var out = [], buf = '', depth = 0, i;
    for (i = 0; i < text.length; i++) {
      var c = text.charAt(i);
      if (c === '(') depth++;
      else if (c === ')') depth--;
      if (c === sep && depth === 0) { out.push(buf); buf = ''; }
      else buf += c;
    }
    out.push(buf);
    return out;
  }

  /* 找出字符串里所有顶层（可以嵌套）的 color-mix( ... ) 片段 */
  function findColorMix(s, from) {
    var i = s.indexOf('color-mix(', from || 0);
    if (i < 0) return null;
    var j = i + 10, depth = 1;
    while (j < s.length && depth > 0) {
      var c = s.charAt(j);
      if (c === '(') depth++;
      else if (c === ')') depth--;
      j++;
    }
    if (depth !== 0) return null;
    return { start: i, end: j, inner: s.slice(i + 10, j - 1) };
  }

  /* 把字符串里的 var(--x[, fallback]) 全展开成当前值 */
  function expandVars(s, stack) {
    var guard = 0;
    while (s.indexOf('var(') >= 0 && guard++ < 40) {
      var i = s.indexOf('var(');
      var j = i + 4, depth = 1;
      while (j < s.length && depth > 0) {
        var c = s.charAt(j);
        if (c === '(') depth++;
        else if (c === ')') depth--;
        j++;
      }
      if (depth !== 0) break;
      var body = s.slice(i + 4, j - 1);
      var parts = splitTop(body, ',');
      var name = parts[0].trim();
      var fb = parts.length > 1 ? parts.slice(1).join(',').trim() : '';
      var val = readVar(name, stack) || fb;
      s = s.slice(0, i) + (val == null ? '' : val) + s.slice(j);
    }
    return s;
  }

  /* 读一个自定义属性的当前值；含 color-mix 就先求值（并写回内联，供后续复用） */
  var memo = {};
  function readVar(name, stack) {
    stack = stack || [];
    if (Object.prototype.hasOwnProperty.call(memo, name)) return memo[name];
    if (stack.indexOf(name) >= 0) return '';
    var raw = '';
    try {
      raw = (window.getComputedStyle(root).getPropertyValue(name) || '').trim();
    } catch (e) {
      raw = '';
    }
    if (!raw) { memo[name] = raw; return raw; }
    if (raw.indexOf('color-mix(') >= 0) {
      var next = stack.concat([name]);
      var out = evalAll(raw, next);
      memo[name] = out;
      applyVar(name, out);
      return out;
    }
    memo[name] = raw;
    return raw;
  }

  /* 把一段值里所有 color-mix 换成 rgba()，其余原样保留（渐变、阴影都靠这个） */
  function evalAll(value, stack) {
    var s = String(value);
    var guard = 0;
    while (guard++ < 40) {
      var hit = findColorMix(s, 0);
      if (!hit) break;
      var mixed = evalMix(hit.inner, stack);
      if (mixed == null) break;
      s = s.slice(0, hit.start) + mixed + s.slice(hit.end);
    }
    return s;
  }

  /* color-mix(in srgb, A p%, B q%) —— 按预乘 alpha 混，和浏览器算的一致 */
  function evalMix(inner, stack) {
    var parts = splitTop(inner, ',');
    if (parts.length < 2) return null;
    var args = parts.slice(1).map(function (p) { return p.trim(); });
    if (args.length === 2) args.push(null);
    var got = [];
    var i;
    for (i = 0; i < 2; i++) {
      var token = args[i] || '';
      var pct = null;
      var m = token.match(/\s(-?[\d.]+%)\s*$/);
      if (m) { pct = parseFloat(m[1]) / 100; token = token.slice(0, m.index).trim(); }
      var col = parseColor(expandVars(token, stack).trim());
      if (!col) return null;
      got.push({ c: col, p: pct });
    }
    var p1 = got[0].p, p2 = got[1].p;
    if (p1 == null && p2 == null) { p1 = 0.5; p2 = 0.5; }
    else if (p1 == null) p1 = 1 - p2;
    else if (p2 == null) p2 = 1 - p1;
    if (p1 < 0) p1 = 0;
    if (p2 < 0) p2 = 0;
    var sum = p1 + p2;
    if (sum <= 0) return 'rgba(0, 0, 0, 0)';
    p1 /= sum;
    p2 /= sum;
    var a1 = got[0].c[3], a2 = got[1].c[3];
    var alpha = a1 * p1 + a2 * p2;
    if (alpha <= 0) return 'rgba(0, 0, 0, 0)';
    var out = [0, 0, 0];
    for (i = 0; i < 3; i++) {
      out[i] = (got[0].c[i] * a1 * p1 + got[1].c[i] * a2 * p2) / alpha;
    }
    return 'rgba(' + clamp255(out[0]) + ', ' + clamp255(out[1]) + ', ' + clamp255(out[2]) +
      ', ' + Math.round(alpha * 1000) / 1000 + ')';
  }

  /* 收集所有含 color-mix 的自定义属性名：扫样式表，不写死名单，主题以后再扩也认 */
  function collectNames() {
    var names = [];
    var seen = {};
    function walk(rules) {
      var i, r;
      for (i = 0; i < rules.length; i++) {
        r = rules[i];
        if (r.cssText && r.cssText.indexOf('color-mix(') >= 0) {
          var re = /(--[\w-]+)\s*:\s*([^;{}]*color-mix\([^;{}]*)/g, m;
          while ((m = re.exec(r.cssText))) {
            if (!seen[m[1]]) { seen[m[1]] = 1; names.push(m[1]); }
          }
        }
        if (r.style && r.style.length) {
          for (var k = 0; k < r.style.length; k++) {
            var prop = r.style[k];
            if (prop.indexOf('--') !== 0) continue;
            var v = r.style.getPropertyValue(prop);
            if (v && v.indexOf('color-mix(') >= 0 && !seen[prop]) {
              seen[prop] = 1;
              names.push(prop);
            }
          }
        }
        if (r.cssRules) walk(r.cssRules);
      }
    }
    for (var s = 0; s < document.styleSheets.length; s++) {
      var rules = null;
      try { rules = document.styleSheets[s].cssRules; } catch (e) { rules = null; }
      if (rules) walk(rules);
    }
    return names;
  }

  /* App 在 WebView 里是以 file:///android_asset/ 打开的，跨文件读 cssRules 会抛
     SecurityError —— document.styleSheets 扫不到东西。所以样式表只当补充：
     这份名单是 sunny-theme.css / app.css 里所有含 color-mix 的自定义属性（当前 17 个），
     换主题时按名单逐个读值就够。CSS 以后新增变量、且又走 http 打开时，扫描会补上。 */
  var BUILTIN = ['--dock', '--mat-sidebar', '--mat-active-bg', '--bg', '--surface',
    '--soft-base', '--mat-chrome', '--mat-fill', '--mat-edge', '--mat-control-edge',
    '--mat-page', '--mat-control', '--mat-active-shadow', '--mat-shadow',
    '--mat-control-shadow', '--mat-input-shadow', '--mat-sidebar-shadow'];

  var managed = [];
  function applyVar(name, value) {
    if (managed.indexOf(name) < 0) managed.push(name);
    try { root.style.setProperty(name, value); } catch (e) { }
  }

  function run() {
    var i;
    for (i = 0; i < managed.length; i++) root.style.removeProperty(managed[i]);
    managed = [];
    memo = {};
    void root.offsetWidth;   /* 逼一次样式重算，否则 getComputedStyle 可能读回刚撤掉的旧值 */
    var names = BUILTIN.slice();
    var extra = collectNames(), k;
    for (k = 0; k < extra.length; k++) {
      if (names.indexOf(extra[k]) < 0) names.push(extra[k]);
    }
    for (i = 0; i < names.length; i++) readVar(names[i], []);
    verify();
  }

  /* 保险：万一这个内核连「含未知函数的自定义属性」都读不出来（读到空串），
     上面整条链路会静默失效，登录层又变透明。这里逐个验收，没落实的用固定色顶上。
     正常路径下所有值都已是 rgba()，不会走到赋值。 */
  var FB_LIGHT = {
    '--bg': '#eceff4', '--surface': '#ffffff', '--soft-base': '#f3f5f9',
    '--mat-page': '#eceff4', '--mat-fill': '#ffffff', '--mat-chrome': '#ffffff',
    '--mat-control': '#ffffff', '--mat-edge': '#dfe4ec', '--mat-control-edge': '#e2e7ef',
    '--mat-sidebar': '#f7f8fb', '--mat-active-bg': 'rgba(127, 134, 148, .12)', '--dock': '#ffffff'
  };
  var FB_DARK = {
    '--bg': '#12171f', '--surface': '#1a212b', '--soft-base': '#1b222c',
    '--mat-page': '#12171f', '--mat-fill': '#1a212b', '--mat-chrome': '#1a212b',
    '--mat-control': '#202834', '--mat-edge': '#2b3542', '--mat-control-edge': '#2b3542',
    '--mat-sidebar': '#171d26', '--mat-active-bg': 'rgba(160, 170, 190, .16)', '--dock': '#1a212b'
  };
  function verify() {
    var fb = root.getAttribute('data-theme') === 'dark' ? FB_DARK : FB_LIGHT;
    for (var name in fb) {
      if (!Object.prototype.hasOwnProperty.call(fb, name)) continue;
      var cur = '';
      try { cur = (window.getComputedStyle(root).getPropertyValue(name) || '').trim(); } catch (e) { cur = ''; }
      if (!cur || cur.indexOf('color-mix(') >= 0) applyVar(name, fb[name]);
    }
  }

  run();

  /* 换明暗/材质/配色/圆角/玻璃开关都会改 <html> 的 data-*，重算一遍。
     style 属性自己也变（就是上面写内联），必须排除，否则自激。 */
  try {
    var mo = new MutationObserver(function () { run(); });
    mo.observe(root, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-material', 'data-color', 'data-corner',
        'data-glass', 'data-btn-mat', 'data-lens', 'class']
    });
  } catch (e) { }
})();
