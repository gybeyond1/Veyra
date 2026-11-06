import { useEffect, useState } from 'react';
import type { AppSettings, ServerInfo, UpdateInfo } from '@shared/types';
import { formatBytes } from '../api';
import { call, errorText } from '../api';

interface Props {
  settings: AppSettings | null;
  notify: (text: string, tone?: 'info' | 'error') => void;
  onSaved: (settings: AppSettings) => void;
  onClose?: () => void;
  /** 当前内容源：决定「私密模式」按钮显示进入还是返回 */
  source: 'hongguo' | 'huangguo';
  onTogglePrivate: () => void;
  onLogout: () => void;
}

export default function SettingsPage({ settings, notify, onSaved, onClose, source, onTogglePrivate, onLogout }: Props) {
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [draft, setDraft] = useState<AppSettings | null>(settings);
  const [saving, setSaving] = useState(false);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [progress, setProgress] = useState<{ phase: string; percent: number } | null>(null);

  useEffect(() => {
    call<ServerInfo>('app.info').then(setInfo).catch(() => undefined);
  }, []);

  useEffect(() => {
    setDraft(settings);
  }, [settings]);

  /* 内置下载的进度：主进程一边下一边推，这里只管显示 */
  useEffect(() => {
    const off = window.veyra.onEvent((event) => {
      if (event.type !== 'update') return;
      const data = event.data as { phase?: string; percent?: number };
      setProgress({ phase: String(data?.phase || ''), percent: Number(data?.percent) || 0 });
      if (data?.phase === 'installing') notify('安装包已下载，正在启动安装程序');
    });
    return off;
  }, [notify]);

  if (!draft) return <div className="page" />;

  async function save(patch: Partial<AppSettings>) {
    if (!draft) return;
    const next = { ...draft, ...patch };
    setDraft(next);
    setSaving(true);
    try {
      const saved = await call<AppSettings>('app.saveSettings', patch);
      onSaved(saved);
      notify('设置已保存');
    } catch (issue) {
      notify(errorText(issue), 'error');
    } finally {
      setSaving(false);
    }
  }

  async function checkUpdate() {
    if (checking) return;
    setChecking(true);
    try {
      const result = await call<UpdateInfo>('update.check');
      setUpdate(result);
      if (!result.hasUpdate) notify(`已是最新版本 ${result.current}`);
    } catch (issue) {
      notify(errorText(issue), 'error');
    } finally {
      setChecking(false);
    }
  }

  async function installUpdate() {
    if (!update?.url) return;
    setProgress({ phase: 'downloading', percent: 0 });
    try {
      await call('update.install', { url: update.url, latest: update.latest });
    } catch (issue) {
      setProgress(null);
      notify(errorText(issue), 'error');
    }
  }

  async function pickDir() {
    if (!draft) return;
    try {
      const dir = await call<string>('app.pickDownloadDir');
      const next = { ...draft, downloadDir: dir };
      setDraft(next);
      onSaved(next);
      notify('下载目录已切换');
    } catch (issue) {
      notify(errorText(issue), 'error');
    }
  }

  const downloading = progress?.phase === 'downloading';

  return (
    <div className="settings-shell">
      {/* 关闭按钮固定在右上角：内容再长也不用滚回顶部才能关 */}
      {onClose && (
        <button type="button" className="settings-close" onClick={onClose} aria-label="关闭设置">
          ✕
        </button>
      )}
      <div className="settings-scroll">
        <div className="page settings-page">
          <div className="page-head">
            <div>
              <h1>设置</h1>
              <p>改动即时保存。下载目录和并发数对之后新建的任务生效。</p>
            </div>
          </div>

          <section className="panel">
            <h2>账号</h2>
            <div className="row">
              <div>
                <strong>私密模式</strong>
                <p>
                  {source === 'huangguo'
                    ? '当前在私密内容里，切回公开内容不需要验证。'
                    : '进入私密内容需要输入验证器里的 6 位动态码。'}
                </p>
              </div>
              <div className="row-ctrl">
                <button type="button" className={source === 'huangguo' ? 'ghost' : 'primary'} onClick={onTogglePrivate}>
                  {source === 'huangguo' ? '返回公开模式' : '进入私密模式'}
                </button>
              </div>
            </div>
            <div className="row">
              <div>
                <strong>退出登录</strong>
                <p>退出后这台电脑会回到登录页，下载任务和本地文件都保留。</p>
              </div>
              <div className="row-ctrl">
                <button type="button" className="ghost danger-text" onClick={onLogout}>
                  退出登录
                </button>
              </div>
            </div>
          </section>

          <DevicePanel notify={notify} />

          {source === 'huangguo' && <PrivateSitePanel notify={notify} />}

          <section className="panel">
            <h2>下载</h2>
            <div className="row">
              <div>
                <strong>下载目录</strong>
                <p className="path" title={draft.downloadDir}>{draft.downloadDir}</p>
              </div>
              <button type="button" className="ghost" onClick={pickDir}>
                选择目录
              </button>
            </div>
            <div className="row">
              <div>
                <strong>并发集数</strong>
                <p>同时下载几集。太高容易被源站限速，家宽一般 4–8 合适。</p>
              </div>
              <div className="row-ctrl">
                <input
                  type="range"
                  min={1}
                  max={16}
                  value={draft.concurrency}
                  onChange={(event) => setDraft({ ...draft, concurrency: Number(event.target.value) })}
                  onMouseUp={() => save({ concurrency: draft.concurrency })}
                />
                <span className="mono">{draft.concurrency}</span>
              </div>
            </div>
            <div className="row">
              <div>
                <strong>下载完成后自动合并</strong>
                <p>把整剧合成为一个单文件，分集文件是否保留见下一条。</p>
              </div>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={draft.autoMerge}
                  onChange={(event) => save({ autoMerge: event.target.checked })}
                />
                <span />
              </label>
            </div>
            <div className="row">
              <div>
                <strong>合并后保留分集</strong>
                <p>关掉时只留整剧单文件，能省一半空间。</p>
              </div>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={draft.keepEpisodes}
                  onChange={(event) => save({ keepEpisodes: event.target.checked })}
                />
                <span />
              </label>
            </div>
          </section>

          <section className="panel">
            <h2>私密网络模式</h2>
            <p className="hint">只影响私密模式，对所选内容源全部有效；公开内容永远直连。切换立即生效。</p>
            <div className="mode-group">
              {[
                { value: 1 as const, title: '仅直连', desc: '用本机网络，失败直接报错' },
                { value: 2 as const, title: '仅代理', desc: '黄果用下面地址，其它源由服务器走同一地址' },
                { value: 3 as const, title: '走后端转发', desc: '由服务器代取，服务器可配代理' },
              ].map((item) => (
                <button
                  key={item.value}
                  type="button"
                  className={`mode-option${draft.proxyMode === item.value ? ' active' : ''}`}
                  onClick={() => save({ proxyMode: item.value })}
                >
                  <strong>{item.title}</strong>
                  <small>{item.desc}</small>
                </button>
              ))}
            </div>
            <div className="row">
              <div>
                <strong>代理地址</strong>
                <p>形如 192.168.31.108:7893 或 http://127.0.0.1:7890，仅「仅代理」时使用；会一并交给服务器代取。</p>
              </div>
              <input
                className="text"
                value={draft.proxy}
                placeholder="host:port"
                disabled={draft.proxyMode !== 2}
                onChange={(event) => setDraft({ ...draft, proxy: event.target.value })}
                onBlur={() => save({ proxy: draft.proxy })}
              />
            </div>
          </section>

          <section className="panel">
            <h2>关于与更新</h2>
            <div className="row">
              <div>
                <strong>当前版本 {info?.appVersion || '—'}</strong>
                <p>
                  {update
                    ? update.hasUpdate
                      ? `发现新版本 ${update.latest}${update.size ? ` · ${formatBytes(update.size)}` : ''}`
                      : `已是最新版本 ${update.latest}`
                    : '直接下载到本机临时目录，下完自动启动安装程序。'}
                </p>
                {update?.notes && <p className="hint">{update.notes}</p>}
              </div>
              <div className="row-ctrl">
                <button type="button" className="ghost" onClick={checkUpdate} disabled={checking || downloading}>
                  {checking ? '检查中…' : '检查更新'}
                </button>
                {update?.hasUpdate && update.url && !downloading && (
                  <button type="button" className="primary" onClick={installUpdate}>
                    下载并安装
                  </button>
                )}
                {downloading && <span className="hint">下载中 {progress?.percent || 0}%</span>}
                {update?.hasUpdate && !update.url && <span className="hint">安装包还在准备，稍后再点一次</span>}
              </div>
            </div>
            {downloading && (
              <div className="update-track">
                <i style={{ width: `${progress?.percent || 0}%` }} />
              </div>
            )}
            <div className="about">
              <p>
                <span>版本</span>
                <strong>{info?.appVersion || '—'}</strong>
              </p>
              <p>
                <span>设备名</span>
                <strong>{info?.deviceName || '—'}</strong>
              </p>
              <p>
                <span>ffmpeg</span>
                <strong className="path">{info?.ffmpeg || '—'}</strong>
              </p>
              <p>
                <span>下载模块</span>
                <strong className="path">{info?.serverDir || '—'}</strong>
              </p>
            </div>
            <p className="hint">日志：用户数据目录下 logs/desktop.log，排查问题直接把最后几十行发过来。</p>
          </section>

          {saving && <div className="saving">正在保存…</div>}
        </div>
      </div>
    </div>
  );
}

