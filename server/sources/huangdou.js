'use strict';
/**
 * 黄豆短剧（tideember.cc / xqjurgek.top）
 *
 * 接口是一套自研的二进制协议，光靠域名是打不开的：
 *   · 请求体 = 16 字节随机 IV + AES-256-CBC(gzip(JSON))，
 *     密钥 = HMAC-SHA256(platformKey, requestId 的 16 字节原文)；
 *   · 额外头 version / deviceType / requestId / sessionId，
 *     以及 time + sign（sha256("Dart|sessionId|requestId|time|path")）。
 * 少任何一个头都是 403，所以这里不能走普通抓取。
 *
 * 线路：主域 tideember.cc 目前没有 A 记录，实际能连的是备份线 xqjurgek.top；
 * 后者证书过期，只取公开剧集数据、不带任何账号凭证，故显式放行证书校验。
 */

const crypto = require('crypto');
const zlib = require('zlib');
const { request, cached } = require('./util');

const PLATFORM_KEY = '7961beb44246e3012ce228d6b5ced05a';
const VERSION = '2.0.0';
const HOSTS = ['https://xqjurgek.top', 'https://tideember.cc'];
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const sessionId = crypto.randomBytes(16).toString('hex');
let host = HOSTS[0];

function uuidLike() {
  const raw = crypto.randomBytes(16).toString('hex');
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
}

/** 解响应：明文 JSON 直接解析，密文按 IV + AES-256-CBC 解，再按需 gunzip */
function decode(blob, key) {
  const text = blob.toString('utf8').trim();
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      return JSON.parse(text);
    } catch {
      /* 落到解密分支 */
    }
  }
  if (blob.length < 32) throw new Error('黄豆返回内容过短');
  const iv = blob.subarray(0, 16);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  let plain = Buffer.concat([decipher.update(blob.subarray(16)), decipher.final()]);
  if (plain[0] === 0x1f && plain[1] === 0x8b) plain = zlib.gunzipSync(plain);
  return JSON.parse(plain.toString('utf8'));
}

