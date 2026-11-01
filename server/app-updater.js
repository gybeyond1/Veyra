'use strict';
/**
 * 更新包缓存（后端自拉版）
 *
 * 背景：客户端直连 GitHub Releases 在国内经常几十 KB/s 甚至不通。后端上行够用，
 * 于是让后端在后台把本仓库的 APK 拉一份到本地，客户端只从后端下载。
 *
 * 关键点：拉包发生在【后台】，慢没关系 —— 用户点「立即更新」时文件已经在盘上了。
 *
 * 拉取策略（每一步失败都换下一个源）：
 *   1. 版本号：releases.atom（几百字节，比 api.github.com 稳，还不吃限流）
 *      失败再试 api.github.com/repos/<repo>/releases/latest
 *   2. 包体：直连 + 若干公共反代，按顺序试；单个源 10 秒内跑不到 300KB/s 就换下一个
 *      （`--speed-limit` / `--speed-time`，比设死超时好：慢源早点放弃，快源不打断）
 *   3. 下载支持断点续传：换源后从 .part 续，不用从头再下 10MB
 *   4. 落盘前校验大小 + sha256（GitHub API 给了 digest 就用它的）
 *
 * 落盘结构：
 *   <dataDir>/app-update/latest.json
 *   <dataDir>/app-update/<channel>/Veyra-x.y.z.apk
 *
 * latest.json:
 *   { "version": "0.24.6", "tag": "v0.24.6", "notes": "...", "fetchedAt": 1699999999999,
 *     "channels": { "mobile": { "file": "Veyra-0.24.6.apk", "size": 10767011, "sha256": "..." },
 *                   "tv":     { "file": "Veyra-TV-0.24.6.apk", ... } } }
 *
 * 手动兜底：后端拉不动时，把 APK 直接丢进 <dataDir>/app-update/<channel>/ 也能被识别
 * （每轮扫描目录，文件名带版本号即可）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const REPO = process.env.APP_UPDATE_REPO || 'gybeyond1/Veyra';
const POLL_MS = parseInt(process.env.APP_UPDATE_POLL_MS || String(10 * 60 * 1000), 10);
const FIRST_DELAY_MS = parseInt(process.env.APP_UPDATE_FIRST_DELAY_MS || '20000', 10);
const MAX_BYTES = 120 * 1024 * 1024;
const KEEP_VERSIONS = 2;
const UA = 'Veyra-Backend-Updater/1.0';

/** 下载源前缀：空串 = 直连。可用 APP_UPDATE_MIRRORS 覆盖（逗号分隔）。 */
const DEFAULT_MIRRORS = [
  '',
  'https://gh-proxy.com/',
  'https://ghfast.top/',
  'https://github.moeyy.xyz/',
];

/** 只有这两个渠道的包会被缓存和分发。 */
const CHANNELS = ['mobile', 'tv'];

function mirrors() {
  const raw = process.env.APP_UPDATE_MIRRORS;
  if (!raw) return DEFAULT_MIRRORS;
  const list = raw.split(',').map(s => s.trim()).filter(s => s !== '');
  // 允许用 "direct" 占位表示直连
  return list.map(s => (s === 'direct' ? '' : s));
}

function versionOf(tag) {
  return String(tag || '').trim().replace(/^[vV]/, '');
}

