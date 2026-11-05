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
 *   2. 包体：先探测大小与 Range 支持，然后**切 6 段并发**，每段独立 .part，
 *      每段每轮换一个源（直连 / 多个公共反代），断在哪续在哪。公共反代经常
 *      「一条连接下 4MB 就掐」，分段后每段不到 2MB，一次就能过。
 *   3. 源不支持 Range 就退化成单流，多轮续传
 *   4. 每轮统计进度，有推进就继续；全失败也不等 10 分钟，1 分钟后重试
 *   5. 落盘前校验大小 + sha256（GitHub API 给了 digest 就用它的）
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
/** 有渠道没拉到时，隔多久再试（比 POLL_MS 短得多：半截包留着，早一轮就早一点下完）。 */
const RETRY_MS = parseInt(process.env.APP_UPDATE_RETRY_MS || '60000', 10);
/**
 * Webhook 快车道：GitHub 一说「发版了」就按这个间隔连打几轮。
 * 正常一轮 10 分钟太久了 —— 而且 release 刚创建时资产往往还在传，第一枪常常扑空，
 * 所以这里必须是秒级重试，打在「资产上传完」的那一刻。
 */
const WAKE_RETRY_MS = parseInt(process.env.APP_UPDATE_WAKE_RETRY_MS || '5000', 10);
const WAKE_ROUNDS = parseInt(process.env.APP_UPDATE_WAKE_ROUNDS || '24', 10);
/** 被唤醒后这段时间内按 tag 精确查 API（atom 有 CDN 缓存，可能还看不到新版本）。 */
const WAKE_API_WINDOW_MS = 120_000;
const MAX_BYTES = 200 * 1024 * 1024;
/**
 * 每个渠道在盘上保留几个版本，默认 1：只留最新的。
 * 检查更新拿到的永远是清单里的最新版，旧包没有任何分发路径，留着只占地方。
 * （早期留 2 是担心有人正在下旧包，实际客户端下载 10MB 只要几十秒，撞上的概率极低，
 *   真撞上它会自动回退 GitHub 重下。）
 */
const KEEP_VERSIONS = Math.max(1, parseInt(process.env.APP_UPDATE_KEEP_VERSIONS || '1', 10) || 1);
/** 分几段并发下。8 段在丢包链路上提升明显，再多容易把家宽连接数打满。 */
const CHUNK_COUNT = 6;
/** 单轮 poll 里最多重试几轮（每轮每段换一个源）。 */
const MAX_ROUNDS = 8;
const UA = 'Veyra-Backend-Updater/1.0';

/** 下载源前缀：空串 = 直连。可用 APP_UPDATE_MIRRORS 覆盖（逗号分隔）。 */
const DEFAULT_MIRRORS = [
  '',
  'https://gh-proxy.com/',
  'https://ghfast.top/',
  'https://github.moeyy.xyz/',
];

/** 只有这两个渠道的包会被缓存和分发。 */
const CHANNELS = ['mobile', 'tv', 'desktop'];
/** 发版必须齐的渠道：桌面端安装包可以后补，不能因此让手机/电视的更新卡住。 */
const REQUIRED_CHANNELS = ['mobile', 'tv'];

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
  if (channel === 'tv') return `Veyra-TV-${version}.apk`;
  if (channel === 'desktop') return `Veyra-Desktop-${version}.exe`;
  return `Veyra-${version}.apk`;
}

/** 资产名是否属于这个渠道：电视/手机都是 apk，桌面端是 electron-builder 产出的 exe。 */
function matchesChannel(channel, name) {
  const value = String(name || '');
  if (channel === 'desktop') return /\.exe$/i.test(value) && /desktop/i.test(value);
  if (!value.endsWith('.apk')) return false;
  return /(^|[-_.])tv([-_.]|$)/i.test(value) === (channel === 'tv');
}

/** 手机/电视两个包是不是都已经传上去了（桌面端缺包不算残缺）。 */
function hasApks(assets, version) {
  if (!Array.isArray(assets) || !assets.length || !version) return false;
  const names = new Set(assets.map(a => (a && a.name) || ''));
  return REQUIRED_CHANNELS.every(channel => names.has(fileName(channel, version)));
}

