'use strict';
/**
 * Veyra 后端 · 下载系统
 *
 * 职责：NAS 端整剧下载 + 合并。
 *  - 任务由 APK 提交（APK 已用自身解析链路把每集播放地址算好，红果附内容密钥 hex）
 *  - 红果：ffmpeg -decryption_key 原生解密下载（与 juku-backend 一致）
 *  - 黄果：直接下载明文分集
 *  - 合并参考 juku-backend：ffprobe 探测各集编码，一致则 concat -c copy 无损合并，
 *    不一致则先逐集统一转码（libx264/aac，中间文件留在 .merge-work 断点续传），再合并。
 *  - 合并成功后删除分集，只保留整剧单文件。任务状态持久化 DATA_DIR/downloads.json。
 */
const crypto = require('crypto');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const { spawnSync, spawn } = require('child_process');
const hgApp = require('./hongguo-app');
const proxyFetch = require('./proxy-fetch');

// 数据/下载目录：环境变量指定，默认 /data、/video（docker-compose 挂载）。
// 裸跑/本地运行时根目录不可写 → 自动回退到可写目录，避免服务因 EACCES 直接崩溃。
let DATA_DIR = process.env.DATA_DIR || '/data';
let DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || '/video';
function resolveWritableDir(preferred, fallbacks) {
  for (const dir of [preferred, ...fallbacks]) {
    try { fs.mkdirSync(dir, { recursive: true }); fs.accessSync(dir, fs.constants.W_OK); return dir; }
    catch { /* try next */ }
  }
  return null;
}
DATA_DIR = resolveWritableDir(DATA_DIR, [path.join(process.cwd(), 'data'), path.join(os.tmpdir(), 'veyra-data')]) || DATA_DIR;
let CONCURRENCY = Math.max(1, parseInt(process.env.DOWNLOAD_CONCURRENCY || '2', 10) || 2);
/** 合并后是否保留分集文件（桌面端在设置里可关，后端保持原来的「合并即清理」） */
let KEEP_EPISODES = false;
const RETRIES = 2;
/** 合并前后是否做音频解码体检（坏音轨宁可报错也不静默出片）。VEYRA_AUDIT_AUDIO=0 可关。 */
const AUDIT_AUDIO = process.env.VEYRA_AUDIT_AUDIO !== '0';
/* 全片音频解码体检的超时。4.8 小时的整季在低功耗 NAS 上要跑两三分钟，5 分钟太紧。 */
const AUDIT_TIMEOUT_MS = 15 * 60 * 1000;
const TASKS_FILE = path.join(DATA_DIR, 'downloads.json');
const REDOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000; // 播放地址默认时效：超时后任务判失败（APK 重新提交）

const HONGGUO_VIDEO_UA = 'com.phoenix.read/73532 (Linux; U; Android 16; zh_CN; 25053RT47C; Build/BP2A.250605.031.A3; Cronet/TTNetVersion:04657795 2026-01-23 QuicVersion:c67e9834 2025-09-08)';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// ---- 任务存储 ----
let tasks = {}; // id -> task
let storeDirty = false;
let storeTimer = null;
function loadTasks() {
  try { tasks = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8')).tasks || {}; } catch { tasks = {}; }
  // 重启后把未完成任务标记为中断，并按分集文件实际存在情况重建成功/失败清单：
  // 已下载的分集（work_<id>/epNNN.mp4）保留，重启/升级后重试失败集只补缺失的集，不会整季重下
  for (const t of Object.values(tasks)) {
    const interrupted = t.status === 'downloading' || t.status === 'merging' || t.status === 'queued';
    // 旧版本遗留的 failed 任务（无 failedEpisodes 字段）：同样按分集文件重建失败清单，使「重试失败集」可用
    const legacyFailed = t.status === 'failed' && !Array.isArray(t.failedEpisodes) && !String(t.error || '').includes('合并失败');
    if (interrupted || legacyFailed) {
      if (interrupted) t.status = 'failed';
      rescanTaskFiles(t);
      const failedCount = (t.failedEpisodes || []).length;
      if (interrupted) {
        t.error = failedCount > 0 ? `服务重启，任务中断（${failedCount} 集待补下，可重试失败集）` : '服务重启，任务中断';
      }
      t.updatedAt = Date.now();
    }
  }
  storeDirty = true;
}
/** 按 work 目录分集文件重建任务每集状态：文件在=成功保留，缺失=失败待补下。 */
function rescanTaskFiles(t) {
  const dir = taskDir(t);
  t.failedEpisodes = [];
  if (!fs.existsSync(dir)) {
    for (const ep of t.episodes) { ep._ok = false; ep.failed = false; }
    return;
  }
  t.episodes.forEach((ep, i) => {
    const f = safeJoin(dir, epName(i + 1));
    let ok = false;
    try { ok = fs.existsSync(f) && fs.statSync(f).size > 0; } catch { ok = false; }
    ep._ok = ok;
    ep.failed = !ok;
    if (!ok) t.failedEpisodes.push({ index: i + 1, error: '分集缺失，待重试补下' });
  });
}
function flushStore(force) {
  if (!storeDirty && !force) return;
  storeDirty = false;
  try {
    const tmp = TASKS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ tasks }, null, 2));
    fs.renameSync(tmp, TASKS_FILE);
  } catch (e) { console.error('[download] 保存任务状态失败:', e.message); storeDirty = true; }
}
function scheduleFlush() {
  if (storeTimer) return;
  storeTimer = setTimeout(() => { storeTimer = null; flushStore(false); }, 1500);
}
function touch(task) { task.updatedAt = Date.now(); storeDirty = true; scheduleFlush(); }

// ---- 工具 ----
function sanitizeName(name) {
  return String(name || '').replace(/[\\/:*?"<>|\r\n\t]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || '未命名';
}
/** 任务目录：<下载目录>/<剧名>/，分集与合并产物都在剧名文件夹下（用户可见、好整理）。 */
function taskDir(t) {
  return safeJoin(DOWNLOAD_DIR, sanitizeName(t && t.title));
}
/** 分集文件名：第01集.mp4（与手机端命名一致） */
function epName(i) { return `第${String(i).padStart(2, '0')}集.mp4`; }
/** 分集密文文件名：第01集.enc（下载中间文件，解密后删除） */
function epEncName(i) { return `第${String(i).padStart(2, '0')}集.enc`; }
function safeJoin(base, name) {
  const target = path.resolve(base, name);
  if (!target.startsWith(path.resolve(base) + path.sep)) throw new Error('非法路径');
  return target;
}
function httpGet(url, headers, onData, onEnd, onError) {
  const mod = url.startsWith('https:') ? https : http;
  const req = mod.get(url, { headers }, res => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume();
      httpGet(new URL(res.headers.location, url).toString(), headers, onData, onEnd, onError);
      return;
    }
    if (res.statusCode !== 200) {
      res.resume();
      onError(new Error(`下载失败 HTTP ${res.statusCode}`));
      return;
    }
    res.on('data', onData);
    res.on('end', onEnd);
  });
  req.on('error', onError);
  req.setTimeout(60_000, () => req.destroy(new Error('下载超时')));
  return req;
}
function downloadFile(url, destPath, headers, progressCb, signal) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    let received = 0;
    let lastTick = 0;
    let aborted = false;
    let req = null;
    const abort = err => {
      if (aborted) return;
      aborted = true;
      file.removeAllListeners();
      file.on('error', () => {});
      try { file.destroy(); } catch { /* ignore */ }
      reject(err || new Error('任务已取消'));
    };
    const onData = chunk => {
      if (signal && signal.aborted) { if (req) req.destroy(); return; }
      received += chunk.length;
      const now = Date.now();
      if (now - lastTick > 300) { lastTick = now; if (progressCb) progressCb(received); }
      if (!file.write(chunk)) { /* 背压不处理，量级小 */ }
    };
    req = httpGet(url, headers,
      onData,
      () => { file.end(() => { if (progressCb) progressCb(received); resolve(); }); },
      err => { file.destroy(); abort(err); });
    file.on('error', err => abort(err));
    if (signal) {
      const check = setInterval(() => {
        if (signal.aborted) { clearInterval(check); if (req) req.destroy(); abort(new Error('任务已取消')); }
      }, 300);
      file.on('close', () => clearInterval(check));
    }
  });
}

// App 源多 CDN 域下载：main_url 失败自动切 backup_url（红果每变体 main/backup 属不同 CDN 域）
async function downloadWithFallback(urls, destPath, headers, progressCb, signal) {
  let lastErr = null;
  for (const u of urls) {
    if (signal.aborted) throw new Error('任务已取消');
    try {
      await downloadFile(u, destPath, headers, progressCb, signal);
      return;
    } catch (e) {
      lastErr = e;
      console.log(`[hongguo-app] 地址下载失败 ${String(u).slice(0, 70)}...: ${e.message}`);
    }
  }
  throw lastErr || new Error('所有播放地址均下载失败');
}

// ---- 合并（对照 juku-backend media_merge.go / media_merge_plan.go 完整移植）----
function probeFile(file) {
  const out = spawnSync('ffprobe', ['-v', 'error', '-show_data', '-show_entries',
    'stream=index,codec_type,codec_name,width,height,profile,sample_rate,channels,channel_layout,duration,start_time,time_base,pix_fmt,codec_tag_string,r_frame_rate,avg_frame_rate,sample_aspect_ratio,bits_per_raw_sample,field_order,sample_fmt,bits_per_sample,extradata',
    '-of', 'json', file], { encoding: 'utf8', timeout: 60_000 });
  if (out.status !== 0) throw new Error('ffprobe 探测失败: ' + (out.stderr || '').slice(0, 300));
  const parsed = JSON.parse(out.stdout);
  const video = (parsed.streams || []).find(s => s.codec_type === 'video');
  const audio = (parsed.streams || []).find(s => s.codec_type === 'audio');
  if (!video) throw new Error('分集没有视频轨道');
  const tb = String(video.time_base || '').split('/');
  const atb = audio ? String(audio.time_base || '').split('/') : [];
  const rateRaw = String(video.avg_frame_rate || video.r_frame_rate || '');
  return {
    videoCodec: video.codec_name,
    width: video.width, height: video.height, vProfile: video.profile || '',
    vTag: video.codec_tag_string || '',
    pixFmt: video.pix_fmt || '',
    videoTB: video.time_base || '',
    frameRateRaw: rateRaw && rateRaw !== '0/0' ? rateRaw : '',
    frameRate: normRate(rateRaw),
    sar: normSar(video.sample_aspect_ratio),
    vBitDepth: Number(video.bits_per_raw_sample) || 0,
    fieldOrder: video.field_order || '',
    audioCodec: audio ? audio.codec_name : null,
    aProfile: audio ? audio.profile || '' : '',
    /* AudioSpecificConfig 里的 AOT：2=LC, 5=SBR(HE), 29=PS(HEv2)。
     * profile 字符串在 mkv/ts 里经常是空的或者写法不一，extradata 才是一手证据。 */
    audioAot: audio && audio.codec_name === 'aac' ? aacAot(audio.extradata) : 0,
    aTag: audio ? (audio.codec_tag_string || '') : '',
    sampleRate: audio ? Number(audio.sample_rate) : 0,
    channels: audio ? Number(audio.channels) : 0,
    layout: audio ? audio.channel_layout || '' : '',
    sampleFmt: audio ? audio.sample_fmt || '' : '',
    aBitDepth: audio ? Number(audio.bits_per_sample) || 0 : 0,
    audioTB: audio ? audio.time_base || '' : '',
    duration: Number(video.duration) || 0,
    audioDuration: audio ? Number(audio.duration) || 0 : 0,
    videoStart: Number(video.start_time) || 0,
    audioStart: audio ? Number(audio.start_time) || 0 : 0,
    avOffset: audio ? (Number(video.start_time) || 0) - (Number(audio.start_time) || 0) : 0,
    /* 音频比视频长多少：正值说明音轨尾巴多出一截。
     * concat 是按每段的最长流推进的，一段音频多 0.5s，下一集的画面就要晚 0.5s 才开始，
     * 288 集累下来就是整片音画错位，所以这段必须裁掉。 */
    avDrift: audio ? (Number(audio.duration) || 0) - (Number(video.duration) || 0) : 0,
    timescale: tb.length === 2 ? Number(tb[1]) || 0 : 0,
    audioTimescale: atb.length === 2 ? Number(atb[1]) || 0 : 0,
  };
}