function compareVersion(a, b) {
  const pa = String(a || '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b || '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/** 渠道 → 附件名。约定优于配置：发布流水线一直用这两个名字。 */
function fileName(channel, version) {
  return channel === 'tv' ? `Veyra-TV-${version}.apk` : `Veyra-${version}.apk`;
}

function curl(args, timeoutMs) {
  return new Promise((resolve) => {
    execFile('curl', args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => resolve({ error, stdout, stderr }));
  });
}

/** 抓一小段文本（atom / api json）。源失败自动换下一个。 */
async function fetchText(url, proxy, timeoutMs) {
  const sources = mirrors();
  let lastError = 'no source';
  for (const prefix of sources) {
    const target = prefix + url;
    const args = ['-sS', '-L', '--fail', '--max-time', String(Math.round(timeoutMs / 1000)),
      '-A', UA, '-H', 'Accept: application/atom+xml, application/json'];
    if (proxy) args.push('-x', proxy);
    args.push(target);
    const result = await curl(args, timeoutMs);
    if (!result.error && result.stdout) return result.stdout;
    lastError = result.error ? String(result.error.message || result.error) : 'empty body';
  }
  throw new Error(lastError);
}

/** 从 atom 里拿最新版本；不依赖 api.github.com（国内经常连不上，且有限流）。 */
function parseAtom(xml) {
  const entries = xml.split('<entry>').slice(1);
  if (!entries.length) return null;
  const first = entries[0];
  const title = (first.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1] || '';
  const content = (first.match(/<content[^>]*>([\s\S]*?)<\/content>/) || [])[1] || '';
  const tag = title.trim();
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) return null;
  return { tag, version: versionOf(tag), notes: htmlToText(decodeEntities(content)) };
}

function decodeEntities(text) {
  return String(text)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function htmlToText(html) {
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|h\d|div)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .split('\n').map(line => line.trim()).filter(Boolean).join('\n')
    .slice(0, 1200);
}

async function sha256OfFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * 单个源下载。返回 { ok, reason }。
 * -C - ：有 .part 就续传
 * --speed-limit/--speed-time：10 秒内平均不到 300KB/s 直接掐掉，换下一个源
 */
async function downloadFrom(prefix, url, partFile, proxy) {
  const args = ['-sS', '-L', '--fail', '--connect-timeout', '15',
    '--speed-limit', '307200', '--speed-time', '10', '--max-time', '900',
    '-A', UA, '-o', partFile, '-C', '-'];
  if (proxy) args.push('-x', proxy);
  args.push(prefix + url);
  const result = await curl(args, 960000);
  if (result.error) {
    // 28 = 超时/低速被掐；33 = 服务端不支持 Range 续传
    const code = result.error.code;
    return { ok: false, reason: code === 28 ? 'too-slow' : (code === 33 ? 'resume-unsupported' : String(code || 'failed')) };
  }
  return { ok: true };
}

function createAppUpdater(options) {
  const dataDir = options.dataDir;
  const getProxy = options.getProxy || (() => '');
  const log = options.log || (() => { });
  const root = path.join(dataDir, 'app-update');
  const manifestFile = path.join(root, 'latest.json');

  let manifest = null;
  let timer = null;
  let polling = false;

  fs.mkdirSync(root, { recursive: true });
  for (const channel of CHANNELS) fs.mkdirSync(path.join(root, channel), { recursive: true });

  loadManifest();

  function loadManifest() {
    try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); }
    catch { manifest = null; }
    return manifest;
  }

  function saveManifest() {
    const tmp = manifestFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2));
    fs.renameSync(tmp, manifestFile);
  }

  function channelDir(channel) { return path.join(root, channel); }

  /** 本地已有的包（按文件名里的版本号），用于「后端没拉到但用户手动丢进来」的场景。 */
  function localVersions(channel) {
    const found = [];
    let names = [];
    try { names = fs.readdirSync(channelDir(channel)); } catch { return found; }
    for (const name of names) {
      const m = name.match(/^Veyra(?:-TV)?-(\d+\.\d+\.\d+)\.apk$/);
      if (!m) continue;
      if (name !== fileName(channel, m[1])) continue;
      const stat = fs.statSync(path.join(channelDir(channel), name));
      if (stat.size > 0) found.push({ version: m[1], file: name, size: stat.size });
    }
    return found.sort((a, b) => compareVersion(b.version, a.version));
  }

  async function discover() {
    const proxy = getProxy() || '';
    // 首选 atom：体积小、不吃 API 限流、反代也更容易代理
    try {
      const xml = await fetchText(`https://github.com/${REPO}/releases.atom`, proxy, 20000);
      const info = parseAtom(xml);
      if (info) return info;
    } catch (error) {
      log(`[update] atom 拉取失败：${error.message}`);
    }
    // 兜底走 API
    const json = await fetchText(`https://api.github.com/repos/${REPO}/releases/latest`, proxy, 20000);
    const release = JSON.parse(json);
    const tag = String(release.tag_name || '').trim();
    if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error('release tag 格式异常');
    return { tag, version: versionOf(tag), notes: htmlToText(release.body || ''), assets: release.assets || [] };
  }

  async function fetchChannel(channel, version, tag, assets) {
    const dir = channelDir(channel);
    const name = fileName(channel, version);
    const apk = path.join(dir, name);
    if (fs.existsSync(apk) && fs.statSync(apk).size > 0) {
      return { file: name, size: fs.statSync(apk).size, sha256: await sha256OfFile(apk) };
    }

    // 附件名以 API 为准（万一某次发布改了名）；API 没给就按约定拼
    let assetName = name;
    if (Array.isArray(assets) && assets.length) {
      const hit = assets.find(a => a && typeof a.name === 'string' && a.name.endsWith('.apk')
        && /(^|[-_.])tv([-_.]|$)/i.test(a.name) === (channel === 'tv'));
      if (hit) assetName = hit.name;
    }
    const url = `https://github.com/${REPO}/releases/download/${tag}/${encodeURIComponent(assetName)}`;
    const part = path.join(dir, name + '.part');
    const proxy = getProxy() || '';

    for (const prefix of mirrors()) {
      const result = await downloadFrom(prefix, url, part, proxy);
      if (result.ok) {
        const size = fs.existsSync(part) ? fs.statSync(part).size : 0;
        if (size <= 0) { fs.rmSync(part, { force: true }); continue; }
        if (size > MAX_BYTES) {
          fs.rmSync(part, { force: true });
          throw new Error(`更新包过大：${size} 字节`);
        }
        fs.rmSync(apk, { force: true });
        fs.renameSync(part, apk);
        log(`[update] 已缓存 ${channel} ${version}（${Math.round(size / 1048576)}MB，源 ${prefix || '直连'}）`);
        return { file: name, size, sha256: await sha256OfFile(apk) };
      }
      if (result.reason === 'resume-unsupported') fs.rmSync(part, { force: true });
      log(`[update] ${channel} 源 ${prefix || '直连'} 不可用：${result.reason}`);
    }
    throw new Error(`所有下载源都失败（${channel} ${version}）`);
  }

  /** 清理旧版本：每渠道只留最近 KEEP_VERSIONS 个，.part 超过一天也清掉。 */
  function prune() {
    for (const channel of CHANNELS) {
      const dir = channelDir(channel);
      let names = [];
      try { names = fs.readdirSync(dir); } catch { continue; }
      const apks = names.filter(n => /\.apk$/.test(n))
        .map(n => ({ n, v: (n.match(/(\d+\.\d+\.\d+)\.apk$/) || [])[1] || '0.0.0' }))
        .sort((a, b) => compareVersion(b.v, a.v));
      for (const stale of apks.slice(KEEP_VERSIONS)) {
        try { fs.rmSync(path.join(dir, stale.n), { force: true }); } catch { /* ignore */ }
      }
      for (const name of names.filter(n => n.endsWith('.part'))) {
        const file = path.join(dir, name);
        try {
          if (Date.now() - fs.statSync(file).mtimeMs > 24 * 3600 * 1000) fs.rmSync(file, { force: true });
        } catch { /* ignore */ }
      }
    }
  }

  async function poll() {
    if (polling) return;
    polling = true;
    try {
      const info = await discover();
      const previous = manifest && manifest.version;
      if (!manifest || !manifest.version || compareVersion(info.version, manifest.version) > 0) {
        manifest = { version: info.version, tag: info.tag, notes: info.notes || '', fetchedAt: Date.now(), channels: {} };
      } else {
        manifest.notes = info.notes || manifest.notes || '';
        manifest.tag = info.tag;
      }
      for (const channel of CHANNELS) {
        // 已经在盘上（含手动投递）就不重复下
        const local = localVersions(channel)[0];
        if (local && compareVersion(local.version, info.version) === 0) {
          manifest.channels[channel] = {
            file: local.file, size: local.size,
            sha256: await sha256OfFile(path.join(channelDir(channel), local.file)),
          };
          continue;
        }
        try {
          manifest.channels[channel] = await fetchChannel(channel, info.version, info.tag, info.assets);
        } catch (error) {
          log(`[update] ${channel} 拉取失败：${error.message}`);
          // 保留上一版记录，清掉不属于当前版本的条目
          if (manifest.channels[channel] && manifest.channels[channel].file.indexOf(info.version) < 0) {
            delete manifest.channels[channel];
          }
        }
      }
      manifest.fetchedAt = Date.now();
      saveManifest();
      prune();
      if (previous !== manifest.version) log(`[update] 当前最新版本 ${manifest.version}`);
    } catch (error) {
      log(`[update] 检查失败：${error.message}`);
    } finally {
      polling = false;
    }
  }

  function status(channel, currentVersion) {
    const dir = channelDir(channel);
    // 优先内存里的清单；进程刚起重启时从文件读
    const data = manifest || loadManifest();
    const current = versionOf(currentVersion);

    if (!data || !data.version) {
      // 还没有清单：看看目录里有没有手动丢进来的包
      const local = localVersions(channel)[0];
      if (local && compareVersion(local.version, current) > 0) {
        return {
          status: 'available', version: local.version, size: local.size, sha256: '',
          url: `/api/app-download/${channel}/${encodeURIComponent(local.file)}`,
          notes: '', source: 'server',
        };
      }
      // 目录里有包但不比本机新：明确回「已是最新」，别让客户端以为后端没上班
      if (local && current) return { status: 'current', version: current };
      return { status: 'none' };
    }

    if (current && compareVersion(data.version, current) <= 0) {
      return { status: 'current', version: current };
    }

    const entry = data.channels && data.channels[channel];
    if (entry && entry.file) {
      const file = path.join(dir, entry.file);
      if (fs.existsSync(file)) {
        return {
          status: 'available', version: data.version, size: entry.size || fs.statSync(file).size,
          sha256: entry.sha256 || '',
          url: `/api/app-download/${channel}/${encodeURIComponent(entry.file)}`,
          notes: data.notes || '', source: 'server',
        };
      }
    }
    // 知道有新版本但还没拉到包：客户端据此回退 GitHub，界面不用等
    return { status: 'preparing', version: data.version };
  }

  /** 下载路由用：只允许清单里登记过的文件，挡住路径穿越。 */
  function fileOf(channel, name) {
    if (CHANNELS.indexOf(channel) < 0) return null;
    if (!/^Veyra(?:-TV)?-\d+\.\d+\.\d+\.apk$/.test(name)) return null;
    const file = path.join(channelDir(channel), name);
    if (!file.startsWith(channelDir(channel) + path.sep)) return null;
    return fs.existsSync(file) ? file : null;
  }

  function start() {
    if (timer) return;
    setTimeout(() => { poll(); }, FIRST_DELAY_MS).unref();
    timer = setInterval(() => { poll(); }, POLL_MS);
    if (timer.unref) timer.unref();
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  return { start, stop, poll, status, fileOf, get manifest() { return manifest || loadManifest(); } };
}

module.exports = { createAppUpdater, compareVersion, fileName, parseAtom };
