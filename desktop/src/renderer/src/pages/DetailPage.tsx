import { useEffect, useMemo, useState } from 'react';
import type { AppSettings, DownloadTask, SeriesDetail } from '@shared/types';
import { call, errorText } from '../api';
import Cover from '../components/Cover';

interface Props {
  id: string;
  fallback: { title: string; cover: string } | null;
  settings: AppSettings | null;
  onBack: () => void;
  onDownloaded: () => void;
  notify: (text: string, tone?: 'info' | 'error') => void;
}

export default function DetailPage({ id, fallback, settings, onBack, onDownloaded, notify }: Props) {
  const [detail, setDetail] = useState<SeriesDetail | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    setSelected(new Set());
    call<SeriesDetail>('catalog.detail', { id })
      .then((data) => {
        if (!alive) return;
        setDetail(data);
        setSelected(new Set(data.episodes));
      })
      .catch((issue) => alive && setError(errorText(issue)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [id, attempt]);

  // 详情接口没给封面时，用列表卡片带过来的那张，别显示空图
  const cover = detail?.cover || fallback?.cover || '';
  const title = detail?.title || fallback?.title || '加载中…';
  const episodes = detail?.episodes || [];

  const allSelected = episodes.length > 0 && selected.size === episodes.length;
  const selectedCount = selected.size;

  const summary = useMemo(() => {
    if (!episodes.length) return '';
    if (allSelected) return `全 ${episodes.length} 集`;
    return `已选 ${selectedCount} / ${episodes.length} 集`;
  }, [episodes.length, allSelected, selectedCount]);

  function toggle(number: number) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(number)) next.delete(number);
      else next.add(number);
      return next;
    });
  }

  async function download(numbers: number[]) {
    if (!numbers.length || busy) return;
    setBusy(true);
    try {
      const task = await call<DownloadTask>('downloads.create', {
        id,
        title,
        cover,
        episodes: numbers,
      });
      notify(`已加入下载队列：${task.title}（${numbers.length} 集）`);
      onDownloaded();
    } catch (issue) {
      notify(errorText(issue), 'error');
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="page">
        <div className="detail-skeleton" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="page">
        <button type="button" className="ghost back" onClick={onBack}>
          ← 返回
        </button>
        <div className="empty-block">
          <h3>打不开这部剧</h3>
          <p>{error}</p>
          <button type="button" className="primary" onClick={() => setAttempt((value) => value + 1)}>
            重试
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="page detail-page">
      <button type="button" className="ghost back" onClick={onBack}>
        ← 返回
      </button>

      <section className="detail-head">
        <div className="detail-cover">
          <Cover src={cover} alt={title} />
        </div>
        <div className="detail-meta">
          <h1>{title}</h1>
          <p className="detail-sub">
            {detail?.score ? `评分 ${detail.score}` : ''}
            {detail?.episodeLabel ? ` · ${detail.episodeLabel}` : ''}
          </p>
          {detail?.tags && detail.tags.length > 0 && (
            <div className="chips">
              {detail.tags.slice(0, 6).map((tag) => (
                <span key={tag} className="chip static">
                  {tag}
                </span>
              ))}
            </div>
          )}
          <p className="detail-desc">{detail?.description || '暂无简介'}</p>
          <div className="detail-actions">
            <button
              type="button"
              className="primary big"
              disabled={busy || !episodes.length}
              onClick={() => download(episodes)}
            >
              {busy ? '正在加入…' : `下载全剧（${episodes.length} 集）`}
            </button>
            <button
              type="button"
              className="ghost big"
              disabled={busy || !selectedCount || allSelected}
              onClick={() => download([...selected].sort((a, b) => a - b))}
            >
              下载已选 {allSelected ? '' : `（${selectedCount}）`}
            </button>
          </div>
          <p className="detail-path">保存到：{settings?.downloadDir || '默认下载目录'}</p>
        </div>
      </section>

      <section className="episodes">
        <header className="section-head">
          <h2>选集</h2>
          <div className="ep-tools">
            <span>{summary}</span>
            <button
              type="button"
              className="link"
              onClick={() => setSelected(allSelected ? new Set() : new Set(episodes))}
            >
              {allSelected ? '取消全选' : '全选'}
            </button>
          </div>
        </header>
        <div className="ep-grid">
          {episodes.map((number) => (
            <button
              key={number}
              type="button"
              className={selected.has(number) ? 'ep active' : 'ep'}
              onClick={() => toggle(number)}
            >
              {number}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
