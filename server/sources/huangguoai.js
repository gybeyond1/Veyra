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

const { requestCurl, cached } = require('./util');

/*
 * 2026-11 换站：老镜像（thu.lbvrhyir.cc / pku.xxbgwypx.cc / *.ediayikma.cc /
 * 带日期的 *.gitiecgad.cc）已经全部失效，实测 0624.gitiecgad.cc 直接不解析。
 * 现在活着的两条是同一套站的两个门牌：huangguoai.io 与 huangguodrama.io
 * （详情页里 37 处引用后者，说明它才是主站域名，huangguoai.io 是它的一面镜子）。
 * 站点整批换域名是常态，所以按「并行探活、谁快用谁」处理，不要串行试。
 */
const MIRRORS = [
  'https://huangguoai.io',
  'https://huangguodrama.io',
];

/*
 * 只留站点真正还认的两个分类：/api/videos/category/{ai-duanju|ai-manju}。
 * 老代码里的 ai-huanlian / ai-mogai 现在一个超时、一个返回 410「分类不存在」，
 * 首页导航里的 /original/ /topics/ 也只是页面，对应 API 一样报「分类不存在」。
 * 分类改版比域名还勤，所以宁可少列，不要列一堆点了必空的。
 */
const AI_CATEGORIES = [
  { id: 'ai-duanju', name: 'AI 短剧' },
  { id: 'ai-manju', name: 'AI 漫剧' },
];

const state = { base: '', probing: null, dead: new Set() };

/*
 * 2026-11 站点把 /api/edge/request 这个统一入口关了（POST 过去连不上），
 * 但站点自己的 REST 接口全部还能直接访问：GET /api/videos/:id 给分集，
 * POST /api/videos/:id/episodes/:ep/playback 给播放地址。
 * 所以这里直接打 REST，不再绕边缘入口 —— 少一跳，也少一个会消失的中间层。
 *
 * 必须走 curl：这个站按 TLS 指纹（JA3）风控，Node 原生 https 在不少家用宽带出口上
 * 不会报错，而是挂到超时。同一台机器用 curl 打同一个 URL 一秒就回 —— 这就是
 * 「手机/浏览器能看，后端体检全红」的根因。requestCurl 每次都起 curl 进程，
 * 这里只有首页/详情/播放三个元数据请求，开销可以接受。
 */
const SITE_UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36';

async function jsonAt(base, path, options) {
  const opt = options || {};
  const method = opt.method || 'GET';
  const res = await requestCurl(`${base}${path}`, {
    method,
    headers: {
      'User-Agent': SITE_UA,
      Accept: 'application/json',
      Referer: `${base}/`,
      Origin: base,
      ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
    },
    body: method === 'POST' ? JSON.stringify(opt.body || {}) : undefined,
    timeout: opt.timeout || 20000,
    maxBytes: 8 << 20,
  });
  if (res.status < 200 || res.status >= 300) throw new Error(`站点返回 ${res.status}`);
  let envelope;
  try {
    envelope = JSON.parse(res.text());
  } catch {
    throw new Error('站点返回格式异常');
  }
  if (String(envelope.status) !== '1') throw new Error(String(envelope.msg || '接口没有返回数据').slice(0, 120));
  return envelope.data;
}

/**
 * 镜像探活：并行发一轮，取最快回话的那条钉住。
 * 主域名常年打不通，串行试会把首屏拖到十几秒。
 * 超时给到 12 秒：curl 冷启动 + 跨境 RTT 都不便宜，8 秒会把能通的线路误判成不通。
 */
function ensureBase() {
  if (state.base) return Promise.resolve(state.base);
  if (state.probing) return state.probing;
  let pool = MIRRORS.filter((base) => !state.dead.has(base));
  if (!pool.length) {
    // 全都标死过一轮：清空重来，别把站点恢复后的第一次请求也拒了
    state.dead.clear();
    pool = MIRRORS.slice();
  }
  state.probing = Promise.any(
    pool.map((base) => jsonAt(base, '/api/videos?page=1&size=1', { timeout: 12000 }).then(() => base))
  )
    .then((base) => {
      state.base = base;
      return base;
    })
    .catch((error) => {
      const reasons = Array.isArray(error && error.errors)
        ? error.errors.map((item) => (item && item.message) || '无响应').join('；')
        : (error && error.message) || '无响应';
      throw new Error(`黄果线路都不通（${String(reasons).slice(0, 160)}）`);
    })
    .finally(() => {
      state.probing = null;
    });
  return state.probing;
}