/** 从 ffprobe 的 hexdump 里取出 AAC AudioSpecificConfig 首字节的 AOT（前 5 bit）。 */
function aacAot(extradata) {
  if (!extradata) return 0;
  const hex = String(extradata)
    .replace(/^[ \t]*[0-9a-fA-F]+:[ \t]*/gm, ' ')
    .trim()
    .split(/\s{2,}/)[0]
    .replace(/\s+/g, '');
  if (!/^[0-9a-fA-F]{2,}$/.test(hex)) return 0;
  const aot = parseInt(hex.slice(0, 2), 16) >> 3;
  return aot === 31 ? 0 : aot;
}

/** 帧率归一化：30000/1001 与 29.97 视为同一个，24 与 24.0 视为同一个。 */
function normRate(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/^(\d+)\/(\d+)$/);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    return b ? Math.round((a / b) * 1000) / 1000 : 0;
  }
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : 0;
}

/** 像素宽高比归一化：空、0:1、1:1 都当 1:1。 */
function normSar(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/^(\d+):(\d+)$/);
  if (!m) return '1:1';
  const a = Number(m[1]), b = Number(m[2]);
  if (!a || !b || a === b) return '1:1';
  return `${a}:${b}`;
}

/** 声道布局归一化：ffprobe 有时给空串，用声道数补上，别把同一件事判成两种参数。 */
function normLayout(info) {
  const raw = String(info.layout || '').trim().toLowerCase();
  if (raw) return raw;
  const c = Number(info.channels) || 0;
  return c === 1 ? 'mono' : c === 2 ? 'stereo' : c === 6 ? '5.1' : c === 8 ? '7.1' : `${c}ch`;
}

/**
 * AAC profile 归一化。ffprobe 同一件事有好几种写法：
 *   LC  → "LC" / "AAC (LC)" / "Low Complexity"
 *   HE  → "HE-AAC" / "HE-AACv2" / "SBR" / "PS"
 * 不归一化的话，"LC" 和 "AAC (LC)" 会被判成两个组，白白多转一半集。
 */
function normAacProfile(raw) {
  const p = String(raw || '').trim().toLowerCase();
  if (!p) return 'lc';
  if (p.includes('eld')) return 'eld';
  if (p.includes('he-aacv2') || (p.includes('he-aac') && p.includes('v2'))) return 'hev2';
  if (p.includes('he-aac') || p.includes('sbr') || p.includes('ps')) return 'he';
  if (p.includes('lc') || p.includes('low complexity')) return 'lc';
  if (p.includes('main')) return 'main';
  return p;
}

/** 目标音轨能否直接 copy：只有 AAC-LC(AOT=2) 才 copy，HE-AAC(SBR/PS) 一律转 LC。 */
function aacCopyable(info) {
  if (!info.audioCodec || String(info.audioCodec).toLowerCase() !== 'aac') return false;
  return aacProfileKey(info) === 'lc';
}

/** 日志用的 profile 可读名：有 AOT 就用 AOT 翻，别让 "AAC (LC)" 和 "LC" 两种写法混着显示。 */
function aProfileText(info) {
  if (info.audioAot) {
    const map = { 1: 'Main', 2: 'LC', 3: 'SSR', 4: 'LTP', 5: 'HE-AAC', 29: 'HE-AACv2' };
    return map[info.audioAot] || `AOT${info.audioAot}`;
  }
  return info.aProfile || '-';
}

/** profile 的比对口径：优先用 extradata 的 AOT，拿不到才退回 profile 字符串。 */
function aacProfileKey(info) {
  /* AOT=2 与 "LC"/"AAC (LC)" 是同一种东西，统一归成 lc —— 否则一边有 extradata、
   * 一边只有 profile 字符串时，同一个音轨会被判成两组，白白多转一半集。 */
  if (info.audioAot) return info.audioAot === 2 ? 'lc' : `aot${info.audioAot}`;
  return normAacProfile(info.aProfile);
}

const NO_AUDIO = '(无音轨)';
/* 参数比对口径：只要这些字段有一个不同，就认为这一集与主流不一致。
 * 视频：编码、分辨率、profile、像素格式、位深、帧率、宽高比
 * 音频：编码、profile、采样率、声道数、声道布局、采样格式
 * 时间基不参与比对 —— 那个不转码也能修，走重封装（-video_track_timescale）。 */
function videoKey(info) {
  return [String(info.videoCodec || '').toLowerCase(), `${info.width}x${info.height}`,
    String(info.vProfile || '').toLowerCase(), info.pixFmt,
    info.vBitDepth || '', info.frameRate || '', info.sar].join('|');
}
function audioKey(info) {
  if (!info.audioCodec) return NO_AUDIO;
  return [String(info.audioCodec).toLowerCase(), aacProfileKey(info), info.sampleRate, info.channels,
    normLayout(info), info.sampleFmt].join('|');
}

/**
 * 音频全解码体检：只解音轨、输出到 null，统计真正的解码错误。
 * ffmpeg -v error 时 stderr 只剩错误行，正常文件是空的。
 */
function decodeErrors(file, selector) {
  const out = spawnSync('ffmpeg', ['-v', 'error', '-nostdin', '-i', file, '-map', selector, '-f', 'null', '-'],
    { encoding: 'utf8', timeout: AUDIT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });
  if (out.error) return { errors: 1, sample: String(out.error.message || out.error).slice(0, 200) };
  const lines = String(out.stderr || '').split('\n').map(s => s.trim()).filter(Boolean);
  // 只认真正的解码/封装错误；时间戳不单调这类"提示"不算（很多正常片源也有）
  const real = lines.filter(l => /error|invalid|cannot|corrupt|truncat|fail|missing|decode|illegal/i.test(l)
    && !/non monotonically increasing|Application provided invalid/i.test(l));
  return { errors: real.length, sample: real.slice(0, 2).join(' | ').slice(0, 300) };
}

/**
 * 接缝体检：统计音轨里「相邻两包几乎重合」的位置。
 *
 * 逐集编码再 concat，每个集边界都会留下 1~3 个间隔约等于 0 的包（实测约 3ms 残帧）：
 * 前一段的尾包还没走完，后一段的首包已经贴上来了。播放器 seek 到集边界时，
 * 新旧两段样本一起被吐出来 —— 就是拖进度条到集边界听见的咔哒声/爆音。
 * 视频帧的 46~53ms 空洞也出自同一处（每段最后 1~2 帧被下段的首帧顶掉）。
 *
 * 整轨一次性编码的产物这里应当是 0。用固定帧长的中位数做基准，
 * 只认「比半个帧长还短」的间隔，避免把正常的抖动算成接缝。
 */
function seamStats(file) {
  const out = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0',
    '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', file],
    { encoding: 'utf8', timeout: AUDIT_TIMEOUT_MS, maxBuffer: 96 * 1024 * 1024 });
  if (out.status !== 0) return { total: 0, seams: 0, dup: 0, frameDur: 0 };
  const pts = [];
  for (const line of String(out.stdout || '').split('\n')) {
    const v = Number(line.trim());
    if (Number.isFinite(v)) pts.push(v);
  }
  if (pts.length < 3) return { total: pts.length, seams: 0, dup: 0, frameDur: 0 };
  // 帧长基准：取前 800 个正间隔的中位数（AAC 一般是 1024 或 2048 样本，定值）
  const deltas = [];
  for (let i = 1; i < pts.length && deltas.length < 800; i++) {
    const d = pts[i] - pts[i - 1];
    if (d > 0.0001) deltas.push(d);
  }
  deltas.sort((a, b) => a - b);
  const frameDur = deltas.length ? deltas[Math.floor(deltas.length / 2)] : 0;
  if (!frameDur) return { total: pts.length, seams: 0, dup: 0, frameDur: 0 };
  let seams = 0, dup = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = pts[i] - pts[i - 1];
    if (d <= 0) dup++;
    else if (d < frameDur * 0.5) seams++;
  }
  return { total: pts.length, seams, dup, frameDur: Math.round(frameDur * 1e6) / 1e6 };
}

/** 合并产物体检：参数是否落到目标值 + 音频能不能完整解码。 */
function auditOutput(file, targetSR, targetCh, expectAudio) {
  let info = null;
  try { info = probeFile(file); } catch (e) { return { audioErrors: 1, sample: '产物无法解析: ' + e.message, problems: [], text: '' }; }
  const problems = [];
  if (expectAudio && !info.audioCodec) problems.push('产物里没有音轨');
  if (expectAudio && info.audioCodec) {
    if (targetSR && info.sampleRate && Number(info.sampleRate) !== Number(targetSR)) problems.push(`采样率 ${info.sampleRate}≠${targetSR}`);
    if (targetCh && info.channels && Number(info.channels) !== Number(targetCh)) problems.push(`声道 ${info.channels}≠${targetCh}`);
  }
  const health = expectAudio ? decodeErrors(file, '0:a:0?') : { errors: 0, sample: '' };
  const seam = expectAudio && info.audioCodec ? seamStats(file) : { total: 0, seams: 0, dup: 0, frameDur: 0 };
  const audioErrors = health.errors + problems.filter(p => p === '产物里没有音轨').length;
  const text = [info.videoCodec ? info.videoCodec.toUpperCase() : '视频?',
    info.audioCodec ? `${info.audioCodec.toUpperCase()} ${info.sampleRate || '?'}Hz ${info.channels || '?'}ch` : '无音轨'].join(' + ');
  return { audioErrors, sample: health.sample, problems, seam, info, text };
}
/**
 * 参数分组统计。返回按「票数降序、首次出现顺序升序」排好的组。
 * 平票时先出现的那一组胜出 —— 也就是第 1 集所在的那一组，避免同一批片子在
 * 两次合并里选出不同目标（2:2 平分时如果随便挑，成品参数会时好时坏）。
 */
