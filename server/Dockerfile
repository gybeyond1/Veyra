# Veyra 后端镜像（内置播放签名服务）
#
# 2026-11-23 起站方只接受 App 自带 libmetasec_ml.so 产出的 x-medusa 签名，
# 仓库里移植版的内置签名一律回 200 + 空正文。签名服务（unidbg 模拟执行 so）
# 从官方镜像整段拷进来，容器启动时自动拉起，用户不需要额外维护一个容器。
FROM beilunyang/openhongguo-signer:latest AS signer

FROM node:22-bookworm-slim

# 下载/合并依赖：ffmpeg（concat 合并 + ffprobe 编码探测）；
# curl：proxy-fetch.js 抓取底层 + 入口脚本探测签名服务是否就绪。
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# 播放签名服务：JRE + 应用目录（含 libmetasec_ml.so）。
COPY --from=signer /opt/java/openjdk /opt/java/openjdk
COPY --from=signer /app /opt/signer
ENV JAVA_HOME=/opt/java/openjdk
ENV PATH=/opt/java/openjdk/bin:$PATH

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund --prefer-offline

# 业务代码整目录复制，靠 .dockerignore 排除 node_modules/test/data。
# 以前是逐个文件列举，0.28.9 新增 server/sources/ 时漏写了一行，
# 镜像里 index.js require('./sources') 直接 MODULE_NOT_FOUND 起不来 —— 不再列举。
# hongguo-sign.js：红果签名链 JS 内嵌实现（hongguo-app.js require 依赖，缺失会导致取流失败）
COPY . ./

# 本地取流服务：红果签名（Gorgon/Argus/Ladon/Medusa）与 CENC 密钥派生都由这个 Go 二进制负责。
# 二进制随源码一起 COPY 进来（fetch/ 下 amd64 与 arm64 各一份，共约 11 MB）。
#
# 2026-11-27：不再用 ARG TARGETARCH 在构建期建软链。
# 默认值 amd64 + buildx 缓存/本地无 --platform 构建时 TARGETARCH 为空，
# 会静默落回 amd64 —— arm64 镜像里 /usr/local/bin/hongguo-fetch 指向 x86 二进制，
# 启动直接 `Exec format error`，取流全挂（issue #13）。
# 改成两个都 chmod，由入口脚本按 uname -m 选，构建参数丢了也不会错。
RUN chmod +x /app/fetch/hongguo-fetch-linux-amd64 /app/fetch/hongguo-fetch-linux-arm64 \
    && chmod +x /app/docker-entrypoint.sh

ENV PORT=8080
ENV HG_PROFILE=/data/hongguo-profile.json
EXPOSE 8080
VOLUME /data

# 健康检查跟随 PORT：之前写死 8080，用户把 PORT 改成别的（绿联默认 8888）后
# 容器一直显示 unhealthy，但服务其实是好的。
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${PORT:-8080}/api/health" || exit 1

# 入口脚本：拉起内置签名服务 → 等就绪 → 起取流服务与 node
CMD ["/app/docker-entrypoint.sh"]
