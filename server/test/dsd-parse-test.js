'use strict';
/*
 * 帝果解析离线回归：不联网，只喂 HTML 片段和 aaencode 片段。
 *
 * 为什么单独留一份：这个站的三个坑（没有详情页、播放页正文由 JS 注入、媒体地址要
 * 过 vplayer 签名）都是端侧试出来的，服务端照抄时最容易只抄一半 ——
 * 一旦「详情页没有解析到分集」复发，先跑这个，能立刻分清是解析坏了还是站点连不上。
 *
 * 跑法：node test/dsd-parse-test.js
 */
const assert = require('assert');
const dsd = require('../sources/dsd');
const { parseDetail, player, aaDecode, cards, mediaFromCover, routeOf, tidy } = dsd.__test;

/* 1) 卡片：标题在 .video-desc 里，封面挂在 <a> 的 background-image 上 */
const listHtml = `
<div class="video-list">
  <a class="video-item" href="/index.php/vod/play/id/491698/sid/1/nid/1.html" style="background-image:url('/video1/g1/IPZZ-969/1.jpg')">
    <div class="video-desc">IPZZ-969 葵つかさ 无码中字</div>
    <div class="video-meta">491698次 03:24:46 全 12 集</div>
  </a>
  <a class="video-item" href="/index.php/vod/play/id/491699/sid/1/nid/1.html">
    <img data-src="/video2/g9/ABC-001/1.jpg" src="/static/lazy.gif" alt="">
    <div class="surface-title">ABC-001 标题</div>
  </a>
</div>`;
const list = cards(listHtml, 'https://www.dsd.com.se/');
assert.strictEqual(list.length, 2, 'should parse 2 cards');
assert.strictEqual(list[0].title, 'IPZZ-969 葵つかさ 无码中字', 'title from .video-desc: ' + list[0].title);
assert.strictEqual(list[0].cover, 'https://www.dsd.com.se/video1/g1/IPZZ-969/1.jpg', 'cover from a[style]');
assert.strictEqual(list[0].episodeLabel, '全 12 集');
assert.strictEqual(list[1].cover.indexOf('/video2/g9/ABC-001/1.jpg') > 0, true, 'skip lazy placeholder');

/* 2) player_aaaa：嵌套对象 + 单引号转义 */
const playHtml = `<!doctype html><html><head>
<meta property="og:title" content="IPZZ-969 葵つかさ">
<meta property="og:image" content="/video1/g1/IPZZ-969/1.jpg">
<title>在线播放 IPZZ-969</title></head><body>
<h1 class="video-title">IPZZ-969 葵つかさ</h1>
<script>var player_aaaa={"flag":"play","encrypt":0,"trysee":0,"points":0,"id":"491698","sid":1,"nid":1,
"url":"https:\\/\\/cdn.example.com\\/video1\\/g1\\/IPZZ-969\\/1000k\\/index.m3u8","vod_data":{"vod_name":"IPZZ-969 葵つかさ","vod_blurb":"简介"}};</script>
</body></html>`;
const p = player(playHtml);
assert.ok(p && p.id === '491698' && p.sid === 1, 'player object parsed');
const detail = parseDetail('491698', { url: 'https://www.dsd.com.se/index.php/vod/play/id/491698/sid/1/nid/1.html', html: playHtml }, p);
assert.strictEqual(detail.title, 'IPZZ-969 葵つかさ');
assert.strictEqual(detail.episodes.length, 1, 'single 正片 fallback');
assert.strictEqual(detail._episodes[0].title, '正片');

