import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import type { DownloadTask } from '../shared/types';
import { ffmpegAvailable, lanAddress, userDataDir } from './paths';
import { fetchBinary, fetchBinaryFast } from './http';
import { serverModules } from './server-modules';
import { playSource } from './huangguo';
import * as remoteSite from './remote-site';
import { session } from './session';
import { readSettings } from './store';
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

/**
 * 解析结果缓存（10 分钟）。一集播放期间播放器会发好几次请求（探测 + Range），
 * 每次都重新拉 videoDetail + videoModel 不但慢，还容易被源站风控。
 */
const resolvedCache = new Map<string, { value: { hls?: string; file?: string }; at: number }>();
const RESOLVE_TTL = 10 * 60 * 1000;

/** 私密源播放地址缓存：prepare 预热过一次，/hg/ 首请求就不用再等源站 */
const hgCache = new Map<string, { url: string; referer: string; at: number }>();

function cachedResolve(key: string): { hls?: string; file?: string } | null {
  const hit = resolvedCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > RESOLVE_TTL) {
    resolvedCache.delete(key);
    return null;
  }
  return hit.value;
}

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

/** 拉源站媒体：通道按用户选择走（直连 / 代理 / 后端转发），不自动兜底。 */
async function fetchMedia(url: string, referer: string): Promise<Buffer> {
  const headers = { Referer: referer, 'User-Agent': 'Mozilla/5.0 (Linux; Android 13) Chrome/130 Mobile Safari/537.36' };
  const mode = Number(readSettings().proxyMode) || 3;
  if (mode !== 3) return fetchBinary(url, HLSTIMEOUT, headers);

  const current = session();
  if (!current?.server) throw new Error('走后端转发需要先登录服务器');
  /* 走 Node 长连接而不是 curl：播放时每 4 秒就有一个分片请求，
     起进程 + 重新握手会让「解析到了但流加载失败」变成常态。 */
  return fetchBinaryFast(
    `${current.server}/api/huangguo-proxy?url=${encodeURIComponent(url)}`,
    30000,
    headers,
  );
}

/**
 * 直连会话：源站凭据（Referer / CloudFront 签名 Cookie）动辄六百多字节，
 * 不能塞进每个分片的 URL，按 sid 存内存，两小时不用就清掉。
 */
const mediaSessions = new Map<string, { headers: Record<string, string>; at: number }>();
const MEDIA_SESSION_TTL = 2 * 60 * 60 * 1000;

function createMediaSession(headers: Record<string, string>): string {
  const id = crypto.randomBytes(9).toString('hex');
  const now = Date.now();
  for (const [key, value] of mediaSessions) {
    if (now - value.at > MEDIA_SESSION_TTL) mediaSessions.delete(key);
  }
  mediaSessions.set(id, { headers, at: now });
  return id;
}

function mediaSessionHeaders(sid: string): Record<string, string> {
  const hit = mediaSessions.get(sid);
  if (!hit) return {};
  hit.at = Date.now();
  return hit.headers;
}

/** 同 rewritePlaylist，但分片地址只带 sid，凭据由 /seg 从会话里取。 */
function rewritePlaylistSession(text: string, base: string, sid: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/g, (_all, uri: string) => {
          const absolute = new URL(uri, base).toString();
          return `URI="${mediaUrl(`/seg?u=${encode(absolute)}&sid=${sid}`)}"`;
        });
      }
      const absolute = new URL(trimmed, base).toString();
      return mediaUrl(`/seg?u=${encode(absolute)}&sid=${sid}`);
    })
    .join('\n');
}

async function proxySegmentSession(url: string, sid: string): Promise<{ body: Buffer; type: string }> {
  const headers = mediaSessionHeaders(sid);
  const body = await fetchBinaryFast(url, 30000, headers);
  const head = body.subarray(0, 16).toString('utf8');
  if (head.startsWith('#EXTM3U')) {
    return { body: Buffer.from(rewritePlaylistSession(body.toString('utf8'), url, sid), 'utf8'), type: 'application/vnd.apple.mpegurl' };
  }
  return { body, type: head.startsWith('\u0000') || body.subarray(0, 3).toString() === 'ID3' ? 'video/mp2t' : 'application/octet-stream' };
}

