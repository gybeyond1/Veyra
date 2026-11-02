'use strict';
/**
 * 分段下载的实战测试。
 *
 * 用户现场的现象：两个 .part 都停在 4.2MB / 4.3MB，一个停住时另一个还在涨
 * —— 说明不是"网络不通"，而是**单个连接下一段就断**（公共反代常见的
 * 单次响应大小/时长限制）。这里用一个本地 HTTP 服务复刻这个行为：
 * 每次响应只吐 400KB 就掐断，看分段逻辑能不能靠续传把整包拼齐。
 */
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { probeRemote, fetchRange } = require('../app-updater');

const SIZE = 3 * 1024 * 1024 + 123;      // 3MB 出头，切 6 段
const BODY = Buffer.alloc(SIZE);
for (let i = 0; i < SIZE; i++) BODY[i] = (i * 31 + 7) & 0xff;

let passed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log('ok   ' + label); }
  else { console.log('FAIL ' + label); process.exitCode = 1; }
}

/** 模拟"每次只给 400KB 就断"的源：支持 Range，但响应写一半 destroy。 */
function startFlakyServer(cutAfter) {
  return http.createServer((req, res) => {
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    if (!range) {
      res.writeHead(200, { 'Content-Length': SIZE, 'Accept-Ranges': 'bytes' });
      res.end(BODY);
      return;
    }
    const start = Number(range[1]);
    const end = range[2] ? Number(range[2]) : SIZE - 1;
    const sliced = BODY.subarray(start, end + 1);
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${SIZE}`,
      'Content-Length': sliced.length,
      'Accept-Ranges': 'bytes',
    });
    // 只吐前 400KB 就断，模拟反代掐流
    const part = sliced.subarray(0, Math.min(cutAfter, sliced.length));
    res.write(part, () => {
      if (part.length < sliced.length) setTimeout(() => res.destroy(), 20);
      else res.end();
    });
  });
}

/** 忽略 Range、永远回整包的源（不少免费反代就这样）。 */
function startNoRangeServer() {
  return http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Length': SIZE });
    res.end(BODY);
  });
}

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-chunk-'));

  // ---- 1. 支持 Range 的源 ----
  const flaky = startFlakyServer(400 * 1024);
  const flakyPort = await listen(flaky);
  const flakyUrl = `http://127.0.0.1:${flakyPort}/apk`;

  const probe = await probeRemote(flakyUrl, '');
  ok(probe && probe.size === SIZE, `探测到大小（${probe && probe.size}）`);
  ok(probe && probe.range === true, '探测到支持 Range');

  // 按 6 段切，每段都靠续传补齐
  const chunks = 6;
  const chunkSize = Math.ceil(SIZE / chunks);
  const files = [];
  for (let i = 0; i < chunks; i++) {
    const start = i * chunkSize;
    const end = Math.min(SIZE - 1, start + chunkSize - 1);
    const file = path.join(dir, `c${i}.part`);
    files.push(file);
    let rounds = 0;
    let complete = false;
    while (!complete && rounds < 30) {
      complete = await fetchRange(flakyUrl, '', start, end, file, '');
      rounds++;
    }
    ok(complete, `第 ${i} 段靠续传拼齐（${rounds} 次请求）`);
    ok(fs.statSync(file).size === end - start + 1, `第 ${i} 段长度正确（${fs.statSync(file).size}）`);
  }

  const merged = Buffer.concat(files.map(f => fs.readFileSync(f)));
  ok(merged.length === SIZE, `拼接后长度 = ${merged.length}`);
  ok(merged.equals(BODY), '拼接后内容与原文件逐字节一致');
  flaky.close();

  // ---- 2. 忽略 Range 的源 ----
  const plain = startNoRangeServer();
  const plainPort = await listen(plain);
  const plainUrl = `http://127.0.0.1:${plainPort}/apk`;
  const plainProbe = await probeRemote(plainUrl, '');
  ok(plainProbe && plainProbe.range === false, '不支持 Range 的源被识别出来（走单流）');

  const broken = path.join(dir, 'broken.part');
  // 源忽略 Range 会回整包；长度远超本段，不能被拼进分段文件
  const result = await fetchRange(plainUrl, '', 0, 1000, broken, '');
  ok(result === false || !fs.existsSync(broken) || fs.statSync(broken).size <= 1001,
    '整包数据不会被当成一段拼进去');
  plain.close();

  // ---- 3. 已有的分段不会被重下 ----
  const again = await fetchRange(flakyUrl, '', 0, 1000, path.join(dir, 'c0.part'), '');
  ok(again === true, '已完整的段直接返回，不再发请求');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('\n' + passed + ' passed');
  setTimeout(() => process.exit(process.exitCode || 0), 100);
})();
