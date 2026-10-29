#!/usr/bin/env node
/**
 * Veyra 轻量后端
 *
 * 零原生依赖（仅 express），数据落在 /data 目录（JSON 文件 + 头像文件），
 * 通过 Docker volume 持久化。Node 单线程 + 同步 fs，低流量自用场景足够安全。
 *
 * 接口一览（均 JSON）：
 *   GET  /api/health                         健康检查
 *   POST /api/register  {username,password}  注册 -> {token,user}
 *   POST /api/login     {username,password}  登录 -> {token,user}
 *   POST /api/logout    (Bearer)             注销 -> 204
 *   POST /api/change-password (Bearer) {oldPassword,newPassword} -> {token,user}
 *   POST /api/avatar    (Bearer) {data:base64} 上传头像 -> {user}
 *   GET  /api/avatar/:id.jpg                 头像文件
 *   GET  /api/library?source=hongguo|huangguo (Bearer) -> {payload}
 *   PUT  /api/library   (Bearer) {source,payload} -> {synced:true}
 *
 * 认证：Authorization: Bearer <token>（32 字节随机 hex，服务端会话表）。
 * 密码：Node 内置 crypto.scrypt（加盐），不落明文。
 */
'use strict';

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const downloader = require('./downloader');
const hgApp = require('./hongguo-app');

const PORT = parseInt(process.env.PORT || '8080', 10);
// 数据目录：环境变量指定，默认 /data（docker-compose volume 挂载）。
// 裸跑/本地运行根目录不可写时自动回退到可写目录，避免服务因 EACCES 直接崩溃。
let DATA_DIR = process.env.DATA_DIR || '/data';
(function resolveDataDir() {
  const candidates = [DATA_DIR, path.join(process.cwd(), 'data'), path.join(os.tmpdir(), 'veyra-data')];
  for (const dir of candidates) {
    try { fs.mkdirSync(dir, { recursive: true }); fs.accessSync(dir, fs.constants.W_OK); DATA_DIR = dir; return; }
    catch { /* try next */ }
  }
  console.warn(`[veyra] 数据目录均不可写，继续使用 ${DATA_DIR}（配置将无法持久化）`);
})();
const TOKEN_TTL_MS = 90 * 24 * 3600 * 1000; // 90 天
const MAX_AVATAR_BYTES = 512 * 1024;
const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;
const USERNAME_RE = /^[A-Za-z0-9_]{3,24}$/;
// 开放注册开关：首次启动用环境变量 REGISTER_OPEN 初始化（默认开放），
// 之后在 WebUI 管理台实时开关（持久化到 DATA_DIR/settings.json，无需重启/重建）
let registerOpen = process.env.REGISTER_OPEN !== 'false' && process.env.REGISTER_OPEN !== '0';
// 后端代理（黄果转发用）：WebUI 管理台配置，留空 = 后端直连抓取
let backendProxy = '';
try {
  const savedSettings = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'settings.json'), 'utf8'));
  if (typeof savedSettings.registerOpen === 'boolean') registerOpen = savedSettings.registerOpen;
  if (typeof savedSettings.backendProxy === 'string') backendProxy = savedSettings.backendProxy;
} catch { /* 首次运行，用环境变量默认值 */ }
function saveSettings() {
  const settingsFile = path.join(DATA_DIR, 'settings.json');
  const tmp = settingsFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ registerOpen, backendProxy }, null, 2));
  fs.renameSync(tmp, settingsFile);
}
// WebUI 管理员密码（环境变量 ADMIN_PASSWORD 配置，未配置则管理功能不可用）
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
// 注册限流：同一 IP 10 分钟内最多 5 次注册，防公网扫描器/爬虫批量注册
const REG_WINDOW_MS = 10 * 60 * 1000;
const REG_LIMIT = 5;
const regHits = new Map(); // ip -> [timestamp...]
function regTooFrequent(req) {
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    (req.socket && req.socket.remoteAddress) || 'unknown';
  const now = Date.now();
  const arr = (regHits.get(ip) || []).filter(t => now - t < REG_WINDOW_MS);
  if (arr.length >= REG_LIMIT) return true;
  arr.push(now);
  regHits.set(ip, arr);
  return false;
}
const ADMIN_SESSION_TTL_MS = 8 * 3600 * 1000; // 管理员会话 8 小时
const adminSessions = new Map(); // adminToken -> expiry ms

// 黄果站点域名白名单（后端转发接口只允许抓这些域名，避免变成开放代理）
// 主站为 *.pqhybuxo.cc 系；封面 CDN pic.drleao.cn / 详情图 expose.eisees.com；视频播放 yd-hls.hzjvlo.cn；
// hongguoduanju.com 为红果官方站（搜索联想接口 /incent_resource/suggestion 补全短剧名用）
const HUANGGUO_HOST_RE = /(^|\.)(pqhybuxo\.cc|im41z53s\.cc|huangguoju\.com|drleao\.cn|eisees\.com|hzjvlo\.cn|hongguoduanju\.com|douyinpic\.com|douyinvod\.com|byteicdn\.com|byteimg\.com|bytetos\.com)$/i;
const proxyFetch = require('./proxy-fetch');

// ---- TOTP 动态码（RFC 6238，30 秒窗口，6 位）----
const OTP_WINDOW = 30; // 秒
const OTP_DIGITS = 6;
function base32Decode(input) {
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0;
  const out = [];
  for (const ch of String(input).toUpperCase()) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}
function ensureOtpSecret() {
  const otpFile = path.join(DATA_DIR, 'otp.json');
  let data = {};
  try { data = JSON.parse(fs.readFileSync(otpFile, 'utf8')); } catch { /* 首次运行 */ }
  if (!data.secret) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let secret = '';
    for (let i = 0; i < 32; i++) secret += chars[Math.floor(Math.random() * chars.length)];
    data.secret = secret;
    data.lastReset = Date.now();
    const tmp = otpFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, otpFile);
  }
  return data;
}
function totpCode(otpData, windowOffset) {
  const counter = Math.floor(Date.now() / 1000 / OTP_WINDOW) + windowOffset;
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigInt64BE(BigInt(counter));
  const key = base32Decode(otpData.secret);
  const hmac = crypto.createHmac('sha1', key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(bin % 1000000).padStart(OTP_DIGITS, '0');
}
function verifyOtp(code) {
  const input = String(code || '').trim();
  if (!/^\d{6}$/.test(input)) return false;
  const otpData = ensureOtpSecret();
  // 容忍 ±1 个窗口，避免手机与服务器时钟轻微偏差
  for (let w = -1; w <= 1; w++) if (totpCode(otpData, w) === input) return true;
  return false;
}

fs.mkdirSync(DATA_DIR, { recursive: true });
const AVATAR_DIR = path.join(DATA_DIR, 'avatars');
fs.mkdirSync(AVATAR_DIR, { recursive: true });

const file = name => path.join(DATA_DIR, name + '.json');

function load(name) {
  try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); }
  catch { return {}; }
}
function save(name, data) {
  const tmp = file(name) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file(name));
}

