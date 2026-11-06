import { useState } from 'react';
import type { AccountUser } from '@shared/types';
import type { View } from '../App';

interface Props {
  view: View;
  user: AccountUser;
  server: string;
  source: 'hongguo' | 'huangguo';
  activeDownloads: number;
  onNav: (view: View) => void;
  onOpenSettings: () => void;
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
];

export default function Sidebar({
  view,
  user,
  server,
  source,
  activeDownloads,
  onNav,
  onOpenSettings,
}: Props) {
  const [avatarBroken, setAvatarBroken] = useState(false);
  const base = server.replace(/\/+$/, '');
  const avatar = !avatarBroken && base ? `${base}${user.avatar || `/api/avatar/${user.id}.jpg`}` : '';

  return (
    <aside className="sidebar">
      <div className="brand">
        <img className="brand-logo" src="./logo.png" alt="Veyra" />
        <div className="brand-text">
          <strong>Veyra</strong>
          <small>{source === 'huangguo' ? '私密模式' : '桌面端'}</small>
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
        {/* 点头像直接进设置：私密模式开关、退出登录都在里面，侧栏不再挂二级菜单 */}
        <button type="button" className="account" onClick={onOpenSettings} title="设置">
          <span className="avatar">
            {avatar && <img src={avatar} alt="" onError={() => setAvatarBroken(true)} />}
            <em>{(user.username || '?').slice(0, 1).toUpperCase()}</em>
          </span>
          <div className="account-meta">
            <strong>{user.username}</strong>
          </div>
        </button>
      </div>
    </aside>
  );
}
