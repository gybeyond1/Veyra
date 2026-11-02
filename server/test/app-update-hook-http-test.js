'use strict';
/**
 * /api/hook/release 的 HTTP 行为测试（真 express、真签名，不联网）：
 *   NODE_PATH=/tmp/srvtest/node_modules node test/app-update-hook-http-test.js
 *
 * 覆盖：挂载方式、ping、错签名、draft 忽略、published 接受、快车道状态、非 release 事件。
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const express = require('express');
const { createAppUpdater } = require('../app-updater');
const { mountReleaseHook } = require('../release-hook');

let pass = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('ok   ' + label); }
  else { console.log('FAIL ' + label); process.exitCode = 1; }
};

const SECRET = 'testsecret';
const sign = (raw) => 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw).digest('hex');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-hook-http-'));
const lines = [];
const updater = createAppUpdater({ dataDir: dir, log: (m) => lines.push(m), autoPoll: false });

const app = express();
// 和 index.js 一样：留一份原始字节给 HMAC 用
app.use(express.json({ limit: '3mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
let secret = SECRET;
mountReleaseHook(app, { updater, log: (m) => lines.push(m), secretOf: () => secret });

const server = http.createServer(app);

function post(body, headers) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      port: server.address().port, path: '/api/hook/release', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw), ...headers },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch { /* 空响应 */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    req.end(raw);
  });
}

server.listen(0, '127.0.0.1', async () => {
  try {
    // 1. ping（GitHub 保存 webhook 时会先打一发）
    const ping = await post({ zen: 'hi' }, { 'x-github-event': 'ping' });
    ok(ping.status === 200 && ping.json.pong === true, 'ping 回 200 + pong');

    // 2. 没配 secret 时端点等于不存在
    secret = '';
    const missing = await post({ action: 'published' }, { 'x-github-event': 'release' });
    ok(missing.status === 404, '没配 GITHUB_WEBHOOK_SECRET 时回 404');
    secret = SECRET;

    // 3. 签名不对
    const body = JSON.stringify({ action: 'published', release: { tag_name: 'v9.9.9', assets: [] } });
    const bad = await post(body, { 'x-github-event': 'release', 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) });
    ok(bad.status === 401, '签名不对回 401');

    // 4. 没签名头
    const none = await post(body, { 'x-github-event': 'release' });
    ok(none.status === 401, '缺签名头回 401');

    // 5. 非 release 事件
    const push = await post({}, { 'x-github-event': 'push', 'x-hub-signature-256': sign('{}') });
    ok(push.status === 202 && push.json.ignored === 'push', 'push 事件忽略，回 202');

    // 6. draft 阶段（created）不拉
    const draftBody = JSON.stringify({ action: 'created', release: { tag_name: 'v9.9.9', assets: [] } });
    const draft = await post(draftBody, { 'x-github-event': 'release', 'x-hub-signature-256': sign(draftBody) });
    ok(draft.status === 202 && draft.json.ignored === 'created', 'draft（created）忽略，回 202');
    ok(updater.wakeState === null, 'draft 不会挂上快车道');

    // 7. published + 资产齐全 → 接受
    const pubBody = JSON.stringify({
      action: 'published',
      release: { tag_name: 'v9.9.9', body: '测试发版', assets: [{ name: 'Veyra-9.9.9.apk' }, { name: 'Veyra-TV-9.9.9.apk' }] },
    });
    const pub = await post(pubBody, { 'x-github-event': 'release', 'x-hub-signature-256': sign(pubBody) });
    ok(pub.status === 202 && pub.json.ok === true, 'published 被接受，立刻回 202');
    ok(updater.wakeState && updater.wakeState.tag === 'v9.9.9', '快车道记下了 v9.9.9');
    ok(lines.some((l) => /\[hook\] release published v9\.9\.9 已排进下载队列/.test(l)), '日志记了这次触发');

    // 8. 非法 tag 不挂快车道
    const bad2 = JSON.stringify({ action: 'published', release: { tag_name: 'nightly', assets: [] } });
    const nightly = await post(bad2, { 'x-github-event': 'release', 'x-hub-signature-256': sign(bad2) });
    ok(nightly.status === 202 && nightly.json.ok === false, '非语义化 tag 回 ok:false');

    // 9. body 被重新序列化过（模拟「解析后再 stringify」）验签必须失败
    const reserialized = JSON.stringify(JSON.parse(pubBody), null, 2);
    const tampered = await post(reserialized, { 'x-github-event': 'release', 'x-hub-signature-256': sign(pubBody) });
    ok(tampered.status === 401, '改动过的 body 验签失败（证明确实按原始字节校验）');
  } catch (e) {
    console.log('FAIL 异常：' + e.message);
    process.exitCode = 1;
  } finally {
    server.close();
    updater.stop();
    console.log('\n' + pass + ' passed' + (process.exitCode ? ', FAILED' : ''));
    setTimeout(() => process.exit(process.exitCode || 0), 50);
  }
});
