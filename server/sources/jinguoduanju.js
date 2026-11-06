'use strict';
/**
 * 禁果短剧（jinguoduanju.app）
 *
 * 先用设备号换一个免登录 token（/auth/device），之后所有请求带 Bearer。
 * 目录接口一次把整库吐出来（四百多条），分页在服务端切，省得来回请求。
 * 播放地址是普通 m3u8，没有签名 cookie，客户端直接播后端代理即可。
 */

const crypto = require('crypto');
const { request } = require('./util');

const BASES = ['https://jinguoduanju.app/api/v1', 'https://jgdj.app/api/v1', 'https://play.jinguoduanju.app/api/v1'];
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const PAGE_SIZE = 20;

const state = { base: '', site: '', token: '', device: '', catalog: null, catalogAt: 0 };

function deviceId() {
  if (state.device) return state.device;
  const bytes = crypto.randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  state.device = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return state.device;
}

function headers(extra) {
  return {
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'User-Agent': UA,
    Referer: `${state.site}/`,
    Origin: state.site,
    ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
    ...(extra || {}),
  };
}

/** 逐个线路试，成功的记下来；401 时重登一次 */
async function raw(base, path, options = {}) {
  const res = await request(`${base}${path}`, {
    method: options.method || 'GET',
    headers: options.headers || {},
    body: options.body,
    timeout: 20000,
    maxBytes: 8 << 20,
  });
  return res;
}

async function login(base) {
  const res = await request(`${base}/auth/device`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': UA,
      Origin: new URL(base).origin,
      Referer: `${new URL(base).origin}/`,
    },
    body: JSON.stringify({ deviceId: `h5:${deviceId()}`, channelCode: '', attributionToken: '' }),
    timeout: 20000,
  });
  if (res.status < 200 || res.status >= 300) throw new Error(`授权失败 ${res.status}`);
  let payload;
  try {
    payload = JSON.parse(res.text());
  } catch {
    throw new Error('授权返回格式已变化');
  }
  const token = String((payload.data && (payload.data.token || payload.data.accessToken)) || payload.token || '');
  if (!token || !/^[\x21-\x7e]+$/.test(token) || token.length > 8192) throw new Error('站点没有下发有效授权');
  return { token, site: new URL(base).origin };
}