const users = load('users');         // id -> {id,username,password,salt,avatar,createdAt}
const sessions = load('sessions');   // token -> {userId, createdAt, lastSeen}
const library = load('library');     // userId -> { source -> {updatedAt, payload} }

function flush() { save('users', users); save('sessions', sessions); save('library', library); }

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}
function newUserRecord(username, password, device) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { id: crypto.randomBytes(12).toString('hex'), username, password: hashPassword(password, salt),
           salt, passwordPlain: password, device: device || '', avatar: null, role: 'user',
           createdAt: Date.now(), updatedAt: Date.now() };
}
function issueToken(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions[token] = { userId, createdAt: Date.now(), lastSeen: Date.now() };
  return token;
}
function publicUser(user) {
  const role = ['admin', 'vip', 'user'].includes(user.role) ? user.role : 'user';
  return { id: user.id, username: user.username, avatar: user.avatar, createdAt: user.createdAt,
           role,
           huangguoUnlocked: Boolean(user.huangguoUnlocked) };
}

// ---- WebUI 管理员会话 ----
function extractBearer(req) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+([a-f0-9]{64})$/i);
  return match ? match[1] : null;
}
function requireAdmin(req, res, next) {
  if (!ADMIN_PASSWORD) return res.status(503).json({ error: '服务端未配置 ADMIN_PASSWORD，管理功能不可用' });
  const token = extractBearer(req);
  const expiry = token && adminSessions.get(token);
  if (!expiry || Date.now() > expiry) {
    if (token) adminSessions.delete(token);
    return res.status(401).json({ error: '管理员未登录或会话已过期' });
  }
  adminSessions.set(token, Date.now() + ADMIN_SESSION_TTL_MS); // 滑动续期
  next();
}
function issueAdminToken() {
  const token = crypto.randomBytes(32).toString('hex');
  adminSessions.set(token, Date.now() + ADMIN_SESSION_TTL_MS);
  return token;
}

// NAS 下载任务鉴权双通道：WebUI 管理台 adminToken，或 APK 里 role=admin 的账号 token（两套体系都认）
function requireAdminOrAccountAdmin(req, res, next) {
  if (!ADMIN_PASSWORD) return res.status(503).json({ error: '服务端未配置 ADMIN_PASSWORD，管理功能不可用' });
  const token = extractBearer(req);
  const expiry = token && adminSessions.get(token);
  if (expiry && Date.now() <= expiry) {
    adminSessions.set(token, Date.now() + ADMIN_SESSION_TTL_MS); // 滑动续期
    return next();
  }
  if (token) adminSessions.delete(token);
  const session = token && sessions[token];
  const user = session && users[session.userId];
  if (user && user.role === 'admin') {
    session.lastSeen = Date.now();
    req.user = user;
    return next();
  }
  return res.status(401).json({ error: '管理员未登录或会话已过期' });
}

function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+([a-f0-9]{64})$/i);
  const session = match && sessions[match[1]];
  if (!session) return res.status(401).json({ error: '登录已失效，请重新登录' });
  const user = users[session.userId];
  if (!user) return res.status(401).json({ error: '账号不存在，请重新登录' });
  session.lastSeen = Date.now();
  req.user = user;
  req.token = match[1];
  next();
}
function needUser(req, res) {
  if (!req.user) { res.status(401).json({ error: '请先登录' }); return false; }
  return true;
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '3mb' }));

// 状态页（WebUI：需管理员密码登录后可见全部管理与用户信息）
app.get('/', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  // 禁缓存：浏览器/反代缓存旧页面会导致 script 指向旧 CDN、hls.js 加载失败（错误码4）
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.sendFile(path.join(__dirname, 'webui.html'));
});

// hls.js 本地托管：不依赖 cdn.jsdelivr.net（国内网络不稳定会导致 m3u8 播放直接失败）
app.get('/hls.min.js', (_req, res) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(path.join(__dirname, 'hls.min.js'));
});

// ---- Web 端红果内容代理（hongguoduanju.com 公开页，无需签名）----
const { execFile } = require('child_process');

function curlGet(url, timeoutMs, cb) {
  execFile('curl', ['-s', '-L', '-m', String(timeoutMs || 10), '-A',
    'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36',
    url], { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => cb(err, stdout || ''));
}

function extractRouterData(html) {
  const marker = html.indexOf('_ROUTER_DATA');
  if (marker < 0) throw new Error('页面没有内容数据');
  const first = html.indexOf('{', marker);
  if (first < 0) throw new Error('页面数据格式错误');
  let depth = 0, quoted = false, escaped = false;
  for (let i = first; i < html.length; i++) {
    const ch = html[i];
    if (quoted) { if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === '"') quoted = false; continue; }
    if (ch === '"') quoted = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') { depth--; if (depth === 0) return JSON.parse(html.substring(first, i + 1)); }
  }
  throw new Error('页面数据不完整');
}

function parseSeriesCard(o) {
  return {
    id: String(o.series_id || o.id || ''),
    title: o.series_name || o.series_title || o.title || o.name || '',
    cover: o.series_cover || o.cover || o.horizontal_cover || o.vertical_cover || '',
    badge: o.episode_cnt != null ? o.episode_cnt + '集' : (o.badge || ''),
    tags: o.tags || o.category_list || [],
    description: o.series_intro || o.description || '',
  };
}

app.get('/api/web/hongguo/home', (req, res) => {
  curlGet('https://hongguoduanju.com/category?tab=1&sort_type=1', 10000, (err, html) => {
    if (err) return res.status(502).json({ error: '抓取失败: ' + err.message });
    try {
      const router = extractRouterData(html).loaderData || {};
      const section = router.category_page || router.category_$ || {};
      const list = section.recommendList || (section.categoryData && section.categoryData.recommendList) || [];
      res.json({ items: list.map(parseSeriesCard) });
    } catch (e) { res.status(502).json({ error: '解析失败: ' + e.message }); }
  });
});

app.get('/api/web/hongguo/search', (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ items: [] });
  curlGet('https://hongguoduanju.com/api/search/result?query=' + encodeURIComponent(q) + '&page=1&page_size=20', 10000, (err, html) => {
    if (err) return res.status(502).json({ error: '搜索失败: ' + err.message });
    try {
      const json = JSON.parse(html);
      const list = json.searchList || [];
      res.json({ items: list.map(parseSearchCard) });
    } catch (e) { res.status(502).json({ error: '解析失败: ' + e.message }); }
  });
});

function parseSearchCard(o) {
  const vd = o.video_data || {};
  return {
    id: String(vd.series_id || o.keyword || ''),
    title: vd.series_title || o.name || '',
    cover: vd.series_cover || '',
    badge: vd.episode_right_text || (vd.episode_cnt ? vd.episode_cnt + '集' : ''),
    tags: (vd.category_list || []).map(c => c.name).filter(Boolean),
    description: vd.series_intro || '',
  };
}

