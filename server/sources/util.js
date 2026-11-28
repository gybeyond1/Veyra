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

/* 少数源站的证书是过期的（黄豆的备用线 xqjurgek.top 就是），这些站只用来
   取剧集数据、不接受任何登录凭证，所以给一个显式放行的 agent；
   调用方要主动传 insecure: true 才会用到，其它请求照常校验证书。 */
const looseAgents = {
  'http:': agents['http:'],
  'https:': new https.Agent({ keepAlive: true, maxSockets: 24, rejectUnauthorized: false }),
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
    insecure = false,
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
        agent: (insecure ? looseAgents : agents)[target.protocol],
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

/**
 * 强制走 curl 的抓取（不管有没有代理）。
 *
 * 为什么单开一个：黄果系站点按 TLS 指纹（ClientHello/JA3）风控，
 * Node 原生 https 在部分出口上不是 400 就是干等（实测 8 秒无响应），
 * 而 curl 的握手特征更接近浏览器，同一台机器同一时刻就能通。
 * 这就是「手机上能看、后端体检全红」的根因 —— 手机走的是 curl/原生播放器。
 * 代价是每次请求起一个进程，只用在这几个源的元数据请求（首页/详情/播放地址）上。
 */
function requestCurl(url, options = {}, proxyUrl = '') {
  /* 证书主机名不匹配时用 -k 再来一次：黄果这类站点是多域名轮换 + 共享 CDN 证书，
     huangguoai.io 解析到的节点证书常常只签了别的名字（curl 60），内容本身没问题。
     只在这一类错误上降级，不影响其他失败照常暴露。 */
  return curlOnce(url, options, proxyUrl, options.insecure === true).catch((error) => {
    const text = String((error && error.message) || '');
    if (options.insecure !== true && /SSL|certificate|CERT|self.signed/i.test(text)) {
      return curlOnce(url, options, proxyUrl, true);
    }
    throw error;
  });
}

function curlOnce(url, options = {}, proxyUrl = '', insecure = false) {
  const { requestThroughProxy } = require('../proxy-fetch');
  const { assertPublicUrl } = require('../ssrf-guard');
  const { method = 'GET', headers = {}, timeout = 20000, maxBytes = 8 << 20, redirects = 5, body } = options;
  const clean = { ...headers };
  // curl 自己解压，别要求 gzip（否则拿到的是压缩字节没人解）
  delete clean['Accept-Encoding'];
  const sent = body === undefined || body === null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
  if (sent !== null) clean['Content-Type'] = clean['Content-Type'] || 'application/json';
  return new Promise((resolve, reject) => {
    requestThroughProxy(
      url,
      proxyUrl,
      { headers: clean, timeout, maxBytes, redirects, method, body: sent, guard: assertPublicUrl, insecure },
      (error, result) => {
        if (error) return reject(error);
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

/** Node 侧失败里哪些值得再用 curl 试一次：TLS 指纹被拒、连接被重置、干等超时 */
function worthCurlRetry(error) {
  const text = String((error && error.message) || error || '');
  return /ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|TLS|SSL|handshake|请求超时|EAI_AGAIN|ETIMEDOUT|other side closed|aborted/i.test(text);
}

/* 管理台配的后端代理：由 sources/index.js 在 mount 时注册，provider 不用自己拿配置 */
let proxyProvider = null;
function setBackendProxy(fn) {
  proxyProvider = typeof fn === 'function' ? fn : null;
}

/**
 * 有代理走代理，没代理走原生 keep-alive 直连。
 * options.fallbackCurl 为真时（默认），Node 侧被风控/重置会再用 curl 打一次 ——
 * 这类站点认的是 TLS 特征，换客户端就能过，比直接报错有用得多。
 * options.backendProxy 为真时，没显式给代理就走管理台配置的后端代理
 * （帝果这种按出口 IP 拦的站，只能这么救）。
 */
async function requestVia(url, options = {}, proxyUrl) {
  const { fallbackCurl = true, backendProxy = false, ...rest } = options;
  let via = proxyUrl === undefined ? '' : proxyUrl;
  if (!via && backendProxy && proxyProvider) {
    try {
      via = String(proxyProvider() || '').trim();
    } catch {
      via = '';
    }
  }
  if (via) return requestViaProxy(url, rest, via);
  try {
    return await request(url, rest);
  } catch (error) {
    if (!fallbackCurl || !worthCurlRetry(error)) throw error;
    return requestCurl(url, rest, '');
  }
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

/*
 * 黄果系封面 AES-128-CBC 解密（与 APK SiteRepository/SiteProfile 同源逻辑，密钥来自 site-default.json 的 cover 配置）。
 * 源站封面是密文、响应头是 binary/octet-stream，<img> 直连必破图 —— 所以后端取完必须解一次。
 * 已经是正常图片时幂等返回，非黄果源不会受影响。
 */
/**
 * 黄果旧版（cloudfront 那套）的封面：**头部一段被换成乱码，后面的 JPEG 码流是明文**。
 * 实测前 494 字节不可读，从第一个 DQT（ff db）段开始就是正常数据，补一个 SOI 即可解码。
 * 少数图（渐进式）连 DQT 一起被卷进乱码区，这时按标准量化表补一段再拼 —— 实测画质正常，
 * 因为这类图本来用的就是标准表。这不是标准 AES，是那套 App 自己的图床保护。
 */
const STD_LUMA = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55,
  14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92,
  49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];
const STD_CHROMA = [
  17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99,
  24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
];
const STD_DQT = Buffer.concat([
  Buffer.from([0xff, 0xdb, 0x00, 0x43, 0x00]), Buffer.from(STD_LUMA),
  Buffer.from([0xff, 0xdb, 0x00, 0x43, 0x01]), Buffer.from(STD_CHROMA),
]);

function repairJpegHead(buf) {
  const limit = Math.min(buf.length - 4, 4096);
  const hasSos = (from) => buf.indexOf(Buffer.from([0xff, 0xda]), from) > from;

  // 1) 最理想：DQT 还在，直接补 SOI
  for (let i = 1; i < limit; i += 1) {
    if (buf[i] !== 0xff || buf[i + 1] !== 0xdb) continue;
    const segLen = buf.readUInt16BE(i + 2);
    if (segLen < 60 || segLen > 300) continue;
    if (!hasSos(i)) continue;
    return Buffer.concat([Buffer.from([0xff, 0xd8]), buf.subarray(i)]);
  }

  // 2) DQT 也没了：找 SOF，前面补标准量化表（SOF2 是渐进式，同样适用）
  for (let i = 1; i < limit; i += 1) {
    if (buf[i] !== 0xff) continue;
    const marker = buf[i + 1];
    if (marker !== 0xc0 && marker !== 0xc2) continue;
    const segLen = buf.readUInt16BE(i + 2);
    if (segLen < 8 || segLen > 300) continue;
    if (!hasSos(i)) continue;
    return Buffer.concat([Buffer.from([0xff, 0xd8]), STD_DQT, buf.subarray(i)]);
  }
  return null;
}

function decryptHuangguoCover(buf) {
  if (!buf || buf.length < 32) return buf;
  const isImage = (b) => b.length >= 12 && (
    (b[0] === 0xFF && b[1] === 0xD8) ||
    (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47 && b[4] === 0x0D && b[5] === 0x0A && b[6] === 0x1A && b[7] === 0x0A) ||
    (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) ||
    (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38)
  );
  if (isImage(buf)) return buf; // 已是有效图片（直连真图/已解密缓存）则幂等跳过
  let out = null;
  try {
    const d = crypto.createDecipheriv('aes-128-cbc',
      Buffer.from('f5d965df75336270', 'utf8'), Buffer.from('97b60374abc2fbe1', 'utf8'));
    out = Buffer.concat([d.update(buf), d.final()]);
  } catch {
    out = null;
  }
  // 头修复：签名校验后 offset 6 XOR 0x0E（APK repairCoverHeader 同款）
  if (out && out.length >= 12) {
    const png = out[0] === 0x89 && out[1] === 0x50 && out[2] === 0x4E && out[3] === 0x47 &&
      out[4] === 0x0D && out[5] === 0x0A && out[6] === 0x14 && out[7] === 0x0A;
    const jpeg = out[0] === 0xFF && out[1] === 0xD8 && out[2] === 0xFF;
    let ok = false;
    if (png) ok = true;
    else if (jpeg) {
      if (out[3] === 0xE0) ok = (out[6] === 0x44 && out[7] === 0x46 && out[8] === 0x49 && out[9] === 0x46 && out[10] === 0);
      else if (out[3] === 0xDB) ok = ((out[6] & 0xFC) === 0x0C);
      else if (out[3] === 0xE1) ok = (out[6] === 0x4B && out[7] === 0x78 && out[8] === 0x69 && out[9] === 0x66);
      else if (out[3] === 0xE2) ok = (out[6] === 0x47 && out[7] === 0x43 && out[8] === 0x43 && out[9] === 0x5F);
    }
    if (ok) out[6] ^= 0x0E;
  }
  if (out && isImage(out)) return out;
  // AES 不成立时再按「头部被换成乱码」处理一次（黄果旧版图床就是这种）
  const patched = repairJpegHead(buf);
  if (patched && isImage(patched)) return patched;
  return buf;
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
  requestCurl,
  requestVia,
  setBackendProxy,
  getJSON,
  cached,
  cacheGet,
  cacheSet,
  issueToken,
  readToken,
  rewritePlaylist,
  baseUrlOf,
  decryptHuangguoCover,
  UA,
};
