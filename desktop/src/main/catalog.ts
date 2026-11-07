import fs from 'node:fs';
import path from 'node:path';
import type { CategoryPayload, HomePayload, SeriesDetail, SeriesCard } from '../shared/types';
import { serverModules } from './server-modules';
import { fetchText } from './http';
import * as huangguo from './huangguo';
import * as remoteSite from './remote-site';
import type { ContentSource } from './source';
import { playUrl, prepare, remoteSitePlayUrl } from './media';
import { userDataDir } from './paths';

const SITE = 'https://hongguoduanju.com';

function toCard(raw: any): SeriesCard | null {
  if (!raw || !raw.id || !raw.title) return null;
  return {
    id: String(raw.id),
    title: String(raw.title),
    cover: String(raw.cover || ''),
    description: String(raw.description || ''),
    badge: raw.badge ? String(raw.badge) : '',
    episodeCount: Number(raw.episodeCount) || 0,
    tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [],
    type: raw.type ? String(raw.type) : '',
  };
}

function toCards(list: any): SeriesCard[] {
  return (Array.isArray(list) ? list : []).map(toCard).filter(Boolean) as SeriesCard[];
}

/* ---------------- 本地缓存（stale-while-revalidate） ----------------
 * 私密源解析一次要好几秒（还要经后端转发），每次进首页都从零加载、整屏骨架屏，
 * 体感非常差。这里把上一次的结果落盘：进来先立刻用缓存渲染，
 * 新数据回来且确实有变化时再整体替换；拉取失败就继续用旧的。
 */
const CACHE_TTL = 12 * 3600 * 1000;

