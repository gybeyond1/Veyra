# Veyra

自建短剧播放系统：**Android 手机 + Android TV + Windows 桌面端 + Node.js 后端**。

不是套壳聚合——片源接入、下载合并、账号权限、双端界面、热更新，都在这一个仓库里。

> 派生自 [MrSsg/HuangguoAPP-for-Andriod](https://github.com/MrSsg/HuangguoAPP-for-Andriod)（GPL-3.0），已独立为 Veyra 品牌：独立包名、独立后端镜像、独立数据目录。
> 内容版权归各源站所有，本项目只提供技术实现，请勿用于商业或传播用途。

---

## 能力清单

### 手机端（`mobile` flavor，包名 `com.veyra.gybeyond`）

| 模块 | 实际情况 |
|---|---|
| 浏览 | 首页推荐、分类、标签、搜索、详情、观看记录、收藏 |
| 播放 | Media3 / ExoPlayer；红果 CENC 加密流本地解密播放，黄果直连或经后端中继 |
| 下载 | **10 路并发**；单集失败不拖垮整批，失败集可单独重试；已下载分集重试时直接复用 |
| 合并 | 自研 NDK ffmpeg（`cpp/ffconcat_jni.c` + 手写 JNI）：C 层解密、时间基统一、concat，产出单文件 |
| 落地 | 本地 / NAS / **SMB / WebDAV / FTP** 直传，传完校验大小再删本地 |
| 账号 | 登录注册；注册开关由后端控制，注册需管理员动态码 |
| 私密模式 | 每次进入都校验动态码（OTP）；源可切换（黄果 / 剧果 / 野果 / 禁果短剧 / 黄果 AI / 黄果旧版）；网络模式（直连 / 代理 / 后端转发）对全部源生效；黄果换域名后自动跟随 301，不用重装 |
| 主题 | 浅色 / 深色两套，跟随系统切换 |
| 更新 | 前端资源热更新（签名校验 + 原子切换），改界面不用重装 APK |

### 桌面端（`desktop/`，Electron + React）

不是把 WebUI 套进窗口：界面用 React 重写，解析、下载、合并全部在本机完成，
只有账号和片单同步走后端。

- 登录：服务器地址 + 账号密码（token 走系统凭据加密），或手机 App 扫二维码直接授权
- 浏览：首页 / 分类 / 搜索 / 详情 / 选集，直接复用 `server/` 的解析模块
- **私密模式**：侧边栏点「私密模式」输入 6 位动态码；设置里可切换内容源（黄果 / 剧果 / 野果 /
  禁果短剧 / 黄果 AI / 黄果旧版）；每次启动后首次进入都要验证
- **播放**：详情页点集数直接播。在线内容由本机媒体服务代取（私密源补 Referer，红果 CENC 流用 ffmpeg 解封装），
  下载完成的任务在「下载」页点「播放本地」播合并成品
- 下载：本机多集并发、失败集自动重试、任务持久化，整剧落到自己选的目录
- 合并：下载完成自动合并成单文件；编码不一致时先统一转码再合并
- 同步：「我的」页直接显示手机端的最近在看与收藏
- **与手机/电视互通**：桌面端注册为 `platform=desktop` 设备——手机投屏列表里会出现「电脑」；
  桌面端下载任务上报后端，手机和电视的下载页直接看到「电脑」那一栏；同一局域网内可直连电脑播放成品
  （Windows 首次启动会弹防火墙授权，选「允许专用网络」）
- **检查更新**：设置页问后端 `/api/app/latest?platform=desktop`，安装包由后端从同一个 `vX.Y.Z` Release 缓存后分发
- 自带 ffmpeg / ffprobe，装完即用

### 电视端（`tv` flavor，包名 `com.veyra.gybeyond.tv`）

TV 端是**独立的一套前端**（`assets/tv.html` / `tv.js` / `tv.css`），不是把手机页面放大：

- 遥控器焦点：整卡放大 + 描边，海报圆角不破
- 长按连续移动：首页选剧、详情选集共用一套连发逻辑
- 播放页：暂停即出控件条，6 项一字贴底（播放 · 上一集 · 下一集 · 选集 · 倍速 · 收藏），选集 20 集一组
- 左右长按快进快退；上下不长按跳集
- 长标题选中后跑马灯（rAF 逐帧位移，接缝不跳）
- 私密模式每次进入都要动态码
- **扫码输入**：遥控器打字难，电视上弹二维码，手机扫码后直接往当前输入框灌字（局域网 ServerSocket + 一次性 token）
- 8 套主题：简洁白 / 少女粉 / 主题黑 / 高能红 / 高能黄 / 早苗绿 / 宝石蓝 / 罗兰紫（TV 端独立一套，存在 `veyra.tv.theme`，和手机端的浅色/深色互不影响）

### 后端（`server/`，Node.js 无框架，单镜像）

- 账号与角色：普通用户只能下到手机，管理员才能下 NAS
- 动态码（OTP）：签发 / 校验 / 重置
- 下载任务队列：ffmpeg 解密 + 合并（avc3 / hev1 时间基统一，产物直接可播）
- 设备联动：`devices/register · poll · cast · ack`，手机找片 → 电视播
- 管理台 WebUI：用户管理、角色切换、注册开关、动态码、出站代理配置与连通性测试
- 片源转发：红果直连 / 中继，黄果走可配置代理

---

## 结构

```
app/                         Android 客户端（17k 行 Java + 8k 行前端）
  src/main/java/             播放 / 下载 / 合并 / 账号 / 设备联动 / 热更
  src/main/cpp/              自研合并引擎 JNI
  src/main/assets/           app.*（手机前端） / tv.*（电视前端）
server/                      API + 下载器 + 管理台
desktop/                     Windows 桌面端（Electron + React，复用 server 的解析与下载）
third_party/hongguo/         红果内容接入层
docker-compose.yaml
```

## 部署

```yaml
services:
  veyra-backend:
    image: gybeyond/veyra-backend:latest
    container_name: veyra
    restart: unless-stopped
    network_mode: host          # 需要访问局域网代理时用 host
    environment:
      - PORT=8888
      - DATA_DIR=/data
      - ADMIN_PASSWORD=change-me
    volumes:
      - ./data:/data
      - /volume1/your/video:/video
```

```bash
docker compose up -d
curl http://<NAS-IP>:8888/api/health     # {"status":"ok"}
```

镜像同时提供 `linux/amd64` 与 `linux/arm64`，`docker compose up -d` 会按机器架构自动选，compose 文件不用改。

`/volume1/your/video` 是群晖路径；威联通是 `/share/...`，Unraid 是 `/mnt/user/...`，按自己设备改。

**离线部署**（NAS 不联网）：从 Release 下载对应架构的包 —— x86 NAS 用 `veyra-backend-<版本>-amd64.tar.gz`，ARM NAS 用 `veyra-backend-<版本>-arm64.tar.gz`，`docker load -i` 导入后改 compose 里的 `image` 为本地镜像即可。

APK 首次打开填后端地址（`http://<NAS-IP>:8888`），注册或登录即可。

## 构建

```bash
./gradlew assembleMobileRelease   # 手机包
./gradlew assembleTvRelease       # 电视包
```

需要 JDK 17、Android SDK、NDK（合并引擎）。

## 说明

- 后端不内置任何片源域名，地址由使用者自填。
- 所有数据在 `DATA_DIR`，备份这一个目录即可。
- 仅供个人自建自用。
