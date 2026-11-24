# Veyra 轻量后端镜像
FROM node:22-alpine

# 下载/合并依赖：ffmpeg（concat 合并 + ffprobe 编码探测），alpine 官方包含两件套；
# curl：proxy-fetch.js 抓取底层（黄果站点对 Node TLS 指纹风控，curl 正常）
RUN apk add --no-cache ffmpeg curl

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund --prefer-offline

# 业务代码整目录复制，靠 .dockerignore 排除 node_modules/test/data。
# 以前是逐个文件列举，0.28.9 新增 server/sources/ 时漏写了一行，
# 镜像里 index.js require('./sources') 直接 MODULE_NOT_FOUND 起不来 —— 不再列举。
# hongguo-sign.js：红果签名链 JS 内嵌实现（hongguo-app.js require 依赖，缺失会导致取流失败）
COPY . ./

# 本地取流服务：hongguo-app.js 的旧签名链（Gorgon/Argus/Ladon）已经过不了
# 2026-11-23 之后的校验，取流改由这个 Go 二进制负责（完整客户端签名 + CENC 密钥派生）。
# 二进制随源码一起 COPY 进来（fetch/），这里只按构建架构建个软链，不重复占空间。
ARG TARGETARCH=amd64
RUN ln -sf /app/fetch/hongguo-fetch-linux-${TARGETARCH} /usr/local/bin/hongguo-fetch \
    && chmod +x /app/fetch/hongguo-fetch-linux-${TARGETARCH}

ENV PORT=8080
ENV HG_PROFILE=/data/hongguo-profile.json
EXPOSE 8080
VOLUME /data

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1

# 先起取流服务（失败不阻塞主进程），再交给 node
CMD ["sh", "-c", "/usr/local/bin/hongguo-fetch & exec node index.js"]
