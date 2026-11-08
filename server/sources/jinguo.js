'use strict';
/**
 * 禁果：和黄果旧版同一套 App 协议（同一个 interfaceKey），
 * 差别只在接口域名（两条线路轮换）、UA 里的包名，以及多了「精选 / 最新」两个推荐位。
 */

const crypto = require('crypto');
const { createLegacyClient, FALLBACK } = require('./legacy-core');

const BASES = ['https://d1wyuxwdrlykj1.cloudfront.net', 'https://hghts.rlkfus.cn'];
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1';

const CHOOSE = 'choose';
const NEW = 'new';
const TAB = 'tab:';

const client = createLegacyClient({
  key: 'jinguo',
  name: '禁果',
  bases: BASES,
  // 禁果的 API 不带 Origin / Referer，播放时才带接口域自己
  front: '',
  ua: UA,
  // 密钥写死在客户端里，没有可抓的官网脚本
  fixedProtocol: FALLBACK,
  userAgent: (device) => `BuildID=com.hgaidj.ozThree;SysType=android;DevID=${device};Ver=1.0.8;DevType=Android;DeviceBrand=google;DeviceModel=Pixel;SystemName=Android;SystemVersion=14;Terminal=1;IsH5=1;Sid=00000000000000000000000000000`,
  // 禁果设备号：16 位十六进制 + 13 位毫秒时间戳
  newDevice: () => crypto.randomBytes(8).toString('hex').toUpperCase() + Date.now(),
  playReferer: (base) => `${base}/`,
});

const api = client.api;

function coverUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.startsWith('//')) return `https:${raw}`;
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://zzzznnn.lkkwip.cn/${raw.replace(/^\/+/, '')}`;
}

function card(row, tabName) {
  const episodes = Number(row.totalEpisode || row.updateEpisode) || 0;
  const tags = [];
  for (const tag of Array.isArray(row.tagNames) ? row.tagNames : []) {
    if (tag && tags.length < 3) tags.push(String(tag).slice(0, 12));
  }
  return {
    id: String(row.id || ''),
    title: String(row.title || '').slice(0, 200),
    cover: coverUrl(row.cover || row.horizontalCover),
    description: String(row.summary || '').slice(0, 4000),
    score: Number(row.scoreExtra) > 0 ? Number(row.scoreExtra).toFixed(1) : '',
    episodeLabel: episodes ? `更新至 ${episodes} 集` : '',
    category: String(row.categoryName || tabName || '短剧').slice(0, 20),
    tags: tags.slice(0, 4),
    status: '',
  };
}

async function tabs() {
  const data = await api('/api/app/playlet-tab/all');
  const list = Array.isArray(data) ? data : data.list || [];
  const items = list
    .filter((tab) => tab && tab.id && tab.name && /^[A-Za-z0-9]{1,64}$/.test(String(tab.id)))
    .map((tab) => ({ id: String(tab.id), name: String(tab.name).trim().slice(0, 24) }));
  return items;
}

function pageOf(data, tabName) {
  const rows = Array.isArray(data.list) ? data.list : Array.isArray(data) ? data : [];
  const items = rows.map((row) => card(row, tabName)).filter((item) => item.id && item.title);
  return { items, nextPage: rows.length >= 20 ? 1 : null };
}

async function listPage(path, page, tabName) {
  const data = await api(path, { pageNumber: page, pageSize: 20 });
  const result = pageOf(data, tabName);
  return { items: result.items, nextPage: result.items.length >= 20 ? page + 1 : null };
}

async function categories() {
  const list = await tabs();
  return [{ id: CHOOSE, name: '精选' }, { id: NEW, name: '最新' }, ...list];
}

async function tabPage(tabId, page) {
  return listPage(`/api/app/playlet/home/tab/${encodeURIComponent(tabId)}`, page);
}

