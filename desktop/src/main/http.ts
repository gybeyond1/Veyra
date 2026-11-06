import http from 'node:http';
import https from 'node:https';
import { execFile } from 'node:child_process';
import { URL } from 'node:url';
import zlib from 'node:zlib';
import { readSettings } from './store';

export interface JsonOptions {
  method?: string;
  body?: unknown;
  token?: string;
  timeoutMs?: number;
  /** 自建服务器常用自签证书，默认放行（只影响用户自己填的地址） */
  allowSelfSigned?: boolean;
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function decode(buffer: Buffer, encoding?: string): string {
  try {
    if (encoding === 'gzip') return zlib.gunzipSync(buffer).toString('utf8');
    if (encoding === 'deflate') return zlib.inflateSync(buffer).toString('utf8');
    if (encoding === 'br') return zlib.brotliDecompressSync(buffer).toString('utf8');
  } catch {
    /* 压缩头不可信时按原文处理 */
  }
  return buffer.toString('utf8');
}

/** 把 Node 的底层错误码翻成人话，别让用户看到 ECONNREFUSED。 */
function friendlyNetworkError(error: NodeJS.ErrnoException): string {
  switch (error.code) {
    case 'ECONNREFUSED':
      return '连不上服务器：地址或端口不对，或者服务没在运行';
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return '找不到这个服务器地址，检查是否填错';
    case 'ECONNRESET':
      return '连接被服务器断开，稍后重试';
    case 'ETIMEDOUT':
      return '连接超时，检查网络或服务器是否在线';
    case 'CERT_HAS_EXPIRED':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
      return '服务器证书有问题（自签证书请用 http 地址）';
    default:
      return error.message || '网络错误';
  }
}

export function requestJson<T = unknown>(base: string, pathname: string, options: JsonOptions = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(pathname, base.endsWith('/') ? base : `${base}/`);
    } catch {
      reject(new HttpError(400, '服务器地址无效'));
      return;
    }
    const isHttps = url.protocol === 'https:';
    const payload = options.body === undefined ? null : Buffer.from(JSON.stringify(options.body), 'utf8');
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': 'Veyra-Desktop/0.1',
    };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(payload.length);
    }
    if (options.token) headers.Authorization = `Bearer ${options.token}`;

    const request = (isHttps ? https : http).request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: options.method || (payload ? 'POST' : 'GET'),
        headers,
        timeout: options.timeoutMs ?? 20000,
        rejectUnauthorized: options.allowSelfSigned === false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(chunk as Buffer));
        response.on('end', () => {
          const text = decode(Buffer.concat(chunks), String(response.headers['content-encoding'] || ''));
          const status = response.statusCode || 0;
          if (status >= 400) {
            let message = text.slice(0, 300);
            try {
              const parsed = JSON.parse(text);
              message = parsed.error || parsed.message || message;
            } catch {
              /* 保持原文 */
            }
            reject(new HttpError(status, message || `HTTP ${status}`));
            return;
          }
          if (!text.trim()) {
            resolve(undefined as T);
            return;
          }
          try {
            resolve(JSON.parse(text) as T);
          } catch {
            reject(new HttpError(502, '服务器返回的不是 JSON，检查地址是否填错'));
          }
        });
      },
    );
    request.on('timeout', () => request.destroy(new Error('连接超时，检查服务器地址和网络')));
    request.on('error', (error: NodeJS.ErrnoException) => {
      reject(new Error(friendlyNetworkError(error)));
    });
    if (payload) request.write(payload);
    request.end();
  });
}

const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36';

/* ---------------- Node 原生抓取（长连接） ----------------
 * 只用于「协议、自家后端」这类不需要伪装 TLS 指纹的地址。
 * 起 curl 子进程一请求一个进程，首页几十张封面 + 播放时每 4 秒一个分片，
 * 光进程创建就把 Windows 拖死，也是「PC 私密模式比手机慢一大截」的主因。
 */
const agents = {
  http: new http.Agent({ keepAlive: true, maxSockets: 8 }),
  https: new https.Agent({ keepAlive: true, maxSockets: 8 }),
};

