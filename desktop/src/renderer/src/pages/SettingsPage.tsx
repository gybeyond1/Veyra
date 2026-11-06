import { useEffect, useState } from 'react';
import type { AppSettings, ServerInfo, UpdateInfo } from '@shared/types';
import { formatBytes } from '../api';
import { call, errorText } from '../api';

interface Props {
  settings: AppSettings | null;
  notify: (text: string, tone?: 'info' | 'error') => void;
  onSaved: (settings: AppSettings) => void;
  onClose?: () => void;
}

export default function SettingsPage({ settings, notify, onSaved, onClose }: Props) {
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [draft, setDraft] = useState<AppSettings | null>(settings);
  const [saving, setSaving] = useState(false);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    call<ServerInfo>('app.info').then(setInfo).catch(() => undefined);
  }, []);

  useEffect(() => {
    setDraft(settings);
  }, [settings]);

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

  return (
    <div className="page settings-page">
      <div className="page-head">
        <div>
          <h1>设置</h1>
          <p>改动即时保存。下载目录和并发数对之后新建的任务生效。</p>
        </div>
        {onClose && (
          <button type="button" className="ghost" onClick={onClose}>
            关闭
          </button>
        )}
      </div>

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
        <h2>私密源通道</h2>
        <p className="hint">只影响黄果/私密模式；公开内容永远直连。切换立即生效。</p>
        <div className="mode-group">
          {[
            { value: 1 as const, title: '仅直连', desc: '用本机网络，失败直接报错' },
            { value: 2 as const, title: '仅代理', desc: '只用下面填的代理地址' },
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
            <p>形如 192.168.31.108:7893 或 http://127.0.0.1:7890，仅「仅代理」时使用。</p>
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
                : '安装包由后端从 GitHub Release 同步，国内也能直接下载。'}
            </p>
            {update?.notes && <p className="hint">{update.notes}</p>}
          </div>
          <div className="row-ctrl">
            <button type="button" className="ghost" onClick={checkUpdate} disabled={checking}>
              {checking ? '检查中…' : '检查更新'}
            </button>
            {update?.hasUpdate && update.url && (
              <button
                type="button"
                className="primary"
                onClick={() => void call('update.install', { url: update.url }).catch((issue) => notify(errorText(issue), 'error'))}
              >
                下载新版
              </button>
            )}
            {update?.hasUpdate && !update.url && <span className="hint">安装包还在准备，稍后再点一次</span>}
          </div>
        </div>
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
  );
}