function tally(infos, key) {
  const groups = new Map();
  infos.forEach((info, index) => {
    const k = key(info);
    const hit = groups.get(k);
    if (hit) { hit.n += 1; hit.indexes.push(index); }
    else groups.set(k, { key: k, n: 1, first: index, indexes: [index], sample: info });
  });
  return [...groups.values()].sort((a, b) => (b.n - a.n) || (a.first - b.first));
}

const H264_PROFILES = { 'constrained baseline': 'baseline', baseline: 'baseline', main: 'main', high: 'high', 'high 10': 'high10' };
/* 目标封装（MP4）能直接装进去的编码。多数派不在这里面时不能只转少数派 ——
 * 否则多数派仍是 av1/vp9、少数派被转成 h264，concat 一 copy 就是花屏。 */
const MP4_VIDEO = new Set(['h264', 'hevc']);
const MP4_PIX = new Set(['yuv420p', 'yuvj420p', 'yuv420p10le', 'yuv422p', 'yuv422p10le', 'yuv444p', 'yuv444p10le']);

/** 视频差异描述：只讲人话，给日志和进度条用。 */
function videoDiffText(info, target) {
  const out = [];
  if (info.videoCodec !== target.videoCodec) out.push(`编码 ${info.videoCodec}→${target.videoCodec}`);
  if (info.width !== target.width || info.height !== target.height) out.push(`分辨率 ${info.width}x${info.height}→${target.width}x${target.height}`);
  if (String(info.vProfile || '').toLowerCase() !== String(target.vProfile || '').toLowerCase()) out.push(`profile ${info.vProfile || '-'}→${target.vProfile || '-'}`);
  if (info.pixFmt !== target.pixFmt) out.push(`像素格式 ${info.pixFmt}→${target.pixFmt}`);
  if ((info.vBitDepth || 0) !== (target.vBitDepth || 0)) out.push(`位深 ${info.vBitDepth || '-'}→${target.vBitDepth || '-'}`);
  if ((info.frameRate || 0) !== (target.frameRate || 0)) out.push(`帧率 ${info.frameRate || '-'}→${target.frameRate || '-'}`);
  if (info.sar !== target.sar) out.push(`宽高比 ${info.sar}→${target.sar}`);
  return out;
}

function audioDiffText(info, target) {
  if (!target.audioCodec && !info.audioCodec) return [];
  if (!info.audioCodec) return ['缺音轨→补静音'];
  if (!target.audioCodec) return ['多音轨→去掉'];
  const out = [];
  if (info.audioCodec !== target.audioCodec) out.push(`编码 ${info.audioCodec}→${target.audioCodec}`);
  // profile 必须比：AAC 的 LC 和 HE-AAC(SBR/PS) 混在一起，播放器按 LC 解就是满耳噪音/变调
  if (aacProfileKey(info) !== aacProfileKey(target)) out.push(`profile ${aProfileText(info)}→${aProfileText(target)}`);
  if (Number(info.sampleRate) !== Number(target.sampleRate)) out.push(`采样率 ${info.sampleRate}→${target.sampleRate}`);
  if (Number(info.channels) !== Number(target.channels)) out.push(`声道 ${info.channels}→${target.channels}`);
  if (normLayout(info) !== normLayout(target)) out.push(`声道布局 ${normLayout(info)}→${normLayout(target)}`);
  if (info.sampleFmt !== target.sampleFmt) out.push(`采样格式 ${info.sampleFmt}→${target.sampleFmt}`);
  return out;
}

/**
 * 合并计划：先逐集比全部参数，再按「少数服从多数」定目标，只把偏离的那几集转码。
 *
 * - 全部一致 → steps 里没有任何转码/重封装，直接 concat -c copy（无损、最快）
 * - 有不一致 → 目标参数取票数最多的那一组；票数少的集转码成目标参数
 * - 多数派编码装了进 MP4（av1/vp9 等）或位深不在支持列表 → 目标降级 h264/yuv420p，
 *   此时所有集都要转，只转少数派会留下混合编码
 * - 多数派没有音轨 → 全部去掉音轨；多数派有音轨而个别集没有 → 给那几集补静音轨
 */
function buildPlan(infos) {
  const vGroups = tally(infos, videoKey);
  const aGroups = tally(infos, audioKey);
  const vWin = vGroups[0];
  const aWin = aGroups[0];

  const vSample = vWin.sample;
  const aSample = aWin.sample;

  // 目标视频：默认照抄多数派；多数派装不进 MP4 时整体降级
  const vDowngrade = !MP4_VIDEO.has(vSample.videoCodec) || !MP4_PIX.has(vSample.pixFmt || 'yuv420p');
  // 降级也沿用多数派的时间基：不必要地改 timescale 只会让更多集走进重封装分支
  const videoTB = vSample.videoTB || '1/90000';
  const timescale = Number(String(videoTB).split('/')[1]) > 0
    && Number(String(videoTB).split('/')[1]) <= 10000000
    ? Number(String(videoTB).split('/')[1]) : 90000;
  const video = {
    key: vWin.key,
    codec: vDowngrade ? 'h264' : vSample.videoCodec,
    width: vSample.width,
    height: vSample.height,
    profile: vDowngrade ? 'high' : vSample.vProfile,
    pixFmt: vDowngrade ? 'yuv420p' : (vSample.pixFmt || 'yuv420p'),
    videoTB: `1/${timescale}`,
    frameRate: vSample.frameRate,
    frameRateRaw: vSample.frameRateRaw,
    sar: vSample.sar,
    vBitDepth: vSample.vBitDepth,
    downgrade: vDowngrade,
    timescale,
    groups: vGroups.map(g => ({ key: g.key, n: g.n, first: g.first })),
  };

  // 目标音频：多数派有音轨才有音轨。
  // 这里不看票数看兼容性 —— HE-AAC / HE-AACv2 在电视、Android 硬解、Emby 上兼容性都差，
  // 被按 LC 解析就是变调/电流声。所以只要多数派不是 AAC-LC，就全部转 aac_low。
  const aDowngrade = !!aSample.audioCodec && !aacCopyable(aSample);
  const audio = {
    key: aWin.key,
    present: !!aSample.audioCodec,
    codec: aSample.audioCodec ? 'aac' : null,
    profile: aSample.audioCodec ? (aDowngrade ? 'LC' : aSample.aProfile) : '',
    sampleRate: aSample.sampleRate || 44100,
    channels: aSample.channels || 2,
    layout: normLayout(aSample),
    sampleFmt: aSample.sampleFmt,
    audioTB: aSample.audioTB,
    downgrade: aDowngrade,
    groups: aGroups.map(g => ({ key: g.key, n: g.n, first: g.first })),
  };

  const steps = infos.map(info => {
    const reasons = [];
    // 比对用的"目标"要按最终目标（可能降级）描述，否则日志里会写出反方向，例如 h264→av1
    const vCompare = vDowngrade
      ? { ...vSample, videoCodec: video.codec, pixFmt: video.pixFmt, vProfile: video.profile, vBitDepth: 8 }
      : vSample;
    const aCompare = aDowngrade
      ? { ...aSample, audioCodec: audio.codec, aProfile: 'LC', audioAot: 2, sampleFmt: aSample.sampleFmt }
      : aSample;
    const vDiff = videoDiffText(info, vCompare);
    const aDiff = audioDiffText(info, aCompare);

    // 多数派装不进 MP4 时是"整体转码"，这条原因只记在 plan 层，不往每集里塞
    const videoNeeded = vDowngrade || vDiff.length > 0;
    if (vDiff.length) reasons.push(...vDiff);

    const silence = !info.audioCodec && !!aSample.audioCodec;      // 这一集缺音轨 → 补静音
    const dropAudio = !!info.audioCodec && !aSample.audioCodec;    // 多数派没音轨 → 这集也去掉
    if (aDiff.length) reasons.push(...aDiff);

    const sync = !!info.audioCodec && Math.abs(info.avOffset || 0) > 0.002;
    if (sync) reasons.push(`音画起点差 ${(info.avOffset * 1000).toFixed(0)}ms`);

    // 音轨尾巴比画面长：concat 按每段最长流推进，这一段会拖着后面所有集往后错
    const trim = !!info.audioCodec && (info.avDrift || 0) > 0.04;
    if (trim) reasons.push(`音轨比画面长 ${(info.avDrift * 1000).toFixed(0)}ms，裁到画面时长`);

    // 音频要重编码的条件：参数与多数派不同、视频转了、音画不同步、编码需降级
    const audioNeeded = !!info.audioCodec && !dropAudio
      && (aDowngrade || videoNeeded || aDiff.length > 0 || sync);

    // 时间基不一致 / 音画不同步 / 音轨过长：不转码也能修，重封装即可
    const tbDiff = info.videoTB !== `1/${timescale}`;
    const remux = !videoNeeded && (tbDiff || sync || trim || dropAudio);
    if (remux && tbDiff) reasons.push(`时间基 ${info.videoTB}→1/${timescale}（重封装）`);

    return { video: videoNeeded, audio: audioNeeded, silence, dropAudio, sync, trim, remux, reasons };
  });

  const notes = [];
  if (vDowngrade) notes.push(`多数派编码 ${vSample.videoCodec}/${vSample.pixFmt} 装不进 MP4，全部转 h264/yuv420p`);
  if (aDowngrade) notes.push(`多数派音频 ${aSample.audioCodec}/${aSample.aProfile || '?'} 不统一，全部转 aac_low`);
  return { timescale, video, audio, steps, notes, videoGroups: vGroups.length, audioGroups: aGroups.length };
}
/**
 * 跑一段 ffmpeg。
 * progressTotal > 0 时开 -progress，按输出时间轴回报 0~1 的进度 ——
 * 整轨重编码要跑好几分钟，没有进度条的话前端看起来就是卡死。
 */
