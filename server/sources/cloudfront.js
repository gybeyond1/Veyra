'use strict';
/**
 * 黄果旧版（cloudfront 上那套 App 接口）
 *
 * 请求参数 AES 加密进 data 字段，响应再按 interfaceKey 派生密钥解一遍，
 * 还要带一个伪造的设备号换访客 token —— 客户端复刻这套不现实，只能服务端做。
 *
 * 协议密钥（interfaceKey / parameterKey / parameterIv）写在官网前端脚本里，
 * 这里启动时抓一次缓存 24 小时，抓不到就用内置的那份（和官方脚本当前一致）。
 */

const crypto = require('crypto');
const { request } = require('./util');

const BASE = 'https://dr6skssi3nxbk.cloudfront.net';
const FRONT = 'https://d2pypzndaqisk.cloudfront.net';
const CDN = 'https://sjljsla.lkkwip.cn';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1';

const FALLBACK = {
  interfaceKey: '65dc07d1b7915c6b2937432b091837a7',
  paramKey: 'BxJand%xf5h3sycH',
  paramIv: 'BxJand%xf5h3sycH',
};

const state = { token: '', device: '', protocol: null, protocolAt: 0, cat: null, catAt: 0 };

/* ---------------- 加解密 ---------------- */

function pkcs7(buffer) {
  const pad = 16 - (buffer.length % 16);
  return Buffer.concat([buffer, Buffer.alloc(pad, pad)]);
}

function unpad(buffer) {
  const pad = buffer[buffer.length - 1];
  return pad > 0 && pad <= 16 ? buffer.subarray(0, buffer.length - pad) : buffer;
}

function encryptParam(value, key, iv) {
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(pkcs7(Buffer.from(JSON.stringify(value)))), cipher.final()]).toString('base64');
}

/** 响应解密：前 12 字节是随机前缀，用它和 interfaceKey 派生出 AES 的 key 与 iv */
function decryptResponse(dataString, interfaceKey) {
  const payload = Buffer.from(String(dataString).trim(), 'base64');
  if (payload.length < 12) throw new Error('响应密文过短');
  const prefix = payload.subarray(0, 12);
  const mixed = Buffer.concat([interfaceKey, prefix]);
  const half = mixed.length >> 1;
  const seed = crypto.createHash('sha256').update(mixed).digest().subarray(8, 24);
  const left = Buffer.concat([seed, mixed.subarray(0, half)]);
  const right = Buffer.concat([mixed.subarray(half), seed]);
  const h1 = crypto.createHash('sha256').update(left).digest();
  const h2 = crypto.createHash('sha256').update(right).digest();
  const key = Buffer.concat([h1.subarray(0, 8), h2.subarray(8, 24), h1.subarray(24)]);
  const iv = Buffer.concat([h2.subarray(0, 4), h1.subarray(12, 20), h2.subarray(28)]);
  const body = payload.subarray(12);
  if (body.length % 16) throw new Error('响应密文未对齐');
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  decipher.setAutoPadding(false);
  return unpad(Buffer.concat([decipher.update(body), decipher.final()]));
}

/* ---------------- 协议 ---------------- */

async function protocol() {
  if (state.protocol && Date.now() - state.protocolAt < 24 * 3600 * 1000) return state.protocol;
  try {
    const page = await request(`${FRONT}/`, { headers: { Referer: `${FRONT}/` }, timeout: 15000, maxBytes: 1 << 20 });
    const html = page.text();
    const entryRef = [...html.matchAll(/<script[^>]*type="module"[^>]*src="([^"]+)"/g)].map((m) => m[1])[0];
    if (!entryRef) throw new Error('未找到前端脚本');
    const script = (await request(new URL(entryRef, `${FRONT}/`).toString(), { headers: { Referer: `${FRONT}/` }, timeout: 20000, maxBytes: 4 << 20 })).text();
    const pick = (name) => {
      const match = new RegExp(`["']${name}["']\\s*[:,]\\s*["']([^"'\\\\\\r\\n]+)["']`).exec(script);
      return match ? match[1] : '';
    };
    const found = { interfaceKey: pick('interfaceKey'), paramKey: pick('parameterKey'), paramIv: pick('parameterIv') };
    if (!found.interfaceKey || found.paramKey.length !== 16 || found.paramIv.length !== 16) throw new Error('协议解析失败');
    state.protocol = found;
    state.protocolAt = Date.now();
  } catch {
    state.protocol = FALLBACK;
    state.protocolAt = Date.now();
  }
  return state.protocol;
}

