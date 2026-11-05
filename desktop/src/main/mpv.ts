import { BrowserWindow } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { mpvAvailable, userDataDir } from './paths';

/**
 * 原生播放内核（mpv）。
 *
 * Chromium 不带 HEVC 解码器，H.265 只能先转码；mpv 自带完整 ffmpeg，
 * 直接硬解原片，零转码、进度条随便拖。做法是起一个 mpv 进程，
 * 用 --wid 把画面绑到一个 Electron 窗口上，再用 JSON IPC 控制。
 *
 * 没有 mpv 二进制时（没打包/没装）直接返回不可用，调用方退回 Chromium 播放。
 */

let proc: ChildProcess | null = null;
let host: BrowserWindow | null = null;
let sock: net.Socket | null = null;
let socketPath = '';
let seq = 0;
/** 播放序号：用来给每次播放分配独立的 socket 名 */
let session = 0;
let buffered = '';
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

function pipePath(): string {
  // 每次播放换一个名字：上一个实例退出时会顺手删掉自己的 socket，
  // 如果复用同一个路径，会出现「新实例的 socket 被旧实例删掉」的竞态
  session += 1;
  if (process.platform === 'win32') return `\\\\.\\pipe\\veyra-mpv-${process.pid}-${session}`;
  return path.join(os.tmpdir(), `veyra-mpv-${process.pid}-${session}.sock`);
}

export function available(): string {
  return mpvAvailable();
}

/** 窗口句柄：Windows 是 HWND，Linux 是 X Window id，mpv 的 --wid 都认十进制。 */
function handleOf(win: BrowserWindow): string {
  const raw = win.getNativeWindowHandle();
  return raw.length >= 8 ? raw.readBigUInt64LE(0).toString() : String(raw.readUInt32LE(0));
}

function closeSocket(): void {
  if (sock) {
    try {
      sock.destroy();
    } catch {
      /* 已经断了 */
    }
  }
  sock = null;
  buffered = '';
  for (const item of pending.values()) item.reject(new Error('mpv 已关闭'));
  pending.clear();
}

/** mpv 启动后才建管道，连不上就重试一小会儿。 */
function connect(retries = 40): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const attempt = (left: number) => {
      const client = net.connect(socketPath);
      client.once('connect', () => {
        client.removeAllListeners('error');
        client.setEncoding('utf8');
        client.on('data', (chunk: string) => {
          buffered += chunk;
          let cut = buffered.indexOf('\n');
          while (cut >= 0) {
            const line = buffered.slice(0, cut).trim();
            buffered = buffered.slice(cut + 1);
            cut = buffered.indexOf('\n');
            if (!line) continue;
            try {
              const message = JSON.parse(line) as { request_id?: number; error?: string; data?: unknown };
              if (typeof message.request_id === 'number') {
                const waiter = pending.get(message.request_id);
                if (waiter) {
                  pending.delete(message.request_id);
                  if (message.error && message.error !== 'success') waiter.reject(new Error(message.error));
                  else waiter.resolve(message.data);
                }
              }
            } catch {
              /* 非 JSON 行（日志）忽略 */
            }
          }
        });
        client.on('close', () => closeSocket());
        resolve(client);
      });
      client.once('error', () => {
        client.destroy();
        if (left <= 0) reject(new Error('连不上 mpv 控制管道'));
        else setTimeout(() => attempt(left - 1), 100);
      });
    };
    attempt(retries);
  });
}

/** 发一条 mpv 命令，等它回 request_id。 */
async function command(...args: unknown[]): Promise<unknown> {
  if (!sock) throw new Error('mpv 没在运行');
  const id = ++seq;
  const payload = `${JSON.stringify({ command: args, request_id: id })}\n`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    sock!.write(payload, (error) => {
      if (error) {
        pending.delete(id);
        reject(error);
      }
    });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error('mpv 没有响应'));
      }
    }, 8000);
  });
}

export interface PlayOptions {
  url: string;
  title?: string;
  /** 秒，从上次看到的位置接着放 */
  start?: number;
  parent?: BrowserWindow | null;
}

export interface PlayResult {
  ok: boolean;
  /** 嵌入失败时为 false，界面可以提示一句 */
  embedded: boolean;
}

function shutdown(): void {
  closeSocket();
  if (proc && !proc.killed) {
    try {
      proc.kill();
    } catch {
      /* 已经退出 */
    }
  }
  proc = null;
  if (host && !host.isDestroyed()) {
    const win = host;
    host = null;
    win.destroy();
  }
  host = null;
}

export function close(): void {
  shutdown();
  try {
    if (process.platform !== 'win32' && socketPath) fs.unlinkSync(socketPath);
  } catch {
    /* sock 文件可能已经没了 */
  }
}

