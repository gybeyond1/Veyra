'use strict';
/**
 * 帝果（www.dsd.com.se，苹果 CMS 模板站）
 *
 * 接口是纯 HTML，没有 JSON API：
 *   · 目录页：a.video-item / a.video-surface，链接形如 /index.php/vod/play/id/123/sid/1/nid/1.html
 *   · 详情页：播放列表里的 sid/nid 就是分集坐标，标题/封面在 og: 标签里
 *   · 播放页：内嵌 player_aaaa = {...}，url 字段按 encrypt（0 明文 / 1 URL 编码 / 2 base64+URL 编码）
 *
 * 这个站对数据中心出口不友好（Cloudflare 前置 + 对部分机房 IP 直接 reset），
 * 所以失败时要把「连不上」和「解析失败」分开报，别让用户以为是剧坏了。
 */

const { request, cached } = require('./util');

const SITE = 'https://www.dsd.com.se';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const VOD = /\/vod\/(play|detail|type|show|search)\/id\/(\d+)(?:\/sid\/(\d+))?(?:\/nid\/(\d+))?/;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function text(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (all, name) => {
      if (name[0] === '#') {
        const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : all;
      }
      return ENTITIES[name.toLowerCase()] !== undefined ? ENTITIES[name.toLowerCase()] : all;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

function attrs(source) {
  const map = {};
  const pattern = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let hit;
  while ((hit = pattern.exec(source))) map[hit[1].toLowerCase()] = hit[3] ?? hit[4] ?? hit[5] ?? '';
  return map;
}

function absolute(raw, base) {
  const value = String(raw || '').trim();
  if (!value || /^data:/i.test(value)) return '';
  try {
    const url = new URL(value, base);
    return /^https?:$/.test(url.protocol) ? url.toString() : '';
  } catch {
    return '';
  }
}

async function page(path) {
  const url = /^https?:/i.test(path) ? path : `${SITE}${path.startsWith('/') ? '' : '/'}${path}`;
  const res = await request(url, {
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'zh-CN,zh;q=0.9' },
    timeout: 8000,
    maxBytes: 6 << 20,
  }).catch((error) => {
    throw new Error(`帝果连不上（${error.message}）——这个站会按出口 IP 拦截，服务器访问不了时需要走代理`);
  });
  if (res.status < 200 || res.status >= 300) throw new Error(`帝果返回 ${res.status}`);
  const body = res.text();
  if (!/<\s*(html|body|div|a)\b/i.test(body)) throw new Error('帝果返回的不是页面');
  return { url, html: body };
}

/* ---------------- 解析 ---------------- */

function anchors(html) {
  const out = [];
  const pattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let hit;
  while ((hit = pattern.exec(html))) out.push({ attr: attrs(hit[1]), inner: hit[2] });
  return out;
}

function classOf(attr) {
  return String(attr.class || '').toLowerCase();
}

function coverFrom(block, base) {
  const img = /<img\b([^>]*)>/i.exec(block);
  if (img) {
    const map = attrs(img[1]);
    for (const key of ['data-src', 'data-original', 'data-echo', 'src']) {
      const value = absolute(map[key], base);
      if (value) return value;
    }
  }
  const style = /style\s*=\s*("[^"]*"|'[^']*')/i.exec(block);
  if (style) {
    const found = /url\(\s*["']?([^"')]+)/i.exec(style[1]);
    if (found) return absolute(found[1], base);
  }
  return '';
}

function cards(html, base) {
  const items = [];
  const seen = new Set();
  for (const anchor of anchors(html)) {
    const cls = classOf(anchor.attr);
    if (!/video-item|video-surface/.test(cls)) continue;
    const href = absolute(anchor.attr.href, base);
    if (!href) continue;
    const match = VOD.exec(href);
    if (!match || !/play|detail/.test(match[1])) continue;
    const id = match[2];
    if (seen.has(id)) continue;
    const title = text(anchor.inner).replace(/^(VIP|会员|独播|新剧)\s*/i, '').slice(0, 200) || text(anchor.attr.title);
    if (!title) continue;
    seen.add(id);
    const episodes = Number((/\d+\s*集/.exec(text(anchor.inner)) || [])[0]?.replace(/\D/g, '')) || 0;
    items.push({
      id,
      title,
      cover: coverFrom(anchor.inner, base),
      description: '',
      score: '',
      episodeLabel: episodes ? `全 ${episodes} 集` : '',
      category: '短剧',
      tags: [],
      status: episodes ? 'finished' : '',
    });
  }
  return items;
}

function categories(html, base) {
  const list = [{ id: '', name: '全部' }];
  const seen = new Set(['']);
  for (const anchor of anchors(html)) {
    const href = absolute(anchor.attr.href, base);
    const match = href && /\/vod\/type\/id\/(\d+)/.exec(href);
    const name = text(anchor.inner);
    if (!match || !name || name.length > 12) continue;
    if (seen.has(match[1])) continue;
    seen.add(match[1]);
    list.push({ id: match[1], name });
    if (list.length >= 20) break;
  }
  return list;
}

function pageCount(html, base) {
  let max = 1;
  for (const anchor of anchors(html)) {
    const href = absolute(anchor.attr.href, base);
    const match = href && /\/page\/(\d+)/.exec(href);
    if (match) max = Math.max(max, Number(match[1]) || 1);
  }
  return max;
}

/* ---------------- 对外接口 ---------------- */

async function loadCategories() {
  return cached('dsd:categories', 6 * 3600 * 1000, async () => {
    const home = await page('/');
    const list = categories(home.html, home.url);
    if (list.length <= 1) throw new Error('帝果没有返回分类');
    return list;
  });
}

async function loadList(path, pageNumber) {
  const target = path.replace(/\{page\}/g, String(pageNumber));
  const data = await page(target);
  const items = cards(data.html, data.url);
  if (!items.length && pageNumber === 1) throw new Error('帝果目录没有解析到内容');
  const total = pageCount(data.html, data.url);
  return { items, nextPage: pageNumber < total ? pageNumber + 1 : null };
}

async function categoriesList() {
  return loadCategories();
}

async function list(pageNumber) {
  return loadList('/index.php/vod/show/id/1.html', pageNumber);
}

async function home_() {
  const first = await list(1).catch(async (error) => {
    // 连不上就别再换入口试第二遍：两次 8 秒叠加会把首页拖死
    if (/连不上/.test(error.message)) throw error;
    const data = await page('/');
    return { items: cards(data.html, data.url), nextPage: null };
  });
  return {
    featured: first.items.slice(0, 5).map((item) => ({ ...item, description: item.description || item.title })),
    items: first.items,
    homepageRecommend: first.items.slice(0, 6),
    homepageNewest: first.items.slice(6, 12),
    recommend: { items: first.items, nextPage: first.nextPage },
    newest: { items: first.items.slice(6, 12), nextPage: first.nextPage },
  };
}

async function category(slug, pageNumber) {
  const list_ = await loadCategories();
  const hit = list_.find((item) => item.id === String(slug));
  if (!hit) return list(pageNumber);
  return loadList(hit.id ? `/index.php/vod/type/id/${hit.id}.html` : '/index.php/vod/show/id/1.html', pageNumber);
}

async function search(keyword, pageNumber) {
  const word = String(keyword || '').trim();
  if (!word) return { items: [], nextPage: null };
  const data = await page(`/index.php/vod/search.html?wd=${encodeURIComponent(word)}&page=${pageNumber}`);
  let items = cards(data.html, data.url);
  if (!items.length) {
    // 部分模板的搜索结果不带 video-item 类名，退化成正则直接扫链接
    const seen = new Set();
    items = [];
    const pattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
    let hit;
    while ((hit = pattern.exec(data.html))) {
      const map = attrs(hit[1]);
      const href = absolute(map.href, data.url);
      const match = href && /\/vod\/(?:detail|play)\/id\/(\d+)/.exec(href);
      if (!match || seen.has(match[1])) continue;
      const title = text(hit[2]);
      if (!title || title.length > 60) continue;
      seen.add(match[1]);
      items.push({
        id: match[1], title, cover: '', description: '', score: '',
        episodeLabel: '', category: '短剧', tags: [], status: '',
      });
    }
  }
  const total = pageCount(data.html, data.url);
  return { items, nextPage: pageNumber < total ? pageNumber + 1 : null };
}

async function detail(id) {
  const key = String(id).replace(/\D/g, '');
  if (!key) throw new Error('无效剧集');
  return cached(`dsd:detail:${key}`, 10 * 60 * 1000, async () => {
    const data = await page(`/index.php/vod/detail/id/${key}.html`);
    const html = data.html;
    const og = (name) => {
      const hit = new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]+content=["']([^"']*)["']`, 'i').exec(html)
        || new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${name}["']`, 'i').exec(html);
      return hit ? text(hit[1]) : '';
    };
    let title = og('og:title') || og('title');
    if (!title) {
      const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
      title = h1 ? text(h1[1]) : '';
    }
    const cover = absolute(og('og:image'), data.url);

    const episodes = [];
    const seen = new Set();
    for (const anchor of anchors(html)) {
      const href = absolute(anchor.attr.href, data.url);
      if (!href) continue;
      const match = /\/vod\/play\/id\/(\d+)\/sid\/(\d+)\/nid\/(\d+)/.exec(href);
      if (!match || match[1] !== key) continue;
      const number = Number(match[3]);
      if (!number || seen.has(number)) continue;
      seen.add(number);
      episodes.push({ number, sid: Number(match[2]), title: text(anchor.inner) || `第 ${number} 集` });
    }
    episodes.sort((a, b) => a.number - b.number);
    if (!episodes.length) throw new Error('帝果详情页没有解析到分集');
    return {
      id: key,
      title: title.slice(0, 200) || `帝果 ${key}`,
      cover,
      description: og('og:description'),
      score: '',
      tags: [],
      episodeLabel: `共 ${episodes.length} 集`,
      episodes: episodes.map((item) => ({ number: item.number, url: `${SITE}/index.php/vod/play/id/${key}/sid/${item.sid}/nid/${item.number}.html` })),
      _episodes: episodes,
    };
  });
}

async function episode(id, number) {
  const info = await detail(id);
  const hit = info._episodes.find((item) => item.number === Number(number)) || info._episodes[0];
  if (!hit) throw new Error('这一集不存在');
  const key = String(id).replace(/\D/g, '');
  const url = `${SITE}/index.php/vod/play/id/${key}/sid/${hit.sid}/nid/${hit.number}.html`;
  const data = await page(url);
  const script = /player_aaaa\s*=\s*(\{[\s\S]*?\})\s*[;<\n]/.exec(data.html) || /"url"\s*:\s*"([^"]+)"/.exec(data.html);
  if (!script) throw new Error('帝果播放页没有解析到播放器参数');
  let media = '';
  if (script[1] && script[1].trim().startsWith('{')) {
    let player;
    try {
      player = JSON.parse(script[1].replace(/\\'/g, "'"));
    } catch {
      throw new Error('帝果播放器参数不是合法 JSON');
    }
    media = String(player.url || '');
    if (String(player.encrypt || '0') === '1') media = decodeURIComponent(media);
    else if (String(player.encrypt || '0') === '2') {
      let decoded;
      try {
        decoded = Buffer.from(media, 'base64').toString('utf8');
      } catch {
        throw new Error('帝果播放地址编码无效');
      }
      media = decodeURIComponent(decoded);
    }
  } else {
    media = script[1] || '';
  }
  media = absolute(media, url);
  if (!media) throw new Error('帝果这一集没有可直接播放的地址');
  return {
    url: media,
    referer: `${SITE}/`,
    title: info.title,
    cover: info.cover,
  };
}

module.exports = {
  id: 'dsd',
  name: '帝果',
  description: '帝果剧库 · 分类齐全',
  content: '短剧',
  categories: categoriesList,
  home: home_,
  category,
  search,
  detail,
  episode,
};
