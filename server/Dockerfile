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

ENV PORT=8080
EXPOSE 8080
VOLUME /data

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1

CMD ["node", "index.js"]