interface DeviceRow {
  id: string;
  name: string;
  model?: string;
  platform?: string;
  online?: boolean;
  lastSeen?: number;
}

const PLATFORM_NAME: Record<string, string> = { android: '手机/平板', tv: '电视', desktop: '电脑' };

/**
 * 设备管理：同账号下的所有设备都在这里。
 * 改名只动显示名；移除 = 让那台设备退出登录，所以必须当场输入 6 位动态码。
 */
function DevicePanel({ notify }: { notify: (text: string, tone?: 'info' | 'error') => void }) {
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState('');
  const [draftName, setDraftName] = useState('');
  const [removing, setRemoving] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  const reload = async () => {
    try {
      setDevices(await call<DeviceRow[]>('devices.list'));
    } catch (issue) {
      notify(errorText(issue), 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function rename(id: string) {
    const name = draftName.trim();
    if (!name) {
      notify('设备名不能为空', 'error');
      return;
    }
    setBusy(true);
    try {
      await call('devices.rename', { id, name });
      setEditing('');
      await reload();
      notify('已改名');
    } catch (issue) {
      notify(errorText(issue), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    if (code.replace(/\D/g, '').length !== 6) {
      notify('请输入 6 位动态码', 'error');
      return;
    }
    setBusy(true);
    try {
      await call('devices.revoke', { id, code });
      setRemoving('');
      setCode('');
      await reload();
      notify('设备已移除，它会退出登录');
    } catch (issue) {
      notify(errorText(issue), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <h2>设备管理</h2>
      <p className="hint">同账号的设备都在这里。改名只是好认；移除会让那台设备退出登录，需要动态码。</p>
      {loading && <p className="hint">读取设备列表…</p>}
      {!loading && !devices.length && <p className="hint">还没有其它设备上报过。</p>}
      {devices.map((device) => (
        <div className="device-row" key={device.id}>
          <div className="device-main">
            <strong>{device.name || '未命名设备'}</strong>
            <p>
              {[PLATFORM_NAME[device.platform || 'android'] || device.platform, device.model, device.online ? '在线' : '离线']
                .filter(Boolean)
                .join(' · ')}
            </p>
          </div>
          {editing === device.id ? (
            <div className="row-ctrl">
              <input
                className="text"
                value={draftName}
                maxLength={24}
                autoFocus
                onChange={(event) => setDraftName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void rename(device.id);
                  if (event.key === 'Escape') setEditing('');
                }}
              />
              <button type="button" className="primary" disabled={busy} onClick={() => void rename(device.id)}>
                保存
              </button>
              <button type="button" className="ghost" onClick={() => setEditing('')}>
                取消
              </button>
            </div>
          ) : (
            <div className="row-ctrl">
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  setEditing(device.id);
                  setDraftName(device.name || '');
                  setRemoving('');
                }}
              >
                改名
              </button>
              <button
                type="button"
                className="ghost danger-text"
                onClick={() => {
                  setRemoving(removing === device.id ? '' : device.id);
                  setCode('');
                  setEditing('');
                }}
              >
                移除
              </button>
            </div>
          )}
          {removing === device.id && (
            <div className="device-remove">
              <span>输入验证器里的 6 位动态码确认移除</span>
              <input
                className="text"
                inputMode="numeric"
                maxLength={6}
                placeholder="000000"
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
              />
              <button type="button" className="primary" disabled={busy || code.length !== 6} onClick={() => void revoke(device.id)}>
                确认移除
              </button>
            </div>
          )}
        </div>
      ))}
    </section>
  );
}

interface SiteRow {
  id: string;
  name: string;
  description?: string;
}

/**
 * 私密内容源：黄果是内置解析（直连/代理/走后端），其余源由后端网关统一解析。
 * 切换后整页重载：首页/分类/详情的缓存都按源存，混着显示比刷新一次更难受。
 */
function PrivateSitePanel({ notify }: { notify: (text: string, tone?: 'info' | 'error') => void }) {
  const [sites, setSites] = useState<SiteRow[]>([]);
  const [current, setCurrent] = useState('huangguo');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    call<AppSettings>('app.settings')
      .then((data) => setCurrent(String(data?.privateSite || 'huangguo')))
      .catch(() => undefined);
    call<SiteRow[]>('privateSite.sources')
      .then((rows) => setSites(Array.isArray(rows) ? rows : []))
      .catch(() => setSites([]));
  }, []);

  async function pick(id: string) {
    if (id === current || busy) return;
    setBusy(true);
    try {
      await call('app.saveSettings', { privateSite: id });
      notify('已切换内容源，正在刷新');
      // 换源等于换一套内容：缓存、片单、当前页全部重来，重载最干净
      setTimeout(() => location.reload(), 260);
    } catch (issue) {
      notify(errorText(issue), 'error');
      setBusy(false);
    }
  }

  const rows: SiteRow[] = [
    { id: 'huangguo', name: '黄果', description: '视频 · AI · 旧版（直连 / 代理 / 后端）' },
    ...sites.filter((row) => row.id && row.id !== 'huangguo'),
  ];

  return (
    <section className="panel">
      <h2>私密内容源</h2>
      <p className="hint">黄果在本机解析（直连/代理/走后端）；其它源由服务器解析，需要登录同一个账号。</p>
      <div className="site-picker">
        {rows.map((row) => (
          <button
            key={row.id}
            type="button"
            className={`site-choice${row.id === current ? ' is-active' : ''}`}
            disabled={busy}
            onClick={() => void pick(row.id)}
          >
            <strong>{row.name}</strong>
            <small>{row.description || ''}</small>
          </button>
        ))}
      </div>
    </section>
  );
}