function runFFmpeg(args, progressCb, progressTotal) {
  return new Promise((resolve, reject) => {
    const head = ['-hide_banner', '-nostdin', '-nostats', '-loglevel', 'error'];
    if (progressTotal > 0) head.push('-progress', 'pipe:1');
    const proc = spawn('ffmpeg', [...head, '-y', ...args]);
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); if (stderr.length > 8192) stderr = stderr.slice(-8192); });
    if (progressTotal > 0 && progressCb) {
      let buf = '';
      let last = -1;
      proc.stdout.on('data', d => {
        buf += d.toString();
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          const m = line.match(/^out_time_us=(\d+)/);
          if (!m) continue;
          const pct = Math.max(0, Math.min(99, Math.round((Number(m[1]) / 1e6) / progressTotal * 100)));
          if (pct !== last) { last = pct; progressCb(pct / 100); }
        }
      });
    }
    proc.on('close', code => {
      if (code === 0) { if (progressCb) progressCb(1); resolve(); }
      else reject(new Error('FFmpeg 处理失败: ' + stderr.slice(0, 500)));
    });
    proc.on('error', reject);
    progressCb && progressCb(0);
  });
}

/** 合并分集 -> 单文件（对照 juku-backend media_merge.go）。workDir 为 .merge-work 断点续传目录，全部成功后才清理。 */
async function mergeEpisodes(episodeFiles, outputPath, workDir, report) {
  const infos = [];
  const corrupt = [];
  for (let i = 0; i < episodeFiles.length; i++) {
    report(Math.round(i * 5 / episodeFiles.length), `检测分集编码 ${i + 1}/${episodeFiles.length}`);
    try { infos.push(probeFile(episodeFiles[i])); }
    catch (e) { throw new Error(`第 ${i + 1} 集编码检测失败: ${e.message}`); }
    // 逐集听一遍音轨：分片下载残缺会留下"能封装但解不出来"的坏帧，
    // 这种集直接 -c:a copy 过去就是满耳朵噪音，必须当集就抓出来。
    if (AUDIT_AUDIO && infos[i].audioCodec) {
      const health = decodeErrors(episodeFiles[i], '0:a:0?');
      if (health.errors > 0) {
        infos[i].audioErrors = health.errors;
        corrupt.push(`第${i + 1}集(${health.errors}处)`);
        console.warn(`[merge] 第 ${i + 1} 集音频解码异常 ${health.errors} 处：${health.sample}`);
      }
    }
  }
  const plan = buildPlan(infos);
  const vT = plan.video;
  const aT = plan.audio;
  // 音轨本身就有坏帧的集，强制重编码一遍再过一遍解码器（多数坏帧会被 AAC 解码器容错掉，
  // 剩下的交给产物校验兜底），至少不会原样 copy 进成品。
  for (let i = 0; i < infos.length; i++) if (infos[i].audioErrors) plan.steps[i].audio = true;

  // ---- 参数一致性报告：目标（多数派）是什么、哪几集偏离 ----
  const targetText = `${String(vT.codec).toUpperCase()} ${vT.width}x${vT.height}`
    + (vT.frameRate ? ` ${vT.frameRate}fps` : '')
    + ` ${vT.pixFmt}`
    + (aT.present ? ` + ${String(aT.codec).toUpperCase()} ${aT.sampleRate}Hz ${aT.channels}ch` : ' + 无音轨');
  console.log(`[merge] 多数派目标参数：${targetText}（视频 ${plan.videoGroups} 种 / 音频 ${plan.audioGroups} 种）`);
  const fmtGroup = g => `${String(g.key).split('|').join(' ')} ×${g.n} 集`;
  console.log(`[merge] 视频分布：${plan.video.groups.map(fmtGroup).join(' / ')}`);
  console.log(`[merge] 音频分布：${plan.audio.groups.map(fmtGroup).join(' / ')}`);
  for (const note of plan.notes) console.log(`[merge] 整体降级：${note}`);
  const drift = plan.steps.map((s, i) => ({ i: i + 1, reasons: s.reasons })).filter(x => x.reasons.length);
  const work = plan.steps.filter(s => s.video || s.audio || s.silence || s.dropAudio || s.remux).length;
  if (!work) {
    console.log('[merge] 全部剧集参数一致，直接无损合并（不转码）');
  } else {
    for (const d of drift.slice(0, 12)) console.log(`[merge] 第 ${d.i} 集偏离多数派：${d.reasons.join('，')}`);
    if (drift.length > 12) console.log(`[merge] ……其余 ${drift.length - 12} 集同类差异省略`);
    console.log(`[merge] ${work}/${infos.length} 集需处理（其中 ${drift.length} 集参数与多数派有差异）`);
  }

  const prepared = new Array(episodeFiles.length);

  for (let i = 0; i < episodeFiles.length; i++) {
    const info = infos[i];
    const step = plan.steps[i];
    if (!step.video && !step.audio && !step.silence && !step.dropAudio && !step.remux) {
      prepared[i] = episodeFiles[i];
      continue;
    }
    // 断点续传：已处理的集直接复用（文件名带 fix5，旧版本残留的处理结果不再复用）
    const cooked = safeJoin(workDir, `ep${String(i + 1).padStart(3, '0')}-fix5.mp4`);
    if (fs.existsSync(cooked) && fs.statSync(cooked).size > 1024) { prepared[i] = cooked; continue; }
    const action = step.video ? '按多数派转码视频+音轨'
      : step.silence ? '补静音音轨'
        : step.dropAudio ? '去掉多余音轨'
          : step.trim ? '裁齐音轨长度'
            : step.sync ? '校准音画起点'
              : step.audio ? '按多数派转码音轨' : '无损换封装(统一时间基)';
    report(5 + Math.round(i * 55 / episodeFiles.length), `${action}第 ${i + 1} 集`);

    const args = [];
    let audioInput = 0;
    const silence = step.silence;
    // 起点偏移和音轨过长都靠双输入各自归零：单输入做不到只动音轨不动视频
    const cut = !step.video && (step.sync || step.trim);
    if (silence) {
      // 这一集压根没有音轨，而多数派有：补一条同参数的静音轨，否则合并后这几集是哑的
      const layout = aT.channels === 1 ? 'mono' : 'stereo';
      args.push('-i', episodeFiles[i]);
      args.push('-f', 'lavfi', '-i', `anullsrc=r=${aT.sampleRate}:cl=${layout}`);
      audioInput = -1;
    } else if (!step.video && (step.audio || cut) && info.audioCodec) {
      // 视频 copy、音频重编码时分别归零：避免 AAC priming 在正向偏移下多出一帧声音。
      args.push('-itsoffset', (-(info.videoStart || 0)).toFixed(6), '-i', episodeFiles[i]);
      args.push('-itsoffset', (-(info.audioStart || 0)).toFixed(6), '-i', episodeFiles[i]);
      audioInput = 1;
    } else args.push('-i', episodeFiles[i]);

    args.push('-map', '0:v:0', '-sn', '-dn', '-map_metadata', '-1', '-c:v', 'copy');

    if (step.video) {
      const filters = ['setpts=PTS-STARTPTS'];
      if (vT.width && vT.height) {
        // 比多数派大的缩到多数派尺寸，小的等比例放大后补齐边（不同分辨率的集拼一起会花屏）
        filters.push(`scale=w='min(iw,${vT.width})':h='min(ih,${vT.height})':force_original_aspect_ratio=decrease`);
        filters.push(`pad=${vT.width}:${vT.height}:(ow-iw)/2:(oh-ih)/2`);
      }
      filters.push('setsar=1');
      if (vT.frameRate) filters.push(`fps=${vT.frameRateRaw || vT.frameRate}`);
      args.push('-vf', filters.join(','));
      // 编码方向照多数派：多数派 hevc 就统一 x265，绝大多数场景是 x264
      if (vT.codec === 'hevc') {
        args.push('-c:v', 'libx265', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', vT.pixFmt, '-tag:v', 'hev1');
      } else {
        const fallback = String(vT.pixFmt).includes('10') ? 'high10' : 'high';
        const profile = H264_PROFILES[String(vT.profile || '').toLowerCase()] || fallback;
        args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-profile:v', profile, '-pix_fmt', vT.pixFmt);
      }
    }

    if (silence) {
      args.push('-map', '1:a:0', '-c:a', 'aac', '-profile:a', 'aac_low', '-b:a', '128k',
        '-ar', String(aT.sampleRate), '-ac', String(aT.channels), '-shortest');
    } else if (step.dropAudio || !info.audioCodec) {
      args.push('-an');
    } else {
      args.push('-map', `${audioInput}:a:0`);
      if (step.audio) {
        args.push('-c:a', 'aac', '-profile:a', 'aac_low', '-b:a', '128k',
          '-ar', String(aT.sampleRate), '-ac', String(aT.channels));
        args.push('-af', `aresample=${aT.sampleRate}:async=1:first_pts=0`);
      } else {
        args.push('-c:a', 'copy');
      }
    }
    // 转码/补静音/裁齐时按本集视频时长截断输出，避免 apad 无限补静音导致音画不同步 / ffmpeg 永不结束
    if ((step.video || step.audio || silence || cut) && info.duration > 0) args.push('-t', String(info.duration));
    args.push('-max_muxing_queue_size', '4096');
    args.push('-video_track_timescale', String(plan.timescale), '-avoid_negative_ts', 'make_zero', '-f', 'mp4', '-y', cooked);
    await runFFmpeg(args);
    prepared[i] = cooked;
  }
  // concat 合并（统一 timescale + in-band SPS/PPS(avc3)，播放器 seek 到任意段不乱码；对照 juku-backend）
  report(62, '合并分集');
  const listFile = safeJoin(workDir, 'inputs.ffconcat');
  const lines = ['ffconcat version 1.0'];
  for (const f of prepared) lines.push(`file '${String(f).replace(/'/g, "'\\''")}'`);
  fs.writeFileSync(listFile, lines.join('\n') + '\n');
  /* 音频整轨重编码。
   *
   * 逐集编码再 concat，每集都会带一段 AAC 编码器延迟（priming，约 1 帧 = 23ms）。
   * concat 时这些 priming 不会互相抵消，而是在每个集边界留下：
   *   · 1~3 个 PTS 间隔不足 1ms 的重叠包（实测全季 800+ 处，seek 到集边界就咔哒/爆音）
   *   · 前一段尾帧被后一段首帧顶掉，视频每处丢 1~2 帧（46~53ms 空洞）
   * 把音频改成「整轨解码一次、编码一次」，全程只有一个 priming，边界从 2N 处降到 0，
   * 代价是整季音频重编一遍（4.8 小时约 3~5 分钟），视频仍然 copy，画质零损失。
   *
   * 全季参数完全一致（没有任何集需要处理）时保持原样直拼 —— 那种情况下源本来就是
   * 一路编下来的，没有 priming 叠加，反而比重新编码更干净。
   */
  const anyAudioWork = plan.steps.some(s => s.audio || s.silence || s.trim || s.sync);
  const totalDur = infos.every(x => (Number(x.duration) || 0) > 0)
    ? infos.reduce((a, x) => a + (Number(x.duration) || 0), 0) : 0;
  const wholeAudio = !!aT.present && anyAudioWork && totalDur > 0;
  const concatArgs = ['-copyts', '-protocol_whitelist', 'file,pipe', '-f', 'concat', '-safe', '0', '-i', listFile,
    '-map', '0:v:0', '-sn', '-dn'];
  if (wholeAudio) {
    console.log(`[merge] 音频整轨重编码：消除 ${infos.length - 1} 处集边界接缝，`
      + `视频保持 copy（音频 ${(totalDur / 60).toFixed(1)} 分钟）`);
    report(66, `音频整轨重编码（${(totalDur / 60).toFixed(0)} 分钟音频，消除拼接点）`);    concatArgs.push('-map', '0:a:0?', '-c:v', 'copy',
      '-c:a', 'aac', '-profile:a', 'aac_low', '-b:a', '128k',
      '-ar', String(aT.sampleRate), '-ac', String(aT.channels),
      '-af', `aresample=${aT.sampleRate}:async=1:first_pts=0`,
      /* 显式裁到视频总时长：整轨编码的 priming 会让音轨比画面长几十毫秒，
       * -shortest 只按包边界截、实测还差 14ms，必须给准确时长。 */
      '-t', totalDur.toFixed(3));
  } else {
    concatArgs.push('-map', '0:a:0?', '-c', 'copy');
  }
  concatArgs.push('-video_track_timescale', String(plan.timescale), '-movflags', '+faststart');
  // h264/hevc 产物一律 avc3/hev1（in-band SPS/PPS）：concat 后播放器 seek 到任何段都按帧内参数解码，杜绝快进花屏/乱码
  if (vT.codec === 'h264') concatArgs.push('-tag:v', 'avc3');
  else if (vT.codec === 'hevc') concatArgs.push('-tag:v', 'hev1');
  concatArgs.push('-y', outputPath);
  await runFFmpeg(concatArgs,
    wholeAudio
      ? (f) => report(66 + Math.round(f * 29), f >= 1 ? '音频重编码完成，收尾' : `音频整轨重编码 ${Math.round(f * 100)}%`)
      : null,
    wholeAudio ? totalDur : 0);

  // ---- 产物体检：音频解不干净就整轨重编码再合一次，绝不再静默出片 ----
  const expectAudio = aT.present;
  report(96, '校验合并产物音轨');
  let audit = auditOutput(outputPath, aT.sampleRate, aT.channels, expectAudio);
  if (audit.audioErrors > 0 && expectAudio) {
    console.warn(`[merge] 产物音频校验未通过（${audit.audioErrors} 处）：${audit.sample}`);
    report(97, `音轨校验未通过（${audit.audioErrors} 处），整轨重编码后再合一次`);
    const retryArgs = ['-copyts', '-protocol_whitelist', 'file,pipe', '-f', 'concat', '-safe', '0', '-i', listFile,
      '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn', '-c:v', 'copy',
      '-c:a', 'aac', '-profile:a', 'aac_low', '-b:a', '128k', '-ar', String(aT.sampleRate), '-ac', String(aT.channels),
      '-af', `aresample=${aT.sampleRate}:async=1:first_pts=0`];
    if (totalDur > 0) retryArgs.push('-t', totalDur.toFixed(3));
    retryArgs.push('-video_track_timescale', String(plan.timescale), '-movflags', '+faststart');
    if (vT.codec === 'h264') retryArgs.push('-tag:v', 'avc3');
    else if (vT.codec === 'hevc') retryArgs.push('-tag:v', 'hev1');
    retryArgs.push('-y', outputPath);
    await runFFmpeg(retryArgs);
    audit = auditOutput(outputPath, aT.sampleRate, aT.channels, expectAudio);
  }
  if (audit.audioErrors > 0) {
    throw new Error(`合并产物音频有 ${audit.audioErrors} 处解码错误`
      + (corrupt.length ? `，疑似这些集下载不完整：${corrupt.slice(0, 5).join('、')}${corrupt.length > 5 ? ` 等 ${corrupt.length} 集` : ''}` : '')
      + '，请删掉对应集重新下载后再合并');
  }
  if (audit.problems.length) console.warn(`[merge] 产物音频参数偏差（不影响播放）：${audit.problems.join('，')}`);
  /* dup 恒有 1 处（末包或首包的零长边界），是 ffmpeg 封装产物自带的，不作为异常；
   * 真正的接缝看 seams —— 整轨重编码后应当归零。 */
  if (audit.seam && (audit.seam.seams > 0 || audit.seam.dup > 1)) {
    console.warn(`[merge] 产物接缝 ${audit.seam.seams} 处 / 重复时间戳 ${audit.seam.dup} 处`
      + `（帧长 ${audit.seam.frameDur}s，共 ${audit.seam.total} 包）：集边界 seek 可能轻微咔哒，解码无误则不阻断出片`);
  } else if (audit.seam && audit.seam.total > 0) {
    console.log(`[merge] 产物接缝 0 处（${audit.seam.total} 包全连续）`);
  }
  report(100, '合并完成');
  return { text: audit.text, corrupt: corrupt.length, aligned: work, drift: drift.length,
    total: infos.length, target: targetText, seams: audit.seam ? audit.seam.seams : 0, wholeAudio };
}

// ---- 任务执行 ----
function startTask(task) {
  if (task.status !== 'queued') return;
  task.status = 'downloading';
  task.progress = { phase: 'downloading', episode: 0, total: task.episodes.length, percent: 0, detail: '准备下载' };
  touch(task);
  runTask(task).catch(err => {
    if (task.status === 'canceled') return;
    task.status = 'failed';
    task.error = err && err.message ? err.message : String(err);
    console.error(`[download] 任务失败 ${task.title}: ${task.error}`);
    task.progress.percent = 0;
    touch(task);
    flushStore(true);
  });
}

// ================= 黄果（私密）源 NAS 下载 =================
// 链路：每集页面（/video/<id>/ 或 /video/<id>/ep-<n>/）#videoInitialData JSON.videoSrc
//   → m3u8(master) 递归展开（解包 video.225600.xyz 代理层/相对路径补全/子流）
//   → 下载全部分片 + #EXT-X-KEY（AES-128）→ 写本地 playlist.m3u8 → ffmpeg -c copy 封装 mp4
//   与 APK/WebUI 播放同源取流，天然兼容源站防盗链与加密。
// 2026-11 换站：pqhybuxo.cc 整族只剩 301，实体内容在 huangguoai.io。
// 带日期的 gitiecgad.cc 是同一套站的轮换域名，旧域留最后兜底。
const HUANGGUO_SITES = ['https://huangguoai.io', 'https://0624.gitiecgad.cc', 'https://thu.pqhybuxo.cc'];

function readBackendProxy() {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'settings.json'), 'utf8'));
    return typeof s.backendProxy === 'string' ? s.backendProxy : '';
  } catch { return ''; }
}

