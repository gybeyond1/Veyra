#!/usr/bin/env node
/**
 * 把 mpv 拉进安装包。
 *
 * 为什么需要它：Electron 内置的 Chromium 不带 HEVC 解码器，H.265 只能转码；
 * mpv 自带完整 ffmpeg，直接硬解原片。二进制不放进 git（几十 MB），
 * 打包前跑一次本脚本即可。
 *
 * 用法：
 *   node scripts/fetch-mpv.mjs            # 没下过就下
 *   node scripts/fetch-mpv.mjs --force    # 强制重下
 *   MPV_URL=<直链> node scripts/fetch-mpv.mjs
 *   MPV_ARCHIVE=D:\mpv.7z node scripts/fetch-mpv.mjs   # 用本地压缩包
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(desktopDir, 'resources', 'mpv');
const force = process.argv.includes('--force');
const exeName = process.platform === 'win32' ? 'mpv.exe' : 'mpv';
const target = path.join(outDir, exeName);

if (process.platform !== 'win32') {
  console.log(`[mpv] 当前是 ${process.platform}，开发时直接用系统 mpv，跳过内置二进制`);
  process.exit(0);
}

if (!force && fs.existsSync(target)) {
  const size = (fs.statSync(target).size / 1024 / 1024).toFixed(1);
  console.log(`[mpv] 已有 ${target}（${size} MB），跳过。要重下加 --force`);
  process.exit(0);
}

function request(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('重定向太多次'));
    const req = https.get(
      url,
      { headers: { 'user-agent': 'veyra-build', accept: '*/*' } },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          const next = new URL(res.headers.location, url).toString();
          return resolve(request(next, redirects + 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}：${url}`));
        }
        resolve(res);
      },
    );
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('下载超时')));
  });
}

async function download(url, dest) {
  const res = await request(url);
  const total = Number(res.headers['content-length']) || 0;
  let done = 0;
  let lastTick = 0;
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  const file = fs.createWriteStream(dest);
  res.on('data', (chunk) => {
    done += chunk.length;
    const now = Date.now();
    if (now - lastTick > 800) {
      lastTick = now;
      const pct = total ? ` ${((done / total) * 100).toFixed(0)}%` : '';
      process.stdout.write(`\r[mpv] 下载中 ${(done / 1024 / 1024).toFixed(1)} MB${pct}   `);
    }
  });
  /* 等 close 而不是 finish：finish 只表示数据交给了写入流，句柄可能还开着。
     Windows 上紧接着用 7za 解压会因为「文件被另一个进程占用」读到 0 字节 —— 
     上一次 CI 就是栽在这里。 */
  await new Promise((resolve, reject) => {
    res.on('error', reject);
    file.on('error', reject);
    file.on('close', resolve);
    res.pipe(file);
  });
  process.stdout.write('\n');
  const size = fs.statSync(dest).size;
  if (size < 1024 * 1024) throw new Error(`下载不完整（${size} 字节）`);
  if (total && size !== total) throw new Error(`下载不完整（${size}/${total} 字节）`);
}

/** 下载失败重试一次：SourceForge 偶尔掐连接，重试比让人手动重跑省钱。 */
async function downloadWithRetry(url, dest) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await download(url, dest);
      return;
    } catch (error) {
      if (attempt === 2) throw error;
      console.log(`[mpv] 下载失败（${error.message}），重试一次`);
      try { fs.rmSync(dest, { force: true }); } catch { /* 本来就是残文件 */ }
    }
  }
}

/**
 * 固定版本的下载地址。不去查 GitHub API：CI 上未登录的 API 每小时只有 60 次，
 * 而且我们要的是可复现的版本，不是「今天最新」。
 * 需要换版本时改这一行，或用 MPV_URL / MPV_ARCHIVE 覆盖。
 */
const DEFAULT_URL =
  'https://sourceforge.net/projects/mpv-player-windows/files/64bit/mpv-x86_64-20261101-git-48fca90e8c.7z/download';

async function latestAsset() {
  return process.env.MPV_URL || DEFAULT_URL;
}

async function unzip(archive, dest) {
  const { path7za } = await import('7zip-bin');
  execFileSync(path7za, ['x', archive, `-o${dest}`, '-y'], { stdio: 'inherit' });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-mpv-'));
try {
  const local = process.env.MPV_ARCHIVE;
  let archive;
  if (local && fs.existsSync(local)) {
    archive = local;
    console.log(`[mpv] 用本地压缩包 ${local}`);
  } else {
    const url = process.env.MPV_URL || (await latestAsset());
    console.log(`[mpv] 从 ${url} 下载`);
    archive = path.join(tmp, 'mpv.7z');
    await downloadWithRetry(url, archive);
  }

  const unpacked = path.join(tmp, 'unpacked');
  await unzip(archive, unpacked);

  // 压缩包里是一堆 exe/dll，只留运行时需要的东西
  fs.mkdirSync(outDir, { recursive: true });
  let copied = 0;
  for (const name of fs.readdirSync(unpacked)) {
    if (!/\.(exe|dll)$/i.test(name)) continue;
    fs.copyFileSync(path.join(unpacked, name), path.join(outDir, name));
    copied += 1;
  }
  if (!fs.existsSync(target)) throw new Error('解压后没找到 mpv.exe');
  fs.writeFileSync(
    path.join(outDir, 'VERSION.txt'),
    `source=${archive}\nfetched=${new Date().toISOString()}\n`,
  );
  const size = (fs.statSync(target).size / 1024 / 1024).toFixed(1);
  console.log(`[mpv] 完成：${copied} 个文件，mpv.exe ${size} MB → ${outDir}`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
