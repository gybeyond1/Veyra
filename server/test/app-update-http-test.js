'use strict';
/**
 * 后端更新接口的 HTTP 行为测试（不需要真的去 GitHub 下载）：
 *   NODE_PATH=/tmp/srvtest/node_modules node test/app-update-http-test.js
 *
 * 覆盖：清单响应、下载路由、Range 续传（客户端断点）、路径穿越、渠道隔离。
 */
const express = require('express');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAppUpdater } = require('../app-updater');

let pass = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log('ok   ' + label); }
  else { console.log('FAIL ' + label); process.exitCode = 1; }
}

// 造一个 128KB 的假 APK，内容可预测，方便校验 Range 取到的片段
const PAYLOAD = Buffer.alloc(128 * 1024);
for (let i = 0; i < PAYLOAD.length; i++) PAYLOAD[i] = i % 251;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-http-'));
fs.mkdirSync(path.join(dir, 'app-update', 'mobile'), { recursive: true });
fs.mkdirSync(path.join(dir, 'app-update', 'tv'), { recursive: true });
fs.writeFileSync(path.join(dir, 'app-update', 'mobile', 'Veyra-0.24.9.apk'), PAYLOAD);
fs.writeFileSync(path.join(dir, 'app-update', 'tv', 'Veyra-TV-0.24.9.apk'), Buffer.alloc(2048, 7));

const updater = createAppUpdater({ dataDir: dir, log: () => { } });

const app = express();
app.get('/api/app-update', (req, res) => {
  const channel = req.query.channel === 'tv' ? 'tv' : 'mobile';
  res.json(updater.status(channel, String(req.query.current || '')));
});
app.get('/api/app-download/:channel/:file', (req, res) => {
  const file = updater.fileOf(req.params.channel, req.params.file);
  if (!file) return res.status(404).json({ error: '更新包不存在或还没准备好' });
  res.setHeader('Content-Type', 'application/vnd.android.package-archive');
  res.setHeader('Content-Disposition', `attachment; filename="${path.basename(file)}"`);
  res.sendFile(file);
});

function request(port, urlPath, headers) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, headers: headers || {} }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
  });
}

const server = app.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  try {
    /* ---------- 清单 ---------- */
    let res = await request(port, '/api/app-update?channel=mobile&current=0.24.5');
    let json = JSON.parse(res.body.toString());
    ok(res.status === 200 && json.status === 'available', '有新版时返回 available');
    ok(json.version === '0.24.9', '版本号正确（' + json.version + '）');
    ok(json.size === PAYLOAD.length, '包大小正确（' + json.size + '）');
    ok(json.url === '/api/app-download/mobile/Veyra-0.24.9.apk', '下载地址指向后端相对路径');

    res = await request(port, '/api/app-update?channel=mobile&current=0.24.9');
    json = JSON.parse(res.body.toString());
    ok(json.status === 'current', '同版本返回 current');

    /* ---------- 下载 ---------- */
    res = await request(port, '/api/app-download/mobile/Veyra-0.24.9.apk');
    ok(res.status === 200, '完整下载返回 200');
    ok(res.body.length === PAYLOAD.length && res.body.equals(PAYLOAD), '下载内容与源文件一致');
    ok(/android\.package-archive/.test(String(res.headers['content-type'])), 'Content-Type 是 APK');
    ok(/attachment; filename="Veyra-0\.24\.9\.apk"/.test(String(res.headers['content-disposition'])), 'Content-Disposition 带文件名');
    ok(String(res.headers['accept-ranges']) === 'bytes', '声明支持 Range（客户端可断点续传）');

    /* ---------- Range 续传 ---------- */
    res = await request(port, '/api/app-download/mobile/Veyra-0.24.9.apk', { Range: 'bytes=100000-' });
    ok(res.status === 206, 'Range 请求返回 206');
    ok(res.body.length === PAYLOAD.length - 100000, '续传长度正确（' + res.body.length + ' 字节）');
    ok(res.body[0] === PAYLOAD[100000], '续传起点字节对齐');

    res = await request(port, '/api/app-download/mobile/Veyra-0.24.9.apk', { Range: 'bytes=0-1023' });
    ok(res.status === 206 && res.body.length === 1024, '分段请求按长度返回');

    /* ---------- 安全 / 隔离 ---------- */
    res = await request(port, '/api/app-download/mobile/Veyra-0.24.8.apk');
    ok(res.status === 404, '不存在的文件 404');

    res = await request(port, '/api/app-download/mobile/..%2F..%2Fetc%2Fpasswd');
    ok(res.status === 404, '路径穿越被拒');

    res = await request(port, '/api/app-download/other/Veyra-0.24.9.apk');
    ok(res.status === 404, '未知渠道被拒');

    // 电视渠道只能拿到电视包
    res = await request(port, '/api/app-update?channel=tv&current=0.24.5');
    json = JSON.parse(res.body.toString());
    ok(json.status === 'available' && /Veyra-TV-/.test(json.url), '电视渠道拿到电视包（' + json.url + '）');
    res = await request(port, '/api/app-download/tv/Veyra-TV-0.24.9.apk');
    ok(res.status === 200 && res.body.length === 2048, '电视包可下载');

    console.log('\n' + pass + ' passed');
  } catch (error) {
    console.log('ERROR ' + error.message);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});
