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
const http = require('http');
const https = require('https');
const downloader = require('./downloader');

const PORT = parseInt(process.env.PORT || '8080', 10);
const DATA_DIR = process.env.DATA_DIR || '/data';
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
const ADMIN_SESSION_TTL_MS = 8 * 3600 * 1000; // 管理员会话 8 小时
const adminSessions = new Map(); // adminToken -> expiry ms

// 黄果站点域名白名单（后端转发接口只允许抓这些域名，避免变成开放代理）
// 主站为 *.pqhybuxo.cc 系；封面 CDN pic.drleao.cn / 详情图 expose.eisees.com；视频播放 yd-hls.hzjvlo.cn
const HUANGGUO_HOST_RE = /(^|\.)(pqhybuxo\.cc|im41z53s\.cc|huangguoju\.com|drleao\.cn|eisees\.com|hzjvlo\.cn)$/i;
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
  return { id: user.id, username: user.username, avatar: user.avatar, createdAt: user.createdAt,
           role: user.role === 'admin' ? 'admin' : 'user',
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
  res.send(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Veyra 后端 · 管理台</title>
<style>
:root{--bg:#0f1115;--card:#1a1e26;--line:#2a3040;--fg:#e8ecf3;--mut:#8a93a5;--ok:#37d67a;--err:#ff5c5c;--acc:#f5d782}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--fg);font:14px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;padding:24px;min-height:100vh}
.wrap{max-width:820px;margin:0 auto}
h1{font-size:20px;letter-spacing:.5px}
h2{font-size:15px;margin:18px 0 10px;color:var(--acc)}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin-bottom:14px}
.row{display:flex;flex-wrap:wrap;gap:8px 24px;align-items:center}
.k{color:var(--mut);font-size:12px}
.v{font-weight:600}
.ok{color:var(--ok)} .err{color:var(--err)}
.mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px}
input{background:#0d0f13;border:1px solid var(--line);color:var(--fg);border-radius:8px;padding:8px 10px;font-size:14px;width:100%}
button{background:var(--acc);color:#1a1e26;border:none;border-radius:8px;padding:9px 16px;font-size:14px;font-weight:700;cursor:pointer}
button:active{opacity:.8}
button.ghost{background:transparent;color:var(--mut);border:1px solid var(--line)}
button.danger{background:var(--err);color:#fff}
.role-admin{color:#0a6;font-weight:700}.role-user{color:var(--mut)}
.g2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
@media(max-width:520px){.g2{grid-template-columns:1fr}}
pre{white-space:pre-wrap;word-break:break-all;background:#0d0f13;border:1px solid var(--line);border-radius:8px;padding:10px;font-size:12px;margin-top:10px;max-height:240px;overflow:auto}
table{width:100%;border-collapse:collapse;font-size:12px}
td,th{border:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
th{color:var(--mut);font-weight:600}
a{color:var(--acc)}
.scroll-x{overflow-x:auto}
</style>
</head>
<body>
<div class="wrap">
<h1>Veyra 后端 · 管理台</h1>
<div id="login-card" class="card" hidden>
<h2>管理员登录</h2>
<p style="color:var(--mut);font-size:12px;margin:0 0 12px">WebUI 需管理员密码进入（服务端环境变量 ADMIN_PASSWORD）。</p>
<input id="admin-pass" type="password" placeholder="管理员密码" autocomplete="current-password">
<p id="login-error" class="err" style="font-size:12px;margin:8px 0 0" hidden></p>
<div class="row" style="margin-top:12px"><button onclick="login()">登录</button></div>
</div>
<div id="admin-area" hidden>
<div class="card">
<div class="row">
<span class="k">服务</span><span class="v mono" id="s-service">-</span>
<span class="k">状态</span><span class="v ok mono" id="s-status">-</span>
<span class="k">用户数</span><span class="v mono" id="s-users">-</span>
<span class="k">注册开关</span><span class="v mono" id="s-register">-</span>
<span class="k">时间</span><span class="v mono" id="s-time">-</span>
<button class="ghost" onclick="logout()">退出登录</button>
</div>
</div>
<h2>系统设置</h2>
<div class="card">
<div class="row" style="gap:12px;flex-wrap:wrap">
<label style="cursor:pointer;display:flex;align-items:center;gap:8px"><input type="checkbox" id="reg-open" style="width:18px;height:18px">开放注册（App 端可注册新账号）</label>
<button onclick="saveRegisterOpen()">保存</button>
<span id="reg-saved" style="font-size:12px"></span>
</div>
<p style="color:var(--mut);font-size:12px;margin-top:8px">开关实时生效并持久化，无需重启容器。</p>
</div>
<h2>后端代理（黄果转发用）</h2>
<div class="card">
<div class="row" style="gap:12px;flex-wrap:wrap">
<input id="backend-proxy" style="flex:1;min-width:240px" placeholder="代理地址，如 http://192.168.1.2:7890 或 socks5://192.168.1.2:1080；留空 = 后端直连">
<button onclick="saveProxy()">保存</button>
<button class="ghost" onclick="testProxy()">测试连通</button>
</div>
<p id="proxy-status" style="font-size:12px;margin-top:8px"></p>
<p style="color:var(--mut);font-size:12px;margin-top:6px">后端服务器（NAS）出口访问黄果源被限时，在此配置代理；保存后 /api/huangguo-proxy 转发自动走该代理。只影响黄果转发，不影响下载与红果。</p>
</div>
<h2>私密模式动态码（OTP）</h2>
<div class="card">
<div class="row">
<span class="k">当前动态码</span><span class="v mono" style="font-size:26px;letter-spacing:4px" id="otp-code">------</span>
<span class="k">剩余</span><span class="v mono" id="otp-remain">-</span>秒
<button onclick="resetOtp()">重置动态码</button>
</div>
<p style="color:var(--mut);font-size:12px;margin-top:8px">APK 私密模式输入这 6 位数字；每 30 秒自动更换。重置后旧码立即失效。</p>
</div>
<h2>在线测试（注册 / 登录）</h2>
<div class="card">
<div class="g2">
<div><input id="u" placeholder="账号（3–24 位字母数字下划线）" autocomplete="off"></div>
<div><input id="p" type="password" placeholder="密码（1 位起，不限长度）" autocomplete="new-password"></div>
</div>
<div class="row" style="margin-top:10px">
<button onclick="apiTest('register')">注册</button>
<button onclick="apiTest('login')">登录</button>
<button onclick="loadAll()">刷新</button>
</div>
<pre id="out">等待操作…</pre>
</div>
<h2>用户管理</h2>
<div class="card">
<p style="color:var(--mut);font-size:12px;margin:0 0 10px">注册信息以明文展示（用户名 / 密码 / 设备型号）。<strong>管理员</strong>可下载到 NAS、免动态码进私密模式；<strong>普通用户</strong>只能下载到手机。</p>
<div class="scroll-x"><table>
<thead><tr><th>用户名</th><th>明文密码</th><th>设备型号</th><th>角色</th><th>注册时间</th><th>操作</th></tr></thead>
<tbody id="user-rows"><tr><td colspan="6" style="color:var(--mut)">加载中…</td></tr></tbody>
</table></div>
</div>
</div>
<h2>接口一览</h2>
<div class="card"><table>
<tr><th>接口</th><th>说明</th></tr>
<tr><td class="mono">GET /api/health</td><td>健康检查（公开）</td></tr>
<tr><td class="mono">POST /api/register</td><td>注册，返回 token + 用户（开关受 REGISTER_OPEN 控制）</td></tr>
<tr><td class="mono">POST /api/login</td><td>登录，返回 token + 用户</td></tr>
<tr><td class="mono">POST /api/otp/verify</td><td>验证私密模式动态码（APK 用，公开）</td></tr>
<tr><td class="mono">GET /api/huangguo-proxy</td><td>黄果转发（APK 用，公开，域名白名单）</td></tr>
<tr><td class="mono">POST /api/admin/login</td><td>管理员登录（ADMIN_PASSWORD）</td></tr>
<tr><td class="mono">GET /api/admin/users</td><td>用户列表（明文，需管理员）</td></tr>
<tr><td class="mono">DELETE /api/admin/users/:id</td><td>删除用户（需管理员）</td></tr>
<tr><td class="mono">GET /api/otp</td><td>当前动态码（需管理员）</td></tr>
</table></div>
<div class="card" style="color:var(--mut);font-size:12px">
<p>数据目录：<span class="mono" id="s-datadir">-</span>（Docker 卷 <span class="mono">./veyra-data:/data</span>，备份拷该目录）</p>
<p style="margin-top:6px">部署文档见 <a href="https://github.com/gybeyond1/HuangguoAPP-for-Andriod/tree/master/server">仓库 server/</a></p>
</div>
</div>
<script>
const out=document.getElementById('out');
let adminToken=localStorage.getItem('veyraAdmin')||'';
const AUTH=()=>({Authorization:'Bearer '+adminToken});
async function init(){
  if(!adminToken){ showLogin(); return; }
  try{
    const r=await fetch('/api/admin/session',{headers:AUTH()});
    if(!r.ok) throw new Error();
    showAdmin();
  }catch(e){ adminToken=''; localStorage.removeItem('veyraAdmin'); showLogin(); }
}
function showLogin(){ document.getElementById('login-card').hidden=false; document.getElementById('admin-area').hidden=true; }
function showAdmin(){ document.getElementById('login-card').hidden=true; document.getElementById('admin-area').hidden=false; loadAll(); }
async function login(){
  const p=document.getElementById('admin-pass').value;
  const el=document.getElementById('login-error'); el.hidden=true;
  try{
    const r=await fetch('/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:p})});
    const d=await r.json().catch(()=>({}));
    if(!r.ok){ el.textContent=d.error||'登录失败'; el.hidden=false; return; }
    adminToken=d.token; localStorage.setItem('veyraAdmin',adminToken); document.getElementById('admin-pass').value=''; showAdmin();
  }catch(e){ el.textContent='网络错误'; el.hidden=false; }
}
async function saveRegisterOpen(){
  const v=document.getElementById('reg-open').checked;
  try{
    const r=await fetch('/api/admin/settings',{method:'PUT',headers:AUTH(),body:JSON.stringify({registerOpen:v})}).then(x=>x.json());
    const el=document.getElementById('reg-saved');
    el.textContent=r.ok?('已保存：'+(r.registerOpen?'开放':'关闭')):(r.error||'保存失败');
    el.style.color=r.ok?'var(--ok)':'var(--bad,#d33)';
    setTimeout(()=>el.textContent='',2500);
    loadAll();
  }catch(e){ document.getElementById('reg-saved').textContent='网络错误'; }
}
async function logout(){ try{ await fetch('/api/admin/logout',{method:'POST',headers:AUTH()}); }catch(e){} adminToken=''; localStorage.removeItem('veyraAdmin'); showLogin(); }
async function saveProxy(){
  const v=document.getElementById('backend-proxy').value.trim();
  try{
    const r=await fetch('/api/admin/settings',{method:'PUT',headers:Object.assign({'Content-Type':'application/json'},AUTH()),body:JSON.stringify({backendProxy:v})}).then(x=>x.json());
    const el=document.getElementById('proxy-status');
    el.textContent=r.ok?('已保存：'+(r.backendProxy||'后端直连（无代理）')):(r.error||'保存失败');
    el.style.color=r.ok?'var(--ok)':'var(--err)';
  }catch(e){ document.getElementById('proxy-status').textContent='网络错误'; }
}
async function testProxy(){
  const el=document.getElementById('proxy-status');
  const proxy=document.getElementById('backend-proxy').value.trim();
  el.textContent='测试中…'; el.style.color='var(--mut)';
  try{
    const r=await fetch('/api/admin/proxy-test',{method:'POST',headers:Object.assign({'Content-Type':'application/json'},AUTH()),body:JSON.stringify({proxy})}).then(x=>x.json());
    if(r.ok) el.textContent='✅ 通：'+r.target+' → HTTP '+r.code+'（'+r.ms+'ms'+(proxy?'，经代理':'，直连')+'）';
    else el.textContent='❌ 失败：'+(r.error||'未知错误');
    el.style.color=r.ok?'var(--ok)':'var(--err)';
  }catch(e){ el.textContent='❌ 请求失败：'+e.message; el.style.color='var(--err)'; }
}
let otpTimer=null;
async function loadAll(){
  try{
    const [st,otp] = await Promise.all([
      fetch('/api/stats',{headers:AUTH()}).then(r=>r.json()),
      fetch('/api/otp',{headers:AUTH()}).then(r=>r.json())
    ]);
    document.getElementById('s-service').textContent=st.service;
    document.getElementById('s-status').textContent=st.status==='ok'?'正常':'异常';
    document.getElementById('s-users').textContent=st.users;
    document.getElementById('s-register').textContent=st.registerOpen?'开放':'已关闭';
    document.getElementById('reg-open').checked=Boolean(st.registerOpen);
    document.getElementById('s-time').textContent=new Date(st.time||Date.now()).toLocaleString();
    document.getElementById('s-datadir').textContent=st.dataDir;
    document.getElementById('otp-code').textContent=otp.code;
    document.getElementById('otp-remain').textContent=otp.expiresIn;
    fetch('/api/admin/settings',{headers:AUTH()}).then(r=>r.json()).then(s=>{
      const input=document.getElementById('backend-proxy');
      if(input && !document.activeElement || (input && document.activeElement!==input)) input.value=s.backendProxy||'';
    }).catch(()=>{});
    out.textContent='已加载';
  }catch(e){ out.textContent='加载失败（登录可能已过期）'; }
  loadUsers();
}
function tickOtp(){
  const el=document.getElementById('otp-remain');
  let s=parseInt(el.textContent,10);
  if(!isNaN(s)){ el.textContent=s>0?s-1:0; if(s<=1) refreshOtp(); }
}
async function refreshOtp(){
  try{ const d=await fetch('/api/otp',{headers:AUTH()}).then(r=>r.json()); document.getElementById('otp-code').textContent=d.code; document.getElementById('otp-remain').textContent=d.expiresIn; }catch(e){}
}
if(otpTimer) clearInterval(otpTimer); otpTimer=setInterval(tickOtp,1000);
async function resetOtp(){
  if(!confirm('确定重置动态码？当前码立即失效')) return;
  try{
    const d=await fetch('/api/otp/reset',{method:'POST',headers:AUTH()}).then(r=>r.json());
    document.getElementById('otp-code').textContent=d.code;
    document.getElementById('otp-remain').textContent=d.window;
    out.textContent='动态码已重置';
  }catch(e){ out.textContent='重置失败: '+e.message }
}
async function loadUsers(){
  const rows=document.getElementById('user-rows');
  try{
    const r=await fetch('/api/admin/users',{headers:AUTH()});
    if(!r.ok) throw new Error('unauthorized');
    const d=await r.json();
    if(!d.users || !d.users.length){ rows.innerHTML='<tr><td colspan="6" style="color:var(--mut)">暂无用户</td></tr>'; return; }
    rows.innerHTML=d.users.map(u=>{
      const safe=(s)=>{ const div=document.createElement('div'); div.textContent=s; return div.innerHTML; };
      const time=u.createdAt?new Date(u.createdAt).toLocaleString():'-';
      const isAdmin=u.role==='admin';
      const roleBtn=isAdmin
        ?'<button class="danger" data-role-id="'+u.id+'" data-role-name="'+safe(u.username)+'" data-role-to="user">设为普通用户</button>'
        :'<button data-role-id="'+u.id+'" data-role-name="'+safe(u.username)+'" data-role-to="admin">设为管理员</button>';
      return '<tr><td class="mono">'+safe(u.username)+'</td><td class="mono">'+safe(u.password)+'</td><td>'+safe(u.device)+'</td><td><span class="mono '+(isAdmin?'role-admin':'role-user')+'">'+(isAdmin?'管理员':'普通用户')+'</span></td><td>'+time+'</td><td style="white-space:nowrap">'+roleBtn+' <button class="danger" data-del-id="'+u.id+'" data-del-name="'+safe(u.username)+'">删除</button></td></tr>';
    }).join('');
  }catch(e){ rows.innerHTML='<tr><td colspan="6" style="color:var(--mut)">加载失败（登录可能已过期）</td></tr>'; }
}
async function deleteUser(id,username){
  if(!confirm('确定删除用户「'+username+'」？其会话/片单/头像将一并删除，不可恢复')) return;
  try{
    const r=await fetch('/api/admin/users/'+id,{method:'DELETE',headers:AUTH()});
    out.textContent=r.ok?('已删除用户 '+username):'删除失败';
    loadUsers();
  }catch(e){ out.textContent='删除失败: '+e.message }
}
async function setUserRole(id,username,role){
  try{
    const r=await fetch('/api/admin/users/'+id+'/role',{method:'PUT',headers:Object.assign({'Content-Type':'application/json'},AUTH()),body:JSON.stringify({role})});
    const d=await r.json().catch(()=>({}));
    out.textContent=r.ok?('已将「'+username+'」设为'+(role==='admin'?'管理员':'普通用户')):(d.error||'设置失败');
    loadUsers();
  }catch(e){ out.textContent='设置失败: '+e.message }
}
// 用户管理“删除/角色”按钮事件委托（避免内嵌 onclick 的引号转义问题）
document.addEventListener('click', function(ev){
  const b=ev.target.closest('[data-del-id]');
  if(b){ deleteUser(b.getAttribute('data-del-id'), b.getAttribute('data-del-name')); return; }
  const rb=ev.target.closest('[data-role-id]');
  if(rb){ setUserRole(rb.getAttribute('data-role-id'), rb.getAttribute('data-role-name'), rb.getAttribute('data-role-to')); }
});
async function apiTest(kind){
  const u=document.getElementById('u').value.trim(),p=document.getElementById('p').value;
  out.textContent='请求中…';
  try{
    const r=await fetch('/api/'+kind,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,password:p})});
    const d=await r.json().catch(()=>({}));
    out.textContent=r.ok
      ? (kind==='register'?'注册成功：':'登录成功：')+'\\n'+JSON.stringify(d,null,2)
      : (r.status+' '+(d.error||'请求失败'));
  }catch(e){ out.textContent='请求失败: '+e.message }
}
init();
</script>
</body>
</html>`);
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
      role: u.role === 'admin' ? 'admin' : 'user',
      huangguoUnlocked: Boolean(u.huangguoUnlocked),
      avatar: u.avatar || null,
      createdAt: u.createdAt || 0,
      updatedAt: u.updatedAt || u.createdAt || 0
    }))
    .sort((a, b) => a.createdAt - b.createdAt);
  res.json({ users: list });
});

// 设置用户角色（管理员/普通用户；用户管理员可 NAS 下载、免动态码进私密模式）
app.put('/api/admin/users/:id/role', requireAdmin, (req, res) => {
  const id = String(req.params.id);
  const user = users[id];
  if (!user) return res.status(404).json({ error: '用户不存在' });
  const role = String((req.body && req.body.role) || '').trim();
  if (role !== 'admin' && role !== 'user') return res.status(400).json({ error: '角色只能是 admin 或 user' });
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
  res.json({ service: 'veyra-backend', status: 'ok', users: Object.keys(users).length, dataDir: DATA_DIR, registerOpen });
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
  const target = 'https://thu.pqhybuxo.cc/';
  const started = Date.now();
  proxyFetch.requestThroughProxy(target, proxy || backendProxy, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36' },
    timeout: 15_000, maxBytes: 1024 * 1024, redirects: 5,
  }, (err, result) => {
    if (err) return res.json({ ok: false, error: err.message || '连接失败' });
    if (result.status < 200 || result.status >= 300)
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
app.post('/api/otp/verify', auth, (req, res) => {
  if (req.user.role === 'admin') {
    req.user.huangguoUnlocked = true;
    req.user.updatedAt = Date.now();
    flush();
    return res.json({ ok: true, unlocked: true });
  }
  if (!verifyOtp(req.body && req.body.code)) return res.status(401).json({ error: '动态码不正确或已过期' });
  req.user.huangguoUnlocked = true;
  req.user.updatedAt = Date.now();
  flush();
  res.json({ ok: true, unlocked: true });
});

// ---- 黄果转发接口：APK 直连不通时绕行（只放行黄果站点/封面/视频域名）----
// 支持后端代理（WebUI 配置 backendProxy）：抓取时按配置走代理或直连；
// m3u8 列表返回前重写分片 URL 为后端代理地址，保证手机端分片请求也走后端。
const proxyCache = new Map(); // target -> { body, type, expires }
const MAX_CACHE_ENTRIES = 200;
const CACHE_TTL = { m3u8: 30_000, html: 60_000, image: 24 * 3600_000, video: 0, other: 0 };
const MAX_BYTES = { m3u8: 1024 * 1024, html: 1024 * 1024, image: 5 * 1024 * 1024, video: 50 * 1024 * 1024, other: 5 * 1024 * 1024 };
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
function kindOf(type, body) {
  const t = String(type || '').toLowerCase();
  if (t.includes('mpegurl') || t.includes('m3u8')) return 'm3u8';
  if (body.length > 6 && body.slice(0, 7).toString('utf8') === '#EXTM3U') return 'm3u8';
  if (t.startsWith('text/') || t.includes('html') || t.includes('xml') || t.includes('json')) return 'html';
  if (t.startsWith('image/')) return 'image';
  if (t.includes('mp2t') || t.includes('mp4') || t.includes('m4s') || t.includes('octet-stream')) return 'video';
  return 'other';
}
app.get('/api/huangguo-proxy', (req, res) => {
  const target = String(req.query.url || '');
  let parsed;
  try { parsed = new URL(target); } catch { return res.status(400).json({ error: '无效地址' }); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    return res.status(400).json({ error: '仅支持 http/https' });
  if (!HUANGGUO_HOST_RE.test(parsed.hostname))
    return res.status(403).json({ error: '仅允许黄果站点域名' });
  const cached = cacheGet(target);
  if (cached) {
    res.setHeader('Content-Type', cached.type);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Proxy-Cache', 'hit');
    return res.end(cached.body);
  }
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36',
    'Accept': '*/*',
  };
  headers['Referer'] = `${parsed.protocol}//${parsed.hostname}/`;
  proxyFetch.requestThroughProxy(target, backendProxy, {
    headers, timeout: 25_000, maxBytes: 50 * 1024 * 1024, redirects: 5,
  }, (err, result) => {
    if (err) {
      if (!res.headersSent) return res.status(502).json({ error: '上游站点连接失败: ' + (err.message || '') });
      return res.end();
    }
    if (result.status < 200 || result.status >= 300)
      return res.status(502).json({ error: '上游站点返回 ' + result.status });
    let type = String(result.headers['content-type'] || 'text/html; charset=utf-8');
    let body = result.body;
    let kind = kindOf(type, body);
    if (body.length > MAX_BYTES[kind]) {
      return res.status(502).json({ error: '响应超过大小限制（' + MAX_BYTES[kind] + ' 字节）' });
    }
    if (kind === 'm3u8') {
      type = 'application/vnd.apple.mpegurl; charset=utf-8';
      // 重写 m3u8：普通 URI 行 + #EXT-X-KEY/#EXT-X-MAP 的 URI="..." 全部包一层后端代理
      const base = `${req.protocol}://${req.headers.host}/api/huangguo-proxy?url=`;
      let text = body.toString('utf8');
      text = text.replace(/(URI=")([^"]+)(")/g, (_m, a, u, c) => {
        try { return a + base + encodeURIComponent(new URL(u, target).toString()) + c; }
        catch { return _m; }
      });
      text = text.replace(/^(?!#)(.+)$/gm, (line) => {
        const uri = line.trim();
        if (!uri) return line;
        try { return base + encodeURIComponent(new URL(uri, target).toString()); }
        catch { return line; }
      });
      body = Buffer.from(text, 'utf8');
    }
    if (kind === 'm3u8' || kind === 'html' || kind === 'image') cachePut(target, body, type, CACHE_TTL[kind]);
    res.status(200);
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Proxy-Cache', 'miss');
    res.end(body);
  });
});

// 健康检查
// ---- 下载任务（NAS 整剧下载+合并，需登录；管理员会话可见/可删全部）----
function isAdminRequest(req) {
  const match = String(req.headers.authorization || '').match(/^Bearer\s+([a-f0-9]{64})$/i);
  return !!match && (adminSessions[match[1]] || 0) > Date.now();
}
app.post('/api/download/tasks', auth, (req, res) => {
  if (!needUser(req, res)) return;
  // NAS 下载仅用户管理员（role=admin）可用；普通用户只能下载到手机
  if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员可下载到 NAS' });
  try {
    const task = downloader.createTask({
      source: req.body.source, title: req.body.title, seriesId: req.body.seriesId,
      episodes: req.body.episodes, owner: req.user.id,
    });
    res.json({ task });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/download/tasks', auth, (req, res) => {
  if (!needUser(req, res)) return;
  res.json({ tasks: downloader.listTasks(req.user.id, isAdminRequest(req)) });
});
app.get('/api/download/tasks/:id', auth, (req, res) => {
  if (!needUser(req, res)) return;
  const task = downloader.getTask(req.params.id, req.user.id, isAdminRequest(req));
  if (!task) return res.status(404).json({ error: '任务不存在' });
  res.json({ task });
});
app.delete('/api/download/tasks/:id', auth, (req, res) => {
  if (!needUser(req, res)) return;
  if (!downloader.deleteTask(req.params.id, req.user.id, isAdminRequest(req)))
    return res.status(404).json({ error: '任务不存在' });
  res.json({ ok: true });
});

app.get('/api/health', (_req, res) => {
  res.json({ code: 200, service: 'veyra-backend', status: 'ok', time: Date.now(), download: downloader.status() });
});

// 注册（密码不限长度：1 位即可；开关在 WebUI 管理台实时控制，持久化到 settings.json）
app.post('/api/register', (req, res) => {
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`veyra-backend listening on 0.0.0.0:${PORT}, data dir: ${DATA_DIR}`);
});
