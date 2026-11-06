// 红果 App 官方接口取流（视频直链 + CENC 解密密钥）。
// 2026-10-27 对齐 guoapp 全链（与 hongguo-dl python 后端同源）：
//   1) 真设备注册 log.snssdk.com device_register（失败回退随机 19 位）
//   2) query 字典序 + Go QueryEscape（* → %2A，空格 → +，~ 保留）——此前 %2A 被还原成 * 导致服务端解析错乱空响应
//   3) 空响应冷却重试 + 换设备（≤3 轮）
//   4) video_model 先 JSON 后 base64 兜底
//   5) spade_a → AES key 用 guoapp hongguoContentKey 新算法（旧算法兜底）
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const https = require('https');
const hgSign = require('./hongguo-sign');

const BASE = 'https://api5-normal-sinfonlineb.fqnovel.com';
const UA = 'com.phoenix.read/73532 (Linux; U; Android 16; zh_CN; 25053RT47C; Build/BP2A.250605.031.A3; Cronet/TTNetVersion:04657795 2026-01-23 QuicVersion:c67e9834 2025-09-08)';
// 与 APK HongguoSigner 一致的固定设备参数（注册成功后 device_id/iid 会覆盖）
const FIXED_DEVICE = {
  ac: 'wifi', aid: '8662', app_name: 'novelread', channel: 'update_64',
  device_brand: 'Redmi', device_id: '', device_platform: 'android',
  device_type: '25053RT47C', dpi: '520', iid: '', language: 'zh',
  manifest_version_code: '73532', os: 'android', os_api: '36', os_version: '16',
  resolution: '1280*2772', ssmix: 'a', update_version_code: '73532',
  version_code: '73532', version_name: '7.3.5.32',
};

let registeredDevice = null; // { device_id, iid }

const QUALITY = {
  2160: 2160, 1440: 1440, 1080: 1080, 720: 720, 576: 576, 540: 540, 480: 480, 360: 360,
  1920: 1080, 1280: 720, 1024: 576, 854: 480, 640: 360,
};

