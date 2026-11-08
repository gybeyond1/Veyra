'use strict';
/**
 * 黄果旧版（cloudfront 上那套 App 接口）
 *
 * 协议在 legacy-core 里，这里只负责：域名、UA、设备号格式，以及把接口数据
 * 映射成 Veyra 的卡片结构。
 */

const crypto = require('crypto');
const { createLegacyClient } = require('./legacy-core');

const BASE = 'https://dr6skssi3nxbk.cloudfront.net';
const FRONT = 'https://d2pypzndaqisk.cloudfront.net';
const CDN = 'https://sjljsla.lkkwip.cn';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1';

const client = createLegacyClient({
  key: 'cloudfront',
  name: '黄果旧版',
  bases: [BASE],
  front: FRONT,
  cdn: CDN,
  ua: UA,
  // 黄果旧版设备号是 8 位十六进制 + 毫秒时间戳（iOS 那套）
  userAgent: (device) => `BuildID=com.abc.Butterfly;SysType=ios;DevID=${device};Ver=1.0.0;DevType=iPhone;DeviceBrand=APPLE;DeviceModel=iPhone;SystemName=iOS;SystemVersion=18.7;Terminal=1;IsH5=1;Sid=00000000000000000000000000000000`,
  newDevice: () => crypto.randomBytes(4).toString('hex').toUpperCase() + Date.now(),
});

const api = client.api;

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
  const data = await api('/api/app/playlet-tab/all');
  const list = Array.isArray(data) ? data : data.list || [];
  const items = list.filter((tab) => tab && tab.id && tab.name).map((tab) => ({ id: String(tab.id), name: String(tab.name).slice(0, 24) }));
  if (!items.length) throw new Error('黄果旧版没有返回可用分类');
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
  const target = await client.playUrl(hit.videoUrl);
  return {
    url: target.url,
    referer: target.referer,
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
