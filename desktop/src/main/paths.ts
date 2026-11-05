import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';

export const isDev = !app.isPackaged;
export const devServerUrl = process.env.VEYRA_DEV_SERVER || '';

export const userDataDir = app.getPath('userData');

/** 仓库里的 server/*.js：开发时直接引用，打包后随 extraResources 放在 resources/server。 */
export function serverDir(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, 'server');
  return path.resolve(__dirname, '../../../server');
}

/** 自带 ffmpeg：Windows 包里是 ffmpeg.exe，其余平台同名，开发时优先系统 PATH。 */
export function bundledFfmpeg(): string {
  const name = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  return app.isPackaged
    ? path.join(process.resourcesPath, 'ffmpeg', name)
    : path.join(__dirname, '../../../desktop/resources/ffmpeg', name);
}

export function ffmpegAvailable(): string {
  const bundled = bundledFfmpeg();
  if (fs.existsSync(bundled)) return bundled;
  return 'ffmpeg';
}

/** 自带 mpv：自带完整 ffmpeg，H.265/AV1/10bit 都能硬解，放原片不用转码。 */
export function bundledMpv(): string {
  const name = process.platform === 'win32' ? 'mpv.exe' : 'mpv';
  return app.isPackaged
    ? path.join(process.resourcesPath, 'mpv', name)
    : path.join(__dirname, '../../../desktop/resources/mpv', name);
}

/** 没内置就用系统装的；都没有返回空，调用方退回 Chromium 播放。 */
export function mpvAvailable(): string {
  const bundled = bundledMpv();
  if (fs.existsSync(bundled)) return bundled;
  const exe = process.platform === 'win32' ? 'mpv.exe' : 'mpv';
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, exe);
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* 目录没权限，跳过 */
    }
  }
  return '';
}

export function ensureDir(dir: string): string {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* 调用方自己决定失败后怎么办 */
  }
  return dir;
}

/**
 * 下载器在 require 时就把 DATA_DIR / DOWNLOAD_DIR 读进模块常量，
 * 所以必须在加载 server/downloader.js 之前设好环境变量。
 */
export function primeRuntimeEnv(runtime: { dataDir: string; downloadDir: string }): void {
  process.env.DATA_DIR = ensureDir(runtime.dataDir);
  process.env.DOWNLOAD_DIR = ensureDir(runtime.downloadDir);
  const bundled = bundledFfmpeg();
  if (fs.existsSync(bundled)) {
    process.env.PATH = `${path.dirname(bundled)}${path.delimiter}${process.env.PATH || ''}`;
  }
}

export function deviceName(): string {
  const os = require('node:os') as typeof import('node:os');
  return os.hostname().replace(/\.local$/i, '') || '我的电脑';
}

/** 局域网 IPv4：扫码登录要把地址给手机，必须挑手机能访问的那张网卡。 */
export function lanAddress(): string {
  const os = require('node:os') as typeof import('node:os');
  const nets = os.networkInterfaces();
  const candidates: { address: string; score: number }[] = [];
  for (const [name, list] of Object.entries(nets)) {
    for (const net of list || []) {
      if (net.family !== 'IPv4' || net.internal) continue;
      let score = 0;
      if (/^192\.168\./.test(net.address)) score = 3;
      else if (/^10\./.test(net.address)) score = 2;
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(net.address)) score = 1;
      if (/docker|vEthernet|VMware|VirtualBox|Loopback/i.test(name)) score -= 5;
      candidates.push({ address: net.address, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.address || '127.0.0.1';
}
