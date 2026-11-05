import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import type { DownloadTask } from '../shared/types';
import { ffmpegAvailable, lanAddress, userDataDir } from './paths';
import { fetchBinary } from './http';
import { serverModules } from './server-modules';
import { playSource } from './huangguo';
import { session } from './session';
import { list as listTasks } from './downloads';

/**
 * 本机媒体服务。
 *
 * 解决三件事：
 *  1. 播放：把私密源的 m3u8 / 红果的加密流代理成本地 HTTP，绕开浏览器拿不到
 *     Referer、也解不了 CENC 的限制；本地已下载的 mp4 也在这里发（支持 Range 拖动）。
 *  2. 共享：手机/TV 在同一局域网时直连这台电脑播放，不用上传到服务器。
 *  3. 发现：把任务摘要挂在 /api/tasks，供其它端读取。
 *
 * 只监听 0.0.0.0 的随机端口，所有请求都要带 token（token 随设备上报给后端）。
 */

let server: http.Server | null = null;
let port = 0;
const token = crypto.randomBytes(16).toString('hex');

const streamJobs = new Map<string, Promise<{ hls?: string; file?: string }>>();
const HLSTIMEOUT = 15000;

function cacheDir(): string {
  const dir = path.join(userDataDir, 'media-cache');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function encode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function decode(value: string): string {
  try {
    return Buffer.from(value, 'base64url').toString('utf8');
  } catch {
    return '';
  }
}

function mediaUrl(pathname: string, absolute = false): string {
  const host = absolute ? `${lanAddress()}:${port}` : `127.0.0.1:${port}`;
  return `http://${host}${pathname}${pathname.includes('?') ? '&' : '?'}t=${token}`;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

function authorized(url: URL): boolean {
  return url.searchParams.get('t') === token;
}

/** 把 m3u8 里的每个 URI 换成本地代理地址；master 子流同样走 /seg，由它按内容再判断。 */
function rewritePlaylist(text: string, base: string, referer: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/g, (_all, uri: string) => {
          const absolute = new URL(uri, base).toString();
          return `URI="${mediaUrl(`/seg?u=${encode(absolute)}&r=${encode(referer)}`)}"`;
        });
      }
      const absolute = new URL(trimmed, base).toString();
      return mediaUrl(`/seg?u=${encode(absolute)}&r=${encode(referer)}`);
    })
    .join('\n');
}

/** 拉源站媒体：直连被风控时退回后端通道，别让一集视频因为一个分片 403 就整段播不了。 */
async function fetchMedia(url: string, referer: string): Promise<Buffer> {
  try {
    return await fetchBinary(url, HLSTIMEOUT, { Referer: referer, 'User-Agent': 'Mozilla/5.0 (Linux; Android 13) Chrome/130 Mobile Safari/537.36' });
  } catch (error) {
    const current = session();
    if (!current?.server || /^https?:\/\/127\.0\.0\.1/.test(url)) throw error;
    return fetchBinary(
      `${current.server}/api/huangguo-proxy?url=${encodeURIComponent(url)}`,
      30000,
      { Referer: referer, 'User-Agent': 'Mozilla/5.0 (Linux; Android 13) Chrome/130 Mobile Safari/537.36' },
    );
  }
}

async function proxySegment(url: string, referer: string): Promise<{ body: Buffer; type: string }> {
  const body = await fetchMedia(url, referer);
  const head = body.subarray(0, 16).toString('utf8');
  if (head.startsWith('#EXTM3U')) {
    return { body: Buffer.from(rewritePlaylist(body.toString('utf8'), url, referer), 'utf8'), type: 'application/vnd.apple.mpegurl' };
  }
  return { body, type: head.startsWith('\u0000') || body.subarray(0, 3).toString() === 'ID3' ? 'video/mp2t' : 'application/octet-stream' };
}