/** 播一个已经能直连的地址（本机媒体服务的 /file、/nas、/remote）。 */
export async function play(options: PlayOptions): Promise<PlayResult> {
  const binary = available();
  if (!binary) throw new Error('没有找到 mpv，先用内置播放器');
  const url = String(options.url || '');
  if (!url) throw new Error('播放地址为空');

  close();
  socketPath = pipePath();
  try {
    if (process.platform !== 'win32') fs.unlinkSync(socketPath);
  } catch {
    /* 不存在正好 */
  }

  const logDir = path.join(userDataDir, 'logs');
  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch {
    /* 日志写不进去不影响播放 */
  }

  host = new BrowserWindow({
    width: 1280,
    height: 720,
    minWidth: 640,
    minHeight: 360,
    parent: options.parent || undefined,
    backgroundColor: '#000000',
    title: options.title || '播放',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 后台时别把渲染时钟挂起，mpv 的画面会跟着停
      backgroundThrottling: false,
    },
  });
  host.setMenuBarVisibility(false);
  // 菜单栏会占掉顶部一条，把画面往下挤；这个窗口里不需要它
  host.removeMenu();
  void host.loadURL('data:text/html,<!doctype html><meta charset="utf-8"><body style="margin:0;background:%23000"></body>');

  const win = host;
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    if (host === win) {
      host = null;
      closeSocket();
      if (proc && !proc.killed) {
        try {
          proc.kill();
        } catch {
          /* 已经退出 */
        }
      }
      proc = null;
    }
  });

  await new Promise<void>((resolve) => {
    if (win.isVisible()) return resolve();
    win.once('show', () => resolve());
    // 兜底：某些环境不触发 ready-to-show
    setTimeout(resolve, 1500);
  });

  // 显卡驱动异常时可以用环境变量换输出方式（VEYRA_MPV_VO=direct3d / x11 / null），
  // 不用为了一台机器改代码重打包
  const vo = process.env.VEYRA_MPV_VO || 'gpu';
  const hwdec = process.env.VEYRA_MPV_HWDEC || 'auto-safe';
  const args = [
    `--wid=${handleOf(win)}`,
    '--no-config',
    '--no-terminal',
    `--input-ipc-server=${socketPath}`,
    '--osc=yes',
    // auto-safe 只走被标记为安全的硬解（D3D11VA/DXVA2/VideoToolbox），失败自动软解
    `--hwdec=${hwdec}`,
    `--vo=${vo}`,
    '--keep-open=no',
    '--force-window=yes',
    '--no-resume-playback',
    '--save-position-on-quit=no',
    '--title=' + (options.title || 'Veyra'),
    `--log-file=${path.join(logDir, 'mpv.log')}`,
    '--',
    url,
  ];
  if (options.start && options.start > 5) args.splice(args.length - 2, 0, `--start=${Math.floor(options.start)}`);

  proc = spawn(binary, args, { stdio: 'ignore', windowsHide: true });
  const child = proc;
  child.on('exit', () => {
    // 只收自己的摊子：上一个实例的 exit 可能在新实例起来之后才到
    if (proc !== child) return;
    proc = null;
    closeSocket();
    if (host && !host.isDestroyed()) host.destroy();
    host = null;
  });
  child.on('error', () => {
    if (proc === child) proc = null;
  });

  try {
    sock = await connect();
  } catch (error) {
    // 参数不被这个版本的 mpv 接受时，进程会直接退出；把现场收干净再报错
    const detail = path.join(logDir, 'mpv.log');
    shutdown();
    throw new Error(`${(error as Error).message}（看 ${detail}）`);
  }
  return { ok: true, embedded: true };
}

/** 播放控制：toggle / seek / volume，界面上的按钮都走这里。 */
export async function control(action: string, value?: number): Promise<unknown> {
  if (action === 'pause') return command('cycle', 'pause');
  if (action === 'seek') return command('seek', Number(value) || 0, 'relative');
  if (action === 'seekTo') return command('seek', Number(value) || 0, 'absolute');
  if (action === 'volume') return command('set_property', 'volume', Number(value) || 100);
  if (action === 'mute') return command('cycle', 'mute');
  if (action === 'fullscreen') return command('cycle', 'fullscreen');
  if (action === 'quit') return command('quit');
  throw new Error(`不支持的操作：${action}`);
}

/** 当前进度，界面刷新用。 */
export async function status(): Promise<{ position: number; duration: number; paused: boolean }> {
  const [position, duration, paused] = await Promise.all([
    command('get_property', 'time-pos').catch(() => 0),
    command('get_property', 'duration').catch(() => 0),
    command('get_property', 'pause').catch(() => false),
  ]);
  return {
    position: Number(position) || 0,
    duration: Number(duration) || 0,
    paused: Boolean(paused),
  };
}