function userAgent() {
  return `BuildID=com.abc.Butterfly;SysType=ios;DevID=${state.device || '00000000000000000000000000000'};Ver=1.0.0;DevType=iPhone;DeviceBrand=APPLE;DeviceModel=iPhone;SystemName=iOS;SystemVersion=18.7;Terminal=1;IsH5=1;Sid=00000000000000000000000000000000`;
}

async function login(force) {
  if (state.token && !force) return state.token;
  if (!state.device) state.device = crypto.randomBytes(4).toString('hex').toUpperCase() + Date.now();
  const keys = await protocol();
  const res = await request(`${BASE}/api/app/mine/login/h5`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      temp: 'test',
      'X-User-Agent': userAgent(),
      Origin: FRONT,
      Referer: `${FRONT}/`,
      'User-Agent': UA,
    },
    body: JSON.stringify({ data: encryptParam({ devID: state.device, sysType: 'ios', isAppStore: false }, Buffer.from(keys.paramKey), Buffer.from(keys.paramIv)) }),
    timeout: 20000,
  });
  const envelope = JSON.parse(res.text());
  let data = envelope.data;
  if (typeof data === 'string') data = JSON.parse(decryptResponse(data, Buffer.from(keys.interfaceKey)).toString('utf8'));
  const token = data && (data.token || data.accessToken);
  if (!token) throw new Error('黄果旧版访客登录失败');
  state.token = String(token);
  return state.token;
}

/** 统一请求：参数加密进 data，响应按需解密 */
async function api(path, params, retried = false) {
  const keys = await protocol();
  const token = await login();
  let url = `${BASE}${path}`;
  const headers = {
    Accept: 'application/json',
    temp: 'test',
    'X-User-Agent': userAgent(),
    Origin: FRONT,
    Referer: `${FRONT}/`,
    'User-Agent': UA,
    Authorization: token,
  };
  if (params) url += `${url.includes('?') ? '&' : '?'}data=${encodeURIComponent(encryptParam(params, Buffer.from(keys.paramKey), Buffer.from(keys.paramIv)))}`;

  const res = await request(url, { headers, timeout: 20000, maxBytes: 8 << 20 });
  let envelope;
  try {
    envelope = JSON.parse(res.text());
  } catch {
    throw new Error(`黄果旧版返回 ${res.status}`);
  }
  const code = String(envelope.code === undefined || envelope.code === null ? '' : envelope.code).replace(/"/g, '');
  if (code && code !== '200' && code !== '0' && code !== 'null') {
    // 5005/5009：访客 token 过期，重登一次
    if ((code === '5005' || code === '5009') && !retried) {
      state.token = '';
      return api(path, params, true);
    }
    throw new Error(`黄果旧版：${String(envelope.msg || code).slice(0, 100)}`);
  }
  let data = envelope.data;
  if (typeof data === 'string' && envelope.hash) {
    try {
      data = JSON.parse(decryptResponse(data, Buffer.from(keys.interfaceKey)).toString('utf8'));
    } catch {
      if (!retried) {
        state.token = '';
        state.protocol = null;
        return api(path, params, true);
      }
      throw new Error('黄果旧版响应解密失败');
    }
  }
  if (data === null || data === undefined) throw new Error('黄果旧版没有返回数据');
  return data;
}

/* ---------------- 数据映射 ---------------- */

function coverUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.startsWith('//')) return `https:${raw}`;
  if (/^https?:\/\//i.test(raw)) return raw;
  const path = raw.replace(/^\/+/, '');
  return `${path.startsWith('upload') ? 'https://pic.zdmhyg.cn/' : 'https://zzzznnn.lkkwip.cn/'}${path}`;
}

function card(row, tabName) {
  const episodes = Number(row.totalEpisode || row.updateEpisode) || 0;
  const tags = [];
  if (row.anchor) tags.push(String(row.anchor).slice(0, 12));
  for (const tag of Array.isArray(row.tagNames) ? row.tagNames : []) {
    if (tag && tags.length < 3) tags.push(String(tag).slice(0, 12));
  }
  const status = Number(row.continueStatus) === 2 ? 'finished' : '';
  return {
    id: String(row.id || ''),
    title: String(row.title || '').slice(0, 200),
    cover: coverUrl(row.cover || row.horizontalCover),
    description: String(row.summary || '').slice(0, 4000),
    score: Number(row.scoreExtra) > 0 ? Number(row.scoreExtra).toFixed(1) : '',
    episodeLabel: episodes ? (status === 'finished' ? `全 ${episodes} 集` : `更新至 ${episodes} 集`) : '',
    category: String(row.categoryName || tabName || '短剧').slice(0, 20),
    tags: tags.slice(0, 4),
    status,
  };
}

