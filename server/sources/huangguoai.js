'use strict';
/**
 * 黄果 AI（huangguoai.com 及其镜像）
 *
 * 站点把接口收敛到一个边缘入口：POST /api/edge/request，
 * body 里写要代理的 method/path，真正的请求由它自己发出。
 * 所以这里只要拼 path，不用处理各种签名。
 *
 * 主域名常年被墙，按镜像列表逐个探活，成功的记住。
 */

const { request } = require('./util');

/*
 * 2026-11 换站：老镜像（thu.lbvrhyir.cc / pku.xxbgwypx.cc / *.ediayikma.cc）
 * 要么 301 到新站、要么直接不通，POST 到边缘入口更是连不上。
 * 现在官方主域是 huangguoai.io，带日期的 gitiecgad.cc 是同一套站的轮换域名，
 * 两个都留着：日期域名哪天再换，主域还能兜。
 */
const MIRRORS = [
  'https://huangguoai.io',
  'https://0624.gitiecgad.cc',
];

const AI_CATEGORIES = [
  { id: 'ai-duanju', name: 'AI 短剧' },
  { id: 'ai-manju', name: 'AI 漫剧' },
  { id: 'ai-huanlian', name: 'AI 换脸' },
  { id: 'ai-mogai', name: 'AI 魔改' },
];

const state = { base: '', probing: null };

