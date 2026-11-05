/** 主进程与渲染层共用的类型与 IPC 契约。 */

export interface AccountUser {
  id: string;
  username: string;
  role: 'admin' | 'vip' | 'user' | string;
  avatar?: string;
  createdAt?: number;
}

export interface SessionState {
  server: string;
  user: AccountUser | null;
  /** 扫码登录只推会话，不保存密码；密码登录时用于自动续期 */
  savedPassword?: boolean;
}

export interface AppSettings {
  server: string;
  downloadDir: string;
  concurrency: number;
  theme: 'dark' | 'light';
  proxy: string;
  autoMerge: boolean;
  keepEpisodes: boolean;
  lastAccount: string;
}

export interface SeriesCard {
  id: string;
  title: string;
  cover: string;
  description?: string;
  badge?: string;
  episodeCount?: number;
  tags?: string[];
  score?: string;
  type?: string;
}

export interface HomePayload {
  slides: SeriesCard[];
  homepageRecommend: SeriesCard[];
  homepageNewest: SeriesCard[];
}

export interface CategoryPayload {
  items: SeriesCard[];
  title?: string;
  total?: number;
  page?: number;
  hasMore?: boolean;
}

export interface SeriesDetail {
  id: string;
  title: string;
  cover: string;
  description: string;
  score: string;
  episodeLabel: string;
  episodes: number[];
  tags?: string[];
  vids?: string[];
  category?: string;
}

export interface DownloadEpisode {
  index: number;
  url?: string;
  key?: string;
}

export interface DownloadTask {
  id: string;
  source: string;
  title: string;
  seriesId: string;
  cover: string;
  status: 'queued' | 'running' | 'merging' | 'done' | 'error' | 'paused' | string;
  output: string;
  error: string;
  progress: { phase: string; episode: number; total: number; percent: number; detail: string };
  failedEpisodes: { index: number; error: string }[];
  createdAt: number;
  updatedAt: number;
  episodeCount: number;
  percent: number;
  detail: string;
  doneCount: number;
  totalCount: number;
}

export interface QrLoginState {
  url: string;
  code: string;
  expiresIn: number;
}

export interface ServerInfo {
  appVersion: string;
  platform: string;
  downloadDir: string;
  ffmpeg: string;
  serverDir: string;
  deviceName: string;
}

/** 渲染层可调用的方法签名。 */
export interface Api {
  'app.info': () => Promise<ServerInfo>;
  'app.settings': () => Promise<AppSettings>;
  'app.saveSettings': (patch: Partial<AppSettings>) => Promise<AppSettings>;
  'app.pickDownloadDir': () => Promise<string>;
  'app.openPath': (target: string) => Promise<void>;
  'app.revealFile': (target: string) => Promise<void>;
  'app.logs': () => Promise<string[]>;

  'auth.session': () => Promise<SessionState>;
  'auth.login': (payload: { server: string; username: string; password: string }) => Promise<SessionState>;
  'auth.register': (payload: { server: string; username: string; password: string; code?: string }) => Promise<SessionState>;
  'auth.logout': () => Promise<void>;
  'auth.qrStart': () => Promise<QrLoginState>;
  'auth.qrStop': () => Promise<void>;

  'catalog.home': () => Promise<HomePayload>;
  'catalog.category': (payload: { type?: string; slug?: string; page?: number }) => Promise<CategoryPayload>;
  'catalog.tags': () => Promise<{ items: { name: string; slug: string; type: string }[] }>;
  'catalog.search': (payload: { q: string }) => Promise<{ items: SeriesCard[] }>;
  'catalog.detail': (payload: { id: string }) => Promise<SeriesDetail>;

  'downloads.list': () => Promise<DownloadTask[]>;
  'downloads.create': (payload: { id: string; title: string; cover?: string; source?: string; episodes?: number[] }) => Promise<DownloadTask>;
  'downloads.remove': (payload: { id: string; deleteFiles?: boolean }) => Promise<void>;
  'downloads.merge': (payload: { id: string }) => Promise<DownloadTask>;
  'downloads.retry': (payload: { id: string }) => Promise<DownloadTask>;
  'downloads.openFolder': (payload: { id: string }) => Promise<void>;

  'sync.pull': () => Promise<{ payload: Record<string, unknown> }>;
  'sync.push': (payload: { library: Record<string, unknown> }) => Promise<{ ok: boolean; at: number }>;
}

export type ApiName = keyof Api;

export interface ApiResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}
