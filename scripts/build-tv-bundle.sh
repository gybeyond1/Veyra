#!/usr/bin/env bash
# 电视端加载的是 app.es5.js：app.html 按 ?lite=1（TV 包）分流，lite 分支只跑这份降级产物。
#
# 改动 app.js 之后必须跑一次这个脚本重新生成，否则电视上看到的是旧界面 ——
# 之前「相关作品 / 制作方 / 热评 / 评论」几块就这么在电视上缺席过一轮。
#
# 降级目标 es2019：电视 WebView 是 Chrome 61 那一档（详见 tv-lite.css 的说明），
# 可选链、空值合并都要转掉，其余语法保持原样。
set -euo pipefail
cd "$(dirname "$0")/../app/src/main/assets"

if ! command -v esbuild >/dev/null 2>&1; then
  echo "缺少 esbuild：npm i -g esbuild" >&2
  exit 1
fi

esbuild app.js --target=es2019 --charset=utf8 --outfile=app.es5.js
node --check app.es5.js
echo "app.es5.js 已更新：$(wc -c < app.es5.js) 字节"