async function edgeAt(base, path, timeout) {
  const res = await request(`${base}/api/edge/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Origin: base, Referer: `${base}/` },
    body: JSON.stringify({ method: 'GET', path, body: '', content_type: '' }),
    timeout: timeout || 20000,
    maxBytes: 8 << 20,
  });
  if (res.status < 200 || res.status >= 300) throw new Error(`镜像返回 ${res.status}`);
  let envelope;
  try {
    envelope = JSON.parse(res.text());
  } catch {
    throw new Error('镜像返回格式异常');
  }
  if (String(envelope.status) !== '1') throw new Error(String(envelope.msg || '接口没有返回数据').slice(0, 120));
  return envelope.data;
}

/**
 * 镜像探活：并行发一轮，取最快回话的那条钉住。
 * 主域名常年打不通，串行试会把首屏拖到十几秒。
 */
function ensureBase() {
  if (state.base) return Promise.resolve(state.base);
  if (state.probing) return state.probing;
  state.probing = Promise.any(
    MIRRORS.map((base) => edgeAt(base, '/api/videos?page=1&size=1', 8000).then(() => base))
  )
    .then((base) => {
      state.base = base;
      return base;
    })
    .catch(() => {
      throw new Error('全部镜像无响应');
    })
    .finally(() => {
      state.probing = null;
    });
  return state.probing;
}

/** 请求一次；镜像中途挂掉就重新探活再来一遍 */
async function edge(path) {
  let lastError = null;
  for (let round = 0; round < 2; round += 1) {
    const base = await ensureBase();
    try {
      return await edgeAt(base, path);
    } catch (error) {
      lastError = error;
      state.base = '';
    }
  }
  throw new Error(`黄果 AI 线路暂不可用（${lastError ? lastError.message : '镜像无响应'}）`);
}

function absolute(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  return state.base ? `${state.base}${raw.startsWith('/') ? '' : '/'}${raw}` : raw;
}

function card(row, category) {
  const episodes = Number(row.total_episodes || row.episode_count) || 0;
  const tags = (Array.isArray(row.tags) ? row.tags : []).filter((tag) => typeof tag === 'string' && tag.trim()).slice(0, 4);
  const hot = Number(row.hot) || 0;
  if (hot >= 10000) tags.push(`${(hot / 10000).toFixed(1)}万热度`);
  const finished = row.is_finished === true || String(row.is_finished) === 'true' || String(row.is_finished) === '1';
  return {
    id: String(row.id || ''),
    title: String(row.title || '').slice(0, 200),
    cover: absolute(row.cover),
    description: String(row.description || '').slice(0, 4000),
    score: Number(row.score) > 0 ? Number(row.score).toFixed(1) : '',
    episodeLabel: episodes ? (finished ? `全 ${episodes} 集` : `更新至 ${episodes} 集`) : '',
    category: String(category || 'AI 短剧').slice(0, 20),
    tags: tags.slice(0, 5),
    status: finished ? 'finished' : 'ongoing',
  };
}

function rowsOf(data) {
  if (Array.isArray(data)) return data;
  return Array.isArray(data.items) ? data.items : Array.isArray(data.list) ? data.list : [];
}

function pageOf(data, page, size) {
  const total = Number(data && data.pagination && (data.pagination.total || data.pagination.count)) || 0;
  const pages = Number(data && data.pagination && data.pagination.pages) || 0;
  if (pages) return page < pages ? page + 1 : null;
  return rowsOf(data).length >= size ? page + 1 : total ? (page * size < total ? page + 1 : null) : null;
}

async function list(path, page, size, category) {
  const data = await edge(path);
  return {
    items: rowsOf(data).map((row) => card(row, category)).filter((item) => item.id && item.title),
    nextPage: pageOf(data, page, size),
  };
}

async function categories() {
  return [{ id: '', name: '全部' }, { id: 'new', name: '最新' }, { id: 'hot', name: '热门榜' }, ...AI_CATEGORIES];
}

async function home() {
  const [feed, ranks] = await Promise.all([
    list('/api/videos?page=1&size=20', 1, 20, 'AI 短剧').catch(() => ({ items: [], nextPage: null })),
    edge('/api/ranks/hot').catch(() => null),
  ]);
  const hot = ranks ? rowsOf(ranks).map((row) => card(row, row.cate_name)).filter((item) => item.id && item.title) : [];
  return {
    featured: (hot.length ? hot : feed.items).slice(0, 5).map((item) => ({ ...item, description: item.description || item.title })),
    items: feed.items,
    homepageRecommend: (hot.length ? hot : feed.items).slice(0, 6),
    homepageNewest: feed.items.slice(0, 6),
    recommend: { items: hot.length ? hot : feed.items, nextPage: null },
    newest: { items: feed.items, nextPage: feed.nextPage },
  };
}

async function category(slug, page) {
  const value = String(slug || '');
  if (!value || value === 'new' || value === 'latest') return list(`/api/videos?page=${page}&size=24`, page, 24, 'AI 短剧');
  if (value === 'hot') {
    const data = await edge('/api/ranks/hot').catch(() => null);
    const items = data ? rowsOf(data).map((row) => card(row, row.cate_name)).filter((item) => item.id && item.title) : [];
    return { items, nextPage: null };
  }
  const meta = AI_CATEGORIES.find((item) => item.id === value);
  return list(`/api/videos/category/${encodeURIComponent(value)}?sort=hot&page=${page}&size=24`, page, 24, meta ? meta.name : '');
}

async function search(keyword, page) {
  return list(`/api/search?q=${encodeURIComponent(keyword)}&page=${page}&size=20`, page, 20, 'AI 短剧');
}

async function detail(id) {
  const key = String(id || '').replace(/^\/+|\/+$/g, '').replace(/^detail\//, '');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(key)) throw new Error('无效剧集');
  const data = await edge(`/api/videos/${encodeURIComponent(key)}`);
  const breadcrumb = Array.isArray(data.breadcrumb) && data.breadcrumb[0] ? data.breadcrumb[0].name : '';
  const info = card(data, breadcrumb);
  if (!info.id) throw new Error('黄果 AI 没有返回这部剧');
  const episodes = [];
  for (const row of Array.isArray(data.episodes) ? data.episodes : []) {
    const number = Number(row && row.ep_num) || 0;
    if (!number) continue;
    episodes.push({ number, title: String((row && row.title) || `第 ${number} 集`) });
  }
  if (!episodes.length) episodes.push({ number: 1, title: info.title });
  episodes.sort((a, b) => a.number - b.number);
  return {
    id: info.id,
    title: info.title,
    cover: info.cover,
    description: info.description,
    score: info.score,
    tags: info.tags,
    episodeLabel: `共 ${episodes.length} 集`,
    episodes: episodes.map((episode) => ({ number: episode.number, url: `${state.base}/video/${info.id}/ep-${episode.number}/` })),
    _episodes: episodes,
  };
}

async function play(id, number) {
  const info = await detail(id);
  const hit = info._episodes.find((item) => item.number === number);
  if (!hit) throw new Error('这一集不存在');
  const data = await edge(`/api/videos/${encodeURIComponent(info.id)}/play?ep=${number}&page_texts=0`);
  const url = absolute(data.video_url || data.video_url_hevc);
  if (!/^https?:\/\//i.test(url)) throw new Error('黄果 AI 没有给出播放地址');
  return {
    url,
    referer: `${state.base}/video/${info.id}/`,
    title: info.title,
    cover: info.cover,
  };
}

module.exports = {
  id: 'huangguoai',
  name: '黄果 AI',
  description: 'AI 短剧 · 漫剧 · 换脸 · 热门榜',
  content: 'AI 短剧',
  categories,
  home,
  category,
  search,
  detail,
  episode: play,
  // 播放地址带短时签名，过期由网关回调重签
  refresh: play,
};