/* 3) 多线路：只留集数最多的那条 */
const multiHtml = playHtml.replace('</body>', `
<div class="play-list">
  <a href="/index.php/vod/play/id/491698/sid/1/nid/1.html">第1集</a>
  <a href="/index.php/vod/play/id/491698/sid/1/nid/2.html">第2集</a>
  <a href="/index.php/vod/play/id/491698/sid/1/nid/3.html">第3集</a>
  <a href="/index.php/vod/play/id/491698/sid/2/nid/1.html">线路2-1</a>
</div></body>`);
const multi = parseDetail('491698', { url: 'https://www.dsd.com.se/index.php/vod/play/id/491698/sid/1/nid/1.html', html: multiHtml }, p);
assert.strictEqual(multi.episodes.length, 3, 'three episodes on best line');
assert.strictEqual(multi.episodeLabel, '共 3 集');


/* 3.5) vod_play_url：真正能给出选集的那条路 */
const vodHtml = playHtml.replace('"vod_data":{"vod_name":"IPZZ-969 葵つかさ","vod_blurb":"简介"}',
  '"vod_data":{"vod_name":"IPZZ-969 葵つかさ","vod_blurb":"简介","vod_play_url":"第01集$https://cdn.example.com/v/1.m3u8#第02集$https://cdn.example.com/v/2.m3u8#第03集$https://cdn.example.com/v/3.m3u8"}');
const vodDetail = parseDetail('491698', { url: 'https://www.dsd.com.se/index.php/vod/play/id/491698/sid/1/nid/1.html', html: vodHtml }, player(vodHtml));
assert.strictEqual(vodDetail.episodes.length, 3, 'vod_play_url episodes');
assert.strictEqual(vodDetail._episodes[0].title, '第01集', 'label kept: ' + vodDetail._episodes[0].title);
assert.strictEqual(vodDetail._episodes[1].direct, 'https://cdn.example.com/v/2.m3u8');

/* 4) 封面反推媒体地址 */
assert.strictEqual(
  mediaFromCover('https://www.dsd.com.se/video1/g1/IPZZ-969/1.jpg'),
  'https://www.dsd.com.se/video1/g1/IPZZ-969/1000k/index.m3u8'
);
assert.strictEqual(mediaFromCover('https://www.dsd.com.se/upload/x.jpg'), '');

/* 5) aaencode 解码：把 "/abc/1000k/index.m3u8" 按站点格式编码回去再解 */
function aaEncodePath(text) {
  const ones = (count) => `(${Array(count).fill('(ﾟΘﾟ)').join('+')})`;
  const aliases = { 0: '(c^_^o)', 1: '(ﾟΘﾟ)', 3: '(o^_^o)', 4: '(ﾟｰﾟ)' };
  const digitOf = (digit) => aliases[digit] || ones(Number(digit));
  const tokens = [...text].map((char) => [...char.charCodeAt(0).toString(8)].map(digitOf).join('+'));
  return `(ﾟДﾟ)['_']((ﾟДﾟ)['_'](ﾟεﾟ+(ﾟДﾟ)[ﾟoﾟ]+(ﾟДﾟ)[ﾟεﾟ]+${tokens.join('+(ﾟДﾟ)[ﾟεﾟ]+')}+(ﾟДﾟ)[ﾟoﾟ]);`;
}
const encoded = aaEncodePath('/abc/1000k/index.m3u8');
const decoded = aaDecode(encoded);
assert.strictEqual(decoded, '/abc/1000k/index.m3u8', 'aaencode roundtrip: ' + decoded);

/* 6) 路由兼容写法 */
assert.deepStrictEqual(routeOf('https://www.dsd.com.se/index.php/vod/play/id/12/sid/1/nid/3.html').params, { id: '12', sid: '1', nid: '3' });
assert.strictEqual(routeOf('https://www.dsd.com.se/index.php/vod/type/id/3/page/2.html').int('page'), 2);
assert.strictEqual(routeOf('https://evil.example.com/vod/play/id/1/sid/1/nid/1.html'), null);

/* 7) 标题清洗 */
assert.strictEqual(tidy('剧名 452346次 02:07:40'), '剧名');
assert.strictEqual(tidy('全 88 集 剧名'), '剧名');

console.log('dsd parser ok');
