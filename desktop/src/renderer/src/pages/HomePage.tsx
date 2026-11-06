import { useEffect, useState } from 'react';
import type { HomePayload, SeriesCard } from '@shared/types';
import { call, errorText } from '../api';
import Cover from '../components/Cover';
import SeriesTile from '../components/SeriesTile';

interface Props {
  source: 'hongguo' | 'huangguo';
  onOpen: (id: string, fallback: { title: string; cover: string }) => void;
  onSearch: (keyword: string) => void;
}

export default function HomePage({ source, onOpen, onSearch }: Props) {
  const [data, setData] = useState<HomePayload | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [slide, setSlide] = useState(0);

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

  if (loading) {
    return (
      <div className="page">
        <div className="hero skeleton" />
        <div className="grid">
          {Array.from({ length: 12 }).map((_, index) => (
            <div key={index} className="tile-skeleton" />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="page">
        <div className="empty-block">
          <h3>首页加载失败</h3>
          <p>{error}</p>
          <button type="button" className="primary" onClick={() => void load()}>
            重试
          </button>
        </div>
      </div>
    );
  }

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