/** release 里有没有这个渠道的包；没有就跳过，免得每 10 分钟白重试一次。 */
function hasAsset(assets, channel) {
  return Array.isArray(assets) && assets.some(a => a && matchesChannel(channel, a.name));
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
  // atom 的 entry title 是「Veyra v0.27.8」，不是纯 tag —— 以前直接拿 title 去匹配
  // ^v\d+\.\d+\.\d+$，永远不成立，每轮都退回 api.github.com 兜底；匿名 API 每 IP
  // 每小时只有 60 次，被限流后清单就再也不动了（表现为客户端永远「已是最新」）。
  // 这里从 title / id（.../Repository/123/v0.27.8）里抽出 vX.Y.Z。
  const id = (first.match(/<id>([\s\S]*?)<\/id>/) || [])[1] || '';
  const hit = (title + ' ' + id).match(/v(\d+\.\d+\.\d+)/);
  if (!hit) return null;
  const tag = 'v' + hit[1];
  return { tag, version: hit[1], notes: htmlToText(decodeEntities(content)) };
}

function decodeEntities(text) {
  return String(text)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function htmlToText(html) {
  const text = String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|h\d|div)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .split('\n').map(line => line.trim()).filter(Boolean);
  // GitHub 用 --generate-notes 生成的 release 会把历史 commit 全列上（几十行），
  // 整坨塞进手机弹窗没人看。只留开头几行：真正想说的那两句都在最前面。
  const head = text.slice(0, 4).join('\n');
  return head.length > 240 ? head.slice(0, 240) + '…' : head;
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
 * 探测远端大小、以及是否支持 Range。
 * 用 `-r 0-0` 发一个只要 1 字节的请求：拿得到 206 + Content-Range 才算支持分段，
 * 只回 200 + Content-Length 的源（不少公共反代就这样）只能整包下。
 *
 * opts.limit / opts.offset：快车道用。资产还没传完时一轮要探 4 个源，
 * 每个源光等超时就十几秒，5 秒的节奏会被拖成 40 秒。所以快车道只探 2 个源，
 * 并且每轮从不同的源起头，轮着把 4 个源都试到。
 */
async function probeRemote(url, proxy, opts) {
  const all = mirrors();
  const limit = opts && opts.limit ? Math.min(opts.limit, all.length) : all.length;
  const offset = (opts && opts.offset) || 0;
  const list = [];
  for (let i = 0; i < limit; i++) list.push(all[(offset + i) % all.length]);
  const maxTime = limit < all.length ? '12' : '40';
  for (const prefix of list) {
    const args = ['-sS', '-L', '--connect-timeout', '8', '--max-time', maxTime,
      '-r', '0-0', '-D', '-', '-o', '/dev/null', '-A', UA];
    if (proxy) args.push('-x', proxy);
    args.push(prefix + url);
    const result = await curl(args, 45_000);
    if (result.error) continue;
    const header = String(result.stdout || '');
    // 先看最终状态码：资产还没传上来时 GitHub 会给 404，
    // 那是张错误页而不是 APK，但它的 Content-Length 照样能被解析成「包大小」，
    // 于是后面的分片下载会把错误页拼成一个 40 字节的假包。
    let status = 0, st;
    const statusRe = /HTTP\/[\d.]+\s+(\d{3})/g;
    while ((st = statusRe.exec(header))) status = Number(st[1]);
    if (status !== 200 && status !== 206) continue;
    // 可能经过多次跳转，头有好几段，取最后出现的那个
    let m, last = null;
    const re = /content-range:\s*bytes\s+0-0\/(\d+)/gi;
    while ((m = re.exec(header))) last = m;
    if (last) return { size: Number(last[1]), range: true, prefix };
    let n, len = null;
    const re2 = /content-length:\s*(\d+)/gi;
    while ((n = re2.exec(header))) len = n;
    if (len) return { size: Number(len[1]), range: false, prefix };
  }
  return null;
}

/**
 * 下载 [start, end] 这一段。outFile 里已有的字节视为有效，从断点续。
 * 返回 true 表示这一段已经完整。
 *
 * 为什么每段自己一个文件：以前所有源共用一个 .part，A 源下了 4MB 断流、
 * B 源不支持 Range，两边互相踩，永远凑不齐一整份。
 */
async function fetchRange(url, prefix, start, end, outFile, proxy) {
  const need = end - start + 1;
  let have = fs.existsSync(outFile) ? fs.statSync(outFile).size : 0;
  if (have >= need) return true;
  if (have > need) { fs.rmSync(outFile, { force: true }); have = 0; }

  const tmp = outFile + '.tmp';
  fs.rmSync(tmp, { force: true });
  const args = ['-sS', '-L', '--fail', '--connect-timeout', '15',
    // 分片后单连接速率本来就低，阈值压到 20KB/s，30 秒都不动才掐
    '--speed-limit', '20480', '--speed-time', '30', '--max-time', '600',
    '-r', `${start + have}-${end}`, '-o', tmp, '-A', UA];
  if (proxy) args.push('-x', proxy);
  args.push(prefix + url);
  const result = await curl(args, 660_000);

  let got = 0;
  try {
    if (fs.existsSync(tmp)) {
      got = fs.statSync(tmp).size;
      // 源忽略 Range 会回整包，长度远大于本段 —— 这种数据拼进去就是废包
      if (got > 0 && have + got <= need) {
        fs.appendFileSync(outFile, fs.readFileSync(tmp));
        have += got;
      }
    }
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  if (result.error && got === 0) {
    const code = result.error.code;
    if (code === 33) return false; // 不支持 Range
  }
  return have >= need;
}

/** 按顺序拼接分段。整包 10MB 级别，读进内存比流式拼接稳妥。 */
function assemble(files, target) {
  const tmp = target + '.assembling';
  const fd = fs.openSync(tmp, 'w');
  try {
    for (const file of files) {
      if (!fs.existsSync(file)) throw new Error('分段缺失：' + path.basename(file));
      fs.writeSync(fd, fs.readFileSync(file));
    }
  } finally {
    fs.closeSync(fd);
  }
  fs.rmSync(target, { force: true });
  fs.renameSync(tmp, target);
}

/** 单流下载（源不支持 Range 时用），多轮续传。 */
async function downloadWhole(url, partFile, proxy, round) {
  const sources = mirrors();
  const prefix = sources[round % sources.length];
  const args = ['-sS', '-L', '--fail', '--connect-timeout', '15',
    '--speed-limit', '30720', '--speed-time', '30', '--max-time', '600',
    '-A', UA, '-o', partFile, '-C', '-'];
  if (proxy) args.push('-x', proxy);
  args.push(prefix + url);
  const result = await curl(args, 660_000);
  return { ok: !result.error, source: prefix || '直连' };
}

function createAppUpdater(options) {
  const dataDir = options.dataDir;
  const getProxy = options.getProxy || (() => '');
  const log = options.log || (() => { });
  // 单测用：wake 只记账、不真的联网
  const autoPoll = options.autoPoll !== false;
  const root = path.join(dataDir, 'app-update');
  const manifestFile = path.join(root, 'latest.json');

  let manifest = null;
  let timer = null;
  let retryTimer = null;
  let polling = false;
  /**
   * Webhook 送来的「要拉哪一版」。
   * 有它的时候 poll 走快车道：不查 atom、秒级重试，直到两个渠道都落地才清掉。
   */
  let wakeHint = null;
  let wakeRound = 0;
  /** 正在下载的进度，给 /api/health 看，方便判断到底卡在哪一段。 */
  let progressState = null;
  /** 手动触发时优先下哪个渠道：手机上点就先手机包，电视上点就先电视包。 */
  let focusChannel = null;
  let pollPromise = null;

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
      const m = name.match(/^Veyra(?:-TV|-Desktop)?-(\d+\.\d+\.\d+)\.(?:apk|exe)$/);
      if (!m) continue;
      if (name !== fileName(channel, m[1])) continue;
      const stat = fs.statSync(path.join(channelDir(channel), name));
      if (stat.size > 0) found.push({ version: m[1], file: name, size: stat.size });
    }
    return found.sort((a, b) => compareVersion(b.version, a.version));
  }

  /** 按 tag 精确查一次 release。webhook 带了 tag，就没必要求助 atom 的缓存。 */
  async function releaseByTag(tag, proxy) {
    const json = await fetchText(
      `https://api.github.com/repos/${REPO}/releases/tags/${encodeURIComponent(tag)}`, proxy, 15000);
    const release = JSON.parse(json);
    const name = String(release.tag_name || '').trim();
    if (!/^v\d+\.\d+\.\d+$/.test(name)) throw new Error('release tag 格式异常');
    return {
      tag: name, version: versionOf(name), notes: htmlToText(release.body || ''),
      assets: Array.isArray(release.assets) ? release.assets : [],
    };
  }

  async function discover(hint) {
    const proxy = getProxy() || '';
    // webhook 带来的一手资产列表：两个包都在就直接用，一个外部请求都不用发。
    if (hint && hasApks(hint.assets, hint.version)) {
      return { tag: hint.tag, version: hint.version, notes: hint.notes, assets: hint.assets };
    }
    // 刚被唤醒的两分钟内按 tag 精确查：atom 走 CDN，新版本常常要几十秒才出现。
    if (hint && Date.now() - hint.at < WAKE_API_WINDOW_MS) {
      try { return await releaseByTag(hint.tag, proxy); }
      catch (error) { log(`[update] 按 tag 查 ${hint.tag} 失败：${error.message}`); }
    }
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

  /**
   * 把某个渠道的包拉到本地。
   *
   * 先探测远端大小和是否支持 Range：
   *   - 支持 → 切 CHUNK_COUNT 段并发，每段独立 .part，某段失败按轮次换源续传
   *   - 不支持 → 单流，多轮换源续传
   * 每轮结束统计进度，只要还有推进就继续，最多 MAX_ROUNDS 轮；
   * 不再「试一轮全失败就等 10 分钟」。
   */
  async function fetchChannel(channel, version, tag, assets, quick) {
    const dir = channelDir(channel);
    const name = fileName(channel, version);
    const apk = path.join(dir, name);
    if (fs.existsSync(apk) && fs.statSync(apk).size > 0) {
      return { file: name, size: fs.statSync(apk).size, sha256: await sha256OfFile(apk) };
    }

    // 附件名以 API 为准（万一某次发布改了名）；API 没给就按约定拼
    let assetName = name;
    let expectSha = '';
    if (Array.isArray(assets) && assets.length) {
      const hit = assets.find(a => a && typeof a.name === 'string' && matchesChannel(channel, a.name));
      if (hit) {
        assetName = hit.name;
        const digest = String(hit.digest || '');
        if (digest.indexOf('sha256:') === 0) expectSha = digest.slice(7).toLowerCase();
      }
    }
    const url = `https://github.com/${REPO}/releases/download/${tag}/${encodeURIComponent(assetName)}`;
    const proxy = getProxy() || '';

    const remote = await probeRemote(url, proxy, quick);
    if (!remote || !remote.size) throw new Error('所有源都探测不到包大小');
    const total = remote.size;
    if (total > MAX_BYTES) throw new Error(`更新包过大：${total} 字节`);

    progressState = { channel, version, total, done: 0, round: 0, mode: remote.range ? 'chunked' : 'whole' };
    log(`[update] ${channel} ${version} 共 ${(total / 1048576).toFixed(1)}MB，`
      + (remote.range ? `分 ${CHUNK_COUNT} 段并发` : '单流') + `（探测源 ${remote.prefix || '直连'}）`);

    // 旧版留下的整体 .part 是从 0 顺序写下来的，前 N 字节都是对的 —— 按段切开当起步数据，
    // 用户那边正卡在 4MB 的两坨不用白扔。
    const legacy = path.join(dir, name + '.part');
    let seed = null;
    if (fs.existsSync(legacy)) {
      try { seed = fs.readFileSync(legacy); } catch { seed = null; }
    }

    if (!remote.range) {
      let finished = false;
      for (let round = 0; round < MAX_ROUNDS && !finished; round++) {
        const result = await downloadWhole(url, legacy, proxy, round);
        progressState.round = round + 1;
        progressState.done = fs.existsSync(legacy) ? fs.statSync(legacy).size : 0;
        finished = progressState.done >= total;
        log(`[update] ${channel} 第 ${round + 1} 轮（${result.source}）：${(progressState.done / 1048576).toFixed(1)}MB / ${(total / 1048576).toFixed(1)}MB`);
      }
      if (!finished) {
        throw new Error(`${channel} 单流没下完（${(progressState.done / 1048576).toFixed(1)}MB），下一轮续传`);
      }
      fs.rmSync(apk, { force: true });
      fs.renameSync(legacy, apk);
    } else {
      const chunkCount = Math.max(1, Math.min(CHUNK_COUNT, Math.ceil(total / (512 * 1024))));
      const chunkSize = Math.ceil(total / chunkCount);
      const chunks = [];
      for (let i = 0; i < chunkCount; i++) {
        const start = i * chunkSize;
        const end = Math.min(total - 1, start + chunkSize - 1);
        if (start > end) break;
        const file = path.join(dir, `${name}.chunk${i}.part`);
        if (seed && seed.length > start && !fs.existsSync(file)) {
          const slice = seed.subarray(start, Math.min(start + (end - start + 1), seed.length));
          if (slice.length > 0) fs.writeFileSync(file, slice);
        }
        chunks.push({ start, end, file });
      }
      if (seed) fs.rmSync(legacy, { force: true });

      const sizeOf = (chunk) => {
        try { return Math.min(fs.statSync(chunk.file).size, chunk.end - chunk.start + 1); }
        catch { return 0; }
      };
      const doneBytes = () => chunks.reduce((sum, chunk) => sum + sizeOf(chunk), 0);
      const sources = mirrors();

      for (let round = 0; round < MAX_ROUNDS; round++) {
        const todo = chunks.filter(chunk => sizeOf(chunk) < chunk.end - chunk.start + 1);
        progressState.round = round + 1;
        progressState.done = doneBytes();
        if (!todo.length) break;
        log(`[update] ${channel} 第 ${round + 1} 轮：${todo.length}/${chunks.length} 段待补，已有 ${(progressState.done / 1048576).toFixed(1)}MB`);
        await Promise.all(todo.map((chunk, index) => {
          // 每段起点错开一个源：同时把几个源都用上，不是排队等第一个超时
          const prefix = sources[(round + index) % sources.length];
          return fetchRange(url, prefix, chunk.start, chunk.end, chunk.file, proxy).catch(() => false);
        }));
      }

      progressState.done = doneBytes();
      const missing = chunks.filter(chunk => sizeOf(chunk) < chunk.end - chunk.start + 1);
      if (missing.length) {
        const left = ((total - progressState.done) / 1048576).toFixed(1);
        throw new Error(`${channel} 还有 ${missing.length} 段没下完，差 ${left}MB，下一轮接着续`);
      }
      assemble(chunks.map(chunk => chunk.file), apk);
      chunks.forEach(chunk => fs.rmSync(chunk.file, { force: true }));
    }

    const size = fs.statSync(apk).size;
    const sha = await sha256OfFile(apk);
    if (size !== total) {
      fs.rmSync(apk, { force: true });
      throw new Error(`${channel} 大小不符（${size} != ${total}）`);
    }
    // 文件头校验：APK 是 zip（"PK"），Windows 安装包是 PE（"MZ"）。
    // 以前这里只认 PK，桌面端 exe 每轮都下完 100MB 再被当成坏包删掉 —— 分块也跟着清空，
    // 表现就是「有分块在下载，过会儿文件夹里啥也没有」。反代维护页 / 404 页两种都过不了。
    const magic = channel === 'desktop' ? [0x4d, 0x5a] : [0x50, 0x4b];
    const kindName = channel === 'desktop' ? 'EXE' : 'APK';
    const head = Buffer.alloc(2);
    const fd = fs.openSync(apk, 'r');
    try { fs.readSync(fd, head, 0, 2, 0); } finally { fs.closeSync(fd); }
    if (head[0] !== magic[0] || head[1] !== magic[1]) {
      fs.rmSync(apk, { force: true });
      throw new Error(`${channel} 下到的不是 ${kindName}（开头不是 ${String.fromCharCode(...magic)}），已丢弃`);
    }
    if (expectSha && sha !== expectSha) {
      fs.rmSync(apk, { force: true });
      throw new Error(`${channel} sha256 校验失败，已丢弃`);
    }
    progressState = null;
    log(`[update] 已缓存 ${channel} ${version}（${(size / 1048576).toFixed(1)}MB）`);
    return { file: name, size, sha256: sha };
  }

  /** 清理旧版本：每渠道只留最近 KEEP_VERSIONS 个，.part 超过一天也清掉。 */
  function prune() {
    for (const channel of CHANNELS) {
      const dir = channelDir(channel);
      let names = [];
      try { names = fs.readdirSync(dir); } catch { continue; }
      const apks = names.filter(n => /\.(apk|exe)$/.test(n))
        .map(n => ({ n, v: (n.match(/(\d+\.\d+\.\d+)\.(?:apk|exe)$/) || [])[1] || '0.0.0' }))
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

  /**
   * 立即跑一轮：查一次最新版本，有新版就把包下下来。
   * 正在跑就复用同一轮（返回同一个 Promise），不并发抢带宽。
   */
  function poll() {
    if (polling) return pollPromise || Promise.resolve();
    polling = true;
    pollPromise = runPoll()
      .catch(() => { })
      .then(() => { polling = false; pollPromise = null; });
    return pollPromise;
  }

  async function runPoll() {
    try {
      const info = await discover(wakeHint);
      const previous = manifest && manifest.version;
      // webhook 会重复投递（GitHub 没收到 2xx 就重试），也可能有人手滑点了旧版本的发布。
      // 旧 tag 不能把清单倒回去，更不能为此白下一个 40MB 的旧包。
      if (manifest && manifest.version && compareVersion(info.version, manifest.version) < 0) {
        log(`[update] 忽略旧版本 ${info.version}（当前已是 ${manifest.version}）`);
        if (wakeHint && compareVersion(wakeHint.version, manifest.version) < 0) wakeHint = null;
      } else {
        if (!manifest || !manifest.version || compareVersion(info.version, manifest.version) > 0) {
          manifest = { version: info.version, tag: info.tag, notes: info.notes || '', fetchedAt: Date.now(), channels: {} };
        } else {
          manifest.notes = info.notes || manifest.notes || '';
          manifest.tag = info.tag;
        }
        // 手动点「检查更新」的那个渠道排前面，另一个渠道随后补
        const order = focusChannel && CHANNELS.indexOf(focusChannel) >= 0
          ? [focusChannel].concat(CHANNELS.filter(c => c !== focusChannel))
          : CHANNELS;
        for (const channel of order) {
          // 已经在盘上（含手动投递）就不重复下
          const local = localVersions(channel)[0];
          if (local && compareVersion(local.version, info.version) === 0) {
            manifest.channels[channel] = {
              file: local.file, size: local.size,
              sha256: await sha256OfFile(path.join(channelDir(channel), local.file)),
            };
            continue;
          }
          // 桌面端还没发安装包时直接跳过，不要让它拖慢手机/电视的更新
          if (channel === 'desktop' && Array.isArray(info.assets) && info.assets.length && !hasAsset(info.assets, 'desktop')) continue;
          try {
            manifest.channels[channel] = await fetchChannel(channel, info.version, info.tag, info.assets,
              // 快车道：只探两个源，每轮换个起点，别让超时把 5 秒的节奏拖没
              wakeHint ? { limit: 2, offset: wakeRound } : null);
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
      }
    } catch (error) {
      log(`[update] 检查失败：${error.message}`);
    } finally {
      // 有渠道还没落地：短间隔重试。以前全失败要干等 10 分钟，
      // 而 .part 已经下了一大半，早一轮就早一点补完。
      const ready = REQUIRED_CHANNELS.every(channel => {
        const entry = manifest && manifest.channels && manifest.channels[channel];
        return entry && entry.file && fs.existsSync(path.join(channelDir(channel), entry.file));
      });
      let quick = false;
      if (wakeHint) {
        // 两个渠道都落到这版（或磁盘上已有更新的版本）就算收工，回到常规节奏
        const done = ready && manifest && compareVersion(manifest.version, wakeHint.version) >= 0;
        if (done) {
          log(`[update] ${wakeHint.version} 已就绪，退出快车道`);
          wakeHint = null;
        } else if (wakeRound >= WAKE_ROUNDS) {
          log(`[update] ${wakeHint.version} 快车道跑了 ${WAKE_ROUNDS} 轮还没齐，交回常规轮询`);
          wakeHint = null;
        } else {
          wakeRound++;
          quick = true;
          scheduleRetry(WAKE_RETRY_MS);
        }
      }
      // 快车道已经在排队了就别再叠一个常规重试（scheduleRetry 里也会去重）
      if (!ready && !quick) scheduleRetry(RETRY_MS);
    }
  }

  function scheduleRetry(ms) {
    if (retryTimer || !timer) return;   // 没 start 过就不排（单测里别留定时器）
    retryTimer = setTimeout(() => { retryTimer = null; poll(); }, Math.max(5000, ms));
    if (retryTimer.unref) retryTimer.unref();
  }

  /** 当前下载进度，给 /api/health 看；没在下载就返回 null。 */
  function progress() {
    if (!progressState) return null;
    return {
      channel: progressState.channel,
      version: progressState.version,
      mode: progressState.mode,
      round: progressState.round,
      total: progressState.total,
      done: progressState.done,
      percent: progressState.total ? Math.round((progressState.done / progressState.total) * 100) : 0,
      // 是不是 webhook 拉起来的快车道（5 秒一轮），排查「为什么现在在下载」用
      quick: !!wakeHint,
    };
  }

  /**
   * GitHub Release Webhook 的入口：发版瞬间把这一版排上队，不用等 10 分钟一轮的定时器。
   *
   * 只应该用「已经正式发布」的 release 调用 —— draft 的资产用公开 URL 下不到，会 404。
   * payload 里的 assets 如果有两个 APK 就直接拿来用：一个外部请求都不用发，
   * 也绕开了 atom 走 CDN 缓存、新版本迟迟不出现的延迟。
   */
  function wake(release) {
    if (!release || typeof release !== 'object') return false;
    const tag = String(release.tag_name || '').trim();
    if (!/^v\d+\.\d+\.\d+$/.test(tag)) return false;
    const assets = Array.isArray(release.assets) ? release.assets : [];
    wakeHint = {
      tag,
      version: versionOf(tag),
      notes: htmlToText(release.body || ''),
      assets,
      at: Date.now(),
    };
    wakeRound = 0;
    log(`[update] webhook 触发 ${tag}（附件 ${assets.length} 个`
      + (hasApks(assets, wakeHint.version) ? '，两个包都在' : '，还缺包，秒级重试') + '）');
    // 正在 poll 也没关系：当前这轮收尾时会看到 wakeHint 并接着打
    if (autoPoll) poll();
    return true;
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
    if (!/^Veyra(?:-TV|-Desktop)?-\d+\.\d+\.\d+\.(?:apk|exe)$/.test(name)) return null;
    const file = path.join(channelDir(channel), name);
    if (!file.startsWith(channelDir(channel) + path.sep)) return null;
    return fs.existsSync(file) ? file : null;
  }

  /**
   * 手动触发一次「检查 + 下载」。
   *
   * channel 传 mobile / tv 就先下这个渠道的包（另一个随后补）；传 all 按常规顺序。
   * 立即返回、不阻塞请求，前端轮询 snapshot() 看进度就行。
   * 没新版本时什么都不会下载 —— discover 拿到的还是当前版本，fetchChannel 直接命中磁盘。
   */
  function checkNow(channel) {
    const focus = CHANNELS.indexOf(channel) >= 0 ? channel : null;
    focusChannel = focus;
    if (polling) return { started: false, running: true, focus, snapshot: snapshot() };
    log(`[update] 手动检查${focus ? `（优先 ${focus}）` : ''}`);
    poll();
    return { started: true, running: true, focus, snapshot: snapshot() };
  }

  /** 给 WebUI / 客户端看的整体状态：最新版本、各渠道是否就绪、下载进度。 */
  function snapshot() {
    const data = manifest || loadManifest();
    const channels = {};
    for (const channel of CHANNELS) {
      const entry = data && data.channels && data.channels[channel];
      let ready = false;
      if (entry && entry.file) {
        try { ready = fs.statSync(path.join(channelDir(channel), entry.file)).size > 0; } catch { ready = false; }
      }
      channels[channel] = {
        ready,
        file: entry && entry.file ? entry.file : '',
        version: ready && data ? data.version : '',
        size: entry && entry.size ? entry.size : 0,
      };
    }
    return {
      version: data && data.version ? data.version : null,
      notes: data && data.notes ? data.notes : '',
      checkedAt: data && data.fetchedAt ? data.fetchedAt : 0,
      channels,
      polling,
      focus: focusChannel,
      progress: progress(),
      wake: wakeHint ? { tag: wakeHint.tag, version: wakeHint.version } : null,
    };
  }

  function start() {
    if (timer) return;
    setTimeout(() => { poll(); }, FIRST_DELAY_MS).unref();
    timer = setInterval(() => { poll(); }, POLL_MS);
    if (timer.unref) timer.unref();
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  }

  return {
    start, stop, poll, wake, status, fileOf, progress, checkNow, snapshot,
    get manifest() { return manifest || loadManifest(); },
    /** 快车道状态（webhook 拉起的那一版），给 /api/health 和测试看。 */
    get wakeState() {
      return wakeHint ? { tag: wakeHint.tag, version: wakeHint.version, round: wakeRound, at: wakeHint.at } : null;
    },
  };
}

module.exports = { createAppUpdater, compareVersion, fileName, hasApks, parseAtom, probeRemote, fetchRange };