async function proxySegment(url: string, referer: string): Promise<{ body: Buffer; type: string }> {
  const body = await fetchMedia(url, referer);
  const head = body.subarray(0, 16).toString('utf8');
  if (head.startsWith('#EXTM3U')) {
    return { body: Buffer.from(rewritePlaylist(body.toString('utf8'), url, referer), 'utf8'), type: 'application/vnd.apple.mpegurl' };
  }
  return { body, type: head.startsWith('\u0000') || body.subarray(0, 3).toString() === 'ID3' ? 'video/mp2t' : 'application/octet-stream' };
}

/* ---------------- H.265（HEVC）兼容 ----------------
 * 源站和下载成品基本都是 H.265。Chromium 只在少数装了系统解码器/有硬解的机器上能放，
 * 其它机器就是「有声音没画面、videoWidth = 0」。检测到放不了时转一遍 H.264 并缓存，
 * 只影响第一次播放。
 */

let pickedEncoder: string | null = null;

/** 跑一次 ffmpeg，把 stdout + stderr 都收回来（ffmpeg 的信息一半在 stderr）。 */
function ffmpegRun(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(ffmpegAvailable(), args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && (error as { killed?: boolean }).killed) {
        reject(error);
        return;
      }
      // 只做探测时 ffmpeg 会以 1 退出（没有输出文件），但流信息已经打印出来了
      resolve(`${stdout || ''}\n${stderr || ''}`);
    });
  });
}

async function probeCodec(file: string): Promise<string> {
  try {
    const info = await ffmpegRun(['-hide_banner', '-i', file], 20000);
    const match = /Stream #\S+.*?Video: (\w+)/.exec(info);
    return match ? match[1].toLowerCase() : '';
  } catch {
    return '';
  }
}

/** 候选编码器：软件优先（不挑硬件、参数一致），硬编在后。 */
const ENCODERS = ['libx264', 'libopenh264', 'h264_nvenc', 'h264_qsv', 'h264_amf'];

let availableEncoders: string[] | null = null;

async function listEncoders(): Promise<string[]> {
  if (availableEncoders) return availableEncoders;
  availableEncoders = [];
  try {
    const out = await ffmpegRun(['-hide_banner', '-encoders'], 15000);
    for (const name of ENCODERS) if (out.includes(name)) availableEncoders.push(name);
  } catch {
    /* 探测失败就当没有，最后会给出明确报错 */
  }
  return availableEncoders;
}

const transcodeJobs = new Map<string, Promise<string>>();

/**
 * 不是 H.265 就原样返回；是的话转成 H.264 并缓存。
 *
 * 编码器要一个一个试：有的 ffmpeg 编译进了 h264_nvenc/qsv 但机器上没有对应硬件，
 * 打开编码器就会失败（本项目在 CI 机器上就踩过），软件编码作为兜底必须留着。
 */
