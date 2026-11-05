import { createRequire } from 'node:module';
import path from 'node:path';
import { serverDir } from './paths';
import { fetchText } from './http';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * 直接复用仓库里 server/ 的解析与下载实现，不在桌面端重写一遍：
 *  - hongguo-app.js     签名取流（纯 JS，不依赖原生）
 *  - hongguo-content.js 首页/分类/搜索解析
 *  - downloader.js      多集并发下载 + ffmpeg 解密 + 合并
 * 这些文件随安装包放在 resources/server，开发时直接读仓库目录。
 */
let cached: { hgApp: any; content: any; contentModule: any; downloader: any } | null = null;

export function serverModules() {
  if (cached) return cached;
  const dir = serverDir();
  const req = createRequire(path.join(dir, 'index.js'));
  const hgApp = req('./hongguo-app.js');
  const contentModule = req('./hongguo-content.js');
  const downloader = req('./downloader.js');
  const content = contentModule.createHongguoContent((url: string, timeoutMs: number) => fetchText(url, timeoutMs));
  cached = { hgApp, content, contentModule, downloader };
  return cached;
}
