import { useEffect, useRef, useState } from 'react';
import type { AppSettings, QrLoginState, SessionState } from '@shared/types';
import { call, errorText } from '../api';

interface Props {
  settings: AppSettings | null;
  notify: (text: string, tone?: 'info' | 'error') => void;
  onLogged: (session: SessionState, settings?: AppSettings) => void;
}

type Mode = 'password' | 'qr' | 'register';

export default function LoginPage({ settings, notify, onLogged }: Props) {
  const [mode, setMode] = useState<Mode>('password');
  const [server, setServer] = useState(settings?.server || '');
  const [username, setUsername] = useState(settings?.lastAccount || '');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [qr, setQr] = useState<(QrLoginState & { svg?: string }) | null>(null);
  const [qrLeft, setQrLeft] = useState(0);
  const qrTimer = useRef<number | null>(null);

  useEffect(() => {
    if (!qr) return;
    setQrLeft(qr.expiresIn || 300);
    qrTimer.current = window.setInterval(() => {
      setQrLeft((left) => {
        if (left <= 1) {
          window.clearInterval(qrTimer.current!);
          setQr(null);
          return 0;
        }
        return left - 1;
      });
    }, 1000);
    return () => {
      if (qrTimer.current) window.clearInterval(qrTimer.current);
    };
  }, [qr]);

  async function persistServer(next: string) {
    try {
      const saved = await call<AppSettings>('app.saveSettings', { server: next, lastAccount: username });
      return saved;
    } catch {
      return undefined;
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      const result =
        mode === 'register'
          ? await call<SessionState>('auth.register', { server, username, password, code })
          : await call<SessionState>('auth.login', { server, username, password });
      const saved = await persistServer(server);
      onLogged(result, saved);
      notify(`欢迎回来，${result.user?.username || username}`);
    } catch (issue) {
      setError(errorText(issue));
    } finally {
      setBusy(false);
    }
  }

  async function startQr() {
    setError('');
    setMode('qr');
    setBusy(true);
    try {
      const info = await call<QrLoginState & { svg: string }>('auth.qrStart');
      setQr(info);
    } catch (issue) {
      setError(errorText(issue));
    } finally {
      setBusy(false);
    }
  }

  async function cancelQr() {
    setQr(null);
    await call('auth.qrStop').catch(() => undefined);
    setMode('password');
  }

  return (
    <div className="login">
      <section className="login-hero">
        <div className="hero-glow" />
        <div className="hero-copy">
          <span className="brand-mark large">V</span>
          <h1>Veyra 桌面端</h1>
          <p>本地解析、下载、合并。整剧落盘成一个文件，账号与手机端同步。</p>
          <ul>
            <li>整剧多集并发下载，断点续传</li>
            <li>自动合并成单文件，直接可播</li>
            <li>手机扫码即可登录，不用敲密码</li>
          </ul>
        </div>
      </section>

      <section className="login-panel">
        <div className="login-card">
          <header>
            <h2>{mode === 'register' ? '注册账号' : '登录'}</h2>
            <p>数据存在你自己的服务器上，电脑只保存登录凭据。</p>
          </header>

          {mode === 'qr' ? (
            <div className="qr-box">
              {qr?.svg ? (
                <>
                  <div className="qr-image" dangerouslySetInnerHTML={{ __html: qr.svg }} />
                  <p className="qr-hint">
                    用手机 Veyra App 的「扫一扫」扫这个码
                    <br />
                    手机确认后电脑自动登录 · {Math.floor(qrLeft / 60)}:{String(qrLeft % 60).padStart(2, '0')}
                  </p>
                </>
              ) : (
                <div className="qr-loading">{busy ? '正在生成二维码…' : '二维码已过期'}</div>
              )}
              <div className="qr-actions">
                <button type="button" className="ghost" onClick={startQr} disabled={busy}>
                  刷新二维码
                </button>
                <button type="button" className="ghost" onClick={cancelQr}>
                  用密码登录
                </button>
              </div>
            </div>
          ) : (
            <form onSubmit={submit} className="login-form">
              <label>
                服务器地址
                <input
                  value={server}
                  onChange={(event) => setServer(event.target.value)}
                  placeholder="http://192.168.1.10:8080"
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <label>
                账号
                <input
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  placeholder="3–24 位字母、数字或下划线"
                  autoComplete="username"
                  spellCheck={false}
                />
              </label>
              <label>
                密码
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="登录密码"
                  autoComplete="current-password"
                />
              </label>
              {mode === 'register' && (
                <label>
                  管理员动态码
                  <input
                    value={code}
                    onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                    placeholder="6 位数字"
                    inputMode="numeric"
                  />
                </label>
              )}
              {error && <p className="form-error">{error}</p>}
              <button type="submit" className="primary block" disabled={busy}>
                {busy ? '请稍候…' : mode === 'register' ? '注册并登录' : '登录'}
              </button>
              <div className="login-alt">
                <button type="button" className="link" onClick={() => { setMode('password'); void startQr(); }}>
                  扫码登录
                </button>
                <span className="dot">·</span>
                <button
                  type="button"
                  className="link"
                  onClick={() => {
                    setMode(mode === 'register' ? 'password' : 'register');
                    setError('');
                  }}
                >
                  {mode === 'register' ? '返回登录' : '注册新账号'}
                </button>
              </div>
            </form>
          )}
        </div>
        <footer className="login-foot">Veyra · 自建短剧系统 · 内容版权归各源站所有</footer>
      </section>
    </div>
  );
}