export async function ensureH264(file: string): Promise<string> {
  if (!file) return file;
  const codec = await probeCodec(file);
  if (codec !== 'hevc' && codec !== 'h265') return file;

  const out = `${file.replace(/\.(mp4|m4v|ts|mkv)$/i, '')}.h264.mp4`;
  if (fs.existsSync(out) && fs.statSync(out).size > 1024) return out;

  const running = transcodeJobs.get(out);
  if (running) return running;

  const job = (async () => {
    const encoders = await listEncoders();
    if (!encoders.length) throw new Error('这个 ffmpeg 没有 H.264 编码器，放不了 H.265 视频');

    let lastError = '';
    for (const encoder of encoders) {
      const startedAt = Date.now();
      const args = ['-y', '-i', file, '-c:v', encoder];
      if (encoder === 'libx264') args.push('-preset', 'veryfast', '-crf', '23');
      args.push(
        // 竖屏短剧 1080x1920 转 720x1280，速度快一倍多，桌面上看差别不大
        '-vf', 'scale=-2:min(1280\\,ih)',
        '-c:a', 'aac', '-b:a', '128k',
        '-movflags', '+faststart',
        out,
      );
      try {
        await new Promise<void>((resolve, reject) => {
          execFile(ffmpegAvailable(), args, { timeout: 30 * 60 * 1000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, _stdout, stderr) => {
            if (!error) return resolve();
            lastError = String(stderr || error.message).split('\n').filter(Boolean).slice(-2).join(' / ');
            reject(new Error(lastError));
          });
        });
        if (fs.existsSync(out) && fs.statSync(out).size > 1024) {
          console.log(`[media] H.265 → H.264（${encoder}，${Date.now() - startedAt}ms）`);
          return out;
        }
        lastError = '输出文件是空的';
      } catch (error) {
        console.warn(`[media] 转码用 ${encoder} 失败：${(error as Error).message}`);
      }
      try {
        fs.unlinkSync(out);
      } catch {
        /* 本来就没生成 */
      }
    }
    throw new Error(`H.265 转码失败（${lastError || '所有编码器都不可用'}）`);
  })().finally(() => transcodeJobs.delete(out));

  transcodeJobs.set(out, job);
  return job;
}

/* ---------------- 远程成品（NAS / 别的设备）的 H.265 兼容 ----------------
 * 手机能放、电脑放不出来，十有八九还是 H.265：手机有硬解，Chromium 没有。
 * 远端文件可能是一部剧合起来好几个 G，等整段转完再播不现实，所以这里转成 HLS：
 * ffmpeg 一边转、播放器一边放，几秒就能出画面，转完的切片留在缓存里下次直接秒开。
 */

interface RemoteJob {
  dir: string;
  playlist: string;
  proc: ChildProcess;
}

const remoteJobs = new Map<string, RemoteJob>();

function remoteKey(url: string): string {
  return crypto.createHash('sha1').update(url).digest('hex').slice(0, 16);
}

function hlsReady(dir: string): boolean {
  try {
    const text = fs.readFileSync(path.join(dir, 'index.m3u8'), 'utf8');
    return /\.ts(\?|$)/m.test(text);
  } catch {
    return false;
  }
}

async function waitForPlaylist(dir: string, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (hlsReady(dir)) return;
    const job = [...remoteJobs.values()].find((item) => item.dir === dir);
    // ffmpeg 已经退出了还没切片：别傻等，明确报错
    if (!job) break;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  if (!hlsReady(dir)) throw new Error('转码没有开始产出，可能是远端文件读不到或格式异常');
}

/**
 * 把远端视频转成 HLS（H.264），返回 index.m3u8 的本地文件路径。
 * 同一个地址只起一个 ffmpeg；切片缓存 7 天。
 */
