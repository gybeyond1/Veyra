// proxy-fetch.js —— 通过 HTTP/SOCKS5 代理抓取 URL（底层调用系统 curl）
// 用途：后端转发接口 /api/huangguo-proxy 在服务器出口被限时，可按 WebUI 配置的代理抓取黄果源。
//
// 2026-10-16 抓取底层从 Node https（CONNECT 隧道）改为系统 curl：
//   黄果站点边缘对 Node TLS 客户端指纹（ClientHello/JA3）返回 400，对 curl 正常放行
//   （实测：同一代理同一目标，curl=301 正常响应，Node=400 被拒）。curl 依赖由 Dockerfile 安装。
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');

function parseProxy(url) {
  const p = new URL(url);
  const type = p.protocol === 'socks5:' ? 'socks5' : 'http';
  const port = p.port ? parseInt(p.port, 10) : (type === 'socks5' ? 1080 : 8080);
  return { type, host: p.hostname, port };
}

// 通过代理建立到 (host, port) 的隧道，回调 (err, socket)
// 保留供诊断/扩展使用；正常抓取已由 requestThroughProxy 委托给系统 curl。
function connectViaProxy(proxy, host, port, done) {
  const socket = net.connect(proxy.port, proxy.host, () => {
    if (proxy.type === 'http') {
      // HTTP 代理：CONNECT 隧道
      socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
      let buf = '';
      const onData = (chunk) => {
        buf += chunk.toString('latin1');
        const idx = buf.indexOf('\r\n\r\n');
        if (idx < 0) return;
        socket.removeListener('data', onData);
        const code = parseInt(buf.slice(0, idx).split(' ')[1], 10);
        if (code !== 200) { socket.destroy(); done(new Error('代理 CONNECT 失败: HTTP ' + code)); return; }
        done(null, socket);
      };
      socket.on('data', onData);
    } else {
      // SOCKS5：方法协商（仅无认证）→ CONNECT
      socket.write(Buffer.from([0x05, 0x01, 0x00]));
      let stage = 0, buf = Buffer.alloc(0);
      const onData = (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (stage === 0) {
          if (buf.length < 2) return;
          if (buf[0] !== 0x05 || buf[1] !== 0x00) { socket.destroy(); done(new Error('SOCKS5 协商失败（代理要求认证？）')); return; }
          stage = 1;
          const hostBuf = Buffer.from(host, 'utf8');
          socket.write(Buffer.concat([
            Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]), hostBuf,
            Buffer.from([(port >> 8) & 0xff, port & 0xff]),
          ]));
          buf = Buffer.alloc(0);
        } else {
          if (buf.length < 10) return;
          if (buf[0] !== 0x05 || buf[1] !== 0x00) { socket.destroy(); done(new Error('SOCKS5 连接目标失败')); return; }
          socket.removeListener('data', onData);
          done(null, socket);
        }
      };
      socket.on('data', onData);
    }
  });
  socket.on('error', (e) => done(e));
}

// 抓取 URL（proxyUrl 为空则直连）；返回 { status, headers, body(Buffer) }
// 底层用系统 curl：目标站点对 Node TLS 指纹风控（400）时 curl 可正常访问（浏览器级指纹更接近）。
//
// 重定向改成手动逐跳：以前用 curl -L，跳转目标完全不经检查 —— 传一个自己的公网域名，
// 让它 302 到 http://192.168.1.1/，前面所有 host 校验就白做了。现在每一跳都过 opts.guard
// （一般是 ssrf-guard 的 assertPublicUrl），跳数仍受 opts.redirects 限制。
function requestThroughProxy(targetUrl, proxyUrl, opts, done) {
  const { headers = {}, timeout = 25000, maxBytes = 5 * 1024 * 1024, redirects = 5, guard } = opts || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-curl-'));
  const bodyFile = path.join(dir, 'body');
  const headerFile = path.join(dir, 'headers');
  let current = String(targetUrl || '');
  let hops = 0;

  const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ } };
  const finish = (err, result) => { cleanup(); done(err, result); };

  const fetchOne = () => {
    let parsed;
    try { parsed = new URL(current); } catch (e) { return finish(e); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return finish(new Error('仅支持 http/https'));

    const args = ['-sS', '--max-time', String(Math.max(1, Math.round(timeout / 1000)))];
    if (proxyUrl) args.push('-x', proxyUrl);
    for (const [k, v] of Object.entries(headers)) {
      if (v !== undefined && v !== null) args.push('-H', `${k}: ${v}`);
    }
    // 不带 -L：自己跟，才能逐跳校验。%{redirect_url} 给出 3xx 的绝对 Location
    args.push('-o', bodyFile, '-D', headerFile, '-w', '%{http_code}\n%{content_type}\n%{redirect_url}', current);
    execFile('curl', args, { maxBuffer: 16 * 1024 * 1024, timeout: timeout + 5000 }, (err, stdout, stderr) => {
      if (err) {
        const msg = String(stderr || '').trim() || err.message || 'curl 抓取失败';
        return finish(new Error(msg));
      }
      const lines = String(stdout).split('\n');
      const code = parseInt(lines[0], 10) || 0;
      const contentType = String(lines[1] || '').trim();
      const location = String(lines[2] || '').trim();

      if (code >= 300 && code < 400 && location) {
        if (hops++ >= redirects) return finish(new Error('重定向次数超过 ' + redirects));
        let next;
        try { next = new URL(location, current).toString(); } catch { return finish(new Error('重定向地址无效: ' + location.slice(0, 120))); }
        current = next;
        return step();
      }

      let body;
      try { body = fs.readFileSync(bodyFile); } catch (e) { return finish(e); }
      if (body.length > maxBytes) return finish(new Error('响应超过大小限制 ' + maxBytes));
      // 解析 curl -D dump 的响应头（只取最后一段）
      const respHeaders = {};
      try {
        const raw = fs.readFileSync(headerFile, 'utf8');
        const blocks = raw.split(/\r?\n\r?\n/);
        const last = blocks.filter(b => b.trim()).pop() || '';
        for (const line of last.split(/\r?\n/)) {
          const idx = line.indexOf(':');
          if (idx > 0) respHeaders[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
        }
      } catch { /* 无响应头时忽略 */ }
      finish(null, { status: code, headers: Object.assign({ 'content-type': contentType }, respHeaders), body });
    });
  };

  // 每一跳（含第一跳）都先过 guard；guard 抛错就整条中止
  const step = () => {
    if (!guard) return fetchOne();
    Promise.resolve()
      .then(() => guard(current))
      .then(() => fetchOne())
      .catch((e) => finish(e instanceof Error ? e : new Error(String(e))));
  };

  step();
}

module.exports = { requestThroughProxy, parseProxy, connectViaProxy };