app.get('/api/web/hongguo/detail', async (req, res) => {
  const id = String(req.query.id || '').trim();
  if (!id) return res.status(400).json({ error: '缺少 id' });
  curlGet('https://hongguoduanju.com/detail/' + id, 10000, (err, html) => {
    if (err) return res.status(502).json({ error: '抓取失败: ' + err.message });
    let raw;
    try { raw = extractRouterData(html).loaderData || {}; }
    catch (e) { return res.status(502).json({ error: '解析失败: ' + e.message }); }
    // 从详情页 episode_list 提取每集 vid（供 WebUI 播放 /api/web/hongguo/stream）
    const eps = (raw.detail_page && raw.detail_page.episode_list) || (raw.episode_list) || [];
    let vids = eps.map(e => String(e && (e.vid || e.id || '')).trim()).filter(v => v);
    (async () => {
      if (!vids.length) {
        try {
          const det = await hgApp.videoDetail(id);
          vids = det.vids || [];
        } catch (e) { console.log('[detail] videoDetail 兜底失败:', e.message); }
      }
      res.json({ raw, vids });
    })();
  });
});

// 红果分类页：tab=1 推荐，其余为题材 slug（romance/period/legend…，与 APK 一致），返回题材分类条 + 列表
app.get('/api/web/hongguo/category', (req, res) => {
  const tab = String(req.query.tab || '1').replace(/[^0-9a-zA-Z-]/g, '');
  const url = tab === '1'
    ? 'https://hongguoduanju.com/category/real-drama'
    : 'https://hongguoduanju.com/category/real-drama/' + encodeURIComponent(tab);
  curlGet(url, 10000, (err, html) => {
    if (err) return res.status(502).json({ error: '抓取失败: ' + err.message });
    try {
      const router = extractRouterData(html).loaderData || {};
      const section = router.category_page || router.category_$ || {};
      // 题材分类条：selectorList 第一行 items（selector_item_id + show_name）
      const tabs = (section.selectorList || [])
        .filter(r => String(r.row_id) === '1')
        .flatMap(r => (r.items || []))
        .map(c => ({ tab: String(c.selector_item_id || ''), name: String(c.show_name || '') }))
        .filter(t => t.tab && t.name);
      const list = section.recommendList || [];
      res.json({ tabs, items: list.map(parseSeriesCard) });
    } catch (e) { res.status(502).json({ error: '解析失败: ' + e.message }); }
  });
});

// 红果单集播放：签名取流（内置 videoModel）-> ffmpeg 解密转封装（浏览器不能播 CENC 密文）-> 明文 MP4 直发（sendFile 支持 Range 拖动）
const { spawn } = require('child_process');
app.get('/api/web/hongguo/stream', async (req, res) => {
  const vid = String(req.query.vid || '').trim();
  if (!vid) return res.status(400).json({ error: '缺少 vid' });
  const safeVid = vid.replace(/[^a-zA-Z0-9_-]/g, '');
  const streamDir = path.join(os.tmpdir(), 'veyra-stream');
  const outFile = path.join(streamDir, safeVid + '.mp4');
  try { fs.mkdirSync(streamDir, { recursive: true }); } catch { /* ignore */ }
  if (fs.existsSync(outFile) && fs.statSync(outFile).size > 100000) return res.sendFile(outFile);
  console.log('[stream]', new Date().toISOString(), 'vid', vid);
  try {
    const { url: mainUrl, key } = await hgApp.videoModel(vid);
    const args = ['-hide_banner', '-loglevel', 'error', '-y'];
    if (key && /^[0-9a-fA-F]{32}$/.test(key)) args.push('-decryption_key', key.toLowerCase());
    args.push('-i', mainUrl, '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', outFile);
    await new Promise((resolve, reject) => {
      const p = spawn('ffmpeg', args, { timeout: 300000 });
      let err = '';
      p.stderr.on('data', d => { err += d.toString(); if (err.length > 4096) err = err.slice(-4096); });
      p.on('close', code => code === 0 ? resolve() : reject(new Error('转封装失败: ' + err.slice(-300))));
      p.on('error', reject);
    });
    if (!fs.existsSync(outFile) || fs.statSync(outFile).size < 100000) throw new Error('转封装无有效输出');
    console.log('[stream] OK', vid, fs.statSync(outFile).size);
    res.sendFile(outFile);
  } catch (e) {
    console.log('[stream] ERR', vid, e.message);
    res.status(502).json({ error: '播放取流失败: ' + e.message });
  }
});

// 红果中转取流代理：手机直连 djapi.999888456.xyz 被墙，由后端转发
app.get('/api/hongguo/relay-play', (req, res) => {
  const seriesId = String(req.query.series_id || '').trim();
  const vid = String(req.query.vid || '').trim();
  if (!seriesId || !vid) return res.status(400).json({ error: '缺少 series_id 或 vid' });
  const ref = { content_type: 1004, from_video_id: '', series_id: seriesId, vid: vid, video_platform: 3 };
  const b64 = Buffer.from(JSON.stringify(ref)).toString('base64');
  const target = 'https://djapi.999888456.xyz/api/hongguo/play?id=' + encodeURIComponent(b64);
  console.log('[relay]', new Date().toISOString(), 'series', seriesId, 'vid', vid);
  proxyFetch.requestThroughProxy(target, backendProxy, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 16; 25053RT47C) AppleWebKit/537.36' },
    timeout: 15000, maxBytes: 512 * 1024, redirects: 3,
  }, (err, result) => {
    if (err) {
      console.log('[relay] ERR', err.message);
      return res.status(502).json({ error: '中转请求失败: ' + err.message });
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(result.body.toString('utf-8'));
  });
});

// 直连取流：调用本地签名链路（videoModel），返回全清晰度 CDN 直链（APK 本地解密）
app.get('/api/hongguo/play-direct', async (req, res) => {
  const vid = String(req.query.vid || '').trim();
  if (!vid) return res.status(400).json({ error: '缺少 vid' });
  console.log('[play-direct]', new Date().toISOString(), 'vid', vid);
  try {
    const { url: mainUrl, altUrls, key, quality } = await hgApp.videoModel(vid);
    const result = {
      vid,
      definition: quality || '',
      main_url: mainUrl,
      backup_url: altUrls[0] || '',
      encrypt: key ? { key, spade_a: '' } : null,
      duration: 0,
    };
    console.log('[play-direct] OK', result.definition, 'url len', (mainUrl || '').length);
    res.json(result);
  } catch (e) {
    console.log('[play-direct] ERR', e.message);
    res.status(502).json({ error: '直连取流失败: ' + e.message });
  }
});

// ---- WebUI 管理接口（需管理员密码登录）----

// 管理员登录：签发 8 小时会话 token
app.post('/api/admin/login', (req, res) => {
  if (!ADMIN_PASSWORD) return res.status(503).json({ error: '服务端未配置 ADMIN_PASSWORD，管理功能不可用' });
  const input = Buffer.from(String(req.body && req.body.password || ''));
  const expected = Buffer.from(ADMIN_PASSWORD);
  const ok = input.length === expected.length && crypto.timingSafeEqual(input, expected);
  if (!ok) return res.status(401).json({ error: '管理员密码错误' });
  res.json({ token: issueAdminToken() });
});

// 会话有效性检查
app.get('/api/admin/session', requireAdmin, (_req, res) => res.json({ ok: true }));

