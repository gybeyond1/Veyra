'use strict';
/**
 * 剧果（huangju.net / api.huangju.net）
 *
 * 接口很干净：/categories、/dramas、/dramas/:slug-id、/play/:episodeId。
 * 麻烦在播放：/play 会下发三个 CloudFront 签名 cookie，分片缺了直接 403，
 * 播放器带不上 cookie，所以播放地址统一由后端 stream 端点持有（见 index.js）。
 */

const { getJSON, cached, request } = require('./util');

const API = 'https://api.huangju.net';
const SITE = 'https://huangju.net';
const UA = 'Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.91 Mobile Safari/537.36';

const HEADERS = {
  'User-Agent': UA,
  Referer: `${SITE}/`,
  Origin: SITE,
  'Accept-Language': 'zh-CN,zh;q=0.9',
};

async function api(path) {
  return getJSON(`${API}${path}`, { headers: HEADERS, timeout: 15000 });
}

/** 源站字段 → Veyra 卡片结构 */
function card(row) {
  const categories = [];
  if (row.category && row.category.name) categories.push(row.category.name);
  for (const entry of Array.isArray(row.categories) ? row.categories : []) {
    const name = typeof entry === 'string' ? entry : entry && entry.name;
    if (name && !categories.includes(name)) categories.push(name);
  }
  const tags = [...categories];
  if (row.region) tags.push(String(row.region));
  if (row.year) tags.push(`${row.year}年`);
  const score = Number(row.score);
  if (score > 0 && score <= 10) tags.push(`评分 ${score}`);

  const episodes = Number(row.totalEpisodes) || 0;
  const status = row.status === 'completed' ? 'finished' : row.status;
  return {
    id: `${row.slug}-${row.id}`,
    title: String(row.title || '').slice(0, 200),
    cover: String(row.coverUrl || row.coverHUrl || ''),
    description: String(row.description || '').slice(0, 4000),
    score: score > 0 && score <= 10 ? score.toFixed(1) : '',
    episodeLabel: status === 'finished' ? `全 ${episodes} 集` : episodes ? `更新至 ${episodes} 集` : '',
    category: categories[0] || '短剧',
    tags: tags.slice(0, 5),
    status: status === 'finished' || status === 'ongoing' ? status : '',
  };
}

/** 分类列表：热门的 "hot" 排前面，其余按源站顺序 */
async function categories() {
  return cached('huangju:categories', 6 * 3600 * 1000, async () => {
    const rows = await api('/categories');
    const list = [{ id: '', name: '全部' }, { id: 'new', name: '最新' }];
    const seen = new Set(['', 'new']);
    for (const row of Array.isArray(rows) ? rows : []) {
      const id = String(row.slug || '');
      if (!id || id === 'hot' || seen.has(id)) continue;
      seen.add(id);
      list.push({ id, name: String(row.name || id) });
      // 源站有三百多个细分标签，全塞进选择器没法用，取前 40 个
      if (list.length >= 40) break;
    }
    return list;
  });
}

async function list(query, page) {
  const params = new URLSearchParams({ page: String(page) });
  for (const [key, value] of Object.entries(query)) if (value) params.set(key, value);
  const data = await api(`/dramas?${params.toString()}`);
  const rows = Array.isArray(data.items) ? data.items : [];
  const pageSize = Number(data.pageSize) || 20;
  const total = Number(data.total) || 0;
  return {
    items: rows.map(card),
    nextPage: total ? (page < Math.ceil(total / pageSize) ? page + 1 : null) : rows.length >= pageSize ? page + 1 : null,
    total,
  };
}

async function home() {
  // 首页三块：热门、最新、成人向推荐（剧果内容以成人向为主，推荐位取热门前 6）
  const [hot, newest] = await Promise.all([list({ sort: 'hot' }, 1), list({ sort: 'new' }, 1)]);
  const featured = hot.items.slice(0, 5).map((item) => ({
    ...item,
    description: item.description || item.title,
  }));
  return {
    featured,
    items: hot.items,
    homepageRecommend: hot.items.slice(0, 6),
    homepageNewest: newest.items.slice(0, 6),
    recommend: { items: hot.items, nextPage: hot.nextPage },
    newest: { items: newest.items, nextPage: newest.nextPage },
  };
}

async function category(slug, page) {
  const result = await list(slug === 'new' ? { sort: 'new' } : { category: slug }, page);
  return { items: result.items, nextPage: result.nextPage };
}

async function search(keyword, page) {
  const result = await list({ q: keyword }, page);
  return { items: result.items, nextPage: result.nextPage };
}

/** 详情里的分集只保留可播的，按 epNo 升序 */
async function detail(id) {
  if (!/^[a-z0-9-]+-\d+$/i.test(id)) throw new Error('无效剧集');
  return cached(`huangju:detail:${id}`, 10 * 60 * 1000, async () => {
    const row = await api(`/dramas/${encodeURIComponent(id)}`);
    const episodes = [];
    const rows = Array.isArray(row.episodes) ? row.episodes : [];
    rows.forEach((episode, index) => {
      if (episode && episode.playable === false) return;
      const number = Number(episode.epNo) || index + 1;
      episodes.push({ number, episodeId: String(episode.id || ''), title: String(episode.title || `第 ${number} 集`) });
    });
    episodes.sort((a, b) => a.number - b.number);
    if (!episodes.length) throw new Error('这一部没有可播放的分集');
    const info = card(row);
    return {
      id,
      title: info.title,
      cover: info.cover,
      description: info.description,
      score: info.score,
      tags: info.tags,
      episodeLabel: `共 ${episodes.length} 集`,
      episodes: episodes.map((episode) => ({ number: episode.number, url: `${SITE}/episode/${episode.episodeId}` })),
      // 服务端自用：播放时按集号取 episodeId，不给客户端
      _episodes: episodes,
    };
  });
}

/** 取某一集的播放地址与签名 cookie（分片缺了这三个 cookie 直接 403） */
async function episode(id, number) {
  const info = await detail(id);
  const hit = info._episodes.find((item) => item.number === number);
  if (!hit || !hit.episodeId) throw new Error('这一集不存在');

  const res = await request(`${API}/play/${encodeURIComponent(hit.episodeId)}`, { headers: HEADERS, timeout: 15000 });
  if (res.status < 200 || res.status >= 300) throw new Error(`源站返回 ${res.status}`);
  let payload;
  try {
    payload = JSON.parse(res.text());
  } catch {
    throw new Error('源站返回的不是 JSON');
  }
  const url = String(payload.url || '');
  if (!/^https?:\/\//i.test(url)) throw new Error('源站没有给出播放地址');

  const raw = res.headers['set-cookie'];
  const cookies = (Array.isArray(raw) ? raw : raw ? [raw] : [])
    .map((line) => String(line).split(';')[0].trim())
    .filter((pair) => /^CloudFront-/.test(pair));
  return {
    url,
    referer: `${SITE}/`,
    cookie: cookies.join('; '),
    title: info.title,
    cover: info.cover,
  };
}

module.exports = {
  id: 'huangju',
  name: '剧果',
  description: '热门 · 最新 · 分类短剧',
  content: '短剧',
  // 分片靠 Set-Cookie 下发的 CloudFront 签名，浏览器带不上 Cookie，
  // 所以 WebUI（不传 carry=1）会据此自动降级为后端转发；
  // 手机 / 电视 / 电脑的原生播放器能把这套头贴到每条请求上，可以真直连。
  noDirect: true,
  categories,
  home,
  category,
  search,
  detail,
  episode,
};
