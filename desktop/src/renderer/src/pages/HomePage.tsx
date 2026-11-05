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

  async function load() {
    setLoading(true);
    setError('');
    try {
      const payload = await call<HomePayload>('catalog.home', { source });
      setData(payload);
    } catch (issue) {
      setError(errorText(issue));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setData(null);
    setSlide(0);
    void load();
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
          <button type="button" className="primary" onClick={load}>
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

      <Section title="推荐给你" items={data?.homepageRecommend || []} onOpen={onOpen} />
      <Section title="最新上线" items={data?.homepageNewest || []} onOpen={onOpen} />
    </div>
  );
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
