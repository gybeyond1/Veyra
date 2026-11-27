import { useEffect, useMemo, useState } from 'react';
import type { CategoryPayload, SeriesCard } from '@shared/types';
import { call, errorText } from '../api';
import SeriesTile from '../components/SeriesTile';

interface Props {
  source: 'hongguo' | 'huangguo';
  onOpen: (id: string, fallback: { title: string; cover: string }) => void;
}

interface Tag {
  name: string;
  slug: string;
  type: string;
}

/**
 * 首页 = 全部剧集。
 *
 * 以前首页顶上还有一张大轮播 + 「推荐给你」+「最新上线」，都是从首页接口拼出来的，
 * 慢、经常缺块，而且真正要用的「全部剧集」被顶到两屏以下。手机端就是直接进列表的，
 * 桌面端也照这个来：进来第一眼就是短剧/漫剧切换 + 题材 + 网格。
 */
export default function HomePage({ source, onOpen }: Props) {
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

  function switchType(next: 'short' | 'comic') {
    setType(next);
    setSlug('');
    setPage(1);
    setTagOpen(false);
  }

  return (
    <div className="page">
      <div className="page-head head-row">
        <h1>全部剧集</h1>
        <div className="seg seg-inline">
          <button type="button" className={type === 'short' ? 'active' : ''} onClick={() => switchType('short')}>
            短剧
          </button>
          <button type="button" className={type === 'comic' ? 'active' : ''} onClick={() => switchType('comic')}>
            漫剧
          </button>
        </div>
      </div>

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
    </div>
  );
}
