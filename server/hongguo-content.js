'use strict';

/** 与 Android ContentRepository/HongguoGenres/ComicRank 对齐的红果公开内容解析。 */
const SITE = 'https://hongguoduanju.com';

function extractRouterData(html) {
  const marker = html.indexOf('_ROUTER_DATA');
  if (marker < 0) throw new Error('页面没有内容数据');
  const first = html.indexOf('{', marker);
  if (first < 0) throw new Error('页面数据格式错误');
  let depth = 0, quoted = false, escaped = false;
  for (let i = first; i < html.length; i++) {
    const ch = html[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return JSON.parse(html.substring(first, i + 1));
    }
  }
  throw new Error('页面数据不完整');
}

function cleanUrl(value) {
  return String(value || '').replace(/\\\//g, '/').replace(/\\u002F/gi, '/')
    .replace(/\\u0026/gi, '&').replace(/&amp;/g, '&');
}

function text(value) { return String(value == null ? '' : value).trim(); }
function pageNumber(value) {
  const page = Number(value == null || value === '' ? 1 : value);
  if (!Number.isInteger(page) || page < 1 || page > 100) {
    const error = new Error('页码必须是 1–100 的整数'); error.statusCode = 400; throw error;
  }
  return page;
}

function normalizeType(value) {
  const type = text(value || 'short').toLowerCase();
  if (type !== 'short' && type !== 'comic') {
    const error = new Error('type 必须是 short 或 comic'); error.statusCode = 400; throw error;
  }
  return type;
}

function normalizeQuery(query) {
  let type = query.type;
  let slug = text(query.slug);
  // 旧 WebUI 的 tab=slug 仅表示短剧题材；tab=1 是短剧精选。
  if (!slug && query.tab && String(query.tab) !== '1') { type = 'short'; slug = text(query.tab); }
  const namespaced = slug.match(/^(short|comic):(.+)$/);
  if (namespaced) { type = namespaced[1]; slug = namespaced[2]; }
  type = normalizeType(type);
  if (slug && !/^[a-z0-9-]{1,80}$/.test(slug)) {
    const error = new Error('无效题材 slug'); error.statusCode = 400; throw error;
  }
  return { type, slug, page: pageNumber(query.page) };
}

function categoryUrl(query) {
  const { type, slug, page } = normalizeQuery(query);
  let url;
  if (slug) {
    const route = type === 'comic' ? 'comic-drama' : 'real-drama';
    url = `${SITE}/category/${route}/${encodeURIComponent(slug)}`;
  } else if (type === 'comic') {
    url = `${SITE}/rank/hot-comic-drama`;
  } else {
    url = `${SITE}/category?tab=1&sort_type=1`;
  }
  if (type === 'comic' && !slug) return `${url}?page=${page}`;
  if (page > 1) return `${url}${url.includes('?') ? '&' : '?'}page=${page}`;
  return url;
}

function tagTextList(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 5).map(item => typeof item === 'object' ? text(item && item.name) : text(item)).filter(Boolean);
}

function parseSeriesCard(input) {
  const o = input && input.video_data && typeof input.video_data === 'object' ? input.video_data : (input || {});
  const info = o.series_episode_info || {};
  const count = Number(o.episode_cnt != null ? o.episode_cnt : info.episode_cnt) || 0;
  const tags = tagTextList(o.tags || o.category_list);
  return {
    id: text(o.series_id || o.id), title: text(o.series_name || o.series_title || o.title || (input && input.name)),
    cover: cleanUrl(o.series_cover || o.cover || o.horizontal_cover || o.vertical_cover),
    description: text(o.series_intro || o.description),
    badge: text(o.episode_right_text) || (count > 0 ? `全 ${count} 集` : text(o.badge)),
    score: text(o.score || o.heatText), tags,
  };
}

function validItems(rows, mapper) {
  const seen = new Set(), items = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const item = mapper(row);
    if (!/^\d{1,30}$/.test(item.id) || !item.title || seen.has(item.id)) continue;
    seen.add(item.id); items.push(item);
  }
  return items;
}

function routerSection(html) {
  const loader = extractRouterData(html).loaderData || {};
  const preferred = loader.category_page || loader.category_$;
  if (preferred && Array.isArray(preferred.recommendList)) return preferred;
  for (const section of Object.values(loader)) {
    if (section && Array.isArray(section.recommendList)) return section;
    if (section && section.categoryData && Array.isArray(section.categoryData.recommendList)) return section.categoryData;
  }
  throw new Error('页面数据结构已变化');
}

function parseTags(section, type) {
  const seen = new Set(), items = [];
  for (const row of section.selectorList || []) {
    if (String(row.row_id) !== '1') continue;
    for (const entry of row.items || []) {
      const slug = text(entry.selector_item_id), name = text(entry.show_name);
      const ids = entry.category_json_ids;
      if (!/^[a-z0-9-]{1,80}$/.test(slug) || !name || !Array.isArray(ids) || !ids.length || seen.has(slug)) continue;
      seen.add(slug); items.push({ slug: `${type}:${slug}`, name, group: type });
    }
  }
  return items;
}