async function ensureRemoteHls(url: string, headers: Record<string, string>): Promise<{ key: string; dir: string }> {
  const key = remoteKey(url);
  const dir = path.join(cacheDir(), `hls-${key}`);
  const playlist = path.join(dir, 'index.m3u8');
  fs.mkdirSync(dir, { recursive: true });

  const running = remoteJobs.get(key);
  if (running) {
    await waitForPlaylist(dir, 90000);
    return { key, dir };
  }
  // 上次已经转完（有 ENDLIST）就直接用
  if (fs.existsSync(playlist) && /#EXT-X-ENDLIST/.test(fs.readFileSync(playlist, 'utf8'))) {
    return { key, dir };
  }
  // 上次半途而废的残留：清掉重来，别让播放器对着半个清单转圈
  if (fs.existsSync(playlist)) {
    try {
      for (const name of fs.readdirSync(dir)) fs.rmSync(path.join(dir, name), { force: true });
    } catch { /* ignore */ }
  }

  const encoders = await listEncoders();
  const encoder = encoders.includes('libx264') ? 'libx264' : encoders[0];
  if (!encoder) throw new Error('这个 ffmpeg 没有 H.264 编码器，放不了 H.265 视频');

  const args = ['-y'];
  const headerText = Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`).join('');
  if (headerText) args.push('-headers', headerText);
  args.push(
    '-i', url,
    '-c:v', encoder,
  );
  if (encoder === 'libx264') args.push('-preset', 'veryfast', '-crf', '23');
  args.push(
    '-vf', 'scale=-2:min(1280\\,ih)',
    '-c:a', 'aac', '-b:a', '128k',
    '-max_muxing_queue_size', '1024',
    '-f', 'hls',
    '-hls_time', '4',
    '-hls_playlist_type', 'event',
    '-hls_flags', 'independent_segments',
    '-hls_segment_filename', path.join(dir, 'seg%05d.ts'),
    playlist,
  );
  const proc = spawn(ffmpegAvailable(), args, { windowsHide: true });
  const job: RemoteJob = { dir, playlist, proc };
  remoteJobs.set(key, job);
  let stderr = '';
  proc.stderr?.on('data', (chunk) => {
    stderr = (stderr + String(chunk)).slice(-4000);
  });
  proc.on('error', (error) => {
    console.warn('[media] 远程转码启动失败：' + error.message);
    remoteJobs.delete(key);
  });
  proc.on('exit', (code) => {
    remoteJobs.delete(key);
    if (code === 0) console.log(`[media] 远程转码完成 ${key}`);
    else console.warn(`[media] 远程转码退出 ${code}：${stderr.split('\n').filter(Boolean).slice(-2).join(' / ')}`);
  });

  console.log(`[media] 开始远程转码 ${key}（${encoder}）`);
  await waitForPlaylist(dir, 120000);
  return { key, dir };
}

function serveHlsFile(req: http.IncomingMessage, res: http.ServerResponse, key: string, name: string): void {
  if (!/^(index\.m3u8|seg\d{5}\.ts)$/.test(name)) return json(res, 404, { error: 'not found' });
  const file = path.join(cacheDir(), `hls-${key}`, name);
  if (!fs.existsSync(file)) return json(res, 404, { error: '切片还没生成' });
  if (name.endsWith('.m3u8')) {
    res.writeHead(200, {
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    });
    fs.createReadStream(file).pipe(res);
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'video/mp2t',
    'Content-Length': fs.statSync(file).size,
    'Access-Control-Allow-Origin': '*',
  });
  fs.createReadStream(file).pipe(res);
}

/** 普通 HTTP 转发（别的设备的局域网媒体服务）：Range 原样透传，不加 Authorization。 */
async function proxyRemote(req: http.IncomingMessage, res: http.ServerResponse, target: string): Promise<void> {
  await new Promise<void>((resolve) => {
    let parsed: URL;
    try {
      parsed = new URL(target);
    } catch {
      json(res, 400, { error: '地址无效' });
      resolve();
      return;
    }
    const headers: Record<string, string> = { 'User-Agent': 'Veyra-Desktop/0.1' };
    if (req.headers.range) headers.Range = String(req.headers.range);
    const client = parsed.protocol === 'https:' ? https.request : http.request;
    const upstream = client(parsed, { method: 'GET', headers }, (remote) => {
      console.log(`[media] 远程转发上游 ${remote.statusCode} ${parsed.pathname}`);
      const pass: Record<string, string> = {};
      for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified']) {
        const value = remote.headers[name];
        if (typeof value === 'string') pass[name] = value;
      }
      res.writeHead(remote.statusCode || 502, pass);
      remote.pipe(res);
      remote.on('end', () => resolve());
      remote.on('error', () => resolve());
    });
    upstream.on('error', (error) => {
      if (!res.headersSent) json(res, 502, { error: `远端文件读取失败：${error.message}` });
      resolve();
    });
    // 客户端中途关掉（拖动进度条换 Range）才掐上游；用 req 的 close 会在请求读完时
    // 就把连接掐掉，导致播放器一个字节都拿不到
    res.on('close', () => { if (!res.writableEnded) upstream.destroy(); });
    upstream.end();
  });
}

/** 红果单集取流：没加密就代理原流；CENC 加密的先用 ffmpeg 解密封装成 mp4 再发。 */
async function hongguoStream(seriesId: string, episode: number): Promise<{ hls?: string; file?: string }> {
  const key = `rg-${seriesId}-${episode}`;
  const known = cachedResolve(key);
  if (known) return known;
  const existing = streamJobs.get(key) as Promise<{ hls?: string; file?: string }> | undefined;
  if (existing) return existing;

  const job = (async () => {
    const startedAt = Date.now();
    const { hgApp } = serverModules();
    const info = await hgApp.videoDetail(seriesId);
    const vid = Array.isArray(info?.vids) ? info.vids[episode - 1] : '';
    if (!vid) throw new Error('这一集没有取到 vid');
    const model = await hgApp.videoModel(vid);
    if (!model?.url) throw new Error('这一集没有取到播放地址');

    let result: { hls?: string; file?: string };
    if (!model.key) {
      // 明文流：m3u8 交给 hls.js，mp4 直接落盘（支持 Range 拖动）
      if (/\.m3u8(\?|$)/i.test(model.url)) {
        result = { hls: model.url };
      } else {
        const file = path.join(cacheDir(), `${key}.mp4`);
        if (!(fs.existsSync(file) && fs.statSync(file).size > 1024)) {
          const buffer = await fetchBinary(model.url, 60000, { Referer: 'https://www.hongguoduanju.com/', 'User-Agent': 'Mozilla/5.0' });
          fs.writeFileSync(file, buffer);
        }
        result = { file };
      }
    } else {
      // CENC 加密：整集先解密转封装成普通 mp4，之后每次播放都是本地文件（秒开、可拖）
      const file = path.join(cacheDir(), `${key}.mp4`);
      if (!(fs.existsSync(file) && fs.statSync(file).size > 1024)) {
        await new Promise<void>((resolve, reject) => {
          execFile(
            ffmpegAvailable(),
            ['-y', '-decryption_key', model.key, '-i', model.url, '-c', 'copy', '-movflags', '+faststart', file],
            { timeout: 10 * 60 * 1000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
            (error) => {
              if (!error) return resolve();
              const text = (error as NodeJS.ErrnoException).code === 'ENOENT'
                ? `找不到 ffmpeg（${ffmpegAvailable()}），安装包不完整，请重新下载安装`
                : '解密转封装失败：' + error.message;
              reject(new Error(text));
            },
          );
        });
      }
      result = { file };
    }

    resolvedCache.set(key, { value: result, at: Date.now() });
    console.log(`[media] 解析完成 ${key}（${result.file ? '本地 mp4' : 'm3u8'}，${Date.now() - startedAt}ms）`);
    return result;
  })().finally(() => streamJobs.delete(key));

  streamJobs.set(key, job);
  return job;
}

/**
 * 播放前先把「要播的东西」准备好。
 *
 * 关键点：红果加密集是先用 ffmpeg 整集解密成 mp4 的，这一步没做完之前
 * 媒体服务不会回任何响应头，浏览器里的 <video> 就会一直空白转圈（等太久还会
 * 直接报错）。所以这里先等解密完成，再把地址交给渲染层 —— 播放器拿到地址时
 * 文件已经在磁盘上，第一个请求毫秒级返回，不会再出现「点了没反应」。
 */
export async function prepare(
  source: 'hongguo' | 'huangguo',
  seriesId: string,
  episode: number,
  h264: boolean,
): Promise<'hls' | 'file'> {
  if (source === 'huangguo') {
    // 私密源要换一次播放地址（带 Referer）/ 可能走后端代理，先热一遍，播放器就不用等
    const found = await playSource(seriesId, episode);
    hgCache.set(`hg-${seriesId}-${episode}`, { ...found, at: Date.now() });
    return /\.m3u8(\?|$)/i.test(found.url) ? 'hls' : 'file';
  }
  const target = await hongguoStream(seriesId, episode);
  // 这台机器放不了 H.265：先把转码做完再交地址，别让播放器对着黑屏干等
  if (target.file && h264) await ensureH264(target.file);
  return target.hls ? 'hls' : 'file';
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
    // 客户端中途关掉（拖动进度条换 Range）才掐上游；用 req 的 close 会在请求读完时
    // 就把连接掐掉，导致播放器一个字节都拿不到
    res.on('close', () => { if (!res.writableEnded) upstream.destroy(); });
    // http.request 只是建了请求对象，不 end() 一个字节都不会发出去（表现为一直转圈）
    upstream.end();
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
    const sid = url.searchParams.get('sid') || '';
    try {
      const result = sid
        ? await proxySegmentSession(target, sid)
        : await proxySegment(target, decode(url.searchParams.get('r') || ''));
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
    if (url.searchParams.get('h264') === '1') {
      try {
        const playable = await ensureH264(found.file);
        return sendFile(req, res, playable, 'video/mp4');
      } catch (error) {
        return json(res, 500, { error: (error as Error).message });
      }
    }
    return sendFile(req, res, found.file, found.type);
  }

  if (url.pathname.startsWith('/nas/')) {
    // 服务器上的成品：桌面端和手机/电视一样，统一从本机媒体服务出，避免渲染层带不了 Authorization
    const [, , taskId, indexRaw] = url.pathname.split('/');
    const current = session();
    if (!current) return json(res, 401, { error: '未登录' });
    const index = Number(indexRaw) || 0;
    const target = `${current.server}/api/download/files/${encodeURIComponent(taskId)}/${index}`;
    if (url.searchParams.get('h264') === '1') {
      // 服务器上的成品多为 H.265（手机能放、Chromium 放不了）：边转 HLS 边播
      try {
        const job = await ensureRemoteHls(target, { Authorization: `Bearer ${current.token}` });
        res.writeHead(302, { Location: mediaUrl(`/hls/${job.key}/index.m3u8`) });
        res.end();
      } catch (error) {
        json(res, 502, { error: (error as Error).message });
      }
      return;
    }
    await proxyServerFile(req, res, target, current.token);
    return;
  }

  if (url.pathname === '/remote') {
    // 别的设备（手机 / 电视 / 另一台电脑）局域网媒体服务上的成品
    const target = decode(url.searchParams.get('u') || '');
    let parsed: URL;
    try {
      parsed = new URL(target);
    } catch {
      return json(res, 400, { error: '地址无效' });
    }
    if (!/^https?:$/.test(parsed.protocol) || !isPrivateHost(parsed.hostname)) {
      return json(res, 403, { error: '只允许访问局域网地址' });
    }
    console.log(`[media] 远程转发 ${parsed.host} ${parsed.pathname}${url.searchParams.get('h264') === '1' ? '（转码）' : ''}`);
    if (url.searchParams.get('h264') === '1') {
      try {
        const job = await ensureRemoteHls(target, {});
        res.writeHead(302, { Location: mediaUrl(`/hls/${job.key}/index.m3u8`) });
        res.end();
      } catch (error) {
        json(res, 502, { error: (error as Error).message });
      }
      return;
    }
    await proxyRemote(req, res, target);
    return;
  }

  if (url.pathname.startsWith('/hls/')) {
    const [, , key, name] = url.pathname.split('/');
    return serveHlsFile(req, res, key || '', name || '');
  }

  if (url.pathname.startsWith('/rs/')) {
    // 接口型源（剧果 / 野果 / 禁果短剧 / 黄果 AI / 黄果旧版）统一走本机媒体服务：
    // 直连时由这里带上源站凭据去取，代理 / 转发时这里转发后端签发的 stream 地址。
    // 渲染层只看得到 127.0.0.1，所以三种模式对播放器是同一件事。
    const [, , site, seriesId, episode] = url.pathname.split('/');
    if (!site || !seriesId) return json(res, 400, { error: '地址无效' });
    try {
      const found = await remoteSite.play(decodeURIComponent(seriesId), Number(episode) || 1);
      const sid = createMediaSession(found.headers);
      const body = await fetchBinaryFast(found.url, 30000, found.headers);
      if (body.subarray(0, 8).toString('utf8').startsWith('#EXTM3U')) {
        const playlist = rewritePlaylistSession(body.toString('utf8'), found.url, sid);
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Access-Control-Allow-Origin': '*' });
        res.end(playlist);
        return;
      }
      res.writeHead(302, { Location: mediaUrl(`/seg?u=${encode(found.url)}&sid=${sid}`) });
      res.end();
    } catch (error) {
      json(res, 502, { error: (error as Error).message });
    }
    return;
  }

  if (url.pathname.startsWith('/hg/')) {
    const [, , seriesId, episode] = url.pathname.split('/');
    try {
      const warm = hgCache.get(`hg-${seriesId}-${Number(episode) || 1}`);
      const source = warm && Date.now() - warm.at < RESOLVE_TTL ? warm : await playSource(seriesId, Number(episode) || 1);
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
      if (url.searchParams.get('h264') === '1') {
        return sendFile(req, res, await ensureH264(target.file!), 'video/mp4');
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
      const startedAt = Date.now();
      const pathname = (req.url || '').split('?')[0];
      res.on('finish', () => {
        const cost = Date.now() - startedAt;
        // 只有慢请求才值得记一笔：排查「点播放一直转圈」时全靠它
        if (cost > 3000) console.warn(`[media] ${req.method} ${pathname} 耗时 ${cost}ms -> ${res.statusCode}`);
      });
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

export function playUrl(source: 'hongguo' | 'huangguo', seriesId: string, episode: number, h264 = false): string {
  const kind = source === 'huangguo' ? 'hg' : 'rg';
  return mediaUrl(`/${kind}/${encodeURIComponent(seriesId)}/${episode}${h264 ? '?h264=1' : ''}`);
}

/** 接口型源：三档网络模式都在本机媒体服务里收口，渲染层拿到的永远是 127.0.0.1 */
export function remoteSitePlayUrl(site: string, seriesId: string, episode: number): string {
  return mediaUrl(`/rs/${encodeURIComponent(site)}/${encodeURIComponent(seriesId)}/${Math.max(1, Number(episode) || 1)}`);
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

/** 局域网地址判断：只让媒体服务去连内网 / 环回地址，避免变成任意 URL 代理。 */
function isPrivateHost(host: string): boolean {
  const value = String(host || '').toLowerCase();
  if (value === 'localhost' || value.endsWith('.local')) return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 10 || a === 127) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }
  // IPv6 回环 / 链路本地
  return value === '::1' || value.startsWith('fe80:') || value.startsWith('fd');
}

/** 服务器上的成品（NAS 任务）：本机媒体服务带 token 转发，渲染层只拿本地地址。 */
export function nasUrl(taskId: string, index = 0, h264 = false): string {
  return mediaUrl(`/nas/${encodeURIComponent(taskId)}/${index}${h264 ? '?h264=1' : ''}`);
}

/** 其它设备局域网媒体服务上的成品：同样经本机媒体服务转发（顺便能兜住 H.265）。 */
export function remoteUrl(target: string, h264 = false): string {
  return mediaUrl(`/remote?u=${encode(target)}${h264 ? '&h264=1' : ''}`);
}

/** 本地已下载文件：先把 H.265 转好（要时间），再让播放器去请求，避免空等。 */
export async function prepareLocal(taskId: string, index = 0): Promise<void> {
  const task = listTasks().find((item) => item.id === taskId);
  if (!task) return;
  const found = episodeFile(task, index);
  if (found) await ensureH264(found.file);
}

/** 本地已下载文件：index=0 是合并成品，>0 是分集。 */
export function fileUrl(taskId: string, index = 0, h264 = false): string {
  return mediaUrl(`/file/${encodeURIComponent(taskId)}/${index}${h264 ? '?h264=1' : ''}`);
}

export function stop(): void {
  for (const job of remoteJobs.values()) {
    try { job.proc.kill('SIGTERM'); } catch { /* 已经退出 */ }
  }
  remoteJobs.clear();
  server?.close();
  server = null;
  port = 0;
}
