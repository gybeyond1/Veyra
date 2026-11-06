import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { app } from 'electron';
import type { UpdateInfo } from '../shared/types';
import { requestJson } from './http';
import { session } from './session';
import { emitEvent } from './bus';

/** 比较 x.y.z；返回 >0 表示 a 比 b 新。 */
function compare(a: string, b: string): number {
  const left = String(a || '0').split('.').map((part) => Number(part) || 0);
  const right = String(b || '0').split('.').map((part) => Number(part) || 0);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] || 0) - (right[index] || 0);
    if (diff) return diff;
  }
  return 0;
}

/**
 * 检测更新：优先问自己的后端（后端会从 GitHub Release 拉安装包并缓存，
 * 国内直连 GitHub 基本不可用，用户只可能从这里下得动）。
 */
export async function check(): Promise<UpdateInfo> {
  const current = session();
  if (!current) throw new Error('请先登录账号');
  const currentVersion = __APP_VERSION__;
  const data = await requestJson<{ version?: string; url?: string; notes?: string; size?: number }>(
    current.server,
    '/api/app/latest?platform=desktop',
    { token: current.token, timeoutMs: 15000 },
  );
  const latest = String(data?.version || currentVersion);
  const rawUrl = String(data?.url || '');
  const url = rawUrl.startsWith('http') ? rawUrl : rawUrl ? new URL(rawUrl, current.server).toString() : '';
  return {
    current: currentVersion,
    latest,
    url,
    notes: String(data?.notes || ''),
    size: Number(data?.size) || 0,
    // 后端知道有新版但安装包还在路上时 url 为空，这时也算「有更新」，界面提示稍后再点
    hasUpdate: compare(latest, currentVersion) > 0,
  };
}

/**
 * 内置下载安装包。
 *
 * 以前这里是 shell.openExternal 把链接丢给浏览器，用户得在浏览器里下完、
 * 再去下载目录双击 —— 桌面端自己有能力做这件事，不该把人赶出去。
 * 下载到临时目录，进度通过事件推给设置页，下完直接拉起安装程序。
 */
export function install(url: string, latest: string): Promise<{ file: string }> {
  if (!/^https?:\/\//i.test(url)) return Promise.reject(new Error('下载地址无效'));
  const dir = path.join(app.getPath('temp'), 'veyra-update');
  fs.mkdirSync(dir, { recursive: true });
  const name = `Veyra-${String(latest || '').replace(/[^0-9.]/g, '') || 'setup'}-setup.exe`;
  const file = path.join(dir, name);
  const partial = `${file}.part`;

  return new Promise((resolve, reject) => {
    const follow = (target: string, redirects = 0): void => {
      if (redirects > 5) {
        reject(new Error('下载地址重定向太多次'));
        return;
      }
      const lib = target.startsWith('https:') ? https : http;
      const request = lib.get(target, { headers: { 'User-Agent': 'Veyra-Desktop/updater' }, timeout: 30000 }, (response) => {
        const status = response.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
          response.resume();
          follow(new URL(response.headers.location, target).toString(), redirects + 1);
          return;
        }
        if (status !== 200) {
          response.resume();
          reject(new Error(`安装包下载失败（HTTP ${status}）`));
          return;
        }
        const total = Number(response.headers['content-length']) || 0;
        let done = 0;
        let lastEmit = 0;
        const output = fs.createWriteStream(partial);
        response.on('data', (chunk: Buffer) => {
          done += chunk.length;
          const now = Date.now();
          if (now - lastEmit > 250) {
            lastEmit = now;
            const percent = total ? Math.min(99, Math.floor((done / total) * 100)) : 0;
            emitEvent('update', { phase: 'downloading', percent, done, total });
          }
        });
        response.pipe(output);
        // 等 close 再动文件：Windows 上句柄没关就 spawn 会读不到内容
        output.on('close', () => {
          if (total && done !== total) {
            try { fs.rmSync(partial, { force: true }); } catch { /* 残文件 */ }
            reject(new Error('下载不完整，请重试'));
            return;
          }
          try {
            fs.renameSync(partial, file);
          } catch (error) {
            reject(error as Error);
            return;
          }
          emitEvent('update', { phase: 'installing', percent: 100 });
          try {
            // detached：安装程序要能在本进程退出后继续跑（安装时通常要求关掉主程序）
            spawn(file, [], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
          } catch (error) {
            reject(new Error('下载完成但打不开安装程序：' + (error as Error).message));
            return;
          }
          resolve({ file });
        });
        output.on('error', (error) => reject(error));
      });
      request.on('timeout', () => request.destroy(new Error('下载超时')));
      request.on('error', (error) => reject(new Error('下载失败：' + error.message)));
    };
    follow(url);
  });
}

/** 下载完成后由渲染层决定何时退出，这里给一个延迟退出的入口（安装程序会等主程序关掉）。 */
export function quitSoon(): void {
  setTimeout(() => app.quit(), 1200);
}
