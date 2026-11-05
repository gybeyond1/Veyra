import type { CategoryPayload, HomePayload, SeriesDetail, SeriesCard } from '../shared/types';
import { serverModules } from './server-modules';
import { fetchText } from './http';

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

export async function home(): Promise<HomePayload> {
  const data = await serverModules().content.home();
  return {
    slides: toCards(data?.slides || data?.items),
    homepageRecommend: toCards(data?.homepageRecommend || data?.recommend?.items),
    homepageNewest: toCards(data?.homepageNewest || data?.newest?.items),
  };
}

export async function category(params: { type?: string; slug?: string; page?: number }): Promise<CategoryPayload> {
  const query = {
    type: params.type === 'comic' ? 'comic' : 'short',
    slug: params.slug || '',
    page: Math.min(100, Math.max(1, Number(params.page) || 1)),
  };
  const data = await serverModules().content.category(query);
  const items = toCards(data?.items);
  return {
    items,
    title: data?.title ? String(data.title) : '',
    total: Number(data?.total) || 0,
    page: query.page,
    hasMore: items.length >= 20,
  };
}

export async function tags(): Promise<{ items: { name: string; slug: string; type: string }[] }> {
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

export async function search(q: string): Promise<{ items: SeriesCard[] }> {
  const keyword = String(q || '').trim();
  if (!keyword) return { items: [] };
  const data = await serverModules().content.search(keyword);
  return { items: toCards(data?.items) };
}

export async function detail(id: string): Promise<SeriesDetail> {
  const seriesId = String(id || '').trim();
  if (!seriesId) throw new Error('缺少剧集 id');
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

  return {
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
}