async function home() {
  const choose = await listPage('/api/app/playlet-recommend/home/choose', 1).catch(() => ({ items: [], nextPage: null }));
  const fresh = await listPage('/api/app/playlet-recommend/home/new', 1).catch(() => ({ items: [], nextPage: null }));
  const items = choose.items.length ? choose.items : fresh.items;
  return {
    featured: items.slice(0, 5).map((item) => ({ ...item, description: item.description || item.title })),
    items,
    homepageRecommend: choose.items.slice(0, 6),
    homepageNewest: fresh.items.slice(0, 6),
    recommend: choose,
    newest: fresh,
  };
}

async function category(slug, page) {
  const value = String(slug || '');
  if (value === CHOOSE) return listPage('/api/app/playlet-recommend/home/choose', page);
  if (value === NEW || value === 'new' || value === 'latest') return listPage('/api/app/playlet-recommend/home/new', page);
  if (value.startsWith(TAB)) return tabPage(value.slice(TAB.length), page);
  if (value) return tabPage(value, page);
  const list = await tabs();
  if (!list.length) return { items: [], nextPage: null };
  return tabPage(list[0].id, page);
}

async function search(keyword, page) {
  const data = await api('/api/app/playlet/keyword/search', { keyword, pageNumber: page, pageSize: 20 });
  const result = pageOf(data);
  return { items: result.items, nextPage: result.items.length >= 20 ? page + 1 : null };
}

async function detail(id) {
  const value = String(id || '');
  if (!/^[A-Za-z0-9]{1,64}$/.test(value)) throw new Error('无效剧集');
  const data = await api(`/api/app/playlet/detail/${encodeURIComponent(value)}`);
  const info = card(data);
  if (!info.title) throw new Error('禁果没有返回这部剧');
  let rows = Array.isArray(data.chapters) ? data.chapters : [];
  if (!rows.length) {
    const extra = await api(`/api/app/playlet-chapter/list/${encodeURIComponent(value)}`);
    rows = Array.isArray(extra) ? extra : extra.list || [];
  }
  const episodes = [];
  rows.forEach((row, index) => {
    if (!row) return;
    const number = Number(row.currentEpisode) || index + 1;
    const locked = !row.videoUrl || row.canPlay === false;
    episodes.push({
      number,
      episodeId: String(row.id || number),
      title: String(row.title || `第 ${number} 集`),
      videoUrl: String(row.videoUrl || ''),
      locked,
    });
  });
  episodes.sort((a, b) => a.number - b.number);
  if (!episodes.length) throw new Error('这一部没有可播放的分集');
  return {
    id: value,
    title: info.title,
    cover: info.cover,
    description: info.description,
    score: info.score,
    tags: info.tags,
    episodeLabel: `共 ${episodes.length} 集`,
    episodes: episodes.map((episode) => ({
      number: episode.number,
      url: '',
      locked: episode.locked,
      label: episode.locked ? '需解锁' : '',
    })),
    _episodes: episodes,
  };
}

/** videoUrl 是相对路径，逐段编码，别把斜杠也编进去 */
function encodePath(value) {
  return String(value).replace(/^\/+|\/+$/g, '').split('/').filter(Boolean)
    .map((segment) => encodeURIComponent(segment)).join('/');
}

async function play(id, number) {
  const info = await detail(id);
  const hit = info._episodes.find((item) => item.number === number);
  if (!hit) throw new Error('这一集不存在');
  if (!hit.videoUrl) throw new Error('这一集需要会员或金币解锁后才能播放');
  const target = await client.playUrl(encodePath(hit.videoUrl));
  return {
    url: target.url,
    referer: target.referer,
    title: info.title,
    cover: info.cover,
  };
}

module.exports = {
  id: 'jinguo',
  name: '禁果',
  description: '精选 · 最新 · 分类短剧 · 在线搜索',
  content: '短剧',
  categories,
  home,
  category,
  search,
  detail,
  episode: play,
};