function parseNext(section, page, count) {
  const pagination = section.pagination || {};
  const actual = Number(pagination.pageNum == null ? page : pagination.pageNum);
  if (actual !== page) throw new Error('分类分页未正确返回');
  const last = Math.min(100, Number(pagination.totalPages == null ? page : pagination.totalPages) || page);
  return count > 0 && page < last ? page + 1 : null;
}

function parseCategory(html, query) {
  const normalized = normalizeQuery(query);
  if (normalized.type === 'comic' && !normalized.slug) return parseComicRank(html, normalized);
  const section = routerSection(html);
  const items = validItems(section.recommendList, parseSeriesCard);
  return {
    items, type: normalized.type, slug: normalized.slug, page: normalized.page,
    nextPage: parseNext(section, normalized.page, items.length),
    tabs: parseTags(section, normalized.type),
  };
}

function decodeAttribute(value) {
  return String(value || '').replace(/&quot;/g, '"').replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}
function attr(tag, name) {
  const match = tag.match(new RegExp('\\s' + name + '="([^"]*)"', 'i')) || tag.match(new RegExp("\\s" + name + "='([^']*)'", 'i'));
  return match ? decodeAttribute(match[1]) : '';
}
function decodeJson(value) { return typeof value === 'string' ? JSON.parse(value) : value; }

function parseComicRank(html, normalized) {
  const { page } = normalized;
  const scripts = html.match(/<script\b[^>]*>/gi) || [];
  for (const tag of scripts) {
    const name = attr(tag, 'data-fn-name');
    if (name !== 'r' && name !== 'mergeLoaderData') continue;
    let args;
    try { args = JSON.parse(attr(tag, 'data-fn-args')); } catch { continue; }
    if (!Array.isArray(args) || args[0] !== 'rank_hot-comic-drama/page') continue;
    let raw;
    if (name === 'r' && args[1] === 'content') raw = args[2];
    else if (name === 'mergeLoaderData') {
      const cell = (args[1] || []).find(item => item && item.key === 'content' && item.routerDataFnName === 'p');
      raw = cell && cell.routerDataFnArgs && cell.routerDataFnArgs[0];
    }
    let payload;
    try { payload = decodeJson(raw); } catch { continue; }
    if (!payload || typeof payload !== 'object') continue;
    if (payload.isSuccess === false) throw new Error('漫剧榜单暂不可用');
    if (!Array.isArray(payload.rankList)) throw new Error('漫剧榜单格式已变化');
    const pagination = payload.pagination || {};
    const totalPages = Number(pagination.totalPages) || 0;
    if (totalPages < 1 || Number(pagination.pageNum == null ? page : pagination.pageNum) !== page) throw new Error('漫剧分页信息异常');
    const items = validItems(payload.rankList, row => {
      const count = Number(row.episodeCount != null ? row.episodeCount : (row.episodeVids || []).length) || 0;
      return {
        id: text(row.seriesId || row.id), title: text(row.title), cover: cleanUrl(row.cover),
        description: text(row.description), badge: count > 0 ? `全 ${count} 集` : text(row.heatText),
        score: text(row.heatText), tags: tagTextList(row.tags), rank: Number(row.rank) || null,
      };
    });
    return { items, type: 'comic', slug: '', page, nextPage: items.length && page < Math.min(totalPages, 100) ? page + 1 : null, tabs: [] };
  }
  // 上游已直接渲染卡片时，至少不能悄悄退回短剧接口。
  const route = (((extractRouterData(html).loaderData || {})['rank_hot-comic-drama/page']) || {});
  if (text(route.rankKey) !== 'comic' || Number(route.pageNum) !== page) throw new Error('页面没有漫剧榜单数据');
  throw new Error('漫剧榜单延期数据尚未解析，请重试');
}

function createHongguoContent(fetchText) {
  async function category(query) {
    const normalized = normalizeQuery(query);
    const html = await fetchText(categoryUrl(normalized), 10000);
    return parseCategory(html, normalized);
  }
  async function home() {
    const [recommend, newest] = await Promise.all([category({ type: 'short', page: 1 }), category({ type: 'comic', page: 1 })]);
    return {
      items: recommend.items, slides: recommend.items.slice(0, 5),
      homepageRecommend: recommend.items, homepageNewest: newest.items,
      recommend, newest,
    };
  }
  async function tags() {
    const [shortHtml, comicHtml] = await Promise.all([
      fetchText(`${SITE}/category/real-drama`, 10000),
      fetchText(`${SITE}/category/comic-drama`, 10000),
    ]);
    const items = [...parseTags(routerSection(shortHtml), 'short'), ...parseTags(routerSection(comicHtml), 'comic')];
    if (!items.length) throw new Error('暂无可用大类');
    return { items };
  }
  return { category, home, tags };
}

module.exports = { SITE, extractRouterData, parseSeriesCard, parseCategory, parseComicRank, parseTags, normalizeQuery, categoryUrl, createHongguoContent };
