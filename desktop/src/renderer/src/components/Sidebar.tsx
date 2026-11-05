import type { AccountUser } from '@shared/types';
import type { View } from '../App';

interface Props {
  view: View;
  user: AccountUser;
  server: string;
  source: 'hongguo' | 'huangguo';
  activeDownloads: number;
  onNav: (view: View) => void;
  onPrivate: () => void;
  onLogout: () => void;
}

const items: { key: View; label: string; icon: JSX.Element }[] = [
  {
    key: 'home',
    label: '首页',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z" />
      </svg>
    ),
  },
  {
    key: 'category',
    label: '分类',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <rect x="4" y="4" width="7" height="7" rx="1.5" />
        <rect x="13" y="4" width="7" height="7" rx="1.5" />
        <rect x="4" y="13" width="7" height="7" rx="1.5" />
        <rect x="13" y="13" width="7" height="7" rx="1.5" />
      </svg>
    ),
  },
  {
    key: 'search',
    label: '搜索',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <circle cx="11" cy="11" r="6.5" />
        <path d="m16 16 4 4" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    key: 'library',
    label: '我的',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M6 4.5h9.5a2 2 0 0 1 2 2V20l-6.5-3.6L4.5 20V6.5a2 2 0 0 1 1.5-2z" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    key: 'downloads',
    label: '下载',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M12 4v11m0 0 4-4m-4 4-4-4" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M5 19h14" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    key: 'settings',
    label: '设置',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <circle cx="12" cy="12" r="3.2" />
        <path d="M12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6" strokeLinecap="round" />
      </svg>
    ),
  },
];

export default function Sidebar({ view, user, server, source, activeDownloads, onNav, onPrivate, onLogout }: Props) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark">V</span>
        <div className="brand-text">
          <strong>Veyra</strong>
          <small>桌面端</small>
        </div>
      </div>

      <nav className="nav">
        {items.map((item) => (
          <button
            key={item.key}
            type="button"
            className={`nav-item${view === item.key || (view === 'detail' && item.key === 'home') ? ' active' : ''}`}
            onClick={() => onNav(item.key)}
          >
            <span className="nav-icon">{item.icon}</span>
            <span>{item.label}</span>
            {item.key === 'downloads' && activeDownloads > 0 && (
              <span className="nav-badge">{activeDownloads}</span>
            )}
          </button>
        ))}
      </nav>

      <div className="side-bottom">
        <button
          type="button"
          className={`private-toggle${source === 'huangguo' ? ' on' : ''}`}
          onClick={onPrivate}
          title={source === 'huangguo' ? '切回公开内容' : '输入动态码进入私密模式'}
        >
          <span className="lock">{source === 'huangguo' ? '🔓' : '🔒'}</span>
          <span>{source === 'huangguo' ? '私密模式 · 已开启' : '私密模式'}</span>
        </button>
        <div className="side-foot">
          <div className="account">
          <span className="avatar">{(user.username || '?').slice(0, 1).toUpperCase()}</span>
          <div className="account-meta">
            <strong>{user.username}</strong>
            <small title={server}>{server.replace(/^https?:\/\//, '')}</small>
          </div>
        </div>
          <button type="button" className="ghost tiny" onClick={onLogout}>
            退出
          </button>
        </div>
      </div>
    </aside>
  );
}