// 解包源站自带代理层：video.225600.xyz:1314/api/huangguo-proxy?url=<真实分片>
function unwrapHgProxy(uri) {
  try {
    const u = new URL(uri);
    if (u.hostname.includes('video.225600.xyz') && /\/api\/huangguo-proxy$/.test(u.pathname)) {
      const inner = u.searchParams.get('url');
      if (inner) return new URL(inner).toString();
    }
  } catch { /* 保留原样 */ }
  return uri;
}

function hgRequest(url, referer, maxBytes, opts) {
  // curl globbing 安全：源站分片文件名可能含未编码的 ()[]{}，curl 会按 glob 解析报 error 3
  url = String(url).replace(/[\[\]\(\)\{\}]/g, c => encodeURIComponent(c));
  // 请求头策略：默认带 Accept-Encoding: identity 强制明文；noIdentity=true 时模仿播放代理
  // （源站对 identity 请求可能返回二进制/加密体，播放代理不带 identity 拿到的就是明文）
  const noIdentity = !!(opts && opts.noIdentity);
  // https 握手失败自动降级 http 重试（部分 CDN 如 tp1.drleao.cn 的 https 端口不稳，与播放代理行为一致）
  const attempt = (u, retriedHttp) => new Promise((resolve, reject) => {
    proxyFetch.requestThroughProxy(u, readBackendProxy(), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36',
        'Accept': '*/*',
        ...(noIdentity ? {} : { 'Accept-Encoding': 'identity' }),
        ...(referer ? { Referer: referer } : {}),
      },
      timeout: 30_000, maxBytes: maxBytes || 40 * 1024 * 1024, redirects: 5,
    }, (err, result) => {
      if (err) {
        if (!retriedHttp && u.startsWith('https://') && /TLS|SSL|eof|handshake|connect/i.test(err.message || '')) {
          return attempt('http://' + u.slice(8), true).then(resolve, reject);
        }
        return reject(err);
      }
      if (!result || result.status < 200 || result.status >= 300) return reject(new Error('HTTP ' + (result && result.status)));
      // 兜底解压：个别源站/代理无视 identity 仍返回压缩体（gzip 魔数 1f 8b / deflate 78 / brotli ce b2）
      let body = result.body;
      if (body && body.length > 2) {
        try {
          if (body[0] === 0x1f && body[1] === 0x8b) body = zlib.gunzipSync(body);
          else if (body[0] === 0x78 && (body[1] === 0x9c || body[1] === 0x01 || body[1] === 0x5e || body[1] === 0xda)) body = zlib.inflateSync(body);
          else if (body[0] === 0xce && body[1] === 0xb2) body = zlib.brotliDecompressSync(body);
        } catch { /* 保留原样 */ }
      }
      resolve(body);
    });
  });
  return attempt(url, false);
}

function resolveHuangguoUri(uri, base) {
  try { return new URL(unwrapHgProxy(uri), base).toString(); }
  catch { return uri; }
}

// 判断文本是否为乱码/二进制（替换符或控制字符占比超标）
function isGarbledText(text) {
  if (!text || !text.length) return false;
  let bad = 0;
  for (const ch of text) {
    if (ch === '\uFFFD' || (ch.charCodeAt(0) < 32 && ch !== '\n' && ch !== '\r' && ch !== '\t')) bad++;
  }
  return bad / text.length > 0.02;
}

