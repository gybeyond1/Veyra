# Veyra 桌面端（Windows）

手机端 / TV 端之外的第三个客户端。不是把 WebUI 塞进窗口：界面用 React 重写，
解析、下载、合并走本机，只有账号和片单同步依赖后端。

## 现在能做什么

| 能力 | 状态 | 说明 |
|---|---|---|
| 登录 | 可用 | 服务器地址 + 账号密码；token 用系统凭据加密存盘（Windows DPAPI） |
| 扫码登录 | 可用 | 窗口显示二维码，手机 Veyra App「扫一扫」直接授权，App 不用改 |
| 注册 | 可用 | 需要管理员 6 位动态码，和手机端一致 |
| 浏览 | 可用 | 首页推荐 / 最新、分类（短剧 / 漫剧 + 题材）、搜索、详情、选集 |
| 下载 | 可用 | 本机多集并发、失败集自动重试、任务持久化、断点目录复用 |
| 合并 | 可用 | 下载完成自动合并（可在设置里关），编码不一致时先统一转码 |
| 设置 | 可用 | 下载目录、并发数、自动合并、合并后保留分集、出站代理 |
| 播放 | 未做 | 当前用「打开目录」交给系统播放器；内置播放器在下一阶段 |
| 片单同步 | 半成品 | 主进程已接 `/api/library`，界面还没做「我的追剧」页 |

## 为什么能复用

`server/` 里的这几个文件是纯 Node、零原生依赖，主进程直接 `require`：

- `hongguo-app.js`：签名取流（`videoDetail` / `videoModel` / `deriveKey`）
- `hongguo-content.js`：首页 / 分类 / 搜索 / 详情解析
- `downloader.js`：并发下载、ffmpeg 解密、concat 合并
- `hongguo-sign.js`、`proxy-fetch.js`：签名与抓取底层

开发时读仓库目录，打包后从 `resources/server` 读。**不在桌面端复制一份**，
后端改了这里跟着生效。

`downloader.js` 只加了三个桌面端要用的函数（`setDownloadDir` / `setConcurrency` /
`setMergeOptions`），后端不调用，行为不变。

## 开发

```bash
cd desktop
npm install          # 首次会拉 Electron 与 ffmpeg 二进制
npm run dev          # Vite + 主进程 watch + Electron
npm run typecheck
npm run build
```

要求 Node 20+，Windows 上另有系统 curl（Win10 1803 起自带）用于抓源站网页。

## 打包

```bash
npm run dist:win     # 产出 release/Veyra-Desktop-<version>-x64.exe
```

Windows 包必须在 Windows（或带 wine 的 Linux）上构建，CI 走
`.github/workflows/desktop-build.yml`（windows-latest）。

安装包自带 ffmpeg / ffprobe，用户机器不需要另装。

## 目录

```
src/main/        主进程：窗口、IPC、登录、扫码、下载、设置
  catalog.ts     浏览（复用 server 解析）
  downloads.ts   下载任务（复用 server/downloader）
  qrlogin.ts     局域网扫码登录（协议与 TV 端一致：veyra://tv-login?...）
  ipc.ts         渲染层可调用的全部方法 + 下载进度推送
src/preload/     contextBridge，只暴露 call / onEvent
src/renderer/    React 界面（登录、首页、分类、详情、下载、设置）
src/shared/      两端共用的类型
```

## 扫码登录协议

二维码内容是：

```
veyra://tv-login?h=<电脑局域网IP>&p=<临时端口>&t=<一次性token>&c=<6位码>&n=<电脑名>
```

手机 App 的 `QrScanActivity` 扫到后 POST 到 `http://h:p/login?t=<token>`，
body `{code, token, server, user}`。电脑校验 token + code（5 分钟有效）后落盘会话。
和 TV 端完全同一条链路，所以手机端不需要任何改动。

## 已知限制

- 只出了 Windows x64 安装包；macOS / Linux 已能本地跑，未做打包
- 在线播放未做：红果是 CENC 加密流，要内置播放得先本地解密转封装
- 未签名 exe，SmartScreen 可能提示「未知发布者」
- 内容版权归各源站所有，仅限自用
