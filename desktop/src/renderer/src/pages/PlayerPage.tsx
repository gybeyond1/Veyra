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
}

/**
 * 桌面端播放器。
 *
 * 在线内容不直接连源站：交给主进程的媒体服务转一手（hls.js 带不了 Referer，
 * 红果的 CENC 流浏览器也解不了）。本地已下载的 mp4 走同一个服务的 /file。
 */
export default function PlayerPage({ source, id, episode, title, position, localTaskId, remoteUrl, episodes, onClose, onEpisode }: Props) {
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
  /**
   * 这一集是 CENC 加密的：后端给了远端直链和内容密钥。
   * 有它就能把地址直接交给 mpv 边下边解（可拖进度），不用等整集落盘。
   */
  const [decrypt, setDecrypt] = useState<{ url: string; key: string } | null>(null);
  /** 滚轮切集的上一次触发时间：一次拨动会连发好几帧 wheel，必须节流 */
  const wheelAt = useRef(0);
  /** 加密集：地址秒回但首帧还要等，loading 遮罩先别撤 */
  const holdLoading = useRef(false);

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
    setDecrypt(null);
    holdLoading.current = false;

    // 别的设备上的成品：本机能解 H.265 就原样播（零转码、可随意拖进度）；
    // 本机解不了就直接走转码版，不要先黑屏失败一次再回退
    if (remoteUrl) {
      const transcode = !hevcOk || remoteFallback;
      setTranscoding(transcode);
      setKind(transcode ? 'hls' : 'file');
      setUrl(transcode ? `${remoteUrl}${remoteUrl.includes('?') ? '&' : '?'}h264=1` : remoteUrl);
      setLoading(transcode);
      return () => {
        alive = false;
      };
    }

    const job = localTaskId
      ? call<{ url: string; rawUrl?: string }>('downloads.play', { id: localTaskId, index: 0, hevc: hevcOk })
      : call<{ url: string; kind: 'hls' | 'file' | 'stream'; decrypt?: { url: string; key: string } }>('catalog.play', { source, id, episode, hevc: hevcOk });
    job
      .then((result) => {
        if (!alive) return;
        const nextKind = (result as { kind?: 'hls' | 'file' | 'stream' }).kind;
        setKind(nextKind === 'hls' ? 'hls' : 'file');
        const encrypted = (result as { decrypt?: { url: string; key: string } }).decrypt || null;
        setDecrypt(encrypted);
        // 加密集的地址是秒回的，遮罩要留到第一帧出来（loadeddata 那边才撤）
        holdLoading.current = Boolean(encrypted);
        setUrl(result.url);
      })
      .catch((issue) => {
        if (alive) setError(errorText(issue));
      })
      .finally(() => {
        if (alive && !holdLoading.current) setLoading(false);
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
    // 边下边解时地址是秒回的，遮罩不能跟着地址一起收 —— 等第一帧真的解出来再撤
    const onReady = () => setLoading(false);
    video.addEventListener('loadeddata', onReady);

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
      if (remoteUrl) {
        if (!remoteFallback && video.error && video.error.code === 4) setRemoteFallback(true);
        return;
      }
      // 加密流边下边解失败（密钥过期 / ffmpeg 起不来）：把原因摆出来，别一直转圈
      const code = video.error?.code;
      setError(code === 4 ? '这一集解不出来，密钥可能已过期，点「重试」重新取一次地址' : '这一集播放失败，点「重试」再试一次');
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
      video.removeEventListener('loadeddata', onReady);
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

  /**
   * 滚轮切集：向下滚下一集，向上滚上一集。
   * 600ms 内只认一次 —— 触控板/滚轮一次拨动会连着发好几个 wheel 事件，
   * 不节流就会一口气跳过五六集。本地成品和其它设备的成品是单个文件，不切。
   */
  const onWheel = (event: React.WheelEvent) => {
    if (localTaskId || remoteUrl) return;
    if (Math.abs(event.deltaY) < 8) return;
    const now = Date.now();
    if (now - wheelAt.current < 600) return;
    const target = event.deltaY > 0 ? next : prev;
    if (!target) return;
    wheelAt.current = now;
    onEpisode(target);
  };

  return (
    <div className="page player-page" onWheel={onWheel}>
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
                ? `其它设备 · 在线播放${transcoding ? ' · 本机转码' : ' · 不转码'}`
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
                <p>
                  {transcoding ? '本机正在转码' : '正在准备播放'}…{waited > 0 ? `（${waited}s）` : ''}
                </p>
                {transcoding ? (
                  <p className="player-loading-sub">
                    这集是 H.265，内置内核解不了，就在这台电脑上转成 H.264；转过的会缓存，下次快很多。
                  </p>
                ) : (
                  waited >= 3 && (
                    <p className="player-loading-sub">
                      这集是加密的，正在边下边解，通常几秒出画面
                    </p>
                  )
                )}
              </div>
            )}
          </>
        )}
      </div>

      <p className="player-hint">
        在线播放由本机解析；滚轮上下可以切换上一集 / 下一集。已下载的剧集在「我的 · 下载」里点「播放本地」，速度更快也不吃网络。
      </p>
    </div>
  );
}