// 展开 m3u8：master 里若含子流（#EXT-X-STREAM-INF）则递归取第一条子流；返回 { segments:[url], keys:[url] }
// 双策略请求：先模仿播放代理（不带 Accept-Encoding，源站对播放链路返回明文），
// 拿到的仍是乱码/二进制则换 Accept-Encoding: identity 重试（直连场景 identity 返回明文）。
async function expandHuangguoM3u8(masterUrl, referer, depth) {
  if (depth > 5) throw new Error('m3u8 层级过深');
  let body = await hgRequest(masterUrl, referer, 10 * 1024 * 1024, { noIdentity: true });
  let text = body.toString('utf8');
  if (isGarbledText(text)) {
    console.log(`[huangguo] master ${String(masterUrl).slice(0, 90)} 无编码头请求返回乱码 bytes=${body.length}，换 identity 重试`);
    body = await hgRequest(masterUrl, referer, 10 * 1024 * 1024, { noIdentity: false });
    text = body.toString('utf8');
  }
  if (isGarbledText(text)) {
    throw new Error('m3u8 内容异常（二进制/乱码）bytes=' + body.length);
  }
  // 校验返回体确实是播放列表（含 #EXT 标签）：master 里若有音轨声明(#EXT-X-MEDIA)会被误判成子流，
  // 从而把下一行分片(0.ts 等)当子流请求，拿到 ts 二进制当文本解析必然乱码。非列表内容直接抛错跳过。
  if (!/#EXT/.test(text)) {
    throw new Error('返回内容不是 m3u8 播放列表（疑似分片二进制）bytes=' + body.length);
  }
  const lines = text.split(/\r?\n/);
  const keys = [];
  const segments = [];
  const subStreams = [];
  let expectSub = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('#EXT-X-KEY')) {
      const m = line.match(/URI="([^"]+)"/);
      if (m) keys.push(resolveHuangguoUri(m[1], masterUrl));
    } else if (line.startsWith('#EXT-X-STREAM-INF')) {
      expectSub = true;
    } else if (line.startsWith('#EXT-X-MEDIA')) {
      // 音轨/字幕声明：自身带 URI 属性，不是子流，跳过（不触发 expectSub）
      expectSub = false;
    } else if (line && !line.startsWith('#')) {
      // 跳过垃圾行（含替换符/控制字符/非法 URL 前缀）
      if (/[\uFFFD\u0000-\u001F]/.test(line)) continue;
      const uri = resolveHuangguoUri(line, masterUrl);
      if (!/^https?:\/\//.test(uri)) continue;
      if (expectSub) { subStreams.push(uri); expectSub = false; continue; }
      segments.push(uri);
    }
  }
  // variant playlist：依次尝试子流，某条 CDN 风控/乱码则换下一条；
  // 全部失败但 master 自身有分片（media playlist）则回退用 master 自身分片
  if (subStreams.length) {
    let lastErr = null;
    for (const sub of subStreams) {
      try {
        console.log(`[huangguo] 展开子流 ${String(sub).slice(0, 90)}`);
        return await expandHuangguoM3u8(sub, referer, depth + 1);
      } catch (e) {
        lastErr = e;
        console.log(`[huangguo] 子流展开失败 ${String(sub).slice(0, 90)}: ${e.message}`);
      }
    }
    if (segments.length) {
      console.log(`[huangguo] 子流全部失败，回退 master 自身分片 ${segments.length} 个`);
      return { segments, keys };
    }
    throw lastErr || new Error('所有子流展开失败');
  }
  return { segments, keys };
}

