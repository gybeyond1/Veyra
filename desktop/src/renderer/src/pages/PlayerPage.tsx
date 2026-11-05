import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import { call, errorText } from '../api';

interface Props {
  source: 'hongguo' | 'huangguo';
  id: string;
  episode: number;
  title: string;
  /** 本地已下载任务 id：有值时播本机文件 */
  localTaskId?: string;
  /** 手机投屏带过来的起播位置（毫秒），只在第一集用一次 */
  position?: number;
  episodes?: number[];
  onClose: () => void;
  onEpisode: (episode: number) => void;
  notify: (text: string, tone?: 'info' | 'error') => void;
}

/**
 * 桌面端播放器。
 *
 * 在线内容不直接连源站：交给主进程的媒体服务转一手（hls.js 带不了 Referer，
 * 红果的 CENC 流浏览器也解不了）。本地已下载的 mp4 走同一个服务的 /file。
 */
export default function PlayerPage({ source, id, episode, title, position, localTaskId, episodes, onClose, onEpisode, notify }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [list, setList] = useState<number[]>(episodes || []);

  // 没从详情页带集数过来（例如手机投屏）时，自己拉一次，保证「下一集」可用
  useEffect(() => {
    if (localTaskId || (episodes && episodes.length)) return;
    let alive = true;
    call<{ episodes: number[] }>('catalog.detail', { id, source })
      .then((data) => {
        if (alive && Array.isArray(data?.episodes)) setList(data.episodes);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, source, localTaskId]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    setUrl('');
    const job = localTaskId
      ? call<{ url: string }>('downloads.play', { id: localTaskId, index: 0 })
      : call<{ url: string }>('catalog.play', { source, id, episode });
    job
      .then((result) => {
        if (alive) setUrl(result.url);
      })
      .catch((issue) => {
        if (alive) setError(errorText(issue));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [source, id, episode, localTaskId, attempt]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !url) return;
    let hls: Hls | null = null;

    if (source === 'huangguo' && Hls.isSupported()) {
      hls = new Hls({ enableWorker: true, lowLatencyMode: false });
      hls.loadSource(url);
      hls.attachMedia(video);
    } else {
      video.src = url;
    }

    const resume = Number(localStorage.getItem(`pos:${source}:${id}:${episode}`) || 0);
    const startAt = episode === 1 && position ? position / 1000 : resume;
    const onLoaded = () => {
      if (startAt > 5 && Number.isFinite(video.duration) && startAt < video.duration - 10) {
        video.currentTime = startAt;
      }
      void video.play().catch(() => undefined);
    };
    video.addEventListener('loadedmetadata', onLoaded, { once: true });

    const save = () => {
      if (video.currentTime > 5) localStorage.setItem(`pos:${source}:${id}:${episode}`, String(video.currentTime));
    };
    const timer = window.setInterval(save, 5000);
    const onEnded = () => {
      save();
      const next = (list.length ? list : episodes || []).find((number) => number > episode);
      if (next) onEpisode(next);
    };
    video.addEventListener('ended', onEnded);

    return () => {
      window.clearInterval(timer);
      video.removeEventListener('ended', onEnded);
      if (hls) hls.destroy();
      else video.removeAttribute('src');
    };
    // position 只在首次挂载时生效，换集不该再跳回手机的位置
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, source, id, episode]);

  const numbers = list.length ? list : episodes || [];
  const index = numbers.indexOf(episode);
  const next = index >= 0 ? numbers[index + 1] : undefined;
  const prev = index > 0 ? numbers[index - 1] : undefined;

  return (
    <div className="page player-page">
      <header className="player-head">
        <button type="button" className="ghost back" onClick={onClose}>
          ← 返回
        </button>
        <div className="player-title">
          <h1>{title || '正在播放'}</h1>
          <p>
            {localTaskId ? '本地文件 · 合并成品' : `第 ${episode} 集${source === 'huangguo' ? ' · 私密模式' : ''}`}
          </p>
        </div>
        <div className="player-nav">
          {!localTaskId && (
            <>
              <button type="button" className="ghost" disabled={!prev} onClick={() => prev && onEpisode(prev)}>
                上一集
              </button>
              <button type="button" className="ghost" disabled={!next} onClick={() => next && onEpisode(next)}>
                下一集
              </button>
            </>
          )}
        </div>
      </header>

      <div className="player-stage">
        {error ? (
          <div className="player-error">
            <h3>播放失败</h3>
            <p>{error}</p>
            <button type="button" className="primary" onClick={() => setAttempt((value) => value + 1)}>
              重试
            </button>
          </div>
        ) : (
          <>
            <video ref={videoRef} controls playsInline />
            {loading && <div className="player-loading">正在准备播放…</div>}
          </>
        )}
      </div>

      <p className="player-hint">
        在线播放由本机解析；已下载的剧集请到「下载」页点「播放本地」，速度更快也不吃网络。
      </p>
    </div>
  );
}