function qualityNumber(value) {
  const m = /2160|1440|1080|720|576|540|480|360/.exec(String(value || ''));
  if (m) return parseInt(m[0], 10);
  if (QUALITY[String(value)]) return QUALITY[String(value)];
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Go url.QueryEscape：字母数字 -_.~ 保留，空格→+，其余 %XX 大写（注意 * → %2A，不能还原） */
function goEscape(s) {
  let out = '';
  for (const b of Buffer.from(String(s), 'utf8')) {
    const c = b;
    if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39)
        || c === 0x2d || c === 0x5f || c === 0x2e || c === 0x7e) out += String.fromCharCode(c);
    else if (c === 0x20) out += '+';
    else out += '%' + c.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

/** 随机 19 位设备 ID（1e18 + random%8e18，与 hongguo-dl 同款） */
function randomDeviceId() {
  return String(1000000000000000000n + (BigInt(Math.floor(Math.random() * 0x7fffffff)) % 8000000000000000000n));
}

/** 注册真设备（log.snssdk.com device_register）；失败返回 null（调用方回退随机） */
function registerDevice() {
  return new Promise(resolve => {
    const openudid = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0')
      + Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
    const clientudid = uuidUpper();
    const cdid = uuidUpper();
    const nowMs = Date.now();
    const header = {
      display_name: '红果免费短剧', aid: 8662, app_version: '7.3.5.32', version_code: 73532,
      manifest_version_code: 73532, update_version_code: 73532, channel: 'update_64', package: 'com.phoenix.read',
      app_language: 'zh', os: 'Android', os_version: '16', os_api: 36, device_model: '25053RT47C',
      device_brand: 'Redmi', device_manufacturer: 'Xiaomi', cpu_abi: 'arm64-v8a', density_dpi: 520,
      display_density: 'xxhdpi', resolution: '2772x1280', language: 'zh', timezone: 8, access: 'wifi',
      openudid, clientudid, cdid, region: 'CN', tz_name: 'Asia/Shanghai', tz_offset: 28800,
      sim_region: 'cn', device_platform: 'android', not_request_sender: 0, is_system_app: 0,
      sdk_flavor: 'china', rom: 'OS2.0', rom_version: 'BP2A.250605.031.A3',
    };
    const body = JSON.stringify({ magic_tag: 'ss_app_log', header, _gen_time: nowMs });
    const q = [];
    for (const k of Object.keys(FIXED_DEVICE)) {
      if (k === 'device_id' || k === 'iid') continue;
      q.push(`${k}=${goEscape(FIXED_DEVICE[k])}`);
    }
    q.push(`req_id=${uuidUpper()}`);
    q.push(`_rticket=${nowMs}`);
    q.sort();
    const req = https.request('https://log.snssdk.com/service/2/device_register/?' + q.join('&'), {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/json; charset=utf-8', 'Accept': 'application/json' },
      timeout: 20000,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const text = Buffer.concat(chunks).toString('utf8');
          const json = JSON.parse(text);
          const did = String(json.device_id_str || json.device_id || '');
          const iid = String(json.install_id_str || json.install_id || '');
          if (did && iid && did !== '0' && iid !== '0' && /^[0-9]{1,32}$/.test(did) && /^[0-9]{1,32}$/.test(iid)) {
            registeredDevice = { device_id: did, iid };
            console.log(`[hongguo-app] device_register 成功 device=${did} iid=${iid}`);
            return resolve(registeredDevice);
          }
        } catch { /* fallthrough */ }
        console.log('[hongguo-app] device_register 失败，回退随机设备');
        resolve(null);
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

function uuidUpper() {
  return 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'.replace(/x/g, () =>
    Math.floor(Math.random() * 16).toString(16).toUpperCase());
}

/** 当前设备参数（注册优先，失败回退随机）；同一对设备供 query 与 Argus 使用 */
function currentDevice() {
  if (registeredDevice) return registeredDevice;
  // 缓存随机对（避免 buildQuery 与 callSigner 各随机一次导致 device 不一致被风控）
  if (!currentDevice.pair) currentDevice.pair = { device_id: randomDeviceId(), iid: randomDeviceId() };
  return currentDevice.pair;
}

/** 生成签名头：内嵌 JS 签名（python 已验证算法 1:1，不依赖二进制） */
function callSigner(rawQuery, bodyStr, dev) {
  const stamp = Math.floor(Date.now() / 1000);
  const headers = hgSign.signPlayerRequest(rawQuery, bodyStr, stamp, dev.device_id);
  return Promise.resolve(headers);
}

/** 构造与 APK 一致的 query string（字典序 + Go QueryEscape） */
function buildQuery(dev) {
  const params = { ...FIXED_DEVICE, device_id: dev.device_id, iid: dev.iid, _rticket: String(Date.now()) };
  const q = Object.keys(params).sort().map(k => `${k}=${goEscape(params[k])}`);
  return q.join('&');
}

/** 签名 POST：JS 签名生成 headers，POST 到 fqnovel；空响应冷却重试 + 换设备（≤3 轮）；gzip 自动解压 */
async function signedPost(path, bodyObj) {
  if (!registeredDevice) {
    registeredDevice = await registerDevice();
    if (!registeredDevice) currentDevice();
  }
  const bodyStr = JSON.stringify(bodyObj);
  let rotations = 0;
  let attempts = 0;
  let lastErr = null;
  while (attempts < 3) {
    const dev = currentDevice();
    const rawQuery = buildQuery(dev);
    let signHeaders;
    try { signHeaders = await callSigner(rawQuery, bodyStr, dev); }
    catch (e) { lastErr = e; attempts++; if (attempts < 3) { await sleep(1500); continue; } throw e; }
    const url = `${BASE}${path}?${rawQuery}`;
    const headers = {
      ...signHeaders,
      'User-Agent': UA,
      'Accept-Encoding': 'gzip',
      'Accept': 'application/json',
      'Content-Type': 'application/json; charset=utf-8',
      'X-XS-From-Web': '0',
      'Sdk-Version': '2',
    };
    if (process.env.HG_DEBUG) console.log('[debug]', url, JSON.stringify(headers));
    const text = await new Promise((resolve, reject) => {
      const u = new URL(url);
      const mod = u.protocol === 'https:' ? https : require('http');
      const req = mod.request(u, { method: 'POST', headers, timeout: 20000 }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          let buf = Buffer.concat(chunks);
          if ((res.headers['content-encoding'] || '').includes('gzip')) {
            const zlib = require('zlib');
            try { buf = zlib.gunzipSync(buf); } catch (e) { /* 保留原样 */ }
          }
          resolve({ code: res.statusCode, text: buf.toString('utf8') });
        });
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('请求超时')));
      req.write(bodyStr);
      req.end();
    });
    if (text.code >= 400 && text.code < 500) throw new Error(`HTTP ${text.code}（4xx 直接失败）`);
    if (!text.text.trim() || text.code !== 200) {
      lastErr = new Error(`空响应/异常 HTTP ${text.code} len=${text.text.length}`);
      attempts++;
      if (attempts >= 2 && rotations < 3) {
        registeredDevice = null;
        currentDevice.pair = null;
        await registerDevice();
        if (!registeredDevice) currentDevice();
        rotations++;
        attempts = 0;
        await sleep(1200);
        continue;
      }
      if (attempts < 3) { await sleep(1800); continue; }
      throw lastErr;
    }
    try { return JSON.parse(text.text); }
    catch { throw new Error('响应解析失败: ' + text.text.slice(0, 200)); }
  }
  throw lastErr || new Error('请求失败');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** 详情：拿全集 vid 列表（与下载集序对齐：vids[i] = 第 i+1 集）。 */
async function videoDetail(seriesId) {
  const json = await signedPost('/novel/player/video_detail/v1/', { series_id: String(seriesId) });
  const vd = (json.data || {}).video_data || {};
  const list = vd.video_list || [];
  if (!Array.isArray(list) || list.length === 0) throw new Error('红果详情未返回分集列表');
  const vids = list.map(v => (v && v.vid != null ? String(v.vid) : '')).filter(v => v);
  if (vids.length === 0) throw new Error('红果详情分集 vid 为空');
  return { vids, title: vd.series_title || '' };
}

/** 单集取流：签名调用 video_model/v1，选最高清晰度档（对齐 python 参照，无上限）。 */
async function videoModel(vid) {
  const json = await signedPost('/novel/player/video_model/v1/', {
    video_id: String(vid),
    content_type: 1,
    biz_param: { need_all_video_definition: true, video_platform: 3 },
  });
  const vmStr = (json.data || {}).video_model;
  if (!vmStr) throw new Error('无 video_model 字段');
  let vm;
  if (typeof vmStr === 'object') vm = vmStr;
  else if (typeof vmStr === 'string') {
    const t = String(vmStr).trim();
    try { vm = JSON.parse(t); }
    catch {
      try { vm = JSON.parse(Buffer.from(t, 'base64').toString('utf8')); }
      catch { throw new Error('video_model 解析失败'); }
    }
  } else vm = {};
  const variants = vm.video_list || [];
  if (!variants.length) throw new Error('video_list 为空');
  const collectUrls = o => {
    const out = [], seen = new Set();
    const add = value => {
      if (typeof value !== 'string') return;
      let a = String(value).trim();
      if (!/^https?:\/\//i.test(a)) {
        try { const d = Buffer.from(a, 'base64').toString('utf8').trim(); if (/^https?:\/\//i.test(d)) a = d; } catch { /* 非 base64 */ }
      }
      if (/^https?:\/\//i.test(a) && !seen.has(a)) { seen.add(a); out.push(a); }
    };
    for (const k of ['main_url', 'backup_url', 'backup_url_1', 'backup_url_2', 'backup_urls', 'url_list']) {
      const val = o[k];
      if (Array.isArray(val)) val.forEach(add); else add(val);
    }
    return out;
  };
  const rows = variants
    .map(o => ({ urls: collectUrls(o), meta: o.video_meta || {}, o }))
    .map(r => {
      const meta = r.meta;
      const h = parseInt(meta.vheight || 0, 10);
      const w = parseInt(meta.vwidth || 0, 10);
      let q = h > 0 ? h * 10 : (w > 0 ? w * 10 : qualityNumber(meta.definition || ''));
      const codec = String(meta.codec_type || '').toLowerCase();
      if (codec === 'h264' || codec === 'avc1') q += 1;
      return { ...r, q };
    })
    .filter(r => r.urls.length > 0
      && !/bytevc2|bvc2/i.test(String(r.meta.codec_type || ''))
      && !/bytevc2/i.test(String(r.o.gear_des_key || '')))
    .sort((a, b) => b.q - a.q);
  if (rows.length === 0) throw new Error('没有可用清晰度');
  // 对齐 python 参照实现：直接取最高分档（分数=height*10，h264 +1）
  const selected = rows[0];
  let key = '';
  const spade = selected.o.encrypt_info && selected.o.encrypt_info.spade_a;
  const encrypted = (selected.o.encrypt_info && selected.o.encrypt_info.encrypt) === true
    || String((selected.o.encrypt_info && selected.o.encrypt_info.encryption_method) || '').toLowerCase() === 'cenc-aes-ctr';
  if (spade && String(spade).length > 0) key = deriveKey(String(spade));
  else if (encrypted && !key) throw new Error('加密流缺少 spade_a');
  return { url: selected.urls[0], altUrls: selected.urls.slice(1), key, quality: selected.q > 0 ? `${Math.round(selected.q / 10)}P` : '自动' };
}

/** spade_a → CENC 解密密钥（guoapp hongguoContentKey 新算法；失败兜底旧 MediaCrypto 算法）。 */
function deriveKey(value) {
  try {
    const s = String(value).trim();
    if (!s || s.length > 1024) throw new Error('spade_a 非法');
    const raw = Buffer.from(s, 'base64');
    if (raw.length < 3) throw new Error('spade_a 过短');
    const tagLength = (raw[0] ^ raw[1] ^ raw[2]) - 48;
    const contentLength = raw.length - tagLength - 1;
    if (tagLength < 1 || contentLength < 33 || contentLength >= raw.length) {
      throw new Error('spade_a 结构不匹配，走旧算法');
    }
    const seed = raw[raw.length - tagLength - 2] ^ raw[raw.length - tagLength - 1];
    const tagBytes = Buffer.alloc(tagLength);
    for (let i = 0; i < tagLength; i++) tagBytes[i] = raw[raw.length - tagLength + i] ^ seed;
    const tagStr = tagBytes.toString('utf8');
    if (tagStr === 'app_v2' || tagStr === 'web_v2') throw new Error('不支持的 spade_a 新格式');
    const decoded = Buffer.alloc(contentLength);
    let prevEven = 250, prevOdd = 85;
    for (let idx = 0; idx < contentLength; idx++) {
      const cur = raw[1 + idx];
      const prev = (idx & 1) === 0 ? prevEven : prevOdd;
      if ((idx & 1) === 0) prevEven = cur; else prevOdd = cur;
      decoded[idx] = ((prev ^ cur) - 21 - popcount(idx)) & 0xff;
    }
    const c0 = decoded[0];
    const padding = c0 >= 0x30 && c0 <= 0x39 ? c0 - 0x30 : c0 >= 0x61 && c0 <= 0x7a ? c0 - 0x61 + 10 : null;
    if (padding === null) throw new Error('spade_a padding 非法');
    if (contentLength - padding - 1 !== 32) throw new Error('spade_a key 长度异常');
    const hexKey = decoded.toString('ascii', 1, 33);
    const key = Buffer.from(hexKey, 'hex');
    if (key.length !== 16) throw new Error('spade_a key 解码异常');
    return key.toString('hex');
  } catch (e) {
    // 旧算法兜底（MediaCrypto.deriveKey 1:1）
    const raw = Buffer.from(String(value), 'base64');
    if (raw.length < 3) throw new Error('内容密钥格式异常');
    const length = Math.min(raw.length - ((raw[0] ^ raw[1] ^ raw[2]) & 0xff) + 47, raw.length - 1);
    if (length < 33) throw new Error('内容密钥长度异常');
    const work = Buffer.from(raw.subarray(1, 1 + length));
    let a = 85, b = 246;
    for (let i = 0; i < work.length; i++) {
      const old = work[i] & 0xff;
      const previous = (i & 1) !== 0 ? a : b;
      if ((i & 1) !== 0) a = old; else b = old;
      const bitCount = popcount(i);
      work[i] = (-21 - bitCount + (previous ^ old)) & 0xff;
    }
    const key = Buffer.from(work.subarray(1, 33).toString('ascii'), 'hex');
    if (key.length !== 16) throw new Error('内容密钥长度异常');
    return key.toString('hex');
  }
}

function popcount(n) {
  let c = 0;
  while (n) { n &= n - 1; c++; }
  return c;
}

// ===== NAS 自主系列解析（手机端只推 seriesId/title/集数，不再解析 URL）=====

const MIRROR_ORIGINS = [
  'https://huangguoai.io',
  'https://0624.gitiecgad.cc',
  'https://thu.pqhybuxo.cc',
];

function httpGet(url, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? require('https') : require('http');
    const req = mod.get(u, { headers: Object.assign({ 'User-Agent': 'Mozilla/5.0' }, headers || {}) }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(httpGet(res.headers.location, headers));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('请求超时')));
  });
}

/** 从 hongguoduanju.com 搜索结果匹配红果 series_id（无需红果签名；标题一致或包含且集数满足）。 */
async function searchSeries(title, expectEpisodes) {
  const q = encodeURIComponent(String(title || '').trim());
  if (!q) throw new Error('剧名缺失');
  const { body } = await httpGet('https://hongguoduanju.com/search/' + q);
  const start = body.indexOf('_ROUTER_DATA = ');
  if (start < 0) throw new Error('搜索页结构异常');
  const jsonStart = body.indexOf('{', start);
  if (jsonStart < 0) throw new Error('搜索页数据缺失');
  let depth = 0, inStr = false, esc = false, jsonEnd = -1;
  for (let i = jsonStart; i < body.length; i++) {
    const ch = body[i];
    if (esc) { esc = false; continue; }
    if (inStr) {
      if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { jsonEnd = i + 1; break; } }
  }
  if (jsonEnd < 0) throw new Error('搜索页数据不完整');
  const data = JSON.parse(body.slice(jsonStart, jsonEnd));
  const ld = data.loaderData || {};
  const norm = s => String(s || '').replace(/\s+/g, '').toLowerCase();
  const titleNorm = norm(title);
  const want = Number(expectEpisodes) || 0;
  let best = null;
  for (const key of Object.keys(ld)) {
    const section = ld[key];
    if (!section || !Array.isArray(section.searchList)) continue;
    for (const row of section.searchList) {
      const vd = (row && row.video_data) || {};
      const sid = String(vd.series_id || '');
      if (!/^[0-9]{1,30}$/.test(sid)) continue;
      const st = norm(vd.series_title || '');
      const eps = parseInt(String(vd.episode_right_text || '').replace(/[^0-9]/g, ''), 10) || 0;
      if (st === titleNorm) return sid;
      if (!best && st && (st.includes(titleNorm) || titleNorm.includes(st)) && (!want || eps >= want)) best = sid;
    }
  }
  if (best) return best;
  throw new Error('未匹配到对应红果剧集');
}

/** 网页源保底：镜像站播放页 #videoInitialData → videoSrc（网页源直链）。返回 { url, referer }，referer 供下载时防盗链校验。 */
async function fetchWebUrl(id, episode) {
  for (const origin of MIRROR_ORIGINS) {
    try {
      const path = episode === 1 ? `/video/${id}/` : `/video/${id}/ep-${episode}/`;
      const { status, body } = await httpGet(origin + path, { Referer: origin + '/' });
      if (status !== 200) continue;
      const m = body.match(/<script[^>]*id="videoInitialData"[^>]*>([\s\S]*?)<\/script>/);
      if (!m) continue;
      const data = JSON.parse(m[1]);
      let src = data.videoSrc;
      // 2026-11 改版：详情页不再塞播放地址，改由 /api/videos/:id/play 单独下发
      if (!(typeof src === 'string' && /^https?:\/\//.test(src))) {
        const api = await httpGet(`${origin}/api/videos/${id}/play?ep=${episode}`, { Referer: `${origin}/video/${id}/` });
        if (api.status === 200) {
          try { src = JSON.parse(api.body).data.video_url || ''; } catch { src = ''; }
        }
      }
      if (typeof src === 'string' && /^https?:\/\//.test(src)) return { url: src, referer: origin };
    } catch { /* 换下一个 origin */ }
  }
  throw new Error('网页源播放地址获取失败');
}

module.exports = { videoDetail, videoModel, deriveKey, searchSeries, fetchWebUrl, registerDevice, currentDevice, buildQuery, goEscape, signedPost };