// 下载一整集：返回 { bytes }；产出 plainFile（明文 MP4）。失败抛错（分片/KEY/合并产物清理由调用方兜底）
async function huangguoDownloadEpisode(seriesId, number, dir, plainFile) {
  const first = number === 1;
  const errors = [];
  let masterUrl = null;
  let masterSite = null;
  for (const site of HUANGGUO_SITES) {
    try {
      const pageUrl = first ? `${site}/video/${seriesId}/` : `${site}/video/${seriesId}/ep-${number}/`;
      const page = await hgRequest(pageUrl, `${site}/video/${seriesId}/`, 3 * 1024 * 1024);
      const html = page.toString('utf8');
      const jsonText = (html.match(/<script[^>]*id="videoInitialData"[^>]*>([\s\S]*?)<\/script>/) || [])[1]
        || (html.match(/videoInitialData["']?\s*[:=]\s*(\{[\s\S]*?\})\s*;/) || [])[1];
      if (!jsonText) throw new Error('页面无 videoInitialData');
      const data = JSON.parse(jsonText.replace(/^[\s\S]*?(?=\{)/, ''));
      let src = data.videoSrc || (Array.isArray(data.videoSrcList) ? data.videoSrcList[0] : '');
      if (!src) {
        // 2026-11 改版：详情页不再塞播放地址，改由 /api/videos/:id/play 单独下发
        const apiRes = await hgRequest(`${site}/api/videos/${seriesId}/play?ep=${number}`, `${site}/video/${seriesId}/`, 1 * 1024 * 1024);
        try { src = JSON.parse(apiRes.toString('utf8')).data.video_url || ''; } catch { src = ''; }
      }
      if (!src) throw new Error('videoSrc 为空');
      masterSite = site; // 记住解析出 m3u8 的站点，防盗链 Referer 必须用播放页所属站点
      masterUrl = resolveHuangguoUri(src, `${site}/video/${seriesId}/`);
      console.log(`[huangguo] 第 ${number} 集 页面解析成功 site=${site.replace(/^https:\/\//, '')} master=${String(masterUrl).slice(0, 110)}`);
      break;
    } catch (e) {
      errors.push(site.replace(/^https:\/\//, '') + ':' + e.message);
      console.log(`[huangguo] 第 ${number} 集 页面解析失败 site=${site.replace(/^https:\/\//, '')} 原因: ${e.message}`);
    }
  }
  if (!masterUrl) throw new Error('解析播放地址失败（' + errors.join(' | ') + '）');
  // Referer 用主站域名：源站/CDN 防盗链校验播放页域名，对不上的会被 302 到 CDN
  // 后返回风控二进制（600KB 垃圾）导致 m3u8 展开失败
  const referer = `https://huangguoai.io/video/${seriesId}/` + (first ? '' : `ep-${number}/`);
  let plan;
  try {
    plan = await expandHuangguoM3u8(masterUrl, referer, 0);
  } catch (e) {
    console.log(`[huangguo] 第 ${number} 集 m3u8 展开失败 master=${String(masterUrl).slice(0, 130)} 原因: ${e.message}`);
    throw e;
  }
  if (!plan.segments.length) throw new Error('m3u8 无分片');
  console.log(`[huangguo] 第 ${number} 集 m3u8 展开成功 分片=${plan.segments.length} keys=${plan.keys.length}`);

  const keyFiles = [];
  for (let i = 0; i < plan.keys.length; i++) {
    try {
      const k = await hgRequest(plan.keys[i], referer, 1024 * 1024);
      const f = safeJoin(dir, `key-${number}-${i}.key`);
      fs.writeFileSync(f, k);
      keyFiles.push(f);
    } catch (e) {
      console.log(`[huangguo] 第 ${number} 集 KEY 下载失败 ${String(plan.keys[i]).slice(0, 90)}: ${e.message}`);
      throw e;
    }
  }

  // 并发下载全部分片（源站分片通常数百 KB～数 MB）
  // 下载失败自动重试：403/瞬时限流换 Referer 变体（www/thu/m 站点域名各试一次），仍失败才报错
  const segFiles = new Array(plan.segments.length);
  let nextSeg = 0;
  const segReferers = [referer, `https://0624.gitiecgad.cc/video/${seriesId}/` + (first ? '' : `ep-${number}/`), `https://thu.pqhybuxo.cc/video/${seriesId}/` + (first ? '' : `ep-${number}/`)];
  await Promise.all(Array.from({ length: Math.min(6, plan.segments.length) }, async () => {
    while (nextSeg < plan.segments.length) {
      const i = nextSeg++;
      let buf = null;
      let lastErr = null;
  for (const rf of segReferers) {
        try { buf = await hgRequest(plan.segments[i], rf, 60 * 1024 * 1024); break; }
        catch (e) { lastErr = e; }
      }
      if (buf === null) {
        console.log(`[huangguo] 第 ${number} 集 分片 ${i} 下载失败(换 ${segReferers.length} 个站点 Referer 均失败): ${lastErr && lastErr.message} url=${String(plan.segments[i]).slice(0, 110)}`);
        throw lastErr || new Error(`分片 ${i} 下载失败`);
      }
      const f = safeJoin(dir, `seg-${number}-${String(i).padStart(4, '0')}.ts`);
      fs.writeFileSync(f, buf);
      segFiles[i] = f;
    }
  }));
  for (let i = 0; i < segFiles.length; i++) {
    if (!segFiles[i]) { const e = new Error('分片下载不完整（第 ' + (i + 1) + '/' + segFiles.length + ' 片缺失）'); cleanupHg(segFiles, keyFiles); throw e; }
  }

  // 写本地 playlist（分片/KEY 用本地相对路径），ffmpeg 原生支持 AES-128 解密
  const playlist = safeJoin(dir, `play-${number}.m3u8`);
  const keyTag = keyFiles.length ? `#EXT-X-KEY:METHOD=AES-128,URI="${path.basename(keyFiles[0])}"\n` : '';
  const content = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:12\n#EXT-X-MEDIA-SEQUENCE:0\n'
    + keyTag + segFiles.map(f => '#EXTINF:4.0,\n' + path.basename(f)).join('\n') + '\n#EXT-X-ENDLIST\n';
  fs.writeFileSync(playlist, content);
  try {
    await runFFmpeg(['-allowed_extensions', 'ALL', '-i', playlist, '-c', 'copy', '-f', 'mp4', '-y', plainFile]);
  } finally {
    cleanupHg(segFiles, keyFiles);
    try { fs.rmSync(playlist, { force: true }); } catch { }
  }
  if (!fs.existsSync(plainFile) || fs.statSync(plainFile).size < 1024) throw new Error('合并产物无效');
}

function cleanupHg(segFiles, keyFiles) {
  for (const f of segFiles || []) { try { if (f) fs.rmSync(f, { force: true }); } catch { } }
  for (const f of keyFiles || []) { try { if (f) fs.rmSync(f, { force: true }); } catch { } }
}

async function runTask(task) {
  const dir = taskDir(task);
  const workDir = safeJoin(dir, '.merge-work');
  fs.mkdirSync(workDir, { recursive: true });
  const outName = `${sanitizeName(task.title)}_全${task.episodes.length}集.mp4`;
  const outputPath = safeJoin(DOWNLOAD_DIR, outName);

  // 黄果（私密）源：记录播放页 Referer 基准（分片/CDN 防盗链校验），并预取每集 m3u8
  if (task.source === 'huangguo' && !task._hgPlayReferer) {
    task._hgPlayReferer = `https://huangguoai.io/video/${task.seriesId}/`;
  }

  // 红果 App 取流升级（v0.13.45）：官方接口多清晰度选最高档（随机设备+签名，NAS 家宽出口）。
  // 解析链路（NAS 自主，手机端只推 seriesId/title/集数）：
  //   A. seriesId 直接 videoDetail 拿 vid
  //   B. A 失败 → 标题搜索 hongguoduanju.com 匹配真 series_id → videoDetail
  //   C. 仍失败 → 下载 worker 惰性抓镜像站网页源保底（低码率，仅兜底）
  if (task.source === 'hongguo' && !task._appVids) {
    if (!task._webId) task._webId = task.seriesId; // 保留手机推来的原始 ID（网页源保底用）
    let vids = null;
    // 手机端直推的 vids（APK 用无签名 video_detail 解析官方 vid）：直接注入，绕开 NAS 端签名风控
    if (Array.isArray(task.vids) && task.vids.length >= task.episodes.length) {
      vids = task.vids.map(v => String(v));
      console.log(`[hongguo-app] ${task.title} 手机端注入 ${vids.length} 个 vid`);
    } else if (task.seriesId) {
      try {
        const det = await hgApp.videoDetail(task.seriesId);
        if (det.vids && det.vids.length >= task.episodes.length) vids = det.vids;
        else console.log(`[hongguo-app] ${task.title} seriesId=${task.seriesId} 集数不足(${det.vids ? det.vids.length : 0}/${task.episodes.length})`);
      } catch (e) {
        console.log(`[hongguo-app] ${task.title} videoDetail(${task.seriesId}) 失败: ${e.message}`);
      }
    }
    if (!vids) {
      try {
        const sid = await hgApp.searchSeries(task.title, task.episodes.length);
        if (sid) {
          console.log(`[hongguo-app] ${task.title} 标题搜索命中 series_id=${sid}`);
          task.seriesId = sid;
          const det = await hgApp.videoDetail(sid);
          if (det.vids && det.vids.length >= task.episodes.length) vids = det.vids;
        }
      } catch (e) {
        console.log(`[hongguo-app] ${task.title} 标题搜索匹配失败: ${e.message}`);
      }
    }
    if (vids) {
      task.episodes.forEach((ep, i) => { ep.vid = vids[i]; });
      task._appVids = true;
      console.log(`[hongguo-app] ${task.title} 注入 ${vids.length} 个 vid，走 App 最高清晰度取流`);
    } else {
      console.log(`[hongguo-app] ${task.title} App 源不可用，将走网页源保底`);
    }
    touch(task);
    flushStore(true);
  }

  // 下载阶段（并发 N 集，多轮自动重试）：
  //  - 每轮只下载未成功的分集；失败集自动进入下一轮，下一轮重新取流换新 URL（解决 403/地址过期）
  //  - 全部成功或达到自动重试轮数后结束；仍失败的集保留在 failedEpisodes，可手动重试失败集
  // 红果 CDN 校验 Referer：带 Referer 反而 403，必须不带（实测 5 种域无 Referer 均 200）
  const headersFor = ep => {
    const h = ep.key
      ? { 'User-Agent': HONGGUO_VIDEO_UA, 'Accept-Encoding': 'identity' }
      : { 'User-Agent': BROWSER_UA, 'Accept-Encoding': 'identity' };
    // 网页源直链（镜像站）防盗链：下载必须带镜像站 Referer，否则源站 403
    if (ep._webReferer) h['Referer'] = ep._webReferer;
    // App 源 CDN 直链：源站要求 Referer 时也带上（取流 URL 同域）
    else if (ep._appReferer) h['Referer'] = ep._appReferer;
    return h;
  };
  const signal = { aborted: false };
  const AUTO_RETRY_ROUNDS = 2; // 初始 1 轮 + 自动补 2 轮（每轮重新取流）
  let downloaded = 0;
  for (let round = 0; round <= AUTO_RETRY_ROUNDS; round++) {
    const queue = task.episodes.map((ep, idx) => ({ ep, idx })).filter(item => !item.ep._ok);
    if (queue.length === 0) break;
    if (round > 0) {
      task.progress.detail = `自动重试第 ${round} 轮（剩余 ${queue.length} 集）`;
      touch(task);
    }
    const workers = [];
    let next = 0;
    for (let w = 0; w < Math.min(CONCURRENCY, queue.length); w++) {
      workers.push((async () => {
        while (!signal.aborted) {
          const item = queue[next++];
          if (!item) break;
          const { ep, idx } = item;
          const plainFile = safeJoin(dir, epName(idx + 1)); // 明文分集
          task.progress.episode = idx + 1;
          task.progress.detail = `下载第 ${idx + 1}/${queue.length} 集`;
          touch(task);
          let attempt = 0;
          while (attempt <= RETRIES && !signal.aborted) {
            try {
              const started = Date.now();
              // 红果 App 取流：每轮每集首次尝试重新取流（换新 URL 解 403/过期；失败保留旧 url 降级网页源）
              if (ep.vid && attempt === 0) {
                try {
                  const s = await hgApp.videoModel(ep.vid);
                  if (s && s.url) {
                    ep.url = s.url;
                    ep.key = s.key || '';
                    ep.altUrls = (s.altUrls || []).slice(0, 4);
                    ep._appSource = true;
                    // App 源 CDN 防盗链校验：下载带取流 URL 同域 Referer（源站要求 Referer 时避免 403）
                    try { ep._appReferer = 'https://' + new URL(s.url).host + '/'; } catch { ep._appReferer = ''; }
                    task.progress.detail = `第 ${idx + 1} 集取流 ${s.quality || ''}`;
                  }
                } catch (e) {
                  console.log(`[hongguo-app] 第 ${idx + 1} 集取流失败，降级网页源: ${e.message}`);
                }
              }
              // 仍无播放地址（手机端未推 URL 且 App 源不可用）：NAS 自抓镜像站网页源保底
              if (!ep.url && attempt === 0) {
                try {
                  const web = await hgApp.fetchWebUrl(task._webId || task.seriesId, idx + 1);
                  ep.url = web.url;
                  ep.key = '';
                  ep._webReferer = web.referer || ''; // 镜像站直链防盗链：下载时带 Referer，否则 403
                  console.log(`[hongguo-app] 第 ${idx + 1} 集网页源保底获取成功`);
                } catch (e) {
                  throw new Error(`第 ${idx + 1} 集网页源解析失败: ${e.message}`);
                }
              }
              if (task.source === 'huangguo') {
                // 黄果（私密）源：每集页面解析 videoSrc(m3u8) → 分片下载 → ffmpeg 封装（一次完成）
                task.progress.detail = `第 ${idx + 1} 集处理中`;
                touch(task);
                await huangguoDownloadEpisode(task.seriesId, idx + 1, dir, plainFile);
              } else if (ep.key) {
                // 红果 CENC-AES-CTR：完整下载密文后由 ffmpeg -decryption_key 本地解密（与 juku-backend 一致，
                // ffmpeg mov demuxer 原生支持 CENC，产物为标准明文 MP4；避免对不支持 Range 的服务器直连拉流）
                const rawFile = safeJoin(dir, epEncName(idx + 1));
                task.progress.detail = `下载第 ${idx + 1} 集`;
                touch(task);
                await downloadWithFallback([ep.url, ...(ep.altUrls || [])], rawFile, headersFor(ep), received => {
                  if (signal.aborted) return;
                  task.progress.percent = Math.min(98, Math.round((downloaded + Math.min(1, received / 1e8)) / task.episodes.length * 100));
                  touch(task);
                }, signal);
                task.progress.detail = `解密第 ${idx + 1} 集`;
                touch(task);
                try {
                  await runFFmpeg(['-decryption_key', ep.key, '-i', rawFile, '-c', 'copy', '-f', 'mp4', '-y', plainFile]);
                } finally {
                  fs.rmSync(rawFile, { force: true });
                }
              } else {
                const rawFile = safeJoin(dir, epEncName(idx + 1));
                await downloadWithFallback([ep.url, ...(ep.altUrls || [])], rawFile, headersFor(ep), received => {
                  if (signal.aborted) return;
                  task.progress.percent = Math.min(98, Math.round((downloaded + Math.min(1, received / 1e8)) / task.episodes.length * 100));
                  touch(task);
                }, signal);
                fs.renameSync(rawFile, plainFile);
              }
              const size = fs.statSync(plainFile).size;
              ep._ok = true;
              downloaded++;
              task.progress.percent = Math.min(98, Math.round(downloaded / task.episodes.length * 100));
              task.progress.detail = `已下载 ${downloaded}/${task.episodes.length} 集`;
              touch(task);
              if (Date.now() - started > REDOWNLOAD_TIMEOUT_MS) throw new Error('播放地址超时失效，请重新提交');
              break;
            } catch (err) {
              fs.rmSync(safeJoin(dir, epEncName(idx + 1)), { force: true });
              fs.rmSync(plainFile, { force: true });
              attempt++;
              if (attempt > RETRIES) {
                // 单集失败不中断整剧：标记失败集进入下一轮自动重试，其余分集继续
                ep.failed = true;
                ep.error = err.message;
                console.log(`[download] ${task.title} 第 ${idx + 1} 集失败(已重试 ${RETRIES} 次): ${err.message}`);
                if (!task.failedEpisodes) task.failedEpisodes = [];
                if (!task.failedEpisodes.some(f => f.index === idx + 1)) task.failedEpisodes.push({ index: idx + 1, error: err.message });
                task.progress.detail = `第 ${idx + 1} 集失败（将自动重试）`;
                touch(task);
                break;
              }
              await new Promise(r => setTimeout(r, 1500 * attempt));
            }
          }
        }
      })());
    }
    await Promise.all(workers);
    if (task.status === 'canceled') return;
    const remaining = task.episodes.filter(ep => !ep._ok).length;
    if (remaining === 0 || round >= AUTO_RETRY_ROUNDS) break;
  }
  signal.aborted = true;
  if (task.status === 'canceled') return;

  // 手动合并：下载完成后保留分集，等待用户在下载管理里点「合并」再合并（不再自动合并）
  task.status = 'ready';
  const appCount = task.episodes.filter(ep => ep._appSource).length;
  const failedCount = (task.failedEpisodes || []).length;
  const sourceNote = task._appVids ? `（红果 App 源 ${appCount}/${task.episodes.length} 集）` : '（网页源）';
  if (failedCount > 0) {
    task.progress = { phase: 'ready', episode: downloaded, total: task.episodes.length, percent: 100, detail: `已下载 ${downloaded}/${task.episodes.length} 集，失败 ${failedCount} 集${sourceNote}，可重试失败集或先合并成功部分` };
  } else {
    task.progress = { phase: 'ready', episode: task.episodes.length, total: task.episodes.length, percent: 100, detail: `已下载 ${task.episodes.length} 集${sourceNote}，待合并` };
  }
  touch(task);
  flushStore(true);
}

/** 合并阶段（runTask 拆分）：合并分集 -> 单文件，成功后清理分集目录 */
async function mergeStage(task, dir, workDir) {
  // 失败的分集跳过，只合并已成功下载的分集；产物名用成功数
  const okEpisodes = task.episodes.filter(ep => !ep.failed);
  if (okEpisodes.length === 0) throw new Error('没有可合并的成功分集');
  const outName = `${sanitizeName(task.title)}_全${okEpisodes.length}集.mp4`;
  const outputPath = safeJoin(dir, outName);
  task.status = 'merging';
  task.progress.phase = 'merging';
  /* 合并从 0 开始算：以前预置 98，紧接着 mergeEpisodes 又 report(0) 把进度条打回 0，
     前端看起来就是"进度条先满再倒退"。 */
  task.progress.percent = 0;
  task.progress.detail = `开始合并（成功 ${okEpisodes.length} 集${(task.failedEpisodes || []).length ? `，跳过失败 ${task.failedEpisodes.length} 集` : ''}）`;
  touch(task);
  const files = task.episodes.map((_, i) => safeJoin(dir, epName(i + 1)))
    .filter((f, i) => !task.episodes[i].failed);
  const summary = await mergeEpisodes(files, outputPath, workDir, (percent, detail) => {
    task.progress.percent = percent;
    task.progress.detail = detail;
    touch(task);
  });
  if (task.status === 'canceled') return;

  // 清理分集与中间文件（保留合并产物 outputPath 与同剧目录其它产物）
  try {
    if (fs.existsSync(dir)) {
      for (const k of fs.readdirSync(dir)) {
        if (k === path.basename(outputPath)) continue;
        const episodeFile = k.endsWith('.mp4') || k.endsWith('.enc');
        // 保留分集时只留下每集的 mp4/enc，中间文件照样清掉
        if (episodeFile && KEEP_EPISODES) continue;
        if (episodeFile || k === '.merge-work' || k.endsWith('.ffconcat')) {
          fs.rmSync(safeJoin(dir, k), { recursive: true, force: true });
        }
      }
    }
  } catch { /* ignore */ }
  task.status = 'done';
  task.output = outputPath;
  task.progress = {
    phase: 'done',
    episode: okEpisodes.length,
    total: task.episodes.length,
    percent: 100,
    detail: summary && summary.text
      ? `完成（${summary.text}；${summary.aligned
        ? `${summary.aligned}/${summary.total} 集已按目标参数统一后合并`
        : '全部剧集参数一致，无损合并'}）`
      : '完成',
  };
  touch(task);
  flushStore(true);
}

/** 手动合并：等待合并信号后执行（任务须处于 ready/failed 状态，合并失败保留分集可重试） */
function mergeTask(id, owner, isAdmin) {
  const t = tasks[id];
  if (!t) return null;
  if (!isAdmin && t.owner && t.owner !== owner) return null;
  if (t.status !== 'ready' && t.status !== 'failed') throw new Error('当前状态不可合并（需先完成下载）');
  const dir = taskDir(t);
  const workDir = safeJoin(dir, '.merge-work');
  fs.mkdirSync(workDir, { recursive: true });
  t.error = '';
  t.status = 'merging';
  t.progress.phase = 'merging';
  t.progress.percent = 0;
  t.progress.detail = '开始合并';
  touch(t);
  mergeStage(t, dir, workDir).catch(err => {
    if (t.status === 'canceled') return;
    t.status = 'failed';
    t.error = err && err.message ? err.message : String(err);
    t.progress.percent = 0;
    t.progress.detail = '合并失败，可重试';
    touch(t);
    flushStore(true);
  });
  return publicTask(t);
}

/** 重试失败分集：只重下 failedEpisodes 标记的集（已下载的成功分集保留不动），重新取流换新 URL。 */
function retryFailedEpisodes(id, owner, isAdmin) {
  const t = tasks[id];
  if (!t) return null;
  if (!isAdmin && t.owner && t.owner !== owner) return null;
  if (t.status !== 'ready' && t.status !== 'failed') throw new Error('当前状态不可重试失败集');
  const failed = (t.failedEpisodes || []).filter(f => f && f.index);
  if (failed.length === 0) throw new Error('没有失败分集');
  t.failedEpisodes = [];
  t.error = '';
  for (const f of failed) {
    const ep = t.episodes[f.index - 1];
    if (ep) { ep._ok = false; ep.failed = false; ep.error = ''; }
  }
  t.status = 'queued';
  startTask(t);
  return publicTask(t);
}

// ---- 对外 API ----
function createTask({ source, title, seriesId, episodes, owner, cover, upload }) {
  if (!Array.isArray(episodes) || episodes.length === 0) throw new Error('没有可下载的分集');
  const norm = [];
  for (let i = 0; i < episodes.length; i++) {
    const raw = episodes[i];
    if (typeof raw === 'number') { norm.push({ index: i + 1, url: '', key: '' }); continue; }
    if (typeof raw === 'object' && raw !== null && raw.index != null) { norm.push({ index: Number(raw.index), url: String(raw.url || ''), key: raw.key ? String(raw.key) : '' }); continue; }
    throw new Error('分集参数无效');
  }
  for (const ep of norm) {
    if (ep.url && !/^https?:\/\//.test(ep.url)) throw new Error('分集播放地址无效');
    if (ep.key && !/^[0-9a-f]{32}$/i.test(ep.key)) throw new Error('分集内容密钥无效');
  }
  const id = crypto.randomBytes(8).toString('hex');
  const task = {
    id, source: source === 'huangguo' ? 'huangguo' : 'hongguo',
    title: sanitizeName(title), seriesId: String(seriesId || ''),
    cover: String(cover || ''),   // 详情页封面：手机下载列表 NAS 行直接显示，不用再灰块
    episodes: norm,
    status: 'queued', owner: String(owner || ''), output: '', failedEpisodes: [],
    progress: { phase: 'queued', episode: 0, total: norm.length, percent: 0, detail: '排队中' },
    createdAt: Date.now(), updatedAt: Date.now(), error: '',
    // 下载完成后要传到哪个远程存储（由服务端上传监视器消费）
    upload: upload || null,
  };
  tasks[id] = task;
  touch(task);
  flushStore(true);
  startTask(task);
  return publicTask(task);
}

function publicTask(t) {
  const p = t.progress || {};
  const total = p.total || t.episodes.length || 0;
  const done = p.episode || 0;
  const failedEpisodes = (t.failedEpisodes || []).filter(f => f && f.index);
  return {
    id: t.id, source: t.source, title: t.title, seriesId: t.seriesId, status: t.status,
    cover: t.cover || '',   // 详情页封面（手机端下载列表 NAS 行显示）
    output: t.output, progress: t.progress, error: t.error,
    failedEpisodes: failedEpisodes.map(f => ({ index: f.index, error: f.error || '' })),
    createdAt: t.createdAt, updatedAt: t.updatedAt,
    episodeCount: t.episodes.length, owner: t.owner,
    upload: t.upload || null,
    percent: p.percent || (t.status === 'done' ? 100 : 0),
    detail: p.detail || (t.status === 'done' ? '完成' : ''),
    doneCount: t.status === 'done' ? t.episodes.length
      : (failedEpisodes.length > 0 ? t.episodes.length - failedEpisodes.length : done),
    totalCount: total,
  };
}
function listTasks(owner, isAdmin) {
  const all = Object.values(tasks).sort((a, b) => b.createdAt - a.createdAt);
  return (isAdmin ? all : all.filter(t => !t.owner || t.owner === owner)).map(publicTask);
}
function getTask(id, owner, isAdmin) {
  const t = tasks[id];
  if (!t) return null;
  if (!isAdmin && t.owner && t.owner !== owner) return null;
  return publicTask(t);
}
/** 原始任务（含 episodes 明细/文件路径信息），供手机拉取分集文件使用 */
function getRawTask(id, owner, isAdmin) {
  const t = tasks[id];
  if (!t) return null;
  if (!isAdmin && t.owner && t.owner !== owner) return null;
  return t;
}
/** 任务工作目录（DOWNLOAD_DIR/<sanitize title>） */
function taskDirOf(t) { return taskDir(t); }

/** 局部更新任务字段（上传状态、清理标记等），只改传进来的键。 */
function patchTask(id, patch) {
  const t = tasks[id];
  if (!t) return null;
  Object.assign(t, patch || {});
  touch(t);
  flushStore(true);
  return publicTask(t);
}
function deleteTask(id, owner, isAdmin) {
  const t = tasks[id];
  if (!t) return false;
  if (!isAdmin && t.owner && t.owner !== owner) return false;
  t.status = 'canceled';
  t.error = '已取消';
  touch(t);
  const dir = taskDir(t);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  try {
    if (t.output && fs.existsSync(t.output)) fs.rmSync(t.output, { force: true });
  } catch { /* ignore */ }
  delete tasks[id];
  flushStore(true);
  return true;
}
/**
 * 桌面端可以改下载目录与并发数（后端不调用这两个函数，行为不变）。
 * 改目录后立刻校验可写，返回真正生效的目录。
 */
function setDownloadDir(dir) {
  if (!dir) return DOWNLOAD_DIR;
  DOWNLOAD_DIR = String(dir);
  ensureDirs();
  flushStore(true);
  return DOWNLOAD_DIR;
}
function setMergeOptions(options) {
  if (options && typeof options.keepEpisodes === 'boolean') KEEP_EPISODES = options.keepEpisodes;
  return { keepEpisodes: KEEP_EPISODES };
}
function setConcurrency(value) {
  const n = parseInt(value, 10);
  if (Number.isFinite(n) && n >= 1) CONCURRENCY = Math.min(16, n);
  return CONCURRENCY;
}
function ensureDirs() {
  // /video 不可写时回退：DATA_DIR/video → 当前目录/video → 系统临时目录
  const resolved = resolveWritableDir(DOWNLOAD_DIR, [
    path.join(DATA_DIR, 'video'),
    path.join(process.cwd(), 'video'),
    path.join(os.tmpdir(), 'veyra-video'),
  ]);
  if (!resolved) throw new Error('没有可用的下载目录（请设置 DOWNLOAD_DIR）');
  if (resolved !== DOWNLOAD_DIR) {
    console.warn(`[downloader] 默认下载目录 ${DOWNLOAD_DIR} 不可写，回退为 ${resolved}`);
    DOWNLOAD_DIR = resolved;
  }
}
function status() {
  ensureDirs();
  const ffmpeg = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8', timeout: 10_000 });
  const ffprobe = spawnSync('ffprobe', ['-version'], { encoding: 'utf8', timeout: 10_000 });
  return {
    downloadDir: DOWNLOAD_DIR,
    writable: (() => { try { fs.accessSync(DOWNLOAD_DIR, fs.constants.W_OK); return true; } catch { return false; } })(),
    ffmpeg: ffmpeg.status === 0, ffprobe: ffprobe.status === 0,
    tasks: Object.keys(tasks).length,
  };
}

loadTasks();
ensureDirs();

module.exports = { createTask, listTasks, getTask, getRawTask, taskDirOf, patchTask, deleteTask, mergeTask, retryFailedEpisodes, status, setDownloadDir, setConcurrency, setMergeOptions, mergeEpisodes, epName, safeJoin };
