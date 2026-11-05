import { BrowserWindow, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import type { Api, ApiName, ApiResult, AppSettings, DownloadTask, SessionState } from '../shared/types';
import { requestJson } from './http';
import { readSettings, writeSettings } from './store';
import { session, normalizeServer } from './session';
import * as auth from './auth';
import * as catalog from './catalog';
import * as downloads from './downloads';
import * as qrlogin from './qrlogin';
import { deviceName, ffmpegAvailable, isDev, serverDir, userDataDir } from './paths';

let mainWindow: BrowserWindow | null = null;
let progressTimer: NodeJS.Timeout | null = null;
let lastProgressSignature = '';

export function bindWindow(win: BrowserWindow): void {
  mainWindow = win;
}

function emit(type: string, data: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('ve:event', { type, data });
  }
}

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
    downloadDir: downloads.list().length ? readSettings().downloadDir : readSettings().downloadDir,
    ffmpeg: ffmpegAvailable(),
    serverDir: serverDir(),
    deviceName: deviceName(),
  }),

  'app.settings': () => settings(),

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
  'auth.login': (payload: { server: string; username: string; password: string }) => auth.login(payload),
  'auth.register': (payload: { server: string; username: string; password: string; code?: string }) => auth.register(payload),
  'auth.logout': async () => {
    await auth.logout();
    emit('auth', { server: '', user: null });
  },
  'auth.qrStart': async () => {
    const info = await qrlogin.start();
    return { ...info, svg: await qrlogin.qrSvg(info.url) };
  },
  'auth.qrStop': () => qrlogin.stop(),

  'catalog.home': () => catalog.home(),
  'catalog.category': (payload: { type?: string; slug?: string; page?: number }) => catalog.category(payload),
  'catalog.tags': () => catalog.tags(),
  'catalog.search': (payload: { q: string }) => catalog.search(payload.q),
  'catalog.detail': (payload: { id: string }) => catalog.detail(payload.id),

  'downloads.list': () => downloads.list(),
  'downloads.create': (payload) => downloads.create(payload),
  'downloads.remove': (payload: { id: string }) => {
    downloads.remove(payload.id);
  },
  'downloads.merge': (payload: { id: string }) => downloads.merge(payload.id),
  'downloads.retry': (payload: { id: string }) => downloads.retry(payload.id),
  'downloads.openFolder': async (payload: { id: string }) => {
    const dir = downloads.taskFolder(payload.id);
    if (fs.existsSync(dir)) await shell.openPath(dir);
  },

  'sync.pull': async () => {
    const { server, token } = requireOnline();
    return requestJson<{ payload: Record<string, unknown> }>(server, '/api/library?source=hongguo', { token });
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
      console.warn(`[ipc] ${method} 失败：${message}`);
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
  }, 1200);
}

export function stopProgressLoop(): void {
  if (progressTimer) clearInterval(progressTimer);
  progressTimer = null;
}
