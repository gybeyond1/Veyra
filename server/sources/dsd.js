'use strict';
/**
 * 帝果（www.dsd.com.se，苹果 CMS 模板站）
 *
 * 接口是纯 HTML，没有 JSON API，而且这站有三处和「标准苹果 CMS」不一样 ——
 * 端侧 Dsd.java 是踩完坑的版本，这里逐条对齐（WebUI 之前按教科书解析，所以整站全瞎）：
 *
 *  1. 没有真正的详情页。详情和第一集播放页是同一张
 *     /index.php/vod/play/id/x/sid/1/nid/1.html；去抓 /vod/detail/id/x.html
 *     只会拿到一张空模板 —— 这就是「详情页没有解析到分集」的根因。
 *  2. 播放页正文由 JS 注入，服务端 HTML 里常常既没有分集列表、也没有 player_aaaa。
 *     所以「扫不到分集」是常态：按单集正片处理，媒体地址用封面反推
 *     （…/FNS-206/1.jpg → …/FNS-206/1000k/index.m3u8）。
 *  3. 媒体地址要经 /addons/vplayer/?url=<路径> 换一次签名（返回 aaencode 编码的
 *     vPath），Referer 也必须换成 /addons/vplayer/，否则分片 403。
 *
 * 另外这站对数据中心出口不友好（Cloudflare 前置 + 按机房 IP 直接 reset），
 * 所以元数据请求全部走 backendProxy；失败时把「连不上」和「解析失败」分开报。
 */

const { requestVia, cached } = require('./util');

const SITE = (process.env.DSD_SITE || 'https://www.dsd.com.se').replace(/\/+$/, '');
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/* ---------------- 小工具 ---------------- */

function digits(value) {
  return String(value == null ? '' : value).replace(/\D/g, '');
}