function nodeGet(url: string, timeoutMs: number, headers?: Record<string, string>, binary = false): Promise<any> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      reject(new Error('地址无效'));
      return;
    }
    const isHttps = parsed.protocol === 'https:';
    const request = (isHttps ? https : http).request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method: 'GET',
        headers: { 'User-Agent': MOBILE_UA, ...(headers || {}) },
        agent: agents[isHttps ? 'https' : 'http'],
        timeout: timeoutMs,
        rejectUnauthorized: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(chunk as Buffer));
        response.on('end', () => {
          const buffer = Buffer.concat(chunks);
          const status = response.statusCode || 0;
          if (status >= 400) {
            reject(new HttpError(status, `HTTP ${status}`));
            return;
          }
          if (binary) {
            resolve(buffer);
            return;
          }
          resolve(decode(buffer, String(response.headers['content-encoding'] || '')));
        });
        response.on('error', (error) => reject(new Error(friendlyNetworkError(error as NodeJS.ErrnoException))));
      },
    );
    request.on('timeout', () => request.destroy(new Error('请求超时')));
    request.on('error', (error: NodeJS.ErrnoException) => reject(new Error(friendlyNetworkError(error))));
    request.end();
  });
}

/** 抓文本（走 Node 长连接，用于自家后端通道）。 */
export function fetchTextFast(url: string, timeoutMs = 10000, headers?: Record<string, string>): Promise<string> {
  return nodeGet(url, timeoutMs, headers, false);
}

/** 抓二进制（走 Node 长连接，用于自家后端通道）。 */
export function fetchBinaryFast(url: string, timeoutMs = 10000, headers?: Record<string, string>): Promise<Buffer> {
  return nodeGet(url, timeoutMs, headers, true);
}

/**
 * 简单并发闸门：封面一次最多同时抓 N 张。
 * 不限并发的话，一个 40 张卡片的分类页会瞬间起 40 个 curl，
 * 后端通道被自己打满，反而大量超时、封面缺失。
 */
export function limitConcurrency<T>(items: T[], size: number, worker: (item: T, index: number) => Promise<void>): Promise<void> {
  const queue = items.map((item, index) => ({ item, index }));
  const workers = Array.from({ length: Math.max(1, Math.min(size, queue.length)) }, async () => {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      await worker(next.item, next.index);
    }
  });
  return Promise.all(workers).then(() => undefined);
}

/**
 * 抓网页文本：先走系统 curl。
 * 红果/黄果的边缘节点会按 TLS 指纹拦 Node 客户端，curl 反而正常；
 * Windows 10 1803 起自带 curl.exe，打包时另外附带一份，不依赖用户环境。
 */
function curlArgs(url: string, timeoutMs: number, headers?: Record<string, string>): string[] {
  const args = ['-s', '-L', '-m', String(Math.max(3, Math.round(timeoutMs / 1000)))];
  // 「仅代理」模式：所有外网请求都走用户填的代理；本地回环（自家后端）永远直连
  const settings = readSettings();
  const local = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/i.test(url);
  if (settings.proxyMode === 2 && settings.proxy && !local) {
    args.push('-x', settings.proxy.trim());
  }
  const custom = headers || {};
  if (!Object.keys(custom).some((key) => key.toLowerCase() === 'user-agent')) args.push('-A', MOBILE_UA);
  for (const [key, value] of Object.entries(custom)) {
    if (!value) continue;
    args.push('-H', `${key}: ${value}`);
  }
  args.push(url);
  return args;
}

export function fetchText(url: string, timeoutMs = 10000, headers?: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'curl',
      curlArgs(url, timeoutMs, headers),
      { maxBuffer: 12 * 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        if (error) {
          reject(new Error(`抓取失败：${error.message}`));
          return;
        }
        resolve(String(stdout || ''));
      },
    );
  });
}

/** 抓二进制（封面、m3u8 分片）：同样走 curl，避开源站对 Node TLS 指纹的风控。 */
export function fetchBinary(
  url: string,
  timeoutMs = 10000,
  headers?: Record<string, string>,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      'curl',
      curlArgs(url, timeoutMs, headers),
      { maxBuffer: 64 * 1024 * 1024, encoding: 'buffer', windowsHide: true },
      (error, stdout) => {
        if (error) {
          reject(new Error(`抓取失败：${error.message}`));
          return;
        }
        resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout || ''));
      },
    );
  });
}
