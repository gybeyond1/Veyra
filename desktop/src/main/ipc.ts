import { BrowserWindow, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
interface DeviceRow {
  id: string;
  name: string;
  model?: string;
  platform?: string;
  online?: boolean;
  lastSeen?: number;
}

import type { Api, ApiName, ApiResult, AppSettings, DownloadTask, SessionState, UpdateInfo } from '../shared/types';
import { requestJson } from './http';
import { readSettings, writeSettings } from './store';
import { session, normalizeServer } from './session';
import * as auth from './auth';
import * as catalog from './catalog';
import * as remoteSite from './remote-site';
import * as downloads from './downloads';
import * as remote from './remote';
import * as qrlogin from './qrlogin';
import * as source from './source';
import * as update from './update';
import * as device from './device';
import * as mpv from './mpv';
import { info as mediaInfo, fileUrl, prepareLocal } from './media';
import { setEmitter } from './bus';
import { deviceName, ffmpegAvailable, isDev, lanAddress, serverDir, userDataDir } from './paths';

let mainWindow: BrowserWindow | null = null;
let progressTimer: NodeJS.Timeout | null = null;
let lastProgressSignature = '';

export function bindWindow(win: BrowserWindow): void {
  mainWindow = win;
}

/**
 * 启动后跟服务器核一次会话。
 * 网络不通时 auth.restore 会保留本地会话（离线也能看已下载内容），
 * 只有服务器明确回 401/403 才真的踢人。
 */
export async function restoreSession(): Promise<void> {
  const before = session();
  if (!before) return;
  try {
    const result = await auth.restore();
    const changed = (before.user?.id || '') !== (result.state.user?.id || '');
    if (changed) {
      // user 变空说明服务器判定凭据失效，带上标记让界面提示一句，别让人莫名其妙回到登录页
      emit('auth', { ...result.state, expired: !result.state.user });
    }
    if (result.error) console.warn('[auth] 会话校验：' + result.error);
  } catch (error) {
    console.warn('[auth] 会话校验失败', (error as Error).message);
  }
}

function emit(type: string, data: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('ve:event', { type, data });
  }
}

setEmitter(emit);

function state(): SessionState {
  const current = session();
  return { server: current?.server || '', user: current?.user || null };
}

function requireOnline(): { server: string; token: string } {
  const current = session();
  if (!current) throw new Error('请先登录账号');
  return { server: current.server, token: current.token };
}

function settings(): AppSettings {
  return readSettings();
}

