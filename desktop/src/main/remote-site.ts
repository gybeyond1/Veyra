import { requestJson } from './http';
import { session } from './session';
import { readSettings } from './store';
import type { CategoryPayload, HomePayload, SeriesCard, SeriesDetail } from '../shared/types';

/**
 * 私密模式「接口型源」的桌面端客户端。
 *
 * 剧果、野果、帝果这些源的解析全在后端 /api/sources/{site}/*：
 * 一份代码手机 / 电视 / 电脑 / WebUI 共用，改一处四端都好。
 * 黄果不走这里，仍然是主进程 huangguo.ts 那套网页解析（三通道不变）。
 */

export function site(): string {
  const id = String(readSettings().privateSite || '').trim();
  return id || 'huangguo';
}

/** 当前是否用的是接口型源（黄果 = 内置解析，返回 false） */
export function active(): boolean {
  return site() !== 'huangguo';
}

function auth(): { server: string; token: string } {
  const current = session();
  if (!current) throw new Error('请先登录账号');
  return { server: current.server, token: current.token };
}

async function get<T>(path: string): Promise<T> {
  const { server, token } = auth();
  return requestJson<T>(server, `/api/sources/${encodeURIComponent(site())}/${path}`, {
    token,
    timeoutMs: 25000,
  });
}

function card(row: any): SeriesCard {
  const label = String(row?.episodeLabel || '');
  const count = Number((label.match(/\d+/) || [])[0]) || 0;
  const score = String(row?.score || '');
  return {
    id: String(row?.id || ''),
    title: String(row?.title || ''),
    cover: String(row?.cover || ''),
    description: String(row?.description || ''),
    badge: score || label,
    episodeCount: count,
    tags: Array.isArray(row?.tags) ? row.tags.map(String) : [],
    type: String(row?.category || ''),
  };
}

function cards(list: any): SeriesCard[] {
  return (Array.isArray(list) ? list : []).map(card).filter((item) => item.id && item.title);
}

export async function home(): Promise<HomePayload> {
  const data = await get<any>('home');
  return {
    slides: cards(data?.featured).slice(0, 5),
    homepageRecommend: cards(data?.homepageRecommend),
    homepageNewest: cards(data?.homepageNewest),
  };
}

export async function category(slug: string, page: number): Promise<CategoryPayload> {
  const query = `category?slug=${encodeURIComponent(slug || '')}&page=${Math.max(1, page)}`;
  const data = await get<any>(query);
  return {
    items: cards(data?.items),
    page: Math.max(1, page),
    hasMore: Boolean(data?.nextPage),
  };
}

export async function search(keyword: string): Promise<SeriesCard[]> {
  const data = await get<any>(`search?q=${encodeURIComponent(keyword)}`);
  return cards(data?.items);
}

export async function detail(id: string): Promise<SeriesDetail> {
  const data = await get<any>(`detail?id=${encodeURIComponent(id)}`);
  const episodes = (Array.isArray(data?.episodes) ? data.episodes : [])
    .map((item: any) => Number(item.number))
    .filter((n: number) => Number.isInteger(n) && n > 0);
  if (!episodes.length) throw new Error('这部剧没有可播放的分集');
  return {
    id: String(data?.id || id),
    title: String(data?.title || ''),
    cover: String(data?.cover || ''),
    description: String(data?.description || ''),
    score: String(data?.score || ''),
    episodeLabel: String(data?.episodeLabel || `共 ${episodes.length} 集`),
    episodes,
    tags: Array.isArray(data?.tags) ? data.tags.map(String) : [],
    category: String(data?.category || ''),
  };
}

/** 播放地址：后端签发的一次性 stream 地址（带签名 cookie），10 分钟有效 */
export async function play(id: string, episode: number): Promise<{ url: string; kind: 'hls' | 'file' }> {
  const data = await get<any>(`episode?id=${encodeURIComponent(id)}&episode=${Math.max(1, episode)}`);
  const url = String(data?.source || '');
  if (!/^https?:\/\//i.test(url)) throw new Error('后端没有返回可播放地址');
  return { url, kind: 'hls' };
}

export async function sources(): Promise<{ id: string; name: string; description?: string }[]> {
  const { server, token } = auth();
  const data = await requestJson<{ sources?: any[] }>(server, '/api/sources', { token, timeoutMs: 15000 });
  return (Array.isArray(data?.sources) ? data.sources : [])
    .map((row) => ({ id: String(row.id || ''), name: String(row.name || ''), description: String(row.description || '') }))
    .filter((row) => row.id);
}
