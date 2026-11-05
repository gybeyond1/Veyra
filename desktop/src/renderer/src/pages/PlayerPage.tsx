import { useEffect, useMemo, useRef, useState } from 'react';
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
  /** 别的设备上的成品直接播只有声音没画面时，切到「转码版」再放一次 */
  const [remoteFallback, setRemoteFallback] = useState(false);
  /** 当前这一集是不是正在本机转码（只影响提示文案） */
  const [transcoding, setTranscoding] = useState(false);
  /** 未转码的原始地址，给 mpv 用 */
  const [rawUrl, setRawUrl] = useState('');
  /** 这台机器有没有带 mpv（有就能原片直放，彻底不转码） */
  const [nativeOk, setNativeOk] = useState(false);

  useEffect(() => {
    call<boolean>('player.mpvAvailable')
      .then((flag) => setNativeOk(flag === true))
      .catch(() => setNativeOk(false));
  }, []);

  /**
   * 这台机器的 Chromium 能不能直接解 H.265。
   * Electron 内置的 Chromium 不带 HEVC 解码器，Windows 上只有系统装了 HEVC 扩展、
   * 内核走系统解码器时才能直放；Linux 基本没有。能直放就绝不转码。
   */
  const hevcOk = useMemo(() => {
    try {
      const probe = document.createElement('video');
      // hvc1 / hev1 是同一个编码的两种封装标记，都要问一遍
      return (
        probe.canPlayType('video/mp4; codecs="hvc1.1.6.L93.B0"') !== '' ||
        probe.canPlayType('video/mp4; codecs="hev1.1.6.L93.B0"') !== ''
      );
    } catch {
      return false;
    }
  }, []);

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

    // 别的设备上的成品：本机能解 H.265 就原样播（零转码、可随意拖进度）；
    // 本机解不了就直接走转码版，不要先黑屏失败一次再回退
    if (remoteUrl) {
      const transcode = !hevcOk || remoteFallback;
      setTranscoding(transcode);
      setRawUrl(remoteUrl);
      setKind(transcode ? 'hls' : 'file');
      setUrl(transcode ? `${remoteUrl}${remoteUrl.includes('?') ? '&' : '?'}h264=1` : remoteUrl);
      setLoading(transcode);
      return () => {
        alive = false;
      };
    }

    const job = localTaskId
      ? call<{ url: string; rawUrl?: string }>('downloads.play', { id: localTaskId, index: 0, hevc: hevcOk })
      : call<{ url: string; kind: 'hls' | 'file' }>('catalog.play', { source, id, episode, hevc: hevcOk });
    job
      .then((result) => {
        if (!alive) return;
        const nextKind = (result as { kind?: 'hls' | 'file' }).kind;
        setKind(nextKind === 'hls' ? 'hls' : 'file');
        setUrl(result.url);
        setRawUrl((result as { rawUrl?: string }).rawUrl || result.url);
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
  }, [source, id, episode, localTaskId, remoteUrl, attempt, hevcOk, remoteFallback]);

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

    // 远端成品如是 H.265：有声音、进度在走，但 videoWidth 永远是 0。
    // 这里一旦发现「能播但没画面」，就切到媒体服务的转码版重来一次。
    const checkPicture = () => {
      if (video.videoWidth > 0) {
        // 转码场景遮罩要留到第一帧真的出来，别让人对着黑屏猜
        setLoading(false);
        return;
      }
      if (!remoteUrl || remoteFallback) return;
      setRemoteFallback(true);
    };
    const onPictureError = () => {
      setLoading(false);
      if (!remoteUrl || remoteFallback) return;
      if (video.error && video.error.code === 4) setRemoteFallback(true);
    };
    video.addEventListener('loadeddata', checkPicture);
    video.addEventListener('error', onPictureError);

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
      video.removeEventListener('loadeddata', checkPicture);
      video.removeEventListener('error', onPictureError);
      if (hls) hls.destroy();
      else video.removeAttribute('src');
    };
    // position 只在首次挂载时生效，换集不该再跳回手机的位置
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, kind, source, id, episode, remoteUrl, remoteFallback]);

  const numbers = list.length ? list : episodes || [];
  const index = numbers.indexOf(episode);
  const next = index >= 0 ? numbers[index + 1] : undefined;
  const prev = index > 0 ? numbers[index - 1] : undefined;

  /** 交给 mpv：不吃 Chromium 的解码能力，H.265 原片硬解，零转码 */
  const openNative = async () => {
    const target = rawUrl || url;
    if (!target) return;
    try {
      const saved = Number(localStorage.getItem(`pos:${source}:${id}:${episode}`) || 0);
      // 交给 mpv 之后把内置播放器停下，不然两路声音一起响
      videoRef.current?.pause();
      await call('player.mpvPlay', { url: target, title, start: saved });
      notify('已用原生内核打开：原片直放，不转码', 'info');
    } catch (issue) {
      notify(errorText(issue), 'error');
    }
  };

  // 只有本地成品和其它设备上的成品能交给 mpv；在线流是加密的，它解不了
  const canNative = nativeOk && Boolean(localTaskId || remoteUrl);

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
                ? `其它设备 · 在线播放${transcoding ? ' · 本机转码' : ' · 原片直放'}`
                : `第 ${episode} 集${source === 'huangguo' ? ' · 私密模式' : ''}`}
          </p>
        </div>
        <div className="player-nav">
          {canNative && (
            <button type="button" className={transcoding ? 'primary' : 'ghost'} onClick={openNative}>
              原片直放
            </button>
          )}
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
                <p>
                  {transcoding ? '本机正在转码' : '正在准备播放'}…{waited > 0 ? `（${waited}s）` : ''}
                </p>
                {transcoding ? (
                  <p className="player-loading-sub">
                    这集是 H.265，内置内核解不了，就在这台电脑上转成 H.264；转过的会缓存，下次快很多。
                    {canNative ? '不想等的话，点右上角「原片直放」，用原生内核硬解，零转码。' : ''}
                  </p>
                ) : (
                  waited >= 3 && <p className="player-loading-sub">首次播放要先解密，通常几秒</p>
                )}
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
