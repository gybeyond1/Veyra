import { useEffect, useMemo, useState } from 'react';
import type { AppSettings, DownloadDispatchResult, DownloadTarget, SeriesDetail } from '@shared/types';
import { call, errorText } from '../api';
import Cover from '../components/Cover';

export interface DetailFallback {
  title: string;
  cover: string;
  description?: string;
  episodeLabel?: string;
}

interface Props {
  id: string;
  source: 'hongguo' | 'huangguo';
  fallback: DetailFallback | null;
  settings: AppSettings | null;
  onBack: () => void;
  onDownloaded: () => void;
  onPlay: (episode: number) => void;
  notify: (text: string, tone?: 'info' | 'error') => void;
}

/**
 * 详情页：
 *  - 平时点集数就是「播这一集」，不做任何勾选；
 *  - 只有点了「下载」才进入选集模式，这时才有勾选框和全选；
 *  - 下载按钮只有一个，不会一进来就把全部集数默认选上。
 */
export default function DetailPage({ id, source, fallback, settings, onBack, onDownloaded, onPlay, notify }: Props) {
  const [detail, setDetail] = useState<SeriesDetail | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  /** 下载到哪儿：本机 / NAS / 某台设备 / 远程存储 */
  const [targets, setTargets] = useState<DownloadTarget[]>([]);
  const [target, setTarget] = useState('local');

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    setSelecting(false);
    setSelected(new Set());
    call<SeriesDetail>('catalog.detail', { id, source })
      .then((data) => {
        if (!alive) return;
        setDetail(data);
      })
      .catch((issue) => alive && setError(errorText(issue)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [id, source, attempt]);

  // 详情接口没给封面时，用列表卡片带过来的那张，别显示空图
  const cover = detail?.cover || fallback?.cover || '';
  const title = detail?.title || fallback?.title || '加载中…';
  const episodes = detail?.episodes || [];
  const allSelected = episodes.length > 0 && selected.size === episodes.length;

  const summary = useMemo(() => {
    if (!episodes.length) return '';
    if (!selecting) return `全 ${episodes.length} 集 · 点集数直接播放`;
    if (allSelected) return `全选 ${episodes.length} 集`;
    return `已选 ${selected.size} 集`;
  }, [allSelected, episodes.length, selecting, selected.size]);

  function toggle(number: number) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(number)) next.delete(number);
      else next.add(number);
      return next;
    });
  }

  function beginSelect() {
    setSelecting(true);
    setSelected(new Set());
    // 每次进选集都刷一次：设备上下线、远端存储增删都能立刻反映
    call<DownloadTarget[]>('downloads.targets')
      .then((list) => {
        setTargets(Array.isArray(list) ? list : []);
        setTarget((current) => (list.some((item) => item.key === current && item.available) ? current : 'local'));
      })
      .catch(() => setTargets([]));
  }

  function cancelSelect() {
    setSelecting(false);
    setSelected(new Set());
  }

  async function download(numbers: number[]) {
    if (!numbers.length || busy) return;
    setBusy(true);
    try {
      const result = await call<DownloadDispatchResult>('downloads.create', {
        id,
        title,
        cover,
        source,
        episodes: numbers,
        target,
      });
      notify(result?.message || `已提交：${title}（${numbers.length} 集）`);
      onDownloaded();
      cancelSelect();
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
            {[detail?.score ? `评分 ${detail.score}` : '', detail?.episodeLabel || fallback?.episodeLabel || '']
              .filter(Boolean)
              .join(' · ')}
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
          <p className="detail-desc">{detail?.description || fallback?.description || '暂无简介'}</p>
          <div className="detail-actions">
            <button
              type="button"
              className="primary big"
              disabled={!episodes.length}
              onClick={() => onPlay(episodes[0])}
            >
              立即播放
            </button>
            <button
              type="button"
              className="ghost big"
              disabled={!episodes.length}
              onClick={() => (selecting ? cancelSelect() : beginSelect())}
            >
              {selecting ? '取消下载' : '下载'}
            </button>
          </div>
          <p className="detail-path">
            保存到：{targets.find((item) => item.key === target)?.hint || settings?.downloadDir || '默认下载目录'}
          </p>
        </div>
      </section>

      <section className="episodes">
        <header className="section-head">
          <h2>选集</h2>
          <div className="ep-tools">
            {selecting && (
              <label className="ep-all">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={() => setSelected(allSelected ? new Set() : new Set(episodes))}
                />
                <span>全选</span>
              </label>
            )}
            <span className="ep-summary">{summary}</span>
          </div>
        </header>

        {selecting && (
          <div className="download-bar">
            <label className="dl-target">
              <span>下载到</span>
              <select value={target} onChange={(event) => setTarget(event.target.value)}>
                {(targets.length ? targets : [{ key: 'local', kind: 'local', name: '本机', hint: '', available: true } as DownloadTarget]).map((item) => (
                  <option key={item.key} value={item.key} disabled={!item.available}>
                    {item.name}
                    {item.hint ? `（${item.hint}）` : ''}
                    {item.available ? '' : ' · 不可用'}
                  </option>
                ))}
              </select>
            </label>
            <div className="download-bar-actions">
              <button type="button" className="ghost" onClick={cancelSelect} disabled={busy}>
                取消
              </button>
              <button
                type="button"
                className="primary"
                disabled={busy || !selected.size}
                onClick={() => download([...selected].sort((a, b) => a - b))}
              >
                {busy ? '正在加入…' : `开始下载（${selected.size} 集）`}
              </button>
            </div>
          </div>
        )}

        <div className="ep-grid">
          {episodes.map((number) => (
            <button
              key={number}
              type="button"
              className={`ep${selecting ? ' selectable' : ''}${selected.has(number) ? ' active' : ''}`}
              title={selecting ? (selected.has(number) ? '取消选中这一集' : '选中这一集') : `播放第 ${number} 集`}
              onClick={() => (selecting ? toggle(number) : onPlay(number))}
            >
              {selecting && <span className="ep-box">{selected.has(number) ? '✓' : ''}</span>}
              <span className="ep-num">{number}</span>
              {!selecting && <span className="ep-icon">▶</span>}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