const handlers: { [K in ApiName]: (...args: any[]) => any } = {
  'app.info': () => ({
    appVersion: __APP_VERSION__,
    platform: process.platform,
    downloadDir: readSettings().downloadDir,
    ffmpeg: ffmpegAvailable(),
    serverDir: serverDir(),
    deviceName: deviceName(),
    lan: mediaInfo().lan,
  }),

  'app.settings': () => settings(),

  // 后端支持的私密内容源（剧果/野果/帝果…）；黄果是内置源，前端自己补一项
  'privateSite.sources': () => remoteSite.sources(),

  'app.saveSettings': (patch: Partial<AppSettings>) => {
    const next = writeSettings(patch);
    downloads.configureDownloads();
    return next;
  },

  'app.pickDownloadDir': async () => {
    const result = await dialog.showOpenDialog(mainWindow || undefined!, {
      title: '选择下载目录',
      defaultPath: settings().downloadDir,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return settings().downloadDir;
    const dir = result.filePaths[0];
    writeSettings({ downloadDir: dir });
    try {
      downloads.configureDownloads();
    } catch (error) {
      console.warn('[settings] 切换下载目录失败', error);
    }
    return dir;
  },

  'app.openPath': async (target: string) => {
    const info = await shell.openPath(target);
    if (info) throw new Error(info);
  },

  'app.revealFile': async (target: string) => {
    if (!target) return;
    if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
      await shell.openPath(target);
      return;
    }
    shell.showItemInFolder(target);
  },

  'app.logs': () => {
    const file = path.join(userDataDir, 'logs', 'desktop.log');
    try {
      const text = fs.readFileSync(file, 'utf8');
      return text.split('\n').slice(-400);
    } catch {
      return [];
    }
  },

  'auth.session': () => state(),
  'auth.login': async (payload: { server: string; username: string; password: string }) => {
    const next = await auth.login(payload);
    device.refresh();
    return next;
  },
  'auth.register': async (payload: { server: string; username: string; password: string; code?: string }) => {
    const next = await auth.register(payload);
    device.refresh();
    return next;
  },
  'auth.logout': async () => {
    await auth.logout();
    source.reset();
    emit('auth', { server: '', user: null });
  },
  'auth.qrStart': async () => {
    const info = await qrlogin.start();
    return { ...info, svg: await qrlogin.qrSvg(info.url) };
  },
  'auth.qrStop': () => qrlogin.stop(),

  'catalog.home': (payload?: { source?: string }) => catalog.home(source.requireSource(payload?.source)),
  // 上一轮的结果：渲染层先拿它铺满界面，新数据回来再整体替换（不闪骨架屏）
  'catalog.cachedHome': (payload?: { source?: string }) =>
    catalog.cachedHome(source.requireSource(payload?.source)),
  'catalog.cachedCategory': (payload: { source?: string; type?: string; slug?: string; page?: number }) =>
    catalog.cachedCategory(source.requireSource(payload?.source), payload),
  'catalog.cachedDetail': (payload: { source?: string; id: string }) =>
    catalog.cachedDetail(source.requireSource(payload?.source), payload.id),
  'catalog.category': (payload: { source?: string; type?: string; slug?: string; page?: number }) =>
    catalog.category(source.requireSource(payload?.source), payload),
  'catalog.tags': (payload?: { source?: string }) => catalog.tags(source.requireSource(payload?.source)),
  'catalog.search': (payload: { source?: string; q: string }) =>
    catalog.search(source.requireSource(payload?.source), payload.q),
  'catalog.detail': (payload: { source?: string; id: string }) =>
    catalog.detail(source.requireSource(payload?.source), payload.id),
  'catalog.play': (payload: { source?: string; id: string; episode: number; hevc?: boolean }) =>
    catalog.play(source.requireSource(payload?.source), payload.id, payload.episode, payload?.hevc === true),

  'source.state': () => source.state(),
  'source.enter': (payload: { code: string }) => source.enterPrivate(payload.code),
  'source.leave': () => source.leavePrivate(),

  'update.check': () => update.check(),
  'update.install': async (payload: { url: string; latest?: string }) => {
    if (!/^https?:\/\//i.test(payload.url)) throw new Error('下载地址无效');
    // 内置下载：下到临时目录后直接拉起安装程序，不再把用户甩给浏览器
    return update.install(payload.url, String(payload.latest || ''));
  },

  /* 设备管理：改名不需要动态码；移除会让那台设备退出登录，需要 6 位动态码 */
  'devices.list': async () => {
    const current = session();
    if (!current) throw new Error('请先登录');
    const data = await requestJson<{ devices?: DeviceRow[] }>(current.server, '/api/devices', {
      token: current.token,
      timeoutMs: 10000,
    });
    return Array.isArray(data?.devices) ? data.devices : [];
  },
  'devices.rename': async (payload: { id: string; name: string }) => {
    const current = session();
    if (!current) throw new Error('请先登录');
    return requestJson(current.server, '/api/devices/rename', {
      method: 'POST',
      body: { id: payload?.id, name: payload?.name },
      token: current.token,
      timeoutMs: 10000,
    });
  },
  'devices.revoke': async (payload: { id: string; code: string }) => {
    const current = session();
    if (!current) throw new Error('请先登录');
    return requestJson(current.server, `/api/devices/${encodeURIComponent(payload?.id || '')}`, {
      method: 'DELETE',
      body: { code: payload?.code },
      token: current.token,
      timeoutMs: 10000,
    });
  },

  'downloads.list': () => downloads.list(),
  'downloads.create': (payload) => downloads.create(payload),
  'downloads.targets': () => downloads.targets(),
  'downloads.remove': (payload: { id: string }) => {
    downloads.remove(payload.id);
  },
  'downloads.merge': (payload: { id: string }) => downloads.merge(payload.id),
  'downloads.retry': (payload: { id: string }) => downloads.retry(payload.id),
  'downloads.openFolder': async (payload: { id: string }) => {
    const dir = downloads.taskFolder(payload.id);
    if (fs.existsSync(dir)) await shell.openPath(dir);
  },
  'downloads.remote': () => remote.list(),

  'downloads.play': async (payload: { id: string; index?: number; hevc?: boolean }) => {
    const task = downloads.list().find((item) => item.id === payload.id);
    if (!task) throw new Error('任务不存在');
    const index = Number(payload.index) || 0;
    const needH264 = payload?.hevc !== true;
    // 和在线播放一样：放不了 H.265 就先转一份 H.264，转完再给地址
    if (needH264) await prepareLocal(payload.id, index);
    return { url: fileUrl(payload.id, index, needH264), rawUrl: fileUrl(payload.id, index, false) };
  },

  'player.mpvAvailable': () => Boolean(mpv.available()),

  'player.mpvPlay': async (payload: { url: string; title?: string; start?: number }) => {
    if (!payload?.url) throw new Error('播放地址为空');
    const start = Number(payload.start) || 0;
    return mpv.play({ url: payload.url, title: payload.title, start, parent: mainWindow });
  },

  'player.mpvControl': (action: string, value?: number) => mpv.control(action, value),

  'player.mpvStatus': () => mpv.status(),

  'player.mpvClose': () => {
    mpv.close();
  },

  'sync.pull': async (payload?: { source?: 'hongguo' | 'huangguo' }) => {
    const { server, token } = requireOnline();
    const source = payload?.source === 'huangguo' ? 'huangguo' : 'hongguo';
    return requestJson<{ payload: Record<string, unknown> }>(server, `/api/library?source=${source}`, { token });
  },

  'sync.push': async (payload: { library: Record<string, unknown> }) => {
    const { server, token } = requireOnline();
    const base = normalizeServer(server);
    const result = await requestJson<{ synced: boolean; updatedAt: number }>(base, '/api/library', {
      method: 'PUT',
      token,
      body: { source: 'hongguo', payload: payload.library },
    });
    return { ok: !!result?.synced, at: Number(result?.updatedAt) || Date.now() };
  },
};

export function registerIpc(): void {
  ipcMain.handle('ve:call', async (_event, method: ApiName, ...args: unknown[]): Promise<ApiResult> => {
    const handler = handlers[method];
    if (!handler) return { ok: false, error: `未知操作：${String(method)}` };
    try {
      const data = await (handler as (...input: unknown[]) => unknown)(...args);
      return { ok: true, data };
    } catch (error) {
      const message = (error as Error)?.message || String(error);
      console.warn(`[ipc] ${method} 失败：${message}`, (error as Error)?.stack || '');
      return { ok: false, error: message };
    }
  });

  qrlogin.setQrLoginListener((next) => {
    emit('auth', next);
  });
}

/* 开了「自动合并」时，下载完成（ready）后立刻排队合并；同一个任务只触发一次。 */
const autoMerged = new Set<string>();

function autoMergeReady(tasks: DownloadTask[]): void {
  if (!readSettings().autoMerge) return;
  for (const task of tasks) {
    if (task.status !== 'ready' || autoMerged.has(task.id)) continue;
    autoMerged.add(task.id);
    try {
      downloads.merge(task.id);
      console.log('[download] 自动合并', task.title);
    } catch (error) {
      autoMerged.delete(task.id);
      console.warn('[download] 自动合并失败', (error as Error).message);
    }
  }
}

/** 下载进度：下载器没有事件回调，1.2 秒轮询一次，只有变化才推给界面。 */
export function startProgressLoop(): void {
  if (progressTimer) clearInterval(progressTimer);
  progressTimer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    let tasks: DownloadTask[] = [];
    try {
      tasks = downloads.list();
    } catch {
      return;
    }
    autoMergeReady(tasks);
    const active = tasks.filter((task) => task.status === 'downloading' || task.status === 'merging' || task.status === 'queued');
    const signature = JSON.stringify(
      tasks.map((task) => [task.id, task.status, task.percent, task.doneCount, task.failedEpisodes.length]),
    );
    const percent = active.length ? Math.max(...active.map((task) => task.percent || 0)) : -1;
    try {
      mainWindow.setProgressBar(percent >= 0 ? Math.min(1, percent / 100) : -1);
    } catch {
      /* 某些桌面环境不支持任务栏进度 */
    }
    if (signature === lastProgressSignature) return;
    lastProgressSignature = signature;
    emit('downloads', tasks);
    // 任务状态变了就顺手刷新设备上报，手机上能尽快看到电脑的下载进度
    device.refresh();
  }, 1200);
}

export function stopProgressLoop(): void {
  if (progressTimer) clearInterval(progressTimer);
  progressTimer = null;
}