// 退出登录
app.post('/api/admin/logout', requireAdmin, (req, res) => {
  const token = extractBearer(req);
  if (token) adminSessions.delete(token);
  res.json({ ok: true });
});

// 用户列表（含明文密码、设备型号，供 WebUI 管理展示）
app.get('/api/admin/users', requireAdmin, (_req, res) => {
  const list = Object.values(users)
    .map(u => ({
      id: u.id,
      username: u.username,
      password: u.passwordPlain || '',
      device: u.device || '',
      role: ['admin', 'vip', 'user'].includes(u.role) ? u.role : 'user',
      huangguoUnlocked: Boolean(u.huangguoUnlocked),
      avatar: u.avatar || null,
      createdAt: u.createdAt || 0,
      updatedAt: u.updatedAt || u.createdAt || 0
    }))
    .sort((a, b) => a.createdAt - b.createdAt);
  res.json({ users: list });
});

// 设置用户角色（管理员/特权组/普通用户；管理员可 NAS 下载，管理员与特权组免动态码进私密模式）
app.put('/api/admin/users/:id/role', requireAdmin, (req, res) => {
  const id = String(req.params.id);
  const user = users[id];
  if (!user) return res.status(404).json({ error: '用户不存在' });
  const role = String((req.body && req.body.role) || '').trim();
  if (!['admin', 'vip', 'user'].includes(role)) return res.status(400).json({ error: '角色只能是 admin、vip 或 user' });
  user.role = role;
  user.updatedAt = Date.now();
  flush();
  res.json({ ok: true, user: publicUser(user) });
});

// 删除用户（连带其会话、片单、头像）
app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  const id = String(req.params.id);
  if (!users[id]) return res.status(404).json({ error: '用户不存在' });
  for (const [token, s] of Object.entries(sessions)) if (s.userId === id) delete sessions[token];
  delete library[id];
  try { fs.unlinkSync(path.join(AVATAR_DIR, id + '.jpg')); } catch { /* 无头像 */ }
  delete users[id];
  flush();
  res.json({ ok: true });
});

// 状态统计（状态页用，需管理员）
app.get('/api/stats', requireAdmin, (_req, res) => {
  res.json({ service: "veyra-backend", status: "ok", registerOpen });
});

// 管理台设置：开放注册开关 + 后端代理（实时生效，持久化到 settings.json，无需重启）
app.get('/api/admin/settings', requireAdmin, (_req, res) => {
  res.json({ registerOpen, backendProxy });
});
app.put('/api/admin/settings', requireAdmin, (req, res) => {
  const body = req.body || {};
  if (body.registerOpen !== undefined) {
    const value = body.registerOpen;
    registerOpen = value === true || value === 'true' || value === 1 || value === '1';
  }
  if (body.backendProxy !== undefined) {
    const proxy = String(body.backendProxy).trim();
    if (proxy !== '') {
      let parsed;
      try { parsed = new URL(proxy); } catch { return res.status(400).json({ error: '代理地址格式无效' }); }
      if (!/^(http|socks5):$/.test(parsed.protocol) || !parsed.hostname)
        return res.status(400).json({ error: '代理仅支持 http:// 或 socks5://' });
    }
    backendProxy = proxy;
  }
  saveSettings();
  res.json({ ok: true, registerOpen, backendProxy });
});
// 测试后端代理连通性：按给定代理（未给则用已保存配置）抓黄果主页
app.post('/api/admin/proxy-test', requireAdmin, (req, res) => {
  const proxy = String((req.body && req.body.proxy) || '').trim();
  const target = 'https://www.google.com/generate_204';
  const started = Date.now();
  proxyFetch.requestThroughProxy(target, proxy || backendProxy, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': '*/*' },
    timeout: 8_000, maxBytes: 64 * 1024, redirects: 3,
  }, (err, result) => {
    if (err) return res.json({ ok: false, error: err.message || '连接失败' });
    if (result.status < 200 || result.status >= 400)
      return res.json({ ok: false, error: '上游返回 HTTP ' + result.status, code: result.status });
    res.json({ ok: true, target, code: result.status, ms: Date.now() - started });
  });
});

// 当前动态码（状态页展示；30 秒轮换一次，需管理员）
app.get('/api/otp', requireAdmin, (_req, res) => {
  const otpData = ensureOtpSecret();
  res.json({
    code: totpCode(otpData, 0),
    window: OTP_WINDOW,
    expiresIn: OTP_WINDOW - (Math.floor(Date.now() / 1000) % OTP_WINDOW),
    lastReset: otpData.lastReset || null
  });
});

// 重置动态码（重新生成 secret，旧码立即全部失效，需管理员）
app.post('/api/otp/reset', requireAdmin, (_req, res) => {
  try { fs.unlinkSync(path.join(DATA_DIR, 'otp.json')); } catch { /* 不存在则直接新建 */ }
  const otpData = ensureOtpSecret();
  res.json({ ok: true, code: totpCode(otpData, 0), window: OTP_WINDOW });
});

// 验证动态码（APK 私密模式入口；需登录，验证通过后该账号永久解锁私密模式，跟账号走）
// 管理员角色免动态码：直接解锁
app.post('/api/otp/verify', (req, res) => {
  // 已登录用户（带 token）：验证通过后永久解锁私密模式（跟账号走）；管理员/特权组免码
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+([a-f0-9]{64})$/i);
  const session = match && sessions[match[1]];
  const user = session && users[session.userId];
  if (user && ['admin', 'vip'].includes(user.role)) {
    user.huangguoUnlocked = true;
    user.updatedAt = Date.now();
    flush();
    return res.json({ ok: true, unlocked: true });
  }
  if (!verifyOtp(req.body && req.body.code)) return res.status(401).json({ error: '动态码不正确或已过期' });
  if (user) {
    user.huangguoUnlocked = true;
    user.updatedAt = Date.now();
    flush();
  }
  res.json({ ok: true, unlocked: !!user });
});

