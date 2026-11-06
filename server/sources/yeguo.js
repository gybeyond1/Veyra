'use strict';
/**
 * 野果（vgbyziuz.cc 线路）
 *
 * 接口是加签 + AES 的：参数固定带 bundleId/via=pwa/oauth_id，响应整体再 AES-CBC 加密，
 * 外面套一层 sign 校验。密钥不在固定位置，而是随前端构建产物变化 ——
 * 所以每次换构建都要重新从 /_nuxt 的模块里把 key/iv/sign_key 和接口基址读出来。
 *
 * 站点经常换域名，这里按线路列表逐个试，成功的那条记下来复用。
 */

const crypto = require('crypto');
const { request } = require('./util');

const SITES = [
  'https://attract.vgbyziuz.cc',
  'https://as.vgbyziuz.cc',
  'https://anyway.vgbyziuz.cc',
  'https://analyze.buxefaex.cc',
];

const PUBLIC_FIELD = /\b(version|mode|padding|key|iv|sign_key)\s*:\s*(?:[a-zA-Z_$][a-zA-Z0-9_$]*\(\s*)?["'`]([^"'`\\\r\n]{1,512})["'`]/g;
const MODULE_IMPORT = /import\s*\{([^{};]+)\}\s*from\s*["'`]([^"'`]+)["'`]/g;
const BASE_CALL = /baseURL:([a-zA-Z_$][a-zA-Z0-9_$]*)\([a-zA-Z_$]?[a-zA-Z0-9_$]*\)/g;
const NUXT_DATA = /<script[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/;
const HEADERS_JSON = { Accept: 'application/json, text/plain, */*' };

let access = null; // { site, base, key, iv, signKey, oid, at }

const fix = (text) => String(text || '').replace(/ /g, '+');

/** 站点里的 key 有时写成 "104_101_121" 这种十进制字节序列 */
function keyBytes(value) {
  if (!value.includes('_')) return Buffer.from(value, 'utf8');
  const parts = value.split('_');
  const out = Buffer.alloc(parts.length);
  for (let i = 0; i < parts.length; i += 1) {
    const byte = Number(parts[i]);
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) return null;
    out[i] = byte;
  }
  return out;
}

function parsePublicConfig(script) {
  const fields = {};
  for (const match of script.matchAll(PUBLIC_FIELD)) fields[match[1]] = match[2];
  if (fields.version !== 'v0' || fields.mode !== 'CBC' || fields.padding !== 'Pkcs7') return null;
  const key = keyBytes(fields.key || '');
  const iv = keyBytes(fields.iv || '');
  const signKey = keyBytes(fields.sign_key || '');
  if (!key || !iv || !signKey) return null;
  if (![16, 24, 32].includes(key.length) || iv.length !== 16 || !signKey.length || signKey.length > 128) return null;
  return { key, iv, signKey };
}

function scriptUrl(base, reference) {
  let target;
  try {
    target = new URL(reference, base);
  } catch {
    return '';
  }
  const page = new URL(base);
  if (target.origin !== page.origin) return '';
  if (!target.pathname.startsWith('/_nuxt/') || !target.pathname.endsWith('.js')) return '';
  target.hash = '';
  return target.toString();
}

/** 从入口脚本里找接口基址：字面量优先，其次是"同源 + /api.php" */
function scriptBase(script, origin) {
  for (const call of script.matchAll(BASE_CALL)) {
    const name = call[1];
    const escaped = name.replace(/[.$]/g, '\\$&');
    const literal = new RegExp(`(?:^|[^a-zA-Z0-9_$.])${escaped}=\\(\\)=>["'\`](https?://[^"'\`\\s]{1,512})["'\`]`).exec(script);
    if (literal && !/shuifeng|telegram|t\.me/i.test(literal[1])) return literal[1].replace(/\/+$/, '');
    const sameOrigin = new RegExp(`(?:^|[^a-zA-Z0-9_$.])${escaped}=\\([^()]{0,40}\\)=>\\{[\\s\\S]{0,400}?origin:([a-zA-Z_$][a-zA-Z0-9_$]*)[\\s\\S]{0,400}?\`\\$\\{([a-zA-Z_$][a-zA-Z0-9_$]*)\\}/api\\.php\``).exec(script);
    if (sameOrigin && sameOrigin[1] === sameOrigin[2] && origin) return `${origin}/api.php`;
  }
  return origin ? `${origin}/api.php` : '';
}

async function discover() {
  let lastError = null;
  for (const site of SITES) {
    try {
      const page = await request(`${site}/`, { headers: { Referer: `${site}/` }, timeout: 20000, maxBytes: 4 << 20 });
      if (page.status < 200 || page.status >= 300) throw new Error(`站点返回 ${page.status}`);
      const html = page.text();
      const entryRef = [...html.matchAll(/<script[^>]*type="module"[^>]*src="([^"]+)"/g)].map((m) => m[1])[0];
      const entry = entryRef && scriptUrl(`${site}/`, entryRef);
      if (!entry) throw new Error('页面结构已变化');

      const entryBody = (await request(entry, { headers: { Referer: `${site}/` }, timeout: 20000, maxBytes: 4 << 20 })).text();
      const origin = new URL(site).origin;
      let base = scriptBase(entryBody, origin);
      let config = parsePublicConfig(entryBody);

      // 密钥通常在同批 chunk 里；并行抓前 8 个，谁先命中用谁
      if (!config) {
        const refs = [...entryBody.matchAll(MODULE_IMPORT)]
          .filter((m) => m[1].length <= 2400)
          .map((m) => scriptUrl(entry, m[2]))
          .filter(Boolean)
          .slice(0, 8);
        const bodies = await Promise.all(
          refs.map((url) =>
            request(url, { headers: { Referer: `${site}/` }, timeout: 20000, maxBytes: 4 << 20 })
              .then((res) => res.text())
              .catch(() => '')
          )
        );
        for (const body of bodies) {
          if (!body) continue;
          if (!config) config = parsePublicConfig(body);
          if (!base || base.endsWith('/api.php')) {
            const found = scriptBase(body, origin);
            if (found) base = found;
          }
          if (config) break;
        }
      }
      if (!config) throw new Error('接口密钥已变化');
      const nuxt = NUXT_DATA.exec(html);
      if (!base && nuxt) {
        try {
          const table = JSON.parse(nuxt[1]);
          for (const row of table) {
            if (row && typeof row === 'object' && !Array.isArray(row) && 'apiBaseURL' in row) {
              const value = table[row.apiBaseURL];
              if (typeof value === 'string' && /^https?:\/\//.test(value)) base = value.replace(/\/+$/, '');
            }
          }
        } catch {
          /* 结构变了就还是用同源兜底 */
        }
      }
      if (!base) throw new Error('未找到接口入口');
      return {
        site,
        base,
        key: config.key,
        iv: config.iv,
        signKey: config.signKey,
        oid: crypto.randomBytes(8).toString('hex'),
        at: Date.now(),
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`野果线路暂不可用（${lastError ? lastError.message : '全部线路无响应'}）`);
}

let loading = null;
async function config() {
  if (access && Date.now() - access.at < 45 * 60 * 1000) return access;
  if (!loading) {
    loading = discover()
      .then((value) => {
        access = value;
        return value;
      })
      .finally(() => {
        loading = null;
      });
  }
  return loading;
}

function signature(envelope, signKey) {
  const names = Object.keys(envelope)
    .filter((name) => name !== 'sign' && name !== '_ver' && envelope[name] !== null && envelope[name] !== undefined)
    .sort();
  const pieces = [];
  for (const name of names) {
    const value = envelope[name];
    if (value !== null && typeof value === 'object') return '';
    let text = String(value);
    if (name === 'data') text = text.replace(/ /g, '+');
    pieces.push(`${name}=${text}`);
  }
  const digest = crypto.createHash('sha256').update(Buffer.concat([Buffer.from(pieces.join('&')), signKey])).digest('hex');
  return crypto.createHash('md5').update(digest).digest('hex');
}

function decryptPayload(encoded, current) {
  const ciphertext = Buffer.from(fix(encoded).trim(), 'base64');
  if (!ciphertext.length || ciphertext.length % 16) throw new Error('密文长度异常');
  const decipher = crypto.createDecipheriv(`aes-${current.key.length * 8}-cbc`, current.key, current.iv);
  decipher.setAutoPadding(false);
  let plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const pad = plain[plain.length - 1];
  if (pad > 0 && pad <= 16) plain = plain.subarray(0, plain.length - pad);
  return JSON.parse(plain.toString('utf8'));
}

async function call(route, params, method = 'POST', retried = false) {
  const current = await config();
  const values = new URLSearchParams({
    bundleId: 'com.pwa.mater',
    version: '1.3.2',
    oauth_type: 'web',
    language: 'zh',
    via: 'pwa',
    oauth_id: current.oid,
    trace_id: current.oid,
    token: '',
  });
  for (const [key, value] of Object.entries(params || {})) values.set(key, String(value));

  let url = `${current.base}${route}`;
  const options = {
    headers: { ...HEADERS_JSON, Origin: current.site, Referer: `${current.site}/` },
    timeout: 20000,
    maxBytes: 8 << 20,
  };
  if (method === 'GET') url += `?${values.toString()}`;
  else {
    options.method = 'POST';
    options.body = values.toString();
    options.headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }

  const res = await request(url, options);
  if (res.status < 200 || res.status >= 300) throw new Error(`源站返回 ${res.status}`);
  let envelope;
  try {
    envelope = JSON.parse(res.text());
  } catch {
    throw new Error('源站返回格式已变化');
  }

  let payload;
  try {
    if (envelope.sign && signature(envelope, current.signKey) !== String(envelope.sign).toLowerCase()) {
      throw new Error('响应签名校验失败');
    }
    payload = typeof envelope.data === 'string' ? decryptPayload(envelope.data, current) : envelope;
  } catch (error) {
    // 密钥随构建轮换：丢掉缓存重来一次
    if (!retried) {
      access = null;
      return call(route, params, method, true);
    }
    throw error;
  }

  const status = String(payload.status);
  if (status !== '1') {
    if (status === '-1') throw new Error('这个源的内容需要站源授权');
    throw new Error(String(payload.msg || '源站请求未完成').slice(0, 120));
  }
  if (!payload.data || typeof payload.data !== 'object') throw new Error('源站返回的数据格式无效');
  return payload.data;
}

function absolute(site, value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  try {
    return new URL(raw, `${site}/`).toString();
  } catch {
    return '';
  }
}

function card(row, site) {
  const id = String(row.video_id || row.id || '');
  const episodes = Number(row.episode_count || row.episodes || row.total_serial) || 0;
  const status = String(row.serialize_status) === '2' ? 'finished' : String(row.serialize_status) === '1' ? 'ongoing' : '';
  const tags = (Array.isArray(row.tags) ? row.tags : []).filter((tag) => typeof tag === 'string' && tag.trim()).slice(0, 5);
  if (row.play_count_text) tags.push(String(row.play_count_text));
  return {
    id,
    title: String(row.title || '').slice(0, 200),
    cover: absolute(site, row.cover),
    description: String(row.description || '').slice(0, 4000),
    score: Number(row.score) > 0 ? Number(row.score).toFixed(1) : '',
    episodeLabel: !episodes ? '' : status === 'finished' ? `全 ${episodes} 集` : `更新至 ${episodes} 集`,
    category: '短剧',
    tags: tags.slice(0, 5),
    status: status === 'finished' || status === 'ongoing' ? status : '',
  };
}

/** 列表接口的分页字段各家写法不同，逐个兜住 */
function paging(data, rows, page) {
  const total = Number(data.total ?? data.total_count) || 0;
  const limit = Number(data.limit ?? data.page_size ?? data.pageSize) || rows.length;
  if (data.has_more !== undefined && data.has_more !== null) {
    const more = data.has_more === true || String(data.has_more) === '1' || String(data.has_more) === 'true';
    return more ? page + 1 : null;
  }
  if (total && limit) return page < Math.ceil(total / limit) ? page + 1 : null;
  return rows.length >= limit ? page + 1 : null;
}

async function categories() {
  const data = await call('/api/home/contentOptions', {}, 'GET');
  const filters = data.video_filter || {};
  const items = [{ id: '', name: '全部' }, { id: 'latest', name: '最新' }];
  const seen = new Set(['', 'latest', 'new']);
  for (const field of ['theme', 'setting', 'background']) {
    const list = (filters[field] && filters[field].list) || [];
    for (const option of list.slice(0, 120)) {
      const value = String(option.value ?? '');
      if (!value || value === '0') continue;
      const id = `${field}:${value}`;
      if (seen.has(id)) continue;
      seen.add(id);
      items.push({ id, name: String(option.name || value).slice(0, 48) });
    }
  }
  return items;
}

async function explore(params, page) {
  const data = await call('/api/theater/exploreList', { page, limit: 20, ...params });
  const rows = Array.isArray(data.list) ? data.list : [];
  const site = (await config()).site;
  return { items: rows.map((row) => card(row, site)), nextPage: paging(data, rows, page) };
}

async function home() {
  const [hot, newest] = await Promise.all([explore({ recommend: 2 }, 1), explore({ recommend: 1 }, 1)]);
  return {
    featured: hot.items.slice(0, 5).map((item) => ({ ...item, description: item.description || item.title })),
    items: hot.items,
    homepageRecommend: hot.items.slice(0, 6),
    homepageNewest: newest.items.slice(0, 6),
    recommend: { items: hot.items, nextPage: hot.nextPage },
    newest: { items: newest.items, nextPage: newest.nextPage },
  };
}

async function category(slug, page) {
  const value = String(slug || '');
  if (!value) return explore({}, page);
  if (value === 'latest' || value === 'new') return explore({ recommend: 1 }, page);
  const [field, id] = value.split(':');
  if (!field || !id) return explore({}, page);
  return explore({ [field]: id }, page);
}

async function search(keyword, page) {
  const data = await call('/api/search/result', { keyword, tab: 'video', page, limit: 20 });
  const rows = Array.isArray(data.list) ? data.list : [];
  const site = (await config()).site;
  return { items: rows.map((row) => card(row, site)), nextPage: paging(data, rows, page) };
}

async function detail(id) {
  if (!/^\d+$/.test(String(id))) throw new Error('无效剧集');
  const data = await call('/api/playlet/detail', { video_id: id, id, episode_id: 0, related_limit: 0 });
  const site = (await config()).site;
  const info = card(data, site);
  const episodes = [];
  for (const row of Array.isArray(data.episodes) ? data.episodes : []) {
    if (row && (row.is_adv === true || String(row.is_adv) === '1')) continue;
    const number = Number(row.sort) || 0;
    const episodeId = String(row.id || '');
    if (!number || !/^\d+$/.test(episodeId)) continue;
    episodes.push({ number, episodeId, title: String(row.title || `第 ${number} 集`) });
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
    episodes: episodes.map((episode) => ({ number: episode.number, url: `${site}/drama/video/${id}/ep-${episode.number}/` })),
    _episodes: episodes,
  };
}

async function play(id, number) {
  const info = await detail(id);
  const hit = info._episodes.find((item) => item.number === number);
  if (!hit) throw new Error('这一集不存在');
  const data = await call('/api/playlet/play', { playlet_id: id, video_id: id, episode_id: hit.episodeId });
  const site = (await config()).site;
  const url = absolute(site, data.video_url) || absolute(site, data.video_url_h265);
  if (!url) throw new Error('源站没有给出播放地址');
  return {
    url,
    referer: `${site}/drama/video/${id}/ep-${number}/`,
    title: info.title,
    cover: info.cover,
  };
}

module.exports = {
  id: 'yeguo',
  name: '野果',
  description: '分类短剧 · 在线搜索',
  content: '短剧',
  categories,
  home,
  category,
  search,
  detail,
  episode: play,
  // 播放地址带短时签名，过期后由网关回调这里重签
  refresh: play,
};
