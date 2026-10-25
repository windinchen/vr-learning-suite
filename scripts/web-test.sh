#!/bin/bash
# 老师网页的浏览器自检：真开一个 Chromium 把控制台点一遍并抓图。
# 用法：bash scripts/web-test.sh          跑全套（要先把后台跑起来：bash scripts/dev.sh）
#      PORT=8787 bash scripts/web-test.sh --shots 0   不抓图，只断言
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-8787}"
BASE="${BASE:-http://127.0.0.1:${PORT}}"

curl -sf -o /dev/null "$BASE/" || { echo "后台没在跑，先 bash scripts/dev.sh" >&2; exit 1; }

# playwright 只当测试驱动用，装进 .webtest/，不进 server 的依赖（后台保持零第三方依赖）
if ! node -e 'import("playwright-core").then(() => process.exit(0), () => process.exit(1))' >/dev/null 2>&1 \
  && [ ! -d "$ROOT/.webtest/node_modules/playwright-core" ]; then
  echo "第一次跑，装 playwright-core 到 .webtest/（浏览器用系统里 Playwright 已缓存的 Chromium，不再下载）"
  mkdir -p "$ROOT/.webtest"
  npm i --prefix "$ROOT/.webtest" --no-audit --no-fund --loglevel=error playwright-core
fi

# 「头显应用」页要有扫描结果才测得出已装/没装，先拉模拟头显上一轮班（上报本机应用 + 心跳）
case "$*" in
  *--no-mock*) ;;
  *)
    echo "先让模拟头显跑一轮，把装着哪些应用报给后台…"
    node "$ROOT/scripts/mock-pico.mjs" --base "$BASE" --serial PICO-4U-A1B2C3 --rounds 1 --interval 1 --no-screen 2>&1 | sed "s/^/  /"
    ;;
esac

status=0
node "$ROOT/scripts/web-test.mjs" --base "$BASE" "$@" || status=1

# 自检最后会点一次「扫描这台头显」，再让模拟头显上第二轮班，把这条指令执行掉，别留一条永远待办的指令
case "$*" in
  *--no-mock*) ;;
  *)
    node "$ROOT/scripts/mock-pico.mjs" --base "$BASE" --serial PICO-4U-A1B2C3 --rounds 1 --interval 1 --no-screen >/dev/null 2>&1 || true
    ;;
esac
exit $status
