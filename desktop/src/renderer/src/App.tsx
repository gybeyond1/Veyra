import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AppSettings, DownloadTask, RemoteTask, SessionState } from '@shared/types';
import { call, errorText } from './api';
import Sidebar from './components/Sidebar';
import IntroOverlay from './components/IntroOverlay';
import LoginPage from './pages/LoginPage';
import HomePage from './pages/HomePage';
import BrowsePage from './pages/BrowsePage';
import DetailPage from './pages/DetailPage';
import DownloadsPage from './pages/DownloadsPage';
import LibraryPage from './pages/LibraryPage';
import SettingsPage from './pages/SettingsPage';
import PlayerPage from './pages/PlayerPage';
import type { DetailFallback } from './pages/DetailPage';

export type View = 'home' | 'category' | 'search' | 'library' | 'detail' | 'downloads' | 'settings' | 'player';
export type Source = 'hongguo' | 'huangguo';

interface PlayerState {
  source: Source;
  id: string;
  episode: number;
  title: string;
  position?: number;
  /** 本地已下载任务：直接播合并成品，不再走在线解析 */
  localTaskId?: string;
  /** 其它设备（服务器 / 手机 / 电视 / 另一台电脑）上的成品，给了就直接播这个地址 */
  remoteUrl?: string;
}