function cachePath(key: string): string {
  const dir = path.join(userDataDir, 'catalog-cache');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${key.replace(/[^A-Za-z0-9:_-]/g, '_').slice(0, 80)}.json`);
}

function writeCache(key: string, payload: unknown): void {
  try {
    fs.writeFileSync(cachePath(key), JSON.stringify({ at: Date.now(), payload }));
  } catch {
    /* 缓存写不进去不影响主流程 */
  }
}

function readCache<T>(key: string): T | null {
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath(key), 'utf8')) as { at: number; payload: T };
    if (!raw || Date.now() - Number(raw.at || 0) > CACHE_TTL) return null;
    return raw.payload;
  } catch {
    return null;
  }
}

export function cachedHome(source: ContentSource): HomePayload | null {
  return readCache<HomePayload>(`home:${source}`);
}

export function cachedCategory(source: ContentSource, params: { type?: string; slug?: string; page?: number }): CategoryPayload | null {
  const page = Math.min(100, Math.max(1, Number(params.page) || 1));
  return readCache<CategoryPayload>(`cat:${source}:${params.type || 'short'}:${params.slug || ''}:${page}`);
}

export function cachedDetail(source: ContentSource, id: string): SeriesDetail | null {
  return readCache<SeriesDetail>(`detail:${source}:${id}`);
}

export async function home(source: ContentSource): Promise<HomePayload> {
  // 私密模式选了接口型源（剧果/野果/帝果…）：后端网关直接给 Veyra 结构，不用本地解析
  if (source === 'huangguo' && remoteSite.active()) return remoteSite.home();
  if (source === 'huangguo') {
    const payload = await huangguo.home();
    writeCache(`home:${source}`, payload);
    return payload;
  }
  const data = await serverModules().content.home();
  const payload = {
    slides: toCards(data?.slides || data?.items),
    homepageRecommend: toCards(data?.homepageRecommend || data?.recommend?.items),
    homepageNewest: toCards(data?.homepageNewest || data?.newest?.items),
  };
  writeCache(`home:${source}`, payload);
  return payload;
}

export async function category(
  source: ContentSource,
  params: { type?: string; slug?: string; page?: number },
): Promise<CategoryPayload> {
  const page = Math.min(100, Math.max(1, Number(params.page) || 1));
  const cacheKey = `cat:${source}:${params.type || 'short'}:${params.slug || ''}:${page}`;
  if (source === 'huangguo' && remoteSite.active()) return remoteSite.category(params.slug || '', page);
  if (source === 'huangguo') {
    const result = await huangguo.category(params.slug || '', page);
    const payload = { items: result.items, title: result.title, page, hasMore: result.hasMore, total: result.items.length };
    writeCache(cacheKey, payload);
    return payload;
  }
  const query = { type: params.type === 'comic' ? 'comic' : 'short', slug: params.slug || '', page };
  const data = await serverModules().content.category(query);
  const items = toCards(data?.items);
  const payload = {
    items,
    title: data?.title ? String(data.title) : '',
    total: Number(data?.total) || 0,
    page,
    hasMore: items.length >= 20,
  };
  writeCache(cacheKey, payload);
  return payload;
}

export async function tags(source: ContentSource): Promise<{ items: { name: string; slug: string; type: string }[] }> {
  if (source === 'huangguo') {
    // 私密站没有标签页接口，用固定分类（与 APK 的 four 个分类一致）
    return {
      items: [
        { name: 'AI 短剧', slug: 'ai-duanju', type: 'short' },
        { name: 'AI 漫剧', slug: 'ai-manju', type: 'short' },
        { name: 'AI 换脸', slug: 'ai-huanlian', type: 'short' },
        { name: 'AI 魔改', slug: 'ai-mogai', type: 'short' },
      ],
    };
  }
  const data = await serverModules().content.tags();
  const items = (Array.isArray(data?.items) ? data.items : [])
    .map((item: any) => ({
      name: String(item?.name || ''),
      slug: String(item?.slug || item?.key || ''),
      type: String(item?.type || 'short'),
    }))
    .filter((item: { name: string; slug: string }) => item.name && item.slug);
  return { items };
}

export async function search(source: ContentSource, q: string): Promise<{ items: SeriesCard[] }> {
  const keyword = String(q || '').trim();
  if (!keyword) return { items: [] };
  if (source === 'huangguo' && remoteSite.active()) return { items: await remoteSite.search(keyword) };
  if (source === 'huangguo') return { items: await huangguo.search(keyword) };
  const data = await serverModules().content.search(keyword);
  return { items: toCards(data?.items) };
}

export async function detail(source: ContentSource, id: string): Promise<SeriesDetail> {
  const seriesId = String(id || '').trim();
  if (!seriesId) throw new Error('缺少剧集 id');
  if (source === 'huangguo' && remoteSite.active()) return remoteSite.detail(seriesId);
  if (source === 'huangguo') {
    const payload = await huangguo.detail(seriesId);
    writeCache(`detail:${source}:${id}`, payload);
    return payload;
  }

  const { hgApp, contentModule } = serverModules();
  const html = await fetchText(`${SITE}/detail/${encodeURIComponent(seriesId)}`, 12000);

  let loader: any = {};
  try {
    loader = contentModule.extractRouterData(html).loaderData || {};
  } catch (error) {
    console.warn('[catalog.detail] 网页结构解析失败，改走 App 接口', (error as Error).message);
  }

  const page = loader.detail_page || loader.detailPage || {};
  const video = page.video_data || loader.video_data || {};
  const rawEpisodes: any[] = page.episode_list || loader.episode_list || [];

  let vids = rawEpisodes.map((ep) => String(ep?.vid || ep?.video_id || '')).filter(Boolean);
  if (!vids.length) {
    try {
      const det = await hgApp.videoDetail(seriesId);
      if (Array.isArray(det?.vids)) vids = det.vids.map((v: unknown) => String(v));
    } catch (error) {
      console.warn('[catalog.detail] vid 兜底失败', (error as Error).message);
    }
  }

  const episodes: number[] = rawEpisodes.length
    ? rawEpisodes.map((ep, index) => Number(ep?.number || ep?.index || index + 1))
    : vids.map((_, index) => index + 1);

  const payload: SeriesDetail = {
    id: seriesId,
    title: String(page.series_title || video.series_title || page.title || ''),
    cover: String(page.series_cover || video.series_cover || ''),
    description: String(page.series_intro || video.series_intro || ''),
    score: String(page.score || video.score || ''),
    episodeLabel: episodes.length ? `全 ${episodes.length} 集` : '',
    episodes,
    vids,
    tags: Array.isArray(video.category_list) ? video.category_list.map(String) : [],
  };
  writeCache(`detail:${source}:${id}`, payload);
  return payload;
}

/**
 * 播放地址：统一交给本机媒体服务。红果加密的先解密落盘再返回，避免播放器空等。
 * hevcOk 由渲染层告诉主进程（这台机器的 Chromium 能不能直接解 H.265）；
 * 放不了就先把这集转成 H.264 再给地址。
 */
export async function play(
  source: ContentSource,
  id: string,
  episode: number,
  hevcOk = false,
): Promise<{ url: string; kind: 'hls' | 'file' }> {
  if (!id) throw new Error('缺少剧集 id');
  const number = Math.max(1, Number(episode) || 1);
  // 接口型源：三档网络模式都交给本机媒体服务。
  // 直连时由它带源站 Referer / 签名 Cookie 去取流（后端不参与），
  // 代理 / 转发时由它转发后端签发的地址 —— 对本机播放器来说都是同一条 127.0.0.1。
  if (source === 'huangguo' && remoteSite.active()) {
    return { url: remoteSitePlayUrl(remoteSite.site(), id, number), kind: 'hls' };
  }
  const needH264 = !hevcOk;
  const kind = await prepare(source, id, number, needH264);
  return { url: playUrl(source, id, number, needH264 && kind === 'file'), kind };
}
