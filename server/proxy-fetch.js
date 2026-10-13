// proxy-fetch.js —— 支持通过 HTTP/SOCKS5 代理抓取 URL（零依赖，Node >=18）
// 用途：后端转发接口 /api/huangguo-proxy 在服务器出口被限时，可按 WebUI 配置的代理抓取黄果源。
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

// 抓取 URL（proxyUrl 为空则直连）；跟随重定向；返回 { status, headers, body(Buffer) }
function requestThroughProxy(targetUrl, proxyUrl, opts, done) {
  const { headers = {}, timeout = 25000, maxBytes = 5 * 1024 * 1024, redirects = 5 } = opts || {};
  let parsed;
  try { parsed = new URL(targetUrl); } catch (e) { return done(e); }
  const isHttps = parsed.protocol === 'https:';
  const mod = isHttps ? https : http;
  const reqOptions = {
    hostname: parsed.hostname,
    port: parsed.port || (isHttps ? 443 : 80),
    path: parsed.pathname + parsed.search,
    method: 'GET',
    headers,
  };
  const perform = () => {
    const req = mod.request(reqOptions, onResponse);
    req.setTimeout(timeout, () => req.destroy(new Error('上游站点超时')));
    req.on('error', (e) => done(e));
    req.end();
  };
  if (!proxyUrl) {
    perform();
  } else {
    let proxy;
    try { proxy = parseProxy(proxyUrl); } catch (e) { return done(e); }
    connectViaProxy(proxy, reqOptions.hostname, reqOptions.port, (err, socket) => {
      if (err) return done(err);
      reqOptions.createConnection = () => socket;
      perform();
    });
  }
  function onResponse(res) {
    const status = res.statusCode || 0;
    if (status >= 300 && status < 400 && res.headers.location && redirects > 0) {
      res.resume();
      const next = new URL(res.headers.location, targetUrl).toString();
      return requestThroughProxy(next, proxyUrl, { ...opts, redirects: redirects - 1 }, done);
    }
    const chunks = [];
    let size = 0;
    let overflow = false;
    res.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) { overflow = true; res.destroy(); }
      else chunks.push(c);
    });
    res.on('end', () => {
      if (overflow) return done(new Error('响应超过大小限制 ' + maxBytes));
      done(null, { status, headers: res.headers, body: Buffer.concat(chunks) });
    });
    res.on('error', (e) => done(e));
  }
}

module.exports = { requestThroughProxy, parseProxy, connectViaProxy };
