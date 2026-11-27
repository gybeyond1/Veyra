import { useEffect, useMemo, useState } from 'react';
import type { CategoryPayload, HomePayload, SeriesCard } from '@shared/types';
import { call, errorText } from '../api';
import Cover from '../components/Cover';
import SeriesTile from '../components/SeriesTile';

interface Props {
  source: 'hongguo' | 'huangguo';
  onOpen: (id: string, fallback: { title: string; cover: string }) => void;
  onSearch: (keyword: string) => void;
}

interface Tag {
  name: string;
  slug: string;
  type: string;
}

/**
 * 首页 = 推荐 + 全部剧集。
 *
 * 「分类」以前是侧栏里单独一页，点进去才能按题材筛。现在并进首页：
 * 推荐下面是 短剧/漫剧 切换 + 题材分类 + 网格，和手机端一个形态，
 * 少一次跳转，也少一个侧栏入口。
 */
export default function HomePage({ source, onOpen, onSearch }: Props) {
  const [data, setData] = useState<HomePayload | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [slide, setSlide] = useState(0);

  const [type, setType] = useState<'short' | 'comic'>('short');
  const [slug, setSlug] = useState('');
  const [page, setPage] = useState(1);
  const [tags, setTags] = useState<Tag[]>([]);
  /** 50 来个题材默认收起来：一行「全部 · 选择分类」就够，摊开会把首屏顶下去 */
  const [tagOpen, setTagOpen] = useState(false);
  const [items, setItems] = useState<SeriesCard[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [hasMore, setHasMore] = useState(false);

  async function load(hasCached = false) {
    if (!hasCached) setLoading(true);
    setError('');
    try {
      const payload = await call<HomePayload>('catalog.home', { source });
      setData(payload);
    } catch (issue) {
      // 有缓存就继续显示旧内容，不把用户刚看到的封面换成错误页
      if (!hasCached) setError(errorText(issue));
    } finally {
      setLoading(false);
    }
  }

  /* 先用上一轮缓存立刻渲染，新数据回来再整体替换。
     私密源解析一次要好几秒，每次进来都对着骨架屏等，体验很差。 */
  useEffect(() => {
    let alive = true;
    setData(null);
    setSlide(0);
    setLoading(true);
    (async () => {
      let cached: HomePayload | null = null;
      try {
        cached = await call<HomePayload | null>('catalog.cachedHome', { source });
      } catch {
        cached = null;
      }
      if (!alive) return;
      if (cached) {
        setData(cached);
        setLoading(false);
      }
      void load(Boolean(cached));
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  useEffect(() => {
    if (!data?.slides?.length) return;
    const timer = window.setInterval(() => setSlide((index) => (index + 1) % data.slides.length), 7000);
    return () => window.clearInterval(timer);
  }, [data]);

  // 题材：短剧 25 个、漫剧 26 个，随内容源切换重新拉
  useEffect(() => {
    let alive = true;
    call<{ items: Tag[] }>('catalog.tags', { source })
      .then((result) => {
        if (alive) setTags(Array.isArray(result?.items) ? result.items : []);
      })
      .catch(() => alive && setTags([]));
    return () => {
      alive = false;
    };
  }, [source]);

  // 全部剧集：切 tab / 题材 / 翻页都重新拉
  useEffect(() => {
    let alive = true;
    setListLoading(true);
    setListError('');
    call<CategoryPayload | null>('catalog.cachedCategory', { type, slug, page, source })
      .then((cached) => {
        if (!alive || page !== 1 || !cached?.items?.length) return;
        setItems(cached.items);
        setHasMore(Boolean(cached.hasMore));
        setListLoading(false);
      })
      .catch(() => undefined);
    call<CategoryPayload>('catalog.category', { type, slug, page, source })
      .then((result) => {
        if (!alive) return;
        setItems(result?.items || []);
        setHasMore(Boolean(result?.hasMore));
      })
      .catch((issue) => alive && setListError(errorText(issue)))
      .finally(() => alive && setListLoading(false));
    return () => {
      alive = false;
    };
  }, [type, slug, page, source]);

  const visibleTags = useMemo(() => {
    const mine = tags.filter((tag) => tag.type === type || tag.slug.startsWith(`${type}:`));
    return mine.length ? mine : tags;
  }, [tags, type]);

  const slides = data?.slides?.length ? data.slides : (data?.homepageRecommend || []).slice(0, 5);
  const featured = slides[slide];

  return (
    <div className="page">
      <div className="topbar">
        <div className="search-mini">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <circle cx="11" cy="11" r="6.5" />
            <path d="m16 16 4 4" strokeLinecap="round" />
          </svg>
          <input
            placeholder="搜索剧名，回车开始"
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                const value = (event.target as HTMLInputElement).value.trim();
                if (value) onSearch(value);
              }
            }}
          />
        </div>
        <span className="topbar-tip">下载到电脑 · 自动合并 · 账号同步</span>
      </div>

      {loading ? (
        <>
          <div className="hero skeleton" />
          <div className="grid">
            {Array.from({ length: 12 }).map((_, index) => (
              <div key={index} className="tile-skeleton" />
            ))}
          </div>
        </>
      ) : (
        <>
          {/* 推荐区拉不到时只提示一句，不能把下面的「全部剧集」一起顶掉 */}
          {error && (
            <div className="inline-error">
              <span>推荐内容没加载出来：{error}</span>
              <button type="button" className="ghost" onClick={() => void load()}>
                重试
              </button>
            </div>
          )}

          {featured && (
            <section className="hero-banner" onClick={() => onOpen(featured.id, { title: featured.title, cover: featured.cover })}>
              <Cover src={featured.cover} alt={featured.title} className="hero-bg" />
              <div className="hero-shade" />
              <div className="hero-body">
                <span className="hero-tag">{featured.badge || '本周推荐'}</span>
                <h1>{featured.title}</h1>
                <p>{featured.description || '点开看详情，选集后可以直接下载整部剧到电脑。'}</p>
                <div className="hero-actions">
                  <button type="button" className="primary" onClick={() => onOpen(featured.id, { title: featured.title, cover: featured.cover })}>
                    查看详情
                  </button>
                  <span className="hero-meta">{featured.episodeCount ? `全 ${featured.episodeCount} 集` : ''}</span>
                </div>
              </div>
              {slides.length > 1 && (
                <div className="hero-dots">
                  {slides.map((item, index) => (
                    <button
                      key={item.id}
                      type="button"
                      className={index === slide ? 'active' : ''}
                      onClick={(event) => {
                        event.stopPropagation();
                        setSlide(index);
                      }}
                      aria-label={`第 ${index + 1} 张`}
                    />
                  ))}
                </div>
              )}
            </section>
          )}

          <Section title="推荐给你" items={fillRecommend(data)} onOpen={onOpen} />
          <Section title="最新上线" items={data?.homepageNewest || []} onOpen={onOpen} />
        </>
      )}

      {/* ---------- 全部剧集：原来侧栏「分类」页的内容 ---------- */}
      <section className="section">
        <header className="section-head">
          <h2>全部剧集</h2>
          <div className="seg seg-inline">
            <button
              type="button"
              className={type === 'short' ? 'active' : ''}
              onClick={() => {
                setType('short');
                setSlug('');
                setPage(1);
                setTagOpen(false);
              }}
            >
              短剧
            </button>
            <button
              type="button"
              className={type === 'comic' ? 'active' : ''}
              onClick={() => {
                setType('comic');
                setSlug('');
                setPage(1);
                setTagOpen(false);
              }}
            >
              漫剧
            </button>
          </div>
        </header>

        <div className="chips">
          <button
            type="button"
            className={!slug ? 'chip active' : 'chip'}
            onClick={() => {
              setSlug('');
              setPage(1);
            }}
          >
            全部
          </button>

          {tagOpen &&
            visibleTags.map((tag) => (
              <button
                key={tag.slug}
                type="button"
                className={slug === tag.slug ? 'chip active' : 'chip'}
                onClick={() => {
                  setSlug(tag.slug);
                  setPage(1);
                }}
              >
                {tag.name}
              </button>
            ))}

          {/* 收起时把当前选中的题材露出来，不然看不出筛了什么 */}
          {!tagOpen && slug && (
            <button type="button" className="chip active">
              {visibleTags.find((tag) => tag.slug === slug)?.name || '已选题材'}
            </button>
          )}

          {visibleTags.length > 0 && (
            <button type="button" className="chip chip-more" onClick={() => setTagOpen((value) => !value)}>
              {tagOpen ? '收起分类' : `选择分类（${visibleTags.length}）`}
            </button>
          )}
        </div>

        {listError && (
          <div className="inline-error">
            <span>{listError}</span>
          </div>
        )}

        {listLoading ? (
          <div className="grid">
            {Array.from({ length: 12 }).map((_, index) => (
              <div key={index} className="tile-skeleton" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <div className="empty-block">
            <h3>没有内容</h3>
            <p>这个题材暂时没有内容，换个分类看看。</p>
          </div>
        ) : (
          <>
            <div className="grid">
              {items.map((item) => (
                <SeriesTile key={item.id} item={item} onOpen={onOpen} />
              ))}
            </div>
            <div className="pager">
              <button type="button" className="ghost" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>
                上一页
              </button>
              <span>第 {page} 页</span>
              <button type="button" className="ghost" disabled={!hasMore} onClick={() => setPage((value) => value + 1)}>
                下一页
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

/* 私密源首页的「推荐」区块经常只有 4 张，比公开源少一格，看着像没加载完。
   不足 5 张就用同一页的轮播/上新补齐。 */
function fillRecommend(data: HomePayload | null): SeriesCard[] {
  if (!data) return [];
  const out: SeriesCard[] = [...(data.homepageRecommend || [])];
  const seen = new Set(out.map((item) => String(item.id)));
  for (const pool of [data.slides || [], data.homepageNewest || []]) {
    for (const item of pool) {
      if (out.length >= 5) break;
      if (!item?.id || seen.has(String(item.id))) continue;
      seen.add(String(item.id));
      out.push(item);
    }
    if (out.length >= 5) break;
  }
  return out;
}

function Section({ title, items, onOpen }: { title: string; items: SeriesCard[]; onOpen: Props['onOpen'] }) {
  if (!items.length) return null;
  return (
    <section className="section">
      <header className="section-head">
        <h2>{title}</h2>
        <span>{items.length} 部</span>
      </header>
      <div className="grid">
        {items.map((item) => (
          <SeriesTile key={item.id} item={item} onOpen={onOpen} />
        ))}
      </div>
    </section>
  );
}