async function call(path, data) {
  let lastError;
  for (const base of [host, ...HOSTS.filter((item) => item !== host)]) {
    try {
      const result = await callOnce(base, path, data);
      host = base;
      return result;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function callOnce(base, path, data) {
  const rid = uuidLike();
  const key = crypto
    .createHmac('sha256', PLATFORM_KEY)
    .update(Buffer.from(rid.replace(/-/g, ''), 'hex'))
    .digest();
  const iv = crypto.randomBytes(16);
  const plain = Buffer.from(JSON.stringify({ token: '', deviceId: sessionId, data }), 'utf8');
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const body = Buffer.concat([iv, cipher.update(zlib.gzipSync(plain)), cipher.final()]);
  const stamp = String(Math.floor(Date.now() / 1000));
  const sign = `${crypto.createHash('sha256').update(`Dart|${sessionId}|${rid}|${stamp}|${path}`).digest('hex')}-${stamp}`;

  const res = await request(`${base}/api${path}`, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      Accept: '*/*',
      Origin: base,
      Referer: `${base}/home`,
      'Content-Type': 'application/octet-stream',
      version: VERSION,
      deviceType: 'web',
      requestId: rid,
      sessionId,
      time: stamp,
      sign,
    },
    body,
    timeout: 20000,
    insecure: true,
    maxBytes: 6 << 20,
  });
  if (res.status < 200 || res.status >= 300) throw new Error(`黄豆接口返回 ${res.status}`);
  const payload = decode(res.body, key);
  const envelope = payload && payload.data ? payload.data : payload;
  if (envelope && envelope.status && envelope.status !== 'y') {
    throw new Error(`黄豆接口拒绝：${envelope.msg || envelope.message || envelope.status}`);
  }
  return envelope && envelope.data !== undefined ? envelope.data : envelope;
}

/* ---------------- 数据映射 ---------------- */

function coverOf(row) {
  const raw = String(row.img_y || row.img_x || row.img || row.cover || row.pic || '').trim();
  if (!raw) return '';
  if (raw.startsWith('//')) return `https:${raw}`;
  return raw;
}

function card(row) {
  const id = String(row.id || row.drama_id || '').replace(/^rp_/, '');
  const episodes = Number(row.episode_count) || 0;
  const label = String(row.update_label || row.corner || '').trim();
  const tags = [];
  const category = String(row.category || row.category_name || '').trim();
  if (category) tags.push(category);
  if (Array.isArray(row.tags)) for (const tag of row.tags) if (tag && tags.length < 4) tags.push(String(tag).slice(0, 12));
  const finished = /全|完结/.test(label);
  return {
    id,
    title: String(row.name || row.title || id).slice(0, 200),
    cover: coverOf(row),
    description: String(row.description || row.summary || '').slice(0, 4000),
    score: '',
    episodeLabel: label || (episodes ? `全 ${episodes} 集` : ''),
    category: category || '短剧',
    tags: tags.slice(0, 4),
    status: finished || (episodes > 0 && !/更新/.test(label)) ? 'finished' : '',
  };
}

function rowsOf(value) {
  if (Array.isArray(value)) return value.filter((row) => row && typeof row === 'object');
  if (!value || typeof value !== 'object') return [];
  for (const key of ['list', 'items', 'data']) {
    const rows = rowsOf(value[key]);
    if (rows.length) return rows;
  }
  return [];
}

/* ---------------- 对外接口 ---------------- */

async function list(page, pageSize = 30) {
  const data = await call('/drama/list', { page: String(page), page_size: String(pageSize) });
  const rows = rowsOf(data);
  const items = rows.map(card).filter((item) => item.id && item.title && item.cover);
  return { items, nextPage: rows.length >= pageSize ? page + 1 : null };
}

async function categories() {
  // 源站列表接口不带分类维度，只保留「全部 / 最新」两档，切换时按发布时间重排
  return [
    { id: '', name: '全部' },
    { id: 'new', name: '最新' },
  ];
}

async function home() {
  const first = await list(1);
  return {
    featured: first.items.slice(0, 5).map((item) => ({ ...item, description: item.description || item.title })),
    items: first.items,
    homepageRecommend: first.items.slice(0, 6),
    homepageNewest: first.items.slice(6, 12),
    recommend: { items: first.items, nextPage: first.nextPage },
    newest: { items: first.items.slice(6, 12), nextPage: first.nextPage },
  };
}

async function category(slug, page) {
  const result = await list(page);
  if (slug === 'new') {
    const sorted = [...result.items].sort((a, b) => Number(b.id.slice(0, 8) || 0) - Number(a.id.slice(0, 8) || 0));
    return { items: sorted, nextPage: result.nextPage };
  }
  return { items: result.items, nextPage: result.nextPage };
}

async function search(keyword, page) {
  // 接口没有搜索端点，退化为逐页翻找标题匹配（只在前 3 页内找，避免拖垮请求）
  const key = keyword.trim();
  if (!key) return { items: [], nextPage: null };
  const hits = [];
  for (let index = 1; index <= Math.max(page, 1) + 2; index += 1) {
    const pageData = await list(index);
    for (const item of pageData.items) if (item.title.includes(key)) hits.push(item);
    if (!pageData.nextPage) break;
  }
  return { items: hits.slice(0, 30), nextPage: null };
}

async function detail(id) {
  const key = String(id).replace(/^rp_/, '');
  if (!key) throw new Error('无效剧集');
  return cached(`huangdou:detail:${key}`, 10 * 60 * 1000, async () => {
    const row = await call('/drama/detail', { id: key });
    const info = card({ ...row, id: row.id || row.drama_id || key });
    const episodes = rowsOf(row.episodes);
    const total = Number(row.episode_count) || episodes.length;
    if (!total || total > 5000) throw new Error('黄豆返回了无效集数');
    const numbers = new Set();
    for (const episode of episodes) {
      const seq = Number(episode.seq || episode.episode || episode.ep || 0);
      if (seq > 0) numbers.add(seq);
    }
    if (!numbers.size) for (let index = 1; index <= total; index += 1) numbers.add(index);
    const list_ = [...numbers].sort((a, b) => a - b).map((number) => ({
      number,
      url: `${host}/drama/${key}/${number}`,
      title: `第 ${number} 集`,
    }));
    return {
      id: key,
      title: info.title,
      cover: info.cover,
      description: info.description,
      score: '',
      tags: info.tags,
      episodeLabel: `共 ${list_.length} 集`,
      episodes: list_,
      _episodes: list_,
    };
  });
}

async function episode(id, number) {
  const info = await detail(id);
  const key = String(id).replace(/^rp_/, '');
  const data = await call('/drama/play', { id: key, seq: String(number) });
  const lines = Array.isArray(data.lines) ? data.lines : [];
  let url = String(data.m3u8 || data.url || data.play_url || data.playUrl || '');
  if (!url) {
    const free = lines.find((line) => line && line.url);
    if (free) url = String(free.url);
  }
  if (!url) throw new Error('黄豆没有给出这一集的播放地址');
  if (url.startsWith('//')) url = `https:${url}`;
  else if (!/^https?:\/\//i.test(url)) url = `${host}/${url.replace(/^\/+/, '')}`;
  // 试看片段会被标成 preview，别把预告当正片播
  if (/preview\.(m3u8|mp4)/i.test(url) || String(data.is_preview).toLowerCase() === 'true') {
    throw new Error('这一集黄豆只给试看片段，换一集或换源试试');
  }
  const hlsKey = String(data.hls_key || '');
  return {
    url,
    referer: `${host}/home`,
    title: info.title,
    cover: info.cover,
    // 清单里若没有 EXT-X-KEY，后端用这把 key 兜底解密
    key: /^[0-9a-f]{32}$/i.test(hlsKey) ? Buffer.from(hlsKey, 'hex') : null,
  };
}

module.exports = {
  id: 'huangdou',
  name: '黄豆短剧',
  description: '黄豆原创 · 每日上新',
  content: '短剧',
  categories,
  home,
  category,
  search,
  detail,
  episode,
};
