#!/usr/bin/env node
/** 冒烟测试：启动后端进程，覆盖注册/登录/改密/头像/片单同步/鉴权拒绝。 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 18555;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chengzi-test-'));
const BASE = `http://127.0.0.1:${PORT}`;

function request(method, url, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(BASE + url, { method, headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
    } }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

(async () => {
  const child = spawn(process.execPath, ['index.js'], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR, ADMIN_PASSWORD: 'smoke-admin-pass' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  child.on('error', e => console.log('SPAWN_ERR:', e.message));
  child.on('exit', (code, sig) => console.log('CHILD_EXIT:', code, sig));
  await new Promise(r => setTimeout(r, 2500));

  try {
    const health = await request('GET', '/api/health');
    assert(health.status === 200 && health.json.service === 'veyra-backend', `health (got ${health.status} ${JSON.stringify(health.json)})`);

    const admin = await request('POST', '/api/admin/login', { password: 'smoke-admin-pass' });
    assert(admin.status === 200 && admin.json.token, '管理员登录');
    const otp = await request('GET', '/api/otp', null, admin.json.token);
    assert(otp.status === 200 && otp.json.code, '获取注册动态码');
    const code = otp.json.code;

    const bad = await request('POST', '/api/register', { username: '中文名', password: '12345678', code });
    assert(bad.status === 400, '用户名格式拒绝');

    const reg = await request('POST', '/api/register', { username: 'chengzi_user', password: 'passw0rd123', code });
    assert(reg.status === 201 && reg.json.token && reg.json.user.username === 'chengzi_user', '注册');
    const token = reg.json.token;

    const dup = await request('POST', '/api/register', { username: 'chengzi_user', password: 'passw0rd123', code });
    assert(dup.status === 409, '重复注册拒绝');

    const login = await request('POST', '/api/login', { username: 'chengzi_user', password: 'passw0rd123' });
    assert(login.status === 200 && login.json.token, '登录');
    const token2 = login.json.token;

    const me = await request('GET', '/api/me', null, token2);
    assert(me.status === 200 && me.json.user.username === 'chengzi_user', '会话恢复 /api/me');

    const wrongPwd = await request('POST', '/api/login', { username: 'chengzi_user', password: 'wrongpass1' });
    assert(wrongPwd.status === 401, '错误密码拒绝');

    const noAuth = await request('GET', '/api/library?source=hongguo', null, 'bad-token');
    assert(noAuth.status === 401, '无效 token 拒绝');

    const library0 = await request('GET', '/api/library?source=hongguo', null, token2);
    assert(library0.status === 200 && JSON.stringify(library0.json.payload) === '{}', '空片单');

    const put = await request('PUT', '/api/library', { source: 'hongguo', payload: { bookmarks: { a: { id: 'a' } }, history: {} } }, token2);
    assert(put.status === 200 && put.json.synced === true, '片单保存');

    const library1 = await request('GET', '/api/library?source=hongguo', null, token2);
    assert(library1.json.payload.bookmarks.a.id === 'a', '片单回读');

    const avatar = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).toString('base64');
    const up = await request('POST', '/api/avatar', { data: avatar }, token2);
    assert(up.status === 200 && up.json.user.avatar.startsWith('/api/avatar/'), '头像上传');

    const avatarGet = await request('GET', up.json.user.avatar);
    assert(avatarGet.status === 200, '头像下载');

    const change = await request('POST', '/api/change-password', { oldPassword: 'passw0rd123', newPassword: 'newpass12345' }, token2);
    assert(change.status === 200 && change.json.token, '改密 + 换 token');

    const oldLogin = await request('POST', '/api/login', { username: 'chengzi_user', password: 'passw0rd123' });
    assert(oldLogin.status === 401, '旧密码失效');

    const newLogin = await request('POST', '/api/login', { username: 'chengzi_user', password: 'newpass12345' });
    assert(newLogin.status === 200, '新密码登录');

    const logout = await request('POST', '/api/logout', null, newLogin.json.token);
    assert(logout.status === 204, '注销');
    const afterLogout = await request('GET', '/api/library?source=hongguo', null, newLogin.json.token);
    assert(afterLogout.status === 401, '注销后 token 失效');

    console.log('PASS: 全部 17 项冒烟测试通过');
  } finally {
    child.kill();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
})().catch(e => { console.error('FAIL:', e); process.exit(1); });
