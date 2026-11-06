import crypto from 'node:crypto';
import * as cheerio from 'cheerio';
import type { HomePayload, SeriesCard, SeriesDetail } from '../shared/types';
import { fetchBinary, fetchText } from './http';
import { readSettings } from './store';
import { session } from './session';

/**
 * 私密源（黄果）网页解析。
 *
 * 规则和 APK 里的 site-default.json 一致，只是用 cheerio 重写了一遍：
 * 数据都在 `.hg-drama-card` 的 data-* 属性与详情页 #videoInitialData 的 JSON 里，
 * 不需要登录任何接口。封面是 AES-128-CBC(NoPadding) 加密的，解密后还要补一个
 * 被 CDN 改坏的 PNG 头字节（0x14 → 0x1a），否则整张图显示不出来。
 */

const SITES = ['https://m.pqhybuxo.cc', 'https://www.pqhybuxo.cc', 'https://thu.pqhybuxo.cc'];
const REFERER = 'https://m.pqhybuxo.cc';
const COVER_KEY = Buffer.from('f5d965df75336270', 'utf8');
const COVER_IV = Buffer.from('97b60374abc2fbe1', 'utf8');

const UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36';

function text(value: unknown): string {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function looksLikeChallenge(html: string): boolean {
  return /Just a moment|challenge-platform|cf-browser-verification|Attention Required/i.test(html);
}

async function load(pathname: string, referer = '/'): Promise<{ html: string; site: string }> {
  let last: Error | null = null;
  // 通道是显式选择，不做自动兜底：直连/代理模式下失败就报错，避免用户以为在走代理其实走了后端
  const mode = Number(readSettings().proxyMode) || 3;

  if (mode !== 3) {
    for (const site of SITES) {
      try {
        const html = await fetchText(site + pathname, 15000, { Referer: `${REFERER}${referer}`, 'User-Agent': UA });
        if (html && html.length > 200 && !looksLikeChallenge(html)) return { html, site };
        throw new Error(html && looksLikeChallenge(html) ? '源站风控拦截' : '页面内容为空');
      } catch (error) {
        last = error as Error;
      }
    }
    throw new Error('私密内容加载失败：' + (last?.message || '网络异常'));
  }

  // 走后端转发：由服务器代取（服务器侧可配代理，且已处理源站白名单）
  const current = session();
  if (current?.server) {
    for (const site of SITES) {
      try {
        const target = `${site}${pathname}`;
        const html = await fetchText(
          `${current.server}/api/huangguo-proxy?url=${encodeURIComponent(target)}`,
          20000,
          { Referer: `${REFERER}${referer}`, 'User-Agent': UA },
        );
        if (html && html.length > 200 && !looksLikeChallenge(html)) return { html, site };
        throw new Error('后端通道返回的内容不可用');
      } catch (error) {
        last = error as Error;
      }
    }
  }
  throw new Error('私密内容加载失败：' + (last?.message || '网络异常'));
}

/** 详情页把初始数据塞在 <script id="videoInitialData"> 里，抓出来按 JSON 解析。 */
function initialData(html: string): Record<string, unknown> {
  const match =
    html.match(/<script[^>]*id="videoInitialData"[^>]*>([\s\S]*?)<\/script>/) ||
    html.match(/videoInitialData["']?\s*[:=]\s*(\{[\s\S]*?\})\s*;/);
  if (!match) return {};
  try {
    return JSON.parse(match[1].replace(/^[\s\S]*?(?=\{)/, '')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function decodeCover(buffer: Buffer): Buffer | null {
  let data = buffer;
  const isImage = (value: Buffer) =>
    value.length > 16 &&
    ((value[0] === 0xff && value[1] === 0xd8) ||
      (value[0] === 0x89 && value[1] === 0x50 && value[2] === 0x4e && value[3] === 0x47) ||
      (value[0] === 0x47 && value[1] === 0x49 && value[2] === 0x46));

  if (!isImage(data)) {
    try {
      const decipher = crypto.createDecipheriv('aes-128-cbc', COVER_KEY, COVER_IV);
      decipher.setAutoPadding(false);
      data = Buffer.concat([decipher.update(data), decipher.final()]);
    } catch {
      return null;
    }
  }
  // CDN 会改坏 PNG 的第 7 个字节；签名对得上才修，避免把正常缓存改两遍
  if (
    data.length > 12 &&
    data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47 &&
    data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x14
  ) {
    data[6] = 0x1a;
  }
  return isImage(data) ? data : null;
}

const coverCache = new Map<string, string>();

async function coverData(raw: string): Promise<string> {
  const url = text(raw);
  if (!url) return '';
  const cached = coverCache.get(url);
  if (cached) return cached;
  try {
    let buffer: Buffer;
    try {
      buffer = await fetchBinary(url, 12000, { Referer: `${REFERER}/`, 'User-Agent': UA });
    } catch (error) {
      // 封面 CDN 直连失败时同样借后端通道（后端会把加密封面解成真图）
      const current = session();
      if (!current?.server) throw error;
      buffer = await fetchBinary(
        `${current.server}/api/huangguo-proxy?url=${encodeURIComponent(url)}`,
        20000,
        { Referer: `${REFERER}/`, 'User-Agent': UA },
      );
    }
    const image = decodeCover(buffer);
    if (!image) return '';
    const mime = image[0] === 0xff ? 'image/jpeg' : image[0] === 0x89 ? 'image/png' : 'image/gif';
    const value = `data:${mime};base64,${image.toString('base64')}`;
    if (coverCache.size > 400) coverCache.clear();
    coverCache.set(url, value);
    return value;
  } catch {
    return '';
  }
}

function cards($: cheerio.CheerioAPI): SeriesCard[] {
  const items: SeriesCard[] = [];
  $('.hg-drama-card[data-track-id]').each((_, element) => {
    const node = $(element);
    const id = text(node.attr('data-track-id'));
    if (!/^\d+$/.test(id)) return;
    const img = node.find('.hg-drama-card__cover img').first();
    const title = text(node.attr('data-track-title')) || text(node.find('.hg-drama-card__title').text());
    if (!title) return;
    const epLabel = text(node.find('.hg-drama-card__episode').text());
    items.push({
      id,
      title,
      cover: text(img.attr('data-src')) || text(img.attr('src')),
      description: text(node.find('.hg-drama-card__desc').text()),
      badge: epLabel,
      episodeCount: Number((epLabel.match(/(\d+)/) || [])[1]) || 0,
      score: text(node.find('.hg-drama-card__score').text()),
      tags: node
        .find('.hg-drama-card__tags .hg-tag')
        .map((__, tag) => text($(tag).text()))
        .get()
        .filter(Boolean)
        .slice(0, 5),
    });
  });
  return items;
}

async function withCovers(items: SeriesCard[]): Promise<SeriesCard[]> {
  return Promise.all(items.map(async (item) => ({ ...item, cover: (await coverData(item.cover)) || item.cover })));
}

export async function home(): Promise<HomePayload> {
  const { html, site } = await load('/');
  const $ = cheerio.load(html);
  const all = cards($);

  const sections: { title: string; items: SeriesCard[] }[] = [];
  $('main section.hg-section').each((_, element) => {
    const node = $(element);
    const title = text(node.find('h2').first().text());
    const items = cards(cheerio.load(node.html() || ''));
    if (title && items.length) sections.push({ title, items });
  });

  // hero 区有时是 JSON 属性，有时是普通轮播；兜底用首页前几张卡片
  const slides = all.slice(0, 8);
  const recommend = sections.find((section) => /推荐|精选/.test(section.title))?.items || sections[0]?.items || all;
  const newest = sections.find((section) => /上新|最新/.test(section.title))?.items || sections[1]?.items || [];

  return {
    slides: await withCovers(dedupe(slides)),
    homepageRecommend: await withCovers(dedupe(recommend)),
    homepageNewest: await withCovers(dedupe(newest)),
  };
}

function dedupe(items: SeriesCard[]): SeriesCard[] {
  const seen = new Set<string>();
  return items.filter((item) => (seen.has(item.id) ? false : (seen.add(item.id), true)));
}

export async function category(slug: string, page: number): Promise<{ items: SeriesCard[]; title: string; hasMore: boolean }> {
  const safe = text(slug).replace(/[^a-z0-9-]/gi, '') || 'ai-duanju';
  const path = page > 1 ? `/${safe}/${page}/` : `/${safe}/`;
  const { html } = await load(path, path);
  const $ = cheerio.load(html);
  const items = dedupe(cards($));
  return { items: await withCovers(items), title: text($('h1').first().text()), hasMore: items.length >= 20 };
}

export async function search(keyword: string): Promise<SeriesCard[]> {
  const query = text(keyword);
  if (!query) return [];
  const path = `/search/?keyword=${encodeURIComponent(query)}`;
  const { html } = await load(path, path);
  return withCovers(dedupe(cards(cheerio.load(html))));
}

export async function detail(id: string): Promise<SeriesDetail> {
  if (!/^\d+$/.test(id)) throw new Error('无效剧集');
  const path = `/video/${id}/`;
  const { html } = await load(path, path);
  const $ = cheerio.load(html);
  const data = initialData(html);

  const episodes: number[] = [];
  const seen = new Set<number>();
  $(`a[href*="/video/${id}"]`).each((_, element) => {
    const href = text($(element).attr('href'));
    const match = href.match(new RegExp(`/video/${id}/(?:ep-(\\d+)/)?$`));
    if (!match) return;
    const number = match[1] ? Number(match[1]) : 1;
    if (number >= 1 && !seen.has(number)) {
      seen.add(number);
      episodes.push(number);
    }
  });
  // 没有选集链接（AI 换脸等单页作品）：用 epPlaySrcs 的键当集数
  const srcs = (data.epPlaySrcs || {}) as Record<string, string>;
  if (!episodes.length) {
    Object.keys(srcs).forEach((key) => {
      const number = Number(key);
      if (number >= 1) episodes.push(number);
    });
  }
  episodes.sort((a, b) => a - b);
  if (!episodes.length) throw new Error('没有找到选集');

  const tags = Array.isArray(data.tags) ? data.tags.map((tag) => text(tag)).filter(Boolean).slice(0, 6) : [];
  const rawCover = text(data.coverSrc) || text(data.posterSrc);

  return {
    id,
    title: text(data.title) || text($('h1').first().text()) || `剧集 ${id}`,
    cover: (await coverData(rawCover)) || '',
    description: text(data.description),
    score: text($('.hg-play__scorenum, .hg-web-play__scorenum').first().text()),
    episodeLabel: `共 ${episodes.length} 集`,
    episodes,
    tags,
    vids: [],
  };
}

/** 取某一集的 m3u8 地址；第 1 集在详情页，其余在 ep-N 页面。 */
export async function playSource(id: string, episode: number): Promise<{ url: string; referer: string }> {
  if (!/^\d+$/.test(id) || episode < 1) throw new Error('无效选集');
  const path = episode === 1 ? `/video/${id}/` : `/video/${id}/ep-${episode}/`;
  const { html } = await load(path, `/video/${id}/`);
  const data = initialData(html);
  const src =
    text(data.videoSrc) ||
    (Array.isArray(data.videoSrcList) ? text(data.videoSrcList[0]) : '') ||
    text((data.epPlaySrcs as Record<string, string> | undefined)?.[String(episode)]);
  if (!src) throw new Error('这一集没有取到播放地址');
  const url = src.startsWith('//') ? `https:${src}` : new URL(src, `${REFERER}${path}`).toString();
  return { url, referer: `${REFERER}/video/${id}/${episode === 1 ? '' : `ep-${episode}/`}` };
}