export default function App() {
  const [booting, setBooting] = useState(true);
  const [session, setSession] = useState<SessionState>({ server: '', user: null });
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [view, setView] = useState<View>('home');
  const [source, setSource] = useState<Source>('hongguo');
  const [detailId, setDetailId] = useState('');
  const [detailFallback, setDetailFallback] = useState<DetailFallback | null>(null);
  const [player, setPlayer] = useState<PlayerState | null>(null);
  const [tasks, setTasks] = useState<DownloadTask[]>([]);
  const [remoteTasks, setRemoteTasks] = useState<RemoteTask[]>([]);
  const [searchSeed, setSearchSeed] = useState('');
  const [privateOpen, setPrivateOpen] = useState(false);
  const [privateCode, setPrivateCode] = useState('');
  const [privateBusy, setPrivateBusy] = useState(false);
  /** 动态码验证通过后先播启动动画，播完再切私密内容 */
  const [introOpen, setIntroOpen] = useState(false);
  /** 设置从侧栏挪进左下角头像菜单，这里是弹窗开关 */
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toast, setToast] = useState<{ text: string; tone: 'info' | 'error' } | null>(null);

  const notify = useCallback((text: string, tone: 'info' | 'error' = 'info') => {
    setToast({ text, tone });
    window.setTimeout(() => setToast((current) => (current?.text === text ? null : current)), 3200);
  }, []);

  const refreshTasks = useCallback(async () => {
    try {
      setTasks(await call<DownloadTask[]>('downloads.list'));
    } catch {
      /* 下载模块未就绪时静默 */
    }
  }, []);

  const refreshRemote = useCallback(async () => {
    try {
      setRemoteTasks(await call<RemoteTask[]>('downloads.remote'));
    } catch {
      /* 设备列表拉不到就保持原样，不要清空 */
    }
  }, []);

  // 下载页打开时刷新本机 + 其它设备，并每 15 秒跟一次进度
  useEffect(() => {
    if (view !== 'downloads') return;
    void refreshTasks();
    void refreshRemote();
    const timer = window.setInterval(() => void refreshRemote(), 15000);
    return () => window.clearInterval(timer);
  }, [view, refreshTasks, refreshRemote]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [state, config] = await Promise.all([
          call<SessionState>('auth.session'),
          call<AppSettings>('app.settings'),
        ]);
        if (!alive) return;
        setSession(state);
        setSettings(config);
        if (state.user) await refreshTasks();
      } catch (error) {
        notify(errorText(error), 'error');
      } finally {
        if (alive) setBooting(false);
      }
    })();
    const off = window.veyra.onEvent((event) => {
      if (event.type === 'downloads') setTasks(event.data as DownloadTask[]);
      if (event.type === 'auth') {
        const next = event.data as SessionState & { expired?: boolean };
        setSession(next);
        if (next.user) {
          setView('home');
          notify(`已登录：${next.user.username}`);
          void refreshTasks();
        } else if (next.expired) {
          notify('登录已失效，请重新登录', 'error');
        }
      }
      if (event.type === 'cast') {
        // 手机投屏：和电视端一样，直接在桌面播放器里接着播
        const payload = event.data as {
          source?: string;
          seriesId?: string;
          title?: string;
          episode?: number;
          position?: number;
        };
        if (!payload?.seriesId) return;
        if (payload.source === 'huangguo' && source !== 'huangguo') {
          notify('手机投的是私密内容，请先输入动态码进入私密模式', 'error');
          return;
        }
        setPlayer({
          source: payload.source === 'huangguo' ? 'huangguo' : 'hongguo',
          id: payload.seriesId,
          episode: Number(payload.episode) || 1,
          title: String(payload.title || '手机投屏'),
          position: Number(payload.position) || 0,
        });
        setView('player');
        notify('已接收手机投屏');
      }
    });
    return () => {
      alive = false;
      off();
    };
  }, [notify, refreshTasks, source]);

  const openDetail = useCallback((id: string, fallback?: DetailFallback) => {
    setDetailId(id);
    setDetailFallback(fallback || null);
    setView('detail');
  }, []);

  const startSearch = useCallback((keyword: string) => {
    setSearchSeed(keyword);
    setView('search');
  }, []);

  const play = useCallback(
    (id: string, episode: number, title: string) => {
      setPlayer({ source, id, episode, title });
      setView('player');
    },
    [source],
  );

  async function togglePrivate() {
    if (source === 'huangguo') {
      try {
        await call('source.leave');
        setSource('hongguo');
        setView('home');
        notify('已切回公开内容');
      } catch (error) {
        notify(errorText(error), 'error');
      }
      return;
    }
    setPrivateCode('');
    setPrivateOpen(true);
  }

  async function submitPrivate() {
    if (privateBusy) return;
    setPrivateBusy(true);
    try {
      await call('source.enter', { code: privateCode });
      setPrivateOpen(false);
      // 先放动画；切 source 的动作放到 onDone 里
      setIntroOpen(true);
    } catch (error) {
      notify(errorText(error), 'error');
    } finally {
      setPrivateBusy(false);
    }
  }

  const activeDownloads = useMemo(
    () => tasks.filter((task) => task.status === 'downloading' || task.status === 'merging' || task.status === 'queued'),
    [tasks],
  );

  if (booting) {
    return (
      <div className="boot">
        <div className="boot-mark">V</div>
        <p>正在启动…</p>
      </div>
    );
  }

  if (!session.user) {
    return (
      <LoginPage
        settings={settings}
        notify={notify}
        onLogged={(next, config) => {
          setSession(next);
          if (config) setSettings(config);
          setView('home');
          void refreshTasks();
        }}
      />
    );
  }

  return (
    <div className="app">
      <Sidebar
        view={view}
        user={session.user}
        server={session.server}
        source={source}
        activeDownloads={activeDownloads.length}
        onNav={(next) => setView(next)}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <main className="main">
        {view === 'home' && <HomePage source={source} onOpen={openDetail} onSearch={startSearch} />}
        {view === 'category' && <BrowsePage source={source} onOpen={openDetail} />}
        {view === 'search' && <BrowsePage mode="search" seed={searchSeed} source={source} onOpen={openDetail} />}
        {view === 'library' && <LibraryPage source={source} onOpen={openDetail} />}
        {view === 'detail' && (
          <DetailPage
            id={detailId}
            source={source}
            fallback={detailFallback}
            settings={settings}
            onBack={() => setView('home')}
            onDownloaded={refreshTasks}
            onPlay={(episode) => play(detailId, episode, detailFallback?.title || '')}
            notify={notify}
          />
        )}
        {view === 'player' && player && (
          <PlayerPage
            source={player.source}
            id={player.id}
            episode={player.episode}
            title={player.title}
            position={player.position}
            localTaskId={player.localTaskId}
            remoteUrl={player.remoteUrl}
            onClose={() => setView('detail')}
            onEpisode={(next) => setPlayer({ ...player, episode: next })}
            notify={notify}
          />
        )}
        {view === 'downloads' && (
          <DownloadsPage
            tasks={tasks.filter((task) => (task.source || 'hongguo') === source)}
            remote={remoteTasks}
            onRefresh={() => {
              void refreshTasks();
              void refreshRemote();
            }}
            onPlay={(task) => {
              setPlayer({ source: 'hongguo', id: task.seriesId || task.id, episode: 1, title: task.title, localTaskId: task.id });
              setView('player');
            }}
            onPlayRemote={(task) => {
              setPlayer({ source: 'hongguo', id: task.remoteId, episode: 1, title: task.title, remoteUrl: task.playUrl });
              setView('player');
            }}
            notify={notify}
          />
        )}
        {view === 'settings' && <div className="page" />}
      </main>

      {privateOpen && (
        <div className="modal-mask" onClick={() => !privateBusy && setPrivateOpen(false)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <h2>进入私密模式</h2>
            <p className="modal-desc">输入验证器里的 6 位动态码。桌面端每次启动后首次进入都需要验证。</p>
            <input
              className="private-code"
              value={privateCode}
              autoFocus
              inputMode="numeric"
              maxLength={6}
              placeholder="000000"
              onChange={(event) => setPrivateCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void submitPrivate();
              }}
            />
            <div className="modal-actions">
              <button type="button" className="ghost" onClick={() => setPrivateOpen(false)} disabled={privateBusy}>
                取消
              </button>
              <button type="button" className="primary" onClick={submitPrivate} disabled={privateBusy || privateCode.length !== 6}>
                {privateBusy ? '验证中…' : '解锁'}
              </button>
            </div>
          </div>
        </div>
      )}

      {settingsOpen && (
        <div className="modal-mask" onClick={() => setSettingsOpen(false)}>
          <div className="modal settings-modal" onClick={(event) => event.stopPropagation()}>
            <SettingsPage
              settings={settings}
              notify={notify}
              onSaved={(next) => setSettings(next)}
              onClose={() => setSettingsOpen(false)}
              source={source}
              onTogglePrivate={async () => {
                setSettingsOpen(false);
                await togglePrivate();
              }}
              onLogout={async () => {
                await call('auth.logout');
                setSettingsOpen(false);
                setSession({ server: session.server, user: null });
                setSource('hongguo');
                setTasks([]);
              }}
            />
          </div>
        </div>
      )}

      {introOpen && (
        <IntroOverlay
          onDone={() => {
            setIntroOpen(false);
            setSource('huangguo');
            setView('home');
            notify('已进入私密模式');
          }}
        />
      )}

      {toast && <div className={`toast ${toast.tone}`}>{toast.text}</div>}
    </div>
  );
}
