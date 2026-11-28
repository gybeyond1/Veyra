/*!
 * 私密模式启动动画（手机 / 电视 / WebUI 共用）
 *
 * 规则：
 * - 铺满整个视口，只放画面：没有进度条、没有右键菜单、点击/触摸全部吞掉
 * - 保留声音；先静音起播（绕开自动播放策略），起来后立刻恢复
 * - 播完 / 出错 / 超时都会 resolve，调用方接着切私密内容
 *
 * 两个坑（都踩过）：
 * 1) 以前进动画前会 requestFullscreen。Chrome 在全屏下会弹「若要退出全屏…」的提示，
 *    而且页面全屏后常有几像素没被盖住 —— 顶部那条白线就是页面背景（--bg 是浅色）露出来的。
 *    fixed + inset:0 本来就铺满视口，全屏 API 只是多了一层浏览器 UI，纯负担，已去掉。
 * 2) 以前直接带声音 play()，被自动播放策略拦下时 Chrome 会在黑底上画一个大播放按钮，
 *    用户看到的是「动画卡住不动」。现在先 muted 静音起播，playing 之后再取消静音。
 */
(function () {
  if (window.veyraIntro) return;

  var STYLE = [
    '.veyra-intro{position:fixed;left:0;top:0;right:0;bottom:0;width:100%;height:100%;',
    'height:100dvh;z-index:2147483647;background:#000;',
    'display:flex;align-items:center;justify-content:center;overflow:hidden;',
    'opacity:1;transition:opacity .26s ease;touch-action:none;',
    'user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent}',
    '.veyra-intro.veyra-intro-out{opacity:0}',
    /* contain：动画是 16:9 的 logo 片头，cover 会在竖屏手机上把「VeyraTV」裁掉；
       上下留的边是黑的，和图层的黑底连成一片，看不出边界 */
    '.veyra-intro video{width:100%;height:100%;object-fit:contain;background:#000;',
    'pointer-events:none;outline:none}',
    /* 播放期间把根节点也刷黑：任何一像素没被图层覆盖的地方都只会是黑的 */
    'html.veyra-intro-open,html.veyra-intro-open body{background:#000!important;overflow:hidden!important}'
  ].join('');

  function injectStyle() {
    if (document.getElementById('veyra-intro-style')) return;
    var style = document.createElement('style');
    style.id = 'veyra-intro-style';
    style.textContent = STYLE;
    (document.head || document.documentElement).appendChild(style);
  }

  var current = null;

  function play(options) {
    if (current) return current;
    options = options || {};
    injectStyle();

    current = new Promise(function (resolve) {
      var layer = document.createElement('div');
      layer.className = 'veyra-intro';
      layer.setAttribute('aria-hidden', 'true');

      var video = document.createElement('video');
      video.playsInline = true;
      video.setAttribute('playsinline', '');
      video.setAttribute('webkit-playsinline', '');
      video.setAttribute('autoplay', '');
      video.setAttribute('disablepictureinpicture', '');
      video.setAttribute('controlslist', 'nodownload nofullscreen noremoteplayback');
      video.preload = 'auto';
      video.volume = 1;
      /* 先静音：带声音的 play() 在移动端十有八九被拦，拦了就会画出浏览器自带的播放按钮 */
      video.muted = true;
      video.src = options.src || 'intro.mp4';
      layer.appendChild(video);

      var finished = false;
      var timer = 0;
      var unmuted = false;

      var root = document.documentElement;
      var body = document.body;
      root.classList.add('veyra-intro-open');

      function teardown() {
        if (finished) return;
        finished = true;
        if (timer) clearTimeout(timer);
        layer.className = 'veyra-intro veyra-intro-out';
        setTimeout(function () {
          if (layer.parentNode) layer.parentNode.removeChild(layer);
          root.classList.remove('veyra-intro-open');
          current = null;
          resolve();
        }, 280);
      }

      // 这是动画，不是播放器：任何输入都不该有反应
      var swallow = ['click', 'dblclick', 'contextmenu', 'mousedown', 'mouseup',
        'pointerdown', 'pointerup', 'touchstart', 'touchend', 'wheel', 'keydown'];
      for (var i = 0; i < swallow.length; i++) {
        layer.addEventListener(swallow[i], function (event) {
          event.preventDefault();
          event.stopPropagation();
        }, { passive: false });
      }

      video.addEventListener('ended', teardown);
      video.addEventListener('error', teardown);
      /* 起播后取消静音：用户在点「私密」时刚有过手势，这一步基本都能成功；
         万一被策略暂停，就退回静音继续放，画面不能停。 */
      video.addEventListener('playing', function () {
        if (unmuted || options.muted) return;
        unmuted = true;
        try { video.muted = false; } catch (ignore) { return; }
        setTimeout(function () {
          if (!finished && video.paused) { video.muted = true; video.play().catch(function () {}); }
        }, 240);
      });
      // 兜底：解码失败或卡住时别把人锁在黑屏里
      timer = setTimeout(teardown, options.maxMs || 9000);

      (body || root).appendChild(layer);

      var started = video.play();
      if (started && started.catch) started.catch(teardown);
    });

    return current;
  }

  window.veyraIntro = { play: play };
})();