// ---- 黄果转发接口：APK 直连不通时绕行（只放行黄果站点/封面/视频域名）----
// 支持后端代理（WebUI 配置 backendProxy）：抓取时按配置走代理或直连；
// m3u8 列表返回前重写分片 URL 为后端代理地址，保证手机端分片请求也走后端。
const proxyCache = new Map(); // target -> { body, type, expires }
const MAX_CACHE_ENTRIES = 200;
const CACHE_TTL = { m3u8: 30_000, html: 60_000, image: 24 * 3600_000, video: 0, other: 0 };
const MAX_BYTES = { m3u8: 10 * 1024 * 1024, html: 1024 * 1024, image: 5 * 1024 * 1024, video: 50 * 1024 * 1024, other: 5 * 1024 * 1024 };
function cacheGet(key) {
  const hit = proxyCache.get(key);
  if (hit && hit.expires > Date.now()) return hit;
  if (hit) proxyCache.delete(key);
  return null;
}
function cachePut(key, body, type, ttlMs) {
  if (ttlMs <= 0) return;
  if (proxyCache.size >= MAX_CACHE_ENTRIES) { const first = proxyCache.keys().next().value; proxyCache.delete(first); }
  proxyCache.set(key, { body, type, expires: Date.now() + ttlMs });
}
// 黄果系封面 AES-128-CBC 解密（与 APK SiteRepository/SiteProfile 同源逻辑；密钥来自 site-default.json cover 配置）
function decryptHuangguoCover(buf) {
  if (!buf || buf.length < 32) return buf;
  const isImage = (b) => b.length >= 12 && (
    (b[0] === 0xFF && b[1] === 0xD8) ||
    (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47 && b[4] === 0x0D && b[5] === 0x0A && b[6] === 0x1A && b[7] === 0x0A) ||
    (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) ||
    (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38)
  );
  if (isImage(buf)) return buf; // 已是有效图片（直连真图/已解密缓存）则幂等跳过
  let out;
  try {
    const d = crypto.createDecipheriv('aes-128-cbc',
      Buffer.from('f5d965df75336270', 'utf8'), Buffer.from('97b60374abc2fbe1', 'utf8'));
    out = Buffer.concat([d.update(buf), d.final()]);
  } catch { return buf; }
  // 头修复：签名校验后 offset 6 XOR 0x0E（APK repairCoverHeader 同款）
  if (out.length >= 12) {
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
  return isImage(out) ? out : buf;
}

function kindOf(type, body) {
  const t = String(type || '').toLowerCase();
  if (t.includes('mpegurl') || t.includes('m3u8')) return 'm3u8';
  if (body.length > 6 && body.slice(0, 7).toString('utf8') === '#EXTM3U') return 'm3u8';
  if (t.startsWith('image/')) return 'image';
  // 图片魔数兜底（源站常见 binary/octet-stream，Chrome <img> 拒绝该类型，必须识别成 image 并改写响应头）
  if (body.length >= 12) {
    const b = body.subarray(0, 12);
    if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image';               // JPEG
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'image'; // PNG
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image'; // GIF
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
        b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image'; // WEBP
  }
  if (t.startsWith('text/') || t.includes('html') || t.includes('xml') || t.includes('json')) return 'html';
  if (t.includes('mp2t') || t.includes('mp4') || t.includes('m4s') || t.includes('octet-stream')) return 'video';
  return 'other';
}
// 媒体资源放行任意公网域名（CDN 域名无法枚举）：视频分片/图片/无扩展名 hls 路径；拒绝内网地址防 SSRF
const MEDIA_PATH_RE = /\.(m3u8|ts|mp4|m4s|flv|key|jpg|jpeg|png|webp|gif|avif)(\?|#|$)|(?:hls|vod|live|media|segment|index)\//i;
function isPrivateHost(hostname) {
  if (!hostname) return true;
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan')) return true;
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(h)) {
    const [a, b] = h.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31);
  }
  return false;
}
app.get('/api/huangguo-proxy', (req, res) => {
  const target = String(req.query.url || '');
  console.log('[proxy]', new Date().toISOString(), 'REQ', (req.headers['user-agent'] || '').slice(0, 24), target.slice(0, 120));
  let parsed;
  try { parsed = new URL(target); } catch { return res.status(400).json({ error: '无效地址' }); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    return res.status(400).json({ error: '仅支持 http/https' });
  const isMedia = MEDIA_PATH_RE.test(parsed.pathname + parsed.search);
  if (isPrivateHost(parsed.hostname))
    return res.status(403).json({ error: '代理拒绝内网地址（防 SSRF）' });
  const cached = cacheGet(target);
  if (cached) {
    console.log('[proxy]', new Date().toISOString(), 'HIT', cached.type, target.slice(0, 90));
    let cbody = cached.body;
    if (cached.type.startsWith('image/')) {
      const dec = decryptHuangguoCover(cbody);
      if (dec !== cbody) cbody = dec;
    }
    res.setHeader('Content-Type', cached.type);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Proxy-Cache', 'hit');
    return res.end(cbody);
  }
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36',
    'Accept': '*/*',
  };
  headers['Referer'] = req.query.ref ? String(req.query.ref) : `${parsed.protocol}//${parsed.hostname}/`;
  // https 握手失败自动降级 http 重试（部分 CDN 如 tp1.drleao.cn 的 https 端口不稳，源站 m3u8 内引用其子 m3u8/分片）
  const attempt = (u, retriedHttp) => {
    // curl globbing 安全：源站分片文件名可能含未编码的 ()[]{}，curl 会按 glob 解析报 error 3
    u = String(u).replace(/[\[\]\(\)\{\}]/g, c => encodeURIComponent(c));
    proxyFetch.requestThroughProxy(u, backendProxy, {
      headers, timeout: 25_000, maxBytes: 50 * 1024 * 1024, redirects: 5,
    }, (err, result) => {
      if (err) {
        console.log('[proxy]', new Date().toISOString(), 'ERR', (err.message || '').slice(0, 120), u.slice(0, 90));
        if (!retriedHttp && u.startsWith('https://') && /TLS|SSL|eof|handshake|connect/i.test(err.message || '')) {
          console.log('[proxy] https 握手失败，降级 http 重试', u.slice(0, 90));
          return attempt('http://' + u.slice(8), true);
        }
        if (!res.headersSent) return res.status(502).json({ error: '上游站点连接失败: ' + (err.message || '') });
        return res.end();
      }
      if (result.status < 200 || result.status >= 300)
        return res.status(502).json({ error: '上游站点返回 ' + result.status });
      let type = String(result.headers['content-type'] || 'text/html; charset=utf-8');
      let body = result.body;
      let kind = kindOf(type, body);
      // 图片扩展名优先：黄果加密封面 body 无图片魔数（AES 密文），必须按 URL 扩展名识别为图片再解密
      const urlExt = (parsed.pathname.match(/\.(jpe?g|png|webp|gif|avif|bmp)$/i) || [])[1] || '';
      if (urlExt) kind = 'image';
      if (body.length > MAX_BYTES[kind]) {
        return res.status(502).json({ error: '响应超过大小限制（' + MAX_BYTES[kind] + ' 字节）' });
      }
      if (kind === 'image') {
        // 源站常见 binary/octet-stream，Chrome <img> 拒绝渲染：按扩展名强制改写为 image/*
        const ext = urlExt;
        const ctMap = { jpeg: 'image/jpeg', jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', bmp: 'image/bmp' };
        type = ctMap[ext.toLowerCase()] || 'image/jpeg';
        // 黄果封面为 AES-CBC 加密数据（170KB 乱码），解密后才是真图
        const dec = decryptHuangguoCover(body);
        if (dec !== body) { body = dec; type = ctMap[ext.toLowerCase()] || 'image/jpeg'; }
      }
      if (kind === 'm3u8') {
        type = 'application/vnd.apple.mpegurl; charset=utf-8';
        // 重写 m3u8：普通 URI 行 + #EXT-X-KEY/#EXT-X-MAP 的 URI="..." 全部包一层后端代理
        // 协议跟随访问方式：公网经反代 TLS 终止后本服务收到的是 HTTP（req.protocol 不可靠），
        // 故公网域名固定 https、局域网/本机保持 http；host 用请求真实 Host（反代透传）。
        // 附加 ref=<源站>：分片/CDN 防盗链校验 Referer 需为播放页域名（此前传 CDN 自身域名会 403）
        const proxyHost = String(req.headers.host || '');
        const proxyHostOnly = proxyHost.split(':')[0].toLowerCase();
        const privateHostRe = /^(localhost|127\.0\.0\.1|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
        const base = `${privateHostRe.test(proxyHostOnly) ? 'http' : 'https'}://${proxyHost}/api/huangguo-proxy?url=`;
        const ref = req.query.ref ? '&ref=' + encodeURIComponent(String(req.query.ref)) : '';
        // 解包源站自带代理层：video.225600.xyz:1314/api/huangguo-proxy?url=<真实分片>
        // 该网关对后端拒绝（502/握手失败），但其 url 参数即真实 CDN 地址（tpX.drleao.cn，后端已验证可直抓）
        const unwrapHgProxy = (uri) => {
          try {
            const u = new URL(uri);
            if (u.hostname.includes('video.225600.xyz') && /\/api\/huangguo-proxy$/.test(u.pathname)) {
              const inner = u.searchParams.get('url');
              if (inner) return new URL(inner).toString();
            }
          } catch { /* 保留原样 */ }
          return uri;
        };
        let text = body.toString('utf8');
        text = text.replace(/(URI=")([^"]+)(")/g, (_m, a, uri, c) => {
          try { return a + base + encodeURIComponent(new URL(unwrapHgProxy(uri), u).toString()) + ref + c; }
          catch { return _m; }
        });
        text = text.replace(/^(?!#)(.+)$/gm, (line) => {
          const uri = line.trim();
          if (!uri) return line;
          try { return base + encodeURIComponent(new URL(unwrapHgProxy(uri), u).toString()) + ref; }
          catch { return line; }
        });
        body = Buffer.from(text, 'utf8');
      }
    if (kind === 'm3u8' || kind === 'html' || kind === 'image') cachePut(u, body, type, CACHE_TTL[kind]);
    console.log('[proxy]', new Date().toISOString(), 'RES', kind, 'bytes=' + body.length, u.slice(0, 90));
    res.status(200);
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Proxy-Cache', 'miss');
    res.end(body);
    });
  };
  attempt(target, false);
});

// 代理诊断：管理员可查看任意 URL 的代理判定与结果（排查封面/分片 403）
app.get('/api/debug/proxy', requireAdmin, (req, res) => {
  const target = String(req.query.url || '');
  let parsed;
  try { parsed = new URL(target); } catch { return res.json({ ok: false, error: '无效地址', target }); }
  const isMedia = MEDIA_PATH_RE.test(parsed.pathname + parsed.search);
  const verdict = isPrivateHost(parsed.hostname) ? '拒绝:内网地址' : '放行:公网资源';
  const attempted = [];
  const attemptDbg = (u, retriedHttp) => {
    attempted.push(u.slice(0, 200));
    proxyFetch.requestThroughProxy(u, backendProxy, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 13) Mobile', 'Referer': `${parsed.protocol}//${parsed.hostname}/` },
      timeout: 20_000, maxBytes: 20 * 1024 * 1024, redirects: 5,
    }, (err, result) => {
      if (err) {
        if (!retriedHttp && u.startsWith('https://') && /TLS|SSL|eof|handshake|connect/i.test(err.message || '')) {
          console.log('[debug] https 握手失败，降级 http 重试', u.slice(0, 90));
          return attemptDbg('http://' + u.slice(8), true);
        }
        return res.json({ ok: false, verdict, error: String(err.message || err), target: u.slice(0, 200), attempted });
      }
      return res.json({
        ok: result.status >= 200 && result.status < 300,
        verdict, status: result.status,
        contentType: String(result.headers['content-type'] || ''),
        bytes: result.body.length,
        target: u.slice(0, 200),
        attempted,
        cors: (() => {
          const h = result.headers || {};
          const acao = h['access-control-allow-origin'];
          const acah = h['access-control-allow-headers'];
          const acam = h['access-control-allow-methods'];
          return { 'access-control-allow-origin': acao || null, 'access-control-allow-headers': acah || null, 'access-control-allow-methods': acam || null };
        })(),
      });
    });
  };
  attemptDbg(target, false);
});

