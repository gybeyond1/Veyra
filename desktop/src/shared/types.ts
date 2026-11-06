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
  /** 私密源通道：1 仅直连 / 2 仅代理 / 3 走后端转发（与手机端同一套语义） */
  proxyMode: 1 | 2 | 3;
  /** 私密内容源：huangguo = 内置网页解析，其它 = 后端网关（剧果/野果/帝果…） */
  privateSite: string;
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

/**
 * 其它设备（服务器/NAS、手机、电视、另一台电脑）上的下载任务。
 * 桌面端「下载」页把它们和本机任务并排显示，在线且已有成品时可以直接播。
 */
export interface RemoteTask {
  /** 唯一键：nas:<id> 或 <deviceId>:<taskId> */
  key: string;
  kind: 'nas' | 'android' | 'tv' | 'desktop';
  /** 设备名，NAS 任务为空 */
  deviceName: string;
  deviceId: string;
  /** 任务在它自己那一侧的 id（播 NAS 用的是这个） */
  remoteId: string;
  title: string;
  cover: string;
  status: string;
  percent: number;
  doneCount: number;
  totalCount: number;
  episodeCount: number;
  merged: boolean;
  online: boolean;
  /** 可播时的播放地址（局域网直连或本机媒体服务转发），不可播为空 */
  playUrl: string;
  /** 不可播的原因 */
  hint: string;
}

/** 详情页「下载到」下拉里的一项：本机 / NAS / 某台在线设备 / 远程存储。 */
export interface DownloadTarget {
  /** local | nas | device:<id> | storage:<id> */
  key: string;
  kind: 'local' | 'nas' | 'device' | 'storage';
  name: string;
  /** 补充说明：平台、在线状态、是否直传 */
  hint: string;
  platform?: string;
  online?: boolean;
  /** 选了能不能真的用（SMB 没中转设备时就不可用） */
  available: boolean;
}

export interface DownloadDispatchResult {
  mode: 'local' | 'nas' | 'device' | 'relay' | 'nas-upload';
  title: string;
  message: string;
  task?: DownloadTask;
}

export interface QrLoginState {
  url: string;
  code: string;
  expiresIn: number;
}

export interface SourceState {
  active: 'hongguo' | 'huangguo';
  unlocked: boolean;
  username: string;
}

export interface UpdateInfo {
  current: string;
  latest: string;
  url: string;
  notes: string;
  size: number;
  hasUpdate: boolean;
}

export interface ServerInfo {
  appVersion: string;
  platform: string;
  downloadDir: string;
  ffmpeg: string;
  serverDir: string;
  deviceName: string;
  lan?: string;
}

/** 渲染层可调用的方法签名。 */
export interface Api {
  'app.info': () => Promise<ServerInfo>;
  'app.settings': () => Promise<AppSettings>;
  'privateSite.sources': () => Promise<{ id: string; name: string; description?: string }[]>;
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

  'catalog.home': (payload?: { source?: string }) => Promise<HomePayload>;
  'devices.list': () => Promise<{ id: string; name: string; model?: string; platform?: string; online?: boolean; lastSeen?: number }[]>;
  'devices.rename': (payload: { id: string; name: string }) => Promise<unknown>;
  'devices.revoke': (payload: { id: string; code: string }) => Promise<unknown>;
  'catalog.cachedHome': (payload?: { source?: string }) => Promise<HomePayload | null>;
  'catalog.cachedCategory': (payload: { source?: string; type?: string; slug?: string; page?: number }) => Promise<CategoryPayload | null>;
  'catalog.cachedDetail': (payload: { source?: string; id: string }) => Promise<SeriesDetail | null>;
  'catalog.category': (payload: { source?: string; type?: string; slug?: string; page?: number }) => Promise<CategoryPayload>;
  'catalog.tags': (payload?: { source?: string }) => Promise<{ items: { name: string; slug: string; type: string }[] }>;
  'catalog.search': (payload: { source?: string; q: string }) => Promise<{ items: SeriesCard[] }>;
  'catalog.detail': (payload: { source?: string; id: string }) => Promise<SeriesDetail>;
  'catalog.play': (payload: { source?: string; id: string; episode: number }) => Promise<{ url: string; kind: 'hls' | 'file' }>;

  'source.state': () => Promise<SourceState>;
  'source.enter': (payload: { code: string }) => Promise<SourceState>;
  'source.leave': () => Promise<SourceState>;

  'update.check': () => Promise<UpdateInfo>;
  'update.install': (payload: { url: string }) => Promise<void>;

  'downloads.list': () => Promise<DownloadTask[]>;
  'downloads.create': (payload: { id: string; title: string; cover?: string; source?: string; episodes?: number[]; target?: string }) => Promise<DownloadDispatchResult>;
  'downloads.targets': () => Promise<DownloadTarget[]>;
  'downloads.remove': (payload: { id: string; deleteFiles?: boolean }) => Promise<void>;
  'downloads.merge': (payload: { id: string }) => Promise<DownloadTask>;
  'downloads.retry': (payload: { id: string }) => Promise<DownloadTask>;
  'downloads.openFolder': (payload: { id: string }) => Promise<void>;
  'downloads.play': (payload: { id: string; index?: number }) => Promise<{ url: string; rawUrl: string }>;
  'downloads.remote': () => Promise<RemoteTask[]>;

  /** 原生播放内核（mpv）：H.265 原片直放，不转码 */
  'player.mpvAvailable': () => Promise<boolean>;
  'player.mpvPlay': (payload: { url: string; title?: string; start?: number }) => Promise<{ ok: boolean; embedded: boolean }>;
  'player.mpvControl': (action: string, value?: number) => Promise<unknown>;
  'player.mpvStatus': () => Promise<{ position: number; duration: number; paused: boolean }>;
  'player.mpvClose': () => Promise<void>;

  'sync.pull': (payload?: { source?: 'hongguo' | 'huangguo' }) => Promise<{ payload: Record<string, unknown> }>;
  'sync.push': (payload: { library: Record<string, unknown> }) => Promise<{ ok: boolean; at: number }>;
}

export type ApiName = keyof Api;

export interface ApiResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}
