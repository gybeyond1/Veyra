'use strict';
/*
 * SSRF 防线测试：地址判定 + 域名解析 + 重定向逐跳校验。
 * 运行：node test/ssrf-guard-test.js
 */
const http = require('http');
const path = require('path');
const { isPrivateHostname, isPrivateIp, assertPublicUrl } = require('../ssrf-guard');
const { requestThroughProxy } = require('../proxy-fetch');

let pass = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name); process.exitCode = 1; }
}

console.log('\n[IPv4 判定]');
for (const h of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.5',
  '169.254.169.254', '100.64.0.1', '100.127.255.255', '0.0.0.0', '224.0.0.1', '255.255.255.255',
  '999.1.1.1', '1.2.3']) {
  ok(isPrivateHostname(h), h + ' 拒绝');
}
for (const h of ['172.32.0.1', '100.63.0.1', '100.128.0.1', '8.8.8.8', '1.1.1.1', '203.0.114.1']) {
  ok(!isPrivateHostname(h), h + ' 放行');
}

console.log('\n[非标准 IPv4 写法]');
// libc 会把 127.1 当成 127.0.0.1、2130706433 当成 127.0.0.1，只判断点分四段等于留后门
for (const h of ['127.1', '1.2.3', '2130706433', '0x7f000001', '017700000001', '192.168.1']) {
  ok(isPrivateHostname(h), h + ' 拒绝');
}
ok(!isPrivateHostname('123.com'), '123.com 仍放行（不是 IP 写法）');

console.log('\n[IPv6 判定]');
for (const h of ['[::1]', '::1', '[::]', '[fe80::1]', '[fd00::1]', '[fc00::1]',
  '[::ffff:192.168.1.1]', '[::ffff:127.0.0.1]', '[ff02::1]', '[::ffff:7f00:1]']) {
  ok(isPrivateHostname(h), h + ' 拒绝');
}
for (const h of ['[2001:4860:4860::8888]', '2606:4700::1111', '[2a00:1450:4001::1]']) {
  ok(!isPrivateHostname(h), h + ' 放行');
}

console.log('\n[主机名判定]');
for (const h of ['localhost', 'foo.local', 'router.lan', 'x.internal', 'home.arpa', '', null]) {
  ok(isPrivateHostname(h), JSON.stringify(h) + ' 拒绝');
}
ok(!isPrivateHostname('example.com'), 'example.com 放行');

console.log('\n[isPrivateIp]');
ok(isPrivateIp('192.168.0.1'), '192.168.0.1 内网');
ok(isPrivateIp('::1'), '::1 内网');
ok(!isPrivateIp('8.8.8.8'), '8.8.8.8 公网');
ok(isPrivateIp('not-an-ip'), '非法输入当内网');

(async () => {
  console.log('\n[assertPublicUrl]');
  const reject = async (u, name) => {
    try { await assertPublicUrl(u); ok(false, name + '（竟然放行了）'); }
    catch (e) { ok(true, name + ' → ' + e.message); }
  };
  const allow = async (u, name) => {
    try { await assertPublicUrl(u); ok(true, name); }
    catch (e) { ok(false, name + '（被误拦：' + e.message + '）'); }
  };

  await reject('http://127.0.0.1:8080/api', '环回地址');
  await reject('http://192.168.1.5:8080/', '家用网段');
  await reject('http://[::1]:8080/', 'IPv6 环回');
  await reject('http://169.254.169.254/latest/meta-data', '云元数据');
  await reject('http://localhost/', 'localhost');
  await reject('file:///etc/passwd', '非 http 协议');
  await reject('http://100.64.0.1/', 'CGNAT');
  await allow('http://8.8.8.8/', '公网 IP');
  await allow('https://example.com/', '公网域名（真实解析）');

  // ---- 重定向逐跳校验 ----
  console.log('\n[重定向逐跳]');
  let hits = { first: 0, second: 0 };
  const second = http.createServer((req, res) => {
    hits.second++;
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('final');
  });
  await new Promise(r => second.listen(0, '127.0.0.1', r));
  const p2 = second.address().port;
  const first = http.createServer((req, res) => {
    hits.first++;
    res.writeHead(302, { location: `http://127.0.0.1:${p2}/final` });
    res.end();
  });
  await new Promise(r => first.listen(0, '127.0.0.1', r));
  const p1 = first.address().port;
  const start = `http://127.0.0.1:${p1}/start`;

  // 1) 第二跳被 guard 拦下：必须收不到 final
  const visits = [];
  const blocked = await new Promise((resolve) => {
    requestThroughProxy(start, null, {
      timeout: 5000, redirects: 5,
      guard: async (u) => {
        visits.push(u);
        if (visits.length >= 2) throw new Error('拦下内网跳转');
      },
    }, (err, result) => resolve({ err, result }));
  });
  ok(blocked.err && /拦下内网跳转/.test(blocked.err.message), '302 到内网时被拦下');
  ok(visits.length === 2, '每一跳都调用了 guard（实际 ' + visits.length + ' 次）');
  ok(visits[1] && /127\.0\.0\.1/.test(visits[1]), 'guard 看到的是解析后的绝对地址：' + (visits[1] || ''));

  // 2) guard 放行时能正常跟随（确认手动跟重定向没把正常链路改坏）
  hits = { first: 0, second: 0 };
  const okRes = await new Promise((resolve) => {
    requestThroughProxy(start, null, { timeout: 5000, redirects: 5, guard: async () => {} },
      (err, result) => resolve({ err, result }));
  });
  ok(!okRes.err, '正常重定向不报错' + (okRes.err ? '：' + okRes.err.message : ''));
  ok(okRes.result && okRes.result.status === 200, '最终状态 200');
  ok(okRes.result && okRes.result.body.toString() === 'final', '取到最终响应体');
  ok(hits.first === 1 && hits.second === 1, '两跳各请求一次');

  // 3) 首跳就被拦：一次请求都不该发出
  hits = { first: 0, second: 0 };
  const zero = await new Promise((resolve) => {
    requestThroughProxy(start, null, {
      timeout: 5000, guard: async () => { throw new Error('首跳拒绝'); },
    }, (err) => resolve(err));
  });
  ok(zero && /首跳拒绝/.test(zero.message), '首跳被拒时直接报错');
  ok(hits.first === 0 && hits.second === 0, '被拒时没有发出任何上游请求');

  // 4) 跳数上限
  const loop = http.createServer((req, res) => {
    res.writeHead(302, { location: `http://127.0.0.1:${loop.address().port}/again` });
    res.end();
  });
  await new Promise(r => loop.listen(0, '127.0.0.1', r));
  const loopErr = await new Promise((resolve) => {
    requestThroughProxy(`http://127.0.0.1:${loop.address().port}/loop`, null,
      { timeout: 5000, redirects: 3, guard: async () => {} }, (err) => resolve(err));
  });
  ok(loopErr && /重定向次数超过 3/.test(loopErr.message), '循环重定向被跳数上限截断');

  first.close(); second.close(); loop.close();
  console.log('\n' + pass + ' passed' + (process.exitCode ? ', FAILED' : ''));
  process.exit(process.exitCode || 0);
})();
