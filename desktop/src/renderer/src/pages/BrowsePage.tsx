import { useEffect, useMemo, useState } from 'react';
import type { CategoryPayload, SeriesCard } from '@shared/types';
import { call, errorText } from '../api';
import SeriesTile from '../components/SeriesTile';

interface Props {
  mode?: 'category' | 'search';
  seed?: string;
  source: 'hongguo' | 'huangguo';
  onOpen: (id: string, fallback: { title: string; cover: string }) => void;
}

export default function BrowsePage({ mode = 'category', seed = '', source, onOpen }: Props) {
  const [type, setType] = useState<'short' | 'comic'>('short');
  const [slug, setSlug] = useState('');
  const [page, setPage] = useState(1);
  const [tags, setTags] = useState<{ name: string; slug: string; type: string }[]>([]);
  const [items, setItems] = useState<SeriesCard[]>([]);
  const [query, setQuery] = useState(seed);
  const [submitted, setSubmitted] = useState(seed);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [hasMore, setHasMore] = useState(false);

  useEffect(() => {
    if (mode !== 'category') return;
    call<{ items: { name: string; slug: string; type: string }[] }>('catalog.tags', { source })
      .then((data) => setTags(data.items))
      .catch(() => setTags([]));
  }, [mode, source]);

  useEffect(() => {
    if (mode === 'search' && seed) {
      setQuery(seed);
      setSubmitted(seed);
    }
  }, [mode, seed]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    /* 分类页同样先铺缓存：切分类时立刻有内容，新数据回来再替换。
       已经有新数据（prev 非空）时不覆盖，避免慢一步的缓存把结果顶掉。 */
    if (mode === 'category') {
      call<CategoryPayload | null>('catalog.cachedCategory', { type, slug, page, source })
        .then((cached) => {
          if (!alive || !cached?.items?.length) return;
          setItems((prev) => (prev.length ? prev : cached.items));
          setHasMore((prev) => prev || !!cached.hasMore);
          setLoading(false);
        })
        .catch(() => undefined);
    }
    const job =
      mode === 'search'
        ? submitted
          ? call<{ items: SeriesCard[] }>('catalog.search', { q: submitted, source }).then((data) => ({
              items: data.items,
              hasMore: false,
              title: `“${submitted}” 的搜索结果`,
            }))
          : Promise.resolve({ items: [], hasMore: false, title: '搜索' })
        : call<CategoryPayload>('catalog.category', { type, slug, page, source }).then((data) => ({
            items: data.items,
            hasMore: !!data.hasMore,
            title: data.title || (type === 'comic' ? '漫剧' : '短剧'),
          }));

    job
      .then((data) => {
        if (!alive) return;
        setItems(data.items);
        setHasMore(data.hasMore);
      })
      .catch((issue) => alive && setError(errorText(issue)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [mode, type, slug, page, submitted, source]);

  const visibleTags = useMemo(() => tags.filter((tag) => tag.type === type), [tags, type]);

  return (
    <div className="page">
      {mode === 'search' ? (
        <div className="search-bar">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="输入剧名，回车搜索"
            onKeyDown={(event) => {
              if (event.key === 'Enter' && query.trim()) {
                setSubmitted(query.trim());
                setPage(1);
              }
            }}
            autoFocus
          />
          <button
            type="button"
            className="primary"
            onClick={() => query.trim() && (setSubmitted(query.trim()), setPage(1))}
          >
            搜索
          </button>
        </div>
      ) : (
        <>
          <div className="seg">
            <button type="button" className={type === 'short' ? 'active' : ''} onClick={() => { setType('short'); setPage(1); setSlug(''); }}>
              短剧
            </button>
            <button type="button" className={type === 'comic' ? 'active' : ''} onClick={() => { setType('comic'); setPage(1); setSlug(''); }}>
              漫剧
            </button>
          </div>
          {visibleTags.length > 0 && (
            <div className="chips">
              <button type="button" className={!slug ? 'chip active' : 'chip'} onClick={() => { setSlug(''); setPage(1); }}>
                全部
              </button>
              {visibleTags.map((tag) => (
                <button
                  key={tag.slug}
                  type="button"
                  className={slug === tag.slug ? 'chip active' : 'chip'}
                  onClick={() => { setSlug(tag.slug); setPage(1); }}
                >
                  {tag.name}
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {error && (
        <div className="empty-block">
          <h3>加载失败</h3>
          <p>{error}</p>
        </div>
      )}

      {loading ? (
        <div className="grid">
          {Array.from({ length: 12 }).map((_, index) => (
            <div key={index} className="tile-skeleton" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="empty-block">
          <h3>{mode === 'search' && !submitted ? '搜点什么' : '没有内容'}</h3>
          <p>{mode === 'search' ? '输入剧名后回车，结果会出现在这里。' : '这个题材暂时没有内容，换个分类看看。'}</p>
        </div>
      ) : (
        <>
          <div className="grid">
            {items.map((item) => (
              <SeriesTile key={item.id} item={item} onOpen={onOpen} />
            ))}
          </div>
          {mode === 'category' && (
            <div className="pager">
              <button type="button" className="ghost" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>
                上一页
              </button>
              <span>第 {page} 页</span>
              <button type="button" className="ghost" disabled={!hasMore} onClick={() => setPage((value) => value + 1)}>
                下一页
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
