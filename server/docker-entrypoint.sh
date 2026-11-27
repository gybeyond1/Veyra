#!/bin/sh
# 容器入口：拉起内置播放签名服务 → 先让后端开始监听 → 拉起取流服务 → 等签名就绪。
#
# 为什么内置：站方 2026-11-23 起只接受 App 自带 libmetasec_ml.so 产出的
# x-medusa 签名（unidbg 模拟执行）。仓库里移植版的内置签名一律回 200 + 空正文，
# 所以播放必须靠这个签名服务。放镜像里省掉用户单独维护一个容器。
#
# 2026-11-26：以前是「等签名最多 90 秒，再起后端」，签名没起来或起得慢，
# 后端就迟迟不监听，手机端一律报「后端连不上」，看起来像更新把 App 弄坏了。
# 现在后端先监听，签名与取流服务异步追上来，容器一起就能连上并按状态自述。
#
# 2026-11-27：取流服务提到「等签名」之前。它只是本地 HTTP 转发，签名没就绪也能监听；
# 以前排在等待之后，前 10~60 秒所有播放都回 ECONNREFUSED 127.0.0.1:18098（issue #13）。
# 同时按 uname -m 选二进制，不再依赖构建期的 TARGETARCH（见 Dockerfile）。
set -u

SIGNER_PORT="${SIGNER_PORT:-19830}"
SIGNER_LOG=/tmp/openhongguo-signer.log
STATE_DIR=/tmp/veyra-state
mkdir -p "$STATE_DIR"

mark() { printf '%s' "$2" >"$STATE_DIR/$1" 2>/dev/null || true; }

# 1) 播放签名服务（unidbg 跑 App 自带 so）
mark signer starting
if [ -x /opt/signer/bin/openhongguo-signer ]; then
  /opt/signer/bin/openhongguo-signer >"$SIGNER_LOG" 2>&1 &
else
  mark signer missing
  echo "[start] !! 镜像里没有 /opt/signer/bin/openhongguo-signer，取流会失败"
fi

# 2) 后端先监听：手机端「连不上」在这一步就消失，健康检查也能立刻过
echo "[start] 后端开始监听（PORT=${PORT:-8080}）"
mark backend up
node index.js &
NODE_PID=$!

# 3) 确定签名服务地址：外部优先，连不上退回内置（免得一个写错的地址把播放全打死）
LOCAL_SIGNER="http://127.0.0.1:${SIGNER_PORT}"
if [ -n "${HG_SIGNER:-}" ]; then
  if curl -sf -m 3 "${HG_SIGNER%/}/ready" >/dev/null 2>&1; then
    echo "[start] 使用外部签名服务：${HG_SIGNER}"
  else
    echo "[start] 外部签名服务 ${HG_SIGNER} 不可达，改用内置签名服务"
    HG_SIGNER=""
  fi
fi
export HG_SIGNER="${HG_SIGNER:-$LOCAL_SIGNER}"

# 4) 取流服务：按容器架构选二进制。
#    镜像里 amd64 / arm64 各带一份，用 uname 判断。
#    issue #13：之前靠构建期的 ARG TARGETARCH 建软链，缓存复用或本地构建没注入时
#    默认落回 amd64，arm64 镜像里就指向 x86 二进制，启动报 Exec format error。
case "$(uname -m)" in
  x86_64|amd64) FETCH_BIN=/app/fetch/hongguo-fetch-linux-amd64 ;;
  aarch64|arm64) FETCH_BIN=/app/fetch/hongguo-fetch-linux-arm64 ;;
  *) FETCH_BIN="" ;;
esac
if [ -n "$FETCH_BIN" ] && [ -x "$FETCH_BIN" ]; then
  "$FETCH_BIN" &
  FETCH_PID=$!
  sleep 1
  if kill -0 "$FETCH_PID" 2>/dev/null; then
    mark fetch up
    echo "[start] 取流服务已启动（$(uname -m)）"
  else
    wait "$FETCH_PID"
    FETCH_RC=$?
    mark fetch down
    echo "[start] !! 取流服务启动失败（$(uname -m)，退出码 ${FETCH_RC}），播放会失败"
  fi
else
  mark fetch missing
  echo "[start] !! 镜像里没有匹配 $(uname -m) 的取流服务，播放会失败"
fi

# 5) 等签名服务就绪，最多 60 秒；超时也要把状态写清楚
i=0
while [ "$i" -lt 60 ]; do
  if curl -sf -m 2 "${HG_SIGNER%/}/ready" >/dev/null 2>&1; then
    mark signer ready
    echo "[start] 播放签名服务就绪（${HG_SIGNER}）"
    break
  fi
  i=$((i + 1))
  sleep 1
done

if [ "$i" -ge 60 ]; then
  mark signer timeout
  echo "[start] !! 内置签名服务 60 秒未就绪，播放会失败。日志尾部："
  tail -n 20 "$SIGNER_LOG" 2>/dev/null || true
fi

echo "[start] 后端就绪（取流：${FETCH_BIN:-无}，签名：${HG_SIGNER}）"

wait "$NODE_PID"
