import { useEffect, useMemo, useState } from 'react';
import type { SeriesCard } from '@shared/types';
import { call, errorText } from '../api';
import Cover from '../components/Cover';

interface Props {
  source: 'hongguo' | 'huangguo';
  onOpen: (id: string, fallback: { title: string; cover: string }) => void;
}

interface LibraryItem {
  id: string;
  title: string;
  cover: string;
  episode?: number;
  position?: number;
  completed?: boolean;
  updatedAt?: number;
  addedAt?: number;
  episodeCount?: number;
}

function toCards(bucket: Record<string, LibraryItem> | undefined, sortedBy: 'addedAt' | 'updatedAt'): LibraryItem[] {
  if (!bucket) return [];
  return Object.values(bucket)
    .filter((item) => item && item.id && item.title)
    .sort((a, b) => (Number(b[sortedBy]) || 0) - (Number(a[sortedBy]) || 0));
}

function progressText(item: LibraryItem): string {
  const episode = Number(item.episode) || 0;
  const position = Number(item.position) || 0;
  if (item.completed) return episode ? `第 ${episode} 集 · 已看完` : '已看完';
  if (!episode) return '';
  const minutes = Math.floor(position / 60000);
  const seconds = Math.floor((position % 60000) / 1000);
  return `第 ${episode} 集 · ${minutes}:${String(seconds).padStart(2, '0')}`;
}

export default function LibraryPage({ source, onOpen }: Props) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [bookmarks, setBookmarks] = useState<LibraryItem[]>([]);
  const [history, setHistory] = useState<LibraryItem[]>([]);
  const [tab, setTab] = useState<'history' | 'bookmarks'>('history');

  useEffect(() => {
    let alive = true;
    setLoading(true);
    call<{ payload: Record<string, any> }>('sync.pull', { source })
      .then((data) => {
        if (!alive) return;
        const payload = data?.payload || {};
        setBookmarks(toCards(payload.bookmarks, 'addedAt'));
        setHistory(toCards(payload.history || payload.progress, 'updatedAt'));
        setError('');
      })
      .catch((issue) => alive && setError(errorText(issue)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [source]);

  const items = tab === 'history' ? history : bookmarks;
  const stats = useMemo(
    () => ({ history: history.length, bookmarks: bookmarks.length }),
    [history.length, bookmarks.length],
  );

  return (
    <div className="page">
      <div className="page-head">
        <h1>我的</h1>
        <p>只显示{source === 'huangguo' ? '私密' : '公开'}模式的记录，和手机端同一个账号。</p>
      </div>

      <div className="seg">
        <button type="button" className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>
          最近在看 {stats.history > 0 ? `(${stats.history})` : ''}
        </button>
        <button type="button" className={tab === 'bookmarks' ? 'active' : ''} onClick={() => setTab('bookmarks')}>
          收藏 {stats.bookmarks > 0 ? `(${stats.bookmarks})` : ''}
        </button>
      </div>

      {loading ? (
        <div className="grid">
          {Array.from({ length: 10 }).map((_, index) => (
            <div key={index} className="tile-skeleton" />
          ))}
        </div>
      ) : error ? (
        <div className="empty-block">
          <h3>同步失败</h3>
          <p>{error}</p>
        </div>
      ) : items.length === 0 ? (
        <div className="empty-block">
          <h3>{tab === 'history' ? '还没有观看记录' : '还没有收藏'}</h3>
          <p>在手机上看过的剧会出现在这里，点开就能直接下到电脑。</p>
        </div>
      ) : (
        <div className="grid">
          {items.map((item) => {
            const hint = progressText(item);
            const card: SeriesCard = {
              id: item.id,
              title: item.title,
              cover: item.cover || '',
              episodeCount: item.episodeCount || 0,
            };
            return (
              <button
                key={item.id}
                type="button"
                className="tile"
                onClick={() => onOpen(card.id, { title: card.title, cover: card.cover })}
                title={card.title}
              >
                <div className="tile-art">
                  <Cover src={card.cover} alt={card.title} />
                  {hint && (
                    <span className="tile-badge">
                      {item.completed ? '已看完' : item.episode ? `第 ${item.episode} 集` : hint}
                    </span>
                  )}
                  <span className="tile-play">
                    <svg viewBox="0 0 24 24" fill="currentColor">
                      <path d="M8 5.5v13l11-6.5z" />
                    </svg>
                  </span>
                </div>
                <p className="tile-title">{card.title}</p>
                <p className="tile-sub">
                  {tab === 'bookmarks'
                    ? '已收藏'
                    : item.completed
                      ? '已看完'
                      : hint
                        ? hint.replace(/^第 \d+ 集 · /, '看到 ')
                        : ''}
                </p>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