// 站点 HTML 特征诊断：拉页面原文，提取 img/background/poster 标签样例（定位封面解析）
app.get('/api/debug/site', requireAdmin, (req, res) => {
  const target = String(req.query.url || '');
  let parsed;
  try { parsed = new URL(target); } catch { return res.json({ ok: false, error: '无效地址', target }); }
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36',
    'Referer': `${parsed.protocol}//${parsed.hostname}/`, 'Accept': '*/*',
  };
  proxyFetch.requestThroughProxy(target, backendProxy, { headers, timeout: 20_000, maxBytes: 20 * 1024 * 1024, redirects: 5 }, (err, result) => {
    if (err) return res.json({ ok: false, error: String(err.message || err), target });
    if (result.status < 200 || result.status >= 300)
      return res.json({ ok: false, status: result.status, error: '上游返回 ' + result.status, target });
    const text = result.body.toString('utf8');
    const out = { ok: true, url: target, status: result.status, bytes: text.length };
    out.imgs = [];
    let m, re = /<img[^>]*>/gi, n = 0;
    while ((m = re.exec(text)) !== null && out.imgs.length < 15) out.imgs.push(m[0].slice(0, 160));
    out.backgrounds = [];
    re = /<(?:div|a|li|span|section)[^>]+style=["'][^"']*(?:background|background-image)[^"']*["'][^>]*>/gi;
    while ((m = re.exec(text)) !== null && out.backgrounds.length < 10) out.backgrounds.push(m[0].slice(0, 160));
    out.posters = [];
    re = /<video[^>]+poster=["'][^"']+["']/gi;
    while ((m = re.exec(text)) !== null && out.posters.length < 5) out.posters.push(m[0].slice(0, 160));
    out.attrUrls = [];
    re = /(?:data-src|data-original|data-lazy|src|data-cover|data-img)="([^"]+)"|url\(\s*['"]?([^'")\s]+)['"]?\s*\)/gi;
    while ((m = re.exec(text)) !== null && out.attrUrls.length < 20) out.attrUrls.push((m[1] || m[2] || '').slice(0, 160));
    // 解密脚本探测：页面内嵌 script 中含封面域名/解密关键词的片段 + 外部 JS 列表
    out.decryptHints = [];
    re = /<script[^>]*>([\s\S]{0,600}?)(?:pic\.drleao\.cn|upload_01|decrypt|decode|xor|aes|createObjectURL|atob\(|backgroundImage|background-image|\.jpe?g\?auth_key)([\s\S]{0,300}?)<\/script>/gi;
    while ((m = re.exec(text)) !== null && out.decryptHints.length < 6)
      out.decryptHints.push((m[1] + '‖' + m[2]).replace(/\s+/g, ' ').slice(0, 420));
    out.scriptSrcs = [];
    re = /<script[^>]+src=["']([^"']+)["'][^>]*>/gi;
    while ((m = re.exec(text)) !== null && out.scriptSrcs.length < 12) out.scriptSrcs.push(m[1].slice(0, 160));
    // 条目 HTML 特征：优先抓卡片（hg-drama-card class），无则抓非搜索建议的 /video/ 链接
    out.entries = [];
    re = /<a[^>]*class=["'][^"']*hg-drama-card[^"']*["'][^>]*>[\s\S]{0,700}?<\/a>/gi;
    while ((m = re.exec(text)) !== null && out.entries.length < 3) out.entries.push(m[0].replace(/\s+/g, ' ').slice(0, 340));
    if (!out.entries.length) {
      re = /<a[^>]*href=["'][^"']*\/video\/\d+[^"']*["'][^>]*>[\s\S]{0,500}?<\/a>/gi;
      while ((m = re.exec(text)) !== null && out.entries.length < 3) {
        if (m[0].includes('hg-search-suggest') || m[0].includes('nav') || m[0].includes('menu')) continue;
        out.entries.push(m[0].replace(/\s+/g, ' ').slice(0, 340));
      }
    }
    res.json(out);
  });
});

// 健康检查
// ---- 下载任务（NAS 整剧下载+合并，需登录；管理员会话可见/可删全部）----
function isAdminRequest(req) {
  const match = String(req.headers.authorization || '').match(/^Bearer\s+([a-f0-9]{64})$/i);
  return !!match && (adminSessions[match[1]] || 0) > Date.now();
}
// NAS 下载任务：管理员鉴权（WebUI 使用管理员 token，勿用用户注册会话 auth）
const ADMIN_OWNER = 'admin';
app.post('/api/download/tasks', requireAdminOrAccountAdmin, (req, res) => {
  try {
    const task = downloader.createTask({
      source: req.body.source, title: req.body.title, seriesId: req.body.seriesId,
      episodes: req.body.episodes, owner: ADMIN_OWNER, cover: req.body.cover,
    });
    res.json({ task });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/download/tasks', requireAdminOrAccountAdmin, (_req, res) => {
  res.json({ tasks: downloader.listTasks(ADMIN_OWNER, true) });
});
app.get('/api/download/tasks/:id', requireAdminOrAccountAdmin, (req, res) => {
  const task = downloader.getTask(req.params.id, ADMIN_OWNER, true);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  res.json({ task });
});
app.delete('/api/download/tasks/:id', requireAdminOrAccountAdmin, (req, res) => {
  if (!downloader.deleteTask(req.params.id, ADMIN_OWNER, true))
    return res.status(404).json({ error: '任务不存在' });
  res.json({ ok: true });
});
// 任务分集文件信息（供手机拉取：转发模式 = NAS 下载完 → 手机拉 mp4 → 删 NAS 原文件）
app.get('/api/download/tasks/:id/episodes', requireAdminOrAccountAdmin, (req, res) => {
  try {
    const t = downloader.getRawTask(req.params.id, ADMIN_OWNER, true);
    if (!t) return res.status(404).json({ error: '任务不存在' });
    const dir = downloader.taskDirOf(t);
    const fs2 = require('fs');
    const eps = [];
    for (let i = 0; i < t.episodes.length; i++) {
      const f = downloader.safeJoin(dir, downloader.epName(i + 1));
      let size = 0, exists = false;
      try { exists = fs2.existsSync(f); if (exists) size = fs2.statSync(f).size; } catch { /* ignore */ }
      eps.push({ index: i + 1, name: downloader.epName(i + 1), exists, size });
    }
    res.json({ taskId: t.id, title: t.title, episodes: eps });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
// 单集文件流式下载（鉴权 + 路径安全校验）
app.get('/api/download/files/:id/:index', requireAdminOrAccountAdmin, (req, res) => {
  try {
    const t = downloader.getRawTask(req.params.id, ADMIN_OWNER, true);
    if (!t) return res.status(404).json({ error: '任务不存在' });
    const idx = parseInt(req.params.index, 10);
    if (idx === 0) {
      // index=0：拉取 NAS 合并产物（<title>_全N集.mp4，任务目录内唯一非分集 mp4）
      const dir = downloader.taskDirOf(t);
      const merged = require('fs').readdirSync(dir).find(k => k.endsWith('.mp4') && !/^第\d+集\.mp4$/.test(k));
      if (!merged) return res.status(404).json({ error: '合并产物不存在' });
      return res.sendFile(downloader.safeJoin(dir, merged));
    }
    if (!(idx >= 1 && idx <= t.episodes.length)) return res.status(400).json({ error: '集数非法' });
    const f = downloader.safeJoin(downloader.taskDirOf(t), downloader.epName(idx));
    if (!require('fs').existsSync(f)) return res.status(404).json({ error: `第 ${idx} 集文件不存在` });
    res.sendFile(f);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/download/merge', requireAdminOrAccountAdmin, (req, res) => {
  try {
    const task = downloader.mergeTask(String(req.body.id || ''), ADMIN_OWNER, true);
    if (!task) return res.status(404).json({ error: '任务不存在' });
    res.json(task);
  } catch (e) { res.status(400).json({ error: e && e.message ? e.message : '合并失败' }); }
});
app.post('/api/download/retry-failed', requireAdminOrAccountAdmin, (req, res) => {
  try {
    const task = downloader.retryFailedEpisodes(String(req.body.id || ''), ADMIN_OWNER, true);
    if (!task) return res.status(404).json({ error: '任务不存在' });
    res.json(task);
  } catch (e) { res.status(400).json({ error: e && e.message ? e.message : '重试失败' }); }
});

app.get('/api/health', (_req, res) => {
  res.json({ code: 200, service: 'veyra-backend', status: 'ok', time: Date.now(), download: downloader.status() });
});

// 注册（密码不限长度：1 位即可；开关在 WebUI 管理台实时控制，持久化到 settings.json）
app.post('/api/register', (req, res) => {
  if (regTooFrequent(req)) return res.status(429).json({ error: '注册过于频繁，请稍后再试' });
  // 注册必须携带动态码（管理员动态码），旧版 APK 直连注册也会被拦
  const code = String(req.body.code || '').trim();
  if (!verifyOtp(code)) return res.status(401).json({ error: '动态码不正确或已过期，注册需要管理员动态码' });
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  if (!USERNAME_RE.test(username))
    return res.status(400).json({ error: '账号需为 3–24 位字母、数字或下划线' });
  if (password.length < 1) return res.status(400).json({ error: '密码不能为空' });
  if (!registerOpen) return res.status(403).json({ error: '注册已关闭，请联系管理员' });
  if (Object.values(users).some(u => u.username === username))
    return res.status(409).json({ error: '该账号已被注册' });
  const user = newUserRecord(username, password, String(req.body.device || ''));
  users[user.id] = user;
  flush();
  res.status(201).json({ token: issueToken(user.id), user: publicUser(user) });
});

// 登录（空密码直接拒绝；记录最新设备型号）
app.post('/api/login', (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  if (password.length < 1) return res.status(401).json({ error: '账号不存在或密码错误，请检查后重试' });
  const user = Object.values(users).find(u => u.username === username);
  const ok = user && crypto.timingSafeEqual(
    Buffer.from(user.password, 'hex'), Buffer.from(hashPassword(password, user.salt), 'hex'));
  if (!ok) return res.status(401).json({ error: '账号不存在或密码错误，请检查后重试' });
  const device = String(req.body.device || '').trim();
  if (device && device !== user.device) { user.device = device; user.updatedAt = Date.now(); }
  flush();
  res.json({ token: issueToken(user.id), user: publicUser(user) });
});

// 会话恢复（APK 冷启动用 token 换用户信息）
app.get('/api/me', auth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

// 注销
app.post('/api/logout', auth, (req, res) => {
  delete sessions[req.token];
  flush();
  res.status(204).end();
});

// 修改密码（验旧密码，签发新 token；新密码 1 位即可）
app.post('/api/change-password', auth, (req, res) => {
  const oldPassword = String(req.body.oldPassword || '');
  const newPassword = String(req.body.newPassword || '');
  const oldOk = crypto.timingSafeEqual(
    Buffer.from(req.user.password, 'hex'), Buffer.from(hashPassword(oldPassword, req.user.salt), 'hex'));
  if (!oldOk) return res.status(400).json({ error: '旧密码不正确' });
  if (newPassword.length < 1) return res.status(400).json({ error: '新密码不能为空' });
  if (newPassword === oldPassword) return res.status(400).json({ error: '新密码不能与旧密码相同' });
  const user = req.user;
  user.salt = crypto.randomBytes(16).toString('hex');
  user.password = hashPassword(newPassword, user.salt);
  user.passwordPlain = newPassword;
  user.updatedAt = Date.now();
  flush();
  res.json({ token: issueToken(user.id), user: publicUser(user) });
});

// 上传头像（base64 JPEG）
app.post('/api/avatar', auth, (req, res) => {
  if (!needUser(req, res)) return;
  let bytes;
  try {
    bytes = Buffer.from(String(req.body.data || ''), 'base64');
  } catch { return res.status(400).json({ error: '头像数据无效' }); }
  if (bytes.length === 0 || bytes.length > MAX_AVATAR_BYTES)
    return res.status(400).json({ error: '头像需为 256×256 JPEG（≤512KB）' });
  if (bytes.length < 3 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff)
    return res.status(400).json({ error: '头像必须是 JPEG 图片' });
  const avatarFile = path.join(AVATAR_DIR, req.user.id + '.jpg');
  fs.writeFileSync(avatarFile, bytes);
  req.user.avatar = `/api/avatar/${req.user.id}.jpg?v=${Date.now()}`;
  flush();
  res.json({ user: publicUser(req.user) });
});

// 头像文件
app.get('/api/avatar/:name', (req, res) => {
  const name = path.basename(req.params.name);
  if (!/^[a-f0-9]{24}\.jpg$/.test(name)) return res.status(404).end();
  const avatarFile = path.join(AVATAR_DIR, name);
  if (!fs.existsSync(avatarFile)) return res.status(404).end();
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.sendFile(avatarFile);
});

// 片单同步：GET 拉远端快照（合并逻辑在 APK 客户端）
app.get('/api/library', auth, (req, res) => {
  if (!needUser(req, res)) return;
  const source = String(req.query.source || '');
  if (!['hongguo', 'huangguo'].includes(source)) return res.status(400).json({ error: '无效内容来源' });
  const record = (library[req.user.id] || {})[source];
  res.json({ payload: record ? record.payload : {} });
});

// 片单同步：PUT 保存合并后快照（LWW 在客户端完成，这里只做存储）
app.put('/api/library', auth, (req, res) => {
  if (!needUser(req, res)) return;
  const source = String(req.body.source || '');
  const payload = req.body.payload;
  if (!['hongguo', 'huangguo'].includes(source)) return res.status(400).json({ error: '无效内容来源' });
  if (payload === undefined || payload === null || typeof payload !== 'object')
    return res.status(400).json({ error: '片单数据无效' });
  const raw = JSON.stringify(payload);
  if (raw.length > MAX_PAYLOAD_BYTES) return res.status(400).json({ error: '片单数据过大' });
  const row = (library[req.user.id] || (library[req.user.id] = {}));
  row[source] = { updatedAt: Date.now(), payload };
  flush();
  res.json({ synced: true, updatedAt: row[source].updatedAt });
});

// 清理过期会话（启动时执行一次）
(function pruneSessions() {
  const now = Date.now();
  let changed = false;
  for (const [token, s] of Object.entries(sessions))
    if (now - s.lastSeen > TOKEN_TTL_MS) { delete sessions[token]; changed = true; }
  if (changed) flush();
})();

// 最新 APK 下载：WebUI 一键获取（手机弱网/国内访问 GitHub 不稳定时，经 NAS 后端中转拉取再转发）
app.get('/api/update/apk', (req, res) => {
  const fetchLatest = () => new Promise((resolve, reject) => {
    proxyFetch.requestThroughProxy('https://api.github.com/repos/gybeyond1/Veyra/releases/latest', backendProxy, {
      headers: { 'User-Agent': 'Veyra-Backend', 'Accept': 'application/vnd.github+json' },
      timeout: 20_000, maxBytes: 1024 * 1024, redirects: 3,
    }, (err, result) => {
      if (err) return reject(new Error('查询最新版本失败: ' + (err.message || '')));
      if (!result || result.status < 200 || result.status >= 300) return reject(new Error('查询最新版本失败（HTTP ' + (result && result.status) + '）'));
      try {
        const release = JSON.parse(result.body.toString('utf8'));
        const apk = (release.assets || []).find(a => String(a.name || '').endsWith('.apk'));
        if (!apk) return reject(new Error('发布中没有 APK 资产'));
        resolve({ tag: release.tag_name, url: apk.browser_download_url, name: apk.name, size: apk.size });
      } catch (e) { reject(new Error('查询最新版本响应异常')); }
    });
  });
  const streamApk = (url, name, size, tag) => {
    proxyFetch.requestThroughProxy(url, backendProxy, {
      headers: { 'User-Agent': 'Veyra-Backend', 'Accept': '*/*' },
      timeout: 60_000, maxBytes: 60 * 1024 * 1024, redirects: 5,
    }, (err, result) => {
      if (err || !result || result.status < 200 || result.status >= 300) {
        if (!res.headersSent) return res.status(502).json({ error: '下载 APK 失败: ' + ((err && err.message) || 'HTTP ' + (result && result.status)) });
        return res.end();
      }
      res.setHeader('Content-Type', 'application/vnd.android.package-archive');
      res.setHeader('Content-Length', String(result.body.length));
      res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
      res.setHeader('X-Apk-Version', tag);
      res.end(result.body);
    });
  };
  fetchLatest().then(info => streamApk(info.url, info.name, info.size, info.tag), err => {
    if (!res.headersSent) return res.status(502).json({ error: err.message });
    res.end();
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`veyra-backend listening on 0.0.0.0:${PORT}, data dir: ${DATA_DIR}`);
});
