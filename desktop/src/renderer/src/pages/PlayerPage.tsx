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
  /** 其它设备上的成品地址（局域网直连或本机媒体服务转发），给了就直接播它 */
  remoteUrl?: string;
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
export default function PlayerPage({ source, id, episode, title, position, localTaskId, remoteUrl, episodes, onClose, onEpisode, notify }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [url, setUrl] = useState('');
  const [kind, setKind] = useState<'hls' | 'file'>('file');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [waited, setWaited] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [list, setList] = useState<number[]>(episodes || []);

  // 解密/取流期间给个秒数，别让人以为卡死了
  useEffect(() => {
    if (!loading) return;
    setWaited(0);
    const timer = window.setInterval(() => setWaited((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [loading, episode, attempt]);

  // 没从详情页带集数过来（例如手机投屏）时，自己拉一次，保证「下一集」可用
  useEffect(() => {
    if (localTaskId || remoteUrl || (episodes && episodes.length)) return;
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

    // 别的设备上的成品是现成 mp4，直接播，不用再解析
    if (remoteUrl) {
      setKind('file');
      setUrl(remoteUrl);
      setLoading(false);
      return () => {
        alive = false;
      };
    }

    const job = localTaskId
      ? call<{ url: string }>('downloads.play', { id: localTaskId, index: 0 })
      : call<{ url: string; kind: 'hls' | 'file' }>('catalog.play', { source, id, episode });
    job
      .then((result) => {
        if (!alive) return;
        const nextKind = (result as { kind?: 'hls' | 'file' }).kind;
        setKind(nextKind === 'hls' ? 'hls' : 'file');
        setUrl(result.url);
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
  }, [source, id, episode, localTaskId, remoteUrl, attempt]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !url) return;
    let hls: Hls | null = null;

    // 服务端已经告诉我们这是 m3u8 还是 mp4：m3u8 必须走 hls.js，直接塞给 video 只会一直转圈
    if (kind === 'hls' && Hls.isSupported()) {
      // 关掉 worker：打包后的页面是 file:// 源，CSP/Blob worker 在个别机器上会被拦，
      // 拦了以后 hls.js 没有任何提示地停住。多线程解码这点收益不值得冒这个风险。
      hls = new Hls({ enableWorker: false, lowLatencyMode: false, maxBufferLength: 30 });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) return;
        hls?.destroy();
        hls = null;
        setError(`流解析失败（${data.details || data.type}）`);
      });
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
  }, [url, kind, source, id, episode]);

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
            {localTaskId
              ? '本地文件 · 合并成品'
              : remoteUrl
                ? '其它设备 · 在线播放'
                : `第 ${episode} 集${source === 'huangguo' ? ' · 私密模式' : ''}`}
          </p>
        </div>
        <div className="player-nav">
          {!localTaskId && !remoteUrl && (
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
            <video ref={videoRef} controls playsInline preload="auto" />
            {loading && (
              <div className="player-loading">
                <p>正在准备播放…{waited > 0 ? `（${waited}s）` : ''}</p>
                {waited >= 3 && <p className="player-loading-sub">红果加密集需要先解密成 mp4，通常 3–10 秒，稍等一下</p>}
              </div>
            )}
          </>
        )}
      </div>

      <p className="player-hint">
        在线播放由本机解析；已下载的剧集请到「下载」页点「播放本地」，速度更快也不吃网络。
      </p>
    </div>
  );
}