function clean(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

/**
 * 卡片整段文本兜底：切掉播放量、时长、集数标签，别让它们混进剧名。
 * 例：「剧名 452346次 02:07:40」→「剧名」。
 */
function tidy(raw) {
  let value = clean(raw);
  if (!value) return '';
  value = value.replace(/^\s*在线播放\s*/i, '');
  value = value.replace(/\s*第\s*\d+\s*集.*$/i, '');
  value = value.replace(/\s*[-|_]\s*(高清资源|懂色帝|在线观看|免费观看).*$/i, '');
  value = value.replace(/\s*\|\s*www\.[^\s|]+.*$/i, '');
  for (let i = 0; i < 6; i += 1) {
    const before = value;
    value = value.replace(/\s*(更新至|全|共|已完结)\s*\d+\s*集\s*/gi, ' ');
    value = value.replace(/\s*\d+(\.\d+)?\s*(万|亿)?\s*次\s*$/, '');
    value = value.replace(/\s*\d{1,2}:\d{2}(:\d{2})?\s*$/, '');
    value = value.replace(/^\s*(\d+(\.\d+)?\s*(万|亿)?\s*次|\d{1,2}:\d{2}(:\d{2})?)\s*/, '');
    value = value.replace(/^[\\|\s]+/, '');
    value = value.replace(/\\/g, ' ');
    value = value.replace(/\s{2,}/g, ' ').trim();
    if (value === before) break;
  }
  return value.trim();
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function text(html) {
  return clean(
    String(html || '')
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
  );
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
    const url = new URL(value, base || SITE + '/');
    return /^https?:$/.test(url.protocol) ? url.toString() : '';
  } catch {
    return '';
  }
}

function backgroundUrl(style) {
  const hit = /url\(\s*["']?([^"')]+)/i.exec(String(style || ''));
  return hit ? hit[1].trim() : '';
}

/* ---------------- 路由：兼容 /index.php、.html、?query 三种写法 ---------------- */

function routeOf(reference) {
  const value = String(reference || '').trim();
  if (!value) return null;
  let url;
  try {
    url = new URL(value, SITE + '/');
  } catch {
    return null;
  }
  if (!/^(www\.)?dsd\.com\.se$/i.test(url.hostname)) return null;
  let path = url.pathname || '';
  if (path.startsWith('/index.php')) path = path.slice('/index.php'.length);
  path = path.replace(/\/+$/, '');
  if (/\.html$/i.test(path)) path = path.slice(0, -5);
  const parts = path.replace(/^\/+/, '').split('/');
  if (parts.length < 2 || parts[0] !== 'vod') return null;
  const action = parts[1];
  if (!['play', 'detail', 'type', 'show', 'search'].includes(action)) return null;
  const params = {};
  for (let i = 2; i + 1 < parts.length; i += 2) if (parts[i]) params[parts[i]] = parts[i + 1];
  for (const [key, val] of url.searchParams) if (!(key in params)) params[key] = val;
  return {
    action,
    get: (key) => String(params[key] || ''),
    int: (key) => Number(digits(params[key])) || 0,
    params,
  };
}

/* ---------------- 抓页面 ---------------- */

/**
 * Referer 必须带：这站的播放页有防盗链，不带 Referer 的请求会被对端直接掐断
 * （看起来像「连不上」，其实站点是通的）。
 */
async function page(path, referer) {
  const url = /^https?:/i.test(path) ? path : `${SITE}${String(path).startsWith('/') ? '' : '/'}${path}`;
  let res;
  try {
    res = await requestVia(
      url,
      {
        headers: {
          'User-Agent': UA,
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          Referer: referer || `${SITE}/`,
        },
        timeout: 14000,
        maxBytes: 6 << 20,
        backendProxy: true,
      },
      ''
    );
  } catch (error) {
    throw new Error(`帝果连不上（${error.message}）——这个站会按出口 IP 拦截，服务器访问不了时需要在管理台配好后端代理`);
  }
  if (res.status < 200 || res.status >= 300) throw new Error(`帝果返回 ${res.status}`);
  const html = res.text();
  if (!/<\s*(html|body|div|a)\b/i.test(html)) throw new Error('帝果返回的不是页面');
  return { url, html };
}

function anchors(html) {
  const out = [];
  const pattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let hit;
  while ((hit = pattern.exec(html))) out.push({ attr: attrs(hit[1]), inner: hit[2] });
  return out;
}

/** 卡片标题优先从子节点取，直接取 <a> 文本会连播放量、时长一起吃进来。 */
const TITLE_NODES = ['video-desc', 'surface-title', 'video-title', 'video-name', 'title'];

function textByClass(inner, names) {
  for (const name of names) {
    const pattern = new RegExp(
      `<(\\w+)[^>]*\\bclass\\s*=\\s*["'][^"']*\\b${name}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/\\1>`,
      'i'
    );
    const hit = pattern.exec(inner);
    if (!hit) continue;
    const value = text(hit[2]);
    if (value) return value;
  }
  return '';
}

function cardCover(link) {
  // 封面可能就挂在 <a> 自己的 background-image 上（这站首页就是）
  const own = backgroundUrl(link.attr.style);
  if (own) return absolute(own, SITE + '/');
  const pattern = /<img\b([^>]*)>/gi;
  let hit;
  while ((hit = pattern.exec(link.inner))) {
    const map = attrs(hit[1]);
    for (const key of ['data-src', 'data-original', 'data-echo', 'src']) {
      const value = String(map[key] || '').trim();
      if (!value || /^data:/i.test(value)) continue;
      // 懒加载占位图（logo、lazy.gif）不是封面
      if (key === 'src' && !value.includes('/upload') && !value.startsWith('/video')) continue;
      return absolute(value, SITE + '/');
    }
  }
  const nested = /<(div|span|a)\b([^>]*)>/gi;
  while ((hit = nested.exec(link.inner))) {
    const hitUrl = backgroundUrl(attrs(hit[2]).style);
    if (hitUrl) return absolute(hitUrl, SITE + '/');
  }
  return '';
}

/**
 * 列表卡片的封面/标题按 id 存着：播放页正文由 JS 注入，服务端 HTML 里常常连
 * og:image 都没有，而封面是唯一能反推媒体地址的线索
 * （…/FNS-206/1.jpg → …/FNS-206/1000k/index.m3u8）。
 */
const coverMemo = new Map();
const titleMemo = new Map();
const MEMO_MAX = 300;

function memoSet(map, key, value) {
  if (!key || !value) return;
  if (map.size >= MEMO_MAX && !map.has(key)) map.delete(map.keys().next().value);
  map.set(key, value);
}

function remember(id, title, cover) {
  if (!id) return;
  memoSet(titleMemo, id, title);
  memoSet(coverMemo, id, cover);
}

/* ---------------- 目录 ---------------- */

function cards(html, base) {
  const items = [];
  const seen = new Set();
  let links = anchors(html).filter((item) => /video-item|video-surface/.test(String(item.attr.class || '').toLowerCase()));
  if (!links.length) links = anchors(html);
  for (const link of links) {
    const href = absolute(link.attr.href, base);
    const route = href && routeOf(href);
    if (!route || !/play|detail/.test(route.action)) continue;
    const id = route.get('id');
    if (!id || seen.has(id)) continue;

    let title = textByClass(link.inner, TITLE_NODES);
    if (!title) title = clean(link.attr.title);
    if (!title) {
      const img = /<img\b([^>]*)>/i.exec(link.inner);
      if (img) title = clean(attrs(img[1]).alt);
    }
    if (!title) title = tidy(text(link.inner));
    title = tidy(title).replace(/^(VIP|会员|独播|新剧)\s*/i, '');
    if (!title || title.length > 80) continue;

    seen.add(id);
    const total = /(?:全|更新至|共|已完结)\s*(\d+)\s*集/.exec(clean(text(link.inner)));
    const label = total ? `全 ${total[1]} 集` : '';
    const cover = cardCover(link);
    remember(id, title, cover);
    items.push({
      id,
      title: title.slice(0, 200),
      cover,
      description: '',
      score: '',
      episodeLabel: label,
      category: '短剧',
      tags: [],
      status: label ? 'finished' : '',
    });
  }
  return items;
}

function categoriesOf(html, base) {
  const list = [{ id: '', name: '全部' }];
  const seen = new Set(['']);
  for (const anchor of anchors(html)) {
    const href = absolute(anchor.attr.href, base);
    const route = href && routeOf(href);
    if (!route || route.action !== 'type') continue;
    const id = route.get('id');
    const name = text(anchor.inner);
    if (!id || !name || name.length > 12 || seen.has(id)) continue;
    seen.add(id);
    list.push({ id, name });
    if (list.length >= 24) break;
  }
  return list;
}

function pageCount(html, base) {
  let max = 1;
  for (const anchor of anchors(html)) {
    const href = absolute(anchor.attr.href, base);
    const hit = href && /\/page\/(\d+)/.exec(href);
    if (hit) max = Math.max(max, Number(hit[1]) || 1);
  }
  return max;
}

async function loadCategories() {
  return cached('dsd:categories', 6 * 3600 * 1000, async () => {
    const home = await page('/');
    const list = categoriesOf(home.html, home.url);
    if (list.length <= 1) throw new Error('帝果没有返回分类');
    return list;
  });
}

async function defaultCategory() {
  const list = await loadCategories();
  const hit = list.find((item) => item.id);
  if (!hit) throw new Error('帝果没有返回分类');
  return hit.id;
}

async function loadList(categoryId, pageNumber) {
  const data = await page(`/index.php/vod/type/id/${categoryId}/page/${pageNumber}.html`);
  const items = cards(data.html, data.url);
  if (!items.length && pageNumber === 1) throw new Error('帝果目录没有解析到内容');
  const total = pageCount(data.html, data.url);
  return { items, nextPage: pageNumber < total ? pageNumber + 1 : null };
}

async function home_() {
  const first = await loadList(await defaultCategory(), 1);
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
  const id = list_.some((item) => item.id && item.id === String(slug)) ? String(slug) : await defaultCategory();
  return loadList(id, Math.max(1, Number(pageNumber) || 1));
}

async function search(keyword, pageNumber) {
  const word = String(keyword || '').trim();
  if (!word) return { items: [], nextPage: null };
  const data = await page(`/index.php/vod/search.html?wd=${encodeURIComponent(word)}&page=${pageNumber}`);
  let items = cards(data.html, data.url);
  if (!items.length) {
    // 部分模板的搜索结果不带 video-item 类名，退化成正则扫链接
    const seen = new Set();
    items = [];
    for (const anchor of anchors(data.html)) {
      const href = absolute(anchor.attr.href, data.url);
      const route = href && routeOf(href);
      if (!route || !/detail|play/.test(route.action)) continue;
      const id = route.get('id');
      if (!id || seen.has(id)) continue;
      const title = tidy(text(anchor.inner));
      if (!title || title.length > 60) continue;
      seen.add(id);
      items.push({
        id,
        title,
        cover: '',
        description: '',
        score: '',
        episodeLabel: '',
        category: '短剧',
        tags: [],
        status: '',
      });
    }
  }
  const total = pageCount(data.html, data.url);
  return { items, nextPage: pageNumber < total ? pageNumber + 1 : null };
}

/* ---------------- 播放器参数 ---------------- */

/** 括号配对要自己数，正则会被嵌套对象截断。 */
function objectAt(source, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const char = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

/** 这站还有 player_bbb 之类，取第一个 id+url 齐的。 */
function player(html) {
  const scripts = [];
  const pattern = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let hit;
  while ((hit = pattern.exec(html))) scripts.push(hit[1]);
  if (!scripts.length) scripts.push(html);
  for (const body of scripts) {
    if (!body || !body.includes('player_')) continue;
    const assign = /\bplayer_[A-Za-z0-9_]+\s*=\s*/g;
    let from = 0;
    let match;
    while ((match = assign.exec(body))) {
      from = assign.lastIndex;
      const brace = body.indexOf('{', from);
      if (brace < 0) break;
      const json = objectAt(body, brace);
      if (!json) continue;
      try {
        const candidate = JSON.parse(json.replace(/\\'/g, "'"));
        if (candidate && candidate.id !== undefined && candidate.url !== undefined) return candidate;
      } catch {
        /* 不是合法 JSON，继续找下一个 */
      }
    }
  }
  return null;
}

function playPath(key, sid, nid) {
  return `${SITE}/index.php/vod/play/id/${key}/sid/${sid}/nid/${nid}.html`;
}

/** 封面反推媒体地址：/video1/<组>/<番号>/1.jpg → /video1/<组>/<番号>/1000k/index.m3u8 */
function mediaFromCover(cover) {
  if (!cover) return '';
  try {
    const url = new URL(cover);
    if (!/^\/video\d*\/.*\/1\.(jpg|jpeg|png|webp)$/i.test(url.pathname)) return '';
    const dir = url.pathname.slice(0, url.pathname.lastIndexOf('/'));
    return `${url.protocol}//${url.host}${dir}/1000k/index.m3u8`;
  } catch {
    return '';
  }
}

/** 整页兜底：JS 里只要拼过 m3u8，正则就能捞出来。 */
function mediaInPage(html, base) {
  if (!html) return '';
  const source = html.replace(/\\\//g, '/');
  const pattern = /https?:\/\/[^"'\s<>()\\]+\.m3u8[^"'\s<>()\\]*/gi;
  let hit;
  while ((hit = pattern.exec(source))) {
    const value = absolute(hit[0], base);
    if (/^https?:\/\/.*\.m3u8(\?.*)?$/i.test(value)) return value;
  }
  return '';
}

/* ---------------- vplayer 签名（aaencode） ---------------- */

function mediaPath(address) {
  try {
    const url = new URL(address);
    return url.pathname + (url.search || '');
  } catch {
    return address;
  }
}

const AA_HEAD = /\(ﾟДﾟ\)\s*\['_'\]\s*\(\s*\(ﾟДﾟ\)\s*\['_'\]/;
const AA_TAIL = /\+\s*\(ﾟДﾟ\)\s*\[\s*ﾟoﾟ\s*\]/g;
const AA_SPLIT = /\(ﾟДﾟ\)\s*\[\s*ﾟεﾟ\s*\]\+/;

function skipSpace(source, pos) {
  while (pos.i < source.length && /\s/.test(source[pos.i])) pos.i += 1;
}

function factor(source, pos) {
  skipSpace(source, pos);
  if (pos.i >= source.length) throw new Error('eof');
  const char = source[pos.i];
  if (char === '(') {
    pos.i += 1;
    const value = expr(source, pos);
    skipSpace(source, pos);
    if (source[pos.i] !== ')') throw new Error(')');
    pos.i += 1;
    return value;
  }
  if (char === '-') {
    pos.i += 1;
    return -factor(source, pos);
  }
  if (!/[0-9]/.test(char)) throw new Error('digit');
  const start = pos.i;
  while (pos.i < source.length && /[0-9]/.test(source[pos.i])) pos.i += 1;
  return parseInt(source.slice(start, pos.i), 10);
}

function term(source, pos) {
  let value = factor(source, pos);
  for (;;) {
    skipSpace(source, pos);
    const op = source[pos.i];
    if (op !== '*' && op !== '/' && op !== '%') return value;
    pos.i += 1;
    const right = factor(source, pos);
    if (right === 0 && op !== '*') throw new Error('div0');
    value = op === '*' ? value * right : op === '/' ? Math.trunc(value / right) : value % right;
  }
}

function expr(source, pos) {
  let value = term(source, pos);
  for (;;) {
    skipSpace(source, pos);
    const op = source[pos.i];
    if (op !== '+' && op !== '-') return value;
    pos.i += 1;
    const right = term(source, pos);
    value = op === '+' ? value + right : value - right;
  }
}

function evalInt(source) {
  const pos = { i: 0 };
  try {
    const value = expr(source, pos);
    skipSpace(source, pos);
    return pos.i === source.length ? value : null;
  } catch {
    return null;
  }
}

function splitTop(value) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (char === '(') depth += 1;
    else if (char === ')') {
      if (depth > 0) depth -= 1;
    } else if (char === '+' && depth === 0) {
      const part = value.slice(start, i).trim();
      if (part) parts.push(part);
      start = i + 1;
    }
  }
  const tail = value.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}

function aaDigit(part) {
  let value = String(part || '').trim();
  if (!value) return null;
  if (value.includes('(oﾟｰﾟo)')) return 'u';
  if (value.includes('(ﾟДﾟ).ﾟΘﾟﾉ')) return 'b';
  value = value
    .split('(c^_^o)').join('0')
    .split('(ﾟΘﾟ)').join('1')
    .split('(o^_^o)').join('3')
    .split('(ﾟｰﾟ)').join('4');
  const number = evalInt(value);
  return number === null ? null : String(number);
}

function aaDecode(raw) {
  const head = AA_HEAD.exec(raw);
  if (!head) return null;
  const body = raw.slice(head.index);
  let end = -1;
  AA_TAIL.lastIndex = 0;
  let tail;
  while ((tail = AA_TAIL.exec(body))) end = tail.index;
  if (end < 0) return null;
  const tokens = body.slice(0, end).split(AA_SPLIT);
  let decoded = '';
  for (let i = 1; i < tokens.length; i += 1) {
    let value = '';
    for (const part of splitTop(tokens[i])) {
      const digit = aaDigit(part);
      if (digit === null) return null;
      value += digit;
    }
    if (value.startsWith('u') && value.length === 5) {
      decoded += String.fromCharCode(parseInt(value.slice(1), 16));
    } else if (/^[0-7]+$/.test(value)) {
      decoded += String.fromCharCode(parseInt(value, 8));
    }
    if (decoded.length > 65536) return null;
  }
  return decoded;
}

/** vplayer 返回一段 aaencode 混淆脚本，里面 var vPath = "…" 才是签名后的路径。 */
function signedPath(body) {
  const script = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let hit;
  while ((hit = script.exec(body))) {
    const block = hit[1];
    if (!block.includes('(ﾟДﾟ)')) continue;
    const decoded = aaDecode(block);
    if (!decoded) continue;
    const path = /\bvar\s+vPath\s*=\s*["']([^"']+)["']/.exec(decoded);
    if (path) return path[1].trim();
  }
  return '';
}

async function sign(address, pageUrl) {
  if (address.includes('sign=')) return address;
  const endpoint = `${SITE}/addons/vplayer/?url=${encodeURIComponent(mediaPath(address))}&jump=`;
  try {
    const res = await requestVia(
      endpoint,
      {
        headers: { 'User-Agent': UA, Referer: pageUrl, Accept: 'text/html,application/xhtml+xml' },
        timeout: 10000,
        maxBytes: 2 << 20,
        backendProxy: true,
      },
      ''
    );
    if (res.status < 200 || res.status >= 300) return address;
    const signed = signedPath(res.text());
    if (!signed) return address;
    const resolved = absolute(signed, `${SITE}/addons/vplayer/`);
    return /^https?:\/\/.*\.(m3u8|mp4)(\?.*)?$/i.test(resolved) ? resolved : address;
  } catch {
    return address;
  }
}

/* ---------------- 详情 / 分集 ---------------- */

/** id → { title, cover, sid, episodes }：episode() 要用，不能只靠 detail 的缓存结果（那份不含内部字段） */
const infoCache = new Map();

function rememberInfo(key, info) {
  if (infoCache.size >= 120 && !infoCache.has(key)) infoCache.delete(infoCache.keys().next().value);
  infoCache.set(key, info);
}

/** 纯解析：页面拿到手之后的活。 */
function parseDetail(key, data, playerObj) {
  const html = data.html;
  const vod = playerObj && playerObj.vod_data && typeof playerObj.vod_data === 'object' ? playerObj.vod_data : null;

  let title = vod ? clean(vod.vod_name || '') : '';
  if (!title) {
    const heading = /<div[^>]*class\s*=\s*["'][^"']*video-info[^"']*["'][^>]*>[\s\S]*?<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html)
      || /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
    title = heading ? clean(text(heading[1])) : '';
  }
  if (!title) title = meta(html, 'og:title');
  if (!title) {
    const docTitle = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
    title = docTitle ? clean(text(docTitle[1])) : '';
  }
  if (!title) title = titleMemo.get(key) || '';
  title = tidy(title);

  let cover = playerObj ? String(playerObj.poster || '').trim() : '';
  if (!cover) cover = meta(html, 'og:image');
  if (!cover) cover = coverOf(html);
  // 列表上的封面才是 /video1/<组>/<番号>/1.jpg 那种能反推播放地址的图，
  // 详情页的 og:image 常常是裁过的缩略图，只用来兜底
  const cachedCover = coverMemo.get(key) || '';
  if ((!cover || !cover.includes('/video')) && cachedCover) cover = cachedCover;
  cover = absolute(cover, data.url);

  // 分集：同一个播放页里所有 /vod/play/id/{key}/sid/../nid/.. 链接；多线路只留集数最多的那条
  const byLine = new Map();
  const labels = new Map();
  for (const anchor of anchors(html)) {
    const href = absolute(anchor.attr.href, data.url);
    const route = href && routeOf(href);
    if (!route || route.action !== 'play') continue;
    if (digits(route.get('id')) !== key) continue;
    const sid = route.int('sid');
    const nid = route.int('nid');
    if (sid <= 0 || nid <= 0) continue;
    if (!byLine.has(sid)) {
      byLine.set(sid, new Map());
      labels.set(sid, new Map());
    }
    const line = byLine.get(sid);
    if (!line.has(nid)) {
      line.set(nid, href);
      labels.get(sid).set(nid, clean(text(anchor.inner)));
    }
  }

  let bestSid = 0;
  let bestCount = 0;
  for (const [sid, line] of byLine) {
    if (line.size > bestCount) {
      bestCount = line.size;
      bestSid = sid;
    }
  }
  /*
   * 这站是「一片一 id」：列表里每条的链接都是 sid/1/nid/1.html，播放页正文又由 JS 注入，
   * 服务端 HTML 里根本不会出现分集列表。所以「扫不到分集」是常态，不是错误 ——
   * 直接当单集正片处理，媒体地址由 episode() 用封面反推。
   */
  /*
   * 没有播放链接时还有两条路：
   *   · player_aaaa.vod_data.vod_play_url —— 苹果 CMS 的标准「分集清单」，
   *     「第01集$https://…m3u8#第02集$…」这种；有它就能给出真正的选集，而不是只有一集「正片」。
   *   · 都没有就按单集正片处理（这站「一片一 id」是常态），媒体地址由封面反推。
   */
  const directEpisodes = !bestSid ? episodesFromVodUrl(vod) : [];
  if (directEpisodes.length) {
    const info = {
      title: title.slice(0, 200) || `帝果 ${key}`,
      cover,
      sid: 1,
      episodes: directEpisodes,
    };
    rememberInfo(key, info);
    return {
      id: key,
      title: info.title,
      cover,
      description: (vod ? clean(vod.vod_blurb || '') : '') || meta(html, 'og:description'),
      score: '',
      tags: [],
      episodeLabel: `共 ${directEpisodes.length} 集`,
      episodes: directEpisodes.map((item) => ({ number: item.number, url: item.direct })),
      _episodes: directEpisodes,
    };
  }
  if (!bestSid) {
    const sid = playerObj ? Math.max(1, Number(playerObj.sid) || 1) : 1;
    const nid = playerObj ? Math.max(1, Number(playerObj.nid) || 1) : 1;
    bestSid = sid;
    byLine.set(sid, new Map([[nid, data.url]]));
    labels.set(sid, new Map([[nid, '']]));
    bestCount = 1;
  }

  const line = byLine.get(bestSid);
  const label = labels.get(bestSid);
  const episodes = [...line.keys()].sort((a, b) => a - b).map((nid) => ({
    number: nid,
    sid: bestSid,
    title: (label.get(nid) || (line.size === 1 ? '正片' : `第 ${nid} 集`)).slice(0, 60),
  }));
  if (!episodes.length || !bestCount) throw new Error('帝果详情页没有解析到分集');

  const description = vod ? clean(vod.vod_blurb || '') : '';
  const info = {
    title: title.slice(0, 200) || `帝果 ${key}`,
    cover,
    sid: bestSid,
    episodes,
  };
  rememberInfo(key, info);

  return {
    id: key,
    title: info.title,
    cover,
    description: description || meta(html, 'og:description'),
    score: '',
    tags: [],
    episodeLabel: `共 ${episodes.length} 集`,
    episodes: episodes.map((item) => ({ number: item.number, url: playPath(key, item.sid, item.number) })),
    _episodes: episodes,
  };
}

/** 苹果 CMS 的分集清单：`第01集$地址#第02集$地址`，多线路用 $$$ 分隔，取第一条。 */
function episodesFromVodUrl(vod) {
  const raw = vod && typeof vod.vod_play_url === 'string' ? vod.vod_play_url : '';
  if (!raw) return [];
  const first = raw.split('$$$')[0];
  return first
    .split('#')
    .map((part, index) => {
      const at = part.indexOf('$');
      const name = at >= 0 ? part.slice(0, at) : '';
      const url = at >= 0 ? part.slice(at + 1) : part;
      if (!/^https?:\/\//i.test(url)) return null;
      // 这里的标签本来就是「第01集」，别过 tidy（它会把整段当成集数标签切掉）
      return { number: index + 1, sid: 1, title: (clean(name) || `第 ${index + 1} 集`).slice(0, 60), direct: url };
    })
    .filter(Boolean);
}

function meta(html, name) {
  const pattern = new RegExp(
    `<meta[^>]+(?:property|name)\\s*=\\s*["']${name}["'][^>]*content\\s*=\\s*["']([^"']*)["']`,
    'i'
  );
  const reversed = new RegExp(
    `<meta[^>]+content\\s*=\\s*["']([^"']*)["'][^>]*(?:property|name)\\s*=\\s*["']${name}["']`,
    'i'
  );
  const hit = pattern.exec(html) || reversed.exec(html);
  return hit ? clean(text(hit[1])) : '';
}

function coverOf(html) {
  const pattern = /<img\b([^>]*)>/gi;
  let hit;
  while ((hit = pattern.exec(html))) {
    const map = attrs(hit[1]);
    for (const key of ['data-src', 'data-original', 'data-echo', 'src']) {
      const value = String(map[key] || '').trim();
      if (!value || /^data:/i.test(value)) continue;
      return absolute(value, SITE + '/');
    }
  }
  const style = /style\s*=\s*("([^"]*)"|'([^']*)')/gi;
  while ((hit = style.exec(html))) {
    const found = backgroundUrl(hit[2] || hit[3] || '');
    if (found) return absolute(found, SITE + '/');
  }
  return '';
}

async function detail(id) {
  const key = digits(id);
  if (!key) throw new Error('无效剧集');
  return cached(`dsd:detail:${key}`, 10 * 60 * 1000, async () => {
    // 这个站的「详情页」就是第一集播放页；sid 实际可能不是 1，从页面里拿
    let data = null;
    let playerObj = null;
    let failure = null;
    try {
      data = await page(playPath(key, 1, 1));
      playerObj = player(data.html);
    } catch (error) {
      failure = error;
    }
    if (playerObj && digits(playerObj.id) !== key) playerObj = null;
    if (!data || !playerObj) {
      try {
        const fallback = await page(`/index.php/vod/detail/id/${key}.html`);
        const fallbackPlayer = player(fallback.html);
        if (!playerObj || (fallbackPlayer && digits(fallbackPlayer.id) === key)) {
          data = fallback;
          if (fallbackPlayer) playerObj = fallbackPlayer;
        }
      } catch (error) {
        if (!data) throw failure || error;
      }
    }
    if (!data) throw new Error('帝果没有返回剧集页面');
    return parseDetail(key, data, playerObj);
  });
}

async function episode(id, number) {
  const key = digits(id);
  if (!key) throw new Error('无效剧集');
  const info = await detail(id);
  const wanted = Number(number) || 1;
  const hit = (info._episodes || []).find((item) => item.number === wanted) || (info._episodes || [])[0];
  if (!hit) throw new Error('这一集不存在');
  const pageUrl = playPath(key, hit.sid, hit.number);

  let data = null;
  let failure = null;
  if (!hit.direct) {
    try {
      data = await page(pageUrl);
    } catch (error) {
      // 播放页被防盗链掐断也要能播：下面还有封面反推这条路
      failure = error;
    }
  }
  let playerObj = data ? player(data.html) : null;
  if (playerObj && digits(playerObj.id) !== key) playerObj = null;
  if (playerObj && Number(playerObj.trysee) > 0) throw new Error('帝果这一集只能试看，暂未取得正片地址');

  let media = hit.direct || '';
  if (!media && playerObj) {
    media = String(playerObj.url || '').trim();
    const encrypt = String(playerObj.encrypt == null ? '0' : playerObj.encrypt);
    if (encrypt === '1') {
      try {
        media = decodeURIComponent(media);
      } catch {
        /* 编码坏了就按原样试 */
      }
    } else if (encrypt === '2') {
      try {
        media = decodeURIComponent(Buffer.from(media, 'base64').toString('utf8'));
      } catch {
        throw new Error('帝果播放地址编码无效');
      }
    }
    media = absolute(media, pageUrl);
  }

  /*
   * 服务端 HTML 里没有 player_aaaa 是常态（正文由 JS 注入），这时用封面反推
   * /1000k/index.m3u8。三个封面来源依次试：详情的、列表缓存的、播放页里翻出来的。
   */
  const memory = infoCache.get(key);
  if (!media) media = mediaFromCover((memory && memory.cover) || '');
  if (!media) media = mediaFromCover(coverMemo.get(key) || '');
  /*
   * 播放页里的 vod_play_url 是第二个来源：正文由 JS 注入时 HTML 里往往只剩这一坨数据，
   * 而它就是真正的分集直链（「第01集$https://…m3u8#…」）。按集号取，取不到取第一条。
   */
  if (!media && data) {
    const listed = episodesFromVodUrl(player(data.html) && player(data.html).vod_data);
    if (listed.length) media = (listed[Math.min(wanted, listed.length) - 1] || listed[0]).direct;
  }
  if (!media && data) media = mediaFromCover(absolute(meta(data.html, 'og:image'), data.url) || coverOf(data.html));
  if (!media && data) media = mediaInPage(data.html, pageUrl);
  if (!media) {
    throw failure || new Error(`帝果没有解析到播放地址（封面 ${brief((memory && memory.cover) || '')}）`);
  }
  if (!/^https?:\/\/.*\.(m3u8|mp4)(\?.*)?$/i.test(media)) throw new Error('帝果这一集不是可直接播放的媒体');

  let referer = `${SITE}/`;
  const signed = await sign(media, pageUrl);
  if (signed !== media) {
    media = signed;
    referer = `${SITE}/addons/vplayer/`;
  } else if (/\/addons\/vplayer\//i.test(media)) {
    // 没能换到签名、但地址还在 vplayer 目录下：这一层的防盗链认的就是这个 Referer
    referer = `${SITE}/addons/vplayer/`;
  }

  return {
    url: media,
    referer,
    title: (memory && memory.title) || info.title,
    cover: (memory && memory.cover) || info.cover,
  };
}

function brief(value) {
  if (!value) return '无';
  const trimmed = String(value).replace(/^https?:\/\/[^/]+/i, '');
  return trimmed.length > 46 ? `…${trimmed.slice(-46)}` : trimmed;
}

module.exports = {
  id: 'dsd',
  name: '帝果',
  description: '帝果剧库 · 分类齐全',
  content: '短剧',
  // 封面 CDN 只认住宅/手机出口，后端取不到时允许前端拿原始地址自己取
  coverDirect: true,
  // 页面和媒体是两套风控：详情页能取到，不代表分片能取到。
  // 这个站的媒体服务器对机房出口回 403，取流必须和管理台代理走同一条路。
  mediaProxy: true,
  /*
   * 浏览器直连必然播不了：媒体域既按出口 IP 拦，也没有 CORS 头。
   * 所以 WebUI 选「仅直连」时自动降级成后端转发，并把原因告诉用户；
   * 手机/电视带 carry=1 时仍按「仅直连」下发真实地址（本机网关能贴 Referer）。
   */
  noDirect: true,
  noDirectReason: '帝果的媒体服务器只认住宅/手机出口，浏览器直连取不到流，已自动走后端转发',
  categories: loadCategories,
  home: home_,
  category,
  search,
  detail,
  episode,
  __test: { parseDetail, player, aaDecode, cards, mediaFromCover, routeOf, tidy, episodesFromVodUrl },
};