/** 红果单集取流：没加密就代理原流；CENC 加密的先用 ffmpeg 解密封装成 mp4 再发。 */
async function hongguoStream(seriesId: string, episode: number): Promise<{ hls?: string; file?: string }> {
  const key = `rg-${seriesId}-${episode}`;
  const existing = streamJobs.get(key) as Promise<{ hls?: string; file?: string }> | undefined;
  if (existing) return existing;

  const job = (async () => {
    const { hgApp } = serverModules();
    const info = await hgApp.videoDetail(seriesId);
    const vid = Array.isArray(info?.vids) ? info.vids[episode - 1] : '';
    if (!vid) throw new Error('这一集没有取到 vid');
    const model = await hgApp.videoModel(vid);
    if (!model?.url) throw new Error('这一集没有取到播放地址');

    if (!model.key) {
      // 明文流：m3u8 交给 hls.js，mp4 直接落盘（支持 Range 拖动）
      if (/\.m3u8(\?|$)/i.test(model.url)) return { hls: model.url };
      const file = path.join(cacheDir(), `${key}.mp4`);
      if (fs.existsSync(file) && fs.statSync(file).size > 1024) return { file };
      const buffer = await fetchBinary(model.url, 60000, { Referer: 'https://www.hongguoduanju.com/', 'User-Agent': 'Mozilla/5.0' });
      fs.writeFileSync(file, buffer);
      return { file };
    }

    const file = path.join(cacheDir(), `${key}.mp4`);
    if (fs.existsSync(file) && fs.statSync(file).size > 1024) return { file };
    await new Promise<void>((resolve, reject) => {
      execFile(
        ffmpegAvailable(),
        ['-y', '-decryption_key', model.key, '-i', model.url, '-c', 'copy', '-movflags', '+faststart', file],
        { timeout: 10 * 60 * 1000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
        (error) => (error ? reject(new Error('解密转封装失败：' + error.message)) : resolve()),
      );
    });
    return { file };
  })().finally(() => streamJobs.delete(key));

  streamJobs.set(key, job);
  return job;
}

function sendFile(req: http.IncomingMessage, res: http.ServerResponse, file: string, type: string): void {
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    json(res, 404, { error: '文件不存在' });
    return;
  }
  const range = String(req.headers.range || '');
  const match = range.match(/bytes=(\d*)-(\d*)/);
  if (match) {
    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    if (start >= size || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      'Content-Type': type,
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' });
  fs.createReadStream(file).pipe(res);
}

/** 服务器上的成品（NAS 下载）：带 token 转发，Range 原样透传，拖动进度条才能用。 */
async function proxyServerFile(req: http.IncomingMessage, res: http.ServerResponse, target: string, authToken: string): Promise<void> {
  await new Promise<void>((resolve) => {
    let parsed: URL;
    try {
      parsed = new URL(target);
    } catch {
      json(res, 400, { error: '地址无效' });
      resolve();
      return;
    }
    const headers: Record<string, string> = { Authorization: `Bearer ${authToken}`, 'User-Agent': 'Veyra-Desktop/0.1' };
    if (req.headers.range) headers.Range = String(req.headers.range);
    const client = parsed.protocol === 'https:' ? https.request : http.request;
    const upstream = client(parsed, { method: 'GET', headers }, (remote) => {
      const pass: Record<string, string> = {};
      for (const key of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified']) {
        const value = remote.headers[key];
        if (typeof value === 'string') pass[key] = value;
      }
      res.writeHead(remote.statusCode || 502, pass);
      remote.pipe(res);
      remote.on('end', () => resolve());
      remote.on('error', () => resolve());
    });
    upstream.on('error', (error) => {
      if (!res.headersSent) json(res, 502, { error: `服务器文件读取失败：${error.message}` });
      resolve();
    });
    req.on('close', () => upstream.destroy());
  });
}

/** 任务目录里找某一集的明文 mp4（分集或合并成品）。 */
function episodeFile(task: DownloadTask, index: number): { file: string; type: string } | null {
  if (index === 0 && task.output && fs.existsSync(task.output)) return { file: task.output, type: 'video/mp4' };
  const raw = serverModules().downloader.getRawTask(task.id, 'desktop', true);
  if (!raw) return null;
  const dir = serverModules().downloader.taskDirOf(raw);
  if (!dir || !fs.existsSync(dir)) return null;
  const names = fs.readdirSync(dir).filter((name) => /\.(mp4|m4v|ts|mkv)$/i.test(name)).sort();
  const hit = index > 0 ? names.filter((name) => new RegExp(`(^|[^0-9])0*${index}([^0-9]|$)`).test(name))[0] : names[0];
  if (!hit) return null;
  return { file: path.join(dir, hit), type: /\.ts$/i.test(hit) ? 'video/mp2t' : 'video/mp4' };
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (url.pathname === '/api/ping') return json(res, 200, { ok: true, name: 'veyra-desktop', port });
  if (!authorized(url)) return json(res, 401, { error: 'token 无效' });

  if (url.pathname === '/api/tasks') {
    const tasks = listTasks().map((task) => ({
      id: task.id,
      title: task.title,
      cover: task.cover,
      status: task.status,
      percent: task.percent,
      doneCount: task.doneCount,
      totalCount: task.totalCount,
      episodeCount: task.episodeCount,
      output: task.output ? path.basename(task.output) : '',
      merged: Boolean(task.output && fs.existsSync(task.output)),
      url: mediaUrl(`/file/${task.id}/0`, true),
    }));
    return json(res, 200, { device: lanAddress(), tasks });
  }

  if (url.pathname === '/seg') {
    const target = decode(url.searchParams.get('u') || '');
    if (!/^https?:\/\//i.test(target)) return json(res, 400, { error: '地址无效' });
    try {
      const result = await proxySegment(target, decode(url.searchParams.get('r') || ''));
      res.writeHead(200, { 'Content-Type': result.type, 'Content-Length': result.body.length, 'Access-Control-Allow-Origin': '*' });
      res.end(result.body);
    } catch (error) {
      json(res, 502, { error: (error as Error).message });
    }
    return;
  }

  if (url.pathname.startsWith('/file/')) {
    const [, , id, index] = url.pathname.split('/');
    const task = listTasks().find((item) => item.id === id);
    if (!task) return json(res, 404, { error: '任务不存在' });
    const found = episodeFile(task, Number(index) || 0);
    if (!found) return json(res, 404, { error: '文件还没下载完' });
    return sendFile(req, res, found.file, found.type);
  }

  if (url.pathname.startsWith('/nas/')) {
    // 服务器上的成品：桌面端和手机/电视一样，统一从本机媒体服务出，避免渲染层带不了 Authorization
    const [, , taskId, indexRaw] = url.pathname.split('/');
    const current = session();
    if (!current) return json(res, 401, { error: '未登录' });
    const index = Number(indexRaw) || 0;
    await proxyServerFile(
      req,
      res,
      `${current.server}/api/download/files/${encodeURIComponent(taskId)}/${index}`,
      current.token,
    );
    return;
  }

  if (url.pathname.startsWith('/hg/')) {
    const [, , seriesId, episode] = url.pathname.split('/');
    try {
      const source = await playSource(seriesId, Number(episode) || 1);
      const body = await fetchMedia(source.url, source.referer);
      if (body.subarray(0, 8).toString('utf8').startsWith('#EXTM3U')) {
        const playlist = rewritePlaylist(body.toString('utf8'), source.url, source.referer);
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Access-Control-Allow-Origin': '*' });
        res.end(playlist);
        return;
      }
      // 直接是 mp4：转发原地址，由 /seg 负责 Range
      res.writeHead(302, { Location: mediaUrl(`/seg?u=${encode(source.url)}&r=${encode(source.referer)}`) });
      res.end();
    } catch (error) {
      json(res, 502, { error: (error as Error).message });
    }
    return;
  }

  if (url.pathname.startsWith('/rg/')) {
    const [, , seriesId, episode] = url.pathname.split('/');
    try {
      const target = await hongguoStream(seriesId, Number(episode) || 1);
      if (target.hls) {
        const body = await fetchBinary(target.hls, HLSTIMEOUT, { Referer: 'https://www.hongguoduanju.com/', 'User-Agent': 'Mozilla/5.0' });
        const playlist = rewritePlaylist(body.toString('utf8'), target.hls, 'https://www.hongguoduanju.com/');
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Access-Control-Allow-Origin': '*' });
        res.end(playlist);
        return;
      }
      return sendFile(req, res, target.file!, 'video/mp4');
    } catch (error) {
      json(res, 502, { error: (error as Error).message });
    }
    return;
  }

  json(res, 404, { error: 'not found' });
}

export function start(): Promise<{ port: number; token: string; base: string }> {
  if (server && port) return Promise.resolve({ port, token, base: `http://127.0.0.1:${port}` });
  return new Promise((resolve, reject) => {
    const instance = http.createServer((req, res) => {
      handle(req, res).catch((error) => json(res, 500, { error: (error as Error).message }));
    });
    instance.once('error', reject);
    // listen 是异步的，端口要等 listening 回调里才拿得到（之前在这里同步读 address 拿到 null）
    instance.listen(0, '0.0.0.0', () => {
      const address = instance.address();
      port = typeof address === 'object' && address ? address.port : 0;
      server = instance;
      console.log('[media] 媒体服务已启动，端口', port);
      resolve({ port, token, base: `http://127.0.0.1:${port}` });
    });
  });
}

export function info(): { port: number; token: string; lan: string } {
  return { port, token, lan: port ? `http://${lanAddress()}:${port}` : '' };
}

export function playUrl(source: 'hongguo' | 'huangguo', seriesId: string, episode: number): string {
  const kind = source === 'huangguo' ? 'hg' : 'rg';
  return mediaUrl(`/${kind}/${encodeURIComponent(seriesId)}/${episode}`);
}

/**
 * 播放前先判流类型：红果/黄果都可能给 mp4 也可能给 m3u8，
 * 渲染层拿错的播放器就会一直转圈（video 元素放不了 m3u8）。
 */
const kindCache = new Map<string, { kind: 'hls' | 'file'; at: number }>();

export async function resolveKind(source: 'hongguo' | 'huangguo', seriesId: string, episode: number): Promise<'hls' | 'file'> {
  const cacheKey = `${source}:${seriesId}:${episode}`;
  const hit = kindCache.get(cacheKey);
  if (hit && Date.now() - hit.at < 120000) return hit.kind;

  let kind: 'hls' | 'file' = source === 'huangguo' ? 'hls' : 'file';
  try {
    if (source === 'huangguo') {
      const found = await playSource(seriesId, episode);
      kind = /\.m3u8(\?|$)/i.test(found.url) ? 'hls' : 'file';
    } else {
      const { hgApp } = serverModules();
      const info = await hgApp.videoDetail(seriesId);
      const vid = Array.isArray(info?.vids) ? info.vids[episode - 1] : '';
      const model = vid ? await hgApp.videoModel(vid) : null;
      // 有 key 说明是 CENC 加密，服务端会先解成 mp4；否则看源地址后缀
      kind = model?.key ? 'file' : /\.m3u8(\?|$)/i.test(String(model?.url || '')) ? 'hls' : 'file';
    }
  } catch {
    /* 探测失败按默认走，播放器自己还有兜底 */
  }
  kindCache.set(cacheKey, { kind, at: Date.now() });
  return kind;
}

/** 服务器上的成品（NAS 任务）：本机媒体服务带 token 转发，渲染层只拿本地地址。 */
export function nasUrl(taskId: string, index = 0): string {
  return mediaUrl(`/nas/${encodeURIComponent(taskId)}/${index}`);
}

/** 本地已下载文件：index=0 是合并成品，>0 是分集。 */
export function fileUrl(taskId: string, index = 0): string {
  return mediaUrl(`/file/${encodeURIComponent(taskId)}/${index}`);
}

export function stop(): void {
  server?.close();
  server = null;
  port = 0;
}