async function tabs() {
  if (state.cat && Date.now() - state.catAt < 10 * 60 * 1000) return state.cat;
  const data = await api('/api/app/playlet-tab/all');
  const list = Array.isArray(data) ? data : data.list || [];
  const items = list.filter((tab) => tab && tab.id && tab.name).map((tab) => ({ id: String(tab.id), name: String(tab.name).slice(0, 24) }));
  if (!items.length) throw new Error('黄果旧版没有返回可用分类');
  state.cat = items;
  state.catAt = Date.now();
  return items;
}

async function tabPage(tabId, page) {
  const data = await api(`/api/app/playlet/home/tab/${encodeURIComponent(tabId)}`, {
    pageNumber: page,
    pageSize: 20,
    tabSortType: '1',
  });
  const rows = Array.isArray(data.list) ? data.list : [];
  const tab = (await tabs()).find((item) => item.id === tabId);
  const items = rows.map((row) => card(row, tab && tab.name)).filter((item) => item.id && item.title);
  return { items, nextPage: rows.length >= 20 ? page + 1 : null };
}

async function categories() {
  return tabs();
}

async function home() {
  const list = await tabs();
  const first = await tabPage(list[0].id, 1);
  const second = list[1] ? await tabPage(list[1].id, 1).catch(() => ({ items: [], nextPage: null })) : { items: [], nextPage: null };
  return {
    featured: first.items.slice(0, 5).map((item) => ({ ...item, description: item.description || item.title })),
    items: first.items,
    homepageRecommend: first.items.slice(0, 6),
    homepageNewest: second.items.slice(0, 6),
    recommend: { items: first.items, nextPage: first.nextPage },
    newest: { items: second.items, nextPage: second.nextPage },
  };
}

async function category(slug, page) {
  const value = String(slug || '');
  // "最新" 在这套接口里没有独立排序，第一栏（原创大作）更新最勤
  if (value && value !== 'new' && value !== 'latest') return tabPage(value, page);
  const list = await tabs();
  return tabPage(list[0].id, page);
}

async function search(keyword, page) {
  const data = await api('/api/app/playlet/keyword/search', { keyword, pageNumber: page, pageSize: 20 });
  const rows = Array.isArray(data.list) ? data.list : [];
  return { items: rows.map((row) => card(row)).filter((item) => item.id && item.title), nextPage: rows.length >= 20 ? page + 1 : null };
}

async function detail(id) {
  if (!/^[0-9a-f]{16,32}$/i.test(String(id))) throw new Error('无效剧集');
  const data = await api(`/api/app/playlet/detail/${encodeURIComponent(id)}`);
  const info = card(data);
  if (!info.title) throw new Error('黄果旧版没有返回这部剧');
  let rows = Array.isArray(data.chapters) ? data.chapters : [];
  if (!rows.length) {
    const extra = await api(`/api/app/playlet-chapter/list/${encodeURIComponent(id)}`);
    rows = Array.isArray(extra) ? extra : extra.list || [];
  }
  const episodes = [];
  rows.forEach((row, index) => {
    if (!row) return;
    const number = Number(row.currentEpisode) || index + 1;
    episodes.push({ number, episodeId: String(row.id || number), title: String(row.title || `第 ${number} 集`), videoUrl: String(row.videoUrl || '') });
  });
  episodes.sort((a, b) => a.number - b.number);
  if (!episodes.length) throw new Error('这一部没有可播放的分集');
  return {
    id: String(id),
    title: info.title,
    cover: info.cover,
    description: info.description,
    score: info.score,
    tags: info.tags,
    episodeLabel: `共 ${episodes.length} 集`,
    episodes: episodes.map((episode) => ({ number: episode.number, url: `${FRONT}/video/${id}/${episode.number}` })),
    _episodes: episodes,
  };
}

async function play(id, number) {
  const info = await detail(id);
  const hit = info._episodes.find((item) => item.number === number);
  if (!hit || !hit.videoUrl) throw new Error('这一集没有可用的播放地址');
  const token = await login();
  const query = new URLSearchParams({ token, c: CDN }).toString();
  return {
    url: `${BASE}/api/app/vid/h5/m3u8/${encodeURIComponent(hit.videoUrl)}?${query}`,
    referer: `${FRONT}/`,
    title: info.title,
    cover: info.cover,
  };
}

module.exports = {
  id: 'cloudfront',
  name: '黄果旧版',
  description: '旧 API 剧库 · 分类与搜索',
  content: '短剧',
  categories,
  home,
  category,
  search,
  detail,
  episode: play,
};
