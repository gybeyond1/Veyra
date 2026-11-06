/*!
 * 私密模式启动动画（手机 / 电视 / WebUI 共用）
 *
 * 规则：
 * - 全屏黑底，只放画面：没有进度条、没有右键菜单、点击/触摸全部吞掉
 * - 保留声音；被自动播放策略拦下时先静音起播，起来后立刻恢复
 * - 播完 / 出错 / 超时都会 resolve，调用方接着切私密内容
 */
(function () {
  if (window.veyraIntro) return;

  var STYLE = [
    '.veyra-intro{position:fixed;inset:0;z-index:2147483647;background:#000;',
    'display:flex;align-items:center;justify-content:center;overflow:hidden;',
    'opacity:1;transition:opacity .26s ease;touch-action:none;',
    'user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent}',
    '.veyra-intro.veyra-intro-out{opacity:0}',
    '.veyra-intro video{width:100%;height:100%;object-fit:contain;background:#000;',
    'pointer-events:none;outline:none}'
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
      video.setAttribute('webkit-playsinline', '');
      video.setAttribute('disablepictureinpicture', '');
      video.setAttribute('controlslist', 'nodownload nofullscreen noremoteplayback');
      video.preload = 'auto';
      video.volume = 1;
      video.src = options.src || 'intro.mp4';
      layer.appendChild(video);

      var finished = false;
      var timer = 0;

      function teardown() {
        if (finished) return;
        finished = true;
        if (timer) clearTimeout(timer);
        layer.className = 'veyra-intro veyra-intro-out';
        setTimeout(function () {
          if (layer.parentNode) layer.parentNode.removeChild(layer);
          root.style.overflow = rootOverflow;
          if (body) body.style.overflow = bodyOverflow;
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

      // 播放期间锁住页面滚动，不然右侧会露一条滚动条
      var root = document.documentElement;
      var body = document.body;
      var rootOverflow = root.style.overflow;
      var bodyOverflow = body ? body.style.overflow : '';
      root.style.overflow = 'hidden';
      if (body) body.style.overflow = 'hidden';

      video.addEventListener('ended', teardown);
      video.addEventListener('error', teardown);
      // 兜底：解码失败或卡住时别把人锁在黑屏里
      timer = setTimeout(teardown, options.maxMs || 9000);

      (document.body || document.documentElement).appendChild(layer);

      var started = video.play();
      if (started && started.catch) {
        started.catch(function () {
          video.muted = true;
          var retry = video.play();
          if (retry && retry.then) {
            retry.then(function () { video.muted = false; }).catch(teardown);
          } else {
            teardown();
          }
        });
      }
    });

    return current;
  }

  window.veyraIntro = { play: play };
})();