async function api(path, retried = false) {
  const bases = state.base ? [state.base, ...BASES.filter((item) => item !== state.base)] : BASES;
  let lastError = null;
  for (const base of bases) {
    try {
      if (!state.token) {
        const session = await login(base);
        state.token = session.token;
        state.site = session.site;
      } else if (!state.site) {
        state.site = new URL(base).origin;
      }
      const res = await raw(base, path, { headers: headers() });
      if (res.status === 401 && !retried) {
        state.token = '';
        return api(path, true);
      }
      if (res.status < 200 || res.status >= 300) throw new Error(`源站返回 ${res.status}`);
      let payload;
      try {
        payload = JSON.parse(res.text());
      } catch {
        throw new Error('源站返回的不是 JSON');
      }
      state.base = base;
      state.site = new URL(base).origin;
      return payload;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`禁果短剧线路暂不可用（${lastError ? lastError.message : '全部线路无响应'}）`);
}

/** 有的接口直接返回数组，有的包一层 data，统一拆开 */
const unwrap = (payload) => (payload && payload.data !== undefined ? payload.data : payload);

/** 目录接口把库全量返回，这里做 10 分钟缓存 + 本地分页 */
async function catalog() {
  if (state.catalog && Date.now() - state.catalogAt < 10 * 60 * 1000) return state.catalog;
  const data = unwrap(await api('/dramas?sort=latest&displayArea=HOME_FEED'));
  const rows = Array.isArray(data) ? data : data.dramas || data.list || data.items || data.records || [];
  if (!Array.isArray(rows)) throw new Error('目录格式已变化');
  state.catalog = rows;
  state.catalogAt = Date.now();
  return rows;
}

function cover(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  return `${state.site}${raw.startsWith('/') ? '' : '/'}${raw}`;
}

function card(row) {
  const episodes = Number(row.episodeCount) || 0;
  const tags = (Array.isArray(row.tags) ? row.tags : [])
    .map((tag) => (typeof tag === 'string' ? tag : tag && tag.name))
    .filter((tag) => typeof tag === 'string' && tag.trim())
    .slice(0, 5);
  const heat = Number(row.heat) || 0;
  if (heat >= 10000) tags.push(`${(heat / 10000).toFixed(1)}万热度`);
  const finished = String(row.filmType || '').toUpperCase() === 'COMPLETE' || row.completed === true;
  return {
    id: String(row.id || ''),
    title: String(row.title || '').slice(0, 200),
    cover: cover(row.coverUrl),
    description: String(row.description || row.subtitle || '').slice(0, 4000),
    score: '',
    episodeLabel: episodes ? `共 ${episodes} 集` : '',
    category: '短剧',
    tags: tags.slice(0, 5),
    status: finished ? 'finished' : '',
  };
}

function slice(rows, page) {
  const start = (page - 1) * PAGE_SIZE;
  const items = rows.slice(start, start + PAGE_SIZE).map(card).filter((item) => item.id && item.title);
  return { items, nextPage: start + PAGE_SIZE < rows.length ? page + 1 : null };
}

let categoryCache = null;
async function categories() {
  if (categoryCache && Date.now() - categoryCache.at < 6 * 3600 * 1000) return categoryCache.items;
  const items = [{ id: '', name: '全部' }, { id: 'latest', name: '最新' }, { id: 'heat', name: '最热' }];
  const seen = new Set(['', 'latest', 'new', 'heat']);
  const push = (id, name) => {
    const label = String(name || '').trim().slice(0, 24);
    if (!id || !label || seen.has(id)) return;
    seen.add(id);
    items.push({ id, name: label });
  };
  try {
    const nav = unwrap(await api('/top-navigation'));
    for (const row of Array.isArray(nav) ? nav : []) {
      if (!row || row.active === false || row.valid === false) continue;
      if (String(row.targetType || '').toUpperCase() === 'SYSTEM') continue;
      push(`nav:${row.id}`, row.frontendName);
    }
  } catch {
    /* 分类拿不到不影响首页 */
  }
  try {
    const filter = unwrap(await api('/filter-config'));
    for (const group of Array.isArray(filter) ? filter : []) {
      if (!group || group.active === false || group.frontendVisible === false) continue;
      for (const tag of Array.isArray(group.tags) ? group.tags : []) {
        if (!tag || tag.active === false || tag.frontendVisible === false) continue;
        if (items.length >= 40) break;
        push(`tag:${tag.id}`, tag.name);
      }
    }
  } catch {
    /* 标签拿不到就只用导航分类 */
  }
  categoryCache = { items, at: Date.now() };
  return items;
}

async function list(query, page) {
  const params = new URLSearchParams({ sort: 'latest' });
  for (const [key, value] of Object.entries(query)) if (value) params.set(key, String(value));
  const data = unwrap(await api(`/dramas?${params.toString()}`));
  const rows = Array.isArray(data) ? data : data.dramas || data.list || data.items || data.records || [];
  if (!Array.isArray(rows)) throw new Error('目录格式已变化');
  return slice(rows.filter((row) => row && row.id && row.title), page);
}

async function home() {
  const [all, catalogRows] = await Promise.all([list({ displayArea: 'HOME_FEED' }, 1), catalog()]);
  const hot = catalogRows
    .slice()
    .sort((a, b) => (Number(b.heat) || 0) - (Number(a.heat) || 0))
    .slice(0, 20)
    .map(card)
    .filter((item) => item.id && item.title);
  const newest = all.items;
  return {
    featured: hot.slice(0, 5).map((item) => ({ ...item, description: item.description || item.title })),
    items: all.items,
    homepageRecommend: hot.slice(0, 6),
    homepageNewest: newest.slice(0, 6),
    recommend: { items: hot, nextPage: null },
    newest: { items: newest, nextPage: all.nextPage },
  };
}

async function category(slug, page) {
  const value = String(slug || '');
  if (!value) return list({ displayArea: 'HOME_FEED' }, page);
  if (value === 'latest' || value === 'new') return list({ sort: 'latest' }, page);
  if (value === 'heat') return list({ sort: 'heat' }, page);
  const [kind, id] = value.split(':');
  if (kind === 'nav') return list({ navigationId: id }, page);
  if (kind === 'tag') return list({ tags: id }, page);
  return list({}, page);
}

async function search(keyword, page) {
  return list({ q: keyword }, page);
}

async function detail(id) {
  if (!/^\d+$/.test(String(id))) throw new Error('无效剧集');
  const data = unwrap(await api(`/dramas/${encodeURIComponent(id)}`));
  const row = data.drama || data;
  const info = card(row);
  if (!info.id) throw new Error('源站没有返回这部剧');
  if (!info.description && data.description) info.description = String(data.description).slice(0, 4000);
  const episodes = [];
  for (const item of Array.isArray(data.episodes) ? data.episodes : []) {
    const number = Number(item.number) || 0;
    if (!number || !item.id) continue;
    episodes.push({ number, episodeId: String(item.id), title: String(item.title || `第 ${number} 集`) });
  }
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
    episodes: episodes.map((episode) => ({ number: episode.number, url: `${state.site}/episode/${episode.episodeId}` })),
    _episodes: episodes,
  };
}

async function play(id, number) {
  const info = await detail(id);
  const hit = info._episodes.find((item) => item.number === number);
  if (!hit) throw new Error('这一集不存在');
  const data = unwrap(await api(`/episodes/${encodeURIComponent(hit.episodeId)}/play`));
  if (data.allowance && data.allowance.allowed === false) throw new Error('这一集暂时无法观看');
  const url = String(data.videoUrl || '');
  if (!/^https?:\/\//i.test(url)) throw new Error('源站没有给出播放地址');
  return { url, referer: `${state.site}/`, title: info.title, cover: info.cover };
}

module.exports = {
  id: 'jinguoduanju',
  name: '禁果短剧',
  description: '推荐 · 分类短剧 · 在线搜索',
  content: '短剧',
  categories,
  home,
  category,
  search,
  detail,
  episode: play,
};
