import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AppSettings, DownloadTask, SessionState } from '@shared/types';
import { call, errorText } from './api';
import Sidebar from './components/Sidebar';
import LoginPage from './pages/LoginPage';
import HomePage from './pages/HomePage';
import BrowsePage from './pages/BrowsePage';
import DetailPage from './pages/DetailPage';
import DownloadsPage from './pages/DownloadsPage';
import LibraryPage from './pages/LibraryPage';
import SettingsPage from './pages/SettingsPage';

export type View = 'home' | 'category' | 'search' | 'library' | 'detail' | 'downloads' | 'settings';

export default function App() {
  const [booting, setBooting] = useState(true);
  const [session, setSession] = useState<SessionState>({ server: '', user: null });
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [view, setView] = useState<View>('home');
  const [detailId, setDetailId] = useState('');
  const [detailFallback, setDetailFallback] = useState<{ title: string; cover: string } | null>(null);
  const [tasks, setTasks] = useState<DownloadTask[]>([]);
  const [searchSeed, setSearchSeed] = useState('');
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
        const next = event.data as SessionState;
        setSession(next);
        if (next.user) {
          setView('home');
          notify(`已登录：${next.user.username}`);
          void refreshTasks();
        }
      }
    });
    return () => {
      alive = false;
      off();
    };
  }, [notify, refreshTasks]);

  const openDetail = useCallback((id: string, fallback?: { title: string; cover: string }) => {
    setDetailId(id);
    setDetailFallback(fallback || null);
    setView('detail');
  }, []);

  const startSearch = useCallback((keyword: string) => {
    setSearchSeed(keyword);
    setView('search');
  }, []);

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
        activeDownloads={activeDownloads.length}
        onNav={(next) => setView(next)}
        onLogout={async () => {
          await call('auth.logout');
          setSession({ server: session.server, user: null });
          setTasks([]);
        }}
      />

      <main className="main">
        {view === 'home' && <HomePage onOpen={openDetail} onSearch={startSearch} />}
        {view === 'category' && <BrowsePage onOpen={openDetail} />}
        {view === 'search' && <BrowsePage mode="search" seed={searchSeed} onOpen={openDetail} />}
        {view === 'library' && <LibraryPage onOpen={openDetail} />}
        {view === 'detail' && (
          <DetailPage
            id={detailId}
            fallback={detailFallback}
            settings={settings}
            onBack={() => setView('home')}
            onDownloaded={refreshTasks}
            notify={notify}
          />
        )}
        {view === 'downloads' && (
          <DownloadsPage tasks={tasks} onRefresh={refreshTasks} notify={notify} />
        )}
        {view === 'settings' && (
          <SettingsPage
            settings={settings}
            notify={notify}
            onSaved={(next) => setSettings(next)}
          />
        )}
      </main>

      {toast && <div className={`toast ${toast.tone}`}>{toast.text}</div>}
    </div>
  );
}
