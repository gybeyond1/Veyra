'use strict';
/**
 * 私密多源公共工具：HTTP 抓取 / 内存缓存 / m3u8 重写 / 播放令牌。
 *
 * 为什么不用 proxy-fetch 的 curl：那套是给"源站按 TLS 指纹拦 Node"的黄果站点用的，
 * 每张图/每个分片起一个进程，首页几十个并发直接把机器打满（PC 端慢的根因）。
 * 这里的源都是普通 JSON/HTML 接口，Node 原生 keep-alive 又快又省。
 */

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const crypto = require('crypto');

const agents = {
  'http:': new http.Agent({ keepAlive: true, maxSockets: 24 }),
  'https:': new https.Agent({ keepAlive: true, maxSockets: 24 }),
};

const UA =
  'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36';

/**
 * GET/POST 一个地址，自动跟随 3 次重定向、解 gzip/deflate/br、限制体积。
 * 返回 { status, headers, body: Buffer, text() }。
 */
function request(url, options = {}) {
  const {
    method = 'GET',
    headers = {},
    timeout = 15000,
    maxBytes = 8 << 20,
    redirects = 3,
    body,
  } = options;

  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      return reject(new Error('无效地址'));
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return reject(new Error('仅支持 http/https'));

    const lib = target.protocol === 'http:' ? http : https;
    const req = lib.request(
      target,
      {
        method,
        headers: { 'User-Agent': UA, 'Accept-Encoding': 'gzip, deflate, br', ...headers },
        agent: agents[target.protocol],
        timeout,
      },
      (res) => {
        const location = res.headers.location;
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && location && redirects > 0) {
          res.resume();
          let next;
          try {
            next = new URL(location, target).toString();
          } catch {
            return reject(new Error('重定向地址无效'));
          }
          return resolve(request(next, { ...options, redirects: redirects - 1 }));
        }
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            req.destroy(new Error('响应超过大小限制'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          let buffer = Buffer.concat(chunks);
          const encoding = String(res.headers['content-encoding'] || '').toLowerCase();
          try {
            if (encoding.includes('gzip')) buffer = zlib.gunzipSync(buffer);
            else if (encoding.includes('deflate')) buffer = zlib.inflateSync(buffer);
            else if (encoding.includes('br')) buffer = zlib.brotliDecompressSync(buffer);
          } catch {
            /* 解压失败就用原始字节 */
          }
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: buffer,
            text: () => buffer.toString('utf8'),
          });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/**
 * 经代理抓取：私密模式的「仅代理」通道。
 *
 * 为什么这里退回 curl（而不是给 Node 套 agent）：socks5 需要额外依赖，
 * 而 proxy-fetch.js 已经在用系统 curl 做 http/socks5 双协议，Dockerfile 也装了 curl。
 * 代价是每个请求一个进程，只用在用户显式选了「仅代理」的分支上。
 */
function requestViaProxy(url, options = {}, proxyUrl) {
  const { requestThroughProxy } = require('../proxy-fetch');
  const { headers = {}, timeout = 15000, maxBytes = 8 << 20, method = 'GET', body } = options;
  // curl 走代理时自己处理压缩，不要再要求 gzip（否则拿到的是压缩字节没人解）
  const clean = { ...headers };
  delete clean['Accept-Encoding'];
  return new Promise((resolve, reject) => {
    const sent = body ? (typeof body === 'string' ? Buffer.from(body) : body) : null;
    if (sent) clean['Content-Length'] = String(sent.length);
    requestThroughProxy(
      url,
      proxyUrl,
      { headers: clean, timeout, maxBytes, redirects: 3 },
      (error, result) => {
        if (error) return reject(error);
        if (method !== 'GET' && method !== 'POST') {
          // curl 分支只按 GET 发；POST 的源目前没有，留个明确的错而不是静默降级
          return reject(new Error('仅代理通道暂不支持该请求方法'));
        }
        resolve({
          status: result.status,
          headers: result.headers || {},
          body: result.body,
          text: () => result.body.toString('utf8'),
        });
      }
    );
  });
}

/** 有代理走代理，没代理走原生 keep-alive 直连。 */
function requestVia(url, options = {}, proxyUrl = '') {
  return proxyUrl ? requestViaProxy(url, options, proxyUrl) : request(url, options);
}

/** GET JSON：非 2xx 或不是 JSON 都抛错，调用方决定怎么兜底。 */
async function getJSON(url, options = {}) {
  const res = await request(url, { ...options, headers: { Accept: 'application/json, text/plain, */*', ...(options.headers || {}) } });
  if (res.status < 200 || res.status >= 300) throw new Error(`源站返回 ${res.status}`);
  try {
    return JSON.parse(res.text());
  } catch {
    throw new Error('源站返回的不是 JSON');
  }
}

/* ---------------- 内存缓存 ---------------- */
const store = new Map();
const MAX_ENTRIES = 600;

function cacheGet(key) {
  const hit = store.get(key);
  if (!hit) return null;
  if (hit.expires && hit.expires < Date.now()) {
    store.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value, ttl) {
  if (store.size >= MAX_ENTRIES) {
    // 简单淘汰：清掉最早写入的一批，够用（缓存都是可重算的）
    let index = 0;
    for (const old of store.keys()) {
      store.delete(old);
      if (++index > 100) break;
    }
  }
  store.set(key, { value, expires: ttl ? Date.now() + ttl : 0 });
}

/** 带缓存取数：同一 key 并发只打一次源站。 */
const inflight = new Map();
async function cached(key, ttl, loader) {
  const hit = cacheGet(key);
  if (hit) return hit;
  if (inflight.has(key)) return inflight.get(key);
  const job = (async () => {
    try {
      const value = await loader();
      cacheSet(key, value, ttl);
      return value;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, job);
  return job;
}

/* ---------------- 播放令牌 ---------------- */
/**
 * 播放地址不能直接给客户端：剧果这类源的分片要靠 Set-Cookie 的 CloudFront 签名，
 * 手机/电视的播放器带不上，只能由后端持有。
 * 令牌绑账号、10 分钟过期，避免把后端变成开放代理。
 */
const tokens = new Map();
const TOKEN_TTL = 10 * 60 * 1000;

function issueToken(userId, payload) {
  const token = crypto.randomBytes(16).toString('hex');
  tokens.set(token, { userId, ...payload, expires: Date.now() + TOKEN_TTL });
  return token;
}

function readToken(token) {
  const hit = tokens.get(token);
  if (!hit) return null;
  if (hit.expires < Date.now()) {
    tokens.delete(token);
    return null;
  }
  return hit;
}

// 定期清理过期令牌，避免长期运行内存只增不减
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of tokens) if (value.expires < now) tokens.delete(key);
}, 60 * 1000).unref();

/* ---------------- m3u8 ---------------- */
/**
 * 重写 m3u8：普通 URI 行和 #EXT-X-KEY / #EXT-X-MAP 的 URI="..." 全部换成后端代理地址。
 * wrap(absoluteUrl) 由各源决定（要带上自己的令牌）。
 */
function rewritePlaylist(text, baseUrl, wrap) {
  const resolve = (raw) => {
    try {
      return new URL(raw, baseUrl).toString();
    } catch {
      return '';
    }
  };
  return text
    .replace(/(URI=")([^"]+)(")/g, (match, head, uri, tail) => {
      const target = resolve(uri);
      return target ? head + wrap(target) + tail : match;
    })
    .replace(/^(?!#)(.+)$/gm, (line) => {
      const uri = line.trim();
      if (!uri) return line;
      const target = resolve(uri);
      return target ? wrap(target) : line;
    });
}

/**
 * 回给播放器的绝对地址前缀。
 * 不能按 host 猜协议：很多人用 http://公网IP:8080 直连，猜成 https 后播放器会去敲
 * 一个根本没开 TLS 的端口，表现就是清单加载不出来、黑屏。优先取反代透传的
 * x-forwarded-proto，其次 express 解析出的 req.protocol。
 */
function baseUrlOf(req) {
  const host = String(req.headers.host || '');
  const only = host.split(':')[0].toLowerCase();
  const isPrivate = /^(localhost|127\.0\.0\.1|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(only);
  const forwarded = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  const protocol = forwarded === 'https' || forwarded === 'http'
    ? forwarded
    : (req.protocol === 'https' ? 'https' : (isPrivate ? 'http' : (req.protocol || 'http')));
  return `${protocol}://${host}`;
}

module.exports = {
  request,
  requestVia,
  getJSON,
  cached,
  cacheGet,
  cacheSet,
  issueToken,
  readToken,
  rewritePlaylist,
  baseUrlOf,
  UA,
};
