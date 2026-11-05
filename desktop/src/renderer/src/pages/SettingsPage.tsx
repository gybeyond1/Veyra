import { useEffect, useState } from 'react';
import type { AppSettings, ServerInfo } from '@shared/types';
import { call, errorText } from '../api';

interface Props {
  settings: AppSettings | null;
  notify: (text: string, tone?: 'info' | 'error') => void;
  onSaved: (settings: AppSettings) => void;
}

export default function SettingsPage({ settings, notify, onSaved }: Props) {
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [draft, setDraft] = useState<AppSettings | null>(settings);
  const [saving, setSaving] = useState(false);

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
        <h1>设置</h1>
        <p>改动即时保存。下载目录和并发数对之后新建的任务生效。</p>
      </div>

      <section className="panel">
        <h2>账号</h2>
        <div className="row">
          <div>
            <strong>服务器</strong>
            <p>{draft.server || '未设置'}</p>
          </div>
        </div>
        <p className="hint">换服务器需要先退出登录，再在登录页填写新地址。</p>
      </section>

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
        <h2>网络</h2>
        <div className="row">
          <div>
            <strong>出站代理</strong>
            <p>形如 http://127.0.0.1:7890，留空表示直连。用于部分源站的线路。</p>
          </div>
          <input
            className="text"
            value={draft.proxy}
            placeholder="留空直连"
            onChange={(event) => setDraft({ ...draft, proxy: event.target.value })}
            onBlur={() => save({ proxy: draft.proxy })}
          />
        </div>
      </section>

      <section className="panel">
        <h2>关于</h2>
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