/** 请求一次；镜像中途挂掉就换另一条门牌再来一遍 */
async function edge(path, options) {
  let lastError = null;
  for (let round = 0; round < 2; round += 1) {
    const base = await ensureBase();
    try {
      return await jsonAt(base, path, options);
    } catch (error) {
      lastError = error;
      state.dead.add(base);
      state.base = '';
    }
  }
  throw new Error(`黄果线路暂不可用（${lastError ? lastError.message : '镜像无响应'}）`);
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
    // 排行榜返回的是 video_id，列表接口才是 id —— 少认一个字段，热门榜就整页空白
    id: String(row.id || row.video_id || ''),
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
  /*
   * 首页两个请求都允许失败（排行榜挂了不该让整页白掉），
   * 但两条都空时必须把真实原因抛上去 —— 以前这里 catch 成空数组，
   * 体检只显示「没有条目」，看的人根本不知道是超时、被风控还是站点改版。
   */
  let feedError = null;
  let rankError = null;
  const [feed, ranks] = await Promise.all([
    list('/api/videos?page=1&size=20', 1, 20, 'AI 短剧').catch((error) => {
      feedError = error;
      return { items: [], nextPage: null };
    }),
    edge('/api/ranks/hot').catch((error) => {
      rankError = error;
      return null;
    }),
  ]);
  const hot = ranks ? rowsOf(ranks).map((row) => card(row, row.cate_name)).filter((item) => item.id && item.title) : [];
  if (!feed.items.length && !hot.length) {
    throw new Error(`黄果 AI 取不到内容：${(feedError || rankError || {}).message || '站点没有返回条目'}`);
  }
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
    // 排行榜只有一页；这里失败要报出来，不能像以前那样 catch 成空数组糊过去
    const data = await edge('/api/ranks/hot');
    const items = rowsOf(data).map((row) => card(row, row.cate_name)).filter((item) => item.id && item.title);
    return { items, nextPage: null };
  }
  const meta = AI_CATEGORIES.find((item) => item.id === value);
  return list(`/api/videos/category/${encodeURIComponent(value)}?sort=hot&page=${page}&size=24`, page, 24, meta ? meta.name : '');
}

async function search(keyword, page) {
  return list(`/api/search?q=${encodeURIComponent(keyword)}&page=${page}&size=20`, page, 20, 'AI 短剧');
}

async function fetchDetail(key) {
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

/*
 * 缓存 3 分钟：play() 也要先拿分集，而每次 curl 都是几百毫秒起，
 * 不缓存就等于点一集打两遍详情。站点分集变动以分钟计，3 分钟足够。
 */
async function detail(id) {
  const key = String(id || '').replace(/^\/+|\/+$/g, '').replace(/^detail\//, '');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(key)) throw new Error('无效剧集');
  return cached(`huangguoai:detail:${key}`, 3 * 60 * 1000, () => fetchDetail(key));
}

async function play(id, number) {
  const info = await detail(id);
  const hit = info._episodes.find((item) => item.number === number);
  if (!hit) throw new Error('这一集不存在');
  // 2026-11 起播放地址只从 playback 接口下发（旧的 GET /play 还在，但 video_url 恒为空）
  const data = await edge(`/api/videos/${encodeURIComponent(info.id)}/episodes/${number}/playback`, { method: 'POST', body: {} });
  const streams = data && data.streams ? data.streams : {};
  const url = absolute(streams.main || streams.hevc || data.video_url || data.video_url_hevc);
  if (!/^https?:\/\//i.test(url)) throw new Error('黄果没有给出播放地址');
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
