#!/bin/sh
# 容器入口：先拉起镜像内置的播放签名服务，再起取流服务和 Node 后端。
#
# 为什么内置：站方 2026-11-23 起只接受 App 自带 libmetasec_ml.so 产出的
# x-medusa 签名（unidbg 模拟执行）。仓库里移植版的内置签名一律回 200 + 空正文，
# 所以播放必须靠这个签名服务。放镜像里省掉用户单独维护一个容器。
set -e

SIGNER_PORT="${SIGNER_PORT:-19830}"
SIGNER_LOG=/tmp/openhongguo-signer.log

/opt/signer/bin/openhongguo-signer >"$SIGNER_LOG" 2>&1 &

i=0
while [ "$i" -lt 90 ]; do
  if curl -sf -m 2 "http://127.0.0.1:${SIGNER_PORT}/ready" >/dev/null 2>&1; then
    echo "[start] 内置签名服务就绪（127.0.0.1:${SIGNER_PORT}）"
    break
  fi
  i=$((i + 1))
  sleep 1
done

if [ "$i" -ge 90 ]; then
  echo "[start] !! 内置签名服务 90 秒未就绪，播放会失败。日志尾部："
  tail -n 20 "$SIGNER_LOG" 2>/dev/null || true
fi

LOCAL_SIGNER="http://127.0.0.1:${SIGNER_PORT}"
if [ -n "${HG_SIGNER}" ]; then
  # 用户自己的服务优先，但连不上就退回内置的，免得一个写错的地址把播放全打死。
  if curl -sf -m 3 "${HG_SIGNER%/}/ready" >/dev/null 2>&1; then
    echo "[start] 使用外部签名服务：${HG_SIGNER}"
  else
    echo "[start] 外部签名服务 ${HG_SIGNER} 不可达，改用内置签名服务"
    HG_SIGNER=""
  fi
fi
export HG_SIGNER="${HG_SIGNER:-$LOCAL_SIGNER}"

/usr/local/bin/hongguo-fetch &
exec node index.js
