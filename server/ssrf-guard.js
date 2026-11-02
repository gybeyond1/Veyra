'use strict';
/*
 * ssrf-guard.js —— 代理目标的 SSRF 防线。
 *
 * 背景：/api/huangguo-proxy 是公网开放的转发接口（WebView 的 <img>/播放器没法带
 * Authorization 头，所以它必须是匿名的），目标 URL 完全由调用方给。只靠一份
 * "内网 IP 前缀表"拦不住真正的攻击面：
 *
 *   1. 前缀表本身漏了 192.168/16、100.64/10（CGNAT/Tailscale）和整个 IPv6；
 *   2. hostname 是域名时，解析到 127.0.0.1 就能绕过字符串判断（DNS rebinding）；
 *   3. curl -L 自动跟重定向，第二跳跳到内网时没人再检查（已在 proxy-fetch 里改成逐跳校验）。
 *
 * 这里提供两层：
 *   - isPrivateHostname / isPrivateIp：纯字符串判断，发给前端展示或快速拒绝；
 *   - assertPublicUrl：异步，域名会真的解析一遍，任一解析结果是内网就拒绝。
 *
 * 注意：DNS 校验与 curl 实际连接之间仍有极短的时间窗（除非用 --resolve 钉死解析结果）。
 * 走上游代理时也拦不住代理侧的解析。这两点属于残余风险，已比原来只判断字符串好得多。
 */

const dns = require('dns');
const net = require('net');

const DNS_TIMEOUT_MS = 3000;

/** 去掉 IPv6 的方括号（Node 的 URL.hostname 对 IPv6 返回 "[::1]" 形式）。 */
function stripBrackets(host) {
  const h = String(host == null ? '' : host).trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) return h.slice(1, -1);
  return h;
}

/** IPv4 是否属于内网/保留段。非法写法（段数不对、超过 255）一律当内网。 */
function ipv4Private(host) {
  const parts = String(host).split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  return a === 0                              // 0.0.0.0/8 本网络
    || a === 10                               // 10.0.0.0/8
    || a === 127                              // 环回
    || (a === 100 && b >= 64 && b <= 127)     // 100.64.0.0/10 CGNAT / Tailscale
    || (a === 169 && b === 254)               // 链路本地（云元数据 169.254.169.254）
    || (a === 172 && b >= 16 && b <= 31)      // 172.16.0.0/12
    || (a === 192 && b === 168)               // 192.168.0.0/16（原实现漏了这一段）
    || (a === 192 && b === 0)                 // 192.0.0.0/24 + 192.0.2.0/24
    || (a === 198 && (b === 18 || b === 19))  // 198.18.0.0/15 基准测试
    || a >= 224;                              // 组播 224/4 + 保留 240/4 + 广播
}

/** IPv6 是否属于内网/保留段。默认拒绝：只放行 2000::/3 全球单播。 */
function ipv6Private(host) {
  const h = String(host).replace(/%.*$/, '');   // 去掉 %eth0 这类 scope id
  // IPv4 映射/兼容写法：::ffff:192.168.1.1、::127.0.0.1
  const mapped = h.match(/^(?:::ffff:|::)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (mapped) return ipv4Private(mapped[1]);
  if (h.includes('.')) return true;             // 其它 v4 混写形式，一律拒
  const first = h.split(':').find(g => g !== '') || '0';
  const g0 = parseInt(first, 16);
  if (!Number.isFinite(g0)) return true;
  if ((g0 & 0xfe00) === 0xfe80) return true;    // fe80::/10 链路本地
  if ((g0 & 0xfe00) === 0xfc00) return true;    // fc00::/7 唯一本地
  if ((g0 & 0xff00) === 0xff00) return true;    // ff00::/8 组播
  if ((g0 & 0xe000) === 0x2000) return false;   // 2000::/3 全球单播
  return true;                                  // ::1、::、IPv4 兼容段等，全拒
}

/** 按字符串判断 hostname 是否内网。IPv4/IPv6 字面量走专门的段判断。 */
function isPrivateHostname(hostname) {
  if (!hostname) return true;
  const h = stripBrackets(hostname);
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost')
    || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan')
    || h === 'home.arpa' || h.endsWith('.home.arpa')) return true;
  if (net.isIPv4(h)) return ipv4Private(h);
  if (net.isIPv6(h)) return ipv6Private(h);
  // 形如 999.1.1.1 的写法 net 不认，当非法地址拒绝
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return ipv4Private(h);
  // libc/curl 会把下面这些非标准写法解析成 IPv4：127.1 → 127.0.0.1、2130706433、
  // 0x7f000001、017700000001。只按点分四段判断等于留了个后门，整类一律拒绝。
  if (/^\d+$/.test(h)) return true;
  if (/^0x[0-9a-f]+$/i.test(h)) return true;
  if (/^\d{1,3}(\.\d{1,3}){0,2}$/.test(h)) return true;
  if (/^(0x[0-9a-f]+|\d+)(\.(0x[0-9a-f]+|\d+)){1,3}$/i.test(h)) return true;
  if (h.includes(':')) return ipv6Private(h);
  return false;
}

/** 任意 IP 字符串是否内网；非法输入当内网。 */
function isPrivateIp(ip) {
  const h = stripBrackets(ip);
  if (net.isIPv4(h)) return ipv4Private(h);
  if (net.isIPv6(h)) return ipv6Private(h);
  return true;
}

/** 解析域名的全部 A/AAAA 记录，带超时（系统解析器卡住时别把请求一起拖死）。 */
function lookupAll(host) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('域名解析超时：' + host));
    }, DNS_TIMEOUT_MS);
    dns.lookup(host, { all: true, verbatim: true }, (err, list) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) return reject(new Error('域名解析失败：' + host));
      resolve(Array.isArray(list) ? list : []);
    });
  });
}

/**
 * 断言 URL 指向公网。不通过就抛错（调用方直接 403）。
 * 域名会真的解析一次：任一记录落到内网即拒绝，堵住 "域名指向 127.0.0.1" 这种绕过。
 */
async function assertPublicUrl(raw) {
  let url;
  try { url = new URL(String(raw || '')); } catch { throw new Error('无效地址'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('仅支持 http/https');

  const host = stripBrackets(url.hostname);
  if (isPrivateHostname(host)) throw new Error('代理拒绝内网地址（防 SSRF）');
  if (net.isIP(host)) return url;   // 已经是公网 IP 字面量

  const list = await lookupAll(host);
  if (!list.length) throw new Error('域名解析失败：' + host);
  for (const item of list) {
    if (isPrivateIp(item.address)) {
      throw new Error('代理拒绝内网地址（防 SSRF）：' + host + ' 解析到 ' + item.address);
    }
  }
  return url;
}

module.exports = {
  isPrivateHostname,
  isPrivateIp,
  assertPublicUrl,
  // 便于单测
  ipv4Private,
  ipv6Private,
};
